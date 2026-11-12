using System.ComponentModel;
using System.Globalization;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class TransferQueueViewModel : INotifyPropertyChanged, IDisposable
{
    private readonly NativeTransferQueue queue;
    private readonly Localization localization;
    private readonly SynchronizationContext? context = SynchronizationContext.Current;
    private readonly Dictionary<string, NativeTransferTask> taskState = new(StringComparer.Ordinal);
    private DateTime rateSampleAt = DateTime.UtcNow;
    private long rateSampleUploadBytes;
    private long rateSampleDownloadBytes;
    private long uploadBytesPerSecond;
    private long downloadBytesPerSecond;
    private readonly object pendingGate = new();
    private readonly Dictionary<string, NativeTransferTask> pendingUpdates = new(StringComparer.Ordinal);
    private readonly HashSet<string> pendingRemovals = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource pendingCancellation = new();
    private int flushScheduled;
    private bool disposed;
    public BulkObservableCollection<NativeTransferTask> Tasks { get; } = [];
    public event Action? QueueChanged;

    public TransferQueueViewModel(NativeTransferQueue queue, Localization localization)
    {
        this.queue = queue;
        this.localization = localization;
        foreach (var task in queue.List()) taskState[task.Id] = task;
        Tasks.ReplaceAll(taskState.Values);
        SampleTransferRates(DateTime.UtcNow);
        queue.Changed += OnChanged;
        queue.Removed += OnRemoved;
    }

    public Task ControlAsync(string id, string operation) => queue.ControlAsync(id, operation);
    public Task ControlAllAsync(string operation) => queue.ControlAllAsync(operation);
    public void ClearFinished() => queue.ClearFinished();

    public int UnfinishedCount => Tasks.Count(task => !task.IsGroup && task.State is
        NativeTransferState.Queued or NativeTransferState.Running or NativeTransferState.Paused);

    public string SummaryText
    {
        get
        {
            var totals = NativeTransferTotals.FromTasks(Tasks.ToArray(), uploadBytesPerSecond, downloadBytesPerSecond);
            if (totals.TotalCount == 0) return string.Empty;
            var parts = new List<string>
            {
                localization.Format("transfer.totalDone", ("done", totals.DoneCount.ToString(CultureInfo.CurrentCulture)),
                    ("total", totals.TotalCount.ToString(CultureInfo.CurrentCulture)))
            };
            if (totals.FailedCount > 0)
                parts.Add(localization.Format("transfer.totalFailed", ("count", totals.FailedCount.ToString(CultureInfo.CurrentCulture))));
            parts.Add(localization.Format(totals.UnknownCount > 0 ? "transfer.totalBytesUnknown" : "transfer.totalBytes",
                ("transferred", FormatBytes(totals.TransferredBytes)), ("total", FormatBytes(totals.TotalBytes))));
            if (totals.DownloadBytesPerSecond > 0) parts.Add($"↓ {FormatSpeed(totals.DownloadBytesPerSecond)}");
            if (totals.UploadBytesPerSecond > 0) parts.Add($"↑ {FormatSpeed(totals.UploadBytesPerSecond)}");
            var speed = totals.DownloadBytesPerSecond > long.MaxValue - totals.UploadBytesPerSecond
                ? long.MaxValue : totals.DownloadBytesPerSecond + totals.UploadBytesPerSecond;
            if (totals.UnknownCount == 0 && totals.TotalBytes > totals.TransferredBytes && speed > 0)
            {
                var seconds = (long)Math.Ceiling((totals.TotalBytes - totals.TransferredBytes) / (double)speed);
                parts.Add(localization.Format("transfer.remaining", ("time", FormatDuration(seconds))));
            }
            return string.Join(" · ", parts);
        }
    }

    private void OnChanged(NativeTransferTask task)
    {
        if (disposed) return;
        lock (pendingGate) pendingUpdates[task.Id] = task;
        ScheduleFlush();
    }

    private void OnRemoved(string id)
    {
        if (disposed) return;
        lock (pendingGate)
        {
            pendingRemovals.Add(id);
            pendingUpdates.Remove(id);
        }
        ScheduleFlush();
    }

    private void ScheduleFlush()
    {
        if (disposed || Interlocked.Exchange(ref flushScheduled, 1) != 0) return;
        _ = FlushAfterDelayAsync();
    }

    private async Task FlushAfterDelayAsync()
    {
        try
        {
            await Task.Delay(50, pendingCancellation.Token).ConfigureAwait(false);
            if (context != null) context.Post(_ => FlushPending(), null);
            else FlushPending();
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void FlushPending()
    {
        if (disposed) return;
        KeyValuePair<string, NativeTransferTask>[] updates;
        string[] removals;
        lock (pendingGate)
        {
            updates = pendingUpdates.ToArray();
            removals = pendingRemovals.ToArray();
            pendingUpdates.Clear();
            pendingRemovals.Clear();
        }
        foreach (var (id, task) in updates) taskState[id] = task;
        foreach (var id in removals) taskState.Remove(id);
        if (updates.Length + removals.Length > 16)
        {
            Tasks.ReplaceAll(taskState.Values);
        }
        else
        {
            foreach (var (_, task) in updates)
            {
                var index = -1;
                for (var itemIndex = 0; itemIndex < Tasks.Count; itemIndex++)
                {
                    if (!string.Equals(Tasks[itemIndex].Id, task.Id, StringComparison.Ordinal)) continue;
                    index = itemIndex;
                    break;
                }
                if (index < 0) Tasks.Add(task);
                else Tasks[index] = task;
            }
            foreach (var id in removals)
            {
                var item = Tasks.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.Ordinal));
                if (item != null) Tasks.Remove(item);
            }
        }
        try
        {
            SampleTransferRates(DateTime.UtcNow);
            OnPropertyChanged(nameof(Tasks));
            OnPropertyChanged(nameof(UnfinishedCount));
            OnPropertyChanged(nameof(SummaryText));
            QueueChanged?.Invoke();
        }
        finally
        {
            Volatile.Write(ref flushScheduled, 0);
            lock (pendingGate)
            {
                if (pendingUpdates.Count > 0 || pendingRemovals.Count > 0) ScheduleFlush();
            }
        }
    }

    public void RefreshSummary()
    {
        SampleTransferRates(DateTime.UtcNow);
        OnPropertyChanged(nameof(SummaryText));
    }

    private void SampleTransferRates(DateTime now)
    {
        var parents = Tasks.Where(task => task.ParentId != null).Select(task => task.ParentId!).ToHashSet(StringComparer.Ordinal);
        var leaves = Tasks.Where(task => !parents.Contains(task.Id)).ToArray();
        var uploadBytes = SaturatingSum(leaves.Where(task => task.Direction == NativeTransferDirection.Upload).Select(task => task.CompletedBytes));
        var downloadBytes = SaturatingSum(leaves.Where(task => task.Direction == NativeTransferDirection.Download).Select(task => task.CompletedBytes));
        var elapsed = (now - rateSampleAt).TotalSeconds;
        if (uploadBytes < rateSampleUploadBytes || downloadBytes < rateSampleDownloadBytes)
        {
            uploadBytesPerSecond = downloadBytesPerSecond = 0;
            rateSampleUploadBytes = uploadBytes;
            rateSampleDownloadBytes = downloadBytes;
            rateSampleAt = now;
            return;
        }
        if (elapsed < 0.25) return;
        uploadBytesPerSecond = leaves.Any(task => task.Direction == NativeTransferDirection.Upload && task.State == NativeTransferState.Running)
            ? (long)((uploadBytes - rateSampleUploadBytes) / elapsed) : 0;
        downloadBytesPerSecond = leaves.Any(task => task.Direction == NativeTransferDirection.Download && task.State == NativeTransferState.Running)
            ? (long)((downloadBytes - rateSampleDownloadBytes) / elapsed) : 0;
        rateSampleUploadBytes = uploadBytes;
        rateSampleDownloadBytes = downloadBytes;
        rateSampleAt = now;
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        var value = (double)Math.Max(0, bytes);
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1) { value /= 1024; unit++; }
        return $"{value.ToString(value >= 100 || unit == 0 ? "0" : "0.#", CultureInfo.CurrentCulture)} {units[unit]}";
    }

    private static string FormatSpeed(long bytesPerSecond) => $"{FormatBytes(bytesPerSecond)}/s";

    private static string FormatDuration(long seconds)
    {
        var safe = Math.Max(0, seconds);
        var hours = safe / 3600;
        var minutes = safe / 60 % 60;
        var remainder = safe % 60;
        return hours > 0 ? $"{hours}:{minutes:00}:{remainder:00}" : $"{minutes}:{remainder:00}";
    }

    private static long SaturatingSum(IEnumerable<long> values)
    {
        var total = 0L;
        foreach (var value in values)
        {
            var nonNegative = Math.Max(0, value);
            total = nonNegative > long.MaxValue - total ? long.MaxValue : total + nonNegative;
        }
        return total;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        pendingCancellation.Cancel();
        queue.Changed -= OnChanged;
        queue.Removed -= OnRemoved;
        pendingCancellation.Dispose();
    }
}
