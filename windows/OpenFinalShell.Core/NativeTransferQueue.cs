namespace OpenFinalShell.Core;

public enum NativeTransferState { Queued, Running, Paused, Completed, Failed, Canceled }
public enum NativeTransferDirection { Upload, Download }

public sealed record NativeTransferTask(
    string Id,
    string SessionId,
    NativeTransferDirection Direction,
    string Source,
    string Target,
    bool Overwrite,
    bool CleanupSource,
    long? TotalBytes,
    long CompletedBytes,
    NativeTransferState State,
    string? Error,
    string? ParentId = null,
    bool IsGroup = false,
    int ChildCount = 0,
    int CompletedItems = 0)
{
    public double ProgressPercent => TotalBytes is > 0 ? Math.Clamp(CompletedBytes * 100d / TotalBytes.Value, 0, 100) : State == NativeTransferState.Completed ? 100 : 0;
    public string Summary => IsGroup
        ? $"{Direction} · {Path.GetFileName(Source)} · {State} · {ProgressPercent:0}% · {CompletedItems}/{ChildCount} files" + (Error == null ? "" : $" · {Error}")
        : $"{Direction} · {Path.GetFileName(Source)} · {State} · {ProgressPercent:0}%" + (Error == null ? "" : $" · {Error}");
}

/// <summary>
/// Bounded native transfer queue. Pause cancels the current SFTP operation but
/// retains the private partial object and byte offset for a real continuation.
/// </summary>
public sealed class NativeTransferQueue : IDisposable
{
    private sealed class Runtime
    {
        public required NativeTransferTask Task;
        public required CancellationTokenSource Cancellation;
        public bool PauseRequested;
        public bool ControlRequested;
        public Task? Worker;
        public readonly List<string> Children = [];
    }

    private readonly NativeSessionManager sessions;
    private readonly object gate = new();
    private readonly Dictionary<string, Runtime> runtimes = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim concurrency = new(2, 2);
    public event Action<NativeTransferTask>? Changed;
    public event Action<string>? Removed;

    public NativeTransferQueue(NativeSessionManager sessions) => this.sessions = sessions;

    public IReadOnlyList<NativeTransferTask> List() { lock (gate) return runtimes.Values.Select(x => x.Task).ToArray(); }

    public void ClearFinished()
    {
        string[] removed;
        lock (gate)
        {
            var finishedGroups = runtimes.Values.Where(runtime => runtime.Task.IsGroup && (runtime.Task.State is NativeTransferState.Completed or NativeTransferState.Canceled))
                .Select(runtime => runtime.Task.Id).ToHashSet(StringComparer.Ordinal);
            removed = runtimes.Where(pair => (pair.Value.Task.State is NativeTransferState.Completed or NativeTransferState.Canceled) &&
                (pair.Value.Task.ParentId == null || finishedGroups.Contains(pair.Value.Task.ParentId)))
                .Select(pair => pair.Key).ToArray();
            foreach (var id in removed)
            {
                if (runtimes[id].Task.CleanupSource) try { DeleteStagedSource(runtimes[id].Task.Source); } catch { }
                runtimes[id].Cancellation.Dispose();
                runtimes.Remove(id);
            }
        }
        foreach (var id in removed) Removed?.Invoke(id);
    }

    public string EnqueueUpload(string sessionId, string source, string target, bool overwrite, bool cleanupSource = false)
        => EnqueueUpload(sessionId, source, target, overwrite, cleanupSource, null);

    public string EnqueueUpload(string sessionId, string source, string target, bool overwrite, bool cleanupSource, string? parentId)
    {
        var id = Guid.NewGuid().ToString("N");
        Add(new Runtime { Task = new(id, sessionId, NativeTransferDirection.Upload, source, target, overwrite, cleanupSource, new FileInfo(source).Length, 0, NativeTransferState.Queued, null, parentId), Cancellation = new() });
        return id;
    }

    public string EnqueueDownload(string sessionId, string source, string target, string? parentId = null)
    {
        var id = Guid.NewGuid().ToString("N");
        Add(new Runtime { Task = new(id, sessionId, NativeTransferDirection.Download, source, target, true, false, null, 0, NativeTransferState.Queued, null, parentId), Cancellation = new() });
        return id;
    }

