using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Renci.SshNet;

namespace OpenFinalShell.Core;

/// <summary>
/// A measured TCP bridge around SSH.NET forwarding. SSH.NET intentionally hides
/// its per-channel streams, so each accepted connection is proxied through a
/// short-lived local forwarding port owned by this bridge.
/// </summary>
internal sealed class NativeForwardBridge : IDisposable
{
    private readonly object gate = new();
    private readonly SshClient client;
    private readonly string id;
    private readonly string type;
    private readonly string bindAddress;
    private readonly int bindPort;
    private readonly string destinationHost;
    private readonly int destinationPort;
    private readonly CancellationTokenSource stopped = new();
    private readonly HashSet<TcpClient> sockets = [];
    private readonly HashSet<ForwardedPortLocal> ephemeralPorts = [];
    private TcpListener? listener;
    private ForwardedPort? sshForward;
    private Task? acceptLoop;
    private readonly NativeForwardTelemetryCounter counter;
    private int disposed;

    public event Action<ForwardTelemetrySnapshot>? TelemetryChanged;
    public event Action<Exception>? Failed;
    public ForwardTelemetrySnapshot Snapshot => counter.Snapshot;

    public NativeForwardBridge(SshClient client, string id, JsonObject rule)
    {
        this.client = client;
        this.id = id;
        counter = new NativeForwardTelemetryCounter(id);
        type = rule["type"]?.GetValue<string>() ?? throw new InvalidDataException("Forwarding type is missing.");
        bindAddress = rule["bindAddr"]?.GetValue<string>() ?? throw new InvalidDataException("Forwarding bind address is missing.");
        bindPort = rule["bindPort"]?.GetValue<int>() ?? throw new InvalidDataException("Forwarding bind port is missing.");
        destinationHost = rule["dstHost"]?.GetValue<string>() ?? string.Empty;
        destinationPort = rule["dstPort"]?.GetValue<int>() ?? 0;
    }

    public void Start()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (!client.IsConnected) throw new InvalidOperationException("SSH session is not connected.");

