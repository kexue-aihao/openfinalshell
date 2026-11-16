using OpenFinalShell.Core;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

var checks = 0;
void Check(bool value, string name)
{
    if (!value) throw new InvalidOperationException("FAIL: " + name);
    checks++; Console.WriteLine("PASS: " + name);
}
string Text(TerminalViewSnapshot snapshot) => string.Concat(snapshot.Screen.Select(NativeTerminalProcessor.CellText));
string Fingerprint(TerminalViewSnapshot snapshot) => JsonSerializer.Serialize(new
{
    snapshot.Rows, snapshot.Columns, snapshot.CursorRow, snapshot.CursorColumn,
    snapshot.AlternateScreen, snapshot.BracketedPaste, snapshot.MouseMode,
    Cells = snapshot.Screen.Select(c => new { Text = NativeTerminalProcessor.CellText(c), c.Cell.Width, c.Cell.FgR, c.Cell.FgG, c.Cell.FgB, c.Cell.Attributes })
});

Check(Marshal.SizeOf<NativeTerminalSnapshotCell>() == 56, "snapshot ABI matches native layout");
var fixture = Encoding.UTF8.GetBytes("hello\r\n中文🙂e\u0301\r\n\u001b[31mred\u001b[0m\rworking 10%\rworking 90%\u001b[K\u001b[?2004h\u001b[?1000h\u001b[6n");
await using (var whole = new NativeTerminalProcessor(12, 40))
await using (var split = new NativeTerminalProcessor(12, 40))
{
    var wholeReplies = new List<byte>(); var splitReplies = new List<byte>();
    whole.Input += b => wholeReplies.AddRange(b); split.Input += b => splitReplies.AddRange(b);
    await whole.ConsumeAsync(fixture);
    foreach (var b in fixture) await split.ConsumeAsync([b]);
    var expected = await whole.SnapshotAsync(); var actual = await split.SnapshotAsync();
    Check(Fingerprint(actual) == Fingerprint(expected), "byte-split UTF-8, wide glyphs, combining marks, ANSI and CR progress equal unsplit reference");
    Check(wholeReplies.SequenceEqual(splitReplies) && wholeReplies.Count > 0, "split terminal query replies preserve exact bytes");
    Check(actual.BracketedPaste && actual.MouseMode != 0, "snapshot carries terminal modes");
    Check(Text(actual).Contains("working 90%"), "carriage return rewrites progress without newline framing");
    await split.PasteAsync(Encoding.UTF8.GetBytes("paste中文"));
    Check(Encoding.UTF8.GetString(splitReplies.ToArray()).Contains("\u001b[200~paste中文\u001b[201~"), "paste executes on owner with negotiated bracketed mode");
    await split.ConsumeAsync(Encoding.UTF8.GetBytes("\u001b[?1049hALT"));
    Check((await split.SnapshotAsync()).AlternateScreen, "alternate screen snapshot is isolated");
    await split.ConsumeAsync(Encoding.UTF8.GetBytes("\u001b[?1049l"));
    Check(Text(await split.SnapshotAsync()).Contains("working 90%"), "return from alternate screen restores normal screen");
    var retained = Fingerprint(actual);
    await split.ClearAsync();
    Check(Fingerprint(actual) == retained && !Text(await split.SnapshotAsync()).Contains("working"), "published snapshot remains independent after parser mutation");
}

foreach (var charset in new[] { "utf8", "gb18030", "gbk", "big5", "latin1" })
{
    var codec = new TerminalCharsetCodec(charset);
    var text = charset == "latin1" ? "café" : "中文";
    var bytes = codec.EncodeText(text);
    await using var terminal = new NativeTerminalProcessor(4, 32);
    foreach (var b in bytes) await terminal.ConsumeAsync(codec.DecodeRemote([b]));
    Check(Text(await terminal.SnapshotAsync()).Contains(text), charset + " decoder retains characters across every byte boundary");
}

await using (var terminal = new NativeTerminalProcessor(6, 40, 100))
{
    await terminal.ConsumeAsync(Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, 200).Select(i => $"line-{i:D4}\r\n"))));
    var snapshot = await terminal.SnapshotAsync();
    Check(snapshot.ScrollbackLines == 100, "scrollback remains bounded while consumer has no UI subscriber");
    var history = await terminal.ReadLinesAsync(0, 16);
    Check(history.Length == 16 * 40, "history request returns detached bounded cells");
    await terminal.SetViewportAsync(80);
    Check((await terminal.SnapshotAsync()).FirstLine == 20, "hidden terminal resumes at requested history viewport");
    using var canceled = new CancellationTokenSource(); canceled.Cancel();
    try { await terminal.ReadLinesAsync(0, 16, canceled.Token); Check(false, "history cancellation"); }
    catch (OperationCanceledException) { Check(true, "history requests honor cancellation"); }
    await terminal.ResizeAsync(10, 64);
    Check((await terminal.SnapshotAsync()).Columns == 64, "resize executes on parser owner");
}

