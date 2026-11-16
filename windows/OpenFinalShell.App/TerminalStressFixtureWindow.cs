using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.App.Controls;
using OpenFinalShell.Core;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.App;

/// <summary>Opt-in local SSH acceptance harness. Uses an isolated store and never executes OS commands.</summary>
internal sealed class TerminalStressFixtureWindow : Window
{
    private readonly NativeTerminalCanvas[] terminals = [new(), new(), new()];
    private readonly NativeStore store = new(NativeStore.DefaultDirectory, new DpapiProtector());
    private readonly NativeSessionManager sessions;
    private readonly CancellationTokenSource lifetime = new();
    private readonly UiResponsivenessMonitor responsiveness;
    private readonly List<string> ids = [];
    private readonly List<long> memory = [];
    private readonly List<string> failures = [];
    private readonly TabView tabs = new();
    private readonly TextBlock status = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer interactions;
    private int turn, searchCount;
    public TerminalStressFixtureWindow()
    {
        Title = "OpenFinalShell local terminal stress fixture";
        sessions = new(store);
        responsiveness = new(DispatcherQueue);
        var layout = new Grid(); layout.RowDefinitions.Add(new() { Height = GridLength.Auto }); layout.RowDefinitions.Add(new());
        layout.Children.Add(status); Grid.SetRow(tabs, 1); layout.Children.Add(tabs); Content = layout;
        layout.SizeChanged += (_, _) => { foreach (var terminal in terminals) terminal.Height = Math.Max(100, layout.ActualHeight - 100); };
        AppWindow.Resize(new Windows.Graphics.SizeInt32(900, 650));
        foreach (var terminal in terminals)
        {
            tabs.TabItems.Add(new TabViewItem { Header = "SSH", Content = terminal, IsClosable = false });
            terminal.InputRejected += () => failures.Add("terminal operation rejected");
        }
        tabs.TabItems.Add(new TabViewItem { Header = "Settings", Content = new StackPanel { Children = { new TextBlock { Text = "Settings during output" }, new Slider { Minimum = 10, Maximum = 24, Value = 14 } } } });
        tabs.SelectionChanged += (_, _) => { for (var i = 0; i < terminals.Length; i++) terminals[i].SetActive(tabs.SelectedIndex == i); };
        sessions.StateChanged += snapshot => { if (snapshot.State == NativeSessionState.Failed) DispatcherQueue.TryEnqueue(() => failures.Add(snapshot.Error ?? "transport failure")); };
        interactions = DispatcherQueue.CreateTimer(); interactions.Interval = TimeSpan.FromSeconds(1);
        interactions.Tick += async (_, _) =>
        {
            turn++; tabs.SelectedIndex = turn % 4;
            status.Text = $"elapsed={clock.Elapsed.TotalSeconds:F0}s actions={turn} searches={searchCount}";
            memory.Add(Process.GetCurrentProcess().PrivateMemorySize64);
            if (turn % 5 == 0 && ids.Count > 0)
            {
                try { await sessions.Get(ids[1]).WriteAsync(Encoding.UTF8.GetBytes("echo ordinary-session\r")); }
                catch (Exception error) { failures.Add(error.Message); }
            }
            if (turn % 7 == 0)
            {
                try { await terminals[0].SearchAsync("fixture", false, false, lifetime.Token); searchCount++; }
                catch (OperationCanceledException) { }
                catch (Exception error) { failures.Add(error.Message); }
            }
            if (turn % 11 == 0) AppWindow.Resize(new Windows.Graphics.SizeInt32(turn % 22 == 0 ? 900 : 1000, 650));
        };
        Activated += StartOnce;
    }
    private bool started;
    private async void StartOnce(object sender, WindowActivatedEventArgs args)
    {
        if (started) return; started = true;
        var seconds = int.TryParse(Environment.GetEnvironmentVariable("OFS_TERMINAL_STRESS_SECONDS"), out var duration) ? duration : 600;
        var port = int.Parse(Environment.GetEnvironmentVariable("OFS_TERMINAL_STRESS_PORT") ?? "2222");
        try
        {
            // Exercise retained canvases through the real workspace parent path.
            await using (var retained = new NativeTerminalCanvas())
            {
                NativeSessionWorkspace Workspace() => new(retained, new StackPanel(), store,
                    () => throw new InvalidOperationException(), () => throw new InvalidOperationException(),
                    _ => throw new InvalidOperationException(), key => key,
                    new NativeCommandComposer(key => key, (_, _, _, _) => true, () => [], (_, _) => { }, (_, _) => { }, new NativeCommandTargets()));
                using var workspace = Workspace();
                var host = new ContentControl { Content = workspace };
                host.Content = null; host.Content = workspace; host.Content = null;
                await retained.EnqueueOutputAsync(Encoding.UTF8.GetBytes("retained parser\r\n"));
            }
            var secret = store.SaveSecret("test123");
            for (var i = 0; i < terminals.Length; i++)
            {
                var index = i;
                var profile = ConnectionProfile.FromJson(new JsonObject
                {
                    ["id"] = "stress" + i, ["name"] = "Stress " + i, ["host"] = "127.0.0.1", ["port"] = port, ["username"] = "test",
                    ["auth"] = new JsonObject { ["method"] = "password", ["passwordRef"] = secret },
                    ["options"] = new JsonObject { ["autoReconnect"] = false }
                });
                var snapshot = await sessions.OpenAsync(profile, _ => Task.FromResult(true), (_, _) => Task.FromResult<string?>("test123"), lifetime.Token,
                    bytes => terminals[index].EnqueueOutputAsync(bytes, lifetime.Token));
                ids.Add(snapshot.SessionId);
                terminals[index].Input += bytes => sessions.Get(snapshot.SessionId).Write(bytes);
                terminals[index].TerminalSizeChanged += (cols, rows) => sessions.Get(snapshot.SessionId).Resize((uint)cols, (uint)rows);
            }
            interactions.Start();
            await sessions.Get(ids[0]).WriteAsync(Encoding.UTF8.GetBytes("replay 10000000 10 32768\r"));
            await sessions.Get(ids[2]).WriteAsync(Encoding.UTF8.GetBytes("replay 10000000 100 13\r"));
            await Task.Delay(TimeSpan.FromSeconds(seconds));
            await sessions.Get(ids[0]).WriteAsync([3]);
        }
        catch (Exception error) { failures.Add(error.ToString()); }
        finally
        {
            interactions.Stop();
            var metrics = ids.Select(id => sessions.Get(id)).Select(s => new { s.ReceivedBytes, s.PendingOutputBytes, s.OutputQueueHighWater, s.ShellBufferedBytes, s.ShellBufferHighWater }).ToArray();
            var closing = Stopwatch.StartNew();
            try { await sessions.DisposeAsync(); foreach (var terminal in terminals) await terminal.DisposeAsync(); }
            catch (Exception error) { failures.Add(error.ToString()); }
            responsiveness.Dispose();
            lifetime.Cancel();
            var report = new { seconds, elapsedSeconds = clock.Elapsed.TotalSeconds, turn, searchCount, closeMs = closing.Elapsed.TotalMilliseconds, metrics, memory, failures,
                render = terminals.Select(t => new { t.RenderCount, t.RenderMilliseconds, t.MaximumRenderMilliseconds }).ToArray() };
            await File.WriteAllTextAsync(Path.Combine(NativeStore.DefaultDirectory, "terminal-stress.json"), JsonSerializer.Serialize(report));
            store.Dispose(); Close(); Application.Current.Exit();
        }
    }
}
