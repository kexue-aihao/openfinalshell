namespace OpenFinalShell.Core;

/// <summary>Thread-safe connection/byte accounting for one active forward rule.</summary>
internal sealed class NativeForwardTelemetryCounter(string forwardId)
{
    private readonly object gate = new();
    private long activeConnections;
    private long totalBytes;
    private bool stopped;

    public ForwardTelemetrySnapshot Snapshot { get { lock (gate) return new(forwardId, activeConnections, totalBytes); } }

    public bool BeginConnection()
    {
        lock (gate)
        {
            if (stopped) throw new InvalidOperationException("Forward telemetry counter is stopped.");
            activeConnections++;
            return true;
        }
    }

    public void EndConnection()
    {
        lock (gate) if (activeConnections > 0) activeConnections--;
    }

    public void AddBytes(long bytes)
    {
        if (bytes <= 0) return;
        lock (gate) if (!stopped) totalBytes = checked(totalBytes + bytes);
    }

    public void Stop()
    {
        lock (gate) { stopped = true; activeConnections = 0; }
    }
}
