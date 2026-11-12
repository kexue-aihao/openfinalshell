using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.Versioning;

namespace OpenFinalShell.Core;

public enum NativeInstanceRole { Primary, Secondary }
public sealed record NativeInstanceChange(string Entity, long Revision, string SourceInstanceId);

/// <summary>
/// Coordinates native windows in the current interactive user session. The
/// primary instance owns the named-pipe endpoint; secondary launches request
/// activation and then exit instead of opening another writer to the database.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class NativeInstanceCoordinator : IDisposable, IAsyncDisposable
{
    private readonly string root;
    private readonly string pipeName;
    private readonly string instanceId = Guid.NewGuid().ToString("N");
    private readonly CancellationTokenSource cancellation = new();
    private Mutex? mutex;
    private string? auth;
    private Task? serverLoop;
    private bool primary;
    private int disposed;
    public event Action? FocusRequested;
    public event Action<NativeInstanceChange>? ConfigurationChanged;
    public string InstanceId => instanceId;
    public bool IsPrimary => primary;

    public NativeInstanceCoordinator(string databaseDirectory)
    {
        root = databaseDirectory;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(databaseDirectory)))).ToLowerInvariant()[..20];
        pipeName = $"OpenFinalShell.NativePreview.{hash}";
    }

    public NativeInstanceRole Start()
    {
        var created = false;
        mutex = new Mutex(true, $"Local\\{pipeName}", out created);
        if (created)
        {
            primary = true; auth = LoadOrCreateAuth(); serverLoop = ServerLoopAsync(cancellation.Token); return NativeInstanceRole.Primary;
        }
        primary = false; return NativeInstanceRole.Secondary;
    }

    public async Task<bool> RequestFocusAsync(CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(5000);
        for (var attempt = 0; attempt < 6; attempt++)
        {
            var response = await SendAsync(new("focus", instanceId, null, null, 0), timeout.Token);
            if (response?.Kind == "ok") return true;
            await Task.Delay(250, timeout.Token);
        }
        return false;
    }

    public async Task<bool> NotifyConfigurationChangedAsync(string entity, long revision, CancellationToken cancellationToken = default)
    {
        if (!primary) return (await SendAsync(new("changed", instanceId, null, entity, revision), cancellationToken))?.Kind == "ok";
        return true;
    }

    private async Task ServerLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var pipeOptions = OperatingSystem.IsWindows() ? PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly : PipeOptions.Asynchronous;
                await using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, pipeOptions);
                await server.WaitForConnectionAsync(cancellationToken);
                await HandleClientAsync(server, cancellationToken);
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(250, cancellationToken).ConfigureAwait(false); }
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        try
        {
            using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
            var line = await reader.ReadLineAsync(cancellationToken); if (line == null) return;
            var request = JsonSerializer.Deserialize<NativePipeRequest>(line, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new InvalidDataException("Invalid native instance request.");
            if (!string.Equals(request.Auth, auth, StringComparison.Ordinal)) throw new UnauthorizedAccessException();
            switch (request.Kind)
            {
                case "focus": FocusRequested?.Invoke(); await pipe.WriteAsync(Encoding.UTF8.GetBytes("{\"kind\":\"ok\"}\n"), cancellationToken); await pipe.FlushAsync(cancellationToken); break;
                case "changed":
                    if (request.Entity is null || request.Revision < 0) throw new InvalidDataException("Invalid configuration revision.");
                    ConfigurationChanged?.Invoke(new(request.Entity, request.Revision, request.Source ?? string.Empty)); await pipe.WriteAsync(Encoding.UTF8.GetBytes("{\"kind\":\"ok\"}\n"), cancellationToken); break;
                default: throw new InvalidDataException("Unknown native instance request.");
            }
        }
        catch { try { await pipe.WriteAsync(Encoding.UTF8.GetBytes("{\"kind\":\"error\"}\n"), cancellationToken); } catch { } }
    }

    private async Task<NativePipeResponse?> SendAsync(NativePipeRequest request, CancellationToken cancellationToken)
    {
        var token = auth ?? LoadAuth(); if (token == null) return null;
        try
        {
            await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(1500);
            await pipe.ConnectAsync(timeout.Token);
            using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
            var payload = request with { Auth = token };
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }) + "\n");
            await pipe.WriteAsync(bytes, timeout.Token);
            await pipe.FlushAsync(timeout.Token);
            var response = await reader.ReadLineAsync(timeout.Token); return response == null ? null : JsonSerializer.Deserialize<NativePipeResponse>(response, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch { return null; }
    }

    private string LoadOrCreateAuth()
    {
        Directory.CreateDirectory(root); var path = Path.Combine(root, "instance-auth.bin");
        try { var protectedBytes = File.ReadAllBytes(path); return Convert.ToBase64String(ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser)); }
        catch
        {
            var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)); var protectedBytes = ProtectedData.Protect(Convert.FromBase64String(token), null, DataProtectionScope.CurrentUser); File.WriteAllBytes(path, protectedBytes); return token;
        }
    }
    private string? LoadAuth()
    {
        try { var bytes = File.ReadAllBytes(Path.Combine(root, "instance-auth.bin")); return Convert.ToBase64String(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser)); } catch { return null; }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        cancellation.Cancel();
        ReleaseMutex();
        var loop = serverLoop;
        if (loop == null || loop.IsCompleted)
        {
            cancellation.Dispose();
            return;
        }
        _ = loop.ContinueWith(_ => cancellation.Dispose(), CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        cancellation.Cancel();
        ReleaseMutex();
        try
        {
            if (serverLoop != null) await serverLoop.WaitAsync(TimeSpan.FromSeconds(1)).ConfigureAwait(false);
        }
        catch
        {
            // The named-pipe loop is cooperative and may already have exited.
        }
        finally
        {
            cancellation.Dispose();
        }
    }

    private void ReleaseMutex()
    {
        if (primary)
        {
            try { mutex?.ReleaseMutex(); } catch { }
        }
        mutex?.Dispose();
        mutex = null;
    }
    private sealed record NativePipeRequest(string Kind, string? Source, string? Auth, string? Entity, long Revision);
    private sealed record NativePipeResponse(string Kind);
}
