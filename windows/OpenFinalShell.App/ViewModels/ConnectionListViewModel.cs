using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class ConnectionListViewModel : INotifyPropertyChanged
{
    private ConnectionProfile? selected;
    private string sortMode = "name";
    private string grouping = "none";
    public ObservableCollection<ConnectionProfile> Profiles { get; } = [];
    public string SortMode { get => sortMode; set { if (sortMode == value) return; sortMode = value; OnPropertyChanged(); } }
    public string Grouping { get => grouping; set { if (grouping == value) return; grouping = value; OnPropertyChanged(); } }
    public ConnectionProfile? Selected
    {
        get => selected;
        set { if (ReferenceEquals(selected, value)) return; selected = value; OnPropertyChanged(); }
    }

    public void Configure(string sort, string group)
    {
        SortMode = sort is "host" or "recent" ? sort : "name";
        Grouping = group == "group" ? "group" : "none";
    }

    public void Reload(NativeStore store, IReadOnlyList<ConnectionGroup>? groups = null)
    {
        var selectedId = Selected?.Id;
        Profiles.Clear();
        var values = new List<ConnectionProfile>();
        foreach (var item in store.List("profiles"))
            try { values.Add(ConnectionProfile.FromJson(item)); }
            catch { /* One corrupt profile must not hide the remaining connections. */ }
        var byId = groups?.ToDictionary(x => x.Id, StringComparer.Ordinal) ?? new(StringComparer.Ordinal);
        foreach (var profile in values.OrderBy(profile => ProfileGroupOrder(profile, byId))
                     .ThenBy(profile => ProfileGroup(profile, byId), StringComparer.CurrentCultureIgnoreCase)
                     .ThenBy(ProfileSort)) Profiles.Add(profile);
        Selected = selectedId == null ? null : Profiles.FirstOrDefault(x => x.Id == selectedId);
    }

    private double ProfileGroupOrder(ConnectionProfile profile, IReadOnlyDictionary<string, ConnectionGroup> groups) => Grouping == "group"
        ? (profile.Data["groupId"]?.GetValue<string>() is { } id && groups.TryGetValue(id, out var group) ? group.Order : double.NegativeInfinity)
        : 0;

    private string ProfileGroup(ConnectionProfile profile, IReadOnlyDictionary<string, ConnectionGroup> groups) => Grouping == "group"
        ? (profile.Data["groupId"]?.GetValue<string>() is { } id && groups.TryGetValue(id, out var group) ? group.Name : profile.Data["group"]?.GetValue<string>() ?? string.Empty)
        : string.Empty;

    private object ProfileSort(ConnectionProfile profile) => SortMode switch
    {
        "host" => profile.Host,
        "recent" => -(profile.Data["lastUsedAt"]?.GetValue<long>() ?? profile.Data["lastConnectedAt"]?.GetValue<long>() ?? 0),
        _ => profile.Name
    };

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
