using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Org.BouncyCastle.Asn1;
using Org.BouncyCastle.Asn1.X509;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;
using Org.BouncyCastle.X509;

namespace OpenFinalShell.Core;

public sealed record NativeLanSyncDevice(string DeviceId, string DeviceName, string AppVersion, string Address, int TcpPort);
public sealed record NativeLanSyncPreview(string Token, string DeviceName, string Address, ImportPreview Import);
public sealed record NativeLanSyncState(string Phase, string? PairingCode, int? TcpPort, NativeLanSyncDevice? Peer, NativeLanSyncPreview? Incoming, string? Error);
public sealed record NativeLanSyncImportResult(int Profiles, int Snippets, int Forwards, int KnownHosts, int Secrets, int Skipped);

/// <summary>Protocol primitives shared by the native LAN sync implementation.</summary>
public static class NativeLanSyncProtocol
{
    public const string Magic = "OFSSYNC1";
    public const int Version = 1;
    public const int DiscoveryPort = 52133;
    public const int MaxFrameBytes = 64 * 1024 * 1024;
    public const int HandshakeMaxFrameBytes = 64 * 1024;

    public static byte[] EncodeFrame(JsonObject frame)
    {
        var body = Encoding.UTF8.GetBytes(frame.ToJsonString());
        if (body.Length is < 1 or > MaxFrameBytes) throw new InvalidDataException("LAN sync frame is too large.");
        var result = new byte[4 + body.Length]; BinaryPrimitives.WriteUInt32BigEndian(result, (uint)body.Length);
        body.CopyTo(result, 4); return result;
    }

    public static JsonObject DecodeFrame(ReadOnlySpan<byte> bytes, int maxBytes = MaxFrameBytes)
    {
        if (bytes.Length < 4) throw new InvalidDataException("LAN sync frame is truncated.");
        var length = BinaryPrimitives.ReadUInt32BigEndian(bytes[..4]);
        if (length is 0 or > MaxFrameBytes || length > maxBytes || bytes.Length != length + 4) throw new InvalidDataException("LAN sync frame length is invalid.");
        var node = JsonNode.Parse(bytes[4..], documentOptions: new JsonDocumentOptions { MaxDepth = 16 })?.AsObject() ?? throw new InvalidDataException("LAN sync frame is not JSON.");
        ValidateFrame(node);
        return node;
    }

    public static void ValidateFrame(JsonObject frame)
    {
        var kind = frame["kind"]?.GetValue<string>();
        if (kind is not ("hello" or "hello-ack" or "confirm-s" or "confirm-r" or "payload" or "received" or "applied" or "rejected" or "error")) throw new InvalidDataException("Unknown LAN sync frame.");
        static string Required(JsonObject value, string key, int max)
        {
            var text = value[key]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(text) || text.Length > max) throw new InvalidDataException("Invalid LAN sync frame field.");
            return text;
        }
        switch (kind)
        {
            case "hello":
                if (Required(frame, "magic", 16) != Magic || frame["proto"]?.GetValue<int>() != Version) throw new InvalidDataException("LAN sync protocol mismatch.");
                Required(frame, "deviceId", 64); Required(frame, "deviceName", 128); Required(frame, "appVersion", 32); Required(frame, "senderPub", 128); break;
            case "hello-ack": Required(frame, "deviceId", 64); Required(frame, "deviceName", 128); Required(frame, "appVersion", 32); Required(frame, "receiverPub", 128); Required(frame, "salt", 64); Required(frame, "sessionId", 64); break;
            case "confirm-s": case "confirm-r": Required(frame, "mac", 128); break;
            case "payload": if (Required(frame, "envelope", MaxFrameBytes).Length > MaxFrameBytes) throw new InvalidDataException("LAN sync payload too large."); break;
            case "applied": foreach (var key in new[] { "profiles", "snippets", "forwards", "knownHosts", "secrets", "skipped" }) if (frame[key]?.GetValue<int>() is < 0) throw new InvalidDataException("Invalid LAN sync result."); break;
            case "error": Required(frame, "code", 64); break;
        }
    }
}