    public string CreateGroup(string sessionId, NativeTransferDirection direction, string source, string target, long totalBytes, int childCount)
    {
        if (totalBytes < 0 || childCount < 0) throw new ArgumentOutOfRangeException(nameof(totalBytes));
        var id = Guid.NewGuid().ToString("N");
        var runtime = new Runtime
        {
            Task = new(id, sessionId, direction, source, target, true, false, totalBytes, 0,
                childCount == 0 ? NativeTransferState.Completed : NativeTransferState.Queued, null, null, true, childCount),
            Cancellation = new()
        };
        Add(runtime);
        return id;
    }

    private void Add(Runtime runtime)
    {
        lock (gate)
        {
            if (runtime.Task.ParentId is { } parentId)
            {
                if (!runtimes.TryGetValue(parentId, out var parent) || !parent.Task.IsGroup)
                    throw new InvalidOperationException("Transfer parent group was not found.");
                parent.Children.Add(runtime.Task.Id);
            }
            runtimes[runtime.Task.Id] = runtime;
        }
        Publish(runtime);
        if (runtime.Task.IsGroup)
        {
            if (runtime.Task.ChildCount == 0) Publish(runtime);
            return;
        }
        Start(runtime);
    }

    private void Start(Runtime runtime) => runtime.Worker = RunAsync(runtime);

    public async Task ControlAsync(string id, string operation)
    {
        Runtime runtime;
        lock (gate) if (!runtimes.TryGetValue(id, out runtime!)) throw new KeyNotFoundException("Transfer task not found.");
        if (runtime.Task.IsGroup)
        {
            string[] children;
            lock (gate) children = runtime.Children.ToArray();
            foreach (var child in children) await ControlAsync(child, operation);
            RecalculateGroup(runtime);
            return;
        }
        switch (operation)
        {
            case "pause":
                lock (gate)
                {
                    if (runtime.Task.State is not (NativeTransferState.Running or NativeTransferState.Queued)) return;
                    runtime.PauseRequested = true; runtime.Cancellation.Cancel();
                    if (runtime.Task.State == NativeTransferState.Queued) Update(runtime, NativeTransferState.Paused, null);
                }
                break;
            case "cancel":
                var cleanupNow = false;
                lock (gate)
                {
                    if (runtime.Task.State is NativeTransferState.Completed or NativeTransferState.Canceled) return;
                    runtime.ControlRequested = true;
                    runtime.Cancellation.Cancel();
                    cleanupNow = runtime.Worker == null || runtime.Worker.IsCompleted;
                    if (cleanupNow) Update(runtime, NativeTransferState.Canceled, null);
                }
                if (cleanupNow) await CleanupCanceledTransferAsync(runtime);
                break;
            case "resume":
                if (runtime.Task.State != NativeTransferState.Paused) return;
                await RestartAsync(runtime);
                break;
            case "retry":
                if (runtime.Task.State is not (NativeTransferState.Failed or NativeTransferState.Paused or NativeTransferState.Canceled)) return;
                await RestartAsync(runtime);
                break;
            default: throw new ArgumentOutOfRangeException(nameof(operation));
        }
    }

    private async Task RestartAsync(Runtime runtime)
    {
        var previous = runtime.Worker;
        if (previous != null) await previous;
        lock (gate)
        {
            if (runtime.Task.State is not (NativeTransferState.Paused or NativeTransferState.Failed or NativeTransferState.Canceled)) return;
            runtime.PauseRequested = false;
            runtime.ControlRequested = false;
            runtime.Cancellation.Dispose();
            runtime.Cancellation = new();
            Update(runtime, NativeTransferState.Queued, null, runtime.Task.CompletedBytes);
            Start(runtime);
        }
    }

