using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace OpenFinalShell.App.Controls;

internal static class NativeRegionMarker
{
    private static readonly HashSet<string> Countries = new(StringComparer.Ordinal)
    {
        "CN", "HK", "TW", "JP", "KR", "SG", "US", "CA", "GB", "DE", "FR", "NL", "RU", "IN", "AU", "BR"
    };

    public static FrameworkElement Create(string? code, double height = 16)
    {
        var normalized = code?.Trim() ?? "";
        var file = normalized switch
        {
            "lan" => "lan.svg",
            "globe" => "globe.svg",
            _ when Countries.Contains(normalized) => normalized + ".svg",
            _ => "globe.svg"
        };
        var width = file.EndsWith(".svg", StringComparison.Ordinal) && Countries.Contains(Path.GetFileNameWithoutExtension(file))
            ? Math.Ceiling(height * 36 / 26)
            : height;
        var source = new SvgImageSource { UriSource = new Uri($"ms-appx:///Assets/Regions/{file}", UriKind.Absolute) };
        return new Border
        {
            Width = width,
            Height = height,
            CornerRadius = new CornerRadius(2),
            BorderThickness = new Thickness(.5),
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush,
            Child = new Image { Source = source, Stretch = Microsoft.UI.Xaml.Media.Stretch.UniformToFill }
        };
    }

    public static string? EffectiveCode(string? flag, string host)
    {
        if (!string.IsNullOrWhiteSpace(flag)) return flag.Trim();
        return IsPrivateHost(host) ? "lan" : null;
    }

    private static bool IsPrivateHost(string host)
    {
        var value = host.Trim().ToLowerInvariant().Trim('[', ']');
        if (value.Length == 0) return false;
        if (value == "localhost" || value.EndsWith(".local", StringComparison.Ordinal)) return true;
        if (value == "::1" || value.StartsWith("fe80:", StringComparison.Ordinal) ||
            value.Length > 1 && value[0] == 'f' && value[1] is 'c' or 'd' && value.Contains(':')) return true;
        if (!System.Net.IPAddress.TryParse(value, out var address))
            return !value.Contains('.') && !value.Contains(':');
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
            return System.Net.IPAddress.IsLoopback(address) || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 || bytes[0] == 127 || bytes[0] == 192 && bytes[1] == 168 ||
               bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 169 && bytes[1] == 254;
    }
}
