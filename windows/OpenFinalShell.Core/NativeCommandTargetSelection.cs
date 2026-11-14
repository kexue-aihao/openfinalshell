namespace OpenFinalShell.Core;

public enum NativeCommandTargetMode
{
    Current,
    All,
    Selected
}

/// <summary>Tracks the active command destination while resolving only ready session IDs.</summary>
public sealed class NativeCommandTargetSelection
{
    private readonly HashSet<string> selectedSessionIds = new(StringComparer.Ordinal);

    public NativeCommandTargetMode Mode { get; private set; } = NativeCommandTargetMode.Current;
    public IReadOnlySet<string> SelectedSessionIds => selectedSessionIds;

    public void UseCurrent() => Mode = NativeCommandTargetMode.Current;

    public void UseAll() => Mode = NativeCommandTargetMode.All;

    public void SetSelected(string sessionId, bool selected)
    {
        Mode = NativeCommandTargetMode.Selected;
        if (selected) selectedSessionIds.Add(sessionId);
        else selectedSessionIds.Remove(sessionId);
    }

    public void SetSelected(IEnumerable<string> sessionIds)
    {
        ArgumentNullException.ThrowIfNull(sessionIds);
        selectedSessionIds.Clear();
        selectedSessionIds.UnionWith(sessionIds);
        Mode = NativeCommandTargetMode.Selected;
    }

    public IReadOnlyList<string> Resolve(string? currentSessionId, IEnumerable<string> availableSessionIds, bool currentOnly = false)
    {
        ArgumentNullException.ThrowIfNull(availableSessionIds);
        return availableSessionIds.Where(sessionId => currentOnly || Mode == NativeCommandTargetMode.Current
                ? sessionId == currentSessionId
                : Mode == NativeCommandTargetMode.All || selectedSessionIds.Contains(sessionId))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }
}
