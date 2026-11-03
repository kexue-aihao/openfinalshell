using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;

namespace OpenFinalShell.Core;

public enum NativeCollectorState { Starting, Running, Failed, Unsupported, Stopped }

/// <summary>
/// Schema-bound Linux monitor collector. It uses one SSH exec request per tick
/// and rejects malformed or unbounded remote values before publishing a snapshot.
/// </summary>
public sealed class NativeMonitorService : IAsyncDisposable
{
    private readonly NativeSession session;
    private readonly object gate = new();
    private CancellationTokenSource? cancellation;
    private Task? worker;
    private NativeMonitorCounters? previousCounters;
    private double directLatencyMs = double.NaN;
    private int directProbeInFlight;
    private int failures;
    private int intervalMs = 2000;
    private long previousSnapshotMs;
    public NativeCollectorState State { get; private set; } = NativeCollectorState.Stopped;
    public MonitorStaticInfo? StaticInfo { get; private set; }
    public event Action<NativeCollectorState, string?>? StateChanged;
    public event Action<MonitorSnapshot>? Snapshot;

    public NativeMonitorService(NativeSession session) => this.session = session;

    public async Task StartAsync(int intervalMs = 2000, CancellationToken cancellation = default)
    {
        await StopAsync();
        this.intervalMs = Math.Clamp(intervalMs, 500, 60000);
        cancellation.ThrowIfCancellationRequested();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        try
        {
            var staticInfo = await ReadStaticAsync(linked.Token);
            if (staticInfo == null) { SetState(NativeCollectorState.Unsupported, "Remote host does not expose Linux /proc metrics."); return; }
            StaticInfo = staticInfo; SetState(NativeCollectorState.Running, null);
            this.cancellation = new CancellationTokenSource();
            worker = PollAsync(this.cancellation.Token);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch (Exception error) { SetState(NativeCollectorState.Failed, error.Message); throw; }
    }

    private async Task PollAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(intervalMs));
        while (await timer.WaitForNextTickAsync(token))
        {
            try
            {
                var snapshot = await ReadSnapshotAsync(token);
                if (snapshot != null) { failures = 0; SetState(NativeCollectorState.Running, null); Snapshot?.Invoke(snapshot); }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                failures++;
                if (failures >= 3) { SetState(NativeCollectorState.Failed, error.Message); break; }
            }
        }
    }

    private async Task<MonitorStaticInfo?> ReadStaticAsync(CancellationToken token)
    {
        var output = await session.ExecuteAsync("printf 'uname=%s\\n' \"$(uname -s)\"; printf 'hostname=%s\\n' \"$(hostname)\"; printf 'arch=%s\\n' \"$(uname -m)\"; printf 'kernel=%s\\n' \"$(uname -r)\"; printf 'addresses=%s\\n' \"$(hostname -I 2>/dev/null)\"", token);
        var values = ParseKeyValues(output);
        if (!values.TryGetValue("uname", out var uname) || !uname.Equals("Linux", StringComparison.OrdinalIgnoreCase)) return null;
        var addresses = values.TryGetValue("addresses", out var raw) ? raw.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(64).ToArray() : [];
        return new(values.GetValueOrDefault("hostname", ""), values.GetValueOrDefault("kernel", ""), values.GetValueOrDefault("arch", ""), "Linux", addresses);
    }

    private async Task<MonitorSnapshot?> ReadSnapshotAsync(CancellationToken token)
    {
        ProbeDirectLatency();
        var script = "printf '@@UPTIME@@\\n'; cat /proc/uptime; printf '@@LOAD@@\\n'; cat /proc/loadavg; " +
            "printf '@@CPU@@\\n'; awk '/^cpu[0-9]* / {print}' /proc/stat; " +
            "printf '@@MEM@@\\n'; awk '/^MemTotal:|^MemAvailable:|^MemFree:|^Buffers:|^Cached:|^SReclaimable:|^SwapTotal:|^SwapFree:/ {print $1,$2}' /proc/meminfo; " +
            "printf '@@NET@@\\n'; awk 'NR>2 {gsub(/:/,\"\",$1); print $1,$2,$10}' /proc/net/dev; " +
            "printf '@@DISKIO@@\\n'; awk '{print $3,$6,$10}' /proc/diskstats; " +
            "printf '@@DF@@\\n'; df -kP 2>/dev/null; " +
            "printf '@@PROCS@@\\n'; if ps -eo pid,pcpu,pmem,comm --sort=-pcpu >/dev/null 2>&1; then ps -eo pid,pcpu,pmem,comm --sort=-pcpu; else ps -eo pid,pcpu,pmem,comm; fi 2>/dev/null | awk 'NR>1 && NR<=11 {name=$4; for(i=5;i<=NF;i++) name=name \" \" $i; print $1,$2,$3,name}'; " +
            "printf '@@SOCK@@\\n'; cat /proc/net/sockstat /proc/net/sockstat6 2>/dev/null; " +
            "printf '@@TCP@@\\n'; awk 'NR>1 {count[$4]++} END {for (state in count) print state,count[state]}' /proc/net/tcp /proc/net/tcp6 2>/dev/null";
        var startedAt = Stopwatch.GetTimestamp();
        var output = await session.ExecuteAsync(script, token);
        var elapsedCallMs = Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var elapsedSeconds = previousSnapshotMs == 0 ? 0 : Math.Max(0.001, (timestamp - previousSnapshotMs) / 1000d);
        var parsed = NativeMonitorParser.Parse(output, previousCounters, timestamp, elapsedSeconds, elapsedCallMs);
        previousCounters = parsed.Counters;
        previousSnapshotMs = timestamp;
        var directLatency = Volatile.Read(ref directLatencyMs);
        return parsed.Snapshot with { DirectLatencyMs = double.IsFinite(directLatency) ? directLatency : null };
    }

    private void ProbeDirectLatency()
    {
        if (Interlocked.CompareExchange(ref directProbeInFlight, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                using var ping = new Ping();
                var reply = await ping.SendPingAsync(session.Profile.Host, 1500);
                Volatile.Write(ref directLatencyMs, reply.Status == IPStatus.Success ? reply.RoundtripTime : double.NaN);
            }
            catch { Volatile.Write(ref directLatencyMs, double.NaN); }
            finally { Volatile.Write(ref directProbeInFlight, 0); }
        });
    }

    private static Dictionary<string, string> ParseKeyValues(string output) => output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Select(line => line.Split('=', 2)).Where(parts => parts.Length == 2 && parts[0].Length <= 32).ToDictionary(parts => parts[0], parts => parts[1].Trim(), StringComparer.Ordinal);
    private void SetState(NativeCollectorState state, string? error) { State = state; StateChanged?.Invoke(state, error); }
    public async Task StopAsync()
    {
        cancellation?.Cancel();
        if (worker != null) try { await worker; } catch (OperationCanceledException) { }
        cancellation?.Dispose(); cancellation = null; worker = null; SetState(NativeCollectorState.Stopped, null);
    }
    public async ValueTask DisposeAsync() => await StopAsync();
}

