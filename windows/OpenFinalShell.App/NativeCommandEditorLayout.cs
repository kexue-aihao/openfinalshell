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
}

internal readonly record struct NativeCommandEditorOffset(double X, double Y);

internal static class NativeCommandEditorDragPolicy
{
    internal static NativeCommandEditorOffset Clamp(
        double requestedX,
        double requestedY,
        double viewportWidth,
        double viewportHeight,
        double dialogWidth,
        double dialogHeight,
        double viewportMargin = 12d)
    {
        var maximumX = Math.Max(0, (viewportWidth - dialogWidth) / 2d - viewportMargin);
        var maximumY = Math.Max(0, (viewportHeight - dialogHeight) / 2d - viewportMargin);
        return new NativeCommandEditorOffset(
            Math.Clamp(requestedX, -maximumX, maximumX),
            Math.Clamp(requestedY, -maximumY, maximumY));
    }
}
