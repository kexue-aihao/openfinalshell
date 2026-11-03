using OpenFinalShell.Core;

public static class NativeForwardTelemetryContractTests
{
    public static void Run(Action<bool, string> check)
    {
        foreach (var type in Enum.GetValues<NativeForwardType>())
        {
            var counter = new NativeForwardTelemetryCounter($"{type.ToString().ToLowerInvariant()}-test");
            check(counter.BeginConnection(), $"{type} forwarding opens a telemetry connection");
            check(counter.BeginConnection(), $"{type} forwarding tracks multiple active connections");
            counter.AddBytes(1024);
            counter.AddBytes(2048);
            check(counter.Snapshot is { ActiveConnections: 2, TotalBytes: 3072 }, $"{type} forwarding records both byte directions");

            counter.EndConnection();
            check(counter.Snapshot is { ActiveConnections: 1, TotalBytes: 3072 }, $"{type} forwarding decrements closed connections and preserves bytes");
            counter.EndConnection();
            counter.EndConnection();
            check(counter.Snapshot is { ActiveConnections: 0, TotalBytes: 3072 }, $"{type} forwarding never reports a negative connection count");

            counter.BeginConnection();
            counter.AddBytes(128);
            counter.Stop();
            check(counter.Snapshot is { ActiveConnections: 0, TotalBytes: 3200 }, $"{type} forwarding stop clears active connections and retains byte totals");
            counter.AddBytes(100);
            counter.Stop();
            check(counter.Snapshot is { ActiveConnections: 0, TotalBytes: 3200 }, $"{type} forwarding ignores late byte updates after stop");
            var rejected = false;
            try { counter.BeginConnection(); }
            catch (InvalidOperationException) { rejected = true; }
            check(rejected, $"{type} forwarding cannot reopen a stopped telemetry runtime");
        }
    }
}
