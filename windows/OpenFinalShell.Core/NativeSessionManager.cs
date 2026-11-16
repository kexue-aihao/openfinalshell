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
public sealed class NativeSessionManager : IDisposable, IAsyncDisposable
{
    private readonly NativeStore store;
    private readonly ConcurrentDictionary<string, NativeSession> sessions = new(StringComparer.Ordinal);

    public event Action<NativeSessionSnapshot>? StateChanged;
    public event Action<NativeConnectionProgress>? ConnectionProgressChanged;
    public event Action<string, byte[]>? Output;

    public NativeSessionManager(NativeStore store) => this.store = store;

    public async Task<NativeSessionSnapshot> OpenAsync(
        ConnectionProfile profile,
        Func<HostKeyChallenge, Task<bool>> confirmHost,
        Func<string, bool, Task<string?>> prompt,
        CancellationToken cancellation,
        Func<byte[], Task>? onOutput = null,
        Action<NativeConnectionProgress>? onConnectionProgress = null)
    {
        var id = Guid.NewGuid().ToString("N");
        var session = new NativeSession(id, profile, store, confirmHost, prompt, onOutput, onConnectionProgress);
        if (!sessions.TryAdd(id, session)) throw new InvalidOperationException("Unable to allocate native session.");
        session.StateChanged += snapshot => StateChanged?.Invoke(snapshot);
        session.ConnectionProgressChanged += progress => ConnectionProgressChanged?.Invoke(progress);
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
            await session.CloseAsync().ConfigureAwait(false);
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

    public void Close(string sessionId) => Observe(CloseAsync(sessionId));
    public async Task CloseAsync(string sessionId, CancellationToken cancellation = default)
    {
        if (!sessions.TryGetValue(sessionId, out var session)) return;
        session.SetState(NativeSessionState.Closed, null);
        await session.CloseAsync(cancellation).ConfigureAwait(false);
        sessions.TryRemove(new KeyValuePair<string, NativeSession>(sessionId, session));
    }
    private static async void Observe(Task task) { try { await task.ConfigureAwait(false); } catch (Exception error) { System.Diagnostics.Debug.WriteLine(error); } }
    public async ValueTask DisposeAsync()
    {
        await Task.WhenAll(sessions.Keys.Select(id => CloseAsync(id))).ConfigureAwait(false);
    }

    public IReadOnlyList<NativeSessionSnapshot> List() => sessions.Values.Select(x => x.Snapshot).ToArray();

    public void Dispose()
    {
        foreach (var id in sessions.Keys.ToArray()) Close(id);
    }
}

public sealed class NativeSession : IDisposable, IAsyncDisposable
{
    private readonly NativeStore store;
    private readonly Func<HostKeyChallenge, Task<bool>> confirmHost;
    private readonly Func<string, bool, Task<string?>> prompt;
    private readonly Func<byte[], Task>? onOutput;
    private sealed record OutputChunk(long Generation, byte[] Bytes, TaskCompletionSource? Barrier = null);
    private readonly Channel<OutputChunk> output = Channel.CreateBounded<OutputChunk>(new BoundedChannelOptions(64)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = false,
        AllowSynchronousContinuations = false
    });
    private readonly CancellationTokenSource outputCancellation = new();
    private readonly ConcurrentDictionary<string, ForwardTelemetrySnapshot> forwardTelemetry = new(StringComparer.Ordinal);
    private SshConnection? connection;
    private SshConnection? jumpConnection;
    private Task? outputPump;
    private int disposed;
    private long generation, pendingBytes, queueHighWater, receivedBytes;
    private readonly object closeGate = new();
    private Task? closeTask, reconnectTask;
    public long PendingOutputBytes => Interlocked.Read(ref pendingBytes);
    public int PendingOutputChunks => output.Reader.Count;
    public long OutputQueueHighWater => Interlocked.Read(ref queueHighWater);
    public long ReceivedBytes => Interlocked.Read(ref receivedBytes);
    public long ShellBufferedBytes => connection?.ShellBufferedBytes ?? 0;
    public long ShellBufferHighWater => connection?.ShellBufferHighWater ?? 0;
    private readonly SemaphoreSlim connectionGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private int reconnectScheduled;
    private bool hasConnected;
    private int lastConnectionProgressPercent;
    private uint terminalColumns = 120, terminalRows = 40;

