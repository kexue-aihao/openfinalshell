using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using Windows.Graphics;

namespace OpenFinalShell.App;

internal sealed class NativeStoreRecoveryWindow : Window
{
    private sealed record SnapshotItem(NativeStoreRecoverySnapshot Snapshot, string Label)
    {
        public override string ToString() => Label;
    }

    private readonly Localization localization;
    private readonly ListView snapshots;
    private readonly TextBlock status;

    public NativeStoreRecoveryWindow(Localization localization, NativeStoreValidation validation,
        IReadOnlyList<NativeStoreRecoverySnapshot> candidates)
    {
        this.localization = localization;
        Title = localization["native.recovery.title"];

        var description = new TextBlock
        {
            Text = localization["native.recovery.description"],
            TextWrapping = TextWrapping.Wrap,
            Opacity = 0.82
        };
        var failure = new TextBlock
        {
            Text = validation.FailureCode == "interrupted-recovery"
                ? localization["native.recovery.description"]
                : string.Empty,
            TextWrapping = TextWrapping.Wrap
        };
        snapshots = new ListView
        {
            SelectionMode = ListViewSelectionMode.Single,
            Height = 190,
            ItemsSource = candidates.Select(snapshot => new SnapshotItem(snapshot,
                localization.Format("native.recovery.snapshot", ("date", snapshot.LastWriteTimeUtc.ToLocalTime().ToString("g")),
                    ("entities", snapshot.EntityCount.ToString()), ("secrets", snapshot.SecretCount.ToString())))).ToArray()
        };
        var emptyMessage = new TextBlock
        {
            Text = candidates.Count == 0 ? localization["native.recovery.noBackups"] : string.Empty,
            TextWrapping = TextWrapping.Wrap,
            Opacity = 0.82
        };
        status = new TextBlock { TextWrapping = TextWrapping.Wrap, MinHeight = 22 };
        var restore = new Button { Content = localization["native.recovery.restore"], IsEnabled = false, MinWidth = 170 };
        var fresh = new Button { Content = localization["native.recovery.fresh"], MinWidth = 170 };
        var exit = new Button { Content = localization["native.recovery.exit"], MinWidth = 90 };
        snapshots.SelectionChanged += (_, _) => restore.IsEnabled = snapshots.SelectedItem is SnapshotItem;
        AutomationProperties.SetName(snapshots, localization["native.recovery.backups"]);
        AutomationProperties.SetName(restore, localization["native.recovery.restore"]);
        AutomationProperties.SetName(fresh, localization["native.recovery.fresh"]);
        AutomationProperties.SetName(exit, localization["native.recovery.exit"]);
        restore.Click += (_, _) =>
        {
            if (snapshots.SelectedItem is SnapshotItem item) RestoreRequested?.Invoke(item.Snapshot.Path);
            else status.Text = localization["native.recovery.selectBackup"];
        };
        fresh.Click += (_, _) => StartFreshRequested?.Invoke();
        exit.Click += (_, _) => ExitRequested?.Invoke();

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Spacing = 8,
            Children = { restore, fresh, exit }
        };
        var details = new StackPanel
        {
            Spacing = 12,
            Children =
            {
                new TextBlock { Text = localization["native.recovery.title"], FontSize = 22, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold },
                description,
                failure,
                new TextBlock { Text = localization["native.recovery.backups"], FontWeight = Microsoft.UI.Text.FontWeights.SemiBold },
                snapshots,
                emptyMessage,
                status
            }
        };
        var layout = new Grid
        {
            RowDefinitions =
            {
                new RowDefinition { Height = new GridLength(1, GridUnitType.Star) },
                new RowDefinition { Height = GridLength.Auto }
            },
            Children =
            {
                new ScrollViewer
                {
                    Content = details,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    VerticalScrollMode = ScrollMode.Enabled
                },
                actions
            }
        };
        Grid.SetRow(actions, 1);
        var root = new Grid
        {
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush,
            Children = { new Border { Padding = new Thickness(24), Child = layout } }
        };
        Content = root;
        AppWindow.Resize(new SizeInt32(700, 510));
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "OpenFinalShell.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);
    }

    public event Action<string>? RestoreRequested;
    public event Action? StartFreshRequested;
    public event Action? ExitRequested;

    public void ShowFailure(bool startingFresh)
        => status.Text = localization[startingFresh ? "native.recovery.freshFailed" : "native.recovery.restoreFailed"];
}
