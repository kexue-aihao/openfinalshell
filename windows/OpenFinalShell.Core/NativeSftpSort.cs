namespace OpenFinalShell.Core;

/// <summary>Applies the directory-first ordering and sortable columns used by the SFTP table.</summary>
public static class NativeSftpSort
{
    public static IReadOnlyList<RemoteEntry> Apply(IEnumerable<RemoteEntry> entries, string? order, bool descending)
    {
        ArgumentNullException.ThrowIfNull(entries);
        var field = order is "size" or "modified" or "mode" ? order : "name";
        IComparable Key(RemoteEntry entry) => field switch
        {
            "size" => entry.Size,
            "modified" => entry.Modified,
            "mode" => entry.Mode,
            _ => entry.Name
        };

        var sorted = descending ? entries.OrderByDescending(Key) : entries.OrderBy(Key);
        return sorted.OrderByDescending(entry => entry.IsDirectory).ToArray();
    }
}
