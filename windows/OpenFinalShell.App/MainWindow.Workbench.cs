using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using System.Text.Json.Nodes;
using Windows.UI;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private void SidebarResize(object sender, DragDeltaEventArgs args)
    {
        if (responsiveSidebarCollapsed) return;
        var maximum = Math.Min(460, Body.ActualWidth - 48 - 6 - 236);
        var minimum = Math.Min(220, maximum);
        var width = Math.Clamp(ContextSidebarColumn.ActualWidth + args.HorizontalChange, minimum, maximum);
        ContextSidebarColumn.Width = new GridLength(width);
    }
    private void SidebarResizeCompleted(object sender, DragCompletedEventArgs args)
    {
        if (responsiveSidebarCollapsed) return;
        var maximum = Math.Min(460, Body.ActualWidth - 48 - 6 - 236);
        var minimum = Math.Min(220, maximum);
        var width = Math.Clamp(ContextSidebarColumn.Width.Value, minimum, maximum);
        store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["sidebarWidth"] = width });
    }
    private void ApplyAppearance()
    {
        Root.RequestedTheme = settings.ThemeMode switch { "dark" => ElementTheme.Dark, "light" => ElementTheme.Light, _ => ElementTheme.Default };
        ApplyShellPalette();
        ApplyAccentResources(settings.Accent);
        try { SystemBackdrop = !settings.ReduceTransparency && environment.MicaEligible ? new MicaBackdrop() : null; } catch { SystemBackdrop = null; }
        foreach (var terminal in sessionTerminals.Values) terminal.Configure(settings, key => localization[key]);
        foreach (var workspace in sessionWorkspaces.Values) workspace.Configure(settings);
        editorWindowHost.Configure(settings);
        ApplyUiZoom();
        UpdateTitleBarLayout();
    }
    private void ApplyShellPalette()
    {
        // Mutate the shared brushes: imperative native surfaces retain these same
        // brush instances, while ThemeResource users update with the window.
        var light = Root.ActualTheme == ElementTheme.Light;
        var windows11 = environment.Profile == "windows-11";
        Color Gray(byte value) => Color.FromArgb(255, value, value, value);
        var shell = Gray(light ? (byte)(windows11 ? 243 : 240) : (byte)(windows11 ? 32 : 31));
        var workspace = Gray(light ? (byte)(windows11 ? 251 : 255) : (byte)(windows11 ? 39 : 37));
        var stroke = light ? Color.FromArgb(40, 0, 0, 0) : Color.FromArgb(40, 255, 255, 255);
        if (new Windows.UI.ViewManagement.AccessibilitySettings().HighContrast)
        {
            var colors = new Windows.UI.ViewManagement.UISettings();
            shell = workspace = colors.GetColorValue(Windows.UI.ViewManagement.UIColorType.Background);
            stroke = colors.GetColorValue(Windows.UI.ViewManagement.UIColorType.Foreground);
        }
        foreach (var (key, color) in new[] { ("ShellBackgroundBrush", shell), ("WorkspaceBackgroundBrush", workspace), ("CardStrokeColorDefaultBrush", stroke) })
            if (Application.Current.Resources[key] is SolidColorBrush brush) brush.Color = color;
    }
    private static void ApplyAccentResources(string value)
    {
        if (!NativeSettings.AccentColors.Contains(value, StringComparer.OrdinalIgnoreCase)) value = NativeSettings.DefaultAccent;
        Color accent;
        try
        {
            accent = Color.FromArgb(255, Convert.ToByte(value.Substring(1, 2), 16), Convert.ToByte(value.Substring(3, 2), 16), Convert.ToByte(value.Substring(5, 2), 16));
        }
        catch (FormatException) { accent = Color.FromArgb(255, 22, 119, 255); }
        var luminance = (.2126 * accent.R + .7152 * accent.G + .0722 * accent.B) / 255;
        var foreground = luminance > .62 ? Color.FromArgb(255, 0, 0, 0) : Color.FromArgb(255, 255, 255, 255);
        void Brush(string key, Color color) => Application.Current.Resources[key] = new SolidColorBrush(color);
        Brush("AccentFillColorDefaultBrush", accent);
        Brush("AccentFillColorSecondaryBrush", Color.FromArgb(208, accent.R, accent.G, accent.B));
        Brush("AccentFillColorTertiaryBrush", Color.FromArgb(144, accent.R, accent.G, accent.B));
        Brush("AccentFillColorDisabledBrush", Color.FromArgb(96, accent.R, accent.G, accent.B));
        Brush("AccentTextFillColorPrimaryBrush", foreground);
        Brush("AccentTextFillColorSecondaryBrush", foreground);
        Brush("AccentTextFillColorTertiaryBrush", foreground);
        Brush("AccentTextFillColorDisabledBrush", Color.FromArgb(128, foreground.R, foreground.G, foreground.B));
        Brush("AccentFillColorSelectedTextBackgroundBrush", accent);
        Brush("AccentFillColorSelectedTextForegroundBrush", foreground);
    }
    private void ZoomHostSizeChanged(object sender, SizeChangedEventArgs args) => ApplyUiZoom();
    private void WorkbenchSizeChanged(object sender, SizeChangedEventArgs args) => UpdateWorkbenchLayout();
    private void ApplyUiZoom()
    {
        if (settings == null || ZoomViewport.ActualWidth <= 0 || ZoomViewport.ActualHeight <= 0) return;
        var zoom = settings.UiScale / 100d;
        Root.Width = ZoomViewport.ActualWidth / zoom;
        Root.Height = ZoomViewport.ActualHeight / zoom;
        UiScaleTransform.ScaleX = zoom;
        UiScaleTransform.ScaleY = zoom;
    }
    private void UpdateWorkbenchLayout()
    {
        if (ContextSidebarColumn == null || Body.ActualWidth <= 0) return;
        // Keep the session work area usable at high app zoom by reducing both
        // columns before switching the context pane to a temporary drawer.
        const double activityRailWidth = 48;
        const double splitterWidth = 6;
        const double minimumWorkspaceWidth = 236;
        const double minimumSidebarWidth = 180;
        var maximumSidebarWidth = Body.ActualWidth - activityRailWidth - splitterWidth - minimumWorkspaceWidth;
        responsiveSidebarCollapsed = maximumSidebarWidth < minimumSidebarWidth;
        var savedCollapsed = store.Find("nativeWorkspace", "nativeWorkspace")?["sidebarCollapsed"]?.GetValue<bool>() ?? false;
        var savedWidth = store.Find("nativeWorkspace", "nativeWorkspace")?["sidebarWidth"]?.GetValue<double>() ?? 300;

        if (responsiveSidebarCollapsed)
        {
            ContextSidebarColumn.Width = new GridLength(0);
            ContextSidebarSplitterColumn.Width = new GridLength(0);
            ContextSidebarSplitter.Visibility = Visibility.Collapsed;
            Grid.SetColumnSpan(ContextSidebar, 3);
            ContextSidebar.Width = Math.Max(0, Math.Min(320, Body.ActualWidth - activityRailWidth));
            ContextSidebar.HorizontalAlignment = HorizontalAlignment.Left;
            ContextSidebar.Visibility = responsiveSidebarOpen ? Visibility.Visible : Visibility.Collapsed;
            return;
        }

        responsiveSidebarOpen = false;
        Grid.SetColumnSpan(ContextSidebar, 1);
        ContextSidebar.ClearValue(FrameworkElement.WidthProperty);
        ContextSidebar.HorizontalAlignment = HorizontalAlignment.Stretch;
        var collapsed = savedCollapsed;
        var sidebarMaximum = Math.Min(460, maximumSidebarWidth);
        var sidebarMinimum = Math.Min(220, sidebarMaximum);
        ContextSidebarColumn.Width = new GridLength(collapsed ? 0 : Math.Clamp(savedWidth, sidebarMinimum, sidebarMaximum));
        ContextSidebarSplitterColumn.Width = new GridLength(collapsed ? 0 : splitterWidth);
        ContextSidebar.Visibility = collapsed ? Visibility.Collapsed : Visibility.Visible;
        ContextSidebarSplitter.Visibility = collapsed ? Visibility.Collapsed : Visibility.Visible;
    }
    private void ConfigureDefaultProxy()
    {
        DefaultProxyChoice.Header = localization["native.workbench.defaultProxy"];
        DefaultProxyChoice.Items.Clear();
        DefaultProxyChoice.Items.Add(new ComboBoxItem { Content = localization["native.proxies.direct"], Tag = "" });
        foreach (var proxy in savedProxies.Items) DefaultProxyChoice.Items.Add(new ComboBoxItem { Content = proxy.Name, Tag = proxy.Id });
        DefaultProxyChoice.SelectedItem = DefaultProxyChoice.Items.OfType<ComboBoxItem>().FirstOrDefault(item => item.Tag?.ToString() == (settings.DefaultProxyId ?? ""));
    }
    private void DefaultProxyChanged(object sender, SelectionChangedEventArgs args)
    {
        if (loadingSettings || DefaultProxyChoice.SelectedItem is not ComboBoxItem item) return;
        var id = item.Tag?.ToString();
        settings = NativeSettings.Update(store, new() { ["connection"] = new JsonObject { ["defaultProxyId"] = string.IsNullOrEmpty(id) ? null : id } });
    }
    private async void ConnectionTreeAction(string action, string? id, bool group)
    {
        try
        {
            if (group) ConnectionGroups.Selected = ConnectionGroups.Groups.FirstOrDefault(item => item.Id == id);
            else { connections.Selected = connections.Profiles.FirstOrDefault(item => item.Id == id); ProfilesList.SelectedItem = connections.Selected; }
            switch (action)
            {
                case "select": return;
                case "connect": if (connections.Selected is { } profile) await OpenProfileAsync(profile); break;
                case "new": newProfileGroup = group ? id : null; try { await ShowConnectionEditorAsync(null); } finally { newProfileGroup = null; } break;
                case "edit": if (group) EditConnectionGroup(this, new RoutedEventArgs()); else if (connections.Selected is { } selected) await ShowConnectionEditorAsync(selected); break;
                case "duplicate": DuplicateConnection(this, new RoutedEventArgs()); break;
                case "ungroup":
                    if (id == null) break;
                    if (group) store.SaveConnectionGroup(id, new() { ["parentId"] = null }, ConnectionGroups.Selected?.Revision);
                    else if (connections.Selected is { } ungrouped) store.Patch("profiles", id, new() { ["groupId"] = null });
                    LoadProfiles(); break;
                case "newGroup":
                    var name = await PromptTextAsync(localization["native.groups.new"]);
                    if (!string.IsNullOrWhiteSpace(name)) { ConnectionGroups.Save(null, name, ConnectionGroups.Groups.Count, parentId: group ? id : null); LoadProfiles(); }
                    break;
                case "delete": if (group) DeleteConnectionGroup(this, new RoutedEventArgs()); else await ConfirmDeleteProfileAsync(); break;
                case "copy":
                    if (connections.Selected is { } copied)
                    {
                        var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
                        var host = copied.Host.Contains(':') ? $"[{copied.Host}]" : copied.Host;
                        package.SetText($"ssh -p {copied.Port} {copied.Username}@{host}");
                        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
                    }
                    break;
            }
        }
        catch (Exception error) { ShowError(error); }
    }
    private async Task ConfirmDeleteProfileAsync()
    {
        var selected = connections.Selected; if (selected == null) return;
        var dialog = new ContentDialog { Title = localization["common.delete"], Content = selected.Name, PrimaryButtonText = localization["common.delete"], CloseButtonText = localization["common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        store.Delete("profiles", selected.Id, selected.Data["_revision"]!.GetValue<long>()); LoadProfiles();
    }
    private async void QuickConnect(object sender, RoutedEventArgs args) => await QuickConnectAsync();
    private async void QuickConnectKeyDown(object sender, KeyRoutedEventArgs args)
    {
        if (args.Key != Windows.System.VirtualKey.Enter) return;
        args.Handled = true; await QuickConnectAsync();
    }
    private async Task QuickConnectAsync()
    {
        try
        {
            var input = QuickConnectInput.Text.Trim();
            if (input.StartsWith("ssh ", StringComparison.Ordinal)) input = input[4..].Trim();
            var uri = new Uri(input.StartsWith("ssh://", StringComparison.OrdinalIgnoreCase) ? input : "ssh://" + input);
            if (uri.Scheme != "ssh" || string.IsNullOrWhiteSpace(uri.Host) || string.IsNullOrWhiteSpace(uri.UserInfo) || uri.UserInfo.Contains(':') || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath is not ("" or "/")) throw new InvalidDataException(localization["native.validationFailed"]);
            var id = "quick-" + Guid.NewGuid().ToString("N");
            var profile = new JsonObject { ["id"] = id, ["name"] = uri.Host, ["host"] = uri.Host.Trim('[', ']'), ["port"] = uri.Port < 0 ? 22 : uri.Port,
                ["username"] = Uri.UnescapeDataString(uri.UserInfo), ["auth"] = new JsonObject { ["method"] = "password" }, ["proxyMode"] = "follow" };
            await OpenProfileAsync(ConnectionProfile.FromJson(profile));
        }
        catch (Exception error) { ShowError(error); }
    }
    private async Task ShowTerminalHistoryAsync(Controls.NativeTerminalCanvas terminal, string sessionId)
    {
        var input = new TextBox { PlaceholderText = localization["terminal.historyFilter"] };
        var list = new ListView { MaxHeight = 360, SelectionMode = ListViewSelectionMode.Single };
        var history = commandLibrary.ListHistory(sessionId);
        void Filter() => list.ItemsSource = history.Where(command => command.Contains(input.Text, StringComparison.CurrentCultureIgnoreCase)).ToArray();
        input.TextChanged += (_, _) => Filter(); Filter();
        var panel = new StackPanel { Spacing = 8, Children = { new TextBlock { Text = localization["terminal.historyHint"], TextWrapping = TextWrapping.Wrap }, input, list } };
        var dialog = new ContentDialog { Title = localization["terminal.history"], Content = panel, XamlRoot = Root.XamlRoot,
            PrimaryButtonText = localization["native.common.ok"], CloseButtonText = localization["common.cancel"] };
        if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary && list.SelectedItem is string command) terminal.Send(command.Replace('\r', ' ').Replace('\n', ' '));
    }
}
