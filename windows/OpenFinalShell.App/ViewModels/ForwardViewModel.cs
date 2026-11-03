using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Microsoft.UI.Dispatching;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class NativeForwardRow : INotifyPropertyChanged
{
    public NativeForwardRule Rule { get; }
    private NativeForwardRuntime runtime;
    private readonly Func<string, string> text;
    public string Id => Rule.Id;
    public string Label => Rule.Label;
    public string ProfileId => Rule.ProfileId;
    public string Type => Rule.Type.ToString().ToLowerInvariant();
    public string Binding => Rule.Type == NativeForwardType.Dynamic
        ? $"{Rule.BindAddress}:{Rule.BindPort} (SOCKS5)"
        : $"{Rule.BindAddress}:{Rule.BindPort} → {Rule.DestinationHost}:{Rule.DestinationPort}";
    public bool AutoStart => Rule.AutoStart;
    public string State => runtime.State.ToString();
    public string Error => runtime.Error ?? string.Empty;
    public long ActiveConnections => runtime.ActiveConnections;
    public long TotalBytes => runtime.TotalBytes;
    public string TelemetrySummary => $"{text("native.forward.connections")}: {runtime.ActiveConnections} · {text("native.forward.totalBytes")}: {runtime.TotalBytes:N0} B";
    public NativeForwardRuntime Runtime => runtime;
    public NativeForwardRow(NativeForwardRule rule, NativeForwardRuntime runtime, Func<string, string> text) { Rule = rule; this.runtime = runtime; this.text = text; }
    public void Update(NativeForwardRuntime next) { runtime = next; OnPropertyChanged(nameof(State)); OnPropertyChanged(nameof(Error)); OnPropertyChanged(nameof(ActiveConnections)); OnPropertyChanged(nameof(TotalBytes)); OnPropertyChanged(nameof(TelemetrySummary)); OnPropertyChanged(nameof(Runtime)); }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public override string ToString() => $"{Label} · {Type} · {Binding} · {State}";
}

public sealed class ForwardViewModel : INotifyPropertyChanged, IDisposable
{
    private readonly NativeForwardManager manager;
    private readonly Func<string, string> text;
    private readonly DispatcherQueue? dispatcher = DispatcherQueue.GetForCurrentThread();
    private NativeForwardRow? selected;
    public ObservableCollection<NativeForwardRow> Rules { get; } = [];
    public NativeForwardRow? Selected { get => selected; set { if (ReferenceEquals(selected, value)) return; selected = value; OnPropertyChanged(); } }
    public ForwardViewModel(NativeForwardManager manager, Func<string, string> text)
    {
        this.manager = manager;
        this.text = text;
        manager.StateChanged += OnStateChanged;
        Reload();
    }
    public void Reload()
    {
        var old = Selected?.Id;
        Rules.Clear();
        foreach (var rule in manager.ListRules()) Rules.Add(new(rule, manager.RuntimeOf(rule.Id), text));
        Selected = old == null ? null : Rules.FirstOrDefault(x => x.Id == old);
    }
    public NativeForwardRule Save(NativeForwardRule rule) { var saved = manager.SaveRule(rule); Reload(); Selected = Rules.FirstOrDefault(x => x.Id == saved.Id); return saved; }
    public void DeleteSelected() { if (Selected is { } row) { manager.DeleteRule(row.Id, row.Rule.Revision); Reload(); } }
    public Task StartSelectedAsync() => Selected == null ? Task.CompletedTask : manager.StartAsync(Selected.Id);
    public void StopSelected() { if (Selected != null) manager.Stop(Selected.Id); }
    public void StartForSession(string profileId) { foreach (var rule in manager.ListRules().Where(x => x.ProfileId == profileId && x.AutoStart)) _ = manager.StartAsync(rule.Id); }
    private void OnStateChanged(NativeForwardRuntime state)
    {
        void Apply()
        {
            var row = Rules.FirstOrDefault(x => x.Id == state.ForwardId);
            row?.Update(state);
            OnPropertyChanged(nameof(Rules));
        }
        if (dispatcher is { HasThreadAccess: false }) dispatcher.TryEnqueue(Apply);
        else Apply();
    }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public void Dispose() => manager.StateChanged -= OnStateChanged;
}
