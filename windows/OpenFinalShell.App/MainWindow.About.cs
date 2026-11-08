using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;
using System.Runtime.InteropServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private bool donationContentInitialized;

    private void ShowAbout(object sender, RoutedEventArgs args) => ActivatePage("about");

    private async void OpenAboutChangelog(object sender, RoutedEventArgs args)
    {
        if (NativeReleaseNotes.All.Count > 0)
        {
            await ShowNativeReleaseNotesAsync();
            return;
        }

        var target = updateService.Available?.NotesUri ?? new Uri("https://github.com/kexue-aihao/openfinalshell/releases");
        try
        {
            if (await Windows.System.Launcher.LaunchUriAsync(target)) return;
        }
        catch
        {
            // Fall through to the native failure dialog below.
        }
        await new ContentDialog
        {
            Title = localization["settings.openLinkFailed"],
            Content = localization["settings.openLinkFailed"],
            CloseButtonText = localization["common.close"],
            XamlRoot = Root.XamlRoot
        }.ShowGatedAsync();
    }

    private async Task ShowNativeReleaseNotesAsync()
    {
        var useChinese = localization.Language.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        var body = new StackPanel { Spacing = 14 };
        foreach (var note in NativeReleaseNotes.All)
        {
            var section = new StackPanel { Spacing = 6 };
            section.Children.Add(new TextBlock
            {
                Text = "v" + note.Version,
                FontSize = 17,
                FontWeight = Microsoft.UI.Text.FontWeights.SemiBold
            });
            foreach (var item in note.Items)
            {
                var type = item.Type.Equals("fix", StringComparison.OrdinalIgnoreCase)
                    ? localization["onboarding.typeFix"]
                    : localization["onboarding.typeFeat"];
                var text = useChinese ? item.Zh : item.En;
                section.Children.Add(new TextBlock
                {
                    Text = $"[{type}] {text}",
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(8, 0, 0, 0)
                });
            }
            body.Children.Add(section);
        }

        await new ContentDialog
        {
            Title = localization["settings.changelog"],
            Content = new ScrollViewer { Content = body, MaxHeight = 560, MaxWidth = 760 },
            CloseButtonText = localization["common.close"],
            XamlRoot = Root.XamlRoot
        }.ShowGatedAsync();
    }

    private async void OpenAboutGithub(object sender, RoutedEventArgs args)
    {
        try
        {
            await Windows.System.Launcher.LaunchUriAsync(new Uri("https://github.com/kexue-aihao/openfinalshell"));
        }
        catch
        {
            await new ContentDialog
            {
                Title = localization["settings.openLinkFailed"],
                Content = localization["settings.openLinkFailed"],
                CloseButtonText = localization["common.close"],
                XamlRoot = Root.XamlRoot
            }.ShowGatedAsync();
        }
    }

    private void ConfigureAbout()
    {
        AboutProductName.Text = localization["nativePreview.title"];
        AboutDescription.Text = localization["nativePreview.description"];
        AboutVersion.Text = localization.Format("native.update.current", ("version", updateService.CurrentVersion));
        var supportStatus = environment.Supported ? localization["platform.available"] : localization["platform.unavailable"];
        AboutEnvironment.Text = $"{environment.DisplayText} · {supportStatus} · process {RuntimeInformation.ProcessArchitecture}";
        AboutChangelogButton.Content = localization["settings.changelog"];
        AboutCheckUpdatesButton.Content = localization["native.update.check"];
        AboutGithubButton.Content = "GitHub";
        AboutUpdateStatus.Text = UpdateStatusText.Text;
        BuildDonationContent();
    }

    private void BuildDonationContent()
    {
        if (donationContentInitialized) return;
        donationContentInitialized = true;
        DonateHost.Children.Add(new TextBlock
        {
            Text = localization["donate.title"],
            FontSize = 20,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            HorizontalAlignment = HorizontalAlignment.Center
        });
        DonateHost.Children.Add(new TextBlock
        {
            Text = localization["donate.subtitle"],
            TextWrapping = TextWrapping.Wrap,
            Opacity = .75,
            HorizontalAlignment = HorizontalAlignment.Center
        });

        var methods = new (string? Label, string? LabelKey, string NoteKey, string File)[]
        {
            ("USDT", null, "donate.noteTrc20", "usdt-trc20.png"),
            ("USDT", null, "donate.notePolygon", "usdt-polygon.png"),
            ("USDT", null, "donate.noteBep20", "usdt-bep20.png"),
            ("USDT", null, "donate.noteErc20", "usdt-erc20.png"),
            ("BNB", null, "donate.noteBnb", "bnb.png"),
            ("ETH", null, "donate.noteEth", "eth.png"),
            ("POL", null, "donate.notePolygon", "pol.png"),
            (null, "donate.wechatAlipay", "donate.scanToPay", "fiat.png")
        };
        var itemsPanel = (ItemsPanelTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load(
            "<ItemsPanelTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><ItemsWrapGrid Orientation=\"Horizontal\" ItemWidth=\"154\" ItemHeight=\"190\"/></ItemsPanelTemplate>");
        var items = new ItemsControl
        {
            ItemsPanel = itemsPanel,
            HorizontalAlignment = HorizontalAlignment.Stretch
        };
        foreach (var method in methods)
        {
            var label = method.LabelKey == null ? method.Label! : localization[method.LabelKey];
            var card = new StackPanel
            {
                Width = 144,
                Spacing = 3,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            card.Children.Add(new TextBlock
            {
                Text = label,
                FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
                HorizontalAlignment = HorizontalAlignment.Center,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap
            });
            card.Children.Add(new TextBlock
            {
                Text = localization[method.NoteKey],
                FontSize = 12,
                Opacity = .75,
                HorizontalAlignment = HorizontalAlignment.Center,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap
            });
            var image = new Image { Width = 116, Height = 116, Stretch = Stretch.Uniform };
            var surface = new Border
            {
                Width = 128,
                Height = 128,
                Padding = new Thickness(5),
                Background = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 255, 255, 255)),
                BorderThickness = new Thickness(1),
                BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
                CornerRadius = NativeSceneStyle.CornerRadius("CardCornerRadius", 8),
                HorizontalAlignment = HorizontalAlignment.Center,
                Child = image
            };
            card.Children.Add(surface);
            items.Items.Add(card);
            _ = LoadDonationImageAsync(image, method.File);
        }
        DonateHost.Children.Add(items);
    }

    private static async Task LoadDonationImageAsync(Image image, string fileName)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "Donate", fileName);
        try
        {
            var file = await StorageFile.GetFileFromPathAsync(path);
            using IRandomAccessStream stream = await file.OpenReadAsync();
            var bitmap = new BitmapImage();
            await bitmap.SetSourceAsync(stream);
            image.Source = bitmap;
        }
        catch (Exception error)
        {
            System.Diagnostics.Debug.WriteLine($"Could not load local donation QR image {fileName}: {error.Message}");
        }
    }

    private void RefreshAboutUpdateStatus()
    {
        if (AboutPage.Visibility == Visibility.Visible)
            AboutUpdateStatus.Text = UpdateStatusText.Text;
    }
}
