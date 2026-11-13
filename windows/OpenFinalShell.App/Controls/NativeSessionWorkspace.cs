using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using OpenFinalShell.App;
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
    private readonly ContentControl commands = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly TabView bottomTabs = new() { IsAddTabButtonVisible = false, TabWidthMode = TabViewWidthMode.SizeToContent, Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Stretch, Visibility = Visibility.Collapsed };
    private readonly TabViewItem filesTab = new() { IsClosable = false, MinHeight = 32 };
    private readonly TabViewItem commandsTab = new() { IsClosable = false, MinHeight = 32 };
    private readonly Func<string, string> text;
    private readonly ContentControl monitoring = new() { Visibility = Visibility.Collapsed, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly ContentControl editorContent = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly TabView editorTabs = new() { IsAddTabButtonVisible = false, TabWidthMode = TabViewWidthMode.SizeToContent, Padding = new Thickness(4, 3, 4, 0) };
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
    private double filesHeightWeight;
    private double editorHeightWeight;
    private double monitorWidth;
    private int toolbarMotionVersion;
    private bool toolsShown;
    private NativeSettings? lastConfiguredSettings;
    public IEnumerable<NativeRemoteEditor> Editors => documents.Values.Select(item => item.Editor);
    public event Action? BottomPaneChanged;
    public bool CommandsVisible => bottomTabs.Visibility == Visibility.Visible && ReferenceEquals(bottomTabs.SelectedItem, commandsTab);
    public NativeCommandComposer Composer { get; }

    public NativeSessionWorkspace(NativeTerminalCanvas terminal, FrameworkElement toolbar, NativeStore store,
        Func<NativeSftpBrowser> createFiles, Func<NativeMonitorPanel> createMonitor, Func<string, NativeRemoteEditor> createEditor,
        Func<string, string> text, NativeCommandComposer composer)
    {
        this.text = text; Composer = composer;
        this.store = store; this.createFiles = createFiles; this.createMonitor = createMonitor; this.createEditor = createEditor;
        var workspacePreferences = store.Find("nativeWorkspace", "nativeWorkspace");
        filesHeightWeight = Math.Clamp(NativeSettings.ReadPath(workspacePreferences, "filesHeight", 200), 60, 1800);
        editorHeightWeight = Math.Clamp(NativeSettings.ReadPath(workspacePreferences, "editorHeight", 280), 60, 1800);
        monitorWidth = Math.Clamp(NativeSettings.ReadPath(workspacePreferences, "monitorWidth", 300), 220, 600);
        this.terminal = terminal; terminal.RemoteDirectoryChanged += FollowRemoteDirectory;
        main.RowDefinitions.Add(new() { Height = new(0) });
        main.RowDefinitions.Add(new() { Height = new(1, GridUnitType.Star), MinHeight = 100 });
        main.RowDefinitions.Add(new() { Height = GridLength.Auto }); main.RowDefinitions.Add(filesRow);
        main.RowDefinitions.Add(new() { Height = GridLength.Auto }); main.RowDefinitions.Add(editorRow);
        var terminalHost = new Grid();
        terminalHost.RowDefinitions.Add(new() { Height = new(1, GridUnitType.Star) });
        terminalHost.RowDefinitions.Add(new() { Height = GridLength.Auto });
        terminalHost.Children.Add(terminal);
        var quickInput = composer.CreateQuickInput(() => ToggleCommands(true));
        terminalHost.Children.Add(quickInput); Grid.SetRow(quickInput, 1);
        var tools = new Border
        {
            Child = toolbar, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 6, 14, 0), Padding = new Thickness(2), CornerRadius = OpenFinalShell.App.NativeSceneStyle.CornerRadius("ControlCornerRadius", 4),
            BorderThickness = new Thickness(1), Opacity = 0, Visibility = Visibility.Collapsed, IsHitTestVisible = false,
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush,
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Microsoft.UI.Xaml.Media.Brush
        };
        terminalHost.Children.Add(tools);
        void SetToolsVisible(bool visible)
        {
            if (toolsShown == visible) return;
            toolsShown = visible;
            var version = Interlocked.Increment(ref toolbarMotionVersion);
            tools.IsHitTestVisible = visible;
            if (visible)
            {
                tools.Visibility = Visibility.Visible;
                UiTaskRunner.Run(() => NativeUiMotion.FadeInAsync(tools));
                return;
            }
            UiTaskRunner.Run(async () =>
            {
                await NativeUiMotion.AnimateOutAsync(tools, null, NativeMotionKind.Fade);
                if (version == Volatile.Read(ref toolbarMotionVersion)) tools.Visibility = Visibility.Collapsed;
            });
        }
        terminalHost.PointerEntered += (_, _) => SetToolsVisible(true);
        terminalHost.GotFocus += (_, _) => SetToolsVisible(true);
        terminalHost.PointerExited += (_, _) =>
        {
            if (XamlRoot == null) { SetToolsVisible(false); return; }
            var focused = Microsoft.UI.Xaml.Input.FocusManager.GetFocusedElement(XamlRoot) as DependencyObject;
            while (focused != null && focused != terminalHost) focused = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetParent(focused);
            if (focused == null) SetToolsVisible(false);
        };
        main.Children.Add(terminalHost); Grid.SetRow(terminalHost, 1);
        main.Children.Add(filesSplitter); Grid.SetRow(filesSplitter, 2);
        filesTab.Header = text("native.sftp.files"); filesTab.Content = files;
        commandsTab.Header = text("native.commands.command"); commandsTab.Content = CreateCommandDock(commands, composer, store);
        bottomTabs.TabItems.Add(filesTab); bottomTabs.TabItems.Add(commandsTab);
        bottomTabs.SelectionChanged += (_, _) => UpdateBottomPane();
        main.Children.Add(bottomTabs); Grid.SetRow(bottomTabs, 3);
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
        root.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star), MinWidth = 236 });
        root.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        root.ColumnDefinitions.Add(monitorColumn);
        root.Children.Add(main);
        root.Children.Add(monitorSplitter); Grid.SetColumn(monitorSplitter, 1);
        root.Children.Add(monitoring); Grid.SetColumn(monitoring, 2);
        filesSplitter.DragDelta += (_, args) =>
        {
            filesHeightWeight = ResizePaneWeight(bottomTabs.ActualHeight - args.VerticalChange);
            UpdatePaneSizes();
        };
        filesSplitter.DragCompleted += (_, _) => SaveSize("filesHeight", filesHeightWeight);
        editorSplitter.DragDelta += (_, args) =>
        {
            editorHeightWeight = ResizePaneWeight(editors.ActualHeight - args.VerticalChange);
            UpdatePaneSizes();
        };
        editorSplitter.DragCompleted += (_, _) => SaveSize("editorHeight", editorHeightWeight);
        monitorSplitter.DragDelta += (_, args) =>
        {
            monitorWidth = Math.Clamp(monitoring.ActualWidth - args.HorizontalChange, 220,
                Math.Max(220, ActualWidth * .45));
            monitorColumn.Width = new GridLength(monitorWidth);
        };
        monitorSplitter.DragCompleted += (_, _) => SaveSize("monitorWidth", monitorWidth);
        SizeChanged += (_, _) => UpdatePaneSizes();
        Content = root;
    }
    private void SaveSize(string key, double value)
    {
        try { store.Patch("nativeWorkspace", "nativeWorkspace", new() { [key] = value }); }
        catch (Exception error) { System.Diagnostics.Debug.WriteLine($"Could not save native pane size: {error.Message}"); }
    }
    internal static Grid CreateCommandDock(UIElement library, NativeCommandComposer composer, NativeStore store)
    {
        var fraction = Math.Clamp(NativeSettings.ReadPath(store.Find("nativeWorkspace", "nativeWorkspace"), "commandLibraryFraction", .32), .2, .65);
        var dock = new Grid();
        var libraryColumn = new ColumnDefinition { Width = new(fraction, GridUnitType.Star), MinWidth = 180 };
        var editorColumn = new ColumnDefinition { Width = new(1 - fraction, GridUnitType.Star), MinWidth = 220 };
        dock.ColumnDefinitions.Add(libraryColumn); dock.ColumnDefinitions.Add(new() { Width = new(6) }); dock.ColumnDefinitions.Add(editorColumn);
        var splitter = new Thumb { Width = 6, Background = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Microsoft.UI.Xaml.Media.Brush };
        dock.Children.Add(library); dock.Children.Add(splitter); Grid.SetColumn(splitter, 1);
        dock.Children.Add(composer); Grid.SetColumn(composer, 2);
        splitter.DragDelta += (_, args) =>
        {
            fraction = Math.Clamp((libraryColumn.ActualWidth + args.HorizontalChange) / Math.Max(1, dock.ActualWidth - 6), .2, .65);
            libraryColumn.Width = new(fraction, GridUnitType.Star); editorColumn.Width = new(1 - fraction, GridUnitType.Star);
        };
        splitter.DragCompleted += (_, _) =>
        {
            try { store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["commandLibraryFraction"] = fraction }); }
            catch (Exception error) { System.Diagnostics.Debug.WriteLine($"Could not save command pane size: {error.Message}"); }
        };
        return dock;
    }
    private double ResizePaneWeight(double height)
    {
        // Store relative weights so opening another pane or changing UI/DPI
        // scale cannot push fixed-height content outside the session viewport.
        var terminalHeight = Math.Max(60, main.RowDefinitions[1].ActualHeight);
        return Math.Clamp(height / terminalHeight * 300, 60, 1800);
    }
    private void UpdatePaneSizes()
    {
        // Reserve usable space for editor chrome and a few lines of text.
        // Proportions alone can leave only a scrollbar when search is open.
        var available = Math.Max(0, ActualHeight - 60);
        filesRow.MinHeight = bottomTabs.Visibility == Visibility.Visible ? Math.Min(160, available * .3) : 0;
        editorRow.MinHeight = editors.Visibility == Visibility.Visible ? Math.Min(240, available * .55) : 0;
        main.RowDefinitions[1].Height = new(3, GridUnitType.Star);
        filesRow.Height = bottomTabs.Visibility == Visibility.Visible ? new(filesHeightWeight / 100, GridUnitType.Star) : new(0);
        editorRow.Height = editors.Visibility == Visibility.Visible ? new(editorHeightWeight / 100, GridUnitType.Star) : new(0);
    }
    public void ToggleFiles(bool forceOpen = false)
    {
        ToggleBottomPane(filesTab, forceOpen);
    }
    public void ToggleCommands(bool forceOpen = false) => ToggleBottomPane(commandsTab, forceOpen);
    public void SetCommandLibrary(UIElement? library) => commands.Content = library;
    private void ToggleBottomPane(TabViewItem tab, bool forceOpen)
    {
        var show = forceOpen || bottomTabs.Visibility != Visibility.Visible || !ReferenceEquals(bottomTabs.SelectedItem, tab);
        bottomTabs.Visibility = filesSplitter.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        bottomTabs.SelectedItem = tab;
        UpdateBottomPane();
    }
    private void UpdateBottomPane()
    {
        var show = bottomTabs.Visibility == Visibility.Visible && ReferenceEquals(bottomTabs.SelectedItem, filesTab);
        if (show && files.Content == null) files.Content = createFiles();
        files.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        UpdatePaneSizes();
        if (files.Content is NativeSftpBrowser browser)
        {
            browser.SetFollowActive(workspaceActive && show);
            if (show && terminal.RemoteDirectory is { } directory) browser.FollowRemoteDirectory(directory);
        }
        BottomPaneChanged?.Invoke();
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
        monitorColumn.Width = new(show ? monitorWidth : 0);
        SetActive(workspaceActive);
    }
    public void SetActive(bool active)
    {
        workspaceActive = active;
        terminal.SetActive(active);
        if (files.Content is NativeSftpBrowser browser) browser.SetFollowActive(active && files.Visibility == Visibility.Visible);
        if (monitoring.Content is ScrollViewer { Content: NativeMonitorPanel monitor }) monitor.SetActive(active && monitoring.Visibility == Visibility.Visible);
    }
    public void Configure(NativeSettings settings)
    {
        filesTab.Header = text("native.sftp.files"); commandsTab.Header = text("native.commands.command");
        Composer.ConfigureLabels();
        if (ReferenceEquals(lastConfiguredSettings, settings)) return;
        lastConfiguredSettings = settings;
        foreach (var editor in Editors) editor.Configure(settings);
        if (files.Content is NativeSftpBrowser browser) browser.Configure(settings);
        if (monitoring.Content is ScrollViewer { Content: NativeMonitorPanel monitor }) monitor.SetInterval(settings.MonitorIntervalMs);
    }
    public void OpenEditor(string path)
    {
        if (!documents.TryGetValue(path, out var item))
        {
            var editor = createEditor(path);
            var tab = new TabViewItem { Header = Path.GetFileName(path), Tag = path, IsClosable = true, MinHeight = 32, Padding = new Thickness(10, 0, 10, 0) };
            ToolTipService.SetToolTip(tab, path);
            editor.StateChanged += () => UpdateTabHeader(tab, path, editor);
            UpdateTabHeader(tab, path, editor);
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
        commands.Content = null;
        terminal.RemoteDirectoryChanged -= FollowRemoteDirectory;
        if (files.Content is NativeSftpBrowser browser) browser.Dispose();
        foreach (var editor in Editors) editor.Dispose(); documents.Clear();
        if (monitoring.Content is ScrollViewer { Content: NativeMonitorPanel monitor }) monitor.Dispose();
    }
    private void FollowRemoteDirectory(string directory)
    {
        if (files.Content is NativeSftpBrowser browser) browser.FollowRemoteDirectory(directory);
    }
    private static void UpdateTabHeader(TabViewItem tab, string path, NativeRemoteEditor editor)
    {
        tab.Header = $"{(editor.HasUnsavedChanges ? "● " : string.Empty)}{Path.GetFileName(path)}";
        ToolTipService.SetToolTip(tab, path);
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
