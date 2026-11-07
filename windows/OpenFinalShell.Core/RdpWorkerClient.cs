using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record NativeRdpDisplay(uint Width = 1280, uint Height = 720, uint Dpi = 96);
public sealed record NativeRdpCapabilities(bool ClipboardText, bool ClipboardFilesUpload, bool ClipboardFilesPaste, bool DragUpload, bool AudioPlayback, string WorkerVersion);
public sealed record NativeRdpFrame(uint Sequence, uint CanvasWidth, uint CanvasHeight, byte[] Rectangles);
public sealed record NativeRdpClipboardFile(string Path, string Name, long Size, bool Directory = false);
public sealed record NativeRdpMessage(byte Type, uint RequestId, JsonObject Payload);
public enum NativeRdpState { Starting, Connecting, Authenticating, Verifying, Ready, Failed, Closing, Closed }

/// <summary>
/// Binary-safe client for the existing FreeRDP Worker protocol. It owns the
/// worker process and validates frame limits before data reaches Win2D.
/// </summary>
public sealed class RdpWorkerClient : IAsyncDisposable
{
    private const uint MaxPayload = 64u * 1024u * 1024u;
    private const uint MaxPixels = 16_777_216;
    private readonly string executable;
    private readonly SemaphoreSlim writeGate = new(1, 1);
    private Process? process;
    private int requestId;
    private CancellationTokenSource? cancellation;
    public NativeRdpState State { get; private set; } = NativeRdpState.Closed;
    public event Action<NativeRdpState, string?>? StateChanged;
    public event Action<NativeRdpFrame>? Frame;
    public event Action<NativeRdpMessage>? Message;
    public event Action<NativeRdpCapabilities>? CapabilitiesReceived;

    public RdpWorkerClient(string? executablePath = null)
    {
        executable = executablePath ?? Path.Combine(AppContext.BaseDirectory, "RdpWorker", OperatingSystem.IsWindows() ? "ofs-rdp-worker.exe" : "ofs-rdp-worker");
    }

