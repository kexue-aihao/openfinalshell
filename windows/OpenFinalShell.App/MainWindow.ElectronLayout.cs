using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.App.Controls;
using Windows.Graphics;

namespace OpenFinalShell.App;

// Presentation parity with the immutable GitHub v0.30.32 renderer.
// This partial owns layout only; services and their contracts stay unchanged.
public sealed partial class MainWindow
{
    private string selectedSettingsSection = "general";
    private bool connectionDrawerOpen;

    private void InitializeElectronLayout()
    {
        Root.ActualThemeChanged += (_, _) =>
        {
            ApplyShellPalette();
            ApplyNativeEditorTheme();
            UpdateTitleBarLayout();
        };
        if (AppWindowTitleBar.IsCustomizationSupported())
        {
            ExtendsContentIntoTitleBar = true;
            AppWindow.TitleBar.ButtonBackgroundColor = Colors.Transparent;
            AppWindow.TitleBar.ButtonInactiveBackgroundColor = Colors.Transparent;
            Root.Loaded += (_, _) => UpdateTitleBarLayout();
        }
        else CaptionButtonsColumn.Width = new GridLength(0);
        Body.SizeChanged += (_, _) => UpdateOverlayLayout();
        SettingsSurface.TabFocusNavigation = KeyboardNavigationMode.Cycle;
        AiSurface.TabFocusNavigation = KeyboardNavigationMode.Cycle;
    }

    private void AddSessionRequested(TabView sender, object args) => NewConnection(sender, new RoutedEventArgs());
    private void TitleBarSizeChanged(object sender, SizeChangedEventArgs args) => UpdateTitleBarLayout();

    private void UpdateTitleBarLayout()
    {
        if (!ExtendsContentIntoTitleBar || Root.XamlRoot == null || TitleBrand.ActualWidth <= 0) return;
        var rasterScale = Root.XamlRoot.RasterizationScale;
        var zoom = settings.UiScale / 100d;
        CaptionButtonsColumn.Width = new GridLength(AppWindow.TitleBar.RightInset / rasterScale / zoom);
        RectInt32 DragRectangle(FrameworkElement element)
        {
            var origin = element.TransformToVisual(ZoomViewport).TransformPoint(new Windows.Foundation.Point());
            return new RectInt32((int)Math.Round(origin.X * rasterScale), 0,
                (int)Math.Round(element.ActualWidth * rasterScale * zoom),
                (int)Math.Round(ShellTitleBar.ActualHeight * rasterScale * zoom));
        }
        // Only the brand and trailing gap drag the window. Tabs and + remain interactive.
        AppWindow.TitleBar.SetDragRectangles([DragRectangle(TitleBrand), DragRectangle(TitleBarDragRegion)]);
        AppWindow.TitleBar.ButtonForegroundColor = Root.ActualTheme == ElementTheme.Dark ? Colors.White : Colors.Black;
    }

    private void ConfigureElectronLayoutLabels()
    {
        WelcomeTitle.Text = localization["welcome.title"];
        WelcomeNewDescription.Text = localization["welcome.newConnectionDesc"];
        QuickConnectHeading.Text = localization["welcome.quickConnect"];
        RecentEmptyText.Text = localization["welcome.noRecent"];
        AutomationProperties.SetName(WelcomeNewButton, localization["welcome.newConnection"]);
        AutomationProperties.SetName(QuickConnectInput, localization["welcome.quickConnect"]);
        StatusVersion.Text = $"{localization["status.version"]} {typeof(MainWindow).Assembly.GetName().Version?.ToString(3)}";
        LanguageChoice.Header = localization["settings.language"];
        ThemeChoice.Header = localization["settings.theme"];
        SettingsConfigureAiButton.Content = "+";
        AutomationProperties.SetName(SettingsConfigureAiButton, localization["native.ai.configure"]);
        SettingsImportButton.Content = localization["native.common.import"];
        SettingsExportButton.Content = localization["native.common.export"];
        AiSettingsLink.Content = localization["aiAssistant.openSettings"];
        foreach (var button in SettingsNavigation.Children.OfType<Button>())
        {
            var section = button.Tag?.ToString() ?? "general";
            var key = section switch { "savedRef" => "savedRef.section", "ai" => "aiAssistant.title", _ => "settings.section_" + section };
            button.Content = localization[key];
            AutomationProperties.SetName(button, localization[key]);
        }
        ToolTipService.SetToolTip(ConnectionViewOptionsButton, localization["native.connections.sort"] + " / " + localization["native.connections.grouping"]);
        AutomationProperties.SetName(ConnectionViewOptionsButton, localization["native.connections.sort"] + " / " + localization["native.connections.grouping"]);
        UpdateRecentEmptyState();
    }

