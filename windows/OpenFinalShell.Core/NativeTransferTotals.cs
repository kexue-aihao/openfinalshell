namespace OpenFinalShell.Core;

public sealed record NativeTransferTotals(
    int DoneCount,
    int FailedCount,
    int TotalCount,
    long TransferredBytes,
    long TotalBytes,
    int UnknownCount,
    int RunningCount,
    long UploadBytesPerSecond,
    long DownloadBytesPerSecond)
{
    private static readonly HashSet<NativeTransferState> FinalStates =
    [NativeTransferState.Completed, NativeTransferState.Failed, NativeTransferState.Canceled, NativeTransferState.Skipped];

    /// <summary>Aggregate visible leaf tasks like Electron's transfer overview, excluding folder parents.</summary>
    public static NativeTransferTotals FromTasks(
        IReadOnlyList<NativeTransferTask> tasks,
        long uploadBytesPerSecond = 0,
        long downloadBytesPerSecond = 0)
    {
        var parentIds = tasks.Where(task => task.ParentId != null)
            .Select(task => task.ParentId!)
            .ToHashSet(StringComparer.Ordinal);
        var leaves = tasks.Where(task => !parentIds.Contains(task.Id)).ToArray();
        var totalBytes = 0L;
        var transferred = 0L;
        var unknown = 0;
        foreach (var task in leaves)
        {
            if (task.TotalBytes is > 0)
            {
                totalBytes = SaturatingAdd(totalBytes, task.TotalBytes.Value);
                transferred = SaturatingAdd(transferred, Math.Clamp(task.CompletedBytes, 0, task.TotalBytes.Value));
            }
            else if (!FinalStates.Contains(task.State)) unknown++;
        }

        return new(
            leaves.Count(task => task.State == NativeTransferState.Completed),
            leaves.Count(task => task.State == NativeTransferState.Failed),
            leaves.Length,
            transferred,
            totalBytes,
            unknown,
            tasks.Count(task => task.State == NativeTransferState.Running),
            Math.Max(0, uploadBytesPerSecond),
            Math.Max(0, downloadBytesPerSecond));
    }

    private static long SaturatingAdd(long left, long right) =>
        right > 0 && left > long.MaxValue - right ? long.MaxValue : left + right;
}
