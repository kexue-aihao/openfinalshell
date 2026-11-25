using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using Windows.System;

namespace OpenFinalShell.App;

/// <summary>Ctrl+K quick switcher across open session tabs and saved connections.</summary>
public sealed partial class MainWindow
{
    private sealed record PaletteEntry(string Title, string Subtitle, TabViewItem? Tab, ConnectionProfile? Profile);

    private bool paletteOpen;
    private Grid? paletteHost;
    private Grid? paletteScrim;
    private Border? paletteSurface;
    private TextBox? paletteSearch;
    private ScrollViewer? paletteScroll;
    private StackPanel? paletteItems;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? paletteSearchTimer;
    private readonly List<Button> paletteButtons = [];
    private readonly SolidColorBrush paletteTransparentBrush = new(Colors.Transparent);
    private Brush? paletteSelectedBrush;
    private IReadOnlyList<PaletteEntry> paletteSourceEntries = [];
    private IReadOnlyList<PaletteEntry> paletteEntries = [];
    private int paletteSelectedIndex = -1;
    private Button? paletteHighlightedButton;
    private Control? palettePreviousFocus;
    private bool paletteFilterPending;
    private int paletteCloseVersion;

    private void OpenQuickSwitcher()
    {
        if (Root.XamlRoot == null) return;
        if (paletteOpen)
        {
            paletteSearch?.Focus(FocusState.Programmatic);
            return;
        }
        if (paletteHost == null || paletteSurface == null || paletteSearch == null) BuildPalette();
        if (paletteHost == null || paletteSurface == null || paletteSearch == null) return;

        palettePreviousFocus = FocusManager.GetFocusedElement(Root.XamlRoot) as Control;
        paletteSourceEntries = BuildPaletteEntries();
        paletteOpen = true;
        // Reuse the built palette across opens; only its data is refreshed.
        Body.Children.Remove(paletteHost);
        paletteHost.IsHitTestVisible = true;
        Grid.SetColumnSpan(paletteHost, 4);
        Body.Children.Add(paletteHost);
        UpdateOverlayLayout();
        if (paletteSearch.Text.Length > 0) paletteSearch.Text = string.Empty;
        RefreshPaletteItems();
        UiTaskRunner.Run(() => NativeUiMotion.AnimateInAsync(paletteSurface, paletteScrim, NativeMotionKind.Overlay), ShowError);
        paletteSearch.Focus(FocusState.Programmatic);
    }

    private async Task CloseQuickSwitcherAsync(bool restoreFocus = true)
    {
        if (!paletteOpen) return;
        paletteOpen = false;
        var closeVersion = ++paletteCloseVersion;
        paletteSearchTimer?.Stop();
        var host = paletteHost;
        var surface = paletteSurface;
        var scrim = paletteScrim;
        UpdateOverlayLayout();
        if (host != null) host.IsHitTestVisible = false;
        if (surface != null)
        {
            try { await NativeUiMotion.AnimateOutAsync(surface, scrim, NativeMotionKind.Overlay); }
            catch (Exception error) { System.Diagnostics.Debug.WriteLine($"Quick switcher exit failed: {error}"); }
        }
        if (closeVersion != paletteCloseVersion) return;
        // Keep the built host so the next Ctrl+K only refreshes data instead
        // of reconstructing the search box, list and themed brushes. Do not
        // remove it if a fast reopen already re-attached the same host.
        if (host != null && !paletteOpen && ReferenceEquals(paletteHost, host))
        {
            Body.Children.Remove(host);
            // Drop tab/profile references while the switcher stays built.
            paletteEntries = [];
            paletteSourceEntries = [];
            paletteSelectedIndex = -1;
            paletteButtons.Clear();
            paletteItems?.Children.Clear();
        }
        if (restoreFocus && !paletteOpen)
        {
            var previous = palettePreviousFocus;
            palettePreviousFocus = null;
            previous?.Focus(FocusState.Programmatic);
        }
        else if (!paletteOpen) palettePreviousFocus = null;
    }

    private void BuildPalette()
    {
        paletteScrim = new Grid { Background = new SolidColorBrush(Windows.UI.Color.FromArgb(102, 0, 0, 0)) };
        paletteScrim.Tapped += (_, _) => UiTaskRunner.Run(() => CloseQuickSwitcherAsync(), ShowError);

        var panel = new Grid();
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        paletteSearch = new TextBox
        {
            PlaceholderText = localization["palette.placeholder"],
            Margin = new Thickness(12, 12, 12, 6),
            FontSize = 14,
            BorderThickness = new Thickness(0),
            Background = new SolidColorBrush(Colors.Transparent)
        };
        paletteSearchTimer = DispatcherQueue.CreateTimer();
        paletteSearchTimer.Interval = TimeSpan.FromMilliseconds(120);
        paletteSearchTimer.IsRepeating = false;
        paletteSearchTimer.Tick += (_, _) => RefreshPaletteItems();
        paletteSearch.TextChanged += (_, _) => QueuePaletteRefresh();

        paletteScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(6, 0, 6, 4)
        };
        paletteItems = new StackPanel { Spacing = 2 };
        paletteScroll.Content = paletteItems;

