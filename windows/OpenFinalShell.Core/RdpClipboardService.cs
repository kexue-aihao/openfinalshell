using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record NativeRdpClipboardProgress(
    string State,
    string Direction,
    string? FileName,
    long Transferred,
    long Total,
    double SpeedBps,
    string? Error);
public sealed record NativeRdpRemoteFile(string Name, long Size, bool Directory);

/// <summary>Native text/file-clipboard protocol adapter for one RDP worker.</summary>
public sealed class RdpClipboardService : IDisposable
{
    private readonly RdpWorkerClient worker;
    public event Action<string>? TextReceived;
    public event Action<NativeRdpClipboardProgress>? ProgressChanged;
    public event Action<IReadOnlyList<string>>? LocalFilesReceived;
    public event Action<IReadOnlyList<NativeRdpRemoteFile>>? RemoteFilesReceived;

    public RdpClipboardService(RdpWorkerClient worker)
    {
        this.worker = worker;
        worker.Message += OnMessage;
    }

    public Task SetTextAsync(string text, CancellationToken cancellation = default) => worker.ClipboardTextAsync(text, cancellation);
    public Task RequestTextAsync(CancellationToken cancellation = default) => worker.ClipboardGetAsync(cancellation);
    public Task SetSynchronizationAsync(bool enabled, CancellationToken cancellation = default) => worker.ClipboardSyncAsync(enabled, cancellation);
    public Task CancelTransferAsync(CancellationToken cancellation = default) => worker.ClipboardCancelAsync(cancellation);
    public Task RequestLocalFilesAsync(CancellationToken cancellation = default) => worker.RequestLocalClipboardFilesAsync(cancellation);
    public Task SetFilesAsync(IReadOnlyList<NativeRdpClipboardFile> files, CancellationToken cancellation = default) => worker.SetClipboardFilesAsync(files, cancellation);
    public Task DownloadRemoteFilesAsync(string directory, CancellationToken cancellation = default) => worker.DownloadRemoteClipboardFilesAsync(directory, cancellation);

    private void OnMessage(NativeRdpMessage message)
    {
        var op = message.Payload["op"]?.GetValue<string>();
        if (op == "clipboardData" && message.Payload["mime"]?.GetValue<string>() == "text/plain")
        {
            TextReceived?.Invoke(message.Payload["text"]?.GetValue<string>() ?? "");
            return;
        }
        if (op == "clipboardLocalFiles" && message.Payload["files"] is JsonArray files)
        {
            LocalFilesReceived?.Invoke(files.Select(value => value?.GetValue<string>() ?? string.Empty).Where(value => value.Length > 0).ToArray());
            return;
        }
        if (op == "remoteFiles" && message.Payload["files"] is JsonArray remoteFiles)
        {
            var values = remoteFiles.OfType<JsonObject>().Select(file => new NativeRdpRemoteFile(
                file["name"]?.GetValue<string>() ?? string.Empty,
                file["size"]?.GetValue<long>() ?? 0,
                file["directory"]?.GetValue<bool>() ?? false)).Where(file => file.Name.Length > 0).ToArray();
            RemoteFilesReceived?.Invoke(values);
            return;
        }
        if (op == "downloadResult")
        {
            var state = message.Payload["state"]?.GetValue<string>() ?? "failed";
            var error = message.Payload["error"]?.GetValue<string>();
            ProgressChanged?.Invoke(new(state, "download", null, message.Payload["fileCount"]?.GetValue<long>() ?? 0, message.Payload["fileCount"]?.GetValue<long>() ?? 0, 0, error));
            return;
        }
        if (op != "clipboardProgress") return;
        ProgressChanged?.Invoke(new(
            message.Payload["state"]?.GetValue<string>() ?? "unknown",
            message.Payload["direction"]?.GetValue<string>() ?? "unknown",
            message.Payload["fileName"]?.GetValue<string>(),
            message.Payload["transferred"]?.GetValue<long>() ?? 0,
            message.Payload["total"]?.GetValue<long>() ?? 0,
            message.Payload["speedBps"]?.GetValue<double>() ?? 0,
            message.Payload["error"]?.GetValue<string>()));
    }

    public void Dispose() => worker.Message -= OnMessage;
}
