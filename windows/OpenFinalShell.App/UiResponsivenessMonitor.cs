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
    private long lastHeartbeat;
    private int disposed;

    public UiResponsivenessMonitor(DispatcherQueue dispatcher)
    {
        this.dispatcher = dispatcher;
        lastHeartbeat = Stopwatch.GetTimestamp();
        loop = Task.Run(LoopAsync);
    }

    private async Task LoopAsync()
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                await Task.Delay(16, cancellation.Token).ConfigureAwait(false);
                dispatcher.TryEnqueue(Heartbeat);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void Heartbeat()
    {
        var now = Stopwatch.GetTimestamp();
        var previous = Interlocked.Exchange(ref lastHeartbeat, now);
        var milliseconds = Stopwatch.GetElapsedTime(previous, now).TotalMilliseconds;
        if (!double.IsFinite(milliseconds) || milliseconds < 0) return;
        lock (gaps)
        {
            if (gaps.Count < 120_000) gaps.Add(milliseconds);
        }
        if (milliseconds >= 250) Write($"UI stall {milliseconds:0.0} ms");
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
        double[] snapshot;
        lock (gaps) snapshot = gaps.ToArray();
        if (snapshot.Length == 0)
        {
            cancellation.Dispose();
            return;
        }
        Array.Sort(snapshot);
        var percentile99 = snapshot[Math.Clamp((int)Math.Ceiling(snapshot.Length * .99) - 1, 0, snapshot.Length - 1)];
        Write($"summary samples={snapshot.Length} p99={percentile99:0.0}ms max={snapshot[^1]:0.0}ms");
        _ = loop.ContinueWith(_ => cancellation.Dispose(), CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }
}