    public string SessionId { get; }
    public ConnectionProfile Profile { get; }
    public NativeSessionSnapshot Snapshot { get; private set; }
    public event Action<NativeSessionSnapshot>? StateChanged;
    public event Action<NativeConnectionProgress>? ConnectionProgressChanged;
    public event Action<byte[]>? Output;
    public event Action<ForwardTelemetrySnapshot>? ForwardTelemetryChanged;
    public event Action<string, Exception>? ForwardFailed;

    public NativeSession(string sessionId, ConnectionProfile profile, NativeStore store,
        Func<HostKeyChallenge, Task<bool>> confirmHost,
        Func<string, bool, Task<string?>> prompt,
        Func<byte[], Task>? onOutput = null,
        Action<NativeConnectionProgress>? onConnectionProgress = null)
    {
        SessionId = sessionId; Profile = profile; this.store = store;
        this.confirmHost = confirmHost; this.prompt = prompt; this.onOutput = onOutput;
        if (onConnectionProgress != null) ConnectionProgressChanged += onConnectionProgress;
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
        await connectionGate.WaitAsync(linked.Token).ConfigureAwait(false);
        try { await ConnectTransportAsync(linked.Token).ConfigureAwait(false); }
        finally { connectionGate.Release(); }
    }
    private async Task ConnectTransportAsync(CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        outputPump ??= Task.Run(() => PumpOutputAsync(outputCancellation.Token));
        var transportGeneration = Interlocked.Increment(ref generation);
        lastConnectionProgressPercent = 0;
        var hasJump = Profile.Data["jumpHostId"] != null;
        var stepCount = hasJump ? 10 : 6;
        ReportProgress("native.connection.preparing", 5, 1, stepCount);
        var (resolvedPassword, targetConnectPort) = await PrepareJumpAsync(cancellation, hasJump, stepCount);
        cancellation.ThrowIfCancellationRequested();
        connection = new SshConnection(Profile, store, confirmHost, prompt, resolvedPassword,
            targetConnectPort is null ? null : "127.0.0.1", targetConnectPort,
            progressChanged: progress => ReportSshProgress("target", progress, hasJump, stepCount));
        connection.OutputConsumer = (bytes, token) => PublishOutputAsync(bytes, transportGeneration, token);
        var transport = connection;
        connection.Failed += error => TransportFailed(transport, error);
        connection.ForwardTelemetryChanged += PublishForwardTelemetry;
        connection.ForwardFailed += (id, error) => ForwardFailed?.Invoke(id, error);
        try
        {
            await transport.ConnectAsync(terminalColumns, terminalRows, cancellation).ConfigureAwait(false);
            cancellation.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(disposed != 0, this);
        }
        catch
        {
            if (ReferenceEquals(connection, transport)) connection = null;
            await transport.CloseAsync().ConfigureAwait(false);
            var jump = jumpConnection; jumpConnection = null; if (jump != null) await jump.CloseAsync().ConfigureAwait(false);
            throw;
        }
        hasConnected = true;
        ReportProgress("native.connection.ready", 100, stepCount, stepCount);
        SetState(NativeSessionState.Ready, null);
    }

