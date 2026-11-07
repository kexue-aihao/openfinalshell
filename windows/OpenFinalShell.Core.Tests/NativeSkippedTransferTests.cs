using System.Security.Cryptography;
using System.Text;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeSkippedTransferTests
{
    public static void Run(Action<bool, string> check)
    {
        var root = Path.Combine(Path.GetTempPath(), "ofs-skipped-transfer-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var store = new NativeStore(root, new TestProtector());
            using var sessions = new NativeSessionManager(store);
            using var queue = new NativeTransferQueue(sessions, text: key => key switch
            {
                "transfer.stateSkipped" => "已跳过",
                _ => key
            });

            var standaloneId = queue.EnqueueSkipped("session-a", NativeTransferDirection.Upload,
                "C:/fixture/exists.txt", "/upload/exists.txt", "Skipped because the remote item exists.", 19);
            var standalone = queue.List().Single(task => task.Id == standaloneId);
            check(standalone.State == NativeTransferState.Skipped && standalone.ProgressPercent == 100 &&
                standalone.CompletedBytes == 0 && standalone.TotalBytes == 19 && standalone.Summary.Contains("Skipped because", StringComparison.Ordinal)
                && standalone.Summary.Contains("已跳过", StringComparison.Ordinal),
                "Skipped upload is a localized visible terminal queue task without claiming transferred bytes");

            foreach (var operation in new[] { "pause", "resume", "retry", "cancel" })
                queue.ControlAsync(standaloneId, operation).GetAwaiter().GetResult();
            check(queue.List().Single(task => task.Id == standaloneId).State == NativeTransferState.Skipped,
                "Skipped queue tasks remain terminal under transfer controls");

            queue.ControlAllAsync("pause").GetAwaiter().GetResult();
            check(queue.List().Single(task => task.Id == standaloneId).State == NativeTransferState.Skipped,
                "Queue-wide pause leaves terminal tasks unchanged");
            var invalidQueueOperationRejected = false;
            try { queue.ControlAllAsync("retry").GetAwaiter().GetResult(); }
            catch (ArgumentOutOfRangeException) { invalidQueueOperationRejected = true; }
            check(invalidQueueOperationRejected, "Queue-wide transfer controls reject unsupported operations");

            var groupId = queue.CreateGroup("session-a", NativeTransferDirection.Upload, "logs", "/upload/logs", 0, 2);
            queue.EnqueueSkipped("session-a", NativeTransferDirection.Upload,
                "C:/fixture/logs/a.txt", "/upload/logs/a.txt", "Skipped existing item", 10, groupId);
            queue.EnqueueSkipped("session-a", NativeTransferDirection.Upload,
                "C:/fixture/logs/b.txt", "/upload/logs/b.txt", "Skipped existing item", 20, groupId);
            var group = queue.List().Single(task => task.Id == groupId);
            check(group.State == NativeTransferState.Skipped && group.SkippedItems == 2 && group.ChildCount == 2 &&
                group.ProgressPercent == 100 && group.Summary.Contains("2 已跳过", StringComparison.Ordinal),
                "Directory group localizes skipped children and reaches a terminal skipped state");

            queue.ClearFinished();
            check(queue.List().Count == 0, "Clear finished removes standalone and grouped skipped tasks");
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    private sealed class TestProtector : ISecretProtector
    {
        private static readonly byte[] Key = SHA256.HashData(Encoding.UTF8.GetBytes("native-skipped-transfer-tests"));
        public byte[] Protect(byte[] value) => value.Select((item, index) => (byte)(item ^ Key[index % Key.Length])).ToArray();
        public byte[] Unprotect(byte[] value) => Protect(value);
    }
}
