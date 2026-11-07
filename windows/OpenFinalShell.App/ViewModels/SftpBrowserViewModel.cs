using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

/// <summary>
/// Owns the remote directory state for an SFTP tab. The view only supplies
/// dialogs and file pickers; all path and remote mutation logic stays here.
/// </summary>
public sealed class SftpBrowserViewModel : INotifyPropertyChanged
{
    private readonly NativeSession session;
    private string currentPath = "/";
    private string status = string.Empty;
    private bool busy;
    private IReadOnlyList<RemoteEntry> allEntries = [];
    private bool showHidden;
    private string sort = "name";
    private bool descending;
    private readonly SemaphoreSlim navigationGate = new(1, 1);
    private long navigationRequest;

    public ObservableCollection<RemoteEntry> Entries { get; } = [];
    public string CurrentPath { get => currentPath; private set { if (currentPath == value) return; currentPath = value; OnPropertyChanged(); } }
    public string Status { get => status; private set { if (status == value) return; status = value; OnPropertyChanged(); } }
    public bool IsBusy { get => busy; private set { if (busy == value) return; busy = value; OnPropertyChanged(); } }
    public RemoteEntry? Selected { get; set; }

    public SftpBrowserViewModel(NativeSession session) => this.session = session;

    public async Task NavigateAsync(string path, CancellationToken token = default)
    {
        var request = Interlocked.Increment(ref navigationRequest);
        await navigationGate.WaitAsync(token);
        try
        {
            if (request != Volatile.Read(ref navigationRequest)) return;
            IsBusy = true;
            var normalized = NormalizePath(path);
            var values = await session.ListAsync(normalized, token);
            token.ThrowIfCancellationRequested();
            if (request != Volatile.Read(ref navigationRequest)) return;
            allEntries = values;
            ApplyView();
            CurrentPath = normalized;
            Status = $"{normalized} · {values.Count}";
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { if (request == Volatile.Read(ref navigationRequest)) Status = error.Message; throw; }
        finally { IsBusy = false; navigationGate.Release(); }
    }

    public Task RefreshAsync(CancellationToken token = default) => NavigateAsync(CurrentPath, token);
    public void ConfigureView(bool hidden, string order, bool reverse)
    {
        showHidden = hidden; sort = order; descending = reverse; ApplyView();
    }
    private void ApplyView()
    {
        var visible = allEntries.Where(e => showHidden || !e.Name.StartsWith('.'));
        Entries.Clear();
        foreach (var entry in NativeSftpSort.Apply(visible, sort, descending)) Entries.Add(entry);
    }
    public Task GoUpAsync(CancellationToken token = default) => NavigateAsync(ParentPath(CurrentPath), token);

    public async Task CreateDirectoryAsync(string name, CancellationToken token = default)
    {
        var path = Combine(CurrentPath, ValidateName(name));
        await session.CreateDirectoryAsync(path, token);
        await NavigateAsync(CurrentPath, token);
    }

    public async Task CreateFileAsync(string name, CancellationToken token = default)
    {
        var path = Combine(CurrentPath, ValidateName(name));
        await session.CreateFileAsync(path, token);
        await NavigateAsync(CurrentPath, token);
    }

    public async Task DeleteAsync(RemoteEntry entry, CancellationToken token = default)
    {
        await session.DeleteAsync(entry.Path, entry.IsDirectory, token);
        await NavigateAsync(CurrentPath, token);
    }

    public async Task RenameAsync(RemoteEntry entry, string name, CancellationToken token = default)
    {
        var target = Combine(CurrentPath, ValidateName(name));
        if (string.Equals(entry.Path, target, StringComparison.Ordinal)) return;
        if (await session.TryGetAsync(target, token) != null) throw new IOException("A remote item with that name already exists.");
        await session.RenameAsync(entry.Path, target, token);
        await NavigateAsync(CurrentPath, token);
    }

    public Task<RemoteEntry?> FindAsync(string name, CancellationToken token = default) => session.TryGetAsync(Combine(CurrentPath, name), token);

    public async Task ChmodAsync(RemoteEntry entry, short mode, CancellationToken token = default)
    {
        await session.ChmodAsync(entry.Path, mode, token);
        await NavigateAsync(CurrentPath, token);
    }

    public static string NormalizePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "/";
        var parts = value.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var result = new List<string>();
        foreach (var part in parts)
        {
            if (part == ".") continue;
            if (part == "..") { if (result.Count > 0) result.RemoveAt(result.Count - 1); continue; }
            result.Add(part);
        }
        return "/" + string.Join('/', result);
    }

    public static string ParentPath(string value)
    {
        var normalized = NormalizePath(value).TrimEnd('/');
        var index = normalized.LastIndexOf('/');
        return index <= 0 ? "/" : normalized[..index];
    }

    public static string Combine(string parent, string name) => NormalizePath(parent).TrimEnd('/') + "/" + ValidateName(name);

    private static string ValidateName(string value)
    {
        var name = value.Trim();
        if (name.Length == 0 || name is "." or ".." || name.Contains('/') || name.Contains('\\'))
            throw new ArgumentException("Remote names must be a single path segment.", nameof(value));
        return name;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
