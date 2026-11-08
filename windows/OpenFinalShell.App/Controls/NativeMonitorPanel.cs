using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.Controls;

/// <summary>Live native server monitor. Metrics arrive only as validated Core snapshots.</summary>
public sealed class NativeMonitorPanel : UserControl, IDisposable
{
    private readonly NativeMonitorService service;
    private readonly NativeSession session;
    private readonly NativeMonitorDashboard dashboard;
    private readonly TextBlock state = new();
    private readonly TextBlock identity = new() { TextWrapping = TextWrapping.Wrap };
    private readonly ProgressRing progress = new() { Width = 14, Height = 14, IsActive = false, Visibility = Visibility.Collapsed };
    private readonly Func<string, string> text;
    private bool started;
    private bool disposed;
    private bool active = true;
    private int generation;
    private CancellationTokenSource? activityCancellation;
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    public event Action? CloseRequested;

    public NativeMonitorPanel(NativeSession session, int intervalMs, Func<string, string> text)
    {
        this.text = text; this.session = session; service = new NativeMonitorService(session);
        session.StateChanged += SessionStateChanged;
        AutomationProperties.SetLiveSetting(state, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        service.StateChanged += OnStateChanged;
        service.Snapshot += OnSnapshot;
        dashboard = new NativeMonitorDashboard(text);
        var close = new Button { Content = "\u00D7", Width = 28, Height = 28, Padding = new Thickness(0) };
        AutomationProperties.SetName(close, text("common.close")); ToolTipService.SetToolTip(close, text("common.close"));
        close.Click += (_, _) => CloseRequested?.Invoke();
        var title = new TextBlock { Text = text("native.monitor.title"), FontSize = 16, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold };
        var header = new Grid { ColumnSpacing = 8 };
        header.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        state.VerticalAlignment = VerticalAlignment.Center; state.FontSize = 12;
        header.Children.Add(state);
        header.Children.Add(progress); Grid.SetColumn(progress, 1);
        header.Children.Add(close); Grid.SetColumn(close, 2);
        identity.FontSize = 12;
        var systemCard = new Border
        {
            Padding = new Thickness(10, 8, 10, 8), CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(1),
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Microsoft.UI.Xaml.Media.Brush,
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush,
            Child = identity
        };
        Content = new StackPanel { Padding = new Thickness(10), Spacing = 10, Children = { title, header, systemCard, dashboard } };
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        Tag = intervalMs;
    }

    private async void OnLoaded(object sender, RoutedEventArgs args) => await UpdateActivityAsync();
    public void SetActive(bool value) { if (active != value) generation++; active = value; if (!value) activityCancellation?.Cancel(); _ = UpdateActivityAsync(); }
    private void SessionStateChanged(NativeSessionSnapshot snapshot) => DispatcherQueue.TryEnqueue(() => { generation++; activityCancellation?.Cancel(); _ = RestartAsync(); });
    public void SetInterval(int intervalMs)
    {
        if (Tag is int previous && previous == intervalMs) return;
        Tag = intervalMs;
        _ = RestartAsync();
    }
    private async Task RestartAsync()
    {
        activityCancellation?.Cancel();
        await lifecycle.WaitAsync();
        try { if (started) await service.StopAsync(); started = false; }
        finally { lifecycle.Release(); }
        await UpdateActivityAsync();
    }
    private async Task UpdateActivityAsync()
    {
        await lifecycle.WaitAsync();
        try
        {
            if (disposed || !active || !IsLoaded || session.Snapshot.State != NativeSessionState.Ready)
            {
                await service.StopAsync();
                activityCancellation?.Dispose(); activityCancellation = null;
                dashboard.Clear(); identity.Text = "";
                SetSessionStatus(session.Snapshot.State);
                started = false; return;
            }
            if (started) return;
            dashboard.Clear();
            activityCancellation?.Dispose();
            activityCancellation = new CancellationTokenSource();
            var revision = generation;
            started = true;
            SetCollectorStatus(NativeCollectorState.Starting);
            await service.StartAsync((int)Tag, activityCancellation.Token);
            if (disposed || !active || !IsLoaded || revision != generation)
            {
                await service.StopAsync(); started = false; dashboard.Clear(); identity.Text = ""; return;
            }
            if (service.StaticInfo is { } info)
                identity.Text = $"{info.Hostname}\n{info.Distribution} · {info.Kernel} · {info.Architecture}\n{string.Join(", ", info.Addresses)}";
        }
        catch (OperationCanceledException) { await service.StopAsync(); started = false; dashboard.Clear(); identity.Text = ""; }
        catch (Exception error) { started = false; if (!disposed) { progress.IsActive = false; progress.Visibility = Visibility.Collapsed; state.Text = $"{text("native.monitor.failed")}: {error.Message}"; } }
        finally { lifecycle.Release(); }
    }

    private async void OnUnloaded(object sender, RoutedEventArgs args)
    {
        generation++; activityCancellation?.Cancel();
        await UpdateActivityAsync();
    }

    private void OnStateChanged(NativeCollectorState value, string? error)
    {
        var revision = generation;
        DispatcherQueue.TryEnqueue(() =>
        {
            if (disposed || revision != generation) return;
            SetCollectorStatus(value);
            if (error != null && value == NativeCollectorState.Failed) state.Text += $" · {error}";
        });
    }

    private void SetCollectorStatus(NativeCollectorState value)
    {
        var (key, busy) = value switch
        {
            NativeCollectorState.Starting => ("native.monitor.starting", true),
            NativeCollectorState.Running => ("native.monitor.collecting", false),
            NativeCollectorState.Unsupported => ("native.monitor.unsupportedState", false),
            NativeCollectorState.Failed => ("native.monitor.failed", false),
            _ => ("native.monitor.stopped", false)
        };
        state.Text = text(key);
        progress.IsActive = busy;
        progress.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
    }

    private void SetSessionStatus(NativeSessionState value)
    {
        var busy = value is NativeSessionState.Connecting or NativeSessionState.Reconnecting;
        state.Text = text(busy ? "native.monitor.waitingSession" : value == NativeSessionState.Failed ? "native.monitor.disconnected" : "native.monitor.stopped");
        progress.IsActive = busy;
        progress.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnSnapshot(MonitorSnapshot snapshot)
    {
        var revision = generation;
        DispatcherQueue.TryEnqueue(() =>
        {
            if (disposed || !active || !IsLoaded || session.Snapshot.State != NativeSessionState.Ready || revision != generation) return;
            dashboard.Update(snapshot);
        });
    }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        generation++; activityCancellation?.Cancel();
        service.StateChanged -= OnStateChanged; service.Snapshot -= OnSnapshot;
        session.StateChanged -= SessionStateChanged;
        _ = UpdateActivityAsync();
    }
}
