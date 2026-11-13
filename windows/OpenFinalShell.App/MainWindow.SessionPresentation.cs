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
            if (!string.IsNullOrWhiteSpace(name) && tab.Tag is string id && sessionProfiles.TryGetValue(id, out var profile))
                UpdateSessionTabHeader(tab, profile, name.Trim());
        }
        if (tab.Tag is string id && sessionProfiles.TryGetValue(id, out var profile))
        {
            UpdateSessionTabHeader(tab, profile, SessionTabTitle(tab));
            if (sessionTerminals.ContainsKey(id)) UpdateSessionTabState(tab, sessionsManager.Get(id).Snapshot.State);
            Action("tab.rename", Rename);
            Action("tab.duplicate", () => OpenProfileAsync(profile, duplicate: true));
            if (sessionTerminals.ContainsKey(id)) Action("tab.reconnect", () => sessionsManager.ReconnectAsync(id, CancellationToken.None));
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

    private static string SessionTabTitle(TabViewItem tab) => tab.Header is StackPanel { Tag: string name } ? name : tab.Header?.ToString() ?? "";

    private void UpdateSessionTabHeader(TabViewItem tab, ConnectionProfile profile, string name)
    {
        profile = connections.Profiles.FirstOrDefault(item => item.Id == profile.Id) ?? profile;
        var code = Controls.NativeRegionMarker.EffectiveCode(profile.Data["flag"]?.GetValue<string>(), profile.Host);
        var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5, Tag = name, VerticalAlignment = VerticalAlignment.Center };
        if (code != null)
        {
            var marker = Controls.NativeRegionMarker.Create(code, 14);
            AutomationProperties.SetName(marker, localization[$"region.{code}"]);
            header.Children.Add(marker);
        }
        header.Children.Add(new TextBlock { Text = name, FontSize = 12, MaxWidth = code == null ? 120 : 100, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center });
        tab.Header = header;
        AutomationProperties.SetName(tab, name);
        ToolTipService.SetToolTip(tab, code == null ? name : $"{name} · {localization[$"region.{code}"]}");
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
