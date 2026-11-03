using System.Globalization;
using System.Text;

namespace OpenFinalShell.Core;

public sealed record NativeMonitorCpuCounter(ulong Total, ulong Idle);
public sealed record NativeMonitorNetworkCounter(long RxBytes, long TxBytes);
public sealed record NativeMonitorDiskCounter(long ReadSectors, long WriteSectors);
public sealed record NativeMonitorCounters(
    NativeMonitorCpuCounter Cpu,
    IReadOnlyList<NativeMonitorCpuCounter> PerCore,
    IReadOnlyDictionary<string, NativeMonitorNetworkCounter> Network,
    IReadOnlyDictionary<string, NativeMonitorDiskCounter> DiskIo);

/// <summary>Parses bounded, line-oriented Linux /proc snapshots emitted by the native SSH collector.</summary>
public static class NativeMonitorParser
{
    private static readonly string[] TcpStateNames =
    [
        "", "ESTABLISHED", "SYN_SENT", "SYN_RECV", "FIN_WAIT1", "FIN_WAIT2", "TIME_WAIT", "CLOSE", "CLOSE_WAIT", "LAST_ACK", "LISTEN", "CLOSING", "NEW_SYN_RECV"
    ];
    private static readonly string[] SkipFilesystems = ["tmpfs", "devtmpfs", "udev", "overlay", "squashfs", "none", "shm", "cgroup"];

    public static (MonitorSnapshot Snapshot, NativeMonitorCounters Counters) Parse(
        string output,
        NativeMonitorCounters? previous,
        long timestamp,
        double elapsedSeconds,
        double? connectionLatencyMs = null)
    {
        if (output.Length > 1024 * 1024) throw new InvalidDataException("Monitor response exceeded the safety limit.");
        var sections = SplitSections(output);
        var uptimeLine = FirstLine(Required(sections, "UPTIME"));
        var uptimeParts = Fields(uptimeLine);
        var uptime = uptimeParts.Length > 0 ? ParseDouble(uptimeParts[0], "uptime", 0, 3155760000) : throw new InvalidDataException("Invalid uptime.");
        var loadParts = Fields(Required(sections, "LOAD").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "");
        if (loadParts.Length < 3) throw new InvalidDataException("Invalid load average.");
        var load = loadParts.Take(3).Select(value => ParseDouble(value, "load average", 0, 1e12)).ToArray();
        var cpuLines = Required(sections, "CPU").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        NativeMonitorCpuCounter? allCpu = null;
        var cores = new List<NativeMonitorCpuCounter>();
        foreach (var line in cpuLines)
        {
            var fields = Fields(line);
            if (fields.Length < 5) continue;
            var label = fields[0];
            if (label != "cpu" && !IsCpuCore(label)) continue;
            var values = fields.Skip(1).Select(value => ParseUnsigned(value, "CPU counter")).ToArray();
            ulong total = 0;
            foreach (var value in values) total = checked(total + value);
            var idle = checked(values[3] + (values.Length > 4 ? values[4] : 0));
            var counter = new NativeMonitorCpuCounter(total, idle);
            if (label == "cpu") allCpu = counter;
            else cores.Add(counter);
        }
        if (allCpu == null) throw new InvalidDataException("Invalid CPU counters.");

        var memory = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var line in Required(sections, "MEM").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = Fields(line);
            if (parts.Length == 2 && parts[0].EndsWith(':'))
                memory[parts[0][..^1]] = ParseLong(parts[1], "memory counter");
        }
        var totalKb = memory.GetValueOrDefault("MemTotal");
        var fallbackAvailable = checked(memory.GetValueOrDefault("MemFree") + memory.GetValueOrDefault("Buffers") + memory.GetValueOrDefault("Cached") + memory.GetValueOrDefault("SReclaimable"));
        var availableKb = memory.GetValueOrDefault("MemAvailable", Math.Min(memory.GetValueOrDefault("MemTotal"), fallbackAvailable));
        var swapTotalKb = memory.GetValueOrDefault("SwapTotal");
        var swapFreeKb = memory.GetValueOrDefault("SwapFree");
        if (totalKb <= 0 || availableKb < 0 || availableKb > totalKb || swapTotalKb < 0 || swapFreeKb < 0 || swapFreeKb > swapTotalKb)
            throw new InvalidDataException("Invalid memory counters.");

        var network = new Dictionary<string, NativeMonitorNetworkCounter>(StringComparer.Ordinal);
        foreach (var line in Optional(sections, "NET").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = Fields(line);
            if (fields.Length < 3 || fields[0].Length > 64 || fields[0].Contains('/') || fields[0].Contains('\\') ||
                fields[0] == "lo" || fields[0].StartsWith("docker", StringComparison.Ordinal) || fields[0].StartsWith("veth", StringComparison.Ordinal) ||
                fields[0].StartsWith("br-", StringComparison.Ordinal) || fields[0].StartsWith("virbr", StringComparison.Ordinal) ||
                fields[0].StartsWith("tun", StringComparison.Ordinal) || fields[0].StartsWith("tap", StringComparison.Ordinal)) continue;
            network[fields[0]] = new(ParseLong(fields[1], "network counter"), ParseLong(fields[2], "network counter"));
            if (network.Count >= 256) break;
        }

