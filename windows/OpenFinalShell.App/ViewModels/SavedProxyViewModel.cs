using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed record SavedProxyItem(string Id, string Name, string Type, string Host, int Port, bool HasPassword, long Revision);

public sealed class SavedProxyViewModel : INotifyPropertyChanged
{
    private readonly NativeStore store;
    public ObservableCollection<SavedProxyItem> Items { get; } = [];
    public SavedProxyItem? Selected { get; set; }
    public SavedProxyViewModel(NativeStore store) { this.store = store; Reload(); }
    public void Reload()
    {
        Items.Clear();
        foreach (var item in store.List("proxies"))
        {
            var id = item["id"]?.GetValue<string>(); var host = item["host"]?.GetValue<string>();
            var port = item["port"]?.GetValue<int>() ?? 0;
            if (id == null || host == null || port is < 1 or > 65535) continue;
            Items.Add(new(id, item["name"]?.GetValue<string>() ?? host, item["type"]?.GetValue<string>() ?? "none", host, port, item["passwordRef"] != null, item["_revision"]?.GetValue<long>() ?? 0));
        }
    }
    public void Save(string id, string name, string type, string host, int port, string? username, string? passwordRef, long? revision = null)
    {
        if (type is not ("none" or "http" or "socks5") || string.IsNullOrWhiteSpace(host) || port is < 1 or > 65535) throw new ArgumentException("Invalid proxy configuration.");
        store.Save("proxies", id, new JsonObject { ["id"] = id, ["name"] = name.Trim(), ["type"] = type, ["host"] = host.Trim(), ["port"] = port, ["username"] = username, ["passwordRef"] = passwordRef }, revision);
        Reload();
    }
    public void DeleteSelected()
    {
        if (Selected == null) return;
        var references = store.FindReferences(Selected.Id).Where(x => x.Kind == "profiles").ToArray();
        if (references.Length > 0)
            throw new NativeReferenceInUseException(references);
        store.Delete("proxies", Selected.Id, Selected.Revision); Reload(); Selected = null;
    }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
