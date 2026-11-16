using Microsoft.Graphics.Canvas.Text;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.Core;
using System.Numerics;
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
public sealed partial class NativeTerminalCanvas : UserControl, IDisposable, IAsyncDisposable
{
    private readonly CanvasControl canvas = new();
    private readonly TextBlock accessibleScreen = new()
    {
        Width = 1, Height = 1, Opacity = 0.01, IsHitTestVisible = false,
        TextWrapping = TextWrapping.NoWrap
    };
    private readonly NativeTerminalProcessor processor = new();
    private TerminalViewSnapshot? view;
    private int refreshPending;
    private bool ParserReady => !terminalDisposed;
    private int CursorRow => view?.CursorRow ?? 0;
    private int CursorColumn => view?.CursorColumn ?? 0;
    private int MouseMode => view?.MouseMode ?? 0;
    private readonly CanvasTextFormat textFormat = new() { FontFamily = "Cascadia Mono", FontSize = 14, WordWrapping = CanvasWordWrapping.NoWrap };
    private readonly Stopwatch automationUpdateClock = Stopwatch.StartNew();
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? accessibilityTimer;
    private NativeTerminalSnapshotCell[] visibleSnapshot = new NativeTerminalSnapshotCell[1];
    private NativeTerminalSnapshotCell[] screenSnapshot = new NativeTerminalSnapshotCell[1];
    private int visibleSnapshotWidth;
    private int scrollOffset;
    private (int line, int column)? selectionStart;
    private (int line, int column)? selectionEnd;
    private (int line, int column)? selectionAnchor;
    private Point selectionOrigin;
    private bool selecting;
    private string searchTerm = string.Empty;
    private readonly List<(int line, int column, int length)> searchResults = [];
    private readonly Dictionary<int, List<(int column, int length)>> searchByLine = [];
    private int searchIndex = -1;
    private int searchGeneration;
    private volatile bool terminalActive = true;
    private volatile bool terminalDisposed;
    private bool drawingDisposed;
    private CancellationTokenSource? copyCancellation;
    public long RenderCount { get; private set; }
    public double RenderMilliseconds { get; private set; }
    public double MaximumRenderMilliseconds { get; private set; }
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
    public event Action<string>? RemoteDirectoryChanged;
    public string? RemoteDirectory => processor.RemoteDirectory;
    public void ResetRemoteDirectory() => Observe(processor.ResetDirectoryAsync());
    public bool BracketedPasteEnabled => view?.BracketedPaste ?? false;
    public string? GetAiPasteIssue(string value) => !ParserReady
        ? "unavailable"
        : NativeAiAnswer.PrepareTerminalPaste(value, BracketedPasteEnabled).Issue;
    public int Columns => lastColumns;
    public int Rows => lastRows;
    // The outer control can retain focus while the native text input client
    // has not acquired it. Focus retries must observe the actual text client.
    public bool HasInputFocus
    {
        get
        {
            var xamlRoot = XamlRoot;
            return xamlRoot != null && textInput.FocusState != FocusState.Unfocused &&
                ReferenceEquals(Microsoft.UI.Xaml.Input.FocusManager.GetFocusedElement(xamlRoot), textInput);
        }
    }