        var disk = new Dictionary<string, NativeMonitorDiskCounter>(StringComparer.Ordinal);
        foreach (var line in Optional(sections, "DISKIO").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = Fields(line);
            if (fields.Length < 3 || !IsPhysicalDisk(fields[0])) continue;
            disk[fields[0]] = new(ParseLong(fields[1], "disk read counter"), ParseLong(fields[2], "disk write counter"));
            if (disk.Count >= 256) break;
        }

        var cpuUsage = previous == null ? 0 : CpuPercent(previous.Cpu, allCpu);
        var perCore = cores.Select((current, index) => previous != null && index < previous.PerCore.Count
            ? CpuPercent(previous.PerCore[index], current) : 0).ToArray();
        var elapsed = Math.Clamp(elapsedSeconds, 0, 86400);
        var networks = network.Select(pair =>
        {
            var before = previous?.Network.GetValueOrDefault(pair.Key);
            return new MonitorNetwork(pair.Key,
                before == null ? 0 : Rate(pair.Value.RxBytes, before.RxBytes, elapsed),
                before == null ? 0 : Rate(pair.Value.TxBytes, before.TxBytes, elapsed),
                pair.Value.RxBytes, pair.Value.TxBytes);
        }).OrderBy(item => item.Interface, StringComparer.Ordinal).ToArray();
        var diskIo = disk.Select(pair =>
        {
            var before = previous?.DiskIo.GetValueOrDefault(pair.Key);
            return new MonitorDiskIo(pair.Key,
                before == null ? 0 : Rate(Delta(pair.Value.ReadSectors, before.ReadSectors), 0, elapsed, 512),
                before == null ? 0 : Rate(Delta(pair.Value.WriteSectors, before.WriteSectors), 0, elapsed, 512));
        }).OrderBy(item => item.Device, StringComparer.Ordinal).ToArray();

