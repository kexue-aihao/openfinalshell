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
    private async void ShowShortcuts(object sender, RoutedEventArgs args)
    {
        var content = new StackPanel { Spacing = 12 };
        foreach (var (keys, key) in new[]
        {
            ("Ctrl+Shift+T", "shortcut.duplicateSession"), ("Ctrl+W", "shortcut.closeTab"),
            ("Ctrl+Tab", "shortcut.nextTab"), ("Ctrl+Shift+Tab", "shortcut.prevTab"), ("Alt+1…9", "shortcut.gotoTab"),
            ("Ctrl+F", "shortcut.search"), ("Ctrl+Shift+H", "shortcut.history"), ("Ctrl+Shift+C", "shortcut.copy"),
            ("Ctrl+Shift+V / Ctrl+V", "shortcut.paste"), ("Ctrl+C", "shortcut.sigint"), ("F2", "shortcut.renameFile"), ("Esc", "shortcut.closeOverlay")
        }) content.Children.Add(new TextBlock { Text = keys + "  ·  " + localization[key], TextWrapping = TextWrapping.Wrap });
        try { await new ContentDialog { Title = localization["settings.section_shortcuts"], Content = new ScrollViewer { Content = content, MaxHeight = 520 }, CloseButtonText = localization["common.close"], XamlRoot = Root.XamlRoot }.ShowGatedAsync(); }
        catch (Exception error) { ShowError(error); }
    }
}
