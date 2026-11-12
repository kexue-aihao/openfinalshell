using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using Windows.Graphics;

namespace OpenFinalShell.App;

/// <summary>Lightweight shell shown while the encrypted store is validated.</summary>
internal sealed class StartupWindow : Window
{
    private readonly TextBlock status;

    public StartupWindow(string language)
    {
        Title = "OpenFinalShell Native";
        var localization = new Localization();
        localization.SetLanguage(language);
        status = new TextBlock
        {
            Text = localization["native.connection.preparing"],
            FontSize = 13,
            Opacity = .78,
            TextWrapping = TextWrapping.Wrap,
            TextAlignment = TextAlignment.Center
        };
        var content = new Grid
        {
            Padding = new Thickness(36),
            Background = Application.Current.Resources["ShellBackgroundBrush"] as Brush
        };
        content.Children.Add(new StackPanel
        {
            Spacing = 16,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Children =
            {
                new Image
                {
                    Source = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri("ms-appx:///Assets/OpenFinalShell.png")),
                    Width = 56,
                    Height = 56
                },
                new TextBlock
                {
                    Text = "OpenFinalShell",
                    FontSize = 20,
                    FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
                    HorizontalAlignment = HorizontalAlignment.Center
                },
                new ProgressRing { IsActive = true, Width = 24, Height = 24 },
                status
            }
        });
        Content = content;
        AppWindow.Resize(new SizeInt32(420, 280));
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
        {
            try { SystemBackdrop = new MicaBackdrop(); } catch { }
        }
    }

    public void SetStatus(string value) => status.Text = value;
}
