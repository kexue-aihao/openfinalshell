using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using System.Runtime.CompilerServices;
using Windows.System;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private bool workbenchComposing;
    private readonly ConditionalWeakTable<TextBox, object> compositionInputs = new();

    private void InitializeWorkbenchShortcuts()
    {
        Root.GotFocus += (_, _) =>
        {
            workbenchComposing = false;
            if (FocusManager.GetFocusedElement(Root.XamlRoot) is TextBox box)
                compositionInputs.GetValue(box, input =>
                {
                    input.TextCompositionStarted += (_, _) => workbenchComposing = true;
                    input.TextCompositionEnded += (_, _) => workbenchComposing = false;
                    return new object();
                });
        };
        Root.PreviewKeyDown += WorkbenchKeyDown;
    }

    private bool HasWorkbenchPopup() => connectionDrawerOpen || activeOverlay != null || Root.XamlRoot == null || VisualTreeHelper.GetOpenPopupsForXamlRoot(Root.XamlRoot).Count > 0;
    private static bool KeyDown(VirtualKey key) => Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(key).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
    private void WorkbenchKeyDown(object sender, KeyRoutedEventArgs args)
    {
        if (args.Handled) return;
        var textEntry = false; var composing = workbenchComposing;
        var source = args.OriginalSource as DependencyObject;
        while (source != null)
        {
            if (source is Controls.NativeTerminalCanvas terminal) { textEntry = false; composing |= terminal.IsInputComposing; break; }
            if (source is TextBox or PasswordBox or ComboBox) textEntry = true;
            source = VisualTreeHelper.GetParent(source);
        }
        args.Handled = RouteWorkbenchShortcut((int)args.Key, KeyDown(VirtualKey.Control), KeyDown(VirtualKey.Shift), KeyDown(VirtualKey.Menu), textEntry, composing);
    }
    private bool HandleNativeEditorShortcut(int key, bool control, bool shift, bool alt) => RouteWorkbenchShortcut(key, control, shift, alt, true, false);
    private bool RouteWorkbenchShortcut(int key, bool control, bool shift, bool alt, bool textEntry, bool composing)
    {
        var shortcut = NativeWorkbenchShortcut.Resolve(key, control, shift, alt, textEntry, composing, HasWorkbenchPopup());
        if (shortcut is not { } requested) return false;
        // Native editor callbacks run inside a window procedure. Defer actions
        // that may hide/destroy that HWND until the message has returned.
        DispatcherQueue.TryEnqueue(async () =>
        {
            try { await ExecuteWorkbenchShortcutAsync(requested); }
            catch (Exception error) { ShowError(error); }
        });
        return true;
    }
    private async Task ExecuteWorkbenchShortcutAsync(NativeWorkbenchShortcut shortcut)
    {
        if (HasWorkbenchPopup() || Sessions.TabItems.Count == 0) return;
        if (shortcut.Action == NativeWorkbenchAction.CloseSession)
        {
            if (Sessions.SelectedItem is TabViewItem closing) await CloseSessionTabAsync(closing);
            return;
        }
        if (shortcut.Action == NativeWorkbenchAction.DuplicateSession)
        {
            var id = SessionIdForTag((Sessions.SelectedItem as TabViewItem)?.Tag?.ToString());
            if (id != null && sessionProfiles.TryGetValue(id, out var profile)) await OpenProfileAsync(profile, duplicate: true);
            return;
        }
        var current = Sessions.SelectedItem == null ? -1 : Sessions.TabItems.IndexOf(Sessions.SelectedItem);
        var next = shortcut.Action switch
        {
            NativeWorkbenchAction.NextSession => (current + 1) % Sessions.TabItems.Count,
            NativeWorkbenchAction.PreviousSession => (current - 1 + Sessions.TabItems.Count) % Sessions.TabItems.Count,
            _ => shortcut.Index
        };
        if (next < 0 || next >= Sessions.TabItems.Count) return;
        ActivatePage("connections"); Sessions.SelectedItem = Sessions.TabItems[next];
        var selected = SessionIdForTag((Sessions.SelectedItem as TabViewItem)?.Tag?.ToString());
        if (selected != null && sessionTerminals.TryGetValue(selected, out var terminal)) terminal.Focus(FocusState.Programmatic);
    }
    private void ConfigureShortcutList()
    {
        ShortcutList.Children.Clear();
        var groups = new (string Key, (string Keys, string Description)[] Items)[]
        {
            ("sessions", [
                ("Ctrl+Shift+T", "shortcut.duplicateSession"), ("Ctrl+W", "shortcut.closeTab"),
                ("Ctrl+Tab", "shortcut.nextTab"), ("Ctrl+Shift+Tab", "shortcut.prevTab"), ("Alt+1…9", "shortcut.gotoTab")]),
            ("terminal", [
                ("Ctrl+F", "shortcut.search"), ("Ctrl+Shift+H", "shortcut.history"),
                ("Ctrl+Shift+C", "shortcut.copy"), ("Ctrl+Shift+V / Ctrl+V", "shortcut.paste"),
                ("Ctrl+C", "shortcut.sigint")]),
            ("files", [("F2", "shortcut.renameFile")]),
            ("overlays", [("Esc", "shortcut.closeOverlay")])
        };
        foreach (var group in groups)
        {
            var rows = new StackPanel { Spacing = 4 };
            rows.Children.Add(new TextBlock
            {
                Text = localization[$"shortcut.groups.{group.Key}"],
                FontSize = 14,
                FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
                Margin = new Thickness(0, 0, 0, 4)
            });
            foreach (var (keys, description) in group.Items)
            {
                var line = new Grid { ColumnSpacing = 12, MinHeight = 38 };
                line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                line.Children.Add(new TextBlock
                {
                    Text = localization[description],
                    VerticalAlignment = VerticalAlignment.Center,
                    TextWrapping = TextWrapping.Wrap
                });
                var keycap = new Border
                {
                    Background = Application.Current.Resources["ShellBackgroundBrush"] as Brush,
                    BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush,
                    BorderThickness = new Thickness(1),
                    CornerRadius = NativeSceneStyle.CornerRadius("ControlCornerRadius", 4),
                    Padding = new Thickness(8, 4, 8, 4),
                    VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock { Text = keys, FontFamily = new Microsoft.UI.Xaml.Media.FontFamily("Consolas"), FontSize = 12 }
                };
                line.Children.Add(keycap);
                Grid.SetColumn(keycap, 1);
                rows.Children.Add(line);
            }
            ShortcutList.Children.Add(new Border
            {
                Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush,
                BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush,
                BorderThickness = new Thickness(1),
                CornerRadius = NativeSceneStyle.CornerRadius("OverlayCornerRadius", 6),
                Padding = new Thickness(12),
                Child = rows
            });
        }
    }
}