internal sealed class NativeLanSyncCrypto
{
    public X25519PrivateKeyParameters Private { get; }
    public byte[] PublicDer { get; }
    public NativeLanSyncCrypto()
    {
        Private = new X25519PrivateKeyParameters(new SecureRandom());
        PublicDer = SubjectPublicKeyInfoFactory.CreateSubjectPublicKeyInfo(Private.GeneratePublicKey()).GetEncoded(Asn1Encodable.Der);
    }
    public static byte[] PublicRaw(byte[] der)
    {
        var info = SubjectPublicKeyInfo.GetInstance(Asn1Object.FromByteArray(der));
        var raw = info.PublicKey.GetBytes();
        if (raw.Length != 32) throw new InvalidDataException("Invalid X25519 public key.");
        return raw;
    }
    public byte[] Shared(byte[] peerDer)
    {
        var peer = new X25519PublicKeyParameters(PublicRaw(peerDer)); var result = new byte[32];
        Private.GenerateSecret(peer, result, 0); return result;
    }
    public static byte[] Derive(byte[] shared, string code, byte[] salt, byte[] transcript)
    {
        var info = Encoding.UTF8.GetBytes("ofs-lansync-v1").Concat(transcript).ToArray();
        var kdfSalt = Hkdf(shared, salt, info, 32);
        var password = Encoding.UTF8.GetBytes(code);
        try { return SCrypt.Generate(password, kdfSalt, 32768, 8, 1, 32); }
        finally { CryptographicOperations.ZeroMemory(password); CryptographicOperations.ZeroMemory(kdfSalt); }
    }
    public static byte[] Transcript(byte[] sender, byte[] receiver, byte[] salt, string sessionId)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var part in new[] { sender, receiver, salt, Encoding.UTF8.GetBytes(sessionId) })
        { var length = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(length, (uint)part.Length); hash.AppendData(length); hash.AppendData(part); }
        return hash.GetHashAndReset();
    }
    public static byte[] Confirm(byte[] key, string role, byte[] transcript)
    {
        using var hmac = new HMACSHA256(key); return hmac.ComputeHash(Encoding.UTF8.GetBytes(role).Concat(transcript).ToArray());
    }
    public static string ChannelPass(byte[] key) => Convert.ToBase64String(key).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    public static bool Equal(byte[] a, byte[] b) => a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    private static byte[] Hkdf(byte[] ikm, byte[] salt, byte[] info, int length)
    {
        using var extract = new HMACSHA256(salt); var prk = extract.ComputeHash(ikm); var result = new byte[length]; var previous = Array.Empty<byte>(); var offset = 0; byte counter = 1;
        while (offset < length) { using var expand = new HMACSHA256(prk); previous = expand.ComputeHash(previous.Concat(info).Append(counter++).ToArray()); var take = Math.Min(previous.Length, length - offset); Buffer.BlockCopy(previous, 0, result, offset, take); offset += take; }
        CryptographicOperations.ZeroMemory(prk); return result;
    }
}

/// <summary>
/// Native LAN sync service. It uses the same framed X25519 + scrypt pairing and v2
/// encrypted envelope as the Electron client; applying data is a user-confirmed,
/// transactional NativeStore import.
/// </summary>
public sealed class NativeLanSyncService : IDisposable
{
    private readonly NativeStore store;
    private readonly string deviceName;
    private readonly string deviceId = Guid.NewGuid().ToString("N");
    private TcpListener? listener;
    private UdpClient? responder;
    private TcpClient? sendSocket;
    private CancellationTokenSource? sendCancellation;
    private CancellationTokenSource? receiveCancellation;
    private ReceiveSession? incoming;
    private readonly object gate = new();
    private int incomingBusy;
    public NativeLanSyncState State { get; private set; } = new("idle", null, null, null, null, null);
    public event Action<NativeLanSyncState>? StateChanged;
    public NativeLanSyncService(NativeStore store, string? deviceName = null) { this.store = store; this.deviceName = string.IsNullOrWhiteSpace(deviceName) ? Environment.MachineName : deviceName; }

