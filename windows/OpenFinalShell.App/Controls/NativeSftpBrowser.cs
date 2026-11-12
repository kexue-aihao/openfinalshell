using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.App.ViewModels;
using OpenFinalShell.Core;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Input;
using WinRT.Interop;
using Windows.Foundation;
using OpenFinalShell.App;

namespace OpenFinalShell.App.Controls;

/// <summary>Native SFTP browser backed by the same session as its terminal tab.</summary>
public sealed class NativeSftpBrowser : UserControl, IDisposable
{
    private sealed record LocalUploadItem(string Path, string Name, bool IsDirectory);
    private sealed record UploadBatchResult(int Queued, int Skipped, bool Canceled = false);

    private const int MaximumDirectoryTransferFiles = 5000;
    private const int MaximumDirectoryDepth = 32;
    private readonly NativeSession session;
    private readonly NativeTransferQueue transfers;
    private readonly SftpBrowserViewModel viewModel;
    private readonly Func<nint> windowHandle;
    private readonly Func<string, string> text;
    private readonly Localization fastDeleteLocalization = new();
    private readonly Action<string> openFile;
    private readonly TextBox path = new() { MinWidth = 0, Text = "/", FontSize = 12 };
    private readonly ListView entries = new() { SelectionMode = ListViewSelectionMode.Single, IsItemClickEnabled = true };
    private readonly TextBlock status = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Button back = new(), forward = new(), up = new(), refresh = new(), upload = new(), uploadFolder = new(), download = new(), newFolder = new(), newFile = new(), rename = new(), chmod = new(), delete = new();
    private readonly StackPanel breadcrumbs = new() { Orientation = Orientation.Horizontal, Spacing = 2 };
    private readonly NativeSftpNavigationHistory navigationHistory = new();
    private Border dropOverlay = null!;
    private TextBlock dropHint = null!;
    private string browseLabel = "Refresh";
    private string uploadLabel = "Upload";
    private string downloadLabel = "Download";
    private string newFolderLabel = "New folder";
    private string deleteLabel = "Delete";
    private bool initialized;
    private NativeSettings preferences;
    private readonly Dictionary<string, (Button Button, string Label)> sortHeaders = new(StringComparer.Ordinal);
    private string sortField = "name";
    private bool sortDescending;
    private bool sortSelected;
    private readonly ToggleSwitch hidden = new();
    private bool configuring;
    private CancellationTokenSource? followCancellation;
    private string? pendingFollowPath;
    private string? reportedDirectory, followingDirectory;
    private string? homeDirectory, shellDirectory;
    private long shellCommandVersion;
    private bool followActive, disposed;
    private int dropMotionVersion;
    private bool dropOverlayShown;

