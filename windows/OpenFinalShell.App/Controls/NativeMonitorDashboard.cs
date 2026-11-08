using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using System.Numerics;

namespace OpenFinalShell.App.Controls;

/// <summary>Theme-aware metric cards and compact detail sections for a session.</summary>
public sealed class NativeMonitorDashboard : StackPanel
{
    private readonly TextBlock cpu = MetricValue(), memory = MetricValue(), memoryCapacity = DetailValue(), network = MetricValue(), latency = MetricValue();
    private readonly ProgressBar cpuBar = new() { Maximum = 100, Height = 5 }, memoryBar = new() { Maximum = 100, Height = 5 };
    private readonly StackPanel cores = new() { Spacing = 5 }, disks = new() { Spacing = 5 }, diskIo = new() { Spacing = 5 }, processes = new() { Spacing = 5 }, sockets = new() { Spacing = 5 }, interfaces = new() { Spacing = 5 };
    private readonly NativeMetricTrend utilization = new(100), traffic = new();
    private readonly Func<string, string> text;
    private readonly TextBlock uptime = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12, Opacity = .75 };
    public NativeMonitorDashboard(Func<string, string> text)
    {
        this.text = text;
        Spacing = 10;
        Children.Add(Card("native.monitor.cpu", cpu, cpuBar));
        Children.Add(Card("native.monitor.memory", memory, memoryCapacity, memoryBar));
        Children.Add(utilization);
        Children.Add(Card("native.monitor.network", network));
        Children.Add(traffic);
        Children.Add(Card("native.monitor.connectionLatency", latency, uptime));
        Section("native.monitor.cpu", cores);
        Section("native.monitor.network", interfaces);
        Section("native.monitor.disk", disks);
        Section("native.monitor.diskIo", diskIo);
        Section("native.monitor.processes", processes);
        Section("native.monitor.sockets", sockets);
        Clear();
    }
    private static TextBlock MetricValue() => new() { FontSize = 22, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Segoe UI Variable Display") };
    private static TextBlock DetailValue() => new() { FontSize = 12, Opacity = .75, TextWrapping = TextWrapping.Wrap };
    private Border Card(string key, params UIElement[] items)
    {
        var body = new StackPanel { Spacing = 6 };
        body.Children.Add(new TextBlock { Text = text(key), FontSize = 12, Opacity = .75, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        foreach (var item in items) body.Children.Add(item);
        return new Border
        {
            Padding = new(10, 9, 10, 9), CornerRadius = new(6), BorderThickness = new(1),
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush,
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush, Child = body
        };
    }
    private void Section(string key, StackPanel content) => Children.Add(new Expander
    {
        Header = text(key), IsExpanded = false, Content = content,
        HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch
    });
    private static void Rows(StackPanel target, IEnumerable<string> rows)
    {
        target.Children.Clear();
        foreach (var row in rows.Take(256)) target.Children.Add(new TextBlock { Text = row, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, FontSize = 12 });
        if (target.Children.Count == 0) target.Children.Add(new TextBlock { Text = "—", Opacity = .6 });
    }
    public void Clear()
    {
        cpu.Text = memory.Text = network.Text = latency.Text = "—"; memoryCapacity.Text = uptime.Text = "";
        cpuBar.Value = memoryBar.Value = 0; utilization.Clear(); traffic.Clear();
        foreach (var panel in new[] { cores, disks, diskIo, processes, sockets, interfaces }) Rows(panel, []);
    }
    public void Update(MonitorSnapshot snapshot)
    {
        var used = snapshot.Memory.TotalKb > 0 ? 100d * snapshot.Memory.UsedKb / snapshot.Memory.TotalKb : 0;
        var rx = snapshot.Network.Sum(i => i.RxBps); var tx = snapshot.Network.Sum(i => i.TxBps);
        cpu.Text = $"{snapshot.Cpu.UsagePct:0.0}%"; cpuBar.Value = Math.Clamp(snapshot.Cpu.UsagePct, 0, 100);
        memory.Text = $"{used:0.0}%"; memoryBar.Value = Math.Clamp(used, 0, 100);
        var totalMiB = snapshot.Memory.TotalKb / 1024d;
        var usedMiB = snapshot.Memory.UsedKb / 1024d;
        memoryCapacity.Text = $"{usedMiB:N0} / {totalMiB:N0} MiB";
        network.Text = $"↓ {Rate(rx)}\n↑ {Rate(tx)}";
        latency.Text = snapshot.ConnectionLatencyMs is { } ms ? $"{ms:0.0} ms" : "—";
        uptime.Text = $"{text("native.monitor.uptime")}: {TimeSpan.FromSeconds(snapshot.UptimeSeconds):d\\.hh\\:mm\\:ss}\n{text("native.monitor.directLatency")}: {(snapshot.DirectLatencyMs is { } direct ? $"{direct:0.0} ms" : "—")}\n{text("native.monitor.load")}: {string.Join(" · ", snapshot.Cpu.LoadAvg.Select(i => i.ToString("0.00")))}";
        utilization.Append(snapshot.Cpu.UsagePct, used, $"{text("native.monitor.cpu")} / {text("native.monitor.memory")} %", text("native.monitor.cpu"), text("native.monitor.memory"));
        traffic.Append(rx, tx, $"{text("native.sftp.download")} / {text("native.sftp.upload")} · {Rate(Math.Max(rx, tx))}", text("native.sftp.download"), text("native.sftp.upload"));
        Rows(cores, snapshot.Cpu.PerCore.Select((v, i) => $"CPU {i}    {v:0.0}%"));
        Rows(interfaces, snapshot.Network.Select(i => $"{i.Interface}    ↓ {Rate(i.RxBps)}    ↑ {Rate(i.TxBps)}"));
        UpdateDisks(snapshot.DiskFs ?? []);
        Rows(diskIo, (snapshot.DiskIo ?? []).Select(i => $"{i.Device}    ↓ {Rate(i.ReadBps)}    ↑ {Rate(i.WriteBps)}"));
        Rows(processes, (snapshot.TopProcesses ?? []).OrderByDescending(i => i.CpuPct).Select(i => $"{i.Name}  ·  PID {i.Pid}\nCPU {i.CpuPct:0.0}%    MEM {i.MemoryPct:0.0}%"));
        var connectionRows = new List<string>();
        if (snapshot.Connections is { } c) connectionRows.Add($"{text("native.monitor.sockets")}: {c.SocketsUsed}\nTCP {c.TcpInUse} · UDP {c.UdpInUse}\nTCP orphan {c.TcpOrphan} · TIME_WAIT {c.TcpTimeWait}");
        connectionRows.AddRange((snapshot.TcpStates ?? new Dictionary<string, int>()).OrderBy(i => i.Key).Select(i => $"{i.Key}    {i.Value}"));
        Rows(sockets, connectionRows);
    }
    private void UpdateDisks(IEnumerable<MonitorDiskFs> values)
    {
        disks.Children.Clear();
        foreach (var disk in values.Take(128))
        {
            var row = new StackPanel { Spacing = 3, Margin = new Thickness(0, 0, 0, 6) };
            var heading = new Grid { ColumnSpacing = 8 };
            heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            heading.Children.Add(new TextBlock { Text = disk.Mount, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 12 });
            var percent = new TextBlock { Text = $"{disk.UsePct:0.0}%", FontSize = 12, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold };
            heading.Children.Add(percent); Grid.SetColumn(percent, 1);
            row.Children.Add(heading);
            var bar = new ProgressBar { Minimum = 0, Maximum = 100, Value = Math.Clamp(disk.UsePct, 0, 100), Height = 4, Foreground = Application.Current.Resources["AccentFillColorDefaultBrush"] as Brush };
            row.Children.Add(bar);
            row.Children.Add(new TextBlock { Text = $"{disk.UsedKb / 1024d:N0} / {disk.TotalKb / 1024d:N0} MiB · {disk.Filesystem}", FontSize = 11, Opacity = .7, TextTrimming = TextTrimming.CharacterEllipsis });
            disks.Children.Add(row);
        }
        if (disks.Children.Count == 0) disks.Children.Add(new TextBlock { Text = "—", Opacity = .6 });
    }
    private static string Rate(long value) => value >= 1048576 ? $"{value / 1048576d:0.0} MiB/s" : value >= 1024 ? $"{value / 1024d:0.0} KiB/s" : $"{value} B/s";
}

internal sealed class NativeMetricTrend : StackPanel
{
    private readonly CanvasControl canvas = new() { Height = 84, ClearColor = Colors.Transparent };
    private readonly TextBlock caption = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11, Opacity = .75 };
    private readonly StackPanel legend = new() { Orientation = Orientation.Horizontal, Spacing = 12 };
    private readonly TextBlock firstLabel = new() { FontSize = 10 }, secondLabel = new() { FontSize = 10 };
    private readonly Queue<(double A, double B)> values = new();
    private readonly double? fixedMaximum;
    public NativeMetricTrend(double? maximum = null)
    {
        fixedMaximum = maximum; Spacing = 4;
        legend.Children.Add(LegendItem(firstLabel, true));
        legend.Children.Add(LegendItem(secondLabel, false));
        Children.Add(caption); Children.Add(legend); Children.Add(canvas);
        canvas.Draw += Draw;
    }
    private static UIElement LegendItem(TextBlock label, bool primary)
    {
        var item = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5, VerticalAlignment = VerticalAlignment.Center };
        item.Children.Add(new Border { Width = 9, Height = 3, CornerRadius = new CornerRadius(2), Background = primary
            ? Application.Current.Resources["AccentFillColorDefaultBrush"] as Brush
            : new SolidColorBrush(Windows.UI.Color.FromArgb(255, 239, 145, 57)) });
        item.Children.Add(label);
        return item;
    }
    public void Clear() { values.Clear(); caption.Text = firstLabel.Text = secondLabel.Text = ""; canvas.Invalidate(); }
    public void Append(double a, double b, string label, string first, string second)
    {
        values.Enqueue((double.IsFinite(a) ? Math.Max(0, a) : 0, double.IsFinite(b) ? Math.Max(0, b) : 0));
        while (values.Count > 90) values.Dequeue();
        caption.Text = label; firstLabel.Text = first; secondLabel.Text = second; canvas.Invalidate();
    }
    private void Draw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var width = (float)sender.ActualWidth; var height = (float)sender.ActualHeight; if (width < 1 || height < 1) return;
        var grid = (Application.Current.Resources["CardStrokeColorDefaultBrush"] as SolidColorBrush)?.Color ?? Windows.UI.Color.FromArgb(70, 128, 128, 128);
        for (var i = 0; i <= 4; i++) args.DrawingSession.DrawLine(0, i * height / 4, width, i * height / 4, grid, 1);
        var samples = values.ToArray(); if (samples.Length < 2) return;
        var maximum = fixedMaximum ?? Math.Max(1, samples.Max(i => Math.Max(i.A, i.B)));
        var primary = (Application.Current.Resources["AccentFillColorDefaultBrush"] as SolidColorBrush)?.Color ?? Colors.DodgerBlue;
        var secondary = Windows.UI.Color.FromArgb(255, 239, 145, 57);
        for (var i = 1; i < samples.Length; i++)
        {
            Vector2 Point(int index, double value) => new(index * width / (samples.Length - 1), height * (1 - (float)Math.Clamp(value / maximum, 0, 1)));
            args.DrawingSession.DrawLine(Point(i - 1, samples[i - 1].A), Point(i, samples[i].A), primary, 2);
            args.DrawingSession.DrawLine(Point(i - 1, samples[i - 1].B), Point(i, samples[i].B), secondary, 2);
        }
    }
}