    private void UpdateRecentEmptyState()
    {
        RecentEmptyText.Visibility = RecentConnections.Items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        RecentConnections.Visibility = RecentConnections.Items.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    }

    private void WelcomeSizeChanged(object sender, SizeChangedEventArgs args)
    {
        if (WelcomeCards == null) return;
        WelcomeViewport.MinHeight = Math.Max(0, WelcomePage.ActualHeight);
        var available = Math.Max(0, WelcomePage.ActualWidth - 64);
        var columns = available >= 812 ? 3 : available >= 536 ? 2 : 1;
        for (var index = 0; index < 3; index++)
            WelcomeCards.ColumnDefinitions[index].Width = index < columns ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
        FrameworkElement[] cards = [WelcomeNewButton, WelcomeQuickCard, WelcomeRecentCard];
        for (var index = 0; index < cards.Length; index++)
        {
            Grid.SetRow(cards[index], index / columns);
            Grid.SetColumn(cards[index], index % columns);
            Grid.SetColumnSpan(cards[index], 1);
        }
        WelcomePage.VerticalContentAlignment = WelcomePage.ActualHeight < 500 ? VerticalAlignment.Top : VerticalAlignment.Center;
    }

    private void SettingsSectionClicked(object sender, RoutedEventArgs args)
    {
        if (sender is not Button { Tag: string section }) return;
        ShowSettingsSection(section);
        ActivatePage("settings");
    }

    private void NewAiProvider(object sender, RoutedEventArgs args)
    {
        AiProviderChoice.SelectedItem = null;
        ConfigureAiProvider(sender, args);
    }

    private void OpenAiSettings(object sender, RoutedEventArgs args)
    {
        ShowSettingsSection("ai");
        ActivatePage("settings");
    }

    private void ShowSettingsSection(string section)
    {
        var previous = selectedSettingsSection;
        selectedSettingsSection = section;
        void Show(UIElement element, string key) => element.Visibility = section == key ? Visibility.Visible : Visibility.Collapsed;
        Show(SettingsGeneralControls, "general");
        Show(SettingsAppearanceControls, "appearance");
        Show(SettingsAiControls, "ai");
        Show(SettingsSavedRefControls, "savedRef");
        Show(SettingsSecurityControls, "security");
        Show(SettingsShortcutControls, "shortcuts");
        if (PreferencesHost.Content is NativePreferencesPanel preferences) preferences.ShowSection(section);
        SettingsPage.ChangeView(null, 0, null, true);
        UpdateSettingsSelection(section);
        if (previous != section)
        {
            FrameworkElement target = section switch
            {
                "appearance" => SettingsAppearanceControls,
                "ai" => SettingsAiControls,
                "savedRef" => SettingsSavedRefControls,
                "security" => SettingsSecurityControls,
                "shortcuts" => SettingsShortcutControls,
                "terminal" or "sftp" => PreferencesHost,
                _ => SettingsGeneralControls
            };
            UiTaskRunner.Run(() => NativeUiMotion.FadeInAsync(target));
        }
    }

    private void UpdateSettingsSelection(string section)
    {
        foreach (var button in SettingsNavigation.Children.OfType<Button>())
        {
            var selected = button.Tag?.ToString() == section;
            button.FontWeight = selected ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal;
            button.Background = selected && Application.Current.Resources["AccentFillColorDisabledBrush"] is Brush accent
                ? accent : new SolidColorBrush(Colors.Transparent);
        }
    }

