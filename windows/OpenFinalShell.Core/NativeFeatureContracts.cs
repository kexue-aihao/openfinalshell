using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record AiProviderProfile(string Id, string Name, Uri BaseUrl, string Model, bool Enabled, bool HasToken, long CreatedAt, long UpdatedAt);
public sealed record AiProviderDraft(string? Id, string Name, Uri BaseUrl, string Model, bool Enabled, string? Token, bool ClearToken = false);
public sealed record AiModelInfo(string Id, string? OwnedBy, int? ContextWindow);
public sealed record AiConnectionTestResult(string Model, int LatencyMs);
public sealed record AiImageAttachment(string DataUrl, string Detail = "auto");
public sealed record AiChatMessage(string Role, string Content, IReadOnlyList<AiImageAttachment>? Images = null);
public sealed record AiImageCapabilityResult(string Model, string Image, string Outcome, string Message, int HttpStatus);
public sealed record MonitorStaticInfo(string Hostname, string Kernel, string Architecture, string Distribution, IReadOnlyList<string> Addresses);
public sealed record MonitorMemory(long TotalKb, long AvailableKb, long UsedKb, long SwapTotalKb, long SwapUsedKb);
public sealed record MonitorCpu(double UsagePct, IReadOnlyList<double> PerCore, IReadOnlyList<double> LoadAvg);
public sealed record MonitorNetwork(string Interface, long RxBps, long TxBps, long RxTotalBytes, long TxTotalBytes);
public sealed record MonitorDiskFs(string Filesystem, string Mount, long TotalKb, long UsedKb, double UsePct);
public sealed record MonitorDiskIo(string Device, long ReadBps, long WriteBps);
public sealed record MonitorProcess(int Pid, string Name, double CpuPct, double MemoryPct);
public sealed record MonitorConnections(int SocketsUsed, int TcpInUse, int TcpOrphan, int TcpTimeWait, int UdpInUse);
public sealed record MonitorSnapshot(
    long Timestamp,
    double UptimeSeconds,
    MonitorCpu Cpu,
    MonitorMemory Memory,
    IReadOnlyList<MonitorNetwork> Network,
    IReadOnlyList<MonitorDiskFs>? DiskFs = null,
    IReadOnlyList<MonitorDiskIo>? DiskIo = null,
    IReadOnlyList<MonitorProcess>? TopProcesses = null,
    MonitorConnections? Connections = null,
    IReadOnlyDictionary<string, int>? TcpStates = null,
    double? ConnectionLatencyMs = null,
    double? DirectLatencyMs = null);
public sealed record PortTrafficEntry(int Port, long Connections, bool RatesAvailable, long RxBps, long TxBps);
public sealed record PortTrafficSnapshot(long Timestamp, IReadOnlyList<PortTrafficEntry> Ports);
public sealed record NativeSnippetGroup(string Id, string Name, double Order);
public sealed record NativeSnippet(string Id, string GroupId, string Name, string Command, bool AutoEnter, double Order);
public sealed record NativeSnippetDuplicateGroup(string Key, string GroupId, string GroupName, IReadOnlyList<NativeSnippet> Snippets);
public sealed record NativeSnippetDuplicateSelection(string GroupKey, string KeepSnippetId, IReadOnlyList<string> PreviewSnippetIds);
public sealed record NativeConnectionProgress(
    string SessionId,
    string ProfileId,
    string StepKey,
    int Percent,
    int StepIndex,
    int StepCount,
    bool WaitingForUser,
    string? WaitingReasonKey = null);
public sealed record NativeSshConnectionProgress(string Phase, bool WaitingForUser = false, string? WaitingReasonKey = null);

public enum NativeForwardType { Local, Remote, Dynamic }
public enum NativeForwardState { Stopped, Active, Error }

/// <summary>Persisted SSH forwarding rule. The payload mirrors the shared ForwardRule contract.</summary>
public sealed record NativeForwardRule(
    string Id,
    string ProfileId,
    NativeForwardType Type,
    string Label,
    string BindAddress,
    int BindPort,
    string? DestinationHost,
    int? DestinationPort,
    bool AutoStart,
    long Revision)
{
    public static NativeForwardRule FromJson(JsonObject data)
    {
        static string Text(JsonObject value, string name, int max, bool required = true)
        {
            var result = value[name]?.GetValue<string>()?.Trim() ?? string.Empty;
            if (required && result.Length == 0 || result.Length > max) throw new InvalidDataException($"Invalid forwarding {name}");
            return result;
        }
        var typeText = Text(data, "type", 16).ToLowerInvariant();
        var type = typeText switch
        {
            "local" => NativeForwardType.Local,
            "remote" => NativeForwardType.Remote,
            "dynamic" => NativeForwardType.Dynamic,
            _ => throw new InvalidDataException("native.errors.invalidForward")
        };
        var bindPort = data["bindPort"]?.GetValue<int>() ?? 0;
        if (bindPort is < 1 or > 65535) throw new InvalidDataException("Invalid forwarding bindPort");
        var destinationHost = type == NativeForwardType.Dynamic ? null : Text(data, "dstHost", 255);
        var destinationPort = type == NativeForwardType.Dynamic ? null : data["dstPort"]?.GetValue<int>();
        if (type != NativeForwardType.Dynamic && destinationPort is < 1 or > 65535) throw new InvalidDataException("Invalid forwarding dstPort");
        var revision = 0L;
        if (data["_revision"] is JsonValue revisionValue)
        {
            if (!revisionValue.TryGetValue<long>(out revision) && revisionValue.TryGetValue<int>(out var smallRevision)) revision = smallRevision;
        }
        return new(
            Text(data, "id", 200), Text(data, "profileId", 200), type,
            Text(data, "label", 120), Text(data, "bindAddr", 64), bindPort,
            destinationHost, destinationPort, data["autoStart"]?.GetValue<bool>() ?? false,
            revision);
    }

    public JsonObject ToJson() => new()
    {
        ["id"] = Id,
        ["profileId"] = ProfileId,
        ["type"] = Type switch { NativeForwardType.Local => "local", NativeForwardType.Remote => "remote", _ => "dynamic" },
        ["label"] = Label,
        ["bindAddr"] = BindAddress,
        ["bindPort"] = BindPort,
        ["dstHost"] = DestinationHost,
        ["dstPort"] = DestinationPort,
        ["autoStart"] = AutoStart
    };
}

public sealed record NativeForwardRuntime(
    string ForwardId,
    NativeForwardState State,
    string? SessionId,
    long ActiveConnections,
    long TotalBytes,
    string? Error);