    public NativeTerminalCanvas()
    {
        processor.SnapshotAvailable += PublishSnapshot;
        processor.Input += bytes => Input?.Invoke(bytes);
        processor.CommandEntered += command => DispatcherQueue.TryEnqueue(() => { if (!terminalDisposed) CommandEntered?.Invoke(command); });
        processor.RemoteDirectoryChanged += path => DispatcherQueue.TryEnqueue(() => { if (!terminalDisposed) RemoteDirectoryChanged?.Invoke(path); });
        processor.Failed += _ => DispatcherQueue.TryEnqueue(() => { if (!terminalDisposed) InputRejected?.Invoke(); });
        var surface = new Grid();
        surface.Children.Add(canvas);
        surface.Children.Add(accessibleScreen);
        InitializeTextInput(surface);
        Content = surface;
        canvas.ClearColor = Colors.Black;
        canvas.Draw += DrawTerminal;
        canvas.CreateResources += (_, _) => ClearTerminalTextLayoutCache();
        PreviewKeyDown += OnKeyDown;
        CharacterReceived += OnCharacterReceived;
        SizeChanged += OnSizeChanged;
        IsTabStop = true;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(this, "Native terminal");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetHelpText(this, "Terminal output will be announced here.");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(this, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(accessibleScreen, "Visible terminal text");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(accessibleScreen, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        // The focused TSF TextBox may handle pointer events first. Keep terminal
        // selection/release working even when a drag starts over that client.
        AddHandler(PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerPressed), true);
        AddHandler(PointerMovedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerMoved), true);
        AddHandler(PointerReleasedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerReleased), true);
        AddHandler(PointerWheelChangedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerWheelChanged), true);
        PointerCanceled += CancelPointerSelection;
        PointerCaptureLost += CancelPointerSelection;
    }


    public void Dispose() { _ = DisposeAsync(); }
    public async ValueTask DisposeAsync()
    {
        if (!terminalDisposed)
        {
            terminalDisposed = true; terminalActive = false;
            copyCancellation?.Cancel();
            blinkTimer?.Stop(); accessibilityTimer?.Stop();
        }
        await processor.DisposeAsync();
        if (!drawingDisposed)
        {
            drawingDisposed = true;
            ClearTerminalTextLayoutCache(); textFormat.Dispose();
            canvas.RemoveFromVisualTree();
        }
    }

    public Task EnqueueOutputAsync(byte[] bytes, CancellationToken cancellation = default) => processor.ConsumeAsync(bytes, cancellation);
    public void SetActive(bool active)
    {
        terminalActive = active;
        if (active) { cursorOn = true; Observe(processor.SetViewportAsync(scrollOffset)); ApplyLatestSnapshot(); }
    }
    private void PublishSnapshot(TerminalViewSnapshot snapshot)
    {
        if (terminalDisposed || !terminalActive || Interlocked.CompareExchange(ref refreshPending, 1, 0) != 0) return;
        if (!DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            Volatile.Write(ref refreshPending, 0);
            if (!terminalDisposed && terminalActive) ApplyLatestSnapshot();
        })) Volatile.Write(ref refreshPending, 0);
    }
    private void ApplyLatestSnapshot()
    {
        if (processor.Latest is not { } snapshot) return;
        view = snapshot;
        visibleSnapshot = snapshot.Cells.ToArray(); screenSnapshot = snapshot.Screen.ToArray();
        visibleSnapshotWidth = snapshot.Columns;
        UpdateAccessibleText(); canvas.Invalidate();
    }
    private async void Observe(Task task)
    {
        try { await task; }
        catch (OperationCanceledException) { }
        catch (Exception) { if (!terminalDisposed) DispatcherQueue.TryEnqueue(() => InputRejected?.Invoke()); }
    }

    private void DrawTerminal(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var drawStarted = Stopwatch.GetTimestamp();
        if (!ParserReady || view == null) return;
        RefreshDpiMetricsIfNeeded();
        var columns = Math.Min(ScreenColumns, view.Columns);
        var rows = Math.Min(ScreenRows, view.Rows);
        var scrollback = CurrentScrollbackLines;
        var firstLine = view.FirstLine;
        RefreshVisibleSnapshot(scrollback);
        for (var row = 0; row < rows; row++)
        {
            var line = firstLine + row;
            RenderTerminalRow(args.DrawingSession, row, line, scrollback, columns);
        }
        RenderTerminalCursor(args.DrawingSession);
        UpdateTerminalOverlays();
        var elapsed = Stopwatch.GetElapsedTime(drawStarted).TotalMilliseconds;
        RenderCount++; RenderMilliseconds += elapsed; MaximumRenderMilliseconds = Math.Max(MaximumRenderMilliseconds, elapsed);
    }

    private void RefreshVisibleSnapshot(int scrollback)
    {
        if (view?.FirstLine != Math.Max(0, scrollback - scrollOffset)) Observe(processor.SetViewportAsync(scrollOffset));
    }

    private static void EnsureSnapshotCapacity(ref NativeTerminalSnapshotCell[] buffer, int count)
    {
        count = Math.Max(1, count);
        if (buffer.Length < count) buffer = new NativeTerminalSnapshotCell[count];
    }

    private string ReadSnapshotText(NativeTerminalSnapshotCell snapshot)
    {
        if (snapshot.Valid == 0 || snapshot.CodepointCount == 0) return string.Empty;
        var result = new StringBuilder(snapshot.CodepointCount);
        AppendSnapshotText(result, snapshot);
        return result.ToString();
    }

    private static bool HasSnapshotText(NativeTerminalSnapshotCell snapshot)
    {
        if (snapshot.Valid == 0 || snapshot.CodepointCount == 0 ||
            (snapshot.CodepointCount == 1 && snapshot.Codepoint0 == ' ')) return false;

        for (var index = 0; index < snapshot.CodepointCount; index++)
            if (IsSafeCodepoint(snapshot.CodepointAt(index))) return true;
        return false;
    }

    private static void AppendSnapshotText(StringBuilder destination, NativeTerminalSnapshotCell snapshot)
    {
        for (var index = 0; index < snapshot.CodepointCount; index++)
        {
            var value = snapshot.CodepointAt(index);
            if (!IsSafeCodepoint(value)) continue;
            if (value <= 0xFFFF)
            {
                destination.Append((char)value);
                continue;
            }

            var scalar = (int)value - 0x10000;
            destination.Append((char)(0xD800 + (scalar >> 10)));
            destination.Append((char)(0xDC00 + (scalar & 0x3FF)));
        }
    }

    private static bool IsSafeCodepoint(uint value) =>
        value <= 0x10FFFF && value is not (>= 0xD800 and <= 0xDFFF) &&
        (value & 0xFFFF) is not (0xFFFE or 0xFFFF);

    private Windows.UI.Color ResolveColor(byte type, byte r, byte g, byte b, byte index, Windows.UI.Color fallback)
    {
        if ((type & 0x06) != 0) return fallback;
        if ((type & 0x01) == 0) return Windows.UI.Color.FromArgb(255, r, g, b);
        if (index < 16) return ansiPalette?[index] ?? DefaultAnsiPalette[index];
        if (index >= 232) { var v = (byte)(8 + (index - 232) * 10); return Windows.UI.Color.FromArgb(255, v, v, v); }
        var n = index - 16; var rr = (byte)((n / 36) == 0 ? 0 : 55 + (n / 36 - 1) * 40); var gg = (byte)(((n / 6) % 6) == 0 ? 0 : 55 + ((n / 6) % 6 - 1) * 40); var bb = (byte)((n % 6) == 0 ? 0 : 55 + (n % 6 - 1) * 40);
        return Windows.UI.Color.FromArgb(255, rr, gg, bb);
    }

    private void OnKeyDown(object sender, Microsoft.UI.Xaml.Input.KeyRoutedEventArgs args)
    {
        if (!ParserReady) return;
        if (composing || (int)args.Key == 229) return;
        // Keep committed text ahead of Enter and other terminal control keys.
        CommitTextInput();
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
        // TextBox input is normally forwarded by TextChanged. If WinUI routed
        // a character here but the hidden native text client did not commit it,
        // defer the fallback until the current routed event finishes. A revision
        // check avoids sending a duplicate when TextChanged handled the key.
        if (composing) return;
        var revision = textInputRevision;
        var value = args.Character;
        var modifiers = CurrentModifiers() & 3;
        DispatcherQueue.TryEnqueue(() =>
        {
            if (!composing && textInputRevision == revision) ForwardCharacter(value, modifiers);
        });
        args.Handled = true;
    }

    private void ForwardCharacter(char value, int modifiers)
    {
        if (char.IsHighSurrogate(value)) { pendingHighSurrogate = value; return; }
        if (char.IsLowSurrogate(value))
        {
            if (pendingHighSurrogate is { } high)
            {
                SendCodepoint((uint)char.ConvertToUtf32(high, value), 0);
                pendingHighSurrogate = null;
            }
            ClearTextInputBuffer();
            return;
        }
        if (pendingHighSurrogate != null)
        {
            SendCodepoint(0xfffd, 0);
            pendingHighSurrogate = null;
        }
        if (!char.IsControl(value)) SendCodepoint(value, modifiers);
        ClearTextInputBuffer();
    }

    private void ClearTextInputBuffer()
    {
        if (clearingInput || textInput.Text.Length == 0) return;
        clearingInput = true;
        try { textInput.Text = ""; }
        finally { clearingInput = false; }
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

    private bool HasSelection => selectionStart is not null && selectionEnd is not null;

    private void ClearSelection()
    {
        selecting = false;
        selectionAnchor = selectionStart = selectionEnd = null;
        canvas.Invalidate();
    }

    private void SendNativeKey(int key, int modifiers)
    {
        ClearSelection(); cursorOn = true; Observe(processor.KeyAsync(key, modifiers));
    }
    private void SendCodepoint(uint codepoint, int modifiers)
    {
        ClearSelection(); cursorOn = true; Observe(processor.CodepointAsync(codepoint, modifiers));
    }

    private void OnSizeChanged(object sender, SizeChangedEventArgs args)
    {
        var columns = ScreenColumns;
        var rows = ScreenRows;
        if (ParserReady) { Observe(processor.ResizeAsync(rows, columns)); canvas.Invalidate(); }
        if (columns != lastColumns || rows != lastRows)
        {
            lastColumns = columns; lastRows = rows;
            TerminalSizeChanged?.Invoke(columns, rows);
        }
    }

    private void OnPointerPressed(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (composing) return;
        FocusTextInput(FocusState.Pointer);
        var point = args.GetCurrentPoint(this).Position;
        var cell = PointToCell(point);
        var modifiers = CurrentModifiers();
        var forceSelection = (modifiers & 1) != 0;
        if (ParserReady && MouseMode != 0 && !forceSelection)
        {
            mouseTracking = true;
            Observe(processor.MouseMoveAsync(cell.row, cell.column, modifiers));
            var properties = args.GetCurrentPoint(this).Properties;
            activeMouseButton = properties.PointerUpdateKind switch
            {
                Microsoft.UI.Input.PointerUpdateKind.RightButtonPressed => 3,
                Microsoft.UI.Input.PointerUpdateKind.MiddleButtonPressed => 2,
                _ => 1
            };
            Observe(processor.MouseButtonAsync(activeMouseButton, 1, modifiers));
            args.Handled = true; return;
        }
        if (args.GetCurrentPoint(this).Properties.IsRightButtonPressed)
        {
            if (NativeSettings.ReadPath(preferences, "rightClick", NativeSettings.DefaultTerminalRightClick) == "menu" || forceSelection) ShowContextMenu(point);
            else _ = PasteClipboardAsync();
            args.Handled = true; return;
        }
        if (!args.GetCurrentPoint(this).Properties.IsLeftButtonPressed) return;
        var screenRows = ScreenRows;
        var total = CurrentScrollbackLines + screenRows;
        var first = Math.Max(0, total - screenRows - scrollOffset);
        textInput.ReleasePointerCapture(args.Pointer);
        // A click only anchors a possible drag; it must never paint a selected
        // cell or overwrite the clipboard. A real drag can select one cell.
        selectionAnchor = (first + cell.row, cell.column);
        selectionOrigin = point;
        selectionStart = selectionEnd = null;
        selecting = true;
        CapturePointer(args.Pointer);
        canvas.Invalidate();
        args.Handled = true;
        // Pointer default handling/capture must finish before the TSF client
        // takes keyboard focus; otherwise a click can immediately steal it.
        DispatcherQueue.TryEnqueue(() => FocusTextInput(FocusState.Programmatic));
    }

    private void OnPointerMoved(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (mouseTracking && ParserReady)
        {
            var mousePoint = args.GetCurrentPoint(this).Position;
            var mouseCell = PointToCell(mousePoint);
            Observe(processor.MouseMoveAsync(mouseCell.row, mouseCell.column, CurrentModifiers()));
            args.Handled = true; return;
        }
        if (!selecting || selectionAnchor is not { } anchor) return;
        var point = args.GetCurrentPoint(this).Position;
        var cell = PointToCell(point);
        var screenRows = ScreenRows;
        var total = CurrentScrollbackLines + screenRows;
        var first = Math.Max(0, total - screenRows - scrollOffset);
        var end = (Math.Clamp(first + cell.row, 0, Math.Max(0, total - 1)), cell.column);
        if (!HasSelection && end == anchor && Math.Abs(point.X - selectionOrigin.X) < 4 && Math.Abs(point.Y - selectionOrigin.Y) < 4) return;
        selectionStart = anchor;
        selectionEnd = end;
        canvas.Invalidate();
        args.Handled = true;
    }

    private void OnPointerReleased(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (mouseTracking && ParserReady)
        {
            mouseTracking = false;
            var cell = PointToCell(args.GetCurrentPoint(this).Position);
            Observe(processor.MouseMoveAsync(cell.row, cell.column, CurrentModifiers()));
            Observe(processor.MouseButtonAsync(activeMouseButton, 0, CurrentModifiers()));
            args.Handled = true; return;
        }
        if (!selecting) return;
        OnPointerMoved(sender, args);
        selecting = false;
        selectionAnchor = null;
        CopySelectionIfEnabled();
        ReleasePointerCapture(args.Pointer);
        args.Handled = true;
        canvas.Invalidate();
    }

    private void CancelPointerSelection(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        // ReleasePointerCapture also raises this event after a completed drag.
        // Only an interrupted gesture should discard its unfinished selection.
        if (selecting) ClearSelection();
    }

    private void CopySelectionIfEnabled()
    {
        if (HasSelection && NativeSettings.ReadPath(preferences, "copyOnSelect", NativeSettings.DefaultTerminalCopyOnSelect)) _ = CopySelectionAsync();
    }

    private void OnPointerWheelChanged(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs args)
    {
        if (!ParserReady) return;
        var delta = args.GetCurrentPoint(this).Properties.MouseWheelDelta;
        if ((CurrentModifiers() & 4) != 0) { Zoom(Math.Sign(delta)); args.Handled = true; return; }
        if (MouseMode != 0)
        {
            var cell = PointToCell(args.GetCurrentPoint(this).Position);
            Observe(processor.MouseMoveAsync(cell.row, cell.column, CurrentModifiers()));
            var button = delta > 0 ? 4 : 5;
            Observe(processor.MouseButtonAsync(button, 1, CurrentModifiers()));
            Observe(processor.MouseButtonAsync(button, 0, CurrentModifiers()));
            args.Handled = true; return;
        }
        var rows = ScreenRows;
        var max = CurrentScrollbackLines;
        scrollOffset = Math.Clamp(scrollOffset - Math.Sign(delta) * 3, 0, max);
        canvas.Invalidate();
        args.Handled = true;
    }

    private (int row, int column) PointToCell(Point point) =>
        (Math.Clamp((int)((point.Y - 4) / cellHeight), 0, ScreenRows - 1), Math.Clamp((int)((point.X - 8) / cellWidth), 0, ScreenColumns - 1));

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
        var cancellation = new CancellationTokenSource();
        var previous = Interlocked.Exchange(ref copyCancellation, cancellation);
        previous?.Cancel();
        try
        {
            var value = await ReadSelectionAsync(cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            if (!terminalDisposed && !string.IsNullOrEmpty(value))
            {
                var package = new DataPackage(); package.SetText(value);
                Clipboard.SetContent(package); Clipboard.Flush();
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) when (terminalDisposed) { }
        catch { if (!terminalDisposed) InputRejected?.Invoke(); }
        finally { Interlocked.CompareExchange(ref copyCancellation, null, cancellation); cancellation.Dispose(); }
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
        if (!ParserReady || string.IsNullOrEmpty(value)) return false;
        var bytes = Encoding.UTF8.GetBytes(value);
        if (bytes.Length > 4 * 1024 * 1024)
        {
            InputRejected?.Invoke();
            return false;
        }
        Observe(processor.PasteAsync(bytes));
        ClearSelection(); cursorOn = true;
        return true;
    }

    /// <summary>Fills explicitly selected AI text without sending an Enter keystroke.</summary>
    public bool TryPasteAiText(string value, out string? issue)
    {
        issue = null;
        if (!ParserReady) { issue = "unavailable"; return false; }
        var prepared = NativeAiAnswer.PrepareTerminalPaste(value, BracketedPasteEnabled);
        if (!prepared.Succeeded) { issue = prepared.Issue; return false; }
        return SendPaste(prepared.Data!);
    }

    private async Task<string> ReadSelectionAsync(CancellationToken cancellation = default)
    {
        if (selectionStart is not { } start || selectionEnd is not { } end) return string.Empty;
        var snapshot = await processor.SnapshotAsync(cancellation);
        var first = start.line < end.line || start.line == end.line && start.column <= end.column ? start : end;
        var last = first == start ? end : start;
        var result = new StringBuilder();
        for (var line = first.line; line <= last.line; line += 128)
        {
            var count = Math.Min(128, last.line - line + 1);
            var batch = await processor.ReadHistoryAsync(line, count, cancellation);
            var cells = batch.Cells;
            if (batch.Columns != snapshot.Columns) throw new OperationCanceledException("Terminal resized during selection copy.");
            for (var row = 0; row < count; row++)
            {
                var from = line + row == first.line ? first.column : 0;
                var to = line + row == last.line ? last.column : snapshot.Columns - 1;
                for (var column = Math.Max(0, from); column <= Math.Min(to, snapshot.Columns - 1); column++)
                    if (row * snapshot.Columns + column < cells.Length) result.Append(ReadSnapshotText(cells[row * snapshot.Columns + column]));
                if (line + row != last.line) result.AppendLine();
            }
        }
        return result.ToString();
    }

    /// <summary>Reads detached terminal history in cancellable bounded batches.</summary>
    public async Task<int> SearchAsync(string value, bool caseSensitive, bool regex,
        CancellationToken cancellation = default)
    {
        var generation = ++searchGeneration;
        searchTerm = value ?? string.Empty;
        searchResults.Clear();
        searchByLine.Clear();
        searchIndex = -1;
        if (!ParserReady || string.IsNullOrEmpty(searchTerm))
        {
            SearchCompleted?.Invoke(0);
            return 0;
        }
        try
        {
            var snapshot = await processor.SnapshotAsync(cancellation);
            var columns = snapshot.Columns;
            var total = snapshot.ScrollbackLines + snapshot.Rows;
            const int batchLines = 128;
            for (var firstLine = 0; firstLine < total; firstLine += batchLines)
            {
                cancellation.ThrowIfCancellationRequested();
                if (generation != searchGeneration) return 0;
                var lineCount = Math.Min(batchLines, total - firstLine);
                var batch = await processor.ReadHistoryAsync(firstLine, lineCount, cancellation);
                if (batch.Columns != columns) throw new OperationCanceledException("Terminal resized during search.");
                var query = searchTerm;
                var matches = await Task.Run(() => ScanSnapshotBatch(batch.Cells, firstLine, lineCount, columns, query, caseSensitive, regex, cancellation), cancellation);
                if (generation != searchGeneration) return 0;
                foreach (var match in matches)
                {
                    searchResults.Add(match);
                    if (!searchByLine.TryGetValue(match.line, out var ranges)) searchByLine[match.line] = ranges = [];
                    ranges.Add((match.column, match.length));
                }
            }
            if (searchResults.Count > 0)
            {
                searchIndex = 0;
                ScrollSearchResultIntoView();
            }
            canvas.Invalidate();
            SearchCompleted?.Invoke(searchResults.Count);
            return searchResults.Count;
        }
        catch (OperationCanceledException)
        {
            if (generation == searchGeneration)
            {
                searchResults.Clear();
                searchByLine.Clear();
                searchIndex = -1;
                canvas.Invalidate();
            }
            throw;
        }
    }

    private static List<(int line, int column, int length)> ScanSnapshotBatch(System.Collections.Immutable.ImmutableArray<NativeTerminalSnapshotCell> cells,
        int firstLine, int lineCount, int columns, string query, bool caseSensitive, bool regex, CancellationToken cancellation)
    {
        var results = new List<(int line, int column, int length)>();
        for (var lineOffset = 0; lineOffset < lineCount; lineOffset++)
        {
            cancellation.ThrowIfCancellationRequested();
            var builder = new StringBuilder(columns);
            var columnsByCharacter = new List<int>(columns);
            var endWidths = new List<int>(columns);
            for (var column = 0; column < columns; column++)
            {
                var snapshot = cells[lineOffset * columns + column];
                var text = snapshot.Valid != 0 ? NativeTerminalProcessor.CellText(snapshot) : " ";
                if (snapshot.Valid != 0 && text.Length == 0 && snapshot.Cell.Width != 0) text = " ";
                builder.Append(text);
                for (var characterIndex = 0; characterIndex < text.Length; characterIndex++)
                {
                    columnsByCharacter.Add(column);
                    endWidths.Add(Math.Max(1, (int)snapshot.Cell.Width));
                }
            }
            var line = firstLine + lineOffset;
            var lineText = builder.ToString();
            foreach (var match in NativeTerminalSearch.Find(lineText, query, caseSensitive, regex))
            {
                if (match.Index < 0 || match.Index >= columnsByCharacter.Count || match.Length <= 0) continue;
                var start = columnsByCharacter[match.Index];
                var endIndex = Math.Min(columnsByCharacter.Count - 1, match.Index + match.Length - 1);
                var end = columnsByCharacter[endIndex] + Math.Max(1, endWidths[endIndex]);
                results.Add((line, start, Math.Max(1, end - start)));
            }
        }
        return results;
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
        if (searchIndex < 0 || searchIndex >= searchResults.Count || !ParserReady) return;
        var rows = ScreenRows;
        var total = CurrentScrollbackLines + rows;
        var line = searchResults[searchIndex].line;
        var first = Math.Max(0, total - rows - scrollOffset);
        if (line < first) scrollOffset = Math.Max(0, total - rows - line);
        else if (line >= first + rows) scrollOffset = Math.Clamp(total - rows - line, 0, CurrentScrollbackLines);
    }

    public void ScrollToBottom() { scrollOffset = 0; canvas.Invalidate(); }

    public void Send(string text) => SendPaste(text);
    public void Feed(byte[] bytes) => Observe(EnqueueOutputAsync(bytes));

    private void UpdateAccessibleText()
    {
        if (!ParserReady) return;
        if (automationUpdateClock.ElapsedMilliseconds < 350)
        {
            if (accessibilityTimer == null)
            {
                accessibilityTimer = DispatcherQueue.CreateTimer();
                accessibilityTimer.IsRepeating = false;
                accessibilityTimer.Tick += AccessibilityTimerTick;
            }
            accessibilityTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(1, 350 - automationUpdateClock.ElapsedMilliseconds));
            if (!accessibilityTimer.IsRunning) accessibilityTimer.Start();
            return;
        }
        automationUpdateClock.Restart();
        var rows = ScreenRows;
        var cols = ScreenColumns;
        var result = new StringBuilder(Math.Min(rows * cols, 16_384));
        EnsureSnapshotCapacity(ref screenSnapshot, rows * cols);
        if (view is not { } currentView) return;
        rows = currentView.Rows; cols = currentView.Columns;
        screenSnapshot = currentView.Screen.ToArray();
        for (var row = 0; row < rows; row++)
        {
            if (row > 0) result.AppendLine();
            for (var col = 0; col < cols; col++)
            {
                var snapshot = screenSnapshot[row * cols + col];
                if (snapshot.Valid == 0) continue;
                AppendSnapshotText(result, snapshot);
            }
        }
        var text = result.ToString().TrimEnd();
        if (accessibleScreen.Text == text) return;
        accessibleScreen.Text = text;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(accessibleScreen, accessibleScreen.Text);
    }

    private void AccessibilityTimerTick(Microsoft.UI.Dispatching.DispatcherQueueTimer sender, object args)
    {
        sender.Stop();
        UpdateAccessibleText();
    }

    private int CurrentScrollbackLines => view?.ScrollbackLines ?? 0;

}
