using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using OpenFinalShell.Core;
using System.Text.Json.Nodes;

namespace OpenFinalShell.App.Controls;

/// <summary>One SSH session owns its terminal, file browser, editors and collectors.</summary>
public sealed class NativeSessionWorkspace : UserControl, IDisposable
{
    private readonly Grid root = new();
    private readonly Grid main = new();
    private readonly RowDefinition filesRow = new() { Height = new(0) };
    private readonly RowDefinition editorRow = new() { Height = new(0) };
    private readonly ColumnDefinition monitorColumn = new() { Width = new(0) };
    private readonly ContentControl files = new() { Visibility = Visibility.Collapsed, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly ContentControl monitoring = new() { Visibility = Visibility.Collapsed, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly ContentControl editorContent = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly TabView editorTabs = new() { IsAddTabButtonVisible = false };
    private readonly Grid editors = new() { Visibility = Visibility.Collapsed };
    private readonly Dictionary<string, (TabViewItem Tab, NativeRemoteEditor Editor)> documents = new(StringComparer.Ordinal);
    private readonly NativeStore store;
    private readonly Func<NativeSftpBrowser> createFiles;
    private readonly Func<NativeMonitorPanel> createMonitor;
    private readonly Func<string, NativeRemoteEditor> createEditor;
    private readonly Thumb filesSplitter = new() { Height = 6, Visibility = Visibility.Collapsed };
    private readonly Thumb editorSplitter = new() { Height = 6, Visibility = Visibility.Collapsed };
    private readonly Thumb monitorSplitter = new() { Width = 6, Visibility = Visibility.Collapsed };
    private bool workspaceActive = true;
    private readonly NativeTerminalCanvas terminal;
    public IEnumerable<NativeRemoteEditor> Editors => documents.Values.Select(item => item.Editor);

    public NativeSessionWorkspace(NativeTerminalCanvas terminal, FrameworkElement toolbar, NativeStore store,
        Func<NativeSftpBrowser> createFiles, Func<NativeMonitorPanel> createMonitor, Func<string, NativeRemoteEditor> createEditor)
    {
        this.store = store; this.createFiles = createFiles; this.createMonitor = createMonitor; this.createEditor = createEditor;
        this.terminal = terminal; terminal.RemoteDirectoryChanged += FollowRemoteDirectory;
        main.RowDefinitions.Add(new() { Height = new(0) });
        main.RowDefinitions.Add(new() { Height = new(1, GridUnitType.Star), MinHeight = 100 });
        main.RowDefinitions.Add(new() { Height = GridLength.Auto }); main.RowDefinitions.Add(filesRow);
        main.RowDefinitions.Add(new() { Height = GridLength.Auto }); main.RowDefinitions.Add(editorRow);
        var terminalHost = new Grid();
        terminalHost.Children.Add(terminal);
        var tools = new Border
        {
            Child = toolbar, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 6, 14, 0), Padding = new Thickness(2), CornerRadius = new CornerRadius(4),
            BorderThickness = new Thickness(1), Opacity = 0,
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush,
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Microsoft.UI.Xaml.Media.Brush
        };
        terminalHost.Children.Add(tools);
        terminalHost.PointerEntered += (_, _) => tools.Opacity = 1;
        terminalHost.GotFocus += (_, _) => tools.Opacity = 1;
        terminalHost.PointerExited += (_, _) =>
        {
            if (XamlRoot == null) { tools.Opacity = 0; return; }
            var focused = Microsoft.UI.Xaml.Input.FocusManager.GetFocusedElement(XamlRoot) as DependencyObject;
            while (focused != null && focused != terminalHost) focused = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetParent(focused);
            if (focused == null) tools.Opacity = 0;
        };
        main.Children.Add(terminalHost); Grid.SetRow(terminalHost, 1);
        main.Children.Add(filesSplitter); Grid.SetRow(filesSplitter, 2);
        main.Children.Add(files); Grid.SetRow(files, 3);
        editors.RowDefinitions.Add(new() { Height = GridLength.Auto }); editors.RowDefinitions.Add(new() { Height = new(1, GridUnitType.Star) });
        editors.Children.Add(editorTabs); editors.Children.Add(editorContent); Grid.SetRow(editorContent, 1);
        main.Children.Add(editorSplitter); Grid.SetRow(editorSplitter, 4); main.Children.Add(editors); Grid.SetRow(editors, 5);
        editorTabs.SelectionChanged += (_, _) => { editorContent.Content = editorTabs.SelectedItem is TabViewItem tab && documents.TryGetValue(tab.Tag?.ToString() ?? "", out var item) ? item.Editor : null; };
        editorTabs.TabCloseRequested += async (_, args) =>
        {
            var path = args.Tab.Tag?.ToString() ?? "";
            if (!documents.TryGetValue(path, out var item) || !await item.Editor.ConfirmCloseAsync()) return;
            documents.Remove(path); editorTabs.TabItems.Remove(item.Tab); item.Editor.Dispose();
            if (documents.Count == 0) { editors.Visibility = editorSplitter.Visibility = Visibility.Collapsed; editorRow.Height = new(0); }
        };
        root.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star), MinWidth = 160 });
        root.ColumnDefinitions.Add(new() { Width = GridLength.Auto }); root.ColumnDefinitions.Add(monitorColumn);
        root.Children.Add(main); root.Children.Add(monitorSplitter); Grid.SetColumn(monitorSplitter, 1);
        root.Children.Add(monitoring); Grid.SetColumn(monitoring, 2);
        filesSplitter.DragDelta += (_, args) => ResizePane("filesHeight", files.ActualHeight - args.VerticalChange);
        editorSplitter.DragDelta += (_, args) => ResizePane("editorHeight", editors.ActualHeight - args.VerticalChange);
        monitorSplitter.DragDelta += (_, args) => { monitorColumn.Width = new(Math.Clamp(monitoring.ActualWidth - args.HorizontalChange, 220, Math.Max(220, ActualWidth * .45))); SaveSize("monitorWidth", monitorColumn.Width.Value); };
        SizeChanged += (_, _) => UpdatePaneSizes();
        Content = root;
    }
    private double Saved(string key, double fallback) => NativeSettings.ReadPath(store.Find("nativeWorkspace", "nativeWorkspace"), key, fallback);
    private void SaveSize(string key, double value) => store.Patch("nativeWorkspace", "nativeWorkspace", new() { [key] = value });
    private void ResizePane(string key, double height)
    {
        // Store relative weights so opening another pane or changing UI/DPI
        // scale cannot push fixed-height content outside the session viewport.
        var terminalHeight = Math.Max(60, main.RowDefinitions[1].ActualHeight);
        SaveSize(key, Math.Clamp(height / terminalHeight * 300, 60, 1800));
        UpdatePaneSizes();
    }
    private void UpdatePaneSizes()
    {
        // Reserve usable space for editor chrome and a few lines of text.
        // Proportions alone can leave only a scrollbar when search is open.
        var available = Math.Max(0, ActualHeight - 60);
        filesRow.MinHeight = files.Visibility == Visibility.Visible ? Math.Min(110, available * .25) : 0;
        editorRow.MinHeight = editors.Visibility == Visibility.Visible ? Math.Min(240, available * .55) : 0;
        main.RowDefinitions[1].Height = new(3, GridUnitType.Star);
        filesRow.Height = files.Visibility == Visibility.Visible ? new(Math.Clamp(Saved("filesHeight", 200), 60, 1800) / 100, GridUnitType.Star) : new(0);
        editorRow.Height = editors.Visibility == Visibility.Visible ? new(Math.Clamp(Saved("editorHeight", 280), 60, 1800) / 100, GridUnitType.Star) : new(0);
    }
    public void ToggleFiles(bool forceOpen = false)
    {
        var show = forceOpen || files.Visibility != Visibility.Visible;
        if (show && files.Content == null) files.Content = createFiles();
        files.Visibility = filesSplitter.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        UpdatePaneSizes();
        if (files.Content is NativeSftpBrowser browser)
        {
            browser.SetFollowActive(workspaceActive && show);
            if (show && terminal.RemoteDirectory is { } directory) browser.FollowRemoteDirectory(directory);
        }
    }
    public void ToggleMonitor(bool forceOpen = false)
    {
        var show = forceOpen || monitoring.Visibility != Visibility.Visible;
        if (show && monitoring.Content == null)
        {
            var monitor = createMonitor(); monitor.CloseRequested += () => ToggleMonitor();
            monitoring.Content = new ScrollViewer { Content = monitor };
        }
        monitoring.Visibility = monitorSplitter.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        monitorColumn.Width = new(show ? Math.Clamp(Saved("monitorWidth", 300), 220, 600) : 0);
        SetActive(workspaceActive);
    }
    public void SetActive(bool active)
    {
        workspaceActive = active;
        if (files.Content is NativeSftpBrowser browser) browser.SetFollowActive(active && files.Visibility == Visibility.Visible);
        if (monitoring.Content is ScrollViewer { Content: NativeMonitorPanel monitor }) monitor.SetActive(active && monitoring.Visibility == Visibility.Visible);
    }
    public void Configure(NativeSettings settings)
    {
        foreach (var editor in Editors) editor.Configure(settings);
        if (files.Content is NativeSftpBrowser browser) browser.Configure(settings);
        if (monitoring.Content is ScrollViewer { Content: NativeMonitorPanel monitor }) monitor.SetInterval(settings.MonitorIntervalMs);
    }
    public void OpenEditor(string path)
    {
        if (!documents.TryGetValue(path, out var item))
        {
            var editor = createEditor(path);
            var tab = new TabViewItem { Header = Path.GetFileName(path), Tag = path };
            documents[path] = item = (tab, editor); editorTabs.TabItems.Add(tab);
        }
        editorTabs.SelectedItem = item.Tab; editorContent.Content = item.Editor;
        editors.Visibility = editorSplitter.Visibility = Visibility.Visible;
        UpdatePaneSizes();
    }
    public async Task<bool> ConfirmCloseAsync()
    {
        foreach (var editor in Editors.ToArray()) if (!await editor.ConfirmCloseAsync()) return false;
        return true;
    }
    public void Dispose()
    {
        terminal.RemoteDirectoryChanged -= FollowRemoteDirectory;
        if (files.Content is NativeSftpBrowser browser) browser.Dispose();
        foreach (var editor in Editors) editor.Dispose(); documents.Clear();
        if (monitoring.Content is ScrollViewer { Content: NativeMonitorPanel monitor }) monitor.Dispose();
    }
    private void FollowRemoteDirectory(string directory)
    {
        if (files.Content is NativeSftpBrowser browser) browser.FollowRemoteDirectory(directory);
    }
    public void FollowShellCommand(string command)
    {
        if (files.Content is NativeSftpBrowser browser) browser.FollowShellCommand(command);
    }
    public void FollowExecutedShellCommands(string commands)
    {
        foreach (var command in commands.Split('\n')) FollowShellCommand(command.Trim());
    }
    public void ResetRemoteDirectory()
    {
        terminal.ResetRemoteDirectory();
        if (files.Content is NativeSftpBrowser browser) browser.ResetRemoteDirectory();
    }
}
