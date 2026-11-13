using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace OpenFinalShell.App.Controls;

/// <summary>Wraps variable-width command names without stretching them into table cells.</summary>
public sealed class NativeWrapPanel : Panel
{
    protected override Size MeasureOverride(Size availableSize)
    {
        double lineWidth = 0, lineHeight = 0, width = 0, height = 0;
        foreach (var child in Children)
        {
            child.Measure(new Size(availableSize.Width, double.PositiveInfinity));
            var desired = child.DesiredSize;
            if (lineWidth > 0 && lineWidth + desired.Width > availableSize.Width)
            { width = Math.Max(width, lineWidth); height += lineHeight; lineWidth = lineHeight = 0; }
            lineWidth += desired.Width; lineHeight = Math.Max(lineHeight, desired.Height);
        }
        return new Size(Math.Max(width, lineWidth), height + lineHeight);
    }
    protected override Size ArrangeOverride(Size finalSize)
    {
        double x = 0, y = 0, lineHeight = 0;
        foreach (var child in Children)
        {
            var size = child.DesiredSize;
            if (x > 0 && x + size.Width > finalSize.Width) { y += lineHeight; x = lineHeight = 0; }
            child.Arrange(new Rect(x, y, Math.Min(size.Width, finalSize.Width), size.Height));
            x += size.Width; lineHeight = Math.Max(lineHeight, size.Height);
        }
        return finalSize;
    }
}
