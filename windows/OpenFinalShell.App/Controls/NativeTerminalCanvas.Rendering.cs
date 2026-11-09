using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Text;
using Microsoft.Graphics.Canvas.UI.Xaml;
using System.Diagnostics;
using System.Numerics;
using System.Text;
using Windows.Foundation;
using Windows.UI;

namespace OpenFinalShell.App.Controls;

public sealed partial class NativeTerminalCanvas
{
    private readonly record struct TerminalPaintSpan(int StartColumn, int CellCount, Color Color)
    {
        public int EndColumn => StartColumn + CellCount;
    }

    private readonly record struct TerminalTextStyle(Color Foreground, bool Bold, bool Italic, bool Underline, bool Strike);

    private sealed record TerminalTextRun(
        int StartColumn,
        int CellCount,
        string Text,
        TerminalTextStyle Style,
        bool Wide);

    private readonly record struct TerminalDecorationSpan(
        int StartColumn,
        int CellCount,
        Color Color,
        bool Underline,
        bool Strike)
    {
        public int EndColumn => StartColumn + CellCount;
    }

    private readonly List<TerminalPaintSpan> terminalBackgroundSpans = [];
    private readonly List<TerminalPaintSpan> terminalSelectionSpans = [];
    private readonly List<TerminalPaintSpan> terminalSearchSpans = [];
    private readonly List<TerminalTextRun> terminalTextRuns = [];
    private readonly List<TerminalDecorationSpan> terminalDecorationSpans = [];
    private readonly StringBuilder terminalTextRunBuffer = new();
    private NativeTerminalCell[] terminalRowCells = new NativeTerminalCell[1];
    private bool[] terminalRowCellValid = new bool[1];
    private const float MinimumHorizontalTextScale = 0.75f;
    private const float MaximumHorizontalTextScale = 1.25f;

    private double DrawingScale
    {
        get
        {
            var dpi = canvas.Dpi;
            return dpi > 0 ? dpi / 96d : 1d;
        }
    }

    private double SnapToPhysicalPixel(double value)
    {
        var scale = DrawingScale;
        return Math.Round(value * scale, MidpointRounding.AwayFromZero) / scale;
    }

    private Rect CellSpanRect(int row, int column, int count)
    {
        var left = SnapToPhysicalPixel(8 + column * cellWidth);
        var right = SnapToPhysicalPixel(8 + (column + count) * cellWidth);
        var top = SnapToPhysicalPixel(4 + row * cellHeight);
        var bottom = SnapToPhysicalPixel(4 + (row + 1) * cellHeight);
        var minimum = 1d / DrawingScale;
        return new Rect(left, top, Math.Max(minimum, right - left), Math.Max(minimum, bottom - top));
    }

    private void EnsureTerminalRowBuffers(int columns)
    {
        if (terminalRowCells.Length >= columns) return;
        terminalRowCells = new NativeTerminalCell[columns];
        terminalRowCellValid = new bool[columns];
    }

