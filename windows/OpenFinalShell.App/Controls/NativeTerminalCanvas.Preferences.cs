using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Text;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using System.Globalization;
using System.Text.Json.Nodes;
using Windows.UI;

namespace OpenFinalShell.App.Controls;

public sealed partial class NativeTerminalCanvas
{
    private static readonly Lazy<JsonObject> TerminalThemes = new(() =>
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "Assets", "TerminalThemes.json");
            return File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonObject themes
                ? themes
                : new JsonObject();
        }
        catch
        {
            return new JsonObject();
        }
    });
    private float cellWidth = 8, cellHeight = 18;
    private double measuredDpi;
    private Color terminalBackground = Colors.Black, terminalForeground = Colors.Gainsboro, terminalCursor = Colors.White;
    private readonly SolidColorBrush terminalBackgroundBrush = new(Colors.Black);
    private readonly SolidColorBrush terminalForegroundBrush = new(Colors.Gainsboro);
    private readonly SolidColorBrush terminalCursorBrush = new(Colors.White);
    private Color[]? ansiPalette;
    private JsonObject preferences = new();
    private Func<string, string> localize = key => key;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? blinkTimer;
    private bool cursorOn = true;
    private int fontZoom;
    private bool pastePromptOpen;
    private int appliedScrollbackLimit = -1;
    private NativeSettings? lastConfiguredSettings;
    private ElementTheme lastConfiguredTheme;
    private double lastInputX = double.NaN, lastInputY = double.NaN;
    private double lastInputWidth = double.NaN, lastInputHeight = double.NaN;
    private double lastCursorX = double.NaN, lastCursorY = double.NaN;
    private double lastCursorWidth = double.NaN, lastCursorHeight = double.NaN;
    private string lastInputFont = string.Empty;
    private double lastInputFontSize = double.NaN;
    public event Action? HistoryRequested;
    private int ScreenColumns => Math.Max(1, (int)((ActualWidth - 16) / cellWidth));
    private int ScreenRows => Math.Max(1, (int)((ActualHeight - 8) / cellHeight));

    public void Configure(NativeSettings settings, Func<string, string> text)
    {
        if (ReferenceEquals(lastConfiguredSettings, settings) && lastConfiguredTheme == ActualTheme) return;
        lastConfiguredSettings = settings;
        lastConfiguredTheme = ActualTheme;
        localize = text;
        preferences = settings.Data["terminal"] as JsonObject ?? new();
        textFormat.FontFamily = NativeSettings.ReadPath(preferences, "fontFamily", "Cascadia Mono");
        UpdateFontMetrics();
        var themeId = NativeSettings.ReadPath(preferences, "themeId", "auto");
        if (themeId == "auto") themeId = settings.ThemeMode == "light" || settings.ThemeMode == "system" && ActualTheme == ElementTheme.Light ? "github-light" : "one-dark";
        if (TerminalThemes.Value[themeId]?["theme"] is JsonObject theme)
        {
            terminalBackground = ParseColor(theme["background"]?.GetValue<string>(), terminalBackground);
            terminalForeground = ParseColor(theme["foreground"]?.GetValue<string>(), terminalForeground);
            terminalCursor = ParseColor(theme["cursor"]?.GetValue<string>(), terminalForeground);
            ansiPalette = new[] { "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite" }
                .Select(key => ParseColor(theme[key]?.GetValue<string>(), terminalForeground)).ToArray();
        }
        terminalBackgroundBrush.Color = terminalBackground;
        terminalForegroundBrush.Color = terminalForeground;
        terminalCursorBrush.Color = terminalCursor;
        textInput.Background = terminalBackgroundBrush;
        textInput.Foreground = terminalForegroundBrush;
        canvas.ClearColor = terminalBackground;
        if (parser != 0) ApplyScrollbackLimit();
        blinkTimer ??= DispatcherQueue.CreateTimer();
        blinkTimer.Interval = TimeSpan.FromMilliseconds(530);
        blinkTimer.Tick -= BlinkCursor; blinkTimer.Tick += BlinkCursor;
        if (NativeSettings.ReadPath(preferences, "cursorBlink", true)) blinkTimer.Start(); else blinkTimer.Stop();
        cursorOn = true; canvas.Invalidate();
    }
    private void BlinkCursor(Microsoft.UI.Dispatching.DispatcherQueueTimer sender, object args)
    {
        if (!terminalActive || !IsLoaded || Visibility != Visibility.Visible) return;
        cursorOn = !cursorOn;
        PositionCursorVisual();
    }
    private void UpdateTerminalOverlays()
    {
        PositionTextInput();
        PositionCursorVisual();
    }
    private void PositionCursorVisual()
    {
        if (!terminalActive || parser == 0 || scrollOffset > 0 || !cursorOn || composing ||
            textInput.FocusState == FocusState.Unfocused)
        {
            cursorVisual.Visibility = Visibility.Collapsed;
            return;
        }
        var cursorRow = ofs_terminal_cursor_row(parser);
        var cursorColumn = ofs_terminal_cursor_col(parser);
        if (cursorRow < 0 || cursorColumn < 0 || cursorRow >= ScreenRows || cursorColumn >= ScreenColumns)
        {
            cursorVisual.Visibility = Visibility.Collapsed;
            return;
        }
        var bounds = CellSpanRect(cursorRow, cursorColumn, 1);
        var style = NativeSettings.ReadPath(preferences, "cursorStyle", "bar");
        var x = bounds.X;
        var y = bounds.Y;
        var width = style == "block" ? bounds.Width : 2;
        var height = style == "underline" ? 2 : bounds.Height;
        if (style == "underline") y = bounds.Bottom - height;
        if (Math.Abs(lastCursorX - x) > .01) { cursorVisual.Margin = new Thickness(x, cursorVisual.Margin.Top, 0, 0); lastCursorX = x; }
        if (Math.Abs(lastCursorY - y) > .01) { cursorVisual.Margin = new Thickness(cursorVisual.Margin.Left, y, 0, 0); lastCursorY = y; }
        if (Math.Abs(lastCursorWidth - width) > .01) { cursorVisual.Width = width; lastCursorWidth = width; }
        if (Math.Abs(lastCursorHeight - height) > .01) { cursorVisual.Height = height; lastCursorHeight = height; }
        cursorVisual.Background = terminalCursorBrush;
        cursorVisual.Visibility = Visibility.Visible;
    }
    private static Color ParseColor(string? value, Color fallback) => value is { Length: 7 } && value[0] == '#' && uint.TryParse(value.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb)
        ? Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb) : fallback;
    private void ApplyScrollbackLimit()
    {
        var limit = Math.Clamp(NativeSettings.ReadPath(preferences, "scrollback", 5000), 0, 100000);
        if (limit == appliedScrollbackLimit) return;
        if (ofs_terminal_set_scrollback_limit(parser, limit) == 0) InputRejected?.Invoke();
        else appliedScrollbackLimit = limit;
    }
    private void UpdateFontMetrics()
    {
        textFormat.FontSize = Math.Clamp((NativeSettings.ReadPath(preferences, "fontSize", 14f)) + fontZoom, 8, 48);
        textFormat.FontWeight = Microsoft.UI.Text.FontWeights.Normal;
        textFormat.FontStyle = Windows.UI.Text.FontStyle.Normal;
        using var layout = new CanvasTextLayout(CanvasDevice.GetSharedDevice(), "M", textFormat, 1000, 1000);
        // Keep the font's natural advance for text layout. Pixel snapping is
        // applied only to rendered rectangle boundaries, never to this metric.
        cellWidth = Math.Max(1, (float)layout.LayoutBounds.Width);
        cellHeight = Math.Max(1, textFormat.FontSize * Math.Clamp(NativeSettings.ReadPath(preferences, "lineHeight", 1.2f), 1, 3));
        measuredDpi = canvas.Dpi;
        if (parser != 0)
        {
            ofs_terminal_resize(parser, ScreenRows, ScreenColumns);
            lastColumns = ScreenColumns; lastRows = ScreenRows;
            TerminalSizeChanged?.Invoke(lastColumns, lastRows);
        }
        canvas.Invalidate();
    }
    private void RefreshDpiMetricsIfNeeded()
    {
        if (canvas.Dpi > 0 && Math.Abs(canvas.Dpi - measuredDpi) > 0.1) UpdateFontMetrics();
    }
    private void Zoom(int delta) { fontZoom = Math.Clamp(fontZoom + delta, -6, 24); UpdateFontMetrics(); }
    private void SelectAll()
    {
        selectionStart = (0, 0); selectionEnd = (CurrentScrollbackLines + ScreenRows - 1, ScreenColumns - 1); canvas.Invalidate();
        CopySelectionIfEnabled();
    }
    public void ClearScreen()
    {
        if (parser == 0) return;
        ofs_terminal_clear(parser); scrollOffset = 0; ClearSelection();
        searchResults.Clear(); searchByLine.Clear(); searchGeneration++; submittedAt = null;
        canvas.Invalidate(); UpdateAccessibleText();
    }
    private void ShowContextMenu(Windows.Foundation.Point position)
    {
        var menu = new MenuFlyout();
        void Add(string key, Action action, bool enabled = true)
        {
            var item = new MenuFlyoutItem { Text = localize(key), IsEnabled = enabled };
            item.Click += (_, _) => action(); menu.Items.Add(item);
        }
        Add("terminal.copy", () => _ = CopySelectionAsync(), HasSelection);
        Add("terminal.paste", () => _ = PasteClipboardAsync());
        Add("terminal.selectAll", SelectAll); Add("terminal.search", () => SearchRequested?.Invoke());
        Add("terminal.history", () => HistoryRequested?.Invoke()); Add("terminal.clear", ClearScreen);
        menu.ShowAt(this, position);
    }
    private async Task ConfirmAndPasteAsync(string value)
    {
        if (pastePromptOpen) return;
        if ((NativeSettings.ReadPath(preferences, "confirmMultilinePaste", true)) && value.TrimEnd('\r', '\n').IndexOfAny(['\r', '\n']) >= 0)
        {
            pastePromptOpen = true;
            try
            {
                var dialog = new ContentDialog { XamlRoot = XamlRoot, Title = localize("terminal.multilinePasteTitle"),
                    Content = localize("terminal.multilinePasteContent").Replace("{{lines}}", value.Split('\n').Length.ToString(CultureInfo.CurrentCulture)),
                    PrimaryButtonText = localize("terminal.paste"), CloseButtonText = localize("common.cancel") };
                if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
            }
            finally { pastePromptOpen = false; }
        }
        SendPaste(value);
    }
}
