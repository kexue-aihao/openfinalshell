using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private async Task ShowStartupNoticeAsync()
    {
        NativeStartupNotice notice;
        try
        {
            notice = NativeStartupNotice.PendingLaunch(store, updateService.CurrentVersion);
        }
        catch (Exception error)
        {
            // A welcome/update message is optional; a storage hiccup must never
            // keep the native shell from starting.
            System.Diagnostics.Debug.WriteLine($"Could not read startup notice state: {error.Message}");
            return;
        }

        if (notice.Kind == NativeStartupNoticeKind.None) return;
        var firstRun = notice.Kind == NativeStartupNoticeKind.Fresh;
        var dialog = new ContentDialog
        {
            Title = firstRun
                ? localization["onboarding.welcomeTitle"]
                : localization.Format("onboarding.whatsNewTitle", ("version", notice.ToVersion)),
            Content = new ScrollViewer
            {
                Content = BuildUpdateContent(notice),
                MaxHeight = Math.Clamp(Root.XamlRoot.Size.Height * .52, 160, 480),
                Width = Math.Clamp(Root.XamlRoot.Size.Width - 100, 200, 640),
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                HorizontalScrollMode = ScrollMode.Disabled
            },
            PrimaryButtonText = localization[firstRun ? "onboarding.getStarted" : "onboarding.gotIt"],
            SecondaryButtonText = localization["onboarding.viewReleases"],
            XamlRoot = Root.XamlRoot
        };

        dialog.Resources["ContentDialogMaxWidth"] = 720d;
        try
        {
            var result = await dialog.ShowGatedAsync();
            NativeStartupNotice.AdvanceLaunch(store, updateService.CurrentVersion);
            if (result == ContentDialogResult.Secondary)
                await Windows.System.Launcher.LaunchUriAsync(new Uri("https://github.com/kexue-aihao/openfinalshell/releases"));
        }
        catch (Exception error)
        {
            System.Diagnostics.Debug.WriteLine($"Could not present startup notice: {error.Message}");
        }
    }

    private StackPanel BuildFirstRunContent()
    {
        var content = new StackPanel { Spacing = 10 };
        content.Children.Add(new TextBlock { Text = localization["onboarding.welcomeIntro"], TextWrapping = TextWrapping.Wrap, Opacity = .8 });
        content.Children.Add(new TextBlock { Text = localization["onboarding.featuresTitle"], FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Margin = new Microsoft.UI.Xaml.Thickness(0, 6, 0, 0) });
        foreach (var key in new[] { "onboarding.featureTerminal", "onboarding.featureSftp", "onboarding.featureMonitor", "onboarding.featureManage" })
            content.Children.Add(new TextBlock { Text = "•  " + localization[key], TextWrapping = TextWrapping.Wrap });

        content.Children.Add(new TextBlock { Text = localization["onboarding.shortcutsTitle"], FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Margin = new Microsoft.UI.Xaml.Thickness(0, 6, 0, 0) });
        foreach (var (keys, description) in StartupShortcuts())
            content.Children.Add(new TextBlock { Text = keys + "  ·  " + localization[description], TextWrapping = TextWrapping.Wrap });
        return content;
    }

    private StackPanel BuildUpdateContent(NativeStartupNotice notice)
    {
        var content = new StackPanel { Spacing = 10 };
        if (notice.Kind == NativeStartupNoticeKind.Fresh)
            content.Children.Add(new TextBlock { Text = localization["onboarding.welcomeIntro"], TextWrapping = TextWrapping.Wrap, Opacity = .8 });
        if (!string.IsNullOrWhiteSpace(notice.FromVersion))
            content.Children.Add(new TextBlock
            {
                Text = localization.Format("onboarding.updatedFromTo", ("from", notice.FromVersion), ("to", notice.ToVersion)),
                TextWrapping = TextWrapping.Wrap,
                Opacity = .8
            });

        var notes = NativeReleaseNotes.All
            .Where(note => NativeReleaseNotes.CompareVersions(note.Version, notice.ToVersion) <= 0)
            .OrderByDescending(note => note.Version, Comparer<string>.Create(NativeReleaseNotes.CompareVersions))
            .ToArray();
        if (notes.Length == 0)
        {
            content.Children.Add(new TextBlock { Text = localization["onboarding.noNotes"], TextWrapping = TextWrapping.Wrap, Opacity = .8 });
            return content;
        }

        var useChinese = localization.Language.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        foreach (var note in notes)
        {
            content.Children.Add(new TextBlock { Text = "v" + note.Version, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Margin = new Microsoft.UI.Xaml.Thickness(0, 5, 0, 0) });
            foreach (var item in note.Items)
            {
                var kind = item.Type.Equals("fix", StringComparison.OrdinalIgnoreCase) ? "onboarding.typeFix" : "onboarding.typeFeat";
                content.Children.Add(new TextBlock
                {
                    Text = "[" + localization[kind] + "]  " + (useChinese ? item.Zh : item.En),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Microsoft.UI.Xaml.Thickness(8, 0, 0, 0)
                });
            }
        }
        return content;
    }

    private static (string Keys, string Description)[] StartupShortcuts() =>
    [
        ("Ctrl+Shift+T", "shortcut.duplicateSession"),
        ("Ctrl+W", "shortcut.closeTab"),
        ("Ctrl+Tab", "shortcut.nextTab"),
        ("Ctrl+Shift+Tab", "shortcut.prevTab"),
        ("Alt+1…9", "shortcut.gotoTab"),
        ("Ctrl+F", "shortcut.search"),
        ("Ctrl+Shift+H", "shortcut.history"),
        ("Ctrl+Shift+C", "shortcut.copy"),
        ("Ctrl+Shift+V / Ctrl+V", "shortcut.paste"),
        ("Ctrl+C", "shortcut.sigint"),
        ("F2", "shortcut.renameFile"),
        ("Esc", "shortcut.closeOverlay")
    ];
}
