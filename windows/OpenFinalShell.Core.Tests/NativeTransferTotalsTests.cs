using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeTransferTotalsTests
{
    public static void Run(Action<bool, string> check)
    {
        var tasks = new NativeTransferTask[]
        {
            new("group", "session", NativeTransferDirection.Upload, "folder", "/remote/folder", true, false,
                155, 130, NativeTransferState.Running, null, null, true, 4),
            new("done", "session", NativeTransferDirection.Upload, "done.txt", "/remote/done.txt", true, false,
                100, 100, NativeTransferState.Completed, null, "group"),
            new("failed", "session", NativeTransferDirection.Download, "/remote/failed", "failed", true, false,
                50, 30, NativeTransferState.Failed, "fixture error", "group"),
            new("skipped", "session", NativeTransferDirection.Upload, "skip.txt", "/remote/skip.txt", false, false,
                5, 0, NativeTransferState.Skipped, "exists", "group"),
            new("unknown", "session", NativeTransferDirection.Download, "/remote/unknown", "unknown", true, false,
                null, 0, NativeTransferState.Queued, null, "group"),
            new("canceled", "session", NativeTransferDirection.Download, "/remote/canceled", "canceled", true, false,
                null, 0, NativeTransferState.Canceled, null)
        };

        var totals = NativeTransferTotals.FromTasks(tasks, 1200, 3400);
        check(totals is { TotalCount: 5, DoneCount: 1, FailedCount: 1, TotalBytes: 155, TransferredBytes: 130,
                UnknownCount: 1, RunningCount: 1, UploadBytesPerSecond: 1200, DownloadBytesPerSecond: 3400 },
            "Transfer overview aggregates leaf tasks, known bytes, unknown work and active rates without counting group parents");
        check(NativeTransferTotals.FromTasks([]) is { TotalCount: 0, DoneCount: 0, FailedCount: 0, UnknownCount: 0 },
            "Empty transfer overview reports zero totals");
    }
}
