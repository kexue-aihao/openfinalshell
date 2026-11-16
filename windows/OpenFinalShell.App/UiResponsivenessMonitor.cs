using Microsoft.UI.Dispatching;
using OpenFinalShell.Core;
using System.Diagnostics;

namespace OpenFinalShell.App;

/// <summary>Opt-in diagnostics that record long UI dispatcher gaps without telemetry.</summary>
internal sealed class UiResponsivenessMonitor : IDisposable
{
    private readonly DispatcherQueue dispatcher;
    private readonly CancellationTokenSource cancellation = new();
    private readonly List<double> gaps = [];
    private readonly Task loop;
    private int disposed;
    private int heartbeatPending;
    private long postedAt;
    private readonly System.Collections.Concurrent.ConcurrentQueue<double> samples = new();

    public UiResponsivenessMonitor(DispatcherQueue dispatcher)
    {
        this.dispatcher = dispatcher;
        loop = Task.Run(LoopAsync);
    }

    private async Task LoopAsync()
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                await Task.Delay(16, cancellation.Token).ConfigureAwait(false);
                while (samples.TryDequeue(out var sample))
                {
                    if (gaps.Count < 120_000) gaps.Add(sample);
                    if (sample >= 250) Write($"UI stall {sample:0.0} ms");
                }
                if (Interlocked.CompareExchange(ref heartbeatPending, 1, 0) != 0) continue;
                Volatile.Write(ref postedAt, Stopwatch.GetTimestamp());
                if (!dispatcher.TryEnqueue(Heartbeat)) Volatile.Write(ref heartbeatPending, 0);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            while (samples.TryDequeue(out var sample)) gaps.Add(sample);
            if (gaps.Count > 0)
            {
                gaps.Sort();
                var p99 = gaps[Math.Clamp((int)Math.Ceiling(gaps.Count * .99) - 1, 0, gaps.Count - 1)];
                Write($"summary samples={gaps.Count} p99={p99:0.0}ms max={gaps[^1]:0.0}ms");
            }
            cancellation.Dispose();
        }
    }

    private void Heartbeat()
    {
        var now = Stopwatch.GetTimestamp();
        var previous = Volatile.Read(ref postedAt);
        var milliseconds = Stopwatch.GetElapsedTime(previous, now).TotalMilliseconds;
        if (Volatile.Read(ref disposed) == 0 && double.IsFinite(milliseconds) && milliseconds >= 0)
            samples.Enqueue(milliseconds);
        Volatile.Write(ref heartbeatPending, 0);
    }

    private void Write(string line)
    {
        try
        {
            Directory.CreateDirectory(NativeStore.DefaultDirectory);
            File.AppendAllText(Path.Combine(NativeStore.DefaultDirectory, "ui-responsiveness.log"),
                $"{DateTimeOffset.UtcNow:O} {line}\n");
        }
        catch
        {
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        cancellation.Cancel();
    }
}
