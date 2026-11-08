using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class CommandLibraryViewModel : INotifyPropertyChanged
{
    private readonly NativeCommandLibrary library;
    private NativeSnippetGroup? selectedGroup;
    private NativeSnippet? selectedSnippet;
    private string query = "";
    public string Query { get => query; set { query = value; ReloadSnippets(); } }
    public ObservableCollection<NativeSnippetGroup> Groups { get; } = [];
    public ObservableCollection<NativeSnippet> Snippets { get; } = [];
    public ObservableCollection<string> History { get; } = [];
    public NativeSnippetGroup? SelectedGroup { get => selectedGroup; set { if (selectedGroup == value) return; selectedGroup = value; OnPropertyChanged(); ReloadSnippets(); } }
    public NativeSnippet? SelectedSnippet { get => selectedSnippet; set { if (selectedSnippet == value) return; selectedSnippet = value; OnPropertyChanged(); } }
    public CommandLibraryViewModel(NativeCommandLibrary library) { this.library = library; Reload(); }
    public void Reload()
    {
        var id = SelectedGroup?.Id;
        Groups.Clear(); foreach (var group in library.ListGroups()) Groups.Add(group);
        SelectedGroup = Groups.FirstOrDefault(i => i.Id == id) ?? Groups.FirstOrDefault(); ReloadSnippets(); ReloadHistory();
    }
    public void ReloadSnippets() { var id = SelectedSnippet?.Id; Snippets.Clear(); foreach (var snippet in library.ListSnippets(SelectedGroup?.Id).Where(i => $"{i.Name} {i.Command}".Contains(query, StringComparison.CurrentCultureIgnoreCase))) Snippets.Add(snippet); SelectedSnippet = Snippets.FirstOrDefault(i => i.Id == id) ?? Snippets.FirstOrDefault(); }
    public void ReloadHistory(string? sessionId = null) { History.Clear(); foreach (var command in library.ListHistory(sessionId)) History.Add(command); }
    public NativeSnippetGroup SaveGroup(string? id, string name) { var result = library.SaveGroup(id, name, id == null ? Groups.Count : null); Reload(); SelectedGroup = Groups.FirstOrDefault(item => item.Id == result.Id); return result; }
    public NativeSnippet SaveSnippet(string? id, string name, string command, bool autoEnter) { if (SelectedGroup == null) throw new InvalidOperationException("Select a command group first."); var result = library.SaveSnippet(id, SelectedGroup.Id, name, command, autoEnter, id == null ? library.ListSnippets(SelectedGroup.Id).Count : null); ReloadSnippets(); SelectedSnippet = Snippets.FirstOrDefault(item => item.Id == result.Id); return result; }
    public void MoveGroup(int direction) { if (SelectedGroup == null) return; library.Move("snippetGroups", SelectedGroup.Id, direction); Reload(); }
    public void MoveSnippet(int direction) { if (SelectedSnippet == null) return; library.Move("snippets", SelectedSnippet.Id, direction); ReloadSnippets(); }
    public void DeleteSelectedSnippet() { if (SelectedSnippet == null) return; library.DeleteSnippet(SelectedSnippet.Id); ReloadSnippets(); }
    public IReadOnlyList<NativeSnippetDuplicateGroup> FindDuplicates() => library.FindDuplicates();
    public int RemoveDuplicates(IReadOnlyList<NativeSnippetDuplicateSelection> selections)
    {
        var removed = library.RemoveDuplicates(selections);
        Reload();
        return removed;
    }
    public void DeleteSelectedGroup() { if (SelectedGroup == null) return; library.DeleteGroup(SelectedGroup.Id); Reload(); }
    public void ClearHistory(string? sessionId = null) { library.ClearHistory(sessionId); ReloadHistory(sessionId); }
    public void AddHistory(string sessionId, string command) { library.AddHistory(sessionId, command); ReloadHistory(sessionId); }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
