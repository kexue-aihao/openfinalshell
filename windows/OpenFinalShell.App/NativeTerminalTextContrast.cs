namespace OpenFinalShell.App;

internal readonly record struct TerminalRgbColor(byte R, byte G, byte B);

internal static class NativeTerminalTextContrast
{
    internal const double MinimumContrastRatio = 4.5;
    private static readonly TerminalRgbColor Black = new(0, 0, 0);
    private static readonly TerminalRgbColor White = new(255, 255, 255);

    internal static bool UsesDefaultForeground(byte foregroundType, byte backgroundType, bool reverse) =>
        ((reverse ? backgroundType : foregroundType) & 0x06) != 0;

    internal static TerminalRgbColor Resolve(
        TerminalRgbColor foreground,
        TerminalRgbColor background,
        bool usesDefaultForeground)
    {
        if (!usesDefaultForeground || ContrastRatio(foreground, background) >= MinimumContrastRatio)
            return foreground;

        return ContrastRatio(Black, background) >= ContrastRatio(White, background) ? Black : White;
    }

    internal static double ContrastRatio(TerminalRgbColor first, TerminalRgbColor second)
    {
        var firstLuminance = RelativeLuminance(first);
        var secondLuminance = RelativeLuminance(second);
        return (Math.Max(firstLuminance, secondLuminance) + 0.05) /
            (Math.Min(firstLuminance, secondLuminance) + 0.05);
    }

    private static double RelativeLuminance(TerminalRgbColor color) =>
        0.2126 * Linearize(color.R) + 0.7152 * Linearize(color.G) + 0.0722 * Linearize(color.B);

    private static double Linearize(byte channel)
    {
        var value = channel / 255d;
        return value <= 0.04045 ? value / 12.92 : Math.Pow((value + 0.055) / 1.055, 2.4);
    }
}
