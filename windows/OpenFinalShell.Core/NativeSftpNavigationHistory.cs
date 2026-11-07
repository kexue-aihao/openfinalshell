namespace OpenFinalShell.Core;

/// <summary>Canonical remote-directory history for the native SFTP pane.</summary>
public sealed class NativeSftpNavigationHistory
{
    private readonly List<string> entries = [];
    private int index = -1;

    public IReadOnlyList<string> Entries => entries;
    public int Index => index;
    public bool CanGoBack => index > 0;
    public bool CanGoForward => index >= 0 && index < entries.Count - 1;
    public string? Current => index >= 0 ? entries[index] : null;
    public string? BackTarget => CanGoBack ? entries[index - 1] : null;
    public string? ForwardTarget => CanGoForward ? entries[index + 1] : null;

    public bool Push(string path)
    {
        RequirePath(path);
        if (string.Equals(Current, path, StringComparison.Ordinal)) return false;
        if (index < entries.Count - 1) entries.RemoveRange(index + 1, entries.Count - index - 1);
        entries.Add(path);
        index = entries.Count - 1;
        return true;
    }

    public bool CommitBack(string path)
    {
        if (!CanGoBack || !string.Equals(BackTarget, path, StringComparison.Ordinal)) return false;
        index--;
        return true;
    }

    public bool CommitForward(string path)
    {
        if (!CanGoForward || !string.Equals(ForwardTarget, path, StringComparison.Ordinal)) return false;
        index++;
        return true;
    }

    private static void RequirePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path[0] != '/' || path.Any(char.IsControl))
            throw new ArgumentException("SFTP history paths must be absolute and printable.", nameof(path));
    }
}