    public async Task<NativeLanSyncState> StartReceiveAsync(CancellationToken cancellation = default)
    {
        if (listener != null) return State;
        listener = new TcpListener(IPAddress.Any, 0); listener.Start();
        receiveCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        string? discoveryError = null;
        try { StartDiscoveryResponder(receiveCancellation.Token); } catch (Exception error) { discoveryError = error.Message; }
        var endpoint = (IPEndPoint)listener.LocalEndpoint; var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        SetState(new("waiting", code, endpoint.Port, null, null, discoveryError));
        _ = AcceptLoopAsync(listener, receiveCancellation.Token);
        await Task.CompletedTask; return State;
    }
    public void StopReceive()
    {
        receiveCancellation?.Cancel(); receiveCancellation?.Dispose(); receiveCancellation = null;
        try { listener?.Stop(); } catch { } listener = null; incoming?.Dispose(); incoming = null; SetState(new("idle", null, null, null, null, null));
        try { responder?.Dispose(); } catch { } responder = null; Interlocked.Exchange(ref incomingBusy, 0);
    }
    public void CancelSend()
    {
        sendCancellation?.Cancel(); sendCancellation?.Dispose(); sendCancellation = null;
        try { sendSocket?.Dispose(); } catch { } sendSocket = null;
    }

