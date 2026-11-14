namespace OpenFinalShell.App;

internal readonly record struct NativeTerminalCursorGeometry(double X, double Y, double Width, double Height);

internal static class NativeTerminalCursorLayout
{
    private const double ChangeTolerance = 0.01;

    public static bool HasChanged(double previous, double current) =>
        !double.IsFinite(previous) || !double.IsFinite(current) || Math.Abs(previous - current) > ChangeTolerance;

    public static bool ShouldDraw(bool active, bool atBottom, bool cursorOn, bool composing) =>
        active && atBottom && cursorOn && !composing;

    public static NativeTerminalCursorGeometry ForCell(
        double x,
        double y,
        double width,
        double height,
        string style)
    {
        if (style == "block") return new NativeTerminalCursorGeometry(x, y, width, height);
        if (style == "underline")
        {
            var underlineHeight = Math.Min(2, height);
            return new NativeTerminalCursorGeometry(x, y + height - underlineHeight, width, underlineHeight);
        }
        return new NativeTerminalCursorGeometry(x, y, Math.Min(2, width), height);
    }
}
