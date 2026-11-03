using System.ComponentModel;
using System.Collections.ObjectModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class NativeLanSyncViewModel : INotifyPropertyChanged, IDisposable
{
    private readonly NativeLanSyncService service;
    private readonly SynchronizationContext? context = SynchronizationContext.Current;
    private NativeLanSyncState state;
    public NativeLanSyncState State => state;
    public string PairingCode => state.PairingCode ?? string.Empty;
    public string Status => state.Error is { Length: > 0 } ? $"{state.Phase}: {state.Error}" : state.Phase;
    public NativeLanSyncPreview? Incoming => state.Incoming;
    public ObservableCollection<NativeLanSyncDevice> Devices { get; } = [];
    public NativeLanSyncDevice? SelectedDevice { get; set; }
    public NativeLanSyncViewModel(NativeLanSyncService service) { this.service = service; state = service.State; service.StateChanged += OnStateChanged; }
    public Task StartReceiveAsync() => service.StartReceiveAsync();
    public void StopReceive() => service.StopReceive();
    public Task SendAsync(string host, int port, string code, bool includeSecrets) => service.SendAsync(host, port, code, includeSecrets);
    public async Task ScanAsync() { var devices = await service.ScanAsync(); Devices.Clear(); foreach (var device in devices) Devices.Add(device); OnPropertyChanged(nameof(Devices)); }
    public void SelectDevice(NativeLanSyncDevice? device) { SelectedDevice = device; OnPropertyChanged(nameof(SelectedDevice)); }
    public Task<NativeLanSyncImportResult> ApplyAsync(string token, ImportConflict conflict) => service.ApplyIncomingAsync(token, conflict);
    public void Reject(string token) => service.RejectIncoming(token);
    private void OnStateChanged(NativeLanSyncState next)
    {
        if (context != null && SynchronizationContext.Current != context) { context.Post(_ => OnStateChanged(next), null); return; }
        state = next; OnPropertyChanged(nameof(State)); OnPropertyChanged(nameof(PairingCode)); OnPropertyChanged(nameof(Status)); OnPropertyChanged(nameof(Incoming));
    }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public void Dispose() => service.StateChanged -= OnStateChanged;
}
