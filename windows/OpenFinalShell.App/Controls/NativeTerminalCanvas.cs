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
    private readonly uint[] codepointBuffer = new uint[16];
    private long? submittedAt;
    private readonly byte[] generatedOutputBuffer = new byte[64 * 1024];
    private readonly Stopwatch automationUpdateClock = Stopwatch.StartNew();
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? accessibilityTimer;
    private NativeTerminalSnapshotCell[] visibleSnapshot = new NativeTerminalSnapshotCell[1];
    private NativeTerminalSnapshotCell[] screenSnapshot = new NativeTerminalSnapshotCell[1];
    private NativeTerminalSnapshotCell[] scrollbackSnapshot = new NativeTerminalSnapshotCell[1];
    private int visibleSnapshotWidth;
    private int visibleSnapshotFirstLine;
    private int visibleSnapshotLineCount;
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
    private readonly object inactiveOutputGate = new();
    private readonly Queue<PendingOutput> inactiveOutput = new();
    private bool terminalActive = true;
    private bool inactiveDrainRunning;
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
        // The focused TSF TextBox may handle pointer events first. Keep terminal
        // selection/release working even when a drag starts over that client.
        AddHandler(PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerPressed), true);
        AddHandler(PointerMovedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerMoved), true);
        AddHandler(PointerReleasedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerReleased), true);
        AddHandler(PointerWheelChangedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler(OnPointerWheelChanged), true);
        PointerCanceled += CancelPointerSelection;
        PointerCaptureLost += CancelPointerSelection;
    }

    private void EnsureParser()
    {
        if (parser != 0) return;
#if DEBUG
        Debug.Assert(Marshal.SizeOf<NativeTerminalSnapshotCell>() == 56);
#endif
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
        lock (inactiveOutputGate)
        {
            while (inactiveOutput.TryDequeue(out var pending))
            {
                pending.Completion.TrySetException(new ObjectDisposedException(nameof(NativeTerminalCanvas)));
                pending.CancellationRegistration.Dispose();
            }
        }
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
        lock (inactiveOutputGate)
        {
            if (!terminalActive || inactiveDrainRunning || inactiveOutput.Count > 0)
            {
                var delayed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var registration = cancellation.Register(() => delayed.TrySetCanceled(cancellation));
                inactiveOutput.Enqueue(new PendingOutput(bytes, cancellation, delayed, registration));
                return delayed.Task;
            }
        }
        return EnqueueActiveOutputAsync(bytes, cancellation);
    }

    public void SetActive(bool active)
    {
        lock (inactiveOutputGate)
        {
            terminalActive = active;
            if (!active) return;
        }
        cursorOn = true;
        canvas.Invalidate();
        _ = DrainInactiveOutputAsync();
    }

    private Task EnqueueActiveOutputAsync(byte[] bytes, CancellationToken cancellation)
    {
        if (DispatcherQueue.HasThreadAccess)
        {
            return FeedBatchedAsync(bytes, cancellation);
        }
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = cancellation.Register(() => completion.TrySetCanceled(cancellation));
        _ = completion.Task.ContinueWith(_ => registration.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        if (!DispatcherQueue.TryEnqueue(async () =>
        {
            try { await FeedBatchedAsync(bytes, cancellation); completion.TrySetResult(); }
            catch (OperationCanceledException) { completion.TrySetCanceled(cancellation); }
            catch (Exception error) { completion.TrySetException(error); }
        })) completion.TrySetException(new InvalidOperationException("Terminal dispatcher is not available."));
        return completion.Task;
    }

    private async Task DrainInactiveOutputAsync()
    {
        lock (inactiveOutputGate)
        {
            if (inactiveDrainRunning || !terminalActive) return;
            inactiveDrainRunning = true;
        }
        try
        {
            while (true)
            {
                PendingOutput pending;
                lock (inactiveOutputGate)
                {
                    if (!terminalActive || !inactiveOutput.TryDequeue(out pending!)) break;
                }
                try
                {
                    await EnqueueActiveOutputAsync(pending.Bytes, pending.Cancellation);
                    pending.Completion.TrySetResult();
                }
                catch (OperationCanceledException) { pending.Completion.TrySetCanceled(pending.Cancellation); }
                catch (Exception error) { pending.Completion.TrySetException(error); }
                finally { pending.CancellationRegistration.Dispose(); }
            }
        }
        finally
        {
            lock (inactiveOutputGate) inactiveDrainRunning = false;
            lock (inactiveOutputGate)
            {
                if (terminalActive && inactiveOutput.Count > 0) _ = DrainInactiveOutputAsync();
            }
        }
    }

    private async Task FeedBatchedAsync(byte[] bytes, CancellationToken cancellation)
    {
        const int sliceSize = 8 * 1024;
        var clock = Stopwatch.StartNew();
        for (var offset = 0; offset < bytes.Length;)
        {
            cancellation.ThrowIfCancellationRequested();
            var count = Math.Min(sliceSize, bytes.Length - offset);
            Feed(bytes.AsSpan(offset, count).ToArray());
            offset += count;
            if (offset < bytes.Length && clock.ElapsedMilliseconds >= 6)
            {
                clock.Restart();
                await Task.Yield();
            }
        }
    }

    private void DrawTerminal(CanvasControl sender, CanvasDrawEventArgs args)
    {
        EnsureParser();
        if (parser == 0) return;
        RefreshDpiMetricsIfNeeded();
        var columns = ScreenColumns;
        var rows = ScreenRows;
        var screenRows = rows;
        var scrollback = CurrentScrollbackLines;
        var totalLines = scrollback + screenRows;
        var firstLine = Math.Max(0, totalLines - rows - scrollOffset);
        RefreshVisibleSnapshot(scrollback);
        for (var row = 0; row < rows; row++)
        {
            var line = firstLine + row;
            RenderTerminalRow(args.DrawingSession, row, line, scrollback, columns);
        }
        RenderTerminalCursor(args.DrawingSession);
        UpdateTerminalOverlays();
    }

    private void RefreshVisibleSnapshot(int scrollback)
    {
        var rows = ScreenRows;
        var columns = ScreenColumns;
        EnsureSnapshotCapacity(ref visibleSnapshot, rows * columns);
        EnsureSnapshotCapacity(ref screenSnapshot, rows * columns);
        if (ofs_terminal_copy_screen(parser, screenSnapshot, (nuint)screenSnapshot.Length) == 0) return;

        var firstLine = Math.Max(0, scrollback - scrollOffset);
        var scrollbackLines = Math.Min(rows, Math.Max(0, scrollback - firstLine));
        if (scrollbackLines > 0)
        {
            var count = scrollbackLines * columns;
            EnsureSnapshotCapacity(ref scrollbackSnapshot, count);
            if (ofs_terminal_copy_scrollback(parser, firstLine, scrollbackLines,
                    scrollbackSnapshot, (nuint)scrollbackSnapshot.Length) == count)
                Array.Copy(scrollbackSnapshot, 0, visibleSnapshot, 0, count);
            else
                scrollbackLines = 0;
        }
        var remaining = rows - scrollbackLines;
        if (remaining > 0)
            Array.Copy(screenSnapshot, 0, visibleSnapshot, scrollbackLines * columns, remaining * columns);
        visibleSnapshotWidth = columns;
        visibleSnapshotFirstLine = firstLine;
        visibleSnapshotLineCount = rows;
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
        for (var index = 0; index < snapshot.CodepointCount; index++)
            result.Append(ToSafeText(snapshot.CodepointAt(index)));
        return result.ToString();
    }

    private bool TryReadLogicalCell(int line, int column, out NativeTerminalSnapshotCell cell)
    {
        var offset = line - visibleSnapshotFirstLine;
        if (offset >= 0 && offset < visibleSnapshotLineCount && column >= 0 &&
            column < visibleSnapshotWidth && visibleSnapshot.Length >= visibleSnapshotWidth * visibleSnapshotLineCount)
        {
            cell = visibleSnapshot[offset * visibleSnapshotWidth + column];
            return cell.Valid != 0;
        }
        cell = default;
        return false;
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
        // Focused TextBox input is forwarded by TextChanged. This handler is
        // only a fallback for characters delivered directly to the canvas.
        if (composing || textInput.FocusState != FocusState.Unfocused) return;
        var value = args.Character;
        if (char.IsHighSurrogate(value)) { pendingHighSurrogate = value; args.Handled = true; return; }
        if (char.IsLowSurrogate(value))
        {
            if (pendingHighSurrogate is { } high)
            {
                SendCodepoint((uint)char.ConvertToUtf32(high, value), 0);
                pendingHighSurrogate = null;
            }
            ClearTextInputBuffer();
            args.Handled = true; return;
        }
        if (pendingHighSurrogate != null)
        {
            SendCodepoint(0xfffd, 0);
            pendingHighSurrogate = null;
        }
        if (!char.IsControl(value)) SendCodepoint(value, CurrentModifiers() & 3);
        ClearTextInputBuffer();
        args.Handled = true;
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
        if (parser == 0 || ofs_terminal_key(parser, key, modifiers) == 0) return;
        ClearSelection(); cursorOn = true;
        if (key == 1 && ofs_terminal_alt_screen(parser) == 0) submittedAt = Stopwatch.GetTimestamp();
        DrainGeneratedOutput();
    }

    private void SendCodepoint(uint codepoint, int modifiers)
    {
        if (parser == 0 || ofs_terminal_unichar(parser, codepoint, modifiers) == 0) return;
        ClearSelection(); cursorOn = true;
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
        if (composing) return;
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
        if (mouseTracking && parser != 0)
        {
            var mousePoint = args.GetCurrentPoint(this).Position;
            var mouseCell = PointToCell(mousePoint);
            ofs_terminal_mouse_move(parser, mouseCell.row, mouseCell.column, CurrentModifiers());
            DrainGeneratedOutput(); args.Handled = true; return;
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
        if (mouseTracking && parser != 0)
        {
            mouseTracking = false;
            var cell = PointToCell(args.GetCurrentPoint(this).Position);
            ofs_terminal_mouse_move(parser, cell.row, cell.column, CurrentModifiers());
            ofs_terminal_mouse_button(parser, activeMouseButton, 0, CurrentModifiers());
            DrainGeneratedOutput(); args.Handled = true; return;
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
        (Math.Clamp((int)((point.Y - 4) / cellHeight), 0, ScreenRows - 1), Math.Clamp((int)((point.X - 8) / cellWidth), 0, ScreenColumns - 1));

    private bool IsSelected(int line, int column)
    {
        if (selectionStart is not { } start || selectionEnd is not { } end) return false;
        var startIsFirst = start.line < end.line || start.line == end.line && start.column <= end.column;
        var first = startIsFirst ? start : end;
        var last = startIsFirst ? end : start;
        return line >= first.line && line <= last.line && (line != first.line || column >= first.column) && (line != last.line || column <= last.column);
    }

    private Task CopySelectionAsync()
    {
        var value = ReadSelection();
        if (!string.IsNullOrEmpty(value))
        {
            try
            {
                var package = new DataPackage(); package.SetText(value);
                Clipboard.SetContent(package); Clipboard.Flush();
            }
            catch { InputRejected?.Invoke(); }
        }
        return Task.CompletedTask;
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
        ClearSelection(); cursorOn = true;
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
        RefreshVisibleSnapshot(CurrentScrollbackLines);
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
                if (TryReadLogicalCell(line, column, out var snapshot))
                {
                    result.Append(ReadSnapshotText(snapshot));
                    continue;
                }
                var ok = line < scrollback
                    ? ofs_terminal_get_scrollback_cell(parser, line, column, out var cell)
                    : ofs_terminal_get_cell(parser, line - scrollback, column, out cell);
                if (ok != 0) result.Append(ReadCellText(line, column, scrollback, cell));
            }
            if (line != last.line) result.AppendLine();
        }
        return result.ToString();
    }

    /// <summary>Scans the terminal in bounded UI-thread slices so typing remains responsive.</summary>
    public async Task<int> SearchAsync(string value, bool caseSensitive, bool regex,
        CancellationToken cancellation = default)
    {
        var generation = ++searchGeneration;
        searchTerm = value ?? string.Empty;
        searchResults.Clear();
        searchByLine.Clear();
        searchIndex = -1;
        if (parser == 0 || string.IsNullOrEmpty(searchTerm))
        {
            SearchCompleted?.Invoke(0);
            return 0;
        }
        try
        {
            var columns = ScreenColumns;
            var rows = ScreenRows;
            var scrollback = CurrentScrollbackLines;
            const int batchLines = 512;
            for (var firstLine = 0; firstLine < scrollback; firstLine += batchLines)
            {
                cancellation.ThrowIfCancellationRequested();
                if (generation != searchGeneration) return 0;
                var lineCount = Math.Min(batchLines, scrollback - firstLine);
                EnsureSnapshotCapacity(ref scrollbackSnapshot, lineCount * columns);
                if (ofs_terminal_copy_scrollback(parser, firstLine, lineCount,
                        scrollbackSnapshot, (nuint)scrollbackSnapshot.Length) != lineCount * columns)
                    break;
                ScanSnapshotBatch(scrollbackSnapshot, firstLine, lineCount, columns, caseSensitive, regex);
                await Task.Yield();
            }

            cancellation.ThrowIfCancellationRequested();
            if (generation != searchGeneration) return 0;
            EnsureSnapshotCapacity(ref screenSnapshot, rows * columns);
            if (ofs_terminal_copy_screen(parser, screenSnapshot, (nuint)screenSnapshot.Length) == rows * columns)
                ScanSnapshotBatch(screenSnapshot, scrollback, rows, columns, caseSensitive, regex);
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

    private void ScanSnapshotBatch(NativeTerminalSnapshotCell[] cells, int firstLine, int lineCount,
        int columns, bool caseSensitive, bool regex)
    {
        for (var lineOffset = 0; lineOffset < lineCount; lineOffset++)
        {
            var builder = new StringBuilder(columns);
            var columnsByCharacter = new List<int>(columns);
            var endWidths = new List<int>(columns);
            for (var column = 0; column < columns; column++)
            {
                var snapshot = cells[lineOffset * columns + column];
                var text = snapshot.Valid != 0 ? ReadSnapshotText(snapshot) : " ";
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
            foreach (var match in NativeTerminalSearch.Find(lineText, searchTerm, caseSensitive, regex))
                AddSearchResult(line, match.Index, match.Length, columnsByCharacter, endWidths);
        }
    }

    private void AddSearchResult(int line, int matchIndex, int matchLength,
        IReadOnlyList<int> columnsByCharacter, IReadOnlyList<int> endWidths)
    {
        if (matchIndex < 0 || matchIndex >= columnsByCharacter.Count || matchLength <= 0) return;
        var startColumn = columnsByCharacter[matchIndex];
        var endIndex = Math.Min(columnsByCharacter.Count - 1, matchIndex + matchLength - 1);
        var endColumn = columnsByCharacter[endIndex];
        endColumn += Math.Max(1, endWidths[endIndex]);
        searchResults.Add((line, startColumn, Math.Max(1, endColumn - startColumn)));
        if (!searchByLine.TryGetValue(line, out var ranges))
            searchByLine[line] = ranges = [];
        ranges.Add((startColumn, Math.Max(1, endColumn - startColumn)));
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
                var columns = Math.Max(1, lastColumns);
                var screenRows = Math.Max(1, lastRows);
                EnsureSnapshotCapacity(ref screenSnapshot, screenRows * columns);
                if (row >= 0 && row < screenRows &&
                    ofs_terminal_copy_screen(parser, screenSnapshot, (nuint)screenSnapshot.Length) == screenRows * columns)
                {
                    for (var col = 0; col < columns; col++)
                    {
                        var snapshot = screenSnapshot[row * columns + col];
                        line.Append(snapshot.Valid == 0 || snapshot.Cell.CodePoint == 0 ? " " : ReadSnapshotText(snapshot));
                    }
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
        var result = new StringBuilder(Math.Min(rows * cols, 16_384));
        EnsureSnapshotCapacity(ref screenSnapshot, rows * cols);
        if (ofs_terminal_copy_screen(parser, screenSnapshot, (nuint)screenSnapshot.Length) != rows * cols) return;
        for (var row = 0; row < rows; row++)
        {
            if (row > 0) result.AppendLine();
            for (var col = 0; col < cols; col++)
            {
                var snapshot = screenSnapshot[row * cols + col];
                if (snapshot.Valid == 0) continue;
                result.Append(ReadSnapshotText(snapshot));
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
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_copy_screen(nint terminal, [Out] NativeTerminalSnapshotCell[] cells, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_copy_scrollback(nint terminal, int firstLine, int lineCount, [Out] NativeTerminalSnapshotCell[] cells, nuint capacity);
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

    private sealed record PendingOutput(byte[] Bytes, CancellationToken Cancellation,
        TaskCompletionSource Completion, CancellationTokenRegistration CancellationRegistration);

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

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeTerminalSnapshotCell
    {
        public NativeTerminalCell Cell;
        public byte CodepointCount;
        public byte Valid;
        public byte Reserved0;
        public byte Reserved1;
        public uint Codepoint0;
        public uint Codepoint1;
        public uint Codepoint2;
        public uint Codepoint3;
        public uint Codepoint4;
        public uint Codepoint5;
        public uint Codepoint6;
        public uint Codepoint7;

        public readonly uint CodepointAt(int index) => index switch
        {
            0 => Codepoint0,
            1 => Codepoint1,
            2 => Codepoint2,
            3 => Codepoint3,
            4 => Codepoint4,
            5 => Codepoint5,
            6 => Codepoint6,
            7 => Codepoint7,
            _ => 0
        };
    }
}