    public async Task<IReadOnlyList<NativeLanSyncDevice>> ScanAsync(CancellationToken cancellation = default)
    {
        var found = new Dictionary<string, NativeLanSyncDevice>(StringComparer.OrdinalIgnoreCase);
        var addresses = NetworkInterface.GetAllNetworkInterfaces().Where(x => x.OperationalStatus == OperationalStatus.Up)
            .SelectMany(x => x.GetIPProperties().UnicastAddresses).Where(x => x.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(x.Address)).Select(x => x.Address).Distinct().ToArray();
        if (addresses.Length == 0) return [];
        var tasks = addresses.Select(async address =>
        {
            using var client = new UdpClient(new IPEndPoint(address, 0)); client.EnableBroadcast = true;
            var probe = JsonSerializer.SerializeToUtf8Bytes(new { magic = NativeLanSyncProtocol.Magic, proto = NativeLanSyncProtocol.Version, kind = "probe", deviceId, deviceName = "" });
            try { await client.SendAsync(probe, new IPEndPoint(IPAddress.Parse("239.255.77.88"), NativeLanSyncProtocol.DiscoveryPort), cancellation); } catch { }
            try { await client.SendAsync(probe, new IPEndPoint(IPAddress.Broadcast, NativeLanSyncProtocol.DiscoveryPort), cancellation); } catch { }
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation); deadline.CancelAfter(TimeSpan.FromMilliseconds(2500));
            while (!deadline.IsCancellationRequested)
            {
                try
                {
                    var packet = await client.ReceiveAsync(deadline.Token); using var json = JsonDocument.Parse(packet.Buffer); var root = json.RootElement;
                    if (root.GetProperty("magic").GetString() != NativeLanSyncProtocol.Magic || root.GetProperty("proto").GetInt32() != NativeLanSyncProtocol.Version || root.GetProperty("kind").GetString() != "announce") continue;
                    var id = root.GetProperty("deviceId").GetString() ?? ""; if (id == deviceId || id.Length is 0 or > 64) continue;
                    var name = root.GetProperty("deviceName").GetString() ?? ""; var version = root.GetProperty("appVersion").GetString() ?? ""; var port = root.GetProperty("tcpPort").GetInt32();
                    if (name.Length > 128 || version.Length > 32 || port is < 1 or > 65535) continue;
                    var foundDevice = new NativeLanSyncDevice(id, name, version, packet.RemoteEndPoint.Address.ToString(), port);
                    lock (found) found.TryAdd($"{id}@{foundDevice.Address}:{port}", foundDevice);
                }
                catch (OperationCanceledException) { break; } catch (Exception) { break; }
            }
        });
        await Task.WhenAll(tasks); return found.Values.ToArray();
    }

    public async Task SendAsync(string host, int port, string pairingCode, bool includeSecrets = true, CancellationToken cancellation = default)
    {
        if (pairingCode.Length != 6 || !pairingCode.All(char.IsDigit)) throw new ArgumentException("Pairing code must be six digits.", nameof(pairingCode));
        CancelSend();
        var socket = new TcpClient(); sendSocket = socket; sendCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellation); var token = sendCancellation.Token;
        try
        {
            await socket.ConnectAsync(host, port, token); var stream = socket.GetStream();
            var ecdh = new NativeLanSyncCrypto(); SetState(new("connecting", null, null, new("", "", "", host, port), null, null));
            await WriteAsync(stream, new JsonObject { ["kind"] = "hello", ["magic"] = NativeLanSyncProtocol.Magic, ["proto"] = NativeLanSyncProtocol.Version, ["deviceId"] = deviceId, ["deviceName"] = deviceName, ["appVersion"] = "native-preview", ["senderPub"] = Convert.ToBase64String(ecdh.PublicDer) }, token);
            var ack = await ReadAsync(stream, token); if (ack["kind"]?.GetValue<string>() != "hello-ack") throw new InvalidDataException("LAN sync handshake failed.");
            var receiverDer = Convert.FromBase64String(ack["receiverPub"]!.GetValue<string>()); var salt = Convert.FromBase64String(ack["salt"]!.GetValue<string>()); var session = ack["sessionId"]!.GetValue<string>();
            var transcript = NativeLanSyncCrypto.Transcript(ecdh.PublicDer, receiverDer, salt, session); var key = NativeLanSyncCrypto.Derive(ecdh.Shared(receiverDer), pairingCode, salt, transcript);
            await WriteAsync(stream, new JsonObject { ["kind"] = "confirm-s", ["mac"] = Convert.ToBase64String(NativeLanSyncCrypto.Confirm(key, "sender", transcript)) }, token);
            var confirm = await ReadAsync(stream, token); if (confirm["kind"]?.GetValue<string>() != "confirm-r" || !NativeLanSyncCrypto.Equal(Convert.FromBase64String(confirm["mac"]!.GetValue<string>()), NativeLanSyncCrypto.Confirm(key, "receiver", transcript))) throw new UnauthorizedAccessException("LAN sync pairing code rejected.");
            var envelope = ExportEnvelope.Export(store, NativeLanSyncCrypto.ChannelPass(key), includeSecrets);
            await WriteAsync(stream, new JsonObject { ["kind"] = "payload", ["envelope"] = Encoding.UTF8.GetString(envelope) }, token);
            var received = await ReadAsync(stream, token); var receivedKind = received["kind"]?.GetValue<string>(); if (receivedKind is not ("received" or "applied")) throw new InvalidDataException("LAN sync payload was rejected.");
            SetState(new("delivered", null, null, State.Peer, null, null));
            _ = AwaitSendResultAsync(stream, socket, token);
        }
        catch { if (ReferenceEquals(sendSocket, socket)) CancelSend(); throw; }
    }

    public async Task<NativeLanSyncImportResult> ApplyIncomingAsync(string token, ImportConflict conflict, CancellationToken cancellation = default)
    {
        ReceiveSession session;
        lock (gate) { session = incoming ?? throw new InvalidOperationException("No LAN sync import is waiting for confirmation."); if (session.Token != token) throw new InvalidOperationException("LAN sync preview expired."); }
        cancellation.ThrowIfCancellationRequested(); SetState(State with { Phase = "applying" });
        store.Import(session.Preview, conflict);
        var result = new NativeLanSyncImportResult(session.Preview.Profiles, Count(session.Preview.Data, "snippets"), Count(session.Preview.Data, "forwards"), Count(session.Preview.Data, "knownHosts"), session.Preview.SecretCount, 0);
        lock (gate) { incoming = null; } Interlocked.Exchange(ref incomingBusy, 0);
        try { await WriteAsync(session.Stream, new JsonObject { ["kind"] = "applied", ["profiles"] = result.Profiles, ["snippets"] = result.Snippets, ["forwards"] = result.Forwards, ["knownHosts"] = result.KnownHosts, ["secrets"] = result.Secrets, ["skipped"] = result.Skipped }, cancellation); } catch { /* data is committed; receipt delivery is best effort */ }
        session.Dispose(); SetState(new("waiting", RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6"), State.TcpPort, null, null, null)); return result;
    }
    public void RejectIncoming(string token)
    {
        ReceiveSession session;
        lock (gate) { if (incoming?.Token != token) return; session = incoming; incoming = null; }
        _ = RejectAsync(session);
        Interlocked.Exchange(ref incomingBusy, 0);
        var nextCode = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        SetState(new("waiting", nextCode, State.TcpPort, null, null, null));
    }
    private static async Task RejectAsync(ReceiveSession session)
    {
        try { await WriteAsync(session.Stream, new JsonObject { ["kind"] = "rejected" }, CancellationToken.None); } catch { }
        session.Dispose();
    }
    private async Task AwaitSendResultAsync(NetworkStream stream, TcpClient socket, CancellationToken cancellation)
    {
        try
        {
            var response = await ReadAsync(stream, cancellation);
            var kind = response["kind"]?.GetValue<string>();
            if (kind == "applied") SetState(new("applied", null, null, State.Peer, null, null));
            else if (kind == "rejected") SetState(new("rejected", null, null, State.Peer, null, null));
            else if (kind == "error") SetState(State with { Phase = "error", Error = response["code"]?.GetValue<string>() });
            else SetState(State with { Phase = "error", Error = "Unexpected LAN sync response." });
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { SetState(State with { Phase = "error", Error = error.Message }); }
        finally { try { socket.Dispose(); } catch { } if (ReferenceEquals(sendSocket, socket)) { sendSocket = null; sendCancellation?.Dispose(); sendCancellation = null; } }
    }
    private static int Count(JsonObject data, string kind) => data[kind] is JsonArray array ? array.Count : 0;
    private async Task AcceptLoopAsync(TcpListener source, CancellationToken cancellation)
    {
        while (!cancellation.IsCancellationRequested)
        {
            try { var socket = await source.AcceptTcpClientAsync(cancellation); _ = HandleIncomingAsync(socket, cancellation); }
            catch (OperationCanceledException) { break; } catch (ObjectDisposedException) { break; } catch (Exception error) { SetState(State with { Phase = "error", Error = error.Message }); }
        }
    }
    private async Task HandleIncomingAsync(TcpClient socket, CancellationToken cancellation)
    {
        if (Interlocked.Exchange(ref incomingBusy, 1) != 0) { socket.Dispose(); return; }
        var stream = socket.GetStream();
        var keepBusy = false;
        try
        {
            var hello = await ReadAsync(stream, cancellation, NativeLanSyncProtocol.HandshakeMaxFrameBytes); var senderDer = Convert.FromBase64String(hello["senderPub"]!.GetValue<string>()); var ecdh = new NativeLanSyncCrypto(); var salt = RandomNumberGenerator.GetBytes(16); var sessionId = Guid.NewGuid().ToString("N");
            var transcript = NativeLanSyncCrypto.Transcript(senderDer, ecdh.PublicDer, salt, sessionId); var key = NativeLanSyncCrypto.Derive(ecdh.Shared(senderDer), State.PairingCode!, salt, transcript);
            await WriteAsync(stream, new JsonObject { ["kind"] = "hello-ack", ["deviceId"] = deviceId, ["deviceName"] = deviceName, ["appVersion"] = "native-preview", ["receiverPub"] = Convert.ToBase64String(ecdh.PublicDer), ["salt"] = Convert.ToBase64String(salt), ["sessionId"] = sessionId }, cancellation);
            var confirm = await ReadAsync(stream, cancellation);
            if (confirm["kind"]?.GetValue<string>() != "confirm-s" || !NativeLanSyncCrypto.Equal(Convert.FromBase64String(confirm["mac"]!.GetValue<string>()), NativeLanSyncCrypto.Confirm(key, "sender", transcript)))
            {
                try { await WriteAsync(stream, new JsonObject { ["kind"] = "error", ["code"] = "err.sync.codeMismatch" }, cancellation); } catch { }
                SetState(new("waiting", RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6"), State.TcpPort, null, null, "Pairing code rejected."));
                socket.Dispose(); return;
            }
            await WriteAsync(stream, new JsonObject { ["kind"] = "confirm-r", ["mac"] = Convert.ToBase64String(NativeLanSyncCrypto.Confirm(key, "receiver", transcript)) }, cancellation);
            SetState(State with { Phase = "receiving", Peer = new(hello["deviceId"]!.GetValue<string>(), hello["deviceName"]!.GetValue<string>(), hello["appVersion"]!.GetValue<string>(), ((IPEndPoint)socket.Client.RemoteEndPoint!).Address.ToString(), ((IPEndPoint)listener!.LocalEndpoint).Port) });
            var payload = await ReadAsync(stream, cancellation); var text = payload["envelope"]!.GetValue<string>(); var preview = ExportEnvelope.Inspect(Encoding.UTF8.GetBytes(text), NativeLanSyncCrypto.ChannelPass(key));
            var pending = new ReceiveSession(Guid.NewGuid().ToString("N"), preview, stream, socket); lock (gate) { incoming?.Dispose(); incoming = pending; }
            await WriteAsync(stream, new JsonObject { ["kind"] = "received" }, cancellation); SetState(State with { Phase = "incoming", Incoming = new(pending.Token, hello["deviceName"]!.GetValue<string>(), ((IPEndPoint)socket.Client.RemoteEndPoint!).Address.ToString(), preview) });
            keepBusy = true;
        }
        catch (Exception error) { try { socket.Dispose(); } catch { } SetState(State with { Phase = "error", Error = error.Message }); }
        finally { if (!keepBusy) Interlocked.Exchange(ref incomingBusy, 0); }
    }
    private void StartDiscoveryResponder(CancellationToken cancellation)
    {
        var socket = new UdpClient(AddressFamily.InterNetwork); socket.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true); socket.Client.Bind(new IPEndPoint(IPAddress.Any, NativeLanSyncProtocol.DiscoveryPort));
        var group = IPAddress.Parse("239.255.77.88");
        foreach (var address in NetworkInterface.GetAllNetworkInterfaces().Where(x => x.OperationalStatus == OperationalStatus.Up).SelectMany(x => x.GetIPProperties().UnicastAddresses).Where(x => x.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(x.Address)))
            try { socket.JoinMulticastGroup(group, address.Address); } catch { }
        responder = socket; _ = ResponderLoopAsync(socket, cancellation);
    }
    private async Task ResponderLoopAsync(UdpClient socket, CancellationToken cancellation)
    {
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                var received = await socket.ReceiveAsync(cancellation); using var json = JsonDocument.Parse(received.Buffer); var root = json.RootElement;
                if (root.GetProperty("magic").GetString() != NativeLanSyncProtocol.Magic || root.GetProperty("proto").GetInt32() != NativeLanSyncProtocol.Version || root.GetProperty("kind").GetString() != "probe") continue;
                if (root.GetProperty("deviceId").GetString() == deviceId) continue;
                var announce = JsonSerializer.SerializeToUtf8Bytes(new { magic = NativeLanSyncProtocol.Magic, proto = NativeLanSyncProtocol.Version, kind = "announce", deviceId, deviceName, appVersion = "native-preview", tcpPort = State.TcpPort, sessionId = Guid.NewGuid().ToString("N") });
                await socket.SendAsync(announce, received.RemoteEndPoint, cancellation);
            }
            catch (OperationCanceledException) { break; } catch (ObjectDisposedException) { break; } catch { }
        }
    }
    private void SetState(NativeLanSyncState state) { State = state; StateChanged?.Invoke(state); }
    private static async Task WriteAsync(NetworkStream stream, JsonObject frame, CancellationToken cancellation) { var bytes = NativeLanSyncProtocol.EncodeFrame(frame); await stream.WriteAsync(bytes, cancellation); }
    private static async Task<JsonObject> ReadAsync(NetworkStream stream, CancellationToken cancellation, int maxBytes = NativeLanSyncProtocol.MaxFrameBytes)
    {
        var header = new byte[4]; await ReadExactlyAsync(stream, header, cancellation); var length = BinaryPrimitives.ReadUInt32BigEndian(header); if (length is 0 or > NativeLanSyncProtocol.MaxFrameBytes || length > maxBytes) throw new InvalidDataException("LAN sync frame too large."); var body = new byte[length]; await ReadExactlyAsync(stream, body, cancellation); return NativeLanSyncProtocol.DecodeFrame(header.Concat(body).ToArray(), maxBytes);
    }
    private static async Task ReadExactlyAsync(NetworkStream stream, byte[] buffer, CancellationToken cancellation) { var offset = 0; while (offset < buffer.Length) { var count = await stream.ReadAsync(buffer.AsMemory(offset), cancellation); if (count == 0) throw new EndOfStreamException("LAN sync peer closed the connection."); offset += count; } }
    public void Dispose() { CancelSend(); StopReceive(); }
    private sealed class ReceiveSession(string token, ImportPreview preview, NetworkStream stream, TcpClient socket) : IDisposable { public string Token { get; } = token; public ImportPreview Preview { get; } = preview; public NetworkStream Stream { get; } = stream; public bool Owns(TcpClient value) => ReferenceEquals(socket, value); public void Dispose() { try { socket.Dispose(); } catch { } } }
}