    public async Task StartAsync(string host, int port, string username, string? domain, NativeRdpDisplay display, CancellationToken externalCancellation = default, NativeRdpProfileOptions? options = null)
    {
        if (process != null) throw new InvalidOperationException("RDP worker is already running.");
        if (!File.Exists(executable)) throw new FileNotFoundException("Native RDP worker is unavailable.", executable);
        if (string.IsNullOrWhiteSpace(host) || host.Length > 255 || port is < 1 or > 65535 || string.IsNullOrWhiteSpace(username)) throw new ArgumentException("Invalid RDP endpoint.");
        ValidateDisplay(display);
        process = Process.Start(new ProcessStartInfo(executable) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true }) ?? throw new InvalidOperationException("Unable to start RDP worker.");
        cancellation = CancellationTokenSource.CreateLinkedTokenSource(externalCancellation);
        SetState(NativeRdpState.Starting, null);
        _ = ReadLoopAsync(process.StandardOutput.BaseStream, cancellation.Token);
        _ = DrainErrorsAsync(process.StandardError, cancellation.Token);
        try
        {
            await SendJsonAsync(0x02, 0, new JsonObject { ["op"] = "helloAck", ["protocol"] = 1, ["maxPayload"] = MaxPayload }, cancellation.Token);
            await SendJsonAsync(0x10, NextRequest(), new JsonObject { ["op"] = "start", ["host"] = host, ["port"] = port, ["username"] = username, ["domain"] = domain ?? "", ["gateway"] = null, ["display"] = new JsonObject { ["width"] = display.Width, ["height"] = display.Height, ["dpi"] = display.Dpi }, ["features"] = (options ?? new NativeRdpProfileOptions(domain, null)).Features() }, cancellation.Token);
        }
        catch
        {
            await StopAsync("startup-failed");
            throw;
        }
    }

    public Task SendPasswordAsync(string password, CancellationToken cancellation = default) => SendJsonAsync(0x11, NextRequest(), new JsonObject { ["op"] = "credential", ["kind"] = "password", ["value"] = password }, cancellation);
    public Task AcceptCertificateAsync(uint promptRequestId, bool accept, CancellationToken cancellation = default) => SendJsonAsync(0x11, NextRequest(), new JsonObject { ["op"] = "certificate", ["requestId"] = promptRequestId, ["accept"] = accept }, cancellation);
    public Task ResizeAsync(NativeRdpDisplay display, CancellationToken cancellation = default) { ValidateDisplay(display); return SendJsonAsync(0x13, NextRequest(), new JsonObject { ["op"] = "resize", ["width"] = display.Width, ["height"] = display.Height, ["dpi"] = display.Dpi }, cancellation); }
    public Task KeyAsync(uint scanCode, bool pressed, bool extended = false, uint? unicode = null, CancellationToken cancellation = default) => SendJsonAsync(0x14, NextRequest(), new JsonObject { ["op"] = "key", ["scanCode"] = scanCode, ["pressed"] = pressed, ["extended"] = extended, ["unicode"] = unicode }, cancellation);
    public Task PointerAsync(uint x, uint y, uint buttons, int wheelX = 0, int wheelY = 0, CancellationToken cancellation = default) => SendJsonAsync(0x15, NextRequest(), new JsonObject { ["op"] = "pointer", ["x"] = x, ["y"] = y, ["buttons"] = buttons, ["wheelX"] = wheelX, ["wheelY"] = wheelY }, cancellation);
    public Task ClipboardTextAsync(string text, CancellationToken cancellation = default) => text.Length <= 1_000_000 ? SendJsonAsync(0x16, NextRequest(), new JsonObject { ["op"] = "clipboardSet", ["mime"] = "text/plain", ["text"] = text }, cancellation) : throw new ArgumentException("Clipboard text is too large.");
    public Task ClipboardGetAsync(CancellationToken cancellation = default)
    {
        var id = NextRequest();
        return SendJsonAsync(0x17, id, new JsonObject { ["op"] = "clipboardGet", ["requestId"] = id }, cancellation);
    }
    public Task RequestLocalClipboardFilesAsync(CancellationToken cancellation = default) =>
        SendJsonAsync(0x19, NextRequest(), new JsonObject { ["op"] = "clipboardLocalFiles" }, cancellation);

    public Task SetClipboardFilesAsync(IReadOnlyList<NativeRdpClipboardFile> files, CancellationToken cancellation = default)
    {
        if (files.Count is < 1 or > 64) throw new ArgumentOutOfRangeException(nameof(files), "Select between 1 and 64 files.");
        var values = new JsonArray();
        foreach (var file in files)
        {
            if (string.IsNullOrWhiteSpace(file.Path) || file.Path.Length > 32768 || string.IsNullOrWhiteSpace(file.Name) || file.Name.Length > 2048 || file.Size < 0 || file.Size > 8L * 1024 * 1024 * 1024)
                throw new ArgumentException("An RDP clipboard file is invalid.", nameof(files));
            values.Add(new JsonObject { ["path"] = file.Path, ["name"] = file.Name, ["size"] = file.Size, ["directory"] = file.Directory });
        }
        return SendJsonAsync(0x18, NextRequest(), new JsonObject { ["op"] = "clipboardFilesSet", ["files"] = values }, cancellation);
    }
    public Task ClipboardSyncAsync(bool enabled, CancellationToken cancellation = default)
        => SendJsonAsync(0x1a, NextRequest(), new JsonObject { ["op"] = "clipboardSync", ["enabled"] = enabled }, cancellation);
    public Task ClipboardCancelAsync(CancellationToken cancellation = default)
        => SendJsonAsync(0x1c, NextRequest(), new JsonObject { ["op"] = "clipboardCancel" }, cancellation);

    public Task DownloadRemoteClipboardFilesAsync(string directory, CancellationToken cancellation = default)
    {
        if (string.IsNullOrWhiteSpace(directory) || directory.Length > 32768) throw new ArgumentException("A valid destination directory is required.", nameof(directory));
        return SendJsonAsync(0x1b, NextRequest(), new JsonObject { ["op"] = "remoteFilesDownload", ["directory"] = directory }, cancellation);
    }

    public async Task StopAsync(string reason = "user")
    {
        var current = process; if (current == null) return;
        SetState(NativeRdpState.Closing, null);
        try { await SendJsonAsync(0x12, NextRequest(), new JsonObject { ["op"] = "close", ["reason"] = reason }, CancellationToken.None); } catch { }
        cancellation?.Cancel();
        if (!current.HasExited) { try { await current.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)); } catch { try { current.Kill(true); } catch { } } }
        process = null;
        current.Dispose();
        cancellation?.Dispose(); cancellation = null;
        SetState(NativeRdpState.Closed, null);
    }

    private async Task ReadLoopAsync(Stream stream, CancellationToken token)
    {
        try
        {
            var header = new byte[16];
            while (!token.IsCancellationRequested && await ReadExactAsync(stream, header, token))
            {
                if (Encoding.ASCII.GetString(header, 0, 4) != "OFSR" || BitConverter.ToUInt16(header, 4) != 1) throw new InvalidDataException("RDP worker protocol mismatch.");
                var type = header[6]; var length = BitConverter.ToUInt32(header, 8); var id = BitConverter.ToUInt32(header, 12);
                if (length > MaxPayload) throw new InvalidDataException("RDP worker payload is too large.");
                var payload = new byte[length]; if (!await ReadExactAsync(stream, payload, token)) break;
                if (type == 0x30) { ParseFrame(payload); continue; }
                try { if (JsonNode.Parse(payload)?.AsObject() is { } json) { HandleState(json); Message?.Invoke(new(type, id, json)); } } catch (JsonException) { throw new InvalidDataException("Invalid RDP worker JSON."); }
            }
            if (!token.IsCancellationRequested && State is not (NativeRdpState.Closing or NativeRdpState.Closed or NativeRdpState.Failed))
                SetState(NativeRdpState.Failed, "RDP worker exited unexpectedly.");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { SetState(NativeRdpState.Failed, error.Message); }
    }

    private void ParseFrame(byte[] payload)
    {
        if (payload.Length < 16) throw new InvalidDataException("RDP frame header is incomplete.");
        var width = BitConverter.ToUInt32(payload, 0); var height = BitConverter.ToUInt32(payload, 4); var sequence = BitConverter.ToUInt32(payload, 8); var rects = BitConverter.ToUInt16(payload, 12);
        if (width < 320 || height < 320 || width > 8192 || height > 8192 || (ulong)width * height > MaxPixels || rects is < 1 or > 1024) throw new InvalidDataException("RDP frame dimensions are invalid.");
        var offset = 16; var count = 0;
        while (offset < payload.Length)
        {
            if (++count > rects || offset + 24 > payload.Length) throw new InvalidDataException("RDP frame rectangle is invalid.");
            var x = BitConverter.ToInt32(payload, offset); var y = BitConverter.ToInt32(payload, offset + 4); var rw = BitConverter.ToUInt32(payload, offset + 8); var rh = BitConverter.ToUInt32(payload, offset + 12); var stride = BitConverter.ToUInt32(payload, offset + 16); var bytes = BitConverter.ToUInt32(payload, offset + 20); offset += 24;
            if (x < 0 || y < 0 || rw == 0 || rh == 0 || (ulong)x + rw > width || (ulong)y + rh > height || stride < rw * 4 || (ulong)stride * rh != bytes || bytes > payload.Length - offset) throw new InvalidDataException("RDP frame rectangle bounds are invalid.");
            offset += checked((int)bytes);
        }
        if (count != rects) throw new InvalidDataException("RDP frame rectangle count mismatch.");
        Frame?.Invoke(new(sequence, width, height, payload[16..]));
    }

    private void HandleState(JsonObject payload)
    {
        var op = payload["op"]?.GetValue<string>();
        if (op == "hello")
        {
            var support = payload["featureSupport"]?.AsObject() ?? new JsonObject();
            CapabilitiesReceived?.Invoke(new(
                support["clipboardText"]?.GetValue<bool>() ?? false,
                support["clipboardFilesUpload"]?.GetValue<bool>() ?? false,
                support["clipboardFilesPaste"]?.GetValue<bool>() ?? false,
                support["dragUpload"]?.GetValue<bool>() ?? false,
                support["audioPlayback"]?.GetValue<bool>() ?? false,
                payload["workerVersion"]?.GetValue<string>() ?? "unknown"));
            return;
        }
        if (op == "state")
        {
            var value = payload["state"]?.GetValue<string>();
            var error = payload["error"]?.GetValue<string>() ?? payload["errorCode"]?.GetValue<string>();
            if (Enum.TryParse<NativeRdpState>(value, true, out var state)) SetState(state, error);
        }
        else if (op == "error")
        {
            SetState(NativeRdpState.Failed, payload["message"]?.GetValue<string>() ?? payload["code"]?.GetValue<string>() ?? "RDP worker error.");
        }
    }
    private async Task SendJsonAsync(byte type, uint id, JsonObject payload, CancellationToken cancellation) { var bytes = Encoding.UTF8.GetBytes(payload.ToJsonString()); await SendFrameAsync(type, id, bytes, cancellation); }
    private async Task SendFrameAsync(byte type, uint id, byte[] payload, CancellationToken cancellation)
    {
        if (payload.Length > MaxPayload) throw new InvalidDataException("RDP worker payload is too large.");
        await writeGate.WaitAsync(cancellation);
        try
        {
            var current = process;
            if (current?.HasExited != false) throw new InvalidOperationException("RDP worker is unavailable.");
            var header = new byte[16]; Encoding.ASCII.GetBytes("OFSR").CopyTo(header, 0); BitConverter.TryWriteBytes(header.AsSpan(4), (ushort)1); header[6] = type; BitConverter.TryWriteBytes(header.AsSpan(8), (uint)payload.Length); BitConverter.TryWriteBytes(header.AsSpan(12), id);
            await current.StandardInput.BaseStream.WriteAsync(header, cancellation); await current.StandardInput.BaseStream.WriteAsync(payload, cancellation); await current.StandardInput.BaseStream.FlushAsync(cancellation);
        }
        finally { writeGate.Release(); }
    }
    private static async Task<bool> ReadExactAsync(Stream stream, byte[] buffer, CancellationToken token) { var offset = 0; while (offset < buffer.Length) { var count = await stream.ReadAsync(buffer.AsMemory(offset), token); if (count == 0) return false; offset += count; } return true; }
    private async Task DrainErrorsAsync(StreamReader reader, CancellationToken token) { try { while (await reader.ReadLineAsync(token) != null) { } } catch (OperationCanceledException) when (token.IsCancellationRequested) { } }
    private uint NextRequest() => unchecked((uint)Interlocked.Increment(ref requestId));
    private static void ValidateDisplay(NativeRdpDisplay display) { if (display.Width < 320 || display.Height < 320 || display.Width > 8192 || display.Height > 8192 || (ulong)display.Width * display.Height > MaxPixels || display.Dpi is < 96 or > 384) throw new ArgumentOutOfRangeException(nameof(display)); }
    private void SetState(NativeRdpState state, string? error) { State = state; StateChanged?.Invoke(state, error); }
    public async ValueTask DisposeAsync() { await StopAsync("shutdown"); writeGate.Dispose(); }
}