    private void UpdateOverlayLayout()
    {
        if (SettingsSurface == null || Body.ActualWidth <= 0) return;
        SettingsSurface.Width = Math.Max(0, Math.Min(860, Body.ActualWidth - 32));
        SettingsSurface.Height = Math.Max(0, Math.Min(616, Body.ActualHeight - 32));
        SettingsNavigationColumn.Width = new GridLength(Body.ActualWidth < 760 ? 136 : 168);
        AiSurface.Width = Math.Max(0, Math.Min(820, Body.ActualWidth - 32));
        AiSurface.Height = Math.Max(0, Math.Min(640, Body.ActualHeight - 32));
        var modal = connectionDrawerOpen || activeOverlay != null;
        MainWorkspace.IsHitTestVisible = ContextSidebar.IsHitTestVisible = ActivityRail.IsHitTestVisible = !modal;
        Sessions.IsEnabled = !modal;
        if (SettingsOverlay.Visibility == Visibility.Visible)
            UpdateSettingsSelection(activeOverlay switch { "lansync" => "lanSync", "about" => "about", _ => selectedSettingsSection });
    }

    private async Task<bool> ShowConnectionDrawerAsync(FrameworkElement content, string title, Control initialFocus)
    {
        if (connectionDrawerOpen) return false;
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var shade = new Grid();
        var scrim = new Grid { Background = new SolidColorBrush(Windows.UI.Color.FromArgb(102, 0, 0, 0)) };
        var surface = new Grid { HorizontalAlignment = HorizontalAlignment.Right, Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush,
            TabFocusNavigation = KeyboardNavigationMode.Cycle };
        surface.RowDefinitions.Add(new() { Height = GridLength.Auto });
        surface.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star) });
        var header = new Grid { Padding = new Thickness(20, 12, 20, 12), ColumnSpacing = 8 };
        header.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new() { Width = GridLength.Auto }); header.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var heading = new TextBlock { Text = title, FontSize = 16, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        var cancel = new Button { Content = localization["common.cancel"] };
        var save = new Button { Content = localization["common.save"], Style = Application.Current.Resources["AccentButtonStyle"] as Style };
        cancel.Click += (_, _) => completion.TrySetResult(false); save.Click += (_, _) => completion.TrySetResult(true);
        header.Children.Add(heading); header.Children.Add(cancel); header.Children.Add(save); Grid.SetColumn(cancel, 1); Grid.SetColumn(save, 2);
        surface.Children.Add(header); surface.Children.Add(content); Grid.SetRow(content, 1);
        shade.Children.Add(scrim); shade.Children.Add(surface); Grid.SetColumnSpan(shade, 4);
        AutomationProperties.SetName(surface, title); AutomationProperties.SetAutomationId(surface, "ConnectionDrawer");
        surface.KeyDown += (_, args) => { if (args.Key == Windows.System.VirtualKey.Escape) { completion.TrySetResult(false); args.Handled = true; } };
        void Resize(object? sender, SizeChangedEventArgs args) => surface.Width = Math.Max(0, Math.Min(520, Body.ActualWidth));
        surface.Width = Math.Max(0, Math.Min(520, Body.ActualWidth));
        Body.SizeChanged += Resize;
        connectionDrawerOpen = true;
        surface.Loaded += (_, _) => initialFocus.Focus(FocusState.Programmatic);
        Body.Children.Add(shade); UpdateOverlayLayout();
        UiTaskRunner.Run(() => NativeUiMotion.AnimateInAsync(surface, scrim, NativeMotionKind.DrawerRight));
        try { return await completion.Task; }
        finally
        {
            Body.SizeChanged -= Resize;
            connectionDrawerOpen = false;
            UpdateOverlayLayout();
            Sessions.Focus(FocusState.Programmatic);
            shade.IsHitTestVisible = false;
            await NativeUiMotion.AnimateOutAsync(surface, scrim, NativeMotionKind.DrawerRight);
            Body.Children.Remove(shade);
        }
    }

    private void SettingsSurfaceKeyDown(object sender, KeyRoutedEventArgs args)
    {
        if (args.Key != Windows.System.VirtualKey.Escape) return;
        CloseOverlayCore();
        SettingsItem.Focus(FocusState.Keyboard);
        args.Handled = true;
    }
}
