using Microsoft.Graphics.Canvas.Text;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.Core;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;

namespace OpenFinalShell.App.Controls;

/// <summary>
/// Native parser + Win2D drawing surface. The parser is libvterm; no HTML or
/// WebView is involved. Selection, scrollback and mouse input are implemented
/// here, with device-level acceptance tracked separately.
/// </summary>
public sealed partial class NativeTerminalCanvas : UserControl, IDisposable
{
    private readonly CanvasControl canvas = new();
    private readonly TextBlock accessibleScreen = new()
    {
        Width = 1, Height = 1, Opacity = 0.01, IsHitTestVisible = false,
        TextWrapping = TextWrapping.NoWrap
    };
    private nint parser;
    private readonly CanvasTextFormat textFormat = new() { FontFamily = "Cascadia Mono", FontSize = 14, WordWrapping = CanvasWordWrapping.NoWrap };
    private readonly CanvasTextFormat cursorTextFormat = new() { FontFamily = "Cascadia Mono", FontSize = 14, WordWrapping = CanvasWordWrapping.NoWrap };
    private readonly uint[] codepointBuffer = new uint[16];
    private long? submittedAt;
    private readonly byte[] generatedOutputBuffer = new byte[64 * 1024];
    private readonly Stopwatch automationUpdateClock = Stopwatch.StartNew();
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? accessibilityTimer;
    private int scrollOffset;
    private (int line, int column)? selectionStart;
    private (int line, int column)? selectionEnd;
    private bool selecting;
    private string searchTerm = string.Empty;
    private readonly List<(int line, int column, int length)> searchResults = [];
    private int searchIndex = -1;
    private char? pendingHighSurrogate;
    private bool mouseTracking;
    private int activeMouseButton = 1;
    private int lastColumns;
    private int lastRows;
    public event Action<byte[]>? Input;
    public event Action<string>? CommandEntered;
    public event Action? SearchRequested;
    public event Action<int>? SearchCompleted;
    public event Action<int, int>? TerminalSizeChanged;
    public event Action? InputRejected;
    private readonly NativeTerminalDirectoryTracker directoryTracker = new();
    public event Action<string>? RemoteDirectoryChanged;
    public string? RemoteDirectory => directoryTracker.CurrentDirectory;
    public void ResetRemoteDirectory() => directoryTracker.Reset();
    public bool BracketedPasteEnabled => parser != 0 && ofs_terminal_bracketed_paste(parser) != 0;
    public string? GetAiPasteIssue(string value) => parser == 0
        ? "unavailable"
        : NativeAiAnswer.PrepareTerminalPaste(value, BracketedPasteEnabled).Issue;
    public int Columns => lastColumns;
    public int Rows => lastRows;

