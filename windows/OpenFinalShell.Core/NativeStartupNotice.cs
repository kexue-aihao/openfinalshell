namespace OpenFinalShell.Core;

public enum NativeStartupNoticeKind
{
    Fresh,
    Update,
    None
}

public sealed record NativeStartupNotice(NativeStartupNoticeKind Kind, string? FromVersion, string ToVersion)
{
    private const string LastLaunchedVersionKey = "last_launched_version";

    public static NativeStartupNotice ClassifyLaunch(string? previousVersion, string currentVersion)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(currentVersion);
        if (string.IsNullOrWhiteSpace(previousVersion))
            return new(NativeStartupNoticeKind.Fresh, null, currentVersion);
        if (!string.Equals(previousVersion, currentVersion, StringComparison.Ordinal))
            return new(NativeStartupNoticeKind.Update, previousVersion, currentVersion);
        return new(NativeStartupNoticeKind.None, previousVersion, currentVersion);
    }

    /// <summary>Classify this launch and persist the current version atomically.</summary>
    public static NativeStartupNotice AdvanceLaunch(NativeStore store, string currentVersion)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentException.ThrowIfNullOrWhiteSpace(currentVersion);
        var previous = store.ReplaceMetaTextAndReadPrevious(LastLaunchedVersionKey, currentVersion);
        return ClassifyLaunch(previous, currentVersion);
    }
}
