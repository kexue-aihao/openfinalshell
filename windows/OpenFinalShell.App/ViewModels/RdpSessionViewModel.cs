using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed record RdpCertificatePrompt(
    uint RequestId,
    string Host,
    int Port,
    string Subject,
    string Issuer,
    string Fingerprint,
    bool Changed);

/// <summary>
/// Owns one native FreeRDP worker session. The view only supplies input and
/// observes state/frame events; it never talks to the worker process directly.
/// </summary>
public sealed class RdpSessionViewModel : INotifyPropertyChanged, IAsyncDisposable
{
    private readonly RdpWorkerClient worker;
    private readonly RdpClipboardService clipboard;
    private readonly string host;
    private readonly int port;
    private readonly string username;
    private readonly string? domain;
    private NativeRdpState state = NativeRdpState.Closed;
    private string? error;
    private NativeRdpDisplay display;
    private bool started;
    private NativeRdpCapabilities? capabilities;

    public RdpSessionViewModel(JsonObject profile, string? workerPath = null)
    {
        host = profile["host"]?.GetValue<string>() ?? throw new InvalidDataException("Invalid RDP host.");
        port = profile["port"]?.GetValue<int>() ?? 3389;
        username = profile["username"]?.GetValue<string>() ?? throw new InvalidDataException("Invalid RDP username.");
        domain = profile["domain"]?.GetValue<string>();
        display = new NativeRdpDisplay();
        worker = new RdpWorkerClient(workerPath);
        clipboard = new RdpClipboardService(worker);
        worker.StateChanged += WorkerStateChanged;
        worker.Frame += frame => Frame?.Invoke(frame);
        worker.Message += WorkerMessage;
        worker.CapabilitiesReceived += value => { Capabilities = value; CapabilitiesChanged?.Invoke(value); };
        clipboard.TextReceived += value => ClipboardTextReceived?.Invoke(value);
        clipboard.LocalFilesReceived += value => ClipboardLocalFilesReceived?.Invoke(value);
        clipboard.ProgressChanged += value => ClipboardProgressChanged?.Invoke(value);
        clipboard.RemoteFilesReceived += value => RemoteFilesReceived?.Invoke(value);
    }

    public NativeRdpState State { get => state; private set { if (state == value) return; state = value; OnPropertyChanged(); } }
    public string? Error { get => error; private set { if (error == value) return; error = value; OnPropertyChanged(); } }
    public NativeRdpDisplay Display { get => display; private set { display = value; OnPropertyChanged(); } }
    public string Host => host;
    public int Port => port;
    public NativeRdpCapabilities? Capabilities { get => capabilities; private set { capabilities = value; OnPropertyChanged(); } }
    public event Action<NativeRdpFrame>? Frame;
    public event Action<RdpCertificatePrompt>? CertificateRequested;
    public event Action<string>? ClipboardTextReceived;
    public event Action<string, string?>? AudioStateChanged;
    public event Action<NativeRdpCapabilities>? CapabilitiesChanged;
    public event Action<IReadOnlyList<string>>? ClipboardLocalFilesReceived;
    public event Action<NativeRdpClipboardProgress>? ClipboardProgressChanged;
    public event Action<IReadOnlyList<NativeRdpRemoteFile>>? RemoteFilesReceived;

    public async Task StartAsync(CancellationToken cancellation = default)
    {
        if (started) return;
        started = true;
        Error = null;
        try
        {
            await worker.StartAsync(host, port, username, domain, Display, cancellation);
        }
        catch (Exception ex)
        {
            started = false;
            Error = ex.Message;
            throw;
        }
    }

    public Task ProvidePasswordAsync(string value, CancellationToken cancellation = default)
    {
        if (string.IsNullOrEmpty(value)) throw new ArgumentException("Password cannot be empty.", nameof(value));
        Error = null;
        return worker.SendPasswordAsync(value, cancellation);
    }

    public Task SendStoredPasswordAsync(string value, CancellationToken cancellation = default) =>
        string.IsNullOrEmpty(value) ? Task.CompletedTask : ProvidePasswordAsync(value, cancellation);

    public Task AcceptCertificateAsync(uint requestId, bool accept, CancellationToken cancellation = default) =>
        worker.AcceptCertificateAsync(requestId, accept, cancellation);

    public Task ResizeAsync(uint width, uint height, uint dpi = 96, CancellationToken cancellation = default)
    {
        var next = new NativeRdpDisplay(Math.Clamp(width, 320u, 8192u), Math.Clamp(height, 320u, 8192u), Math.Clamp(dpi, 96u, 384u));
        if (next == Display) return Task.CompletedTask;
        Display = next;
        return started ? worker.ResizeAsync(next, cancellation) : Task.CompletedTask;
    }

    public Task KeyAsync(uint scanCode, bool pressed, bool extended = false, uint? unicode = null, CancellationToken cancellation = default) =>
        worker.KeyAsync(scanCode, pressed, extended, unicode, cancellation);

    public Task PointerAsync(uint x, uint y, uint buttons, int wheelX = 0, int wheelY = 0, CancellationToken cancellation = default) =>
        worker.PointerAsync(x, y, buttons, wheelX, wheelY, cancellation);

    public Task SetClipboardTextAsync(string text, CancellationToken cancellation = default) => clipboard.SetTextAsync(text, cancellation);

    public Task RequestClipboardTextAsync(CancellationToken cancellation = default)
    {
        return clipboard.RequestTextAsync(cancellation);
    }

    public Task RequestLocalClipboardFilesAsync(CancellationToken cancellation = default) => clipboard.RequestLocalFilesAsync(cancellation);
    public Task SetClipboardFilesAsync(IReadOnlyList<NativeRdpClipboardFile> files, CancellationToken cancellation = default) => clipboard.SetFilesAsync(files, cancellation);
    public Task DownloadRemoteClipboardFilesAsync(string directory, CancellationToken cancellation = default) => clipboard.DownloadRemoteFilesAsync(directory, cancellation);

    public Task StopAsync(string reason = "user")
    {
        started = false;
        return worker.StopAsync(reason);
    }

    private void WorkerStateChanged(NativeRdpState next, string? message)
    {
        State = next;
        Error = message;
        if (next is NativeRdpState.Failed or NativeRdpState.Closed) started = false;
    }

    private void WorkerMessage(NativeRdpMessage message)
    {
        if (message.Payload["op"]?.GetValue<string>() == "prompt" && message.Payload["kind"]?.GetValue<string>() == "certificate")
        {
            var data = message.Payload["payload"]?.AsObject() ?? new JsonObject();
            CertificateRequested?.Invoke(new(
                message.Payload["requestId"]?.GetValue<uint>() ?? message.RequestId,
                data["host"]?.GetValue<string>() ?? host,
                data["port"]?.GetValue<int>() ?? port,
                data["subject"]?.GetValue<string>() ?? "",
                data["issuer"]?.GetValue<string>() ?? "",
                data["fingerprintSha256"]?.GetValue<string>() ?? "",
                data["changed"]?.GetValue<bool>() ?? false));
        }
        if (message.Payload["op"]?.GetValue<string>() == "audio")
            AudioStateChanged?.Invoke(message.Payload["state"]?.GetValue<string>() ?? "unknown", message.Payload["errorCode"]?.GetValue<string>());
    }

    public async ValueTask DisposeAsync()
    {
        worker.StateChanged -= WorkerStateChanged;
        clipboard.Dispose();
        await worker.DisposeAsync();
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
