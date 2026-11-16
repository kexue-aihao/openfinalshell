using System.Collections.Immutable;
using System.Diagnostics;
using System.Text;
using System.Threading.Channels;

namespace OpenFinalShell.Core;

public sealed record TerminalViewSnapshot(long Version, int Rows, int Columns, int ScrollbackLines,
    int FirstLine, int CursorRow, int CursorColumn, bool AlternateScreen, bool BracketedPaste,
    int MouseMode, ImmutableArray<NativeTerminalSnapshotCell> Cells,
    ImmutableArray<NativeTerminalSnapshotCell> Screen);
public sealed record TerminalHistoryBatch(int FirstLine, int Columns, ImmutableArray<NativeTerminalSnapshotCell> Cells);

/// <summary>Single owner of libvterm. No work in this class depends on a UI dispatcher.</summary>
public sealed partial class NativeTerminalProcessor : IAsyncDisposable
{
    private sealed record Work(Action Action, TaskCompletionSource Completion, CancellationToken Token);
    private sealed record OutputWork(byte[] Bytes, TaskCompletionSource Completion, CancellationToken Token);
    private readonly Channel<Work> commands = Channel.CreateBounded<Work>(new BoundedChannelOptions(128)
    { SingleReader = true, AllowSynchronousContinuations = false });
    // The session owns the 2 MiB receive queue. Only one parsed completion is
    // outstanding at this boundary; direct users get the same bounded behavior.
    private readonly Channel<OutputWork> output = Channel.CreateBounded<OutputWork>(new BoundedChannelOptions(1)
    { SingleReader = true, AllowSynchronousContinuations = false });
    private readonly SemaphoreSlim wake = new(0, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly Task worker;
    private readonly NativeTerminalDirectoryTracker directory = new();
    private readonly byte[] generated = new byte[64 * 1024];
    private nint parser;
    private int rows, columns, scrollOffset, scrollbackLimit;
    private long version, parsedBytes, parseTicks, snapshotTicks;
    private long visibleVersion;
    private long? submittedAt;
    private bool dirty = true;
    private int disposed;
    private TerminalViewSnapshot? latest;
    public TerminalViewSnapshot? Latest => Volatile.Read(ref latest);
    public long ParsedBytes => Interlocked.Read(ref parsedBytes);
    public TimeSpan ParseTime => TimeSpan.FromSeconds((double)Interlocked.Read(ref parseTicks) / Stopwatch.Frequency);
    public event Action<TerminalViewSnapshot>? SnapshotAvailable;
    public event Action<byte[]>? Input;
    public event Action<string>? CommandEntered;
    public event Action<string>? RemoteDirectoryChanged;
    public event Action<Exception>? Failed;
    public string? RemoteDirectory => directory.CurrentDirectory;

    public NativeTerminalProcessor(int rows = 40, int columns = 120, int scrollbackLimit = 5000)
    {
        this.rows = rows; this.columns = columns; this.scrollbackLimit = scrollbackLimit;
        worker = Task.Run(RunAsync);
    }
    private void Signal() { try { wake.Release(); } catch (SemaphoreFullException) { } }
    public async Task ConsumeAsync(byte[] bytes, CancellationToken cancellation = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        // Bound individual submissions, including callers outside NativeSession.
        for (var offset = 0; offset < bytes.Length; offset += 32 * 1024)
        {
            var count = Math.Min(32 * 1024, bytes.Length - offset);
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await output.Writer.WriteAsync(new(bytes.AsSpan(offset, count).ToArray(), completion, linked.Token), linked.Token).ConfigureAwait(false);
            Signal();
            await completion.Task.WaitAsync(linked.Token).ConfigureAwait(false);
        }
    }
    private Task Post(Action action, CancellationToken cancellation = default)
    {
        if (Volatile.Read(ref disposed) != 0) return Task.FromException(new ObjectDisposedException(nameof(NativeTerminalProcessor)));
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // UI commands never wait behind a full queue or accumulate blocked writers.
        if (!commands.Writer.TryWrite(new(action, completion, cancellation)))
            return Task.FromException(new InvalidOperationException("Terminal interaction queue is full."));
        Signal(); return completion.Task;
    }
    public Task KeyAsync(int key, int modifiers) => Post(() =>
    {
        if (key == 1 && ofs_terminal_alt_screen(parser) == 0) submittedAt = Stopwatch.GetTimestamp();
        ofs_terminal_key(parser, key, modifiers); DrainInput();
    });
    public Task CodepointAsync(uint value, int modifiers) => Post(() => { ofs_terminal_unichar(parser, value, modifiers); DrainInput(); });
    public Task TextAsync(string text, int modifiers) => Post(() =>
    {
        foreach (var rune in text.EnumerateRunes())
            if (!Rune.IsControl(rune)) ofs_terminal_unichar(parser, (uint)rune.Value, modifiers);
        DrainInput();
    });
    public Task PasteAsync(byte[] bytes) => Post(() =>
    {
        submittedAt = null;
        if (ofs_terminal_paste_utf8(parser, bytes, (nuint)bytes.Length) == 0) throw new IOException("Terminal paste rejected.");
        DrainInput();
    });
    public Task MouseMoveAsync(int row, int column, int modifiers) => Post(() => { ofs_terminal_mouse_move(parser, row, column, modifiers); DrainInput(); });
    public Task MouseButtonAsync(int button, int pressed, int modifiers) => Post(() => { ofs_terminal_mouse_button(parser, button, pressed, modifiers); DrainInput(); });
    public Task ResizeAsync(int newRows, int newColumns) => Post(() =>
    {
        if (newRows == rows && newColumns == columns) return;
        if (ofs_terminal_resize(parser, newRows, newColumns) == 0) throw new IOException("Terminal resize failed.");
        rows = newRows; columns = newColumns; dirty = true;
    });
    public Task SetScrollbackLimitAsync(int limit) => Post(() =>
    {
        if (ofs_terminal_set_scrollback_limit(parser, limit) == 0) throw new IOException("Terminal scrollback limit failed.");
        scrollbackLimit = limit; dirty = true;
    });
    public Task SetViewportAsync(int offset) => Post(() => { scrollOffset = offset; dirty = true; });
    public Task ResetDirectoryAsync() => Post(directory.Reset);
    public Task ClearAsync() => Post(() => { ofs_terminal_clear(parser); submittedAt = null; scrollOffset = 0; dirty = true; });
    public async Task<ImmutableArray<NativeTerminalSnapshotCell>> ReadLinesAsync(int first, int count, CancellationToken cancellation = default)
        => (await ReadHistoryAsync(first, count, cancellation).ConfigureAwait(false)).Cells;
    public async Task<TerminalHistoryBatch> ReadHistoryAsync(int first, int count, CancellationToken cancellation = default)
    {
        if (count is < 0 or > 512) throw new ArgumentOutOfRangeException(nameof(count));
        if (first < 0) throw new ArgumentOutOfRangeException(nameof(first));
        TerminalHistoryBatch? result = null;
        await Post(() => result = new(first, columns, CopyLines(first, count).ToImmutableArray()), cancellation).WaitAsync(cancellation).ConfigureAwait(false);
        return result!;
    }
    public async Task<TerminalViewSnapshot> SnapshotAsync(CancellationToken cancellation = default)
    {
        TerminalViewSnapshot? result = null;
        await Post(() => result = Capture(), cancellation).WaitAsync(cancellation).ConfigureAwait(false);
        return result!;
    }
    private async Task RunAsync()
    {
        Exception? failure = null;
        try
        {
            parser = ofs_terminal_create(rows, columns);
            if (parser == 0) throw new IOException("Cannot create terminal parser.");
            if (ofs_terminal_set_scrollback_limit(parser, scrollbackLimit) == 0) throw new IOException("Terminal scrollback allocation failed.");
            while (!lifetime.IsCancellationRequested)
            {
                DrainCommands();
                if (output.Reader.TryRead(out var pending))
                {
                    try
                    {
                        var budget = Stopwatch.GetTimestamp();
                        for (var offset = 0; offset < pending.Bytes.Length; offset += 2048)
                        {
                            lifetime.Token.ThrowIfCancellationRequested(); pending.Token.ThrowIfCancellationRequested();
                            var bytes = pending.Bytes.AsSpan(offset, Math.Min(2048, pending.Bytes.Length - offset)).ToArray();
                            var started = Stopwatch.GetTimestamp();
                            Feed(bytes);
                            Interlocked.Add(ref parseTicks, Stopwatch.GetTimestamp() - started);
                            Interlocked.Add(ref parsedBytes, bytes.Length);
                            if (Stopwatch.GetElapsedTime(budget).TotalMilliseconds >= 2)
                            { DrainCommands(); budget = Stopwatch.GetTimestamp(); }
                        }
                        pending.Completion.TrySetResult();
                    }
                    catch (OperationCanceledException) { pending.Completion.TrySetCanceled(); }
                    catch (Exception error) { pending.Completion.TrySetException(error); throw; }
                }
                if (dirty && Stopwatch.GetElapsedTime(snapshotTicks).TotalMilliseconds >= 50)
                {
                    var snapshot = Capture(); dirty = false; snapshotTicks = Stopwatch.GetTimestamp();
                    var previous = Latest;
                    if (previous == null || !SameView(previous, snapshot))
                    {
                        snapshot = snapshot with { Version = ++visibleVersion };
                        Volatile.Write(ref latest, snapshot); SnapshotAvailable?.Invoke(snapshot);
                    }
                }
                if (!commands.Reader.TryPeek(out _) && !output.Reader.TryPeek(out _))
                    await wake.WaitAsync(50, lifetime.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception error) { failure = error; Failed?.Invoke(error); }
        finally
        {
            commands.Writer.TryComplete(failure); output.Writer.TryComplete(failure);
            while (commands.Reader.TryRead(out var command)) command.Completion.TrySetException(failure ?? new ObjectDisposedException(nameof(NativeTerminalProcessor)));
            while (output.Reader.TryRead(out var pending)) pending.Completion.TrySetException(failure ?? new ObjectDisposedException(nameof(NativeTerminalProcessor)));
            if (parser != 0) { ofs_terminal_destroy(parser); parser = 0; }
        }
    }
    private void DrainCommands()
    {
        // Bound each turn even if input is continuously arriving.
        for (var i = 0; i < 32 && commands.Reader.TryRead(out var work); i++)
        {
            try { work.Token.ThrowIfCancellationRequested(); work.Action(); work.Completion.TrySetResult(); }
            catch (OperationCanceledException) { work.Completion.TrySetCanceled(work.Token); }
            catch (Exception error) { work.Completion.TrySetException(error); }
        }
    }
    private void Feed(byte[] bytes)
    {
        if (directory.Feed(bytes) is { } path) RemoteDirectoryChanged?.Invoke(path);
        var newline = submittedAt.HasValue ? Array.IndexOf(bytes, (byte)'\n') : -1;
        if (submittedAt is { } started && (Stopwatch.GetElapsedTime(started).TotalSeconds > 5 || ofs_terminal_alt_screen(parser) != 0))
        { submittedAt = null; newline = -1; }
        if (newline >= 0)
        {
            if (newline > 0) FeedNative(bytes.AsSpan(0, newline).ToArray());
            var screen = new NativeTerminalSnapshotCell[rows * columns];
            ofs_terminal_copy_screen(parser, screen, (nuint)screen.Length);
            var row = Math.Clamp(ofs_terminal_cursor_row(parser), 0, rows - 1);
            var text = new StringBuilder(columns);
            for (var col = 0; col < columns; col++) text.Append(CellText(screen[row * columns + col]));
            submittedAt = null;
            if (NativeCommandHistoryCapture.ExtractEchoed(text.ToString(), ofs_terminal_alt_screen(parser) != 0) is { } command) CommandEntered?.Invoke(command);
            FeedNative(bytes.AsSpan(newline).ToArray());
        }
        else FeedNative(bytes);
        DrainInput(); dirty = true;
    }
    private void FeedNative(byte[] bytes)
    {
        if (ofs_terminal_feed(parser, bytes, (nuint)bytes.Length) != (nuint)bytes.Length) throw new IOException("Terminal parser did not consume all bytes.");
    }
    private void DrainInput()
    {
        if (ofs_terminal_take_output_error(parser) != 0) throw new IOException("Terminal generated output overflow.");
        while (true)
        {
            var count = checked((int)ofs_terminal_read_output(parser, generated, (nuint)generated.Length));
            if (count == 0) break;
            Input?.Invoke(generated.AsSpan(0, count).ToArray());
        }
    }
    private int Scrollback => ofs_terminal_alt_screen(parser) != 0 ? 0 : ofs_terminal_scrollback_lines(parser);
    private NativeTerminalSnapshotCell[] CopyLines(int first, int count)
    {
        var cells = new NativeTerminalSnapshotCell[count * columns];
        var scrollback = Scrollback;
        var historyCount = Math.Min(count, Math.Max(0, scrollback - first));
        if (historyCount > 0) ofs_terminal_copy_scrollback(parser, Math.Max(0, first), historyCount, cells, (nuint)cells.Length);
        if (historyCount < count)
        {
            var screen = new NativeTerminalSnapshotCell[rows * columns];
            ofs_terminal_copy_screen(parser, screen, (nuint)screen.Length);
            var screenFirst = Math.Max(0, first - scrollback);
            var screenCount = Math.Min(count - historyCount, rows - screenFirst);
            if (screenCount > 0) Array.Copy(screen, screenFirst * columns, cells, historyCount * columns, screenCount * columns);
        }
        return cells;
    }
    private TerminalViewSnapshot Capture()
    {
        var history = Scrollback;
        var first = Math.Max(0, history - Math.Clamp(scrollOffset, 0, history));
        var screen = new NativeTerminalSnapshotCell[rows * columns];
        ofs_terminal_copy_screen(parser, screen, (nuint)screen.Length);
        return new(++version, rows, columns, history, first, ofs_terminal_cursor_row(parser), ofs_terminal_cursor_col(parser),
            ofs_terminal_alt_screen(parser) != 0, ofs_terminal_bracketed_paste(parser) != 0, ofs_terminal_mouse_mode(parser),
            CopyLines(first, rows).ToImmutableArray(), screen.ToImmutableArray());
    }
    private static bool SameView(TerminalViewSnapshot a, TerminalViewSnapshot b) =>
        a.Rows == b.Rows && a.Columns == b.Columns && a.FirstLine == b.FirstLine && a.ScrollbackLines == b.ScrollbackLines &&
        a.CursorRow == b.CursorRow && a.CursorColumn == b.CursorColumn && a.AlternateScreen == b.AlternateScreen &&
        a.BracketedPaste == b.BracketedPaste && a.MouseMode == b.MouseMode &&
        a.Cells.AsSpan().SequenceEqual(b.Cells.AsSpan()) && a.Screen.AsSpan().SequenceEqual(b.Screen.AsSpan());
    public static string CellText(NativeTerminalSnapshotCell cell)
    {
        if (cell.Valid == 0 || cell.Cell.Width == 0) return string.Empty;
        var text = new StringBuilder();
        for (var i = 0; i < cell.CodepointCount; i++)
        {
            var cp = cell.CodepointAt(i);
            if (cp <= 0x10FFFF && cp is not (>= 0xD800 and <= 0xDFFF) && (cp & 0xFFFF) is not (0xFFFE or 0xFFFF)) text.Append(char.ConvertFromUtf32((int)cp));
        }
        return text.ToString();
    }
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) { lifetime.Cancel(); Signal(); }
        await worker.ConfigureAwait(false);
    }
}
