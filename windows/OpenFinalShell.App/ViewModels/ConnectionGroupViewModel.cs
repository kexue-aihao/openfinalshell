using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class ConnectionGroupViewModel : INotifyPropertyChanged
{
    private readonly NativeStore store;
    private ConnectionGroup? selected;
    public ObservableCollection<ConnectionGroup> Groups { get; } = [];
    public ConnectionGroup? Selected { get => selected; set { if (ReferenceEquals(selected, value)) return; selected = value; OnPropertyChanged(); } }

    public ConnectionGroupViewModel(NativeStore store) { this.store = store; Reload(); }

    public void Reload()
    {
        var selectedId = Selected?.Id;
        Groups.Clear();
        foreach (var item in store.List("groups"))
            try { Groups.Add(ConnectionGroup.FromJson(item)); } catch { }
        var ordered = Groups.OrderBy(x => x.Order).ThenBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
        Groups.Clear(); foreach (var group in ordered) Groups.Add(group);
        Selected = selectedId == null ? null : Groups.FirstOrDefault(x => x.Id == selectedId);
    }

    public ConnectionGroup Save(string? id, string name, double order = 0, long? revision = null, string? parentId = null, bool changeParent = false)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 120) throw new ArgumentException("Connection group name is invalid.");
        var groupId = string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id.Trim();
        var existing = store.Find("groups", groupId);
        var expected = revision ?? existing?["_revision"]?.GetValue<long>();
        var payload = new JsonObject { ["id"] = groupId, ["name"] = name.Trim(), ["order"] = double.IsFinite(order) ? order : Groups.Count };
        if (changeParent || existing == null) payload["parentId"] = parentId;
        var next = store.SaveConnectionGroup(groupId, payload, expected);
        Reload();
        Selected = Groups.FirstOrDefault(x => x.Id == groupId);
        return Selected ?? new ConnectionGroup(groupId, name.Trim(), order, next);
    }

    public void DeleteSelected()
    {
        if (Selected is not { } group) return;
        store.DeleteConnectionGroup(group.Id, group.Revision);
        Selected = null;
        Reload();
    }

    public void MoveSelected(int direction)
    {
        if (direction is not (-1 or 1)) throw new ArgumentOutOfRangeException(nameof(direction));
        if (Selected is not { } group) return;
        var siblings = Groups.Where(item => item.ParentId == group.ParentId).ToList();
        var index = siblings.IndexOf(group);
        var neighborIndex = index + direction;
        if (index < 0 || neighborIndex < 0 || neighborIndex >= siblings.Count) return;
        var reordered = siblings;
        (reordered[index], reordered[neighborIndex]) = (reordered[neighborIndex], reordered[index]);
        store.ReorderConnectionGroups(reordered.Select((item, order) => (item.Id, (double)order, item.Revision)).ToArray());
        Reload();
        Selected = Groups.FirstOrDefault(item => item.Id == group.Id);
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