public static class NativePortTrafficParser
{
    public static IReadOnlyList<NativePortTrafficCounter> Parse(string text)
    {
        var values = new List<NativePortTrafficCounter>();
        foreach (var line in text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 5 || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var port) || port is < 1 or > 65535 ||
                !long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var connections) || connections < 0 ||
                !long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var rx) || rx < 0 ||
                !long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var tx) || tx < 0 ||
                !long.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var counterConnections) || counterConnections < 0 || counterConnections > connections) continue;
            values.Add(new(port, connections, rx, tx, counterConnections));
        }
        return values.OrderByDescending(item => item.Connections).ThenBy(item => item.Port).Take(4096).ToArray();
    }
}

public sealed record NativePortTrafficCounter(int Port, long Connections, long RxBytes, long TxBytes, long CounterConnections)
{
    public bool RatesAvailable => CounterConnections == Connections;
}

public enum NativePortTrafficState { Starting, Running, Failed, Unsupported, Stopped }

public sealed class NativePortTrafficService : IAsyncDisposable
{
    private const string AggregateAwk = """
function flush() {
  if (port == "") return
  conns[port]++
  rx[port] += received
  tx[port] += sent
  if (has_sent && has_received) counter_conns[port]++
}
$1 ~ /^(ESTAB|SYN-SENT|SYN-RECV|FIN-WAIT-1|FIN-WAIT-2|TIME-WAIT|CLOSE|CLOSE-WAIT|LAST-ACK|CLOSING|LISTEN)$/ {
  flush()
  endpoint = $4
  sub(/^.*:/, "", endpoint)
  port = (endpoint ~ /^[0-9]+$/ && endpoint >= 1 && endpoint <= 65535) ? endpoint : ""
  sent = 0; received = 0; has_sent = 0; has_received = 0
  next
}
{
  for (i = 1; i <= NF; i++) {
    if ($i ~ /^bytes_sent:/) { value = $i; sub(/^bytes_sent:/, "", value); if (value ~ /^[0-9]+$/) { sent = value; has_sent = 1 } }
    else if ($i ~ /^bytes_received:/) { value = $i; sub(/^bytes_received:/, "", value); if (value ~ /^[0-9]+$/) { received = value; has_received = 1 } }
  }
}
END { flush(); for (p in conns) printf "%s %d %.0f %.0f %d\n", p, conns[p], rx[p], tx[p], counter_conns[p] + 0 }
""";
    private readonly NativeSession session;
    private CancellationTokenSource? cancellation;
    private Task? worker;
    private Dictionary<int, NativePortTrafficCounter> previous = [];
    private long previousTimestamp;
    private int failures;
    private int intervalMs;
    public NativePortTrafficState State { get; private set; } = NativePortTrafficState.Stopped;
    public event Action<NativePortTrafficState, string?>? StateChanged;
    public event Action<PortTrafficSnapshot>? Snapshot;

