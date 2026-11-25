using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using OpenFinalShell.Core;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Globalization;

namespace OpenFinalShell.App.Controls;

public sealed class NativePortTrafficPanel : UserControl, IDisposable
{
    private sealed class TrafficRow(int port) : INotifyPropertyChanged
    {
        private string text = "";
        public int Port { get; } = port;
        public string Text
        {
            get => text;
            set { if (text == value) return; text = value; PropertyChanged?.Invoke(this, new(nameof(Text))); }
        }
        public event PropertyChangedEventHandler? PropertyChanged;
    }

    private readonly NativePortTrafficService service;
    private readonly ListView list = new();
    private readonly TextBlock state = new();
    private readonly TextBlock summary = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Localization localization;
    private readonly ObservableCollection<TrafficRow> rows = [];
    private readonly Dictionary<int, TrafficRow> rowsByPort = [];
    private readonly HashSet<int> seenPorts = [];
    private bool disposed;

    public NativePortTrafficPanel(NativeSession session, int intervalMs, Localization localization)
    {
        this.localization = localization; service = new NativePortTrafficService(session, intervalMs);
        AutomationProperties.SetName(list, localization["native.portTraffic.title"]);
        list.SelectionMode = ListViewSelectionMode.None;
        list.DisplayMemberPath = nameof(TrafficRow.Text);
        list.ItemsSource = rows;
        service.StateChanged += OnStateChanged; service.Snapshot += OnSnapshot;
        Content = new StackPanel { Spacing = 8, Children = { state, summary, list } };
        Loaded += (_, _) => UiTaskRunner.Run(() => service.StartAsync(),
            error => state.Text = error.Message);
        Unloaded += (_, _) => UiTaskRunner.Run(() => service.StopAsync(),
            error => state.Text = error.Message);
    }

    private string StateLabel(NativePortTrafficState value) => value switch
    {
        NativePortTrafficState.Starting => localization["native.portTraffic.stateStarting"],
        NativePortTrafficState.Running => localization["native.portTraffic.stateRunning"],
        NativePortTrafficState.Failed => localization["native.portTraffic.stateFailed"],
        NativePortTrafficState.Unsupported => localization["native.portTraffic.stateUnsupported"],
        NativePortTrafficState.Stopped => localization["native.portTraffic.stateStopped"],
        _ => value.ToString()
    };

    private void OnStateChanged(NativePortTrafficState value, string? error) => DispatcherQueue.TryEnqueue(() =>
    {
        if (disposed) return;
        var label = StateLabel(value);
        state.Text = error == null
            ? $"{localization["native.portTraffic.state"]}: {label}"
            : $"{localization["native.portTraffic.state"]}: {label} · {error}";
    });

    private string RowText(PortTrafficEntry port) => localization.Format(
        port.RatesAvailable ? "native.portTraffic.row" : "native.portTraffic.rowNoRates",
        ("port", port.Port.ToString(CultureInfo.CurrentCulture)),
        ("connections", port.Connections.ToString(CultureInfo.CurrentCulture)),
        ("rx", port.RxBps.ToString("N0", CultureInfo.CurrentCulture)),
        ("tx", port.TxBps.ToString("N0", CultureInfo.CurrentCulture)));

    private void UpdateSummary(PortTrafficSnapshot snapshot)
    {
        if (snapshot.Ports.Count == 0)
        {
            summary.Text = localization["native.portTraffic.empty"];
            return;
        }
        long connections = 0, rx = 0, tx = 0;
        var ratesAvailable = true;
        foreach (var port in snapshot.Ports)
        {
            connections += port.Connections; rx += port.RxBps; tx += port.TxBps;
            ratesAvailable &= port.RatesAvailable;
        }
        summary.Text = localization.Format(
            ratesAvailable ? "native.portTraffic.summary" : "native.portTraffic.summaryNoRates",
            ("ports", snapshot.Ports.Count.ToString(CultureInfo.CurrentCulture)),
            ("connections", connections.ToString(CultureInfo.CurrentCulture)),
            ("rx", rx.ToString("N0", CultureInfo.CurrentCulture)),
            ("tx", tx.ToString("N0", CultureInfo.CurrentCulture)));
    }

    private void OnSnapshot(PortTrafficSnapshot snapshot) => DispatcherQueue.TryEnqueue(() =>
    {
        if (disposed) return;
        UpdateSummary(snapshot);
        seenPorts.Clear();
        for (var index = 0; index < snapshot.Ports.Count; index++)
        {
            var port = snapshot.Ports[index];
            var label = RowText(port);
            if (rowsByPort.TryGetValue(port.Port, out var row))
            {
                row.Text = label;
                var current = rows.IndexOf(row);
                if (current != index) rows.Move(current, Math.Min(index, rows.Count - 1));
            }
            else
            {
                row = new TrafficRow(port.Port) { Text = label };
                rowsByPort[port.Port] = row;
                rows.Insert(Math.Min(index, rows.Count), row);
            }
            seenPorts.Add(port.Port);
        }
        // Keep containers for ports that are still open; only remove closed ones.
        for (var index = rows.Count - 1; index >= 0; index--)
        {
            if (seenPorts.Contains(rows[index].Port)) continue;
            rowsByPort.Remove(rows[index].Port);
            rows.RemoveAt(index);
        }
    });
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        service.StateChanged -= OnStateChanged;
        service.Snapshot -= OnSnapshot;
        rowsByPort.Clear();
        rows.Clear();
        _ = service.DisposeAsync();
    }
}