    public NativeTerminalCanvas()
    {
        var surface = new Grid();
        surface.Children.Add(canvas);
        surface.Children.Add(accessibleScreen);
        InitializeTextInput(surface);
        Content = surface;
        canvas.ClearColor = Colors.Black;
        canvas.Draw += DrawTerminal;
        Loaded += (_, _) => EnsureParser();
        PreviewKeyDown += OnKeyDown;
        CharacterReceived += OnCharacterReceived;
        SizeChanged += OnSizeChanged;
        IsTabStop = true;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(this, "Native terminal");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetHelpText(this, "Terminal output will be announced here.");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(this, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(accessibleScreen, "Visible terminal text");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(accessibleScreen, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        PointerPressed += OnPointerPressed;
        PointerMoved += OnPointerMoved;
        PointerReleased += OnPointerReleased;
        PointerWheelChanged += OnPointerWheelChanged;
    }

    private void EnsureParser()
    {
        if (parser != 0) return;
        // A shell may emit its first bytes before this canvas has entered the
        // visual tree. Start at the same size requested from SSH, then resize
        // when WinUI reports its actual layout so early output is not clipped
        // into a one-cell terminal.
        var columns = ActualWidth > 0 ? ScreenColumns : 120;
        var rows = ActualHeight > 0 ? ScreenRows : 40;
        parser = ofs_terminal_create(rows, columns);
        if (parser != 0) ApplyScrollbackLimit();
        canvas.Invalidate();
    }

    public void Dispose()
    {
        blinkTimer?.Stop();
        accessibilityTimer?.Stop();
        accessibilityTimer = null;
        ReleaseParser();
    }
    private void ReleaseParser()
    {
        if (parser == 0) return;
        ofs_terminal_destroy(parser); parser = 0;
        appliedScrollbackLimit = -1;
    }

    /// <summary>Applies one backpressured SSH chunk on the UI thread without loss.</summary>
    public Task EnqueueOutputAsync(byte[] bytes, CancellationToken cancellation = default)
    {
        if (bytes.Length == 0) return Task.CompletedTask;
        if (DispatcherQueue.HasThreadAccess)
        {
            Feed(bytes);
            return Task.CompletedTask;
        }
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = cancellation.Register(() => completion.TrySetCanceled(cancellation));
        _ = completion.Task.ContinueWith(_ => registration.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        if (!DispatcherQueue.TryEnqueue(() =>
        {
            try { Feed(bytes); completion.TrySetResult(); }
            catch (Exception error) { completion.TrySetException(error); }
        })) completion.TrySetException(new InvalidOperationException("Terminal dispatcher is not available."));
        return completion.Task;
    }

    private void DrawTerminal(CanvasControl sender, CanvasDrawEventArgs args)
    {
        EnsureParser();
        if (parser == 0) return;
        PositionTextInput();
        var columns = ScreenColumns;
        var rows = ScreenRows;
        var screenRows = rows;
        var scrollback = CurrentScrollbackLines;
        var totalLines = scrollback + screenRows;
        var firstLine = Math.Max(0, totalLines - rows - scrollOffset);
        var cells = new NativeTerminalCell[columns];
        for (var row = 0; row < rows; row++)
        {
            var line = firstLine + row;
            // Paint all backgrounds first: a wide glyph must not be erased by
            // the background of its continuation cell.
            for (var column = 0; column < columns; column++)
            {
                var ok = line < scrollback ? ofs_terminal_get_scrollback_cell(parser, line, column, out cells[column]) : ofs_terminal_get_cell(parser, line - scrollback, column, out cells[column]);
                if (ok == 0) continue;
                var cell = cells[column]; var x = 8 + column * cellWidth; var y = 4 + row * cellHeight;
                var background = ResolveColor(cell.BgType, cell.BgR, cell.BgG, cell.BgB, cell.BgIndex, terminalBackground);
                if ((cell.Attributes & 8) != 0) background = ResolveColor(cell.FgType, cell.FgR, cell.FgG, cell.FgB, cell.FgIndex, terminalForeground);
                args.DrawingSession.FillRectangle(x, y, cellWidth, cellHeight, background);
                if (IsSelected(line, column)) args.DrawingSession.FillRectangle(x, y, cellWidth, cellHeight, Windows.UI.Color.FromArgb(100, 70, 130, 220));
                if (searchResults.Any(result => result.line == line && column >= result.column && column < result.column + result.length))
                {
                    var active = searchIndex >= 0 && searchIndex < searchResults.Count && searchResults[searchIndex].line == line &&
                        column >= searchResults[searchIndex].column && column < searchResults[searchIndex].column + searchResults[searchIndex].length;
                    args.DrawingSession.FillRectangle(x, y, cellWidth, cellHeight, active
                        ? Windows.UI.Color.FromArgb(190, 255, 170, 0)
                        : Windows.UI.Color.FromArgb(100, 255, 210, 0));
                }
            }
            for (var column = 0; column < columns; column++)
            {
                var cell = cells[column];
                if (cell.CodePoint == 0xFFFFFFFFu) continue;
                var x = 8 + column * cellWidth; var y = 4 + row * cellHeight;
                var foreground = ResolveColor(cell.FgType, cell.FgR, cell.FgG, cell.FgB, cell.FgIndex, terminalForeground);
                if ((cell.Attributes & 8) != 0) foreground = ResolveColor(cell.BgType, cell.BgR, cell.BgG, cell.BgB, cell.BgIndex, terminalBackground);
                var cellText = ReadCellText(line, column, scrollback, cell);
                textFormat.FontWeight = (cell.Attributes & 1) != 0 ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.Normal;
                textFormat.FontStyle = (cell.Attributes & 4) != 0 ? Windows.UI.Text.FontStyle.Italic : Windows.UI.Text.FontStyle.Normal;
                if (!string.IsNullOrEmpty(cellText) && cellText != " ") args.DrawingSession.DrawText(cellText, new Vector2(x, y), foreground, textFormat);
                if ((cell.Attributes & 2) != 0) args.DrawingSession.DrawLine(x, y + cellHeight - 2, x + cellWidth * Math.Max(1, (int)cell.Width), y + cellHeight - 2, foreground);
                if ((cell.Attributes & 16) != 0) args.DrawingSession.DrawLine(x, y + cellHeight / 2, x + cellWidth * Math.Max(1, (int)cell.Width), y + cellHeight / 2, foreground);
            }
        }
        if (scrollOffset > 0 || !cursorOn) return;
        var cursorRow = ofs_terminal_cursor_row(parser); var cursorCol = ofs_terminal_cursor_col(parser);
        if (cursorRow >= 0 && cursorCol >= 0 && cursorCol < columns && cursorRow < rows)
        {
            var x = 8 + cursorCol * cellWidth; var y = 4 + cursorRow * cellHeight;
            switch (NativeSettings.ReadPath(preferences, "cursorStyle", "bar"))
            {
                case "block": args.DrawingSession.DrawRectangle(x, y, cellWidth, cellHeight, terminalCursor, 1); break;
                case "underline": args.DrawingSession.FillRectangle(x, y + cellHeight - 2, cellWidth, 2, terminalCursor); break;
                default: args.DrawingSession.FillRectangle(x, y, 2, cellHeight, terminalCursor); break;
            }
        }
    }

    private Windows.UI.Color ResolveColor(byte type, byte r, byte g, byte b, byte index, Windows.UI.Color fallback)
    {
        if ((type & 0x06) != 0) return fallback;
        if ((type & 0x01) == 0) return Windows.UI.Color.FromArgb(255, r, g, b);
        var palette = index < 16 ? new[] {
            Colors.Black, Colors.Maroon, Colors.Green, Colors.Olive, Colors.Navy, Colors.Purple, Colors.Teal, Colors.Silver,
            Colors.Gray, Colors.Red, Colors.Lime, Colors.Yellow, Colors.Blue, Colors.Magenta, Colors.Cyan, Colors.White
        } : null;
        if (palette != null) return ansiPalette?[index] ?? palette[index];
        if (index >= 232) { var v = (byte)(8 + (index - 232) * 10); return Windows.UI.Color.FromArgb(255, v, v, v); }
        var n = index - 16; var rr = (byte)((n / 36) == 0 ? 0 : 55 + (n / 36 - 1) * 40); var gg = (byte)(((n / 6) % 6) == 0 ? 0 : 55 + ((n / 6) % 6 - 1) * 40); var bb = (byte)((n % 6) == 0 ? 0 : 55 + (n % 6 - 1) * 40);
        return Windows.UI.Color.FromArgb(255, rr, gg, bb);
    }

    private void OnKeyDown(object sender, Microsoft.UI.Xaml.Input.KeyRoutedEventArgs args)
    {
        if (parser == 0) return;
        if (composing || (int)args.Key == 229) return;
        var modifiers = CurrentModifiers();
        var control = (modifiers & 4) != 0;
        if (control && (modifiers & 1) != 0 && args.Key == Windows.System.VirtualKey.H) { HistoryRequested?.Invoke(); args.Handled = true; return; }
        if (control && (args.Key == Windows.System.VirtualKey.Add || (int)args.Key == 187)) { Zoom(1); args.Handled = true; return; }
        if (control && (args.Key == Windows.System.VirtualKey.Subtract || (int)args.Key == 189)) { Zoom(-1); args.Handled = true; return; }
        if (control && args.Key == Windows.System.VirtualKey.F) { SearchRequested?.Invoke(); args.Handled = true; return; }
        if (control && args.Key == Windows.System.VirtualKey.C)
        {
            if (HasSelection) _ = CopySelectionAsync();
            else if ((modifiers & 1) == 0) SendCodepoint('c', modifiers);
            args.Handled = true; return;
        }
        if (control && args.Key == Windows.System.VirtualKey.V) { _ = PasteClipboardAsync(); args.Handled = true; return; }
        if (control && args.Key is >= Windows.System.VirtualKey.A and <= Windows.System.VirtualKey.Z)
        {
            SendCodepoint((uint)char.ToLowerInvariant((char)args.Key), modifiers);
            args.Handled = true; return;
        }

        var nativeKey = MapNativeKey(args.Key);
        if (nativeKey is { } key)
        {
            SendNativeKey(key, modifiers);
            args.Handled = true;
        }
    }

    private void OnCharacterReceived(UIElement sender, Microsoft.UI.Xaml.Input.CharacterReceivedRoutedEventArgs args)
    {
        if (textInput.FocusState != FocusState.Unfocused || composing) return;
        var value = args.Character;
        if (char.IsHighSurrogate(value)) { pendingHighSurrogate = value; args.Handled = true; return; }
        if (char.IsLowSurrogate(value))
        {
            if (pendingHighSurrogate is { } high)
            {
                SendCodepoint((uint)char.ConvertToUtf32(high, value), 0);
                pendingHighSurrogate = null;
            }
            args.Handled = true; return;
        }
        if (pendingHighSurrogate != null)
        {
            SendCodepoint(0xfffd, 0);
            pendingHighSurrogate = null;
        }
        if (!char.IsControl(value)) SendCodepoint(value, CurrentModifiers() & 3);
        args.Handled = true;
    }

    private static int? MapNativeKey(Windows.System.VirtualKey key) => key switch
    {
        Windows.System.VirtualKey.Enter => 1,
        Windows.System.VirtualKey.Tab => 2,
        Windows.System.VirtualKey.Back => 3,
        Windows.System.VirtualKey.Escape => 4,
        Windows.System.VirtualKey.Up => 5,
        Windows.System.VirtualKey.Down => 6,
        Windows.System.VirtualKey.Left => 7,
        Windows.System.VirtualKey.Right => 8,
        Windows.System.VirtualKey.Insert => 9,
        Windows.System.VirtualKey.Delete => 10,
        Windows.System.VirtualKey.Home => 11,
        Windows.System.VirtualKey.End => 12,
        Windows.System.VirtualKey.PageUp => 13,
        Windows.System.VirtualKey.PageDown => 14,
        Windows.System.VirtualKey.F1 => 257,
        Windows.System.VirtualKey.F2 => 258,
        Windows.System.VirtualKey.F3 => 259,
        Windows.System.VirtualKey.F4 => 260,
        Windows.System.VirtualKey.F5 => 261,
        Windows.System.VirtualKey.F6 => 262,
        Windows.System.VirtualKey.F7 => 263,
        Windows.System.VirtualKey.F8 => 264,
        Windows.System.VirtualKey.F9 => 265,
        Windows.System.VirtualKey.F10 => 266,
        Windows.System.VirtualKey.F11 => 267,
        Windows.System.VirtualKey.F12 => 268,
        _ => null
    };

    private static int CurrentModifiers()
    {
        var result = 0;
        if (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)) result |= 1;
        if (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Menu).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)) result |= 2;
        if (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)) result |= 4;
        return result;
    }

    private bool HasSelection => selectionStart is not null && selectionEnd is not null && selectionStart != selectionEnd;

    private void SendNativeKey(int key, int modifiers)
    {
        if (parser == 0 || ofs_terminal_key(parser, key, modifiers) == 0) return;
        if (key == 1 && ofs_terminal_alt_screen(parser) == 0) submittedAt = Stopwatch.GetTimestamp();
        DrainGeneratedOutput();
    }

    private void SendCodepoint(uint codepoint, int modifiers)
    {
        if (parser == 0 || ofs_terminal_unichar(parser, codepoint, modifiers) == 0) return;
        DrainGeneratedOutput();
    }

    private void DrainGeneratedOutput()
    {
        if (parser == 0) return;
        if (ofs_terminal_take_output_error(parser) != 0) InputRejected?.Invoke();
        while (true)
        {
            var count = ofs_terminal_read_output(parser, generatedOutputBuffer, (nuint)generatedOutputBuffer.Length);
            if (count == 0) break;
            var bytes = generatedOutputBuffer.AsSpan(0, checked((int)count)).ToArray();
            Input?.Invoke(bytes);
        }
    }

    private void OnSizeChanged(object sender, SizeChangedEventArgs args)
    {
        var columns = ScreenColumns;
        var rows = ScreenRows;
        if (parser != 0) { ofs_terminal_resize(parser, rows, columns); canvas.Invalidate(); }
        if (columns != lastColumns || rows != lastRows)
        {
            lastColumns = columns; lastRows = rows;
            TerminalSizeChanged?.Invoke(columns, rows);
        }
    }

    private void OnPointerPressed(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        FocusTextInput(FocusState.Pointer);
        var point = args.GetCurrentPoint(this).Position;
        var cell = PointToCell(point);
        var modifiers = CurrentModifiers();
        var forceSelection = (modifiers & 1) != 0;
        if (parser != 0 && ofs_terminal_mouse_mode(parser) != 0 && !forceSelection)
        {
            mouseTracking = true;
            ofs_terminal_mouse_move(parser, cell.row, cell.column, modifiers);
            var properties = args.GetCurrentPoint(this).Properties;
            activeMouseButton = properties.PointerUpdateKind switch
            {
                Microsoft.UI.Input.PointerUpdateKind.RightButtonPressed => 3,
                Microsoft.UI.Input.PointerUpdateKind.MiddleButtonPressed => 2,
                _ => 1
            };
            ofs_terminal_mouse_button(parser, activeMouseButton, 1, modifiers);
            DrainGeneratedOutput(); args.Handled = true; return;
        }
        if (args.GetCurrentPoint(this).Properties.IsRightButtonPressed)
        {
            if (NativeSettings.ReadPath(preferences, "rightClick", NativeSettings.DefaultTerminalRightClick) == "menu" || forceSelection) ShowContextMenu(point);
            else _ = PasteClipboardAsync();
            args.Handled = true; return;
        }
        var screenRows = ScreenRows;
        var total = CurrentScrollbackLines + screenRows;
        var first = Math.Max(0, total - screenRows - scrollOffset);
        selectionStart = (first + cell.row, cell.column);
        selectionEnd = selectionStart;
        selecting = true;
        CapturePointer(args.Pointer);
        canvas.Invalidate();
    }

    private void OnPointerMoved(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (mouseTracking && parser != 0)
        {
            var mousePoint = args.GetCurrentPoint(this).Position;
            var mouseCell = PointToCell(mousePoint);
            ofs_terminal_mouse_move(parser, mouseCell.row, mouseCell.column, CurrentModifiers());
            DrainGeneratedOutput(); args.Handled = true; return;
        }
        if (!selecting) return;
        var point = args.GetCurrentPoint(this).Position;
        var cell = PointToCell(point);
        var screenRows = ScreenRows;
        var total = CurrentScrollbackLines + screenRows;
        var first = Math.Max(0, total - screenRows - scrollOffset);
        selectionEnd = (Math.Clamp(first + cell.row, 0, Math.Max(0, total - 1)), cell.column);
        canvas.Invalidate();
    }

    private void OnPointerReleased(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (mouseTracking && parser != 0)
        {
            mouseTracking = false;
            var cell = PointToCell(args.GetCurrentPoint(this).Position);
            ofs_terminal_mouse_move(parser, cell.row, cell.column, CurrentModifiers());
            ofs_terminal_mouse_button(parser, activeMouseButton, 0, CurrentModifiers());
            DrainGeneratedOutput(); args.Handled = true; return;
        }
        selecting = false;
        if (HasSelection && NativeSettings.ReadPath(preferences, "copyOnSelect", NativeSettings.DefaultTerminalCopyOnSelect)) _ = CopySelectionAsync();
        ReleasePointerCapture(args.Pointer);
    }

    private void OnPointerWheelChanged(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (parser == 0) return;
        var delta = args.GetCurrentPoint(this).Properties.MouseWheelDelta;
        if ((CurrentModifiers() & 4) != 0) { Zoom(Math.Sign(delta)); args.Handled = true; return; }
        if (ofs_terminal_mouse_mode(parser) != 0)
        {
            var cell = PointToCell(args.GetCurrentPoint(this).Position);
            ofs_terminal_mouse_move(parser, cell.row, cell.column, CurrentModifiers());
            var button = delta > 0 ? 4 : 5;
            ofs_terminal_mouse_button(parser, button, 1, CurrentModifiers());
            ofs_terminal_mouse_button(parser, button, 0, CurrentModifiers());
            DrainGeneratedOutput(); args.Handled = true; return;
        }
        var rows = ScreenRows;
        var max = CurrentScrollbackLines;
        scrollOffset = Math.Clamp(scrollOffset - Math.Sign(delta) * 3, 0, max);
        canvas.Invalidate();
        args.Handled = true;
    }

    private (int row, int column) PointToCell(Point point) =>
        (Math.Max(0, (int)((point.Y - 4) / cellHeight)), Math.Max(0, (int)((point.X - 8) / cellWidth)));

    private bool IsSelected(int line, int column)
    {
        if (selectionStart is not { } start || selectionEnd is not { } end) return false;
        var startIsFirst = start.line < end.line || start.line == end.line && start.column <= end.column;
        var first = startIsFirst ? start : end;
        var last = startIsFirst ? end : start;
        return line >= first.line && line <= last.line && (line != first.line || column >= first.column) && (line != last.line || column <= last.column);
    }

    private async Task CopySelectionAsync()
    {
        var value = ReadSelection();
        if (string.IsNullOrEmpty(value)) return;
        var package = new DataPackage(); package.SetText(value); Clipboard.SetContent(package);
    }

    private async Task PasteClipboardAsync()
    {
        try
        {
            var view = Clipboard.GetContent();
            if (view.Contains(StandardDataFormats.Text)) await ConfirmAndPasteAsync(await view.GetTextAsync());
        }
        catch { InputRejected?.Invoke(); }
    }

    private bool SendPaste(string value)
    {
        if (parser == 0 || string.IsNullOrEmpty(value)) return false;
        var bytes = Encoding.UTF8.GetBytes(value);
        if (bytes.Length > 4 * 1024 * 1024 || ofs_terminal_paste_utf8(parser, bytes, (nuint)bytes.Length) == 0)
        {
            InputRejected?.Invoke();
            return false;
        }
        submittedAt = null; // Pasted newlines need not be shell submissions (bracketed paste).
        DrainGeneratedOutput();
        return true;
    }

    /// <summary>Fills explicitly selected AI text without sending an Enter keystroke.</summary>
    public bool TryPasteAiText(string value, out string? issue)
    {
        issue = null;
        if (parser == 0) { issue = "unavailable"; return false; }
        var prepared = NativeAiAnswer.PrepareTerminalPaste(value, BracketedPasteEnabled);
        if (!prepared.Succeeded) { issue = prepared.Issue; return false; }
        return SendPaste(prepared.Data!);
    }

    private string ReadSelection()
    {
        if (parser == 0 || selectionStart is not { } start || selectionEnd is not { } end) return string.Empty;
        var first = start.line < end.line || start.line == end.line && start.column <= end.column ? start : end;
        var last = first.line == start.line && first.column == start.column ? end : start;
        var rows = ScreenRows;
        var scrollback = CurrentScrollbackLines;
        var result = new StringBuilder();
        for (var line = first.line; line <= last.line; line++)
        {
            var from = line == first.line ? first.column : 0;
            var to = line == last.line ? last.column : Math.Max(0, ScreenColumns - 1);
            for (var column = from; column <= to; column++)
            {
                var ok = line < scrollback ? ofs_terminal_get_scrollback_cell(parser, line, column, out var cell) : ofs_terminal_get_cell(parser, line - scrollback, column, out cell);
                if (ok != 0) result.Append(ReadCellText(line, column, scrollback, cell));
            }
            if (line != last.line) result.AppendLine();
        }
        return result.ToString();
    }

    public int Search(string value) => Search(value, caseSensitive: false, regex: false);

    /// <summary>Matches Electron's case/regex options and retains every match on each line.</summary>
    public int Search(string value, bool caseSensitive, bool regex)
    {
        searchTerm = value ?? string.Empty; searchResults.Clear();
        searchIndex = -1;
        if (parser == 0 || string.IsNullOrEmpty(searchTerm)) { SearchCompleted?.Invoke(0); return 0; }
        var rows = ScreenRows;
        var columns = ScreenColumns;
        var scrollback = CurrentScrollbackLines;
        var total = scrollback + rows;
        for (var line = 0; line < total; line++)
        {
            var builder = new StringBuilder();
            var columnsByCharacter = new List<int>();
            for (var column = 0; column < columns; column++)
            {
                var ok = line < scrollback ? ofs_terminal_get_scrollback_cell(parser, line, column, out var cell) : ofs_terminal_get_cell(parser, line - scrollback, column, out cell);
                var text = ok != 0 ? ReadCellText(line, column, scrollback, cell) : " ";
                if (ok != 0 && string.IsNullOrEmpty(text) && cell.Width != 0) text = " ";
                builder.Append(text);
                for (var characterIndex = 0; characterIndex < text.Length; characterIndex++) columnsByCharacter.Add(column);
            }
            var lineText = builder.ToString();
            foreach (var match in NativeTerminalSearch.Find(lineText, searchTerm, caseSensitive, regex))
            {
                AddSearchResult(line, match.Index, match.Length, columnsByCharacter, scrollback);
            }
        }
        if (searchResults.Count > 0) { searchIndex = 0; ScrollSearchResultIntoView(); }
        canvas.Invalidate(); SearchCompleted?.Invoke(searchResults.Count); return searchResults.Count;
    }

    private void AddSearchResult(int line, int matchIndex, int matchLength, IReadOnlyList<int> columnsByCharacter, int scrollback)
    {
        if (matchIndex < 0 || matchIndex >= columnsByCharacter.Count || matchLength <= 0) return;
        var startColumn = columnsByCharacter[matchIndex];
        var endIndex = Math.Min(columnsByCharacter.Count - 1, matchIndex + matchLength - 1);
        var endColumn = columnsByCharacter[endIndex];
        if (line < scrollback)
        {
            if (ofs_terminal_get_scrollback_cell(parser, line, endColumn, out var endCell) != 0) endColumn += Math.Max(1, (int)endCell.Width);
        }
        else if (ofs_terminal_get_cell(parser, line - scrollback, endColumn, out var endCell) != 0) endColumn += Math.Max(1, (int)endCell.Width);
        searchResults.Add((line, startColumn, Math.Max(1, endColumn - startColumn)));
    }

    public int SearchNext() => MoveSearch(1);

    public int SearchPrevious() => MoveSearch(-1);

    private int MoveSearch(int delta)
    {
        if (searchResults.Count == 0) return 0;
        searchIndex = (searchIndex + delta) % searchResults.Count;
        if (searchIndex < 0) searchIndex += searchResults.Count;
        ScrollSearchResultIntoView();
        canvas.Invalidate();
        return searchIndex + 1;
    }

    private void ScrollSearchResultIntoView()
    {
        if (searchIndex < 0 || searchIndex >= searchResults.Count || parser == 0) return;
        var rows = ScreenRows;
        var total = CurrentScrollbackLines + rows;
        var line = searchResults[searchIndex].line;
        var first = Math.Max(0, total - rows - scrollOffset);
        if (line < first) scrollOffset = Math.Max(0, total - rows - line);
        else if (line >= first + rows) scrollOffset = Math.Clamp(total - rows - line, 0, CurrentScrollbackLines);
    }

    public void ScrollToBottom() { scrollOffset = 0; canvas.Invalidate(); }

    private string ReadCellText(int line, int column, int scrollback, NativeTerminalCell cell)
    {
        if (cell.Width == 0) return string.Empty;
        var count = line < scrollback
            ? ofs_terminal_get_scrollback_codepoints(parser, line, column, codepointBuffer, codepointBuffer.Length)
            : ofs_terminal_get_cell_codepoints(parser, line - scrollback, column, codepointBuffer, codepointBuffer.Length);
        if (count <= 0) return cell.CodePoint == 0 ? string.Empty : ToSafeText(cell.CodePoint);
        var builder = new StringBuilder();
        for (var i = 0; i < count; i++)
        {
            var value = codepointBuffer[i];
            if (value is >= 0xD800 and <= 0xDBFF && i + 1 < count && codepointBuffer[i + 1] is >= 0xDC00 and <= 0xDFFF)
            {
                builder.Append((char)value).Append((char)codepointBuffer[++i]);
            }
            else if (value != 0)
            {
                builder.Append(ToSafeText(value));
            }
        }
        return builder.ToString();
    }

    private static string ToSafeText(uint value) => value <= 0x10FFFF && value is not (>= 0xD800 and <= 0xDFFF) && (value & 0xFFFF) is not (0xFFFE or 0xFFFF)
        ? char.ConvertFromUtf32((int)value)
        : string.Empty;


    public void Send(string text)
    {
        if (parser == 0) return;
        SendPaste(text);
    }

    public void Feed(byte[] bytes)
    {
        if (directoryTracker.Feed(bytes) is { } directory) RemoteDirectoryChanged?.Invoke(directory);
        if (parser == 0) EnsureParser();
        if (parser != 0)
        {
            var newline = submittedAt.HasValue ? Array.IndexOf(bytes, (byte)'\n') : -1;
            if (submittedAt is { } started && (Stopwatch.GetElapsedTime(started).TotalSeconds > 5 || ofs_terminal_alt_screen(parser) != 0))
            { submittedAt = null; newline = -1; }
            if (newline >= 0)
            {
                if (newline > 0) { var prefix = bytes.AsSpan(0, newline).ToArray(); ofs_terminal_feed(parser, prefix, (nuint)prefix.Length); }
                var row = ofs_terminal_cursor_row(parser); var line = new StringBuilder();
                for (var col = 0; col < Math.Max(1, lastColumns); col++)
                {
                    if (ofs_terminal_get_cell(parser, row, col, out var cell) == 0) continue;
                    line.Append(cell.CodePoint == 0 ? " " : ReadCellText(CurrentScrollbackLines + row, col, CurrentScrollbackLines, cell));
                }
                submittedAt = null;
                if (NativeCommandHistoryCapture.ExtractEchoed(line.ToString(), ofs_terminal_alt_screen(parser) != 0) is { } command) CommandEntered?.Invoke(command);
                var suffix = bytes.AsSpan(newline).ToArray(); ofs_terminal_feed(parser, suffix, (nuint)suffix.Length);
            }
            else ofs_terminal_feed(parser, bytes, (nuint)bytes.Length);
            DrainGeneratedOutput();
            canvas.Invalidate();
            UpdateAccessibleText();
        }
    }

    private void UpdateAccessibleText()
    {
        if (parser == 0) return;
        if (automationUpdateClock.ElapsedMilliseconds < 350)
        {
            accessibilityTimer ??= DispatcherQueue.CreateTimer();
            accessibilityTimer.IsRepeating = false;
            accessibilityTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(1, 350 - automationUpdateClock.ElapsedMilliseconds));
            accessibilityTimer.Tick -= AccessibilityTimerTick;
            accessibilityTimer.Tick += AccessibilityTimerTick;
            if (!accessibilityTimer.IsRunning) accessibilityTimer.Start();
            return;
        }
        automationUpdateClock.Restart();
        var rows = ScreenRows;
        var cols = ScreenColumns;
        var scrollback = CurrentScrollbackLines;
        var result = new StringBuilder(Math.Min(rows * cols, 16_384));
        for (var row = 0; row < rows; row++)
        {
            if (row > 0) result.AppendLine();
            for (var col = 0; col < cols; col++)
            {
                var line = scrollback + row;
                if (ofs_terminal_get_cell(parser, row, col, out var cell) == 0) continue;
                result.Append(ReadCellText(line, col, scrollback, cell));
            }
        }
        accessibleScreen.Text = result.ToString().TrimEnd();
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(accessibleScreen, accessibleScreen.Text);
    }

    private void AccessibilityTimerTick(Microsoft.UI.Dispatching.DispatcherQueueTimer sender, object args)
    {
        sender.Stop();
        UpdateAccessibleText();
    }

    private int CurrentScrollbackLines => parser == 0 || ofs_terminal_alt_screen(parser) != 0 ? 0 : ofs_terminal_scrollback_lines(parser);

    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nint ofs_terminal_create(int rows, int cols);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern void ofs_terminal_destroy(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nuint ofs_terminal_feed(nint terminal, byte[] bytes, nuint length);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nuint ofs_terminal_read_text(nint terminal, byte[] buffer, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_resize(nint terminal, int rows, int cols);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_set_scrollback_limit(nint terminal, int lines);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern void ofs_terminal_clear(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_cursor_row(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_cursor_col(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_cell(nint terminal, int row, int col, out NativeTerminalCell cell);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_cell_codepoints(nint terminal, int row, int col, [Out] uint[] codepoints, int capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_scrollback_lines(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_scrollback_cell(nint terminal, int line, int col, out NativeTerminalCell cell);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_scrollback_codepoints(nint terminal, int line, int col, [Out] uint[] codepoints, int capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_key(nint terminal, int key, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_unichar(nint terminal, uint codepoint, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_paste_utf8(nint terminal, byte[] bytes, nuint length);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_mouse_mode(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_bracketed_paste(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_alt_screen(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_mouse_move(nint terminal, int row, int col, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_mouse_button(nint terminal, int button, int pressed, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nuint ofs_terminal_read_output(nint terminal, [Out] byte[] buffer, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_take_output_error(nint terminal);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeTerminalCell
    {
        public uint CodePoint;
        public byte FgType;
        public byte FgR;
        public byte FgG;
        public byte FgB;
        public byte FgIndex;
        public byte BgType;
        public byte BgR;
        public byte BgG;
        public byte BgB;
        public byte BgIndex;
        public ushort Attributes;
        public byte Width;
    }
}
