using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private void ConfigureSessionTabPresentation(TabViewItem tab)
    {
        tab.FontSize = 12;
        tab.MinWidth = 96; tab.MaxWidth = 200;
        var tag = tab.Tag?.ToString();
        if (tag?.StartsWith("connecting:", StringComparison.Ordinal) == true)
        {
            tab.ContextFlyout = null;
            return;
        }
        var menu = new MenuFlyout();
        void Action(string key, Func<Task> action)
        {
            var item = new MenuFlyoutItem { Text = localization[key] };
            AutomationProperties.SetName(item, localization[key]);
            item.Click += async (_, _) => { try { await action(); } catch (Exception error) { ShowError(error); } };
            menu.Items.Add(item);
        }
        async Task Rename()
        {
            var name = await PromptTextAsync(localization["tab.rename"]);
            if (!string.IsNullOrWhiteSpace(name)) { tab.Header = name.Trim(); AutomationProperties.SetName(tab, name.Trim()); }
        }
        if (tab.Tag is string id && sessionProfiles.TryGetValue(id, out var profile))
        {
            UpdateSessionTabState(tab, sessionsManager.Get(id).Snapshot.State);
            Action("tab.rename", Rename);
            Action("tab.duplicate", () => OpenProfileAsync(profile, duplicate: true));
            Action("tab.reconnect", () => sessionsManager.ReconnectAsync(id, CancellationToken.None));
            menu.Items.Add(new MenuFlyoutSeparator());
            tab.DoubleTapped += async (_, args) => { args.Handled = true; await Rename(); };
        }
        Action("tab.close", () => CloseSessionTabAsync(tab));
        Action("tab.closeOthers", async () =>
        {
            foreach (var item in Sessions.TabItems.OfType<TabViewItem>().Where(item => item != tab).ToArray())
            {
                await CloseSessionTabAsync(item);
                if (Sessions.TabItems.Contains(item)) break;
            }
        });
        Action("tab.closeToRight", async () =>
        {
            foreach (var item in Sessions.TabItems.OfType<TabViewItem>().Skip(Sessions.TabItems.IndexOf(tab) + 1).ToArray())
            {
                await CloseSessionTabAsync(item);
                if (Sessions.TabItems.Contains(item)) break;
            }
        });
        Action("tab.closeAll", async () =>
        {
            foreach (var item in Sessions.TabItems.OfType<TabViewItem>().ToArray())
            {
                await CloseSessionTabAsync(item);
                if (Sessions.TabItems.Contains(item)) break;
            }
        });
        tab.ContextFlyout = menu;
        tab.PointerPressed += async (_, args) =>
        {
            if (!args.GetCurrentPoint(tab).Properties.IsMiddleButtonPressed) return;
            args.Handled = true; await CloseSessionTabAsync(tab);
        };
    }

    private static void UpdateSessionTabState(TabViewItem tab, NativeSessionState state)
    {
        var color = state switch
        {
            NativeSessionState.Ready => Windows.UI.Color.FromArgb(255, 82, 196, 26),
            NativeSessionState.Closed or NativeSessionState.Failed => Windows.UI.Color.FromArgb(255, 255, 77, 79),
            _ => Windows.UI.Color.FromArgb(255, 250, 173, 20)
        };
        tab.IconSource = new FontIconSource { Glyph = "\u25CF", FontFamily = new FontFamily("Segoe UI"), FontSize = 8, Foreground = new SolidColorBrush(color) };
    }
}
