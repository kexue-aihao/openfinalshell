using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace OpenFinalShell.Core;

public enum NativeSessionState
{
    Connecting,
    Ready,
    Reconnecting,
    Failed,
    Closed
}

public sealed record NativeSessionSnapshot(
    string SessionId,
    string ProfileId,
    string ProfileName,
    NativeSessionState State,
    string? Error,
    DateTimeOffset ChangedAt);

/// <summary>
/// Owns the lifetime of native SSH sessions. The UI only observes snapshots and
/// forwards input; it never owns transport objects or decides when to reconnect.
/// </summary>
public sealed class NativeSessionManager : IDisposable
{
    private readonly NativeStore store;
    private readonly ConcurrentDictionary<string, NativeSession> sessions = new(StringComparer.Ordinal);

    public event Action<NativeSessionSnapshot>? StateChanged;
    public event Action<string, byte[]>? Output;

    public NativeSessionManager(NativeStore store) => this.store = store;

    public async Task<NativeSessionSnapshot> OpenAsync(
        ConnectionProfile profile,
        Func<HostKeyChallenge, Task<bool>> confirmHost,
        Func<string, bool, Task<string?>> prompt,
        CancellationToken cancellation,
        Func<byte[], Task>? onOutput = null)
    {
        var id = Guid.NewGuid().ToString("N");
        var session = new NativeSession(id, profile, store, confirmHost, prompt, onOutput);
        if (!sessions.TryAdd(id, session)) throw new InvalidOperationException("Unable to allocate native session.");
        session.StateChanged += snapshot => StateChanged?.Invoke(snapshot);
        session.Output += bytes => Output?.Invoke(id, bytes);
        try
        {
            session.SetState(NativeSessionState.Connecting, null);
            await session.ConnectAsync(cancellation);
            return session.Snapshot;
        }
        catch (Exception error)
        {
            session.SetState(NativeSessionState.Failed, error.Message);
            sessions.TryRemove(id, out _);
            session.Dispose();
            throw;
        }
    }

    public NativeSession Get(string sessionId) => sessions.TryGetValue(sessionId, out var session)
        ? session
        : throw new KeyNotFoundException("Native session not found.");

    public async Task ReconnectAsync(string sessionId, CancellationToken cancellation)
    {
        var session = Get(sessionId);
        session.SetState(NativeSessionState.Reconnecting, null);
        try { await session.ReconnectAsync(cancellation); }
        catch (Exception error) { session.SetState(NativeSessionState.Failed, error.Message); throw; }
    }

    public void Close(string sessionId)
    {
        if (!sessions.TryRemove(sessionId, out var session)) return;
        session.SetState(NativeSessionState.Closed, null);
        session.Dispose();
    }

    public IReadOnlyList<NativeSessionSnapshot> List() => sessions.Values.Select(x => x.Snapshot).ToArray();

    public void Dispose()
    {
        foreach (var id in sessions.Keys.ToArray()) Close(id);
    }
}