    private void RenderTerminalRow(CanvasDrawingSession session, int row, int line, int scrollback, int columns)
    {
        EnsureTerminalRowBuffers(columns);
        terminalBackgroundSpans.Clear();
        terminalSelectionSpans.Clear();
        terminalSearchSpans.Clear();
        terminalTextRuns.Clear();
        terminalDecorationSpans.Clear();
        terminalTextRunBuffer.Clear();

        TerminalTextStyle? activeStyle = null;
        var activeStart = 0;
        var activeCells = 0;
        var activeWide = false;
        var coveredBackgroundColumn = 0;

        void FlushTextRun()
        {
            if (activeStyle is { } style && activeCells > 0 && terminalTextRunBuffer.Length > 0)
            {
                terminalTextRuns.Add(new TerminalTextRun(
                    activeStart, activeCells, terminalTextRunBuffer.ToString(), style, activeWide));
            }
            activeStyle = null;
            activeStart = 0;
            activeCells = 0;
            activeWide = false;
            terminalTextRunBuffer.Clear();
        }

        for (var column = 0; column < columns; column++)
        {
            var ok = line < scrollback
                ? ofs_terminal_get_scrollback_cell(parser, line, column, out terminalRowCells[column])
                : ofs_terminal_get_cell(parser, line - scrollback, column, out terminalRowCells[column]);
            terminalRowCellValid[column] = ok != 0;
            var cell = terminalRowCells[column];

            var background = ok == 0
                ? terminalBackground
                : ResolveColor(cell.BgType, cell.BgR, cell.BgG, cell.BgB, cell.BgIndex, terminalBackground);
            if (ok != 0 && (cell.Attributes & 8) != 0)
                background = ResolveColor(cell.FgType, cell.FgR, cell.FgG, cell.FgB, cell.FgIndex, terminalForeground);
            // libvterm records the continuation of a wide glyph as a separate
            // cell with incomplete color data. Paint the wide origin over its
            // full reported width so all CJK/emoji characters in one ANSI span
            // remain one uninterrupted colored rectangle.
            if (column >= coveredBackgroundColumn)
            {
                var backgroundCells = 1;
                if (ok != 0 && cell.CodePoint != 0xFFFFFFFFu && cell.Width > 1)
                {
                    backgroundCells = Math.Clamp((int)cell.Width, 1, columns - column);
                    coveredBackgroundColumn = column + backgroundCells;
                }
                AddPaintSpan(terminalBackgroundSpans, column, backgroundCells, background);
            }

            if (IsSelected(line, column))
                AddPaintSpan(terminalSelectionSpans, column, 1, Color.FromArgb(100, 70, 130, 220));
            if (SearchOverlayColor(line, column) is { } searchColor)
                AddPaintSpan(terminalSearchSpans, column, 1, searchColor);

            if (ok == 0 || cell.Width == 0)
            {
                FlushTextRun();
                continue;
            }
            if (cell.CodePoint == 0xFFFFFFFFu) continue;

            var cellText = ReadCellText(line, column, scrollback, cell);
            if (string.IsNullOrEmpty(cellText) || cellText == " ")
            {
                FlushTextRun();
                continue;
            }

            var foreground = ResolveColor(cell.FgType, cell.FgR, cell.FgG, cell.FgB, cell.FgIndex, terminalForeground);
            if ((cell.Attributes & 8) != 0)
                foreground = ResolveColor(cell.BgType, cell.BgR, cell.BgG, cell.BgB, cell.BgIndex, terminalBackground);
            var style = new TerminalTextStyle(
                foreground,
                Bold: (cell.Attributes & 1) != 0,
                Italic: (cell.Attributes & 4) != 0,
                Underline: (cell.Attributes & 2) != 0,
                Strike: (cell.Attributes & 16) != 0);
            var span = Math.Clamp((int)cell.Width, 1, columns - column);

            if (style.Underline || style.Strike)
                AddDecorationSpan(terminalDecorationSpans, column, span, style);

            var wide = span > 1;
            if (activeStyle != style || activeWide != wide || activeStart + activeCells != column) FlushTextRun();
            if (activeStyle is null)
            {
                activeStyle = style;
                activeStart = column;
                activeWide = wide;
            }
            terminalTextRunBuffer.Append(cellText);
            activeCells += span;
        }
        FlushTextRun();

        foreach (var span in terminalBackgroundSpans)
            session.FillRectangle(CellSpanRect(row, span.StartColumn, span.CellCount), span.Color);
        foreach (var span in terminalSelectionSpans)
            session.FillRectangle(CellSpanRect(row, span.StartColumn, span.CellCount), span.Color);
        foreach (var span in terminalSearchSpans)
            session.FillRectangle(CellSpanRect(row, span.StartColumn, span.CellCount), span.Color);

        foreach (var run in terminalTextRuns)
        {
            var bounds = CellSpanRect(row, run.StartColumn, run.CellCount);
            textFormat.FontWeight = run.Style.Bold ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.Normal;
            textFormat.FontStyle = run.Style.Italic ? Windows.UI.Text.FontStyle.Italic : Windows.UI.Text.FontStyle.Normal;
            using var layout = new CanvasTextLayout(
                CanvasDevice.GetSharedDevice(), run.Text, textFormat, (float)bounds.Width, (float)bounds.Height)
            {
                WordWrapping = CanvasWordWrapping.NoWrap,
                HorizontalAlignment = CanvasHorizontalAlignment.Left
            };
            var naturalWidth = layout.LayoutBounds.Width;
            var horizontalScale = ResolveHorizontalTextScale((float)bounds.Width, (float)naturalWidth);
            var savedTransform = session.Transform;
            using var clip = session.CreateLayer(1f, bounds);
            try
            {
                if (Math.Abs(horizontalScale - 1f) > 0.0001f)
                {
                    session.Transform =
                        Matrix3x2.CreateTranslation(-(float)bounds.X, -(float)bounds.Y) *
                        Matrix3x2.CreateScale(horizontalScale, 1f) *
                        Matrix3x2.CreateTranslation((float)bounds.X, (float)bounds.Y) *
                        savedTransform;
                }
                session.DrawTextLayout(layout, new Vector2((float)bounds.X, (float)bounds.Y), run.Style.Foreground);
            }
            finally
            {
                session.Transform = savedTransform;
            }
        }

        var stroke = (float)(1d / DrawingScale);
        foreach (var decoration in terminalDecorationSpans)
        {
            var bounds = CellSpanRect(row, decoration.StartColumn, decoration.CellCount);
            var start = new Vector2((float)bounds.X, 0);
            var end = new Vector2((float)bounds.Right, 0);
            if (decoration.Underline)
            {
                var y = (float)SnapToPhysicalPixel(bounds.Bottom - 2);
                session.DrawLine(new Vector2(start.X, y), new Vector2(end.X, y), decoration.Color, stroke);
            }
            if (decoration.Strike)
            {
                var y = (float)SnapToPhysicalPixel(bounds.Top + bounds.Height / 2);
                session.DrawLine(new Vector2(start.X, y), new Vector2(end.X, y), decoration.Color, stroke);
            }
        }
    }

