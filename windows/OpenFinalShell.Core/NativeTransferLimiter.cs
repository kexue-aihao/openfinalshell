namespace OpenFinalShell.Core;

/// <summary>Live global and per-session limits; lowering a limit drains existing work.</summary>
public sealed class NativeTransferLimiter : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, int> sessions = new(StringComparer.Ordinal);
    private TaskCompletionSource pulse = NewPulse();
    private int globalLimit = 4, sessionLimit = 2, active;
    private bool disposed;
    private static TaskCompletionSource NewPulse() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Configure(int global, int perSession)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            globalLimit = Math.Clamp(global, 1, 32); sessionLimit = Math.Clamp(perSession, 1, 16);
            Wake();
        }
    }
    public async Task<IDisposable> AcquireAsync(string sessionId, CancellationToken cancellation = default)
    {
        while (true)
        {
            Task wait;
            lock (gate)
            {
                cancellation.ThrowIfCancellationRequested();
                ObjectDisposedException.ThrowIf(disposed, this);
                sessions.TryGetValue(sessionId, out var count);
                if (active < globalLimit && count < sessionLimit)
                {
                    active++; sessions[sessionId] = count + 1;
                    return new Lease(this, sessionId);
                }
                wait = pulse.Task;
            }
            await wait.WaitAsync(cancellation).ConfigureAwait(false);
        }
    }
    private void Release(string id)
    {
        lock (gate)
        {
            active--;
            if (--sessions[id] == 0) sessions.Remove(id);
            Wake();
        }
    }
    private void Wake() { var previous = pulse; pulse = NewPulse(); previous.TrySetResult(); }
    public void Dispose() { lock (gate) { disposed = true; Wake(); } }
    private sealed class Lease(NativeTransferLimiter owner, string id) : IDisposable
    {
        private NativeTransferLimiter? current = owner;
        public void Dispose() => Interlocked.Exchange(ref current, null)?.Release(id);
    }
}