    internal async Task ReconnectAsync(CancellationToken cancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        await connectionGate.WaitAsync(linked.Token).ConfigureAwait(false);
        try
        {
            var old = connection; connection = null; if (old != null) await old.CloseAsync().ConfigureAwait(false);
            var oldJump = jumpConnection; jumpConnection = null; if (oldJump != null) await oldJump.CloseAsync().ConfigureAwait(false);
            // Finish the previous generation's in-flight parser callback before
            // a new transport can publish data or state notifications.
            var barrier = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await output.Writer.WriteAsync(new(generation, [], barrier), linked.Token).ConfigureAwait(false);
            await barrier.Task.WaitAsync(linked.Token).ConfigureAwait(false);
            await ConnectTransportAsync(linked.Token).ConfigureAwait(false);
        }
        finally { connectionGate.Release(); }
    }
    private void TransportFailed(SshConnection source, Exception error)
    {
        if (disposed != 0 || !ReferenceEquals(source, connection)) return;
        SetState(NativeSessionState.Failed, error.Message);
        var autoReconnect = Profile.Data["options"]?["autoReconnect"]?.GetValue<bool>() ?? true;
        if (!hasConnected || !autoReconnect || Interlocked.CompareExchange(ref reconnectScheduled, 1, 0) != 0) return;
        reconnectTask = Task.Run(async () =>
        {
            try
            {
                var attempt = 0;
                while (!lifetime.IsCancellationRequested)
                {
                    SetState(NativeSessionState.Reconnecting, error.Message);
                    var delaySeconds = attempt >= 5 ? 30 : 1 << attempt;
                    attempt++;
                    await Task.Delay(TimeSpan.FromSeconds(delaySeconds), lifetime.Token);
                    if (Snapshot.State == NativeSessionState.Ready) return;
                    try { await ReconnectAsync(lifetime.Token); return; }
                    catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return; }
                    catch (Exception failure) { error = failure; }
                }
            }
            catch (OperationCanceledException) { }
            finally { Volatile.Write(ref reconnectScheduled, 0); }
        });
    }

    private async Task<(string? Password, int? LocalPort)> PrepareJumpAsync(CancellationToken cancellation, bool hasJump, int stepCount)
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

            ReportProgress("native.connection.preparingJump", 10, 1, stepCount);
            var jumpPassword = await ResolvePasswordAsync(jumpProfile, cancellation, "jump", hasJump, stepCount);
            jumpConnection = new SshConnection(jumpProfile, store, confirmHost, prompt, jumpPassword,
                progressChanged: progress => ReportSshProgress("jump", progress, hasJump, stepCount));
            ReportProgress("native.connection.connectingJump", 15, 2, stepCount);
            await jumpConnection.ConnectAsync(0, 0, cancellation, openShell: false).ConfigureAwait(false);
            ReportProgress("native.connection.establishingJumpTunnel", 38, 5, stepCount);
            localPort = jumpConnection.StartJumpTunnel(Profile.Host, Profile.Port);
            ReportProgress("native.connection.jumpTunnelReady", 40, 5, stepCount);
        }

        var resolvedPassword = await ResolvePasswordAsync(Profile, cancellation, "target", hasJump, stepCount);
        cancellation.ThrowIfCancellationRequested();
        return (resolvedPassword, localPort);
    }

    private async Task<string?> ResolvePasswordAsync(ConnectionProfile profile, CancellationToken cancellation, string role = "target", bool hasJump = false, int stepCount = 6)
    {
        cancellation.ThrowIfCancellationRequested();
        var step = role == "jump" ? 1 : hasJump ? 5 : 1;
        var percent = role == "jump" ? 10 : hasJump ? 45 : 5;
        var stepKey = role == "jump"
            ? "native.connection.preparingJump"
            : hasJump ? "native.connection.preparingTarget" : "native.connection.preparing";
        ReportProgress(stepKey, percent, step, stepCount);
        var auth = profile.Data["auth"] as JsonObject;
        if ((auth?["method"]?.GetValue<string>() ?? "password") != "password") return null;
        var storedPassword = store.ReadSecret(auth?["passwordRef"]?.GetValue<string>());
        if (storedPassword != null) return storedPassword;
        var promptLabel = $"native.password ({profile.Username}@{profile.Host}:{profile.Port})";
        ReportProgress(stepKey, percent, step, stepCount, waitingForUser: true, waitingReasonKey: "native.connection.waitingForCredentials");
        var resolved = await prompt(promptLabel, false);
        cancellation.ThrowIfCancellationRequested();
        ReportProgress(stepKey, percent, step, stepCount);
        return resolved ?? throw new OperationCanceledException(cancellation);
    }

    private void ReportSshProgress(string role, NativeSshConnectionProgress progress, bool hasJump, int stepCount)
    {
        var jump = role == "jump";
        var stepKey = progress.Phase switch
        {
            "connecting" => jump ? "native.connection.connectingJump" : "native.connection.connectingTarget",
            "hostKey" => jump ? "native.connection.verifyingJumpHost" : "native.connection.verifyingTargetHost",
            "authentication" => jump ? "native.connection.authenticatingJump" : "native.connection.authenticatingTarget",
            "authenticated" => jump ? "native.connection.jumpAuthenticated" : "native.connection.targetAuthenticated",
            "openingShell" => "native.connection.openingShell",
            _ => "native.connection.preparing"
        };
        var (percent, step) = (jump, progress.Phase) switch
        {
            (true, "connecting") => (15, 2),
            (true, "hostKey") => (25, 3),
            (true, "authentication") => (30, 4),
            (true, "authenticated") => (35, 4),
            (false, "connecting") when hasJump => (50, 6),
            (false, "hostKey") when hasJump => (65, 7),
            (false, "authentication") when hasJump => (75, 8),
            (false, "authenticated") when hasJump => (85, 8),
            (false, "openingShell") when hasJump => (95, 9),
            (false, "connecting") => (20, 2),
            (false, "hostKey") => (50, 3),
            (false, "authentication") => (65, 4),
            (false, "authenticated") => (85, 4),
            (false, "openingShell") => (95, 5),
            _ => (lastConnectionProgressPercent, 1)
        };
        var waitingReasonKey = progress.WaitingReasonKey switch
        {
            "hostKey" => "native.connection.waitingForHostKey",
            "authentication" => "native.connection.waitingForAuthentication",
            _ => null
        };
        ReportProgress(stepKey, percent, step, stepCount, progress.WaitingForUser, waitingReasonKey);
    }

    private void ReportProgress(string stepKey, int percent, int stepIndex, int stepCount,
        bool waitingForUser = false, string? waitingReasonKey = null)
    {
        percent = Math.Clamp(Math.Max(lastConnectionProgressPercent, percent), 0, 100);
        lastConnectionProgressPercent = percent;
        try
        {
            ConnectionProgressChanged?.Invoke(new NativeConnectionProgress(
                SessionId, Profile.Id, stepKey, percent, stepIndex, stepCount, waitingForUser, waitingReasonKey));
        }
        catch
        {
            // Progress reporting must not change connection or authentication behavior.
        }
    }

    private async Task PublishOutputAsync(byte[] bytes, long sourceGeneration, CancellationToken cancellation)
    {
        if (bytes.Length == 0 || sourceGeneration != Volatile.Read(ref generation)) return;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, outputCancellation.Token);
        for (var offset = 0; offset < bytes.Length; offset += 32 * 1024)
        {
            var chunk = bytes.AsSpan(offset, Math.Min(32 * 1024, bytes.Length - offset)).ToArray();
            var queued = Interlocked.Add(ref pendingBytes, chunk.Length);
            Interlocked.Exchange(ref queueHighWater, Math.Max(queueHighWater, queued));
            try { await output.Writer.WriteAsync(new(sourceGeneration, chunk), linked.Token).ConfigureAwait(false); }
            catch { Interlocked.Add(ref pendingBytes, -chunk.Length); throw; }
            Interlocked.Add(ref receivedBytes, chunk.Length);
        }
    }

    private async Task PumpOutputAsync(CancellationToken cancellation)
    {
        var decodedGeneration = -1L;
        var codec = new TerminalCharsetCodec(Profile.Data["terminal"]?["charset"]?.GetValue<string>());
        try
        {
            await foreach (var chunk in output.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
            {
                Interlocked.Add(ref pendingBytes, -chunk.Bytes.Length);
                if (chunk.Barrier is { } barrier) { barrier.TrySetResult(); continue; }
                if (chunk.Generation != Volatile.Read(ref generation)) continue;
                if (decodedGeneration != chunk.Generation) { codec.Reset(); decodedGeneration = chunk.Generation; }
                var bytes = codec.DecodeRemote(chunk.Bytes);
                if (bytes.Length == 0) continue;
                if (onOutput != null) await onOutput(bytes).WaitAsync(cancellation).ConfigureAwait(false);
                if (chunk.Generation == Volatile.Read(ref generation)) Output?.Invoke(bytes);
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            SetState(NativeSessionState.Failed, error.Message);
            output.Writer.TryComplete(error);
            if (connection is { } failed) await failed.CloseAsync().ConfigureAwait(false);
        }
        finally
        {
            while (output.Reader.TryRead(out var pending))
            {
                Interlocked.Add(ref pendingBytes, -pending.Bytes.Length);
                pending.Barrier?.TrySetCanceled();
            }
        }
    }

    public Task WriteAsync(byte[] bytes, CancellationToken cancellation = default) => connection?.WriteAsync(bytes, cancellation) ?? Task.CompletedTask;
    public void Write(byte[] bytes) => Observe(WriteAsync(bytes));
    public Task ResizeAsync(uint columns, uint rows, CancellationToken cancellation = default)
    {
        if (columns == 0 || rows == 0) return Task.CompletedTask;
        terminalColumns = columns; terminalRows = rows;
        return connection?.ResizeAsync(columns, rows, cancellation) ?? Task.CompletedTask;
    }
    public void Resize(uint columns, uint rows) => Observe(ResizeAsync(columns, rows));
    private async void Observe(Task task)
    {
        try { await task.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (disposed == 0) SetState(NativeSessionState.Failed, error.Message); }
    }
    public Task<IReadOnlyList<RemoteEntry>> ListAsync(string path, CancellationToken token) => RequireConnection().ListAsync(path, token);
    public async Task WarmSftpAsync(CancellationToken token = default)
    {
        try { await RequireConnection().WarmSftpAsync(token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { System.Diagnostics.Debug.WriteLine($"Could not prewarm SFTP: {error.Message}"); }
    }
    public Task<string> RealPathAsync(string path, CancellationToken token, bool requireExisting = false) => RequireConnection().RealPathAsync(path, token, requireExisting);
    public Task<string> GetSftpWorkingDirectoryAsync(CancellationToken token) => RequireConnection().GetWorkingDirectoryAsync(token);
    public Task<RemoteEntry?> ResolveEntryAsync(string path, CancellationToken token) => RequireConnection().ResolveEntryAsync(path, token);
    public Task<NativeDeletePreview> PreviewDeleteAsync(string path, CancellationToken token) => RequireConnection().PreviewDeleteAsync(path, token);
    public Task DownloadAsync(string path, Stream destination, CancellationToken token, Action<long>? progress = null, long resumeOffset = 0) => RequireConnection().DownloadAsync(path, destination, token, progress, resumeOffset);
    public Task UploadAsync(Stream source, string path, bool overwrite, CancellationToken token, Action<long>? progress = null, long resumeOffset = 0) => RequireConnection().UploadAsync(source, path, overwrite, token, progress, resumeOffset);
    public Task<RemoteEntry?> TryGetAsync(string path, CancellationToken token) => RequireConnection().TryGetAsync(path, token);
    public Task CreateDirectoryAsync(string path, CancellationToken token) => RequireConnection().CreateDirectoryAsync(path, token);
    public Task CreateFileAsync(string path, CancellationToken token) => RequireConnection().CreateFileAsync(path, token);
    public Task<byte[]> ReadFileAsync(string path, CancellationToken token, long maxBytes = long.MaxValue) => RequireConnection().ReadFileAsync(path, token, maxBytes);
    public Task WriteFileAtomicAsync(string path, byte[] bytes, bool overwrite, CancellationToken token, bool allowNonAtomic = false, byte[]? expectedHash = null, Action<long>? progress = null) => RequireConnection().WriteFileAtomicAsync(path, bytes, overwrite, token, allowNonAtomic, expectedHash, progress);
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

    public Task CloseAsync(CancellationToken cancellation = default)
    {
        Task closing;
        lock (closeGate)
        {
            if (closeTask == null)
            {
                Interlocked.Exchange(ref disposed, 1);
                lifetime.Cancel(); outputCancellation.Cancel(); output.Writer.TryComplete();
                Interlocked.Increment(ref generation);
                closeTask = Task.Run(CloseCoreAsync);
            }
            closing = closeTask;
        }
        return closing.WaitAsync(cancellation);
    }
    private async Task CloseCoreAsync()
    {
        var transport = connection; connection = null;
        if (transport != null) await transport.CloseAsync().ConfigureAwait(false);
        await connectionGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (connection is { } late) await late.CloseAsync().ConfigureAwait(false);
            connection = null;
            if (jumpConnection is { } jump) await jump.CloseAsync().ConfigureAwait(false);
            jumpConnection = null;
        }
        finally { connectionGate.Release(); }
        if (outputPump != null) await outputPump.ConfigureAwait(false);
        if (reconnectTask != null) await reconnectTask.ConfigureAwait(false);
        SetState(NativeSessionState.Closed, null);
    }
    public ValueTask DisposeAsync() => new(CloseAsync());
    public void Dispose() => Observe(CloseAsync());
}
