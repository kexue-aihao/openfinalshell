using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed record KnownHostItem(string Key, string Host, int Port, string Algorithm, string Fingerprint, long Revision);

public sealed class KnownHostViewModel : INotifyPropertyChanged
{
    private readonly NativeStore store;
    public ObservableCollection<KnownHostItem> Items { get; } = [];
    public KnownHostItem? Selected { get; set; }
    public KnownHostViewModel(NativeStore store) { this.store = store; Reload(); }
    public void Reload()
    {
        Items.Clear();
        foreach (var item in store.List("knownHosts"))
        {
            var key = item["key"]?.GetValue<string>(); var fingerprint = item["fingerprintSha256"]?.GetValue<string>();
            if (key == null || fingerprint == null) continue;
            var parts = key.Split(':', 3);
            _ = int.TryParse(parts.Length > 1 ? parts[1] : "22", out var port);
            Items.Add(new(key, parts.Length > 0 ? parts[0] : key, port, item["keyType"]?.GetValue<string>() ?? "unknown", fingerprint, item["_revision"]?.GetValue<long>() ?? 0));
        }
    }
    public void RevokeSelected()
    {
        if (Selected == null) return;
        store.Delete("knownHosts", Selected.Key, Selected.Revision); Reload(); Selected = null;
    }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