    private async Task RunAsync(Runtime runtime)
    {
        var acquiredConcurrency = false;
        try
        {
            await concurrency.WaitAsync(runtime.Cancellation.Token);
            acquiredConcurrency = true;
            if (runtime.Task.State != NativeTransferState.Queued) return;
            Update(runtime, NativeTransferState.Running, null);
            var session = sessions.Get(runtime.Task.SessionId);
            if (runtime.Task.Direction == NativeTransferDirection.Upload)
            {
                await using var source = new FileStream(runtime.Task.Source, FileMode.Open, FileAccess.Read, FileShare.Read);
                var partialRemote = runtime.Task.Target + ".ofs-partial-" + runtime.Task.Id;
                var offset = runtime.Task.CompletedBytes;
                var partialEntry = offset > 0 ? await session.TryGetAsync(partialRemote, runtime.Cancellation.Token) : null;
                if (offset > 0 && (partialEntry == null || partialEntry.Size != offset || runtime.Task.TotalBytes is { } expectedSize && expectedSize != source.Length)) offset = 0;
                Update(runtime, NativeTransferState.Running, null, offset, source.Length);
                await session.UploadAsync(source, partialRemote, true, runtime.Cancellation.Token,
                    completed => Update(runtime, NativeTransferState.Running, null, completed), offset);
                var uploaded = await session.TryGetAsync(partialRemote, runtime.Cancellation.Token);
                if (uploaded == null || uploaded.Size != source.Length)
                    throw new IOException($"Upload size verification failed ({uploaded?.Size ?? 0}/{source.Length} bytes).");
                var existing = await session.TryGetAsync(runtime.Task.Target, runtime.Cancellation.Token);
                if (existing != null && !runtime.Task.Overwrite) throw new IOException("Remote file already exists; retry with overwrite confirmation.");
                if (existing != null)
                {
                    var backupRemote = runtime.Task.Target + ".ofs-backup-" + runtime.Task.Id;
                    await session.RenameAsync(runtime.Task.Target, backupRemote, runtime.Cancellation.Token);
                    try { await session.RenameAsync(partialRemote, runtime.Task.Target, runtime.Cancellation.Token); }
                    catch { await session.RenameAsync(backupRemote, runtime.Task.Target, CancellationToken.None); throw; }
                    await session.DeleteAsync(backupRemote, false, CancellationToken.None);
                }
                else await session.RenameAsync(partialRemote, runtime.Task.Target, runtime.Cancellation.Token);
                Update(runtime, NativeTransferState.Completed, null, source.Length);
                if (runtime.Task.CleanupSource)
                    try { DeleteStagedSource(runtime.Task.Source); } catch { }
            }
            else
            {
                var remote = await session.TryGetAsync(runtime.Task.Source, runtime.Cancellation.Token);
                if (remote is { IsDirectory: true }) throw new InvalidOperationException("Cannot download a remote directory as a file.");
                var total = remote?.Size;
                var previousSize = runtime.Task.TotalBytes;
                Update(runtime, NativeTransferState.Running, null, 0, total);
                var partial = runtime.Task.Target + ".ofs-partial-" + runtime.Task.Id;
                try
                {
                    var offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
                    if (offset > 0 && remote is { } currentRemote && previousSize is { } expectedSize && expectedSize != currentRemote.Size)
                    {
                        File.Delete(partial);
                        offset = 0;
                    }
                    await using (var destination = new FileStream(partial, offset > 0 ? FileMode.Open : FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        await session.DownloadAsync(runtime.Task.Source, destination, runtime.Cancellation.Token,
                            completed => Update(runtime, NativeTransferState.Running, null, completed, total), offset);
                    }
                    var downloadedLength = new FileInfo(partial).Length;
                    if (total.HasValue && downloadedLength != total.Value)
                        throw new IOException($"Download size verification failed ({downloadedLength}/{total.Value} bytes).");
                    var remoteAfterTransfer = await session.TryGetAsync(runtime.Task.Source, runtime.Cancellation.Token);
                    if (remoteAfterTransfer is { } after && (after.Size != downloadedLength || remote is { } before && after.Modified != before.Modified))
                        throw new IOException("Remote file changed during download; retry the transfer.");
                    File.Move(partial, runtime.Task.Target, true);
                    Update(runtime, NativeTransferState.Completed, null, downloadedLength, total ?? downloadedLength);
                }
                finally
                {
                    // A paused download owns its partial file. Keeping the
                    // bytes and offset lets the next run issue a real SFTP
                    // range continuation instead of silently restarting.
                    var keepPartial = runtime.PauseRequested && !runtime.ControlRequested;
                    if (!keepPartial) { try { if (File.Exists(partial)) File.Delete(partial); } catch { } }
                }
            }
        }
        catch (OperationCanceledException)
        {
            if (runtime.ControlRequested) Update(runtime, NativeTransferState.Canceled, null, 0);
            else if (runtime.PauseRequested) Update(runtime, NativeTransferState.Paused, null);
            else Update(runtime, NativeTransferState.Failed, "Transfer canceled.", 0);
            if (runtime.Task.Direction == NativeTransferDirection.Upload && !runtime.PauseRequested) await CleanupPartialRemoteAsync(runtime);
            if (runtime.ControlRequested && runtime.Task.CleanupSource) try { DeleteStagedSource(runtime.Task.Source); } catch { }
        }
        catch (Exception error)
        {
            if (runtime.Task.Direction == NativeTransferDirection.Upload && !runtime.PauseRequested) await CleanupPartialRemoteAsync(runtime);
            Update(runtime, NativeTransferState.Failed, error.Message, 0);
        }
        finally { if (acquiredConcurrency) concurrency.Release(); }
    }

    private static void DeleteStagedSource(string path)
    {
        File.Delete(path);
        var parent = Path.GetDirectoryName(path);
        var root = Path.Combine(Path.GetTempPath(), "OpenFinalShell.NativeTransfers");
        if (parent != null && Directory.Exists(parent) &&
            parent.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
            !Directory.EnumerateFileSystemEntries(parent).Any())
            Directory.Delete(parent);
    }
    private async Task CleanupPartialRemoteAsync(Runtime runtime)
    {
        try
        {
            var session = sessions.Get(runtime.Task.SessionId);
            var partial = runtime.Task.Target + ".ofs-partial-" + runtime.Task.Id;
            if (await session.TryGetAsync(partial, CancellationToken.None) != null) await session.DeleteAsync(partial, false, CancellationToken.None);
        }
        catch { /* best-effort cleanup; keep the original transfer result */ }
    }

    private async Task CleanupCanceledTransferAsync(Runtime runtime)
    {
        if (runtime.Task.Direction == NativeTransferDirection.Upload) await CleanupPartialRemoteAsync(runtime);
        else
        {
            var partial = runtime.Task.Target + ".ofs-partial-" + runtime.Task.Id;
            try { if (File.Exists(partial)) File.Delete(partial); } catch { }
        }
        if (runtime.Task.CleanupSource) try { DeleteStagedSource(runtime.Task.Source); } catch { }
    }

    private void Update(Runtime runtime, NativeTransferState state, string? error, long? completed = null, long? total = null)
    {
        lock (gate) runtime.Task = runtime.Task with {
            State = state,
            Error = error,
            CompletedBytes = completed ?? runtime.Task.CompletedBytes,
            TotalBytes = total ?? runtime.Task.TotalBytes
        };
        Publish(runtime);
        if (runtime.Task.ParentId is { } parentId)
        {
            Runtime? parent;
            lock (gate) runtimes.TryGetValue(parentId, out parent);
            if (parent != null) RecalculateGroup(parent);
        }
    }

    private void RecalculateGroup(Runtime group)
    {
        NativeTransferTask[] children;
        lock (gate)
        {
            if (!group.Task.IsGroup || !runtimes.ContainsKey(group.Task.Id)) return;
            children = group.Children.Select(id => runtimes.TryGetValue(id, out var child) ? child.Task : null)
                .Where(task => task != null).Cast<NativeTransferTask>().ToArray();
        }
        var completedBytes = children.Sum(child => child.CompletedBytes);
        var completedItems = children.Count(child => child.State == NativeTransferState.Completed);
        var running = children.Any(child => child.State == NativeTransferState.Running);
        var pending = children.Any(child => child.State == NativeTransferState.Queued);
        var paused = children.Any(child => child.State == NativeTransferState.Paused);
        var failed = children.Any(child => child.State == NativeTransferState.Failed);
        var allTerminal = children.Length == group.Task.ChildCount && children.All(child => child.State is NativeTransferState.Completed or NativeTransferState.Failed or NativeTransferState.Canceled);
        var state = allTerminal
            ? failed ? NativeTransferState.Failed : children.All(child => child.State == NativeTransferState.Completed) ? NativeTransferState.Completed : NativeTransferState.Canceled
            : running ? NativeTransferState.Running
            : paused ? NativeTransferState.Paused
            : pending ? NativeTransferState.Queued
            : NativeTransferState.Queued;
        var error = failed ? $"{children.Count(child => child.State == NativeTransferState.Failed)} file(s) failed." : null;
        lock (gate)
        {
            group.Task = group.Task with { State = state, Error = error, CompletedBytes = completedBytes, CompletedItems = completedItems };
        }
        Publish(group);
    }

    private void Publish(Runtime runtime) => Changed?.Invoke(runtime.Task);
    public void Dispose()
    {
        Runtime[] active;
        lock (gate) { active = runtimes.Values.ToArray(); foreach (var runtime in active) runtime.Cancellation.Cancel(); }
        _ = Task.WhenAll(active.Select(runtime => runtime.Worker ?? Task.CompletedTask)).ContinueWith(_ =>
        {
            foreach (var runtime in active) runtime.Cancellation.Dispose();
            concurrency.Dispose();
        }, TaskScheduler.Default);
    }
}
