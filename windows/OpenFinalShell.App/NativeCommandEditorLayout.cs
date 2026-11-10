namespace OpenFinalShell.App;

internal readonly record struct NativeCommandEditorLayout(
    double DialogWidth,
    double ContentHeight,
    double EditorHeight,
    double TargetsHeight,
    bool Portrait);

internal static class NativeCommandEditorLayoutPolicy
{
    internal static NativeCommandEditorLayout Resolve(double viewportWidth, double viewportHeight)
    {
        var width = double.IsFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 800;
        var height = double.IsFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 600;
        var portrait = height > width;
        var horizontalMargin = width < 600 ? 24d : 96d;
        var dialogWidth = Math.Clamp(Math.Round(width - horizontalMargin), 280d, 1120d);
        var contentHeight = Math.Clamp(Math.Round(height - (portrait ? 190d : 150d)), 260d, 760d);
        var targetsHeight = Math.Clamp(Math.Round(contentHeight * 0.24), 96d, 190d);
        var editorHeight = Math.Clamp(Math.Round(contentHeight - 250d), 180d, 520d);
        return new NativeCommandEditorLayout(dialogWidth, contentHeight, editorHeight, targetsHeight, portrait);
    }

    // Inputs and result are physical pixels. Leave room for window borders,
    // the system caption and the taskbar, including on portrait/high-DPI screens.
    internal static NativeCommandEditorWindowSize ResolveWindowSize(
        int workWidth, int workHeight, double rasterScale, double uiZoom,
        double? savedWidthDip = null, double? savedHeightDip = null)
    {
        var dpi = double.IsFinite(rasterScale) && rasterScale > 0 ? rasterScale : 1d;
        var zoom = double.IsFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1d;
        var availableWidth = Math.Max(1, workWidth - (int)Math.Ceiling(32 * dpi));
        var availableHeight = Math.Max(1, workHeight - (int)Math.Ceiling(80 * dpi));

        // Persist the actual client size in DIPs, not pixels, so a custom size
        // remains familiar when the editor is reopened on another-DPI display.
        if (savedWidthDip is > 0 && savedHeightDip is > 0
            && double.IsFinite(savedWidthDip.Value) && double.IsFinite(savedHeightDip.Value))
        {
            var minWidth = Math.Min(availableWidth, (int)Math.Ceiling(320 * dpi));
            var minHeight = Math.Min(availableHeight, (int)Math.Ceiling(280 * dpi));
            var widthDip = Math.Clamp(savedWidthDip.Value, minWidth / dpi, availableWidth / dpi);
            var heightDip = Math.Clamp(savedHeightDip.Value, minHeight / dpi, availableHeight / dpi);
            return new NativeCommandEditorWindowSize(
                Math.Clamp((int)Math.Round(widthDip * dpi), minWidth, availableWidth),
                Math.Clamp((int)Math.Round(heightDip * dpi), minHeight, availableHeight));
        }

        var layout = Resolve(availableWidth / (dpi * zoom), availableHeight / (dpi * zoom));
        return new NativeCommandEditorWindowSize(
            Math.Clamp((int)Math.Round(layout.DialogWidth * dpi * zoom), 1, availableWidth),
            Math.Clamp((int)Math.Round((layout.ContentHeight + 80) * dpi * zoom), 1, availableHeight));
    }
}

internal readonly record struct NativeCommandEditorWindowSize(int Width, int Height);
