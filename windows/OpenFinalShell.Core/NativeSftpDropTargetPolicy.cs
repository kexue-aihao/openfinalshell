namespace OpenFinalShell.Core;

/// <summary>Resolves the SFTP upload drop zone using the same fallback rules as the Electron pane.</summary>
public sealed record NativeSftpDropTarget(bool Accepted, string Directory, bool IsDirectoryRow)
{
    public static NativeSftpDropTarget Resolve(
        bool hasStorageItems,
        bool sessionReady,
        bool navigationPending,
        string currentDirectory,
        RemoteEntry? hoveredEntry)
    {
        if (!hasStorageItems || !sessionReady || navigationPending || !IsSafeAbsolutePath(currentDirectory))
            return new(false, currentDirectory, false);

        // A single directory row is a specific drop target. Files, multi-selection,
        // blank space, and unaddressable rows fall back to the current directory.
        if (hoveredEntry is { IsDirectory: true } && IsSafeAbsolutePath(hoveredEntry.Path))
            return new(true, hoveredEntry.Path, true);

        return new(true, currentDirectory, false);
    }

    private static bool IsSafeAbsolutePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path[0] != '/' || path.Any(char.IsControl)) return false;
        return path.Split('/', StringSplitOptions.RemoveEmptyEntries).All(segment => segment is not ("." or ".."));
    }
}
