using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed record SavedKeyItem(string Id, string Name, string Path, bool HasPassphrase, long Revision);

public sealed class SavedKeyViewModel : INotifyPropertyChanged
{
    private readonly NativeStore store;
    public ObservableCollection<SavedKeyItem> Items { get; } = [];
    public SavedKeyItem? Selected { get; set; }
    public SavedKeyViewModel(NativeStore store) { this.store = store; Reload(); }
    public void Reload()
    {
        Items.Clear();
        foreach (var item in store.List("privateKeys"))
        {
            var id = item["id"]?.GetValue<string>(); var path = item["path"]?.GetValue<string>();
            if (id == null || path == null) continue;
            Items.Add(new(id, item["name"]?.GetValue<string>() ?? Path.GetFileName(path), path, item["passphraseRef"] != null, item["_revision"]?.GetValue<long>() ?? 0));
        }
    }
    public void Save(string id, string name, string path, string? passphraseRef = null, long? revision = null)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Key name and path are required.");
        store.Save("privateKeys", id, new JsonObject { ["id"] = id, ["name"] = name.Trim(), ["path"] = Path.GetFullPath(path), ["passphraseRef"] = passphraseRef }, revision);
        Reload();
    }
    public void DeleteSelected()
    {
        if (Selected == null) return;
        var references = store.FindReferences(Selected.Id).Where(x => x.Kind == "profiles").ToArray();
        if (references.Length > 0)
            throw new NativeReferenceInUseException(references);
        store.Delete("privateKeys", Selected.Id, Selected.Revision); Reload(); Selected = null;
    }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
