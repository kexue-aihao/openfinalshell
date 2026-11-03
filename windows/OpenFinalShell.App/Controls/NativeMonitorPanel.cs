using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using OpenFinalShell.Core;
using System.Globalization;
using System.Numerics;

namespace OpenFinalShell.App.Controls;

/// <summary>Live native server monitor. Metrics arrive only as validated Core snapshots.</summary>
public sealed class NativeMonitorPanel : UserControl, IDisposable
{
    private readonly NativeMonitorService service;
    private readonly CanvasControl chart = new() { Height = 260, ClearColor = Colors.Transparent };
    private readonly TextBlock state = new();
    private readonly TextBlock identity = new() { TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock metrics = new() { TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock details = new() { TextWrapping = TextWrapping.Wrap };
    private readonly object gate = new();
    private readonly Queue<double> cpuHistory = new();
    private readonly Func<string, string> text;
    private bool started;
    private bool disposed;

    public NativeMonitorPanel(NativeSession session, int intervalMs, Func<string, string> text)
    {
        this.text = text; service = new NativeMonitorService(session);
        AutomationProperties.SetLiveSetting(state, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        service.StateChanged += OnStateChanged;
        service.Snapshot += OnSnapshot;
        chart.Draw += DrawChart;
        Content = new StackPanel { Spacing = 12, Children = { state, identity, metrics, details, chart } };
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        Tag = intervalMs;
    }

    private async void OnLoaded(object sender, RoutedEventArgs args)
    {
        if (started || disposed) return;
        started = true;
        try
        {
            await service.StartAsync((int)Tag);
            if (service.StaticInfo is { } info)
                identity.Text = $"{info.Hostname} · {info.Distribution} · {info.Kernel} · {info.Architecture} · {string.Join(", ", info.Addresses)}";
        }
        catch (Exception error) { state.Text = $"{text("native.monitor.failed")}: {error.Message}"; }
    }

    private async void OnUnloaded(object sender, RoutedEventArgs args)
    {
        if (disposed) return;
        await service.StopAsync(); started = false;
    }

    private void OnStateChanged(NativeCollectorState value, string? error)
    {
        DispatcherQueue.TryEnqueue(() => state.Text = error == null ? $"{text("native.monitor.state")}: {value}" : $"{text("native.monitor.state")}: {value} · {error}");
    }

    private void OnSnapshot(MonitorSnapshot snapshot)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            var rx = snapshot.Network.Sum(item => item.RxBps); var tx = snapshot.Network.Sum(item => item.TxBps);
            var memoryPct = snapshot.Memory.TotalKb > 0 ? 100d * snapshot.Memory.UsedKb / snapshot.Memory.TotalKb : 0;
            metrics.Text = string.Format(CultureInfo.CurrentCulture,
                "{0}: {1:0.0}% ({13})    {2}: {3:0.0}% ({4:N0}/{5:N0} KB)    {6}: ↓ {7:N0} B/s  ↑ {8:N0} B/s    {9}: {10:0.00}, {11:0.00}, {12:0.00}",
                text("native.monitor.cpu"), snapshot.Cpu.UsagePct, text("native.monitor.memory"), memoryPct,
                snapshot.Memory.UsedKb, snapshot.Memory.TotalKb, text("native.monitor.network"), rx, tx,
                text("native.monitor.load"), snapshot.Cpu.LoadAvg.ElementAtOrDefault(0), snapshot.Cpu.LoadAvg.ElementAtOrDefault(1), snapshot.Cpu.LoadAvg.ElementAtOrDefault(2),
                string.Join(" · ", snapshot.Cpu.PerCore.Select((value, index) => $"CPU{index}: {value:0.0}%")));
            var diskFs = snapshot.DiskFs is { Count: > 0 } fileSystems
                ? string.Join(" · ", fileSystems.Select(item => $"{item.Mount} {item.UsePct:0.0}% ({item.UsedKb:N0}/{item.TotalKb:N0} KB)"))
                : "—";
            var diskIo = snapshot.DiskIo is { Count: > 0 } devices
                ? string.Join(" · ", devices.Select(item => $"{item.Device} ↓ {item.ReadBps:N0} B/s ↑ {item.WriteBps:N0} B/s"))
                : "—";
            var processTop = snapshot.TopProcesses is { Count: > 0 } processes
                ? string.Join(" · ", processes.Select(item => $"{item.Name} ({item.Pid}) CPU {item.CpuPct:0.0}% / MEM {item.MemoryPct:0.0}%"))
                : "—";
            var sockets = snapshot.Connections is { } connectionCounts
                ? $"{text("native.monitor.sockets")}: {connectionCounts.SocketsUsed} · TCP {connectionCounts.TcpInUse} (orphans {connectionCounts.TcpOrphan}, TIME_WAIT {connectionCounts.TcpTimeWait}) · UDP {connectionCounts.UdpInUse}"
                : $"{text("native.monitor.sockets")}: —";
            var tcpStates = snapshot.TcpStates is { Count: > 0 } states
                ? string.Join(" · ", states.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => $"{item.Key}: {item.Value}"))
                : "—";
            var directLatency = snapshot.DirectLatencyMs is { } directLatencyMs ? $"{directLatencyMs:0.0} ms" : "—";
            var connectionLatency = snapshot.ConnectionLatencyMs is { } connectionLatencyMs ? $"{connectionLatencyMs:0.0} ms" : "—";
            details.Text = string.Join(Environment.NewLine,
                $"{text("native.monitor.uptime")}: {TimeSpan.FromSeconds(snapshot.UptimeSeconds).ToString(@"d\.hh\:mm\:ss", CultureInfo.CurrentCulture)} · {text("native.monitor.directLatency")}: {directLatency} · {text("native.monitor.connectionLatency")}: {connectionLatency}",
                $"{text("native.monitor.disk")}: {diskFs}",
                $"{text("native.monitor.diskIo")}: {diskIo}",
                $"{text("native.monitor.processes")}: {processTop}",
                sockets,
                $"{text("native.monitor.tcpStates")}: {tcpStates}");
            lock (gate) { cpuHistory.Enqueue(snapshot.Cpu.UsagePct); while (cpuHistory.Count > 90) cpuHistory.Dequeue(); }
            chart.Invalidate();
        });
    }

    private void DrawChart(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var width = (float)sender.ActualWidth; var height = (float)sender.ActualHeight;
        if (width <= 0 || height <= 0) return;
        for (var percent = 0; percent <= 100; percent += 25)
        {
            var y = height - height * percent / 100f;
            args.DrawingSession.DrawLine(0, y, width, y, Windows.UI.Color.FromArgb(70, 128, 128, 128), 1);
        }
        double[] values; lock (gate) values = cpuHistory.ToArray();
        if (values.Length < 2) return;
        var spacing = width / (values.Length - 1);
        for (var index = 1; index < values.Length; index++)
        {
            var x1 = (index - 1) * spacing; var x2 = index * spacing;
            var y1 = height - (float)Math.Clamp(values[index - 1], 0, 100) * height / 100f;
            var y2 = height - (float)Math.Clamp(values[index], 0, 100) * height / 100f;
            args.DrawingSession.DrawLine(new Vector2(x1, y1), new Vector2(x2, y2), Colors.DodgerBlue, 2);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        service.StateChanged -= OnStateChanged; service.Snapshot -= OnSnapshot;
        _ = service.DisposeAsync();
    }
}
