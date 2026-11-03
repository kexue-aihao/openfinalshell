using System.Text;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

/// <summary>Small file-safety cases for the native remote editor contract.</summary>
public static class NativeFileSafetyCases
{
    public static async Task RunAsync(Action<bool, string> check, string testRoot)
    {
        var plain = Encoding.UTF8.GetBytes("line one\nline two\tok\r\n");
        var utf8 = NativeTextCodec.Detect(plain);
        check(!NativeTextCodec.LooksBinary(plain, utf8.Encoding), "Remote editor accepts ordinary UTF-8 text");

        var utf16 = NativeTextCodec.Encode("text\n第二行", NativeTextEncoding.Utf16Le, true);
        var utf16Info = NativeTextCodec.Detect(utf16);
        check(!NativeTextCodec.LooksBinary(utf16, utf16Info.Encoding), "Remote editor accepts BOM-marked UTF-16 text");

        var binary = new byte[] { 0x50, 0x4B, 0x03, 0x04, 0, 0xFF, 0x10, 0x00 };
        var binaryInfo = NativeTextCodec.Detect(binary);
        check(NativeTextCodec.LooksBinary(binary, binaryInfo.Encoding), "Remote editor rejects binary data with NUL bytes");

        check(NativeRemoteEditorService.MaximumEditableBytes == 8 * 1024 * 1024,
            "Remote editor enforces the shared 8 MiB file limit");

        var storePath = Path.Combine(testRoot, "transfer-group-" + Guid.NewGuid().ToString("N"));
        using var store = new NativeStore(storePath, new TestProtector());
        using var sessions = new NativeSessionManager(store);
        using var queue = new NativeTransferQueue(sessions);
        var emptyGroup = queue.CreateGroup("session-unused", NativeTransferDirection.Upload, "empty", "/empty", 0, 0);
        var emptyTask = queue.List().Single(task => task.Id == emptyGroup);
        check(emptyTask.IsGroup && emptyTask.State == NativeTransferState.Completed && emptyTask.ProgressPercent == 100,
            "Empty directory transfer groups complete as visible tasks");

        var sourcePath = Path.Combine(testRoot, "transfer-group-source-" + Guid.NewGuid().ToString("N"));
        await File.WriteAllBytesAsync(sourcePath, [1, 2, 3]);
        var failedGroup = queue.CreateGroup("missing-session", NativeTransferDirection.Upload, "folder", "/folder", 3, 1);
        var childId = queue.EnqueueUpload("missing-session", sourcePath, "/folder/file.bin", true, false, failedGroup);
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (queue.List().Single(task => task.Id == failedGroup).State == NativeTransferState.Failed) break;
            await Task.Delay(10);
        }
        var failedParent = queue.List().Single(task => task.Id == failedGroup);
        var failedChild = queue.List().Single(task => task.Id == childId);
        check(failedChild.ParentId == failedGroup && failedParent.State == NativeTransferState.Failed && failedParent.CompletedItems == 0,
            "Directory transfer groups aggregate child failures and retain retryable children");
        File.Delete(sourcePath);
    }
}