    public NativeSftpBrowser(NativeSession session, NativeTransferQueue transfers, Func<nint> windowHandle, Func<string, string> text, Action<string>? openFile = null, NativeSettings? settings = null)
    {
        this.session = session; this.transfers = transfers; this.windowHandle = windowHandle; this.text = text;
        this.openFile = openFile ?? (_ => { });
        preferences = settings ?? NativeSettings.Defaults;
        fastDeleteLocalization.SetLanguage(preferences.Language);
        viewModel = new SftpBrowserViewModel(session);
        browseLabel = text("native.sftp.refresh"); uploadLabel = text("native.sftp.upload"); downloadLabel = text("native.sftp.download");
        newFolderLabel = text("native.sftp.newFolder"); deleteLabel = text("native.sftp.delete");
        back.Content = text("sftp.back"); forward.Content = text("sftp.forward"); up.Content = text("native.sftp.up"); refresh.Content = browseLabel; upload.Content = uploadLabel; uploadFolder.Content = text("native.sftp.uploadFolder"); download.Content = downloadLabel;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(back, text("sftp.back")); Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(forward, text("sftp.forward"));
        newFolder.Content = newFolderLabel; newFile.Content = text("native.sftp.newFile"); rename.Content = text("native.sftp.rename"); chmod.Content = text("native.sftp.chmod"); delete.Content = deleteLabel;
        path.KeyDown += async (_, args) => { if (args.Key == Windows.System.VirtualKey.Enter) { await NavigateAsync(path.Text); args.Handled = true; } };
        back.Click += async (_, _) => await NavigateHistoryAsync(-1);
        forward.Click += async (_, _) => await NavigateHistoryAsync(1);
        up.Click += async (_, _) => await NavigateAsync(SftpBrowserViewModel.ParentPath(viewModel.CurrentPath));
        refresh.Click += async (_, _) => await RunAsync(() => viewModel.RefreshAsync());
        upload.Click += async (_, _) => await UploadAsync();
        uploadFolder.Click += async (_, _) => await UploadFolderAsync();
        download.Click += async (_, _) => await DownloadAsync();
        newFolder.Click += async (_, _) => await CreateFolderAsync();
        newFile.Click += async (_, _) => await CreateFileAsync();
        rename.Click += async (_, _) => await RenameAsync();
        chmod.Click += async (_, _) => await ChmodAsync();
        delete.Click += async (_, _) => await DeleteAsync();
        entries.ItemsSource = viewModel.Entries;
        entries.ItemTemplate = (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><Grid MinWidth=\"1000\" Padding=\"8,4\" ColumnSpacing=\"12\"><Grid.ColumnDefinitions><ColumnDefinition Width=\"2.4*\"/><ColumnDefinition Width=\"0.7*\"/><ColumnDefinition Width=\"0.9*\"/><ColumnDefinition Width=\"1.1*\"/><ColumnDefinition Width=\"0.9*\"/><ColumnDefinition Width=\"0.9*\"/><ColumnDefinition Width=\"260\"/></Grid.ColumnDefinitions><TextBlock Text=\"{Binding Name}\" TextTrimming=\"CharacterEllipsis\"/><TextBlock Grid.Column=\"1\" Text=\"{Binding Type}\" Opacity=\"0.65\" TextTrimming=\"CharacterEllipsis\"/><TextBlock Grid.Column=\"2\" Text=\"{Binding Size}\" Opacity=\"0.65\" HorizontalAlignment=\"Right\"/><TextBlock Grid.Column=\"3\" Text=\"{Binding Mode}\" Opacity=\"0.65\" HorizontalAlignment=\"Center\"/><TextBlock Grid.Column=\"4\" Text=\"{Binding OwnerId}\" Opacity=\"0.65\" HorizontalAlignment=\"Right\"/><TextBlock Grid.Column=\"5\" Text=\"{Binding GroupId}\" Opacity=\"0.65\" HorizontalAlignment=\"Right\"/><TextBlock Grid.Column=\"6\"  Opacity=\"0.65\" TextTrimming=\"CharacterEllipsis\"/></Grid></DataTemplate>");
        entries.ContainerContentChanging += UpdateEntryPresentation;
        entries.IsItemClickEnabled = false;
        entries.DoubleTapped += async (_, args) =>
        {
            if (EntryAt(args.OriginalSource as DependencyObject) is { } item) await OpenEntryAsync(item);
            args.Handled = true;
        };
        entries.RightTapped += ShowContextMenu;
        entries.KeyDown += async (_, args) =>
        {
            var controlDown = (InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Control) & Windows.UI.Core.CoreVirtualKeyStates.Down) != 0;
            if (controlDown && args.Key == Windows.System.VirtualKey.A) { entries.SelectAll(); args.Handled = true; }
            else if (controlDown && args.Key == Windows.System.VirtualKey.C) { CopySelectedPaths(); args.Handled = true; }
            else if (args.Key == Windows.System.VirtualKey.Enter && entries.SelectedItem is RemoteEntry selected) { await OpenEntryAsync(selected); args.Handled = true; }
            else if (args.Key == Windows.System.VirtualKey.F2) { await RenameAsync(); args.Handled = true; }
            else if (args.Key == Windows.System.VirtualKey.Delete) { await DeleteAsync(); args.Handled = true; }
            else if (args.Key == Windows.System.VirtualKey.F5) { await RunAsync(() => viewModel.RefreshAsync()); args.Handled = true; }
            else if (args.Key == Windows.System.VirtualKey.Application ||
                args.Key == Windows.System.VirtualKey.F10 &&
                (InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift) & Windows.UI.Core.CoreVirtualKeyStates.Down) != 0)
            {
                var contextTarget = entries.SelectedItems.OfType<RemoteEntry>().FirstOrDefault();
                var point = new Point(8, 8);
                if (contextTarget != null && entries.ContainerFromItem(contextTarget) is UIElement container)
                {
                    try { point = container.TransformToVisual(entries).TransformPoint(new Point(4, Math.Max(0, container.RenderSize.Height / 2))); }
                    catch { /* use the safe list origin when the item is virtualized */ }
                }
                ShowContextMenu(contextTarget, point);
                args.Handled = true;
            }
        };
        entries.SelectionChanged += (_, _) => viewModel.Selected = entries.SelectedItem as RemoteEntry;
        viewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(SftpBrowserViewModel.CurrentPath))
            {
                path.Text = viewModel.CurrentPath;
                UpdateBreadcrumbs();
                UpdateHistoryControls();
            }
            if (args.PropertyName == nameof(SftpBrowserViewModel.Status)) status.Text = viewModel.Status;
            if (args.PropertyName == nameof(SftpBrowserViewModel.IsBusy))
            {
                UpdateHistoryControls();
                if (!viewModel.IsBusy) ScheduleFollow();
            }
        };
        UpdateHistoryControls();

        entries.SelectionMode = ListViewSelectionMode.Extended;
        entries.AllowDrop = true;
        entries.DragEnter += (_, args) => UpdateDropTarget(args);
        entries.DragOver += (_, args) => UpdateDropTarget(args);
        entries.DragLeave += EntriesDragLeave;
        entries.Drop += async (_, args) => await DropFilesAsync(args);
        hidden.Header = null;
        hidden.OffContent = hidden.OnContent = text("sftp.showHidden");
        hidden.MinWidth = 0;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(hidden, text("sftp.showHidden"));
        void UpdateView() { if (!configuring) viewModel.ConfigureView(hidden.IsOn, sortField, sortDescending); }
        hidden.Toggled += (_, _) => UpdateView();
        Configure(preferences);
        void Icon(Button button, string glyph)
        {
            var label = button.Content?.ToString() ?? "";
            ToolTipService.SetToolTip(button, label);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, label);
            button.Content = new FontIcon { Glyph = glyph, FontSize = 14 };
            button.Width = 28; button.Height = 28; button.Padding = new Thickness(0);
            button.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            button.BorderThickness = new Thickness(0);
        }
        Icon(back, "\uE72B"); Icon(forward, "\uE72A"); Icon(up, "\uE74A"); Icon(refresh, "\uE72C");
        Icon(upload, "\uE898"); Icon(uploadFolder, "\uE8B7"); Icon(download, "\uE896");
        Icon(newFolder, "\uE8F4"); Icon(newFile, "\uE8A5"); Icon(rename, "\uE8AC"); Icon(chmod, "\uE72E"); Icon(delete, "\uE74D");
        var navigation = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Children = { back, forward, up, refresh } };
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Children = { upload, uploadFolder, download, newFolder, newFile, rename, chmod, delete } };
        var toolbar = new Grid { Padding = new Thickness(8, 4, 8, 4), ColumnSpacing = 4, RowSpacing = 4 };
        toolbar.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        toolbar.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        toolbar.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        toolbar.RowDefinitions.Add(new() { Height = GridLength.Auto }); toolbar.RowDefinitions.Add(new() { Height = GridLength.Auto });
        toolbar.Children.Add(navigation); toolbar.Children.Add(path); toolbar.Children.Add(actions);
        Grid.SetColumn(path, 1); Grid.SetColumn(actions, 2);
        toolbar.SizeChanged += (_, _) =>
        {
            var narrow = toolbar.ActualWidth < 640;
            Grid.SetColumn(actions, narrow ? 0 : 2); Grid.SetRow(actions, narrow ? 1 : 0); Grid.SetColumnSpan(actions, narrow ? 3 : 1);
            Grid.SetColumnSpan(path, narrow ? 2 : 1);
        };
        UpdateBreadcrumbs();
        var breadcrumbScroller = new ScrollViewer { Content = breadcrumbs, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Enabled, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollMode = ScrollMode.Disabled };
        var breadcrumbRow = new Grid { Padding = new Thickness(8, 0, 8, 0), ColumnSpacing = 8 };
        breadcrumbRow.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        breadcrumbRow.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        breadcrumbRow.Children.Add(breadcrumbScroller); breadcrumbRow.Children.Add(hidden); Grid.SetColumn(hidden, 1);
        var header = new Grid { MinWidth = 1000, ColumnSpacing = 12, Padding = new Thickness(8, 4, 8, 4), Background = Application.Current.Resources.TryGetValue("SubtleFillColorSecondaryBrush", out var headerBrush) && headerBrush is Brush fill ? fill : null };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2.4, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(.7, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(.9, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(.9, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(.9, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(260) });
        AddSortableHeader(header, "name", text("sftp.colName"), 0);
        AddHeaderCell(header, text("sftp.colType"), 1);
        AddSortableHeader(header, "size", text("sftp.colSize"), 2, true);
        AddHeaderCell(header, text("sftp.colMode"), 3, true);
        AddHeaderCell(header, text("sftp.colOwner"), 4, true);
        AddHeaderCell(header, text("sftp.colGroup"), 5, true);
        AddSortableHeader(header, "modified", text("sftp.colMtime"), 6);
        UpdateSortHeaderButtons();
        var headerScroller = new ScrollViewer { Content = header, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Enabled, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollMode = ScrollMode.Disabled };
        var entriesScroller = new ScrollViewer { Content = entries, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Enabled, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollMode = ScrollMode.Disabled };
        headerScroller.ViewChanged += (_, _) =>
        {
            if (Math.Abs(entriesScroller.HorizontalOffset - headerScroller.HorizontalOffset) > 1)
                entriesScroller.ChangeView(headerScroller.HorizontalOffset, null, null, true);
        };
        entriesScroller.ViewChanged += (_, _) =>
        {
            if (Math.Abs(headerScroller.HorizontalOffset - entriesScroller.HorizontalOffset) > 1)
                headerScroller.ChangeView(entriesScroller.HorizontalOffset, null, null, true);
        };
        dropHint = new TextBlock { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, FontSize = 18, Margin = new Thickness(24) };
        dropOverlay = new Border
        {
            Visibility = Visibility.Collapsed,
            IsHitTestVisible = false,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            Margin = new Thickness(8),
            Padding = new Thickness(12),
            BorderThickness = new Thickness(2),
            CornerRadius = OpenFinalShell.App.NativeSceneStyle.CornerRadius("OverlayCornerRadius", 8),
            Background = Application.Current.Resources.TryGetValue("CardBackgroundFillColorDefaultBrush", out var cardBrush) && cardBrush is Brush card ? card : new SolidColorBrush(Windows.UI.Color.FromArgb(242, 36, 36, 36)),
            BorderBrush = Application.Current.Resources.TryGetValue("AccentFillColorDefaultBrush", out var accentBrush) && accentBrush is Brush accent ? accent : new SolidColorBrush(Windows.UI.Color.FromArgb(255, 0, 120, 212)),
            Child = dropHint
        };
        var entriesHost = new Grid { Children = { entriesScroller, dropOverlay } };
        Content = new Grid
        {
            RowDefinitions = { new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }, new RowDefinition { Height = GridLength.Auto } },
            Children = { toolbar, breadcrumbRow, headerScroller, entriesHost, status }
        };
        Grid.SetRow(breadcrumbRow, 1);
        Grid.SetRow(headerScroller, 2); Grid.SetRow(entriesHost, 3); Grid.SetRow(status, 4);
        Loaded += async (_, _) =>
        {
            if (initialized) return;
            initialized = true;
            var queuedFollow = pendingFollowPath;
            var initial = "/";
            try { homeDirectory = initial = await session.RealPathAsync(".", CancellationToken.None); }
            catch { /* Some SFTP servers reject REALPATH; root remains a safe fallback. */ }
            await NavigateAsync(initial);
            pendingFollowPath ??= queuedFollow;
            ScheduleFollow();
        };
    }

    private void UpdateEntryPresentation(ListViewBase sender, ContainerContentChangingEventArgs args)
    {
        if (args.InRecycleQueue || args.Item is not RemoteEntry entry) return;
        var modified = SftpTimestamp.Format(entry.Modified, preferences.Language);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(args.ItemContainer,
            $"{entry.Name} · {entry.Type} · {entry.Size} · {modified} · {entry.Mode} · {entry.OwnerId} · {entry.GroupId}");
        if (args.ItemContainer.ContentTemplateRoot is Grid row && row.Children.Count > 6 && row.Children[6] is TextBlock label)
        {
            label.Text = modified;
            ToolTipService.SetToolTip(label, modified);
        }
        else if (args.Phase == 0) args.RegisterUpdateCallback(1, UpdateEntryPresentation);
    }

    public void Configure(NativeSettings settings)
    {
        var previouslyFollowing = preferences.Get("sftp.followTerminalCd", true);
        preferences = settings; configuring = true; hidden.IsOn = settings.SftpShowHiddenFiles; configuring = false;
        fastDeleteLocalization.SetLanguage(settings.Language);
        viewModel.ConfigureView(hidden.IsOn, sortField, sortDescending);
        if (!preferences.Get("sftp.followTerminalCd", true)) { pendingFollowPath = null; followCancellation?.Cancel(); }
        else { if (!previouslyFollowing) pendingFollowPath = reportedDirectory; ScheduleFollow(); }
    }

    public void FollowRemoteDirectory(string directory)
    {
        if (disposed) return;
        shellCommandVersion++;
        reportedDirectory = shellDirectory = SftpBrowserViewModel.NormalizePath(directory);
        if (!preferences.Get("sftp.followTerminalCd", true)) return;
        pendingFollowPath = shellDirectory;
        followCancellation?.Cancel();
        ScheduleFollow();
    }

    public void FollowShellCommand(string command)
    {
        var target = NativeShellPathSync.ParseCdTarget(command);
        if (target == null) return;
        var commandVersion = ++shellCommandVersion;
        if (target == "~" || target.StartsWith("~/", StringComparison.Ordinal))
        {
            _ = FollowHomeCommandAsync(target, commandVersion);
            return;
        }
        var cwd = pendingFollowPath ?? followingDirectory ?? shellDirectory ?? viewModel.CurrentPath;
        var resolved = NativeShellPathSync.ApplyCd(cwd, target, homeDirectory);
        if (resolved != null) FollowShellDirectory(resolved);
    }

    private void FollowShellDirectory(string directory)
    {
        if (disposed) return;
        shellDirectory = SftpBrowserViewModel.NormalizePath(directory);
        if (!preferences.Get("sftp.followTerminalCd", true)) return;
        pendingFollowPath = shellDirectory;
        followCancellation?.Cancel();
        ScheduleFollow();
    }

    private async Task FollowHomeCommandAsync(string target, long commandVersion)
    {
        try
        {
            homeDirectory ??= await session.RealPathAsync(".", CancellationToken.None);
            if (commandVersion != shellCommandVersion) return;
            var cwd = pendingFollowPath ?? followingDirectory ?? shellDirectory ?? viewModel.CurrentPath;
            var resolved = NativeShellPathSync.ApplyCd(cwd, target, homeDirectory);
            if (resolved != null) FollowShellDirectory(resolved);
        }
        catch (Exception error) { System.Diagnostics.Debug.WriteLine($"Could not resolve shell home directory: {error.Message}"); }
    }
    public void SetFollowActive(bool active)
    {
        followActive = active;
        if (!active) { if (followCancellation != null) pendingFollowPath ??= followingDirectory; followCancellation?.Cancel(); }
        else ScheduleFollow();
    }
    public void ResetRemoteDirectory()
    {
        reportedDirectory = pendingFollowPath = shellDirectory = null; shellCommandVersion++; followCancellation?.Cancel();
    }
    private void ScheduleFollow()
    {
        if (disposed || !followActive || !initialized || pendingFollowPath == null || !preferences.Get("sftp.followTerminalCd", true)) return;
        _ = FollowPendingDirectoryAsync();
    }
    private async Task FollowPendingDirectoryAsync()
    {
        if (disposed || !followActive || pendingFollowPath is not { } target || !preferences.Get("sftp.followTerminalCd", true)) return;
        if (session.Snapshot.State != NativeSessionState.Ready) { pendingFollowPath = null; return; }
        pendingFollowPath = null;
        if (target == viewModel.CurrentPath) { path.Text = viewModel.CurrentPath; return; }
        path.Text = target;
        var cancellation = new CancellationTokenSource(); followCancellation = cancellation;
        followingDirectory = target;
        try
        {
            // The list request validates the directory itself. Avoid serial
            // REALPATH and stat calls before listing, so terminal cd reaches
            // the visible file list with one SFTP round trip.
            await viewModel.NavigateAsync(target, cancellation.Token);
            navigationHistory.Push(viewModel.CurrentPath);
            UpdateHistoryControls();
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (!disposed && followActive && !cancellation.IsCancellationRequested && ReferenceEquals(followCancellation, cancellation))
            {
                path.Text = viewModel.CurrentPath;
                status.Text = text("sftp.followFailed").Replace("{{path}}", target, StringComparison.Ordinal).Replace("{{reason}}", error.Message, StringComparison.Ordinal);
            }
        }
        finally
        {
            if (ReferenceEquals(followCancellation, cancellation)) { followCancellation = null; followingDirectory = null; }
            cancellation.Dispose();
            ScheduleFollow();
        }
    }
    public void Dispose()
    {
        disposed = true; pendingFollowPath = null; shellCommandVersion++; followCancellation?.Cancel();
    }
    private static RemoteEntry? EntryAt(DependencyObject? source)
    {
        while (source != null) { if (source is FrameworkElement { DataContext: RemoteEntry entry }) return entry; source = VisualTreeHelper.GetParent(source); }
        return null;
    }

    private void UpdateBreadcrumbs()
    {
        breadcrumbs.Children.Clear();
        var current = SftpBrowserViewModel.NormalizePath(viewModel.CurrentPath);
        var segments = current.Split('/', StringSplitOptions.RemoveEmptyEntries);
        AddBreadcrumb("/", "/", segments.Length == 0);
        var accumulated = string.Empty;
        foreach (var segment in segments)
        {
            accumulated += "/" + segment;
            breadcrumbs.Children.Add(new TextBlock { Text = "/", Opacity = .65, VerticalAlignment = VerticalAlignment.Center });
            AddBreadcrumb(segment, accumulated, string.Equals(accumulated, current, StringComparison.Ordinal));
        }
    }

    private void AddSortableHeader(Grid header, string field, string label, int column, bool right = false)
    {
        var button = new Button
        {
            Padding = new Thickness(4, 2, 4, 2),
            BorderThickness = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = right ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            MinWidth = 0
        };
        button.Click += (_, _) =>
        {
            if (sortSelected && string.Equals(sortField, field, StringComparison.Ordinal)) sortDescending = !sortDescending;
            else { sortField = field; sortDescending = false; sortSelected = true; }
            viewModel.ConfigureView(hidden.IsOn, sortField, sortDescending);
            UpdateSortHeaderButtons();
        };
        sortHeaders[field] = (button, label);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, label);
        Grid.SetColumn(button, column);
        header.Children.Add(button);
    }

    private void UpdateSortHeaderButtons()
    {
        foreach (var (field, (button, label)) in sortHeaders)
        {
            var active = sortSelected && string.Equals(sortField, field, StringComparison.Ordinal);
            var indicator = active ? sortDescending ? " ↓" : " ↑" : string.Empty;
            button.Content = label + indicator;
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, label + indicator);
        }
    }

    private static void AddHeaderCell(Grid header, string label, int column, bool right = false)
    {
        var cell = new TextBlock { Text = label, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Opacity = .78, TextTrimming = TextTrimming.CharacterEllipsis, HorizontalAlignment = right ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        Grid.SetColumn(cell, column); header.Children.Add(cell);
    }

    private void AddBreadcrumb(string label, string target, bool current)
    {
        var button = new Button
        {
            Content = label,
            Padding = new Thickness(6, 2, 6, 2),
            IsEnabled = !current,
            Tag = target
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, target == "/" ? "/" : target);
        button.Click += async (_, _) => await NavigateAsync((string)button.Tag);
        breadcrumbs.Children.Add(button);
    }
    private async Task OpenEntryAsync(RemoteEntry item, bool forceEditor = false)
    {
        if (item.IsDirectory) await NavigateAsync(item.Path);
        else if (item.Type is NativeRemoteEntryType.File or NativeRemoteEntryType.Symlink)
        {
            if (forceEditor || preferences.SftpDoubleClickAction == "open") openFile(item.Path);
            else await DownloadAsync(new[] { item });
        }
    }

    private void CopySelectedPaths()
    {
        var selected = entries.SelectedItems.OfType<RemoteEntry>().ToArray();
        if (selected.Length == 0) return;
        var data = new DataPackage();
        data.SetText(string.Join(Environment.NewLine, selected.Select(entry => entry.Path)));
        Clipboard.SetContent(data);
        status.Text = text("sftp.copyPath");
    }
    private void ShowContextMenu(object sender, RightTappedRoutedEventArgs args)
    {
        args.Handled = true;
        var target = EntryAt(args.OriginalSource as DependencyObject);
        if (target != null && !entries.SelectedItems.Contains(target)) { entries.SelectedItems.Clear(); entries.SelectedItems.Add(target); }
        ShowContextMenu(target, args.GetPosition(entries));
    }

    private void ShowContextMenu(RemoteEntry? target, Point position)
    {
        // Capture the selection now; async menu actions cannot drift to another row.
        var selected = entries.SelectedItems.OfType<RemoteEntry>().ToArray();
        var uploadDirectory = target?.IsDirectory == true ? target.Path : viewModel.CurrentPath;
        var canWrite = !disposed && !viewModel.IsBusy && session.Snapshot.State == NativeSessionState.Ready;
        var menu = new MenuFlyout();
        void Add(string key, Func<Task> action, bool enabled = true)
        {
            var item = new MenuFlyoutItem { Text = text(key), IsEnabled = enabled };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(item, item.Text);
            item.Click += async (_, _) => { entries.SelectedItems.Clear(); foreach (var entry in selected) entries.SelectedItems.Add(entry); await RunAsync(action); }; menu.Items.Add(item);
        }
        if (target != null)
        {
            Add("sftp.open", () => OpenEntryAsync(target, true));
            Add("sftp.download", () => DownloadAsync());
            Add("native.sftp.upload", () => UploadAsync(uploadDirectory), canWrite);
            Add("native.sftp.uploadFolder", () => UploadFolderAsync(uploadDirectory), canWrite);
            Add("native.sftp.rename", RenameAsync, selected.Length == 1);
            Add("sftp.permissions", ChmodAsync);
            Add("sftp.copyPath", () => { CopySelectedPaths(); return Task.CompletedTask; });
            Add("native.sftp.delete", DeleteAsync);
            var canFastDelete = preferences.Get("sftp.fastDelete", true) && selected.Length > 0 &&
                selected.All(entry => entry.IsDirectory && !entry.IsSymbolicLink);
            if (canFastDelete) Add("sftp.fastDelete", FastDeleteAsync, canFastDelete);
        }
        else
        {
            Add("sftp.refresh", () => viewModel.RefreshAsync());
            Add("native.sftp.upload", () => UploadAsync(uploadDirectory), canWrite);
            Add("native.sftp.uploadFolder", () => UploadFolderAsync(uploadDirectory), canWrite);
            Add("sftp.newFile", CreateFileAsync, canWrite);
            Add("sftp.newFolder", CreateFolderAsync, canWrite);
        }
        menu.ShowAt(entries, position);
    }

    private async Task NavigateAsync(string target)
    {
        pendingFollowPath = null; followCancellation?.Cancel();
        try
        {
            var resolved = await session.RealPathAsync(target, CancellationToken.None);
            await viewModel.NavigateAsync(resolved);
            navigationHistory.Push(resolved);
            UpdateHistoryControls();
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task NavigateHistoryAsync(int direction)
    {
        if (viewModel.IsBusy) return;
        var target = direction < 0 ? navigationHistory.BackTarget : navigationHistory.ForwardTarget;
        if (target == null) return;
        pendingFollowPath = null; followCancellation?.Cancel();
        try
        {
            var resolved = await session.RealPathAsync(target, CancellationToken.None);
            await viewModel.NavigateAsync(resolved);
            var committed = direction < 0 ? navigationHistory.CommitBack(resolved) : navigationHistory.CommitForward(resolved);
            if (!committed)
            {
                // A server may canonicalize the path differently. Preserve the
                // current directory while avoiding a corrupt history cursor.
                navigationHistory.Push(resolved);
            }
            UpdateHistoryControls();
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void UpdateHistoryControls()
    {
        back.IsEnabled = !viewModel.IsBusy && navigationHistory.CanGoBack;
        forward.IsEnabled = !viewModel.IsBusy && navigationHistory.CanGoForward;
    }

    private async Task RunAsync(Func<Task> action)
    {
        try { await action(); }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task UploadAsync(string? targetDirectory = null)
    {
        var picker = new FileOpenPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, windowHandle());
        var files = await picker.PickMultipleFilesAsync(); if (files.Count == 0) return;
        try
        {
            var uploads = files.Select(file => new LocalUploadItem(file.Path, file.Name, false)).ToArray();
            var result = await EnqueueUploadBatchAsync(uploads, targetDirectory ?? viewModel.CurrentPath);
            if (!result.Canceled) status.Text = FormatUploadStatus(result);
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task<UploadBatchResult> EnqueueUploadBatchAsync(IReadOnlyList<LocalUploadItem> uploads, string targetDirectory)
    {
        if (uploads.Count == 0) return new(0, 0);
        IReadOnlyList<RemoteEntry> existing;
        try { existing = await session.ListAsync(targetDirectory, CancellationToken.None); }
        catch (Exception error) { throw new IOException(text("sftp.uploadProbeFailed"), error); }
        var remoteEntries = existing.Select(item => new NativeUploadRemoteEntry(
            item.Name, item.IsDirectory, item.IsSymbolicLink, item.Size)).ToArray();
        var candidates = uploads.Select(item => new NativeUploadCandidate(item.Name, item.IsDirectory)).ToArray();
        var policy = preferences.Get("sftp.conflictPolicy", "ask");
        if (policy == "resume") policy = "overwrite";
        var plan = NativeUploadConflictPlanner.Plan(candidates, remoteEntries, policy);
        var action = policy;
        if (plan.RequiresDecision)
        {
            var decision = await ChooseUploadConflictActionAsync(plan.Conflicts);
            if (decision == null) return new(0, 0, Canceled: true);
            action = decision;
            plan = NativeUploadConflictPlanner.Plan(candidates, remoteEntries, action);
        }
        else if (policy == "ask") action = "overwrite";
        if (action != policy) plan = NativeUploadConflictPlanner.Plan(candidates, remoteEntries, action);

        var queued = 0;
        var skipped = 0;
        foreach (var item in plan.Items)
        {
            var upload = uploads.Single(candidate => candidate.Name == item.Candidate.Name);
            var target = SftpBrowserViewModel.Combine(targetDirectory, item.RemoteName);
            if (item.Skipped)
            {
                transfers.EnqueueSkipped(session.SessionId, NativeTransferDirection.Upload, upload.Path, target,
                    text("err.sftp.skippedExisting"), upload.IsDirectory ? null : new FileInfo(upload.Path).Length);
                skipped++;
                continue;
            }
            if (upload.IsDirectory)
            {
                var treeResult = await EnqueueUploadTreeAsync(upload.Path, upload.Name, target, action);
                queued += treeResult.Queued;
                skipped += treeResult.Skipped;
            }
            else
            {
                var stagedPath = await StageLocalFileAsync(upload.Path);
                transfers.EnqueueUpload(session.SessionId, stagedPath, target, item.Overwrite, cleanupSource: true);
                queued++;
            }
        }
        return new(queued, skipped);
    }

    private async Task<string?> ChooseUploadConflictActionAsync(IReadOnlyList<NativeUploadRemoteEntry> conflicts)
    {
        var title = text("sftp.conflictTitle").Replace("{{count}}", conflicts.Count.ToString(), StringComparison.Ordinal);
        var content = new StackPanel { Spacing = 10 };
        content.Children.Add(new TextBlock { Text = text("sftp.conflictDesc").Replace("**", string.Empty, StringComparison.Ordinal), TextWrapping = TextWrapping.Wrap });
        var list = new StackPanel { Spacing = 4 };
        foreach (var conflict in conflicts.Take(10))
        {
            list.Children.Add(new TextBlock
            {
                Text = conflict.Name + (conflict.IsDirectory ? $" · {text("sftp.conflictIsDir")}" : string.Empty),
                TextTrimming = TextTrimming.CharacterEllipsis
            });
        }
        if (conflicts.Count > 10)
            list.Children.Add(new TextBlock { Text = text("sftp.conflictMore").Replace("{{count}}", (conflicts.Count - 10).ToString(), StringComparison.Ordinal) });
        content.Children.Add(new ScrollViewer { MaxHeight = 220, Content = list });
        content.Children.Add(new TextBlock { Text = text("sftp.conflictOverwriteHint"), TextWrapping = TextWrapping.Wrap });
        content.Children.Add(new TextBlock { Text = text("sftp.conflictSkipHint"), TextWrapping = TextWrapping.Wrap });
        content.Children.Add(new TextBlock { Text = text("sftp.conflictRenameHint"), TextWrapping = TextWrapping.Wrap });

        string? selectedAction = null;
        ContentDialog? dialog = null;
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        void AddAction(string labelKey, string action)
        {
            var button = new Button { Content = text(labelKey) };
            button.Click += (_, _) => { selectedAction = action; dialog?.Hide(); };
            actions.Children.Add(button);
        }
        AddAction("sftp.conflictSkipAll", "skip");
        AddAction("sftp.conflictRenameAll", "rename");
        AddAction("sftp.conflictOverwriteAll", "overwrite");
        content.Children.Add(actions);
        dialog = new ContentDialog
        {
            Title = title,
            Content = content,
            CloseButtonText = text("native.common.cancel"),
            XamlRoot = XamlRoot
        };
        var result = await dialog.ShowGatedAsync();
        return result == ContentDialogResult.None ? selectedAction : null;
    }

    private string FormatUploadStatus(UploadBatchResult result)
    {
        var summary = $"{result.Queued} · {uploadLabel}";
        return result.Skipped == 0 ? summary : $"{summary} · {text("transfer.stateSkipped")}: {result.Skipped}";
    }

    private void UpdateDropTarget(DragEventArgs args)
    {
        if (!args.DataView.Contains(StandardDataFormats.StorageItems)) return;
        args.AcceptedOperation = DataPackageOperation.None;
        args.Handled = true;
        if (disposed || viewModel.IsBusy) { SetDropOverlay(false); return; }
        var targetEntry = EntryAt(args.OriginalSource as DependencyObject);
        var resolved = NativeSftpDropTarget.Resolve(true, session.Snapshot.State == NativeSessionState.Ready, viewModel.IsBusy, viewModel.CurrentPath, targetEntry);
        if (!resolved.Accepted) { SetDropOverlay(false); return; }
        dropHint.Text = text("sftp.dropToUpload").Replace("{{dir}}", resolved.Directory, StringComparison.Ordinal);
        SetDropOverlay(true);
        args.AcceptedOperation = DataPackageOperation.Copy;
    }

    private void SetDropOverlay(bool visible)
    {
        if (dropOverlayShown == visible) return;
        dropOverlayShown = visible;
        var version = Interlocked.Increment(ref dropMotionVersion);
        dropOverlay.IsHitTestVisible = false;
        if (visible)
        {
            dropOverlay.Visibility = Visibility.Visible;
            UiTaskRunner.Run(() => NativeUiMotion.FadeInAsync(dropOverlay));
            return;
        }
        UiTaskRunner.Run(async () =>
        {
            await NativeUiMotion.AnimateOutAsync(dropOverlay, null, NativeMotionKind.Fade);
            if (version == Volatile.Read(ref dropMotionVersion)) dropOverlay.Visibility = Visibility.Collapsed;
        });
    }

    private void EntriesDragLeave(object sender, DragEventArgs args)
    {
        var position = args.GetPosition(entries);
        if (position.X < 0 || position.Y < 0 || position.X > entries.ActualWidth || position.Y > entries.ActualHeight)
            SetDropOverlay(false);
    }

    private async Task DropFilesAsync(DragEventArgs args)
    {
        args.Handled = true;
        SetDropOverlay(false);
        if (!args.DataView.Contains(StandardDataFormats.StorageItems)) return;
        var targetEntry = EntryAt(args.OriginalSource as DependencyObject);
        var resolved = NativeSftpDropTarget.Resolve(true, session.Snapshot.State == NativeSessionState.Ready, viewModel.IsBusy, viewModel.CurrentPath, targetEntry);
        if (!resolved.Accepted) return;
        var targetDirectory = resolved.Directory;
        try
        {
            var items = await args.DataView.GetStorageItemsAsync();
            var uploads = new List<LocalUploadItem>();
            foreach (var item in items)
            {
                if (item is StorageFile file) uploads.Add(new(file.Path, file.Name, false));
                else if (item is StorageFolder folder) uploads.Add(new(folder.Path, folder.Name, true));
            }
            var result = await EnqueueUploadBatchAsync(uploads, targetDirectory);
            if (!result.Canceled) status.Text = FormatUploadStatus(result);
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task DownloadAsync(IReadOnlyList<RemoteEntry>? selectedOverride = null)
    {
        var selected = (selectedOverride ?? entries.SelectedItems.OfType<RemoteEntry>().ToArray()).ToArray();
        if (selected.Length == 0) return;
        var configuredDirectory = preferences.Get("sftp.downloadDir", "").Trim();
        if (configuredDirectory.Length > 0)
        {
            try
            {
                if (!Path.IsPathFullyQualified(configuredDirectory)) throw new IOException(text("native.validationFailed"));
                EnsureDownloadTargetIsNotLink(configuredDirectory);
                Directory.CreateDirectory(configuredDirectory);
                var destinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var item in selected)
                {
                    var destination = GetSafeLocalPath(configuredDirectory, item.Name);
                    if (!destinations.Add(destination)) throw new IOException(text("native.validationFailed"));
                    if (item.IsDirectory) await EnqueueDownloadTreeAsync(item, configuredDirectory, destination);
                    else { EnsureDownloadTargetIsNotLink(destination); EnsureDownloadFileTarget(destination); transfers.EnqueueDownload(session.SessionId, item.Path, destination); }
                }
                status.Text = $"{destinations.Count} · {downloadLabel}";
            }
            catch (Exception error) { status.Text = error.Message; }
            return;
        }
        var folderPicker = new FolderPicker(); folderPicker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(folderPicker, windowHandle());
        var target = await folderPicker.PickSingleFolderAsync(); if (target == null) return;
        try
        {
            var destinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in selected)
            {
                var destination = GetSafeLocalPath(target.Path, item.Name);
                if (!destinations.Add(destination)) throw new IOException("Selected remote names collide on the case-insensitive local filesystem.");
                if (item.IsDirectory) await EnqueueDownloadTreeAsync(item, target.Path, destination);
                else { EnsureDownloadTargetIsNotLink(destination); EnsureDownloadFileTarget(destination); transfers.EnqueueDownload(session.SessionId, item.Path, destination); }
            }
            status.Text = $"{selected.Length} · {downloadLabel}";
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private static void EnsureDownloadFileTarget(string target)
    {
        if (Directory.Exists(target)) throw new IOException("A directory already exists at the selected download file path.");
    }

    private async Task EnqueueDownloadTreeAsync(RemoteEntry item, string localParent, string? knownLocalRoot = null, string conflictPolicy = "ask")
    {
        var localRoot = knownLocalRoot ?? GetSafeLocalPath(localParent, item.Name);
        EnsureDownloadTargetIsNotLink(localRoot);
        if (preferences.Get("sftp.packedTransfer", false))
            status.Text = $"{item.Name} · {text("transfer.phaseScanning")}";
        var packed = await transfers.TryEnqueuePackedDownloadAsync(session.SessionId, item.Path, localRoot, conflictPolicy);
        if (packed.TaskId != null)
        {
            status.Text = $"{item.Name} · {downloadLabel}";
            return;
        }
        Directory.CreateDirectory(localRoot);
        var files = new List<(string RemotePath, string LocalPath, long Bytes)>();
        await CollectDownloadTreeAsync(item, localRoot, localRoot, files, 0, [0]);
        if (files.Select(file => file.LocalPath).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Count)
            throw new IOException("Remote filenames collide on the case-insensitive local filesystem.");
        var group = transfers.CreateGroup(session.SessionId, NativeTransferDirection.Download, item.Name, localRoot,
            files.Sum(file => file.Bytes), files.Count, packed.Notice);
        foreach (var file in files)
        {
            EnsureDownloadTargetIsNotLink(file.LocalPath);
            transfers.EnqueueDownload(session.SessionId, file.RemotePath, file.LocalPath, group);
        }
    }

    private async Task CollectDownloadTreeAsync(RemoteEntry item, string localRoot, string localParent, List<(string RemotePath, string LocalPath, long Bytes)> files, int depth, int[] visited)
    {
        if (depth > MaximumDirectoryDepth) throw new IOException($"Directory transfers are limited to {MaximumDirectoryDepth} levels.");
        if (++visited[0] > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} entries.");
        if (files.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
        if (item.IsSymbolicLink) throw new IOException("Directory transfers do not follow remote symbolic links.");
        if (item.IsDirectory)
        {
            var children = await session.ListAsync(item.Path, CancellationToken.None);
            if (children.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} entries.");
            foreach (var child in children)
            {
                var childPath = GetSafeLocalPath(localParent, child.Name, localRoot);
                if (child.IsSymbolicLink) throw new IOException("Directory transfers do not follow remote symbolic links.");
                if (child.IsDirectory)
                {
                    EnsureDownloadTargetIsNotLink(childPath);
                    Directory.CreateDirectory(childPath);
                    if (files.Count >= MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
                    await CollectDownloadTreeAsync(child, localRoot, childPath, files, depth + 1, visited);
                }
                else
                {
                    if (files.Count >= MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
                    files.Add((child.Path, childPath, Math.Max(0, child.Size)));
                }
            }
            return;
        }
        files.Add((item.Path, GetSafeLocalPath(localParent, item.Name, localRoot), Math.Max(0, item.Size)));
    }

    private async Task UploadFolderAsync(string? targetDirectory = null)
    {
        var picker = new FolderPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, windowHandle());
        var folder = await picker.PickSingleFolderAsync(); if (folder == null) return;
        try
        {
            var result = await EnqueueUploadBatchAsync(new[] { new LocalUploadItem(folder.Path, folder.Name, true) }, targetDirectory ?? viewModel.CurrentPath);
            if (!result.Canceled) status.Text = FormatUploadStatus(result);
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void CollectUploadTreeAsync(string localDirectory, string remoteDirectory, List<(string LocalPath, string RemotePath)> files, List<string> remoteDirectories, int depth, int[] visited)
    {
        if (depth > MaximumDirectoryDepth) throw new IOException($"Directory transfers are limited to {MaximumDirectoryDepth} levels.");
        if (++visited[0] > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} entries.");
        foreach (var child in Directory.EnumerateDirectories(localDirectory))
        {
            if ((File.GetAttributes(child) & System.IO.FileAttributes.ReparsePoint) != 0) continue;
            var remoteChild = SftpBrowserViewModel.Combine(remoteDirectory, Path.GetFileName(child));
            remoteDirectories.Add(remoteChild);
            CollectUploadTreeAsync(child, remoteChild, files, remoteDirectories, depth + 1, visited);
            if (files.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
        }
        foreach (var filePath in Directory.EnumerateFiles(localDirectory))
        {
            if ((File.GetAttributes(filePath) & System.IO.FileAttributes.ReparsePoint) != 0) continue;
            files.Add((filePath, SftpBrowserViewModel.Combine(remoteDirectory, Path.GetFileName(filePath))));
            if (files.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
        }
    }

    private async Task<UploadBatchResult> EnqueueUploadTreeAsync(string localDirectory, string displayName, string remoteDirectory, string action)
    {
        var files = new List<(string LocalPath, string RemotePath)>();
        var remoteDirectories = new List<string> { remoteDirectory };
        CollectUploadTreeAsync(localDirectory, remoteDirectory, files, remoteDirectories, 0, [0]);
        var plannedFiles = new List<(string LocalPath, string RemotePath, bool Overwrite)>();
        var skippedFiles = new List<(string LocalPath, string RemotePath, long Bytes)>();
        var skipped = 0;
        foreach (var directoryGroup in files.GroupBy(file => RemoteParent(file.RemotePath), StringComparer.Ordinal))
        {
            var remoteDirectoryEntry = await session.TryGetAsync(directoryGroup.Key, CancellationToken.None);
            if (remoteDirectoryEntry is { IsDirectory: false } || remoteDirectoryEntry is { IsSymbolicLink: true })
                throw new IOException($"Remote upload parent is not a safe directory: {directoryGroup.Key}");
            var entriesInDirectory = remoteDirectoryEntry == null
                ? Array.Empty<RemoteEntry>()
                : await session.ListAsync(directoryGroup.Key, CancellationToken.None);
            var candidatesInDirectory = directoryGroup.Select(file => new NativeUploadCandidate(Path.GetFileName(file.RemotePath), false)).ToArray();
            var remoteInDirectory = entriesInDirectory.Select(item => new NativeUploadRemoteEntry(item.Name, item.IsDirectory, item.IsSymbolicLink, item.Size)).ToArray();
            var filePlan = NativeUploadConflictPlanner.Plan(candidatesInDirectory, remoteInDirectory, action);
            for (var index = 0; index < filePlan.Items.Count; index++)
            {
                var planned = filePlan.Items[index];
                var source = directoryGroup.ElementAt(index);
                if (planned.Skipped)
                {
                    skippedFiles.Add((source.LocalPath, source.RemotePath, new FileInfo(source.LocalPath).Length));
                    skipped++;
                    continue;
                }
                plannedFiles.Add((source.LocalPath, SftpBrowserViewModel.Combine(directoryGroup.Key, planned.RemoteName), planned.Overwrite));
            }
        }
        var staged = new List<(string TemporaryPath, string RemotePath, bool Overwrite)>();
        try
        {
            foreach (var directory in remoteDirectories) await EnsureRemoteDirectoryAsync(directory);
            foreach (var filePath in plannedFiles)
            {
                staged.Add((await StageLocalFileAsync(filePath.LocalPath), filePath.RemotePath, filePath.Overwrite));
            }
            var group = transfers.CreateGroup(session.SessionId, NativeTransferDirection.Upload, displayName, remoteDirectory,
                staged.Sum(file => new FileInfo(file.TemporaryPath).Length), staged.Count + skippedFiles.Count);
            foreach (var file in staged)
                transfers.EnqueueUpload(session.SessionId, file.TemporaryPath, file.RemotePath, file.Overwrite, cleanupSource: true, parentId: group);
            foreach (var file in skippedFiles)
                transfers.EnqueueSkipped(session.SessionId, NativeTransferDirection.Upload, file.LocalPath, file.RemotePath,
                    text("err.sftp.skippedExisting"), file.Bytes, group);
            return new(staged.Count, skipped);
        }
        catch
        {
            foreach (var file in staged) { try { File.Delete(file.TemporaryPath); } catch { } }
            throw;
        }
    }

    private static string RemoteParent(string path)
    {
        var index = path.LastIndexOf('/');
        return index <= 0 ? "/" : path[..index];
    }

    private static Task<string> StageLocalFileAsync(string source)
    {
        return Task.Run(() =>
        {
            var directory = Path.Combine(Path.GetTempPath(), "OpenFinalShell.NativeTransfers");
            Directory.CreateDirectory(directory);
            var destination = Path.Combine(directory, Guid.NewGuid().ToString("N"), Path.GetFileName(source));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(source, destination, true);
            return destination;
        });
    }
    private static string GetSafeLocalPath(string parent, string name, string? root = null)
    {
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.Contains('/') || name.Contains('\\'))
            throw new IOException("Remote filename is not a safe local path segment.");
        if (name.EndsWith(' ') || name.EndsWith('.') || IsWindowsDeviceName(name))
            throw new IOException("Remote filename is reserved or ambiguous on Windows.");
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new IOException("Remote filename contains characters that are not valid on this Windows device.");
        var fullPath = Path.GetFullPath(Path.Combine(parent, name));
        var fullRoot = Path.GetFullPath(root ?? parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Remote filename escapes the selected local download folder.");
        return fullPath;
    }

    private static bool IsWindowsDeviceName(string name)
    {
        var stem = Path.GetFileNameWithoutExtension(name).TrimEnd(' ', '.');
        return stem.Equals("CON", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && stem[3] is >= '1' and <= '9');
    }

    private static void EnsureDownloadTargetIsNotLink(string path)
    {
        for (string? current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current))
        {
            System.IO.FileAttributes attributes;
            try { attributes = File.GetAttributes(current); }
            catch (FileNotFoundException) { continue; }
            catch (DirectoryNotFoundException) { continue; }
            if ((attributes & System.IO.FileAttributes.ReparsePoint) != 0)
                throw new IOException("A local symbolic link blocks the selected download path.");
        }
    }

    private async Task EnsureRemoteDirectoryAsync(string path)
    {
        var existing = await session.TryGetAsync(path, CancellationToken.None);
        if (existing != null)
        {
            if (!existing.IsDirectory || existing.IsSymbolicLink) throw new IOException($"Remote target is not a safe directory: {path}");
            return;
        }
        try { await session.CreateDirectoryAsync(path, CancellationToken.None); }
        catch
        {
            var raced = await session.TryGetAsync(path, CancellationToken.None);
            if (raced == null || !raced.IsDirectory) throw;
        }
    }

    private async Task CreateFolderAsync()
    {
        var input = new TextBox { Header = newFolderLabel, PlaceholderText = "folder" };
        var dialog = new ContentDialog { Title = newFolderLabel, Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary || string.IsNullOrWhiteSpace(input.Text)) return;
        await RunAsync(() => viewModel.CreateDirectoryAsync(input.Text));
    }

    private async Task CreateFileAsync()
    {
        var input = new TextBox { Header = text("native.sftp.newFile"), PlaceholderText = "file.txt" };
        var dialog = new ContentDialog { Title = text("native.sftp.newFile"), Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary || string.IsNullOrWhiteSpace(input.Text)) return;
        await RunAsync(() => viewModel.CreateFileAsync(input.Text));
    }

    private async Task RenameAsync()
    {
        if (entries.SelectedItem is not RemoteEntry item) return;
        var input = new TextBox { Header = text("native.sftp.rename"), Text = item.Name };
        var dialog = new ContentDialog { Title = text("native.sftp.rename"), Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        await RunAsync(() => viewModel.RenameAsync(item, input.Text));
    }

    private async Task ChmodAsync()
    {
        var selected = entries.SelectedItems.OfType<RemoteEntry>().ToArray();
        if (selected.Length == 0) return;
        var input = new TextBox { Header = text("native.sftp.chmod"), Text = "644", PlaceholderText = "644" };
        var dialog = new ContentDialog { Title = text("native.sftp.chmod"), Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        short mode;
        try { mode = checked((short)Convert.ToInt32(input.Text, 8)); }
        catch (Exception) { status.Text = text("native.validationFailed"); return; }
        if (mode is < 0 or > 511) { status.Text = text("native.validationFailed"); return; }
        await RunAsync(async () => { foreach (var item in selected) await session.ChmodAsync(item.Path, mode, CancellationToken.None); await viewModel.RefreshAsync(); });
    }

    private async Task FastDeleteAsync()
    {
        if (!preferences.Get("sftp.fastDelete", true)) return;
        var selected = entries.SelectedItems.OfType<RemoteEntry>().ToArray();
        if (selected.Length == 0 || selected.Any(item => !item.IsDirectory || item.IsSymbolicLink)) return;

        NativeFastDeletePreview preview;
        try
        {
            // Re-check the selected remote objects before showing an irreversible action.
            foreach (var item in selected)
            {
                var current = await session.TryGetAsync(item.Path, CancellationToken.None);
                if (current is not { IsDirectory: true, IsSymbolicLink: false })
                    throw new IOException(text("native.validationFailed"));
            }
            preview = NativeFastDelete.Preview(selected.Select(item => item.Path).ToArray(), fastDeleteLocalization);
        }
        catch (Exception error) { status.Text = error.Message; return; }

        var summary = new StackPanel { Spacing = 10 };
        summary.Children.Add(new TextBlock { Text = text("sftp.fastDeleteWarning"), TextWrapping = TextWrapping.Wrap });
        var paths = selected.Take(10).Select(item => item.Path).ToList();
        if (selected.Length > paths.Count)
            paths.Add(text("sftp.fastDeleteMore").Replace("{{count}}", (selected.Length - 10).ToString(), StringComparison.Ordinal));
        summary.Children.Add(new TextBlock { Text = string.Join(Environment.NewLine, paths), TextWrapping = TextWrapping.Wrap });
        summary.Children.Add(new TextBlock { Text = text("sftp.fastDeleteCommandLabel") });
        summary.Children.Add(new TextBox
        {
            Text = preview.Command, IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap,
            FontFamily = new Microsoft.UI.Xaml.Media.FontFamily("Cascadia Mono"), MaxHeight = 170,
        });
        if (preview.Batches > 1)
            summary.Children.Add(new TextBlock { Text = text("sftp.fastDeleteBatches").Replace("{{count}}", preview.Batches.ToString(), StringComparison.Ordinal), TextWrapping = TextWrapping.Wrap });

        var dialog = new ContentDialog
        {
            Title = text("sftp.fastDeleteTitle").Replace("{{count}}", preview.Count.ToString(), StringComparison.Ordinal),
            Content = new ScrollViewer { Content = summary, MaxHeight = 520 },
            PrimaryButtonText = text("sftp.fastDeleteOk"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot
        };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;

        // The confirmation dialog may remain open while another client changes
        // the remote entry. Recheck types after consent and before any command
        // bytes are sent, so the user's approval still refers to directories.
        try
        {
            foreach (var item in selected)
            {
                var current = await session.TryGetAsync(item.Path, CancellationToken.None);
                if (current is not { IsDirectory: true, IsSymbolicLink: false })
                    throw new IOException(text("native.validationFailed"));
            }
        }
        catch (Exception error)
        {
            status.Text = error.Message;
            try { await viewModel.RefreshAsync(); } catch { }
            return;
        }

        status.Text = text("sftp.fastDeleteBatches").Replace("{{count}}", preview.Batches.ToString(), StringComparison.Ordinal);
        NativeFastDeleteResult result;
        try
        {
            result = await NativeFastDelete.ExecuteAsync(
                selected.Select(item => item.Path).ToArray(), fastDeleteLocalization,
                (command, token) => session.ExecuteDetailedAsync(command, NativeFastDelete.CommandTimeout, token));
        }
        catch (Exception error)
        {
            status.Text = text("sftp.fastDeleteUnknown") + " · " + error.Message;
            try { await viewModel.RefreshAsync(); } catch { }
            await ShowFastDeleteAlertAsync(text("sftp.fastDeleteUnknown"), error.Message);
            return;
        }

        string? alertTitle = null;
        var alertContent = new StackPanel { Spacing = 8 };
        if (result.ExitCode is null)
        {
            alertTitle = text("sftp.fastDeleteUnknown");
            AddFastDeleteStderr(alertContent, result.StandardError);
        }
        else if (result.Leftover.Count > 0)
        {
            alertTitle = text("sftp.fastDeletePartial").Replace("{{count}}", result.Leftover.Count.ToString(), StringComparison.Ordinal);
            foreach (var leftover in result.Leftover.Take(10)) alertContent.Children.Add(new TextBlock { Text = leftover, TextWrapping = TextWrapping.Wrap });
            AddFastDeleteStderr(alertContent, result.StandardError);
        }
        else if (result.ExitCode != 0)
        {
            alertTitle = text("sftp.fastDeleteNonZero").Replace("{{code}}", result.ExitCode.Value.ToString(), StringComparison.Ordinal);
            AddFastDeleteStderr(alertContent, result.StandardError);
        }

        var outcome = alertTitle ?? text("sftp.fastDeleteDone").Replace("{{count}}", preview.Count.ToString(), StringComparison.Ordinal);
        try { await viewModel.RefreshAsync(); }
        catch (Exception error) { outcome += " · " + error.Message; }
        status.Text = outcome;
        if (alertTitle != null) await ShowFastDeleteAlertAsync(alertTitle, alertContent);
    }

    private async Task ShowFastDeleteAlertAsync(string title, object content)
    {
        var dialog = new ContentDialog
        {
            Title = title, Content = content, CloseButtonText = text("native.common.ok"), XamlRoot = XamlRoot
        };
        await dialog.ShowGatedAsync();
    }

    private void AddFastDeleteStderr(Panel content, string stderr)
    {
        if (string.IsNullOrWhiteSpace(stderr)) return;
        content.Children.Add(new TextBlock
        {
            Text = string.Join(Environment.NewLine, stderr.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0).Take(5)),
            TextWrapping = TextWrapping.Wrap
        });
    }

    private async Task DeleteAsync()
    {
        var selected = entries.SelectedItems.OfType<RemoteEntry>().ToArray();
        if (selected.Length == 0) return;
        var previews = new List<NativeDeletePreview>();
        try { foreach (var item in selected) previews.Add(await session.PreviewDeleteAsync(item.Path, CancellationToken.None)); }
        catch (Exception error) { status.Text = error.Message; return; }
        var summary = string.Join("\n", selected.Select(item => item.Path)) + $"\n{previews.Sum(p => p.Entries)}{(previews.Any(p => p.Truncated) ? "+" : "")} {text("native.sftp.entries")} · {previews.Sum(p => p.Bytes)} B\n{text("sftp.deleteIrreversible")}";
        if (previews.Any(p => p.ContainsSymlink)) summary += $"\n{text("native.sftp.symlinkWarning")}";
        var dialog = new ContentDialog { Title = deleteLabel, Content = summary, PrimaryButtonText = deleteLabel, CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        await RunAsync(async () => { foreach (var item in selected) await session.DeleteAsync(item.Path, item.IsDirectory, CancellationToken.None); await viewModel.RefreshAsync(); });
    }
}