    private Color? SearchOverlayColor(int line, int column)
    {
        if (searchResults.Count == 0) return null;
        if (searchIndex >= 0 && searchIndex < searchResults.Count &&
            IsSearchResultColumn(searchResults[searchIndex], line, column))
            return Color.FromArgb(190, 255, 170, 0);
        foreach (var result in searchResults)
            if (IsSearchResultColumn(result, line, column))
                return Color.FromArgb(100, 255, 210, 0);
        return null;
    }

    private static bool IsSearchResultColumn((int line, int column, int length) result, int line, int column) =>
        result.line == line && column >= result.column && column < result.column + result.length;

    private static float ResolveHorizontalTextScale(float targetWidth, float naturalWidth)
    {
        if (!float.IsFinite(targetWidth) || !float.IsFinite(naturalWidth) ||
            targetWidth <= 0 || naturalWidth <= 0.001f)
            return 1f;
        var scale = targetWidth / naturalWidth;
        if (!float.IsFinite(scale)) return 1f;
        if (scale < MinimumHorizontalTextScale || scale > MaximumHorizontalTextScale)
        {
            Debug.WriteLine(
                $"Terminal text scale outside safe range: target={targetWidth}, natural={naturalWidth}, scale={scale}");
            return 1f;
        }
        return scale;
    }

    private static void AddPaintSpan(List<TerminalPaintSpan> spans, int start, int count, Color color)
    {
        if (count <= 0) return;
        if (spans.Count > 0)
        {
            var previous = spans[^1];
            if (previous.EndColumn == start && previous.Color.Equals(color))
            {
                spans[^1] = previous with { CellCount = previous.CellCount + count };
                return;
            }
        }
        spans.Add(new TerminalPaintSpan(start, count, color));
    }

    private static void AddDecorationSpan(
        List<TerminalDecorationSpan> spans,
        int start,
        int count,
        TerminalTextStyle style)
    {
        if (spans.Count > 0)
        {
            var previous = spans[^1];
            if (previous.EndColumn == start && previous.Color.Equals(style.Foreground) &&
                previous.Underline == style.Underline && previous.Strike == style.Strike)
            {
                spans[^1] = previous with { CellCount = previous.CellCount + count };
                return;
            }
        }
        spans.Add(new TerminalDecorationSpan(start, count, style.Foreground, style.Underline, style.Strike));
    }
}