        if (type == "remote")
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var localBridgePort = ((IPEndPoint)listener.LocalEndpoint).Port;
            acceptLoop = AcceptLoopAsync(listener, HandleRemoteConnectionAsync, stopped.Token);
            var remote = new ForwardedPortRemote(bindAddress, checked((uint)bindPort), IPAddress.Loopback.ToString(), checked((uint)localBridgePort));
            client.AddForwardedPort(remote);
            try { remote.Start(); sshForward = remote; }
            catch { client.RemoveForwardedPort(remote); remote.Dispose(); throw; }
        }
        else
        {
            listener = new TcpListener(ParseBindAddress(bindAddress), bindPort);
            listener.Start();
            acceptLoop = AcceptLoopAsync(listener, type == "dynamic" ? HandleSocksConnectionAsync : HandleLocalConnectionAsync, stopped.Token);
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        stopped.Cancel();
        try { listener?.Stop(); } catch { }
        if (sshForward is { } remote)
        {
            try { remote.Stop(); } catch { }
            try { client.RemoveForwardedPort(remote); } catch { }
            remote.Dispose();
            sshForward = null;
        }
        lock (gate)
        {
            foreach (var socket in sockets) try { socket.Dispose(); } catch { }
            sockets.Clear();
            foreach (var port in ephemeralPorts)
            {
                try { port.Stop(); } catch { }
                try { client.RemoveForwardedPort(port); } catch { }
                port.Dispose();
            }
            ephemeralPorts.Clear();
        }
        try { acceptLoop?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        counter.Stop();
        Publish();
        stopped.Dispose();
    }

    private async Task AcceptLoopAsync(TcpListener source, Func<TcpClient, CancellationToken, Action, Task> handler, CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var socket = await source.AcceptTcpClientAsync(cancellation).ConfigureAwait(false);
                lock (gate) sockets.Add(socket);
                _ = HandleSocketAsync(socket, handler, cancellation);
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (cancellation.IsCancellationRequested) { }
        catch (SocketException) when (cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (!cancellation.IsCancellationRequested)
            {
                Failed?.Invoke(error);
                _ = Task.Run(Dispose);
            }
        }
    }

    private async Task HandleSocketAsync(TcpClient socket, Func<TcpClient, CancellationToken, Action, Task> handler, CancellationToken cancellation)
    {
        var counted = false;
        void MarkActive()
        {
            if (counted) return;
            counted = counter.BeginConnection(); if (counted) Publish();
        }
        try
        {
            await handler(socket, cancellation, MarkActive).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch { }
        finally
        {
            if (counted) { counter.EndConnection(); Publish(); }
            lock (gate) sockets.Remove(socket);
            socket.Dispose();
        }
    }

    private async Task HandleLocalConnectionAsync(TcpClient incoming, CancellationToken cancellation, Action markActive)
    {
        using var remote = await ConnectThroughSshAsync(destinationHost, destinationPort, cancellation).ConfigureAwait(false);
        markActive();
        await PumpBothWaysAsync(incoming, remote.Client, cancellation).ConfigureAwait(false);
    }

    private async Task HandleRemoteConnectionAsync(TcpClient incoming, CancellationToken cancellation, Action markActive)
    {
        using var target = new TcpClient();
        await target.ConnectAsync(destinationHost, destinationPort, cancellation).ConfigureAwait(false);
        markActive();
        await PumpBothWaysAsync(incoming, target, cancellation).ConfigureAwait(false);
    }

    private async Task HandleSocksConnectionAsync(TcpClient incoming, CancellationToken cancellation, Action markActive)
    {
        var clientStream = incoming.GetStream();
        var greeting = new byte[2];
        await clientStream.ReadExactlyAsync(greeting, cancellation).ConfigureAwait(false);
        if (greeting[0] != 5 || greeting[1] == 0) return;
        var methods = new byte[greeting[1]];
        await clientStream.ReadExactlyAsync(methods, cancellation).ConfigureAwait(false);
        if (!methods.Contains((byte)0)) { await clientStream.WriteAsync(new byte[] { 5, 0xff }, cancellation).ConfigureAwait(false); return; }
        await clientStream.WriteAsync(new byte[] { 5, 0 }, cancellation).ConfigureAwait(false);

        var request = new byte[4];
        await clientStream.ReadExactlyAsync(request, cancellation).ConfigureAwait(false);
        if (request[0] != 5 || request[1] != 1 || request[2] != 0)
        {
            await SocksReplyAsync(clientStream, 7, cancellation).ConfigureAwait(false); return;
        }

        string host;
        switch (request[3])
        {
            case 1:
                var ipv4 = new byte[4]; await clientStream.ReadExactlyAsync(ipv4, cancellation).ConfigureAwait(false);
                host = new IPAddress(ipv4).ToString(); break;
            case 3:
                var length = new byte[1]; await clientStream.ReadExactlyAsync(length, cancellation).ConfigureAwait(false);
                var domain = new byte[length[0]]; await clientStream.ReadExactlyAsync(domain, cancellation).ConfigureAwait(false);
                host = new UTF8Encoding(false, true).GetString(domain); break;
            case 4:
                var ipv6 = new byte[16]; await clientStream.ReadExactlyAsync(ipv6, cancellation).ConfigureAwait(false);
                host = new IPAddress(ipv6).ToString(); break;
            default:
                await SocksReplyAsync(clientStream, 8, cancellation).ConfigureAwait(false); return;
        }
        var portBytes = new byte[2]; await clientStream.ReadExactlyAsync(portBytes, cancellation).ConfigureAwait(false);
        var port = BinaryPrimitives.ReadUInt16BigEndian(portBytes);
        if (port == 0) { await SocksReplyAsync(clientStream, 1, cancellation).ConfigureAwait(false); return; }

        try
        {
            using var remote = await ConnectThroughSshAsync(host, port, cancellation).ConfigureAwait(false);
            await SocksReplyAsync(clientStream, 0, cancellation).ConfigureAwait(false);
            markActive();
            await PumpBothWaysAsync(incoming, remote.Client, cancellation).ConfigureAwait(false);
        }
        catch
        {
            try { await SocksReplyAsync(clientStream, 5, cancellation).ConfigureAwait(false); } catch { }
            throw;
        }
    }

    private async Task<TunnelSocket> ConnectThroughSshAsync(string host, int port, CancellationToken cancellation)
    {
        var portForward = new ForwardedPortLocal(IPAddress.Loopback.ToString(), 0, host, checked((uint)port));
        client.AddForwardedPort(portForward);
        try
        {
            portForward.Start();
            lock (gate) ephemeralPorts.Add(portForward);
            var socket = new TcpClient();
            try { await socket.ConnectAsync(IPAddress.Loopback, checked((int)portForward.BoundPort), cancellation).ConfigureAwait(false); }
            catch { socket.Dispose(); throw; }
            return new TunnelSocket(socket, portForward, this);
        }
        catch
        {
            try { portForward.Stop(); } catch { }
            try { client.RemoveForwardedPort(portForward); } catch { }
            portForward.Dispose();
            throw;
        }
    }

    private async Task PumpBothWaysAsync(TcpClient first, TcpClient second, CancellationToken cancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var one = CopyAsync(first.GetStream(), second.GetStream(), linked.Token);
        var two = CopyAsync(second.GetStream(), first.GetStream(), linked.Token);
        await Task.WhenAny(one, two).ConfigureAwait(false);
        linked.Cancel();
        Close(first); Close(second);
        try { await Task.WhenAll(one, two).ConfigureAwait(false); } catch { }
    }

    private async Task CopyAsync(NetworkStream source, NetworkStream destination, CancellationToken cancellation)
    {
        var buffer = new byte[32 * 1024];
        while (!cancellation.IsCancellationRequested)
        {
            var read = await source.ReadAsync(buffer, cancellation).ConfigureAwait(false);
            if (read == 0) break;
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellation).ConfigureAwait(false);
            counter.AddBytes(read); Publish();
        }
    }

    private static async Task SocksReplyAsync(NetworkStream stream, byte status, CancellationToken cancellation) =>
        await stream.WriteAsync(new byte[] { 5, status, 0, 1, 0, 0, 0, 0, 0, 0 }, cancellation).ConfigureAwait(false);

    private void Publish() => TelemetryChanged?.Invoke(Snapshot);

    private static IPAddress ParseBindAddress(string value)
    {
        if (value is "*" or "0.0.0.0") return IPAddress.Any;
        if (value is "::" or "[::]") return IPAddress.IPv6Any;
        if (IPAddress.TryParse(value.Trim('[', ']'), out var address)) return address;
        if (value.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return IPAddress.Loopback;
        return Dns.GetHostAddresses(value).FirstOrDefault() ?? throw new InvalidDataException("Forward bind address could not be resolved.");
    }

    private static void Close(TcpClient client)
    {
        try { client.Client.Shutdown(SocketShutdown.Both); } catch { }
        try { client.Dispose(); } catch { }
    }

    private void RemoveEphemeralPort(ForwardedPortLocal port)
    {
        lock (gate) ephemeralPorts.Remove(port);
        try { port.Stop(); } catch { }
        try { client.RemoveForwardedPort(port); } catch { }
        port.Dispose();
    }

    private sealed class TunnelSocket(TcpClient client, ForwardedPortLocal port, NativeForwardBridge owner) : IDisposable
    {
        public TcpClient Client { get; } = client;
        public void Dispose() { Client.Dispose(); owner.RemoveEphemeralPort(port); }
    }
}
