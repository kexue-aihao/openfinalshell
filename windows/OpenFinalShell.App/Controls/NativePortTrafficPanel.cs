using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using OpenFinalShell.Core;
using System.Globalization;

namespace OpenFinalShell.App.Controls;

public sealed class NativePortTrafficPanel : UserControl, IDisposable
{
    private readonly NativePortTrafficService service;
    private readonly ListView list = new();
    private readonly TextBlock state = new();
    private readonly Func<string, string> text;
    private bool disposed;

    public NativePortTrafficPanel(NativeSession session, int intervalMs, Func<string, string> text)
    {
        this.text = text; service = new NativePortTrafficService(session, intervalMs);
        AutomationProperties.SetName(list, "Port traffic");
        service.StateChanged += OnStateChanged; service.Snapshot += OnSnapshot;
        Content = new StackPanel { Spacing = 8, Children = { state, list } };
        Loaded += (_, _) => UiTaskRunner.Run(() => service.StartAsync(),
            error => state.Text = error.Message);
        Unloaded += (_, _) => UiTaskRunner.Run(() => service.StopAsync(),
            error => state.Text = error.Message);
    }
    private void OnStateChanged(NativePortTrafficState value, string? error) => DispatcherQueue.TryEnqueue(() => state.Text = error == null ? $"{text("native.portTraffic.state")}: {value}" : $"{text("native.portTraffic.state")}: {value} · {error}");
    private void OnSnapshot(PortTrafficSnapshot snapshot) => DispatcherQueue.TryEnqueue(() => list.ItemsSource = snapshot.Ports.Select(port => string.Format(CultureInfo.CurrentCulture, "{0} · {1} connections · ↓ {2:N0} B/s · ↑ {3:N0} B/s{4}", port.Port, port.Connections, port.RxBps, port.TxBps, port.RatesAvailable ? "" : " · rates unavailable")).ToArray());
    public void Dispose() { if (disposed) return; disposed = true; service.StateChanged -= OnStateChanged; service.Snapshot -= OnSnapshot; _ = service.DisposeAsync(); }
}