        var hint = new TextBlock
        {
            Text = localization["palette.hint"],
            FontSize = 11,
            Opacity = .6,
            Margin = new Thickness(14, 6, 14, 10),
            TextWrapping = TextWrapping.Wrap
        };

        panel.Children.Add(paletteSearch);
        panel.Children.Add(paletteScroll);
        Grid.SetRow(paletteScroll, 1);
        panel.Children.Add(hint);
        Grid.SetRow(hint, 2);

        paletteSurface = new Border
        {
            Width = 560,
            MaxHeight = 460,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 72, 0, 0),
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush,
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush,
            BorderThickness = new Thickness(1),
            CornerRadius = NativeSceneStyle.CornerRadius("OverlayCornerRadius", 8),
            Child = panel
        };
        paletteSelectedBrush = Application.Current.Resources["AccentFillColorDisabledBrush"] as Brush;
        AutomationProperties.SetName(paletteSurface, localization["palette.title"]);
        AutomationProperties.SetAutomationId(paletteSurface, "QuickSwitcher");

        paletteHost = new Grid { TabFocusNavigation = KeyboardNavigationMode.Cycle };
        paletteHost.Children.Add(paletteScrim);
        paletteHost.Children.Add(paletteSurface);
        paletteHost.PreviewKeyDown += PalettePreviewKeyDown;
        AutomationProperties.SetName(paletteHost, localization["palette.title"]);
    }

    private void PalettePreviewKeyDown(object sender, KeyRoutedEventArgs args)
    {
        switch (args.Key)
        {
            case VirtualKey.Escape:
                args.Handled = true;
                UiTaskRunner.Run(() => CloseQuickSwitcherAsync(), ShowError);
                break;
            case VirtualKey.Enter:
                args.Handled = true;
                if (paletteFilterPending) RefreshPaletteItems();
                UiTaskRunner.Run(() => ActivateSelectedPaletteEntryAsync(), ShowError);
                break;
            case VirtualKey.Down:
                args.Handled = true;
                MovePaletteSelection(1);
                break;
            case VirtualKey.Up:
                args.Handled = true;
                MovePaletteSelection(-1);
                break;
        }
    }

    private void MovePaletteSelection(int delta)
    {
        if (paletteButtons.Count == 0) return;
        paletteSelectedIndex = paletteSelectedIndex < 0
            ? 0
            : (paletteSelectedIndex + delta + paletteButtons.Count) % paletteButtons.Count;
        UpdatePaletteHighlight();
    }

    private void QueuePaletteRefresh()
    {
        paletteFilterPending = true;
        if (paletteSearchTimer == null) { RefreshPaletteItems(); return; }
        paletteSearchTimer.Stop();
        paletteSearchTimer.Start();
    }

    private void RefreshPaletteItems()
    {
        if (paletteItems == null) return;
        paletteFilterPending = false;
        paletteSearchTimer?.Stop();
        paletteItems.Children.Clear();
        paletteButtons.Clear();
        paletteHighlightedButton = null;
        var query = paletteSearch?.Text.Trim() ?? string.Empty;
        var all = paletteSourceEntries;
        paletteEntries = query.Length == 0
            ? all
            : all.Where(entry =>
                entry.Title.Contains(query, StringComparison.CurrentCultureIgnoreCase) ||
                entry.Subtitle.Contains(query, StringComparison.CurrentCultureIgnoreCase)).ToArray();

        AddPaletteSection(localization["palette.sessions"], paletteEntries.Where(entry => entry.Tab != null));
        AddPaletteSection(localization["palette.connections"], paletteEntries.Where(entry => entry.Profile != null));
        if (paletteEntries.Count == 0)
        {
            paletteItems.Children.Add(new TextBlock
            {
                Text = localization["palette.empty"],
                Opacity = .6,
                FontSize = 12,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(12, 10, 12, 12)
            });
        }

        paletteSelectedIndex = paletteEntries.Count > 0 ? 0 : -1;
        UpdatePaletteHighlight();
        paletteScroll?.ChangeView(null, 0, null, true);
    }

    private IReadOnlyList<PaletteEntry> BuildPaletteEntries()
    {
        var entries = new List<PaletteEntry>(Sessions.TabItems.Count + connections.Profiles.Count);
        foreach (var item in Sessions.TabItems)
            if (item is TabViewItem tab)
                entries.Add(new PaletteEntry(SessionTabTitle(tab), PaletteSessionSubtitle(tab), tab, null));
        foreach (var profile in connections.Profiles)
            entries.Add(new PaletteEntry(profile.Name, $"{profile.Username}@{profile.Host}:{profile.Port}", null, profile));
        return entries;
    }

    private string PaletteSessionSubtitle(TabViewItem tab)
    {
        var id = SessionIdForTag(tab.Tag?.ToString());
        return id != null && sessionProfiles.TryGetValue(id, out var profile)
            ? $"{profile.Username}@{profile.Host}:{profile.Port}"
            : string.Empty;
    }

    private void AddPaletteSection(string heading, IEnumerable<PaletteEntry> entries)
    {
        if (paletteItems == null) return;
        var section = entries.ToList();
        if (section.Count == 0) return;
        paletteItems.Children.Add(new TextBlock
        {
            Text = heading,
            FontSize = 11,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Opacity = .6,
            Margin = new Thickness(10, 8, 10, 4)
        });
        foreach (var entry in section) AddPaletteButton(entry);
    }

    private void AddPaletteButton(PaletteEntry entry)
    {
        if (paletteItems == null) return;
        var row = new Grid { ColumnSpacing = 10, Padding = new Thickness(10, 5, 10, 5) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(new FontIcon
        {
            Glyph = entry.Tab != null ? "\uE756" : entry.Profile?.Data["protocol"]?.GetValue<string>() == "rdp" ? "\uE9D9" : "\uE756",
            FontSize = 14,
            VerticalAlignment = VerticalAlignment.Center
        });
        var labels = new StackPanel { Spacing = 1 };
        labels.Children.Add(new TextBlock
        {
            Text = entry.Title,
            FontSize = 13,
            TextTrimming = TextTrimming.CharacterEllipsis
        });
        if (entry.Subtitle.Length > 0)
            labels.Children.Add(new TextBlock
            {
                Text = entry.Subtitle,
                FontSize = 11,
                Opacity = .65,
                TextTrimming = TextTrimming.CharacterEllipsis
            });
        row.Children.Add(labels);
        Grid.SetColumn(labels, 1);

        var button = new Button
        {
            Content = row,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Padding = new Thickness(0),
            Background = paletteTransparentBrush,
            BorderThickness = new Thickness(0),
            CornerRadius = NativeSceneStyle.CornerRadius("ControlCornerRadius", 4),
            UseSystemFocusVisuals = true
        };
        AutomationProperties.SetName(button, entry.Subtitle.Length == 0 ? entry.Title : $"{entry.Title} · {entry.Subtitle}");
        button.Click += (_, _) => UiTaskRunner.Run(() => ActivatePaletteEntryAsync(entry), ShowError);
        paletteItems.Children.Add(button);
        paletteButtons.Add(button);
    }

    private void UpdatePaletteHighlight()
    {
        Button? selected = paletteSelectedIndex >= 0 && paletteSelectedIndex < paletteButtons.Count
            ? paletteButtons[paletteSelectedIndex]
            : null;
        if (!ReferenceEquals(paletteHighlightedButton, selected))
        {
            if (paletteHighlightedButton != null) paletteHighlightedButton.Background = paletteTransparentBrush;
            if (selected != null) selected.Background = paletteSelectedBrush ?? paletteTransparentBrush;
            paletteHighlightedButton = selected;
        }
        if (paletteSelectedIndex >= 0 && paletteSelectedIndex < paletteButtons.Count)
            paletteButtons[paletteSelectedIndex].StartBringIntoView();
    }

    private Task ActivateSelectedPaletteEntryAsync()
    {
        if (paletteSelectedIndex < 0 || paletteSelectedIndex >= paletteEntries.Count) return Task.CompletedTask;
        return ActivatePaletteEntryAsync(paletteEntries[paletteSelectedIndex]);
    }

    private async Task ActivatePaletteEntryAsync(PaletteEntry entry)
    {
        await CloseQuickSwitcherAsync(restoreFocus: false);
        if (entry.Tab is { } tab)
        {
            if (Sessions.TabItems.Contains(tab)) Sessions.SelectedItem = tab;
            var id = SessionIdForTag(tab.Tag?.ToString());
            if (id != null && sessionTerminals.TryGetValue(id, out var terminal)) terminal.FocusTerminalInput();
            return;
        }
        if (entry.Profile is { } profile) await OpenProfileAsync(profile);
    }
}