// A hostile synchronization context catches accidental UI continuation capture.
var previous = SynchronizationContext.Current;
SynchronizationContext.SetSynchronizationContext(new RejectContext());
Task background;
try
{
    var terminal = new NativeTerminalProcessor();
    background = Task.Run(async () => { await terminal.ConsumeAsync(fixture); await terminal.DisposeAsync(); });
}
finally { SynchronizationContext.SetSynchronizationContext(previous); }
await background.WaitAsync(TimeSpan.FromSeconds(3));
Check(true, "processing and disposal do not require caller synchronization context");

var stop = new NativeTerminalProcessor();
var floodTask = stop.ConsumeAsync(new byte[4 * 1024 * 1024]);
var closeClock = Stopwatch.StartNew();
await stop.DisposeAsync();
try { await floodTask; } catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException or System.Threading.Channels.ChannelClosedException) { }
await stop.DisposeAsync();
Check(closeClock.Elapsed < TimeSpan.FromSeconds(3), "close cancels active producer, joins owner and supports repeated disposal within 3 seconds");

await using (var terminal = new NativeTerminalProcessor(30, 80))
{
    var interrupted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    terminal.Input += bytes => { if (bytes.Contains((byte)3)) interrupted.TrySetResult(); };
    var continuous = terminal.ConsumeAsync(Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("continuous 中文 log\r\n", 100000))));
    var inputClock = Stopwatch.StartNew();
    await terminal.CodepointAsync('c', 4).WaitAsync(TimeSpan.FromSeconds(1));
    await interrupted.Task.WaitAsync(TimeSpan.FromSeconds(1));
    Check(inputClock.Elapsed < TimeSpan.FromSeconds(1), "Ctrl+C encoding is serviced during continuous output without waiting for all parsing");
    await terminal.ResizeAsync(24, 100).WaitAsync(TimeSpan.FromSeconds(1));
    var snapshot = await terminal.SnapshotAsync().WaitAsync(TimeSpan.FromSeconds(1));
    Check(snapshot.Columns == 100 && snapshot.Rows == 24, "resize and snapshot commands run while an output producer is active");
    await continuous;
}

if (args.Contains("--stress"))
{
    var totalLines = int.TryParse(Environment.GetEnvironmentVariable("OFS_STRESS_LINES"), out var count) ? count : 2_500_000;
    foreach (var limit in new[] { 5000, 100000 })
    {
        // 64 columns fits the existing native 256 MiB scrollback allocation cap.
        await using var terminal = new NativeTerminalProcessor(30, 64, limit);
        var clock = Stopwatch.StartNew();
        var memory = new List<long>(); long submitted = 0;
        for (var i = 0; i < totalLines; i += 256)
        {
            var bytes = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(i, Math.Min(256, totalLines - i)).Select(n => $"{n:D8} 中文 log\r\n")));
            submitted += bytes.Length;
            await terminal.ConsumeAsync(bytes);
            if (i % 65536 == 0) memory.Add(Process.GetCurrentProcess().PrivateMemorySize64);
            if (i % 16384 == 0) await terminal.KeyAsync(5, 0);
        }
        var final = await terminal.SnapshotAsync();
        Check(terminal.ParsedBytes == submitted, $"stress {limit}: all {submitted} bytes parsed in order");
        Check(Text(final).Contains($"{totalLines - 1:D8}"), $"stress {limit}: final line survives {totalLines} lines");
        Check(final.ScrollbackLines == limit, $"stress {limit}: history at configured cap");
        Console.WriteLine(JsonSerializer.Serialize(new { mode = "stress", limit, totalLines, bytes = submitted, elapsedMs = clock.ElapsedMilliseconds,
            parseMs = terminal.ParseTime.TotalMilliseconds, memory, final.ScrollbackLines }));
    }
}
Console.WriteLine($"Terminal pipeline checks passed: {checks}");

sealed class RejectContext : SynchronizationContext
{
    public override void Post(SendOrPostCallback callback, object? state) => throw new InvalidOperationException("Unexpected UI continuation");
}