    public NativePortTrafficService(NativeSession session, int intervalMs = 2000) { this.session = session; this.intervalMs = Math.Clamp(intervalMs, 1000, 60000); }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        await StopAsync(); cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        SetState(NativePortTrafficState.Starting, null); worker = RunAsync(cancellation.Token);
    }

    private async Task RunAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var output = await session.ExecuteAsync(BuildCommand(), token);
                if (output.Length > 512 * 1024) throw new InvalidDataException("Port traffic response exceeded the safety limit.");
                if (output.Contains("OFS_NOSS", StringComparison.Ordinal)) { SetState(NativePortTrafficState.Unsupported, "ss is unavailable on the remote host."); return; }
                var counters = NativePortTrafficParser.Parse(output).ToDictionary(item => item.Port);
                var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var elapsed = previousTimestamp == 0 ? 0 : Math.Max(0.001, (timestamp - previousTimestamp) / 1000d);
                var values = counters.Values.Select(current =>
                {
                    var ratesAvailable = current.RatesAvailable;
                    var rx = 0L; var tx = 0L;
                    if (ratesAvailable && elapsed > 0 && previous.TryGetValue(current.Port, out var old) && old.RatesAvailable)
                    {
                        rx = Rate(current.RxBytes, old.RxBytes, elapsed); tx = Rate(current.TxBytes, old.TxBytes, elapsed);
                    }
                    return new PortTrafficEntry(current.Port, current.Connections, ratesAvailable, rx, tx);
                }).OrderByDescending(value => value.RxBps + value.TxBps).ThenByDescending(value => value.Connections).ThenBy(value => value.Port).ToArray();
                previous = counters; previousTimestamp = timestamp; failures = 0;
                Snapshot?.Invoke(new(timestamp, values)); SetState(NativePortTrafficState.Running, null);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                failures++;
                if (failures >= 3) { SetState(NativePortTrafficState.Failed, error.Message); return; }
            }
            try { await Task.Delay(intervalMs, token); } catch (OperationCanceledException) { break; }
        }
    }

    private static long Rate(long current, long old, double elapsed) => checked((long)Math.Min(Math.Max(0, current - old) / elapsed, long.MaxValue));
    private static string BuildCommand() => "if command -v ss >/dev/null 2>&1; then ss -ntinH 2>/dev/null | awk '" + AggregateAwk + "'; else printf 'OFS_NOSS\\n'; fi";
    private void SetState(NativePortTrafficState state, string? error) { State = state; StateChanged?.Invoke(state, error); }
    public async Task StopAsync()
    {
        cancellation?.Cancel(); if (worker != null) try { await worker; } catch (OperationCanceledException) { }
        cancellation?.Dispose(); cancellation = null; worker = null; SetState(NativePortTrafficState.Stopped, null);
    }
    public async ValueTask DisposeAsync() => await StopAsync();
}