        var tcpStates = ParseTcpStates(Optional(sections, "TCP"));
        var connCounts = ParseConnections(Optional(sections, "SOCK"));
        var snapshot = new MonitorSnapshot(
            timestamp,
            uptime,
            new(cpuUsage, perCore, [load[0], load[1], load[2]]),
            new(totalKb, availableKb, totalKb - availableKb, swapTotalKb, swapTotalKb - swapFreeKb),
            networks,
            ParseDiskFs(Optional(sections, "DF")),
            diskIo,
            ParseProcesses(Optional(sections, "PROCS")),
            connCounts,
            tcpStates,
            connectionLatencyMs,
            null);
        var counters = new NativeMonitorCounters(allCpu, cores, network, disk);
        return (snapshot, counters);
    }

    private static Dictionary<string, string> SplitSections(string output)
    {
        var sections = new Dictionary<string, StringBuilder>(StringComparer.Ordinal);
        StringBuilder? current = null;
        foreach (var rawLine in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var line = rawLine.TrimEnd();
            if (line.Length >= 5 && line.StartsWith("@@", StringComparison.Ordinal) && line.EndsWith("@@", StringComparison.Ordinal))
            {
                var name = line[2..^2];
                if (name.Length is > 0 and <= 16)
                {
                    current = new StringBuilder();
                    sections[name] = current;
                    continue;
                }
            }
            current?.AppendLine(line);
        }
        return sections.ToDictionary(pair => pair.Key, pair => pair.Value.ToString(), StringComparer.Ordinal);
    }

    private static string Required(IReadOnlyDictionary<string, string> sections, string name) =>
        sections.TryGetValue(name, out var value) && value.Length > 0 ? value : throw new InvalidDataException($"Monitor response is missing {name}.");
    private static string Optional(IReadOnlyDictionary<string, string> sections, string name) => sections.GetValueOrDefault(name, "");
    private static string FirstLine(string value) => value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "";
    private static string[] Fields(string line) => line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    private static bool IsCpuCore(string label) => label.Length > 3 && label.StartsWith("cpu", StringComparison.Ordinal) && label.AsSpan(3).IndexOfAnyExceptInRange('0', '9') < 0;
    private static bool IsPhysicalDisk(string name) =>
        name.StartsWith("sd", StringComparison.Ordinal) && name.Length == 3 && char.IsAsciiLetterLower(name[2]) ||
        name.StartsWith("vd", StringComparison.Ordinal) && name.Length == 3 && char.IsAsciiLetterLower(name[2]) ||
        name.StartsWith("xvd", StringComparison.Ordinal) && name.Length == 4 && char.IsAsciiLetterLower(name[3]) ||
        name.StartsWith("hd", StringComparison.Ordinal) && name.Length == 3 && char.IsAsciiLetterLower(name[2]) ||
        name.StartsWith("nvme", StringComparison.Ordinal) && name.Contains('n') && name.All(char.IsAsciiLetterOrDigit) && !name.Contains('p') ||
        name.StartsWith("mmcblk", StringComparison.Ordinal) && name[6..].All(char.IsAsciiDigit);

    private static double ParseDouble(string value, string name, double min, double max) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result) && double.IsFinite(result) && result >= min && result <= max
            ? result : throw new InvalidDataException($"Invalid {name}.");
    private static ulong ParseUnsigned(string value, string name) => ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result)
        ? result : throw new InvalidDataException($"Invalid {name}.");
    private static long ParseLong(string value, string name) => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result) && result >= 0
        ? result : throw new InvalidDataException($"Invalid {name}.");
    private static double CpuPercent(NativeMonitorCpuCounter before, NativeMonitorCpuCounter current)
    {
        if (current.Total <= before.Total || current.Idle < before.Idle) return 0;
        var total = current.Total - before.Total;
        var idle = Math.Min(total, current.Idle - before.Idle);
        return Math.Clamp((double)(total - idle) * 100 / total, 0, 100);
    }
    private static long Delta(long current, long previous) => current >= previous ? current - previous : 0;
    private static long Rate(long current, long previous, double elapsed, long multiplier = 1)
    {
        if (elapsed <= 0) return 0;
        var delta = Math.Max(0, current - previous);
        return checked((long)Math.Min((double)delta * multiplier / elapsed, long.MaxValue));
    }

    private static IReadOnlyList<MonitorDiskFs> ParseDiskFs(string text)
    {
        var result = new List<MonitorDiskFs>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Skip(1))
        {
            var fields = Fields(line);
            if (fields.Length < 6 || SkipFilesystems.Any(prefix => fields[0].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))) continue;
            if (!long.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out var total) || total <= 0 ||
                !long.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out var used) || used < 0) continue;
            var pctText = fields[4].TrimEnd('%');
            if (!double.TryParse(pctText, NumberStyles.Float, CultureInfo.InvariantCulture, out var pct) || !double.IsFinite(pct)) continue;
            result.Add(new(fields[0], string.Join(' ', fields.Skip(5)), total, used, Math.Clamp(pct, 0, 100)));
            if (result.Count >= 256) break;
        }
        return result;
    }

    private static MonitorConnections? ParseConnections(string text)
    {
        var values = new Dictionary<string, int>(StringComparer.Ordinal);
        var hit = false;
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = Fields(line);
            if (fields.Length < 3) continue;
            var family = fields[0].TrimEnd(':');
            for (var index = 1; index + 1 < fields.Length; index += 2)
            {
                if (!int.TryParse(fields[index + 1], NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count < 0) continue;
                var key = fields[index];
                var normalizedFamily = family.EndsWith('6') ? family[..^1] : family;
                if (normalizedFamily == "sockets" && key == "used") values["sockets"] = count;
                if (normalizedFamily == "TCP" && key is "inuse" or "orphan" or "tw") values[$"tcp-{key}"] = values.GetValueOrDefault($"tcp-{key}") + count;
                if (normalizedFamily == "UDP" && key == "inuse") values["udp"] = values.GetValueOrDefault("udp") + count;
                if (normalizedFamily is "TCP" or "UDP" or "sockets") hit = true;
            }
        }
        return hit ? new(values.GetValueOrDefault("sockets"), values.GetValueOrDefault("tcp-inuse"), values.GetValueOrDefault("tcp-orphan"), values.GetValueOrDefault("tcp-tw"), values.GetValueOrDefault("udp")) : null;
    }

    private static IReadOnlyDictionary<string, int> ParseTcpStates(string text)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = Fields(line);
            if (fields.Length != 2 || fields[0].Length is < 1 or > 2 || !byte.TryParse(fields[0], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var state) ||
                !int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count < 0) continue;
            var name = state < TcpStateNames.Length && TcpStateNames[state].Length > 0 ? TcpStateNames[state] : $"UNKNOWN_{state:X2}";
            result[name] = result.GetValueOrDefault(name) + count;
        }
        return result;
    }

    private static IReadOnlyList<MonitorProcess> ParseProcesses(string text)
    {
        var result = new List<MonitorProcess>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = line.Split((char[]?)null, 4, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (fields.Length < 4 || !int.TryParse(fields[0], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid <= 0 ||
                !double.TryParse(fields[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var cpu) || !double.IsFinite(cpu) ||
                !double.TryParse(fields[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var memory) || !double.IsFinite(memory)) continue;
            result.Add(new(pid, fields[3].Length > 255 ? fields[3][..255] : fields[3], Math.Clamp(cpu, 0, 10000), Math.Clamp(memory, 0, 100)));
        }
        return result.OrderByDescending(item => item.CpuPct).ThenByDescending(item => item.MemoryPct).Take(10).ToArray();
    }
}
