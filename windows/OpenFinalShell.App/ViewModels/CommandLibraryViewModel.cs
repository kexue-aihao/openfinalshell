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
    public ObservableCollection<NativeSnippetGroup> Groups { get; } = [];
    public ObservableCollection<NativeSnippet> Snippets { get; } = [];
    public ObservableCollection<string> History { get; } = [];
    public NativeSnippetGroup? SelectedGroup { get => selectedGroup; set { if (selectedGroup == value) return; selectedGroup = value; OnPropertyChanged(); ReloadSnippets(); } }
    public NativeSnippet? SelectedSnippet { get => selectedSnippet; set { if (selectedSnippet == value) return; selectedSnippet = value; OnPropertyChanged(); } }
    public CommandLibraryViewModel(NativeCommandLibrary library) { this.library = library; Reload(); }
    public void Reload()
    {
        Groups.Clear(); foreach (var group in library.ListGroups()) Groups.Add(group);
        SelectedGroup = Groups.FirstOrDefault(); ReloadHistory();
    }
    public void ReloadSnippets() { Snippets.Clear(); foreach (var snippet in library.ListSnippets(SelectedGroup?.Id)) Snippets.Add(snippet); SelectedSnippet = Snippets.FirstOrDefault(); }
    public void ReloadHistory(string? sessionId = null) { History.Clear(); foreach (var command in library.ListHistory(sessionId)) History.Add(command); }
    public NativeSnippetGroup SaveGroup(string? id, string name) { var result = library.SaveGroup(id, name, Groups.Count); Reload(); SelectedGroup = Groups.FirstOrDefault(item => item.Id == result.Id); return result; }
    public NativeSnippet SaveSnippet(string? id, string name, string command, bool autoEnter) { if (SelectedGroup == null) throw new InvalidOperationException("Select a command group first."); var result = library.SaveSnippet(id, SelectedGroup.Id, name, command, autoEnter, Snippets.Count); ReloadSnippets(); SelectedSnippet = Snippets.FirstOrDefault(item => item.Id == result.Id); return result; }
    public void DeleteSelectedSnippet() { if (SelectedSnippet == null) return; library.DeleteSnippet(SelectedSnippet.Id); ReloadSnippets(); }
    public void DeleteSelectedGroup() { if (SelectedGroup == null) return; library.DeleteGroup(SelectedGroup.Id); Reload(); }
    public void ClearHistory(string? sessionId = null) { library.ClearHistory(sessionId); ReloadHistory(sessionId); }
    public void AddHistory(string sessionId, string command) { library.AddHistory(sessionId, command); ReloadHistory(sessionId); }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