public sealed class NativeSession : IDisposable
{
    private readonly NativeStore store;
    private readonly Func<HostKeyChallenge, Task<bool>> confirmHost;
    private readonly Func<string, bool, Task<string?>> prompt;
    private readonly Func<byte[], Task>? onOutput;
    private readonly Channel<byte[]> output = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(64)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = false,
        AllowSynchronousContinuations = false
    });
    private readonly CancellationTokenSource outputCancellation = new();
    private readonly TerminalCharsetCodec terminalCodec;
    private readonly ConcurrentDictionary<string, ForwardTelemetrySnapshot> forwardTelemetry = new(StringComparer.Ordinal);
    private SshConnection? connection;
    private SshConnection? jumpConnection;
    private Task? outputPump;
    private int disposed;
    private readonly SemaphoreSlim connectionGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private int reconnectScheduled;
    private bool hasConnected;
    private uint terminalColumns = 120, terminalRows = 40;

    public string SessionId { get; }
    public ConnectionProfile Profile { get; }
    public NativeSessionSnapshot Snapshot { get; private set; }
    public event Action<NativeSessionSnapshot>? StateChanged;
    public event Action<byte[]>? Output;
    public event Action<ForwardTelemetrySnapshot>? ForwardTelemetryChanged;
    public event Action<string, Exception>? ForwardFailed;

    public NativeSession(string sessionId, ConnectionProfile profile, NativeStore store,
        Func<HostKeyChallenge, Task<bool>> confirmHost,
        Func<string, bool, Task<string?>> prompt,
        Func<byte[], Task>? onOutput = null)
    {
        SessionId = sessionId; Profile = profile; this.store = store;
        this.confirmHost = confirmHost; this.prompt = prompt; this.onOutput = onOutput;
        terminalCodec = new TerminalCharsetCodec(profile.Data["terminal"]?["charset"]?.GetValue<string>());
        Snapshot = new(sessionId, profile.Id, profile.Name, NativeSessionState.Closed, null, DateTimeOffset.UtcNow);
    }

    internal void SetState(NativeSessionState state, string? error)
    {
        if (Volatile.Read(ref disposed) != 0 && state != NativeSessionState.Closed) return;
        Snapshot = Snapshot with { State = state, Error = error, ChangedAt = DateTimeOffset.UtcNow };
        StateChanged?.Invoke(Snapshot);
    }

    internal async Task ConnectAsync(CancellationToken cancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        await connectionGate.WaitAsync(linked.Token);
        try { await ConnectTransportAsync(linked.Token); }
        finally { connectionGate.Release(); }
    }
    private async Task ConnectTransportAsync(CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        outputPump ??= PumpOutputAsync(outputCancellation.Token);
        terminalCodec.Reset();
        var (resolvedPassword, targetConnectPort) = await PrepareJumpAsync(cancellation);
        cancellation.ThrowIfCancellationRequested();
        connection = new SshConnection(Profile, store, confirmHost, prompt, resolvedPassword,
            targetConnectPort is null ? null : "127.0.0.1", targetConnectPort);
        connection.Output += PublishOutput;
        var transport = connection;
        connection.Failed += error => TransportFailed(transport, error);
        connection.ForwardTelemetryChanged += PublishForwardTelemetry;
        connection.ForwardFailed += (id, error) => ForwardFailed?.Invoke(id, error);
        try
        {
            await transport.ConnectAsync(terminalColumns, terminalRows, cancellation);
            cancellation.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(disposed != 0, this);
        }
        catch
        {
            if (ReferenceEquals(connection, transport)) connection = null;
            transport.Dispose();
            var jump = jumpConnection; jumpConnection = null; jump?.Dispose();
            throw;
        }
        hasConnected = true;
        SetState(NativeSessionState.Ready, null);
    }

    internal async Task ReconnectAsync(CancellationToken cancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        await connectionGate.WaitAsync(linked.Token);
        try
        {
            var old = connection; connection = null; old?.Dispose();
            var oldJump = jumpConnection; jumpConnection = null; oldJump?.Dispose();
            await ConnectTransportAsync(linked.Token);
        }
        finally { connectionGate.Release(); }
    }
    private void TransportFailed(SshConnection source, Exception error)
    {
        if (disposed != 0 || !ReferenceEquals(source, connection)) return;
        SetState(NativeSessionState.Failed, error.Message);
        if (!hasConnected || Profile.Data["options"]?["autoReconnect"]?.GetValue<bool>() != true || Interlocked.CompareExchange(ref reconnectScheduled, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                for (var attempt = 0; attempt < 5 && !lifetime.IsCancellationRequested; attempt++)
                {
                    SetState(NativeSessionState.Reconnecting, error.Message);
                    await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, 1 << attempt)), lifetime.Token);
                    if (Snapshot.State == NativeSessionState.Ready) return;
                    try { await ReconnectAsync(lifetime.Token); return; }
                    catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return; }
                    catch (Exception failure) { error = failure; }
                }
                if (!lifetime.IsCancellationRequested) SetState(NativeSessionState.Failed, error.Message);
            }
            catch (OperationCanceledException) { }
            finally { Volatile.Write(ref reconnectScheduled, 0); }
        });
    }

    private async Task<(string? Password, int? LocalPort)> PrepareJumpAsync(CancellationToken cancellation)
    {
        var jumpId = Profile.Data["jumpHostId"]?.GetValue<string>();
        int? localPort = null;
        if (jumpId != null)
        {
            if (string.IsNullOrWhiteSpace(jumpId) || jumpId == Profile.Id)
                throw new InvalidDataException("native.errors.jumpHostInvalid");
            var data = store.Find("profiles", jumpId)
                ?? throw new KeyNotFoundException("native.errors.jumpHostMissing");
            var jumpProfile = ConnectionProfile.FromJson(data);
            if (jumpProfile.Data["jumpHostId"] != null)
                throw new InvalidDataException("native.errors.jumpNestedUnsupported");
            if (jumpProfile.Data["protocol"]?.GetValue<string>() == "rdp")
                throw new InvalidDataException("native.errors.jumpRdpUnsupported");

            var jumpPassword = await ResolvePasswordAsync(jumpProfile, cancellation);
            jumpConnection = new SshConnection(jumpProfile, store, confirmHost, prompt, jumpPassword);
            await jumpConnection.ConnectAsync(0, 0, cancellation, openShell: false);
            localPort = jumpConnection.StartJumpTunnel(Profile.Host, Profile.Port);
        }

        var resolvedPassword = await ResolvePasswordAsync(Profile, cancellation);
        cancellation.ThrowIfCancellationRequested();
        return (resolvedPassword, localPort);
    }

    private async Task<string?> ResolvePasswordAsync(ConnectionProfile profile, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        var auth = profile.Data["auth"] as JsonObject;
        if ((auth?["method"]?.GetValue<string>() ?? "password") != "password") return null;
        var storedPassword = store.ReadSecret(auth?["passwordRef"]?.GetValue<string>());
        if (storedPassword != null) return storedPassword;
        var promptLabel = $"native.password ({profile.Username}@{profile.Host}:{profile.Port})";
        var resolved = await prompt(promptLabel, false);
        cancellation.ThrowIfCancellationRequested();
        return resolved ?? throw new OperationCanceledException(cancellation);
    }

    private void PublishOutput(byte[] bytes)
    {
        if (bytes.Length == 0 || outputCancellation.IsCancellationRequested) return;
        bytes = terminalCodec.DecodeRemote(bytes);
        if (bytes.Length == 0) return;
        try
        {
            // SSH.NET raises DataReceived synchronously on its receive path. Waiting
            // on this bounded channel intentionally applies backpressure instead
            // of dropping terminal bytes when the UI thread is busy.
            const int chunkSize = 32 * 1024;
            for (var offset = 0; offset < bytes.Length; offset += chunkSize)
            {
                var count = Math.Min(chunkSize, bytes.Length - offset);
                var chunk = bytes.AsSpan(offset, count).ToArray();
                output.Writer.WriteAsync(chunk, outputCancellation.Token).AsTask().GetAwaiter().GetResult();
            }
        }
        catch (OperationCanceledException) { }
        catch (ChannelClosedException) { }
    }

    private async Task PumpOutputAsync(CancellationToken cancellation)
    {
        try
        {
            await foreach (var bytes in output.Reader.ReadAllAsync(cancellation))
            {
                if (onOutput != null) await onOutput(bytes);
                Output?.Invoke(bytes);
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            SetState(NativeSessionState.Failed, error.Message);
            output.Writer.TryComplete(error);
        }
    }

    public void Write(byte[] bytes)
    {
        var encoded = terminalCodec.EncodeInput(bytes);
        if (encoded.Length > 0) connection?.Write(encoded);
    }
    public void Resize(uint columns, uint rows)
    {
        if (columns == 0 || rows == 0) return;
        terminalColumns = columns; terminalRows = rows;
        connection?.Resize(columns, rows);
    }
    public Task<IReadOnlyList<RemoteEntry>> ListAsync(string path, CancellationToken token) => RequireConnection().ListAsync(path, token);
    public Task<string> RealPathAsync(string path, CancellationToken token, bool requireExisting = false) => RequireConnection().RealPathAsync(path, token, requireExisting);
    public Task<NativeDeletePreview> PreviewDeleteAsync(string path, CancellationToken token) => RequireConnection().PreviewDeleteAsync(path, token);
    public Task DownloadAsync(string path, Stream destination, CancellationToken token, Action<long>? progress = null, long resumeOffset = 0) => RequireConnection().DownloadAsync(path, destination, token, progress, resumeOffset);
    public Task UploadAsync(Stream source, string path, bool overwrite, CancellationToken token, Action<long>? progress = null, long resumeOffset = 0) => RequireConnection().UploadAsync(source, path, overwrite, token, progress, resumeOffset);
    public Task<RemoteEntry?> TryGetAsync(string path, CancellationToken token) => RequireConnection().TryGetAsync(path, token);
    public Task CreateDirectoryAsync(string path, CancellationToken token) => RequireConnection().CreateDirectoryAsync(path, token);
    public Task CreateFileAsync(string path, CancellationToken token) => RequireConnection().CreateFileAsync(path, token);
    public Task<byte[]> ReadFileAsync(string path, CancellationToken token, long maxBytes = long.MaxValue) => RequireConnection().ReadFileAsync(path, token, maxBytes);
    public Task WriteFileAtomicAsync(string path, byte[] bytes, bool overwrite, CancellationToken token, bool allowNonAtomic = false, byte[]? expectedHash = null) => RequireConnection().WriteFileAtomicAsync(path, bytes, overwrite, token, allowNonAtomic, expectedHash);
    public Task DeleteAsync(string path, bool recursive, CancellationToken token) => RequireConnection().DeleteAsync(path, recursive, token);
    public Task RenameAsync(string from, string to, CancellationToken token) => RequireConnection().RenameAsync(from, to, token);
    public Task ChmodAsync(string path, short mode, CancellationToken token) => RequireConnection().ChmodAsync(path, mode, token);
    public void StartForward(JsonObject rule) => RequireConnection().StartForward(rule);
    public void StartForward(string id, JsonObject rule) => RequireConnection().StartForward(id, rule);
    public void StopForward(string id) => connection?.StopForward(id);
    public ForwardTelemetrySnapshot? ForwardTelemetryOf(string id) =>
        connection?.ForwardTelemetryOf(id) ?? (forwardTelemetry.TryGetValue(id, out var snapshot) ? snapshot : null);

    private void PublishForwardTelemetry(ForwardTelemetrySnapshot snapshot)
    {
        forwardTelemetry[snapshot.ForwardId] = snapshot;
        ForwardTelemetryChanged?.Invoke(snapshot);
    }
    public Task<string> ExecuteAsync(string command, CancellationToken token) => RequireConnection().ExecuteAsync(command, token);
    public Task<NativeCommandResult> ExecuteDetailedAsync(string command, TimeSpan timeout, CancellationToken token) =>
        RequireConnection().ExecuteDetailedAsync(command, timeout, token);

    private SshConnection RequireConnection() => connection ?? throw new InvalidOperationException("Native session is not connected.");

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        lifetime.Cancel();
        outputCancellation.Cancel();
        output.Writer.TryComplete();
        connection?.Dispose();
        connection = null;
        jumpConnection?.Dispose();
        jumpConnection = null;
        // A credential prompt or handshake may still be completing. Once the
        // connect gate drains, clean up anything created during cancellation.
        _ = Task.Run(async () =>
        {
            await connectionGate.WaitAsync();
            try { connection?.Dispose(); connection = null; jumpConnection?.Dispose(); jumpConnection = null; }
            finally { connectionGate.Release(); }
        });
        if (outputPump is { } pump)
            _ = pump.ContinueWith(_ => outputCancellation.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        else outputCancellation.Dispose();
        if (Snapshot.State != NativeSessionState.Closed) SetState(NativeSessionState.Closed, null);
    }
}
