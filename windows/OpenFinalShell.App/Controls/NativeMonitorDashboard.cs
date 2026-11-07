using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using System.Numerics;

namespace OpenFinalShell.App.Controls;

/// <summary>Bounded native metric cards, histories and detail rows for one session.</summary>
public sealed class NativeMonitorDashboard : StackPanel
{
    private readonly TextBlock cpu = new(), memory = new(), network = new(), latency = new();
    private readonly ProgressBar cpuBar = new() { Maximum = 100 }, memoryBar = new() { Maximum = 100 };
    private readonly StackPanel cores = new() { Spacing = 6 }, disks = new() { Spacing = 6 }, diskIo = new() { Spacing = 6 }, processes = new() { Spacing = 6 }, sockets = new() { Spacing = 6 }, interfaces = new() { Spacing = 6 };
    private readonly NativeMetricTrend utilization = new(100), traffic = new();
    private readonly Func<string, string> text;
    private readonly TextBlock uptime = new() { TextWrapping = TextWrapping.Wrap };
    public NativeMonitorDashboard(Func<string, string> text)
    {
        this.text = text; Spacing = 12;
        Border Card(string key, params UIElement[] items)
        {
            var body = new StackPanel { Spacing = 8 };
            body.Children.Add(new TextBlock { Text = text(key), FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
            foreach (var item in items) body.Children.Add(item);
            return new Border { Padding = new(12), CornerRadius = new(6), BorderThickness = new(1), BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(70, 128, 128, 128)), Child = body };
        }
        foreach (var value in new[] { cpu, memory, network, latency }) { value.FontSize = 20; value.TextWrapping = TextWrapping.Wrap; }
        Children.Add(Card("native.monitor.cpu", cpu, cpuBar));
        Children.Add(Card("native.monitor.memory", memory, memoryBar));
        Children.Add(utilization);
        Children.Add(Card("native.monitor.network", network));
        Children.Add(traffic);
        Children.Add(Card("native.monitor.connectionLatency", latency, uptime));
        void Section(string key, StackPanel content) => Children.Add(new Expander { Header = text(key), IsExpanded = true, Content = content, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch });
        Section("native.monitor.cpu", cores); Section("native.monitor.network", interfaces);
        Section("native.monitor.disk", disks); Section("native.monitor.diskIo", diskIo);
        Section("native.monitor.processes", processes); Section("native.monitor.sockets", sockets);
        Clear();
    }
    private static void Rows(StackPanel target, IEnumerable<string> rows)
    {
        target.Children.Clear();
        foreach (var row in rows.Take(256)) target.Children.Add(new TextBlock { Text = row, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        if (target.Children.Count == 0) target.Children.Add(new TextBlock { Text = "—" });
    }
    public void Clear()
    {
        cpu.Text = memory.Text = network.Text = latency.Text = "—"; uptime.Text = "";
        cpuBar.Value = memoryBar.Value = 0; utilization.Clear(); traffic.Clear();
        foreach (var panel in new[] { cores, disks, diskIo, processes, sockets, interfaces }) Rows(panel, []);
    }
    public void Update(MonitorSnapshot snapshot)
    {
        var used = snapshot.Memory.TotalKb > 0 ? 100d * snapshot.Memory.UsedKb / snapshot.Memory.TotalKb : 0;
        var rx = snapshot.Network.Sum(i => i.RxBps); var tx = snapshot.Network.Sum(i => i.TxBps);
        cpu.Text = $"{snapshot.Cpu.UsagePct:0.0}%"; cpuBar.Value = Math.Clamp(snapshot.Cpu.UsagePct, 0, 100);
        memory.Text = $"{used:0.0}% · {snapshot.Memory.UsedKb / 1024d:N0}/{snapshot.Memory.TotalKb / 1024d:N0} MiB"; memoryBar.Value = Math.Clamp(used, 0, 100);
        network.Text = $"↓ {Rate(rx)}\n↑ {Rate(tx)}";
        latency.Text = snapshot.ConnectionLatencyMs is { } ms ? $"{ms:0.0} ms" : "—";
        uptime.Text = $"{text("native.monitor.uptime")}: {TimeSpan.FromSeconds(snapshot.UptimeSeconds):d\\.hh\\:mm\\:ss}\n{text("native.monitor.directLatency")}: {(snapshot.DirectLatencyMs is { } direct ? $"{direct:0.0} ms" : "—")}\n{text("native.monitor.load")}: {string.Join(" · ", snapshot.Cpu.LoadAvg.Select(i => i.ToString("0.00")))}";
        utilization.Append(snapshot.Cpu.UsagePct, used, $"{text("native.monitor.cpu")} / {text("native.monitor.memory")} %");
        traffic.Append(rx, tx, $"↓ / ↑ B/s · {Rate(Math.Max(rx, tx))}");
        Rows(cores, snapshot.Cpu.PerCore.Select((v, i) => $"CPU {i}    {v:0.0}%"));
        Rows(interfaces, snapshot.Network.Select(i => $"{i.Interface}    ↓ {Rate(i.RxBps)}    ↑ {Rate(i.TxBps)}"));
        Rows(disks, (snapshot.DiskFs ?? []).Select(i => $"{i.Mount} ({i.Filesystem})    {i.UsePct:0.0}%\n{i.UsedKb / 1024d:N0}/{i.TotalKb / 1024d:N0} MiB"));
        Rows(diskIo, (snapshot.DiskIo ?? []).Select(i => $"{i.Device}    ↓ {Rate(i.ReadBps)}    ↑ {Rate(i.WriteBps)}"));
        Rows(processes, (snapshot.TopProcesses ?? []).OrderByDescending(i => i.CpuPct).Select(i => $"{i.Pid}  {i.Name}\nCPU {i.CpuPct:0.0}%    MEM {i.MemoryPct:0.0}%"));
        var connectionRows = new List<string>();
        if (snapshot.Connections is { } c) connectionRows.Add($"{text("native.monitor.sockets")}: {c.SocketsUsed}\nTCP {c.TcpInUse} · UDP {c.UdpInUse}\nTCP orphan {c.TcpOrphan} · TIME_WAIT {c.TcpTimeWait}");
        connectionRows.AddRange((snapshot.TcpStates ?? new Dictionary<string, int>()).OrderBy(i => i.Key).Select(i => $"{i.Key}    {i.Value}"));
        Rows(sockets, connectionRows);
    }
    private static string Rate(long value) => value >= 1048576 ? $"{value / 1048576d:0.0} MiB/s" : value >= 1024 ? $"{value / 1024d:0.0} KiB/s" : $"{value} B/s";
}

internal sealed class NativeMetricTrend : StackPanel
{
    private readonly CanvasControl canvas = new() { Height = 110, ClearColor = Colors.Transparent };
    private readonly TextBlock caption = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Queue<(double A, double B)> values = new();
    private readonly double? fixedMaximum;
    public NativeMetricTrend(double? maximum = null)
    {
        fixedMaximum = maximum; Spacing = 4; Children.Add(caption); Children.Add(canvas); canvas.Draw += Draw;
    }
    public void Clear() { values.Clear(); caption.Text = ""; canvas.Invalidate(); }
    public void Append(double a, double b, string label)
    {
        values.Enqueue((double.IsFinite(a) ? Math.Max(0, a) : 0, double.IsFinite(b) ? Math.Max(0, b) : 0));
        while (values.Count > 90) values.Dequeue(); caption.Text = label; canvas.Invalidate();
    }
    private void Draw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var width = (float)sender.ActualWidth; var height = (float)sender.ActualHeight; if (width < 1 || height < 1) return;
        for (var i = 0; i <= 4; i++) args.DrawingSession.DrawLine(0, i * height / 4, width, i * height / 4, Windows.UI.Color.FromArgb(70, 128, 128, 128), 1);
        var samples = values.ToArray(); if (samples.Length < 2) return;
        var maximum = fixedMaximum ?? Math.Max(1, samples.Max(i => Math.Max(i.A, i.B)));
        for (var i = 1; i < samples.Length; i++)
        {
            Vector2 Point(int index, double value) => new(index * width / (samples.Length - 1), height * (1 - (float)Math.Clamp(value / maximum, 0, 1)));
            args.DrawingSession.DrawLine(Point(i - 1, samples[i - 1].A), Point(i, samples[i].A), Colors.DodgerBlue, 2);
            args.DrawingSession.DrawLine(Point(i - 1, samples[i - 1].B), Point(i, samples[i].B), Colors.Orange, 2);
        }
    }
}
