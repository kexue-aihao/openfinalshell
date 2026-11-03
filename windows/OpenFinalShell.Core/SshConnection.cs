using Renci.SshNet;
using Renci.SshNet.Common;
using Renci.SshNet.Sftp;
using System.Reflection;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

/// <summary>Owns one SSH transport. Host verification runs before credentials are sent.</summary>
public sealed class SshConnection : IDisposable
{
    private sealed class InlineProgress<T>(Action<T> callback) : IProgress<T>
    {
        public void Report(T value) => callback(value);
    }

    private readonly NativeStore store;
    private readonly SshClient client;
    private readonly ConnectionInfo info;
    private readonly Func<HostKeyChallenge, Task<bool>> confirmHost;
    private readonly string terminalType;
    private readonly string startupCommand;
    private readonly TerminalCharsetCodec terminalCodec;
    private readonly string hostKeyHost;
    private readonly int hostKeyPort;
    private readonly List<IDisposable> owned = [];
    private readonly Dictionary<string, NativeForwardBridge> forwards = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Action<Exception>> forwardFailureHandlers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ForwardTelemetrySnapshot> forwardTelemetry = new(StringComparer.Ordinal);
    private readonly List<ForwardedPortLocal> jumpTunnels = [];
    private readonly SemaphoreSlim sftpGate = new(1);
    private SftpClient? sftp;
    private ShellStream? shell;
    public event Action<byte[]>? Output;
    public event Action<Exception>? Failed;
    public event Action<ForwardTelemetrySnapshot>? ForwardTelemetryChanged;
    public event Action<string, Exception>? ForwardFailed;
    public bool Connected => client.IsConnected;

    public SshConnection(ConnectionProfile profile, NativeStore store,
        Func<HostKeyChallenge, Task<bool>> confirmHost,
        Func<string, bool, Task<string?>> prompt,
        string? resolvedPassword = null,
        string? connectHost = null,
        int? connectPort = null)
    {
        this.store = store; this.confirmHost = confirmHost;
        var data = profile.Data;
        hostKeyHost = profile.Host;
        hostKeyPort = profile.Port;
        terminalType = data["terminal"]?["termType"]?.GetValue<string>() is { Length: > 0 and <= 128 } configuredTerm
            ? configuredTerm : "xterm-256color";
        startupCommand = data["terminal"]?["startupCommand"]?.GetValue<string>() ?? string.Empty;
        terminalCodec = new TerminalCharsetCodec(data["terminal"]?["charset"]?.GetValue<string>());
        if (startupCommand.Length > 8192 || startupCommand.Contains('\0'))
            throw new InvalidDataException("Invalid startup command.");
        if (data["protocol"]?.GetValue<string>() == "rdp")
            throw new NotSupportedException("native.errors.transportUnavailable");
        if (data["jumpHostId"] != null && connectHost == null)
            throw new InvalidOperationException("Jump host must be resolved by the native session manager.");
        var auth = data["auth"]?.AsObject() ?? new JsonObject { ["method"] = "password" };
        List<AuthenticationMethod> methods = [];
        switch (auth["method"]?.GetValue<string>())
        {
            case "password":
                var password = store.ReadSecret(auth["passwordRef"]?.GetValue<string>()) ?? resolvedPassword;
                if (password == null) throw new InvalidOperationException("Password authentication requires an asynchronously resolved credential.");
                methods.Add(new PasswordAuthenticationMethod(profile.Username, password));
                var interactive = new KeyboardInteractiveAuthenticationMethod(profile.Username);
                interactive.AuthenticationPrompt += (_, e) => {
                    foreach (var item in e.Prompts)
                        item.Response = prompt(item.Request, item.IsEchoed).GetAwaiter().GetResult()
                            ?? throw new OperationCanceledException();
                };
                methods.Add(interactive);
                break;
            case "privateKey":
                var keyEntity = auth["privateKeyId"]?.GetValue<string>() is { } keyId ? store.Find("privateKeys", keyId) : null;
                var path = keyEntity?["path"]?.GetValue<string>() ?? auth["privateKeyPath"]?.GetValue<string>();
                if (path == null || !File.Exists(path)) throw new FileNotFoundException("native.errors.privateKeyMissing");
                var phraseRef = keyEntity?["passphraseRef"] ?? auth["passphraseRef"];
                var phrase = store.ReadSecret(phraseRef?.GetValue<string>());
                var privateKey = phrase == null ? new PrivateKeyFile(path) : new PrivateKeyFile(path, phrase);
                owned.Add(privateKey); methods.Add(new PrivateKeyAuthenticationMethod(profile.Username, privateKey));
                break;
            case "agent":
                methods.Add(new AgentAuthenticationMethod(profile.Username, NativeSshAgent.Discover()));
                break;
            default: throw new InvalidDataException("Unsupported SSH authentication method.");
        }
        var proxy = data["proxyMode"]?.GetValue<string>() == "direct" ? null
            : data["proxyId"]?.GetValue<string>() is { } proxyId ? store.Find("proxies", proxyId) : data["proxy"] as JsonObject;
        if (proxy != null && proxy["type"]?.GetValue<string>() != "none")
        {
            if (connectHost != null)
                throw new InvalidOperationException("native.errors.jumpProxyUnsupported");
            var type = proxy["type"]?.GetValue<string>() switch {
                "http" => ProxyTypes.Http, "socks5" => ProxyTypes.Socks5,
                _ => throw new InvalidDataException("native.errors.invalidProxy") };
            info = new ConnectionInfo(connectHost ?? profile.Host, connectPort ?? profile.Port, profile.Username, type,
                proxy["host"]!.GetValue<string>(), proxy["port"]!.GetValue<int>(),
                proxy["username"]?.GetValue<string>() ?? "", store.ReadSecret(proxy["passwordRef"]?.GetValue<string>()) ?? "", methods.ToArray());
        }
        else info = new ConnectionInfo(connectHost ?? profile.Host, connectPort ?? profile.Port, profile.Username, methods.ToArray());
        info.Timeout = TimeSpan.FromMilliseconds(data["options"]?["readyTimeout"]?.GetValue<int>() ?? 20000);
        client = new SshClient(info) { KeepAliveInterval = TimeSpan.FromMilliseconds(data["options"]?["keepaliveInterval"]?.GetValue<int>() ?? 15000) };
        client.HostKeyReceived += VerifyHost;
        client.ErrorOccurred += (_, e) => Failed?.Invoke(e.Exception);
    }
    private void VerifyHost(object? sender, HostKeyEventArgs e)
    {
        e.CanTrust = false;
        var key = $"{hostKeyHost}:{hostKeyPort}:{e.HostKeyName}";
        var fingerprint = "SHA256:" + Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(e.HostKey)).TrimEnd('=');
        var known = store.Find("knownHosts", key);
        if (known?["fingerprintSha256"]?.GetValue<string>() == fingerprint) { e.CanTrust = true; return; }
        if (!confirmHost(new(hostKeyHost, hostKeyPort, e.HostKeyName, fingerprint, known != null)).GetAwaiter().GetResult()) return;
        store.Save("knownHosts", key, new() { ["key"] = key, ["keyType"] = e.HostKeyName,
            ["fingerprintSha256"] = fingerprint, ["addedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, known?["_revision"]?.GetValue<long>() ?? 0);
        e.CanTrust = true;
    }
    public async Task ConnectAsync(uint columns, uint rows, CancellationToken cancellation, bool openShell = true)
    {
        // SSH.NET's host-key and keyboard-interactive callbacks are synchronous.
        // Keep them off the WinUI dispatcher because those callbacks may wait for
        // a confirmation/input dialog posted to that dispatcher.
        await Task.Run(async () => await client.ConnectAsync(cancellation).ConfigureAwait(false), cancellation).ConfigureAwait(false);
        if (!openShell) return;
        shell = client.CreateShellStream(terminalType, columns, rows, 0, 0, 65536);
        shell.DataReceived += (_, e) => Output?.Invoke(e.Data);
        shell.ErrorOccurred += (_, e) => Failed?.Invoke(e.Exception);
        if (!string.IsNullOrWhiteSpace(startupCommand))
        {
            shell.Write(terminalCodec.EncodeText(startupCommand + "\r"));
            shell.Flush();
        }
    }

    public int StartJumpTunnel(string destinationHost, int destinationPort)
    {
        if (!client.IsConnected) throw new InvalidOperationException("Jump host is not connected.");
        if (string.IsNullOrWhiteSpace(destinationHost) || destinationPort is < 1 or > 65535)
            throw new InvalidDataException("Jump host destination is invalid.");
        var tunnel = new ForwardedPortLocal("127.0.0.1", 0, destinationHost, checked((uint)destinationPort));
        client.AddForwardedPort(tunnel);
        try
        {
            tunnel.Start();
            jumpTunnels.Add(tunnel);
            return checked((int)tunnel.BoundPort);
        }
        catch { tunnel.Dispose(); throw; }
    }
    public void Write(byte[] bytes) { shell?.Write(bytes, 0, bytes.Length); shell?.Flush(); }
    public void Resize(uint columns, uint rows) => shell?.ChangeWindowSize(columns, rows, 0, 0);
    private async Task<SftpClient> GetSftp(CancellationToken token)
    {
        if (sftp?.IsConnected == true) return sftp;
        sftp?.Dispose(); sftp = new SftpClient(info); sftp.HostKeyReceived += VerifyHost;
        await Task.Run(async () => await sftp.ConnectAsync(token).ConfigureAwait(false), token).ConfigureAwait(false); return sftp;
    }
    public async Task<IReadOnlyList<RemoteEntry>> ListAsync(string path, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try {
            var transport = await GetSftp(token); List<RemoteEntry> entries = [];
            await foreach (var item in transport.ListDirectoryAsync(path, token))
                if (item.Name is not "." and not "..") entries.Add(ToRemoteEntry(item));
            return entries.OrderByDescending(v => v.IsDirectory).ThenBy(v => v.Name).ToArray();
        } finally { sftpGate.Release(); }
    }

    public async Task<string> RealPathAsync(string path, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            // Use the SFTP REALPATH request rather than local string
            // normalization. This resolves symlinks and server-specific home
            // directory semantics and keeps navigation consistent with the
            // remote file system.
            var value = string.IsNullOrWhiteSpace(path) ? "." : path.Trim();
            // SSH.NET exposes REALPATH on ISftpSession while keeping the
            // session accessor internal on SftpClient. Use the public protocol
            // interface through that accessor when available, with a safe
            // lexical fallback for older SSH.NET builds.
            var sessionProperty = typeof(SftpClient).GetProperty("SftpSession", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (sessionProperty?.GetValue(client) is { } session)
            {
                var method = session.GetType().GetMethod("GetCanonicalPathAsync", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, binder: null, types: [typeof(string), typeof(CancellationToken)], modifiers: null);
                if (method?.Invoke(session, [value, token]) is Task<string> canonical)
                    return await canonical;
            }
            if (value == ".") return client.WorkingDirectory;
            if (value.StartsWith('/')) return NormalizeRemotePath(value);
            return NormalizeRemotePath(client.WorkingDirectory.TrimEnd('/') + "/" + value);
        }
        finally { sftpGate.Release(); }
    }

    public async Task<NativeDeletePreview> PreviewDeleteAsync(string path, CancellationToken token, int maxEntries = 10000)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            var root = client.Get(path);
            long entries = 0, files = 0, bytes = 0; var symlink = false; var truncated = false;
            async Task VisitAsync(Renci.SshNet.Sftp.ISftpFile item)
            {
                if (++entries > maxEntries) { truncated = true; return; }
                if (item.IsSymbolicLink) { symlink = true; return; }
                if (!item.IsDirectory) { files++; bytes = checked(bytes + Math.Max(0, item.Length)); return; }
                await foreach (var child in client.ListDirectoryAsync(item.FullName, token))
                {
                    if (child.Name is "." or "..") continue;
                    await VisitAsync(child);
                    if (truncated) break;
                }
            }
            await VisitAsync(root);
            return new(path, entries, files, bytes, symlink, truncated);
        }
        finally { sftpGate.Release(); }
    }
    public async Task DownloadAsync(string path, Stream destination, CancellationToken token, Action<long>? progress = null, long resumeOffset = 0)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            await using var source = client.OpenRead(path);
            if (resumeOffset < 0) throw new ArgumentOutOfRangeException(nameof(resumeOffset));
            if (resumeOffset > 0)
            {
                if (!source.CanSeek || !destination.CanSeek) throw new NotSupportedException("Resume is not supported by this stream.");
                if (resumeOffset > source.Length) throw new ArgumentOutOfRangeException(nameof(resumeOffset));
                source.Position = resumeOffset; destination.Position = resumeOffset;
            }
            await CopyWithProgressAsync(source, destination, token, progress, resumeOffset);
        }
        finally { sftpGate.Release(); }
    }
    // Uploads default to no overwrite. The caller must obtain explicit conflict consent.
    public async Task UploadAsync(Stream source, string path, bool overwrite, CancellationToken token, Action<long>? progress = null, long resumeOffset = 0)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            var mode = resumeOffset > 0 ? FileMode.OpenOrCreate : (overwrite ? FileMode.Create : FileMode.CreateNew);
            await using var destination = client.Open(path, mode, FileAccess.Write);
            if (resumeOffset < 0) throw new ArgumentOutOfRangeException(nameof(resumeOffset));
            if (resumeOffset > 0)
            {
                if (!source.CanSeek || !destination.CanSeek) throw new NotSupportedException("Resume is not supported by this stream.");
                if (resumeOffset > source.Length) throw new ArgumentOutOfRangeException(nameof(resumeOffset));
                source.Position = resumeOffset; destination.Position = resumeOffset;
            }
            await CopyWithProgressAsync(source, destination, token, progress, resumeOffset);
        }
        finally { sftpGate.Release(); }
    }

    private static async Task CopyWithProgressAsync(Stream source, Stream destination, CancellationToken token, Action<long>? progress, long initial)
    {
        var buffer = new byte[128 * 1024]; var total = initial;
        while (true)
        {
            var read = await source.ReadAsync(buffer, token);
            if (read == 0) break;
            await destination.WriteAsync(buffer.AsMemory(0, read), token);
            total += read; progress?.Invoke(total);
        }
        await destination.FlushAsync(token);
    }

    public async Task<RemoteEntry?> TryGetAsync(string path, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            try
            {
                if (!client.Exists(path)) return null;
                var item = client.Get(path);
                return string.IsNullOrEmpty(item.Name) ? null : ToRemoteEntry(item);
            }
            catch (Renci.SshNet.Common.SftpPathNotFoundException) { return null; }
        }
        finally { sftpGate.Release(); }
    }

    public async Task CreateFileAsync(string path, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            if (client.Exists(path)) throw new IOException("Remote file already exists.");
            await using var stream = await client.OpenAsync(path, FileMode.CreateNew, FileAccess.Write, token);
        }
        finally { sftpGate.Release(); }
    }

    public async Task<byte[]> ReadFileAsync(string path, CancellationToken token, long maxBytes = long.MaxValue)
    {
        if (maxBytes < 0) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        await sftpGate.WaitAsync(token);
        try
        {
            await using var source = (await GetSftp(token)).OpenRead(path);
            if (source.CanSeek && source.Length > maxBytes)
                throw new InvalidOperationException($"Remote file exceeds the {maxBytes} byte read limit.");
            using var buffer = new MemoryStream(source.CanSeek ? (int)Math.Min(Math.Min(source.Length, maxBytes), 64 * 1024) : 0);
            var chunk = new byte[32 * 1024];
            while (true)
            {
                var read = await source.ReadAsync(chunk, token);
                if (read == 0) break;
                if (buffer.Length + read > maxBytes)
                    throw new InvalidOperationException($"Remote file exceeds the {maxBytes} byte read limit.");
                buffer.Write(chunk, 0, read);
            }
            return buffer.ToArray();
        }
        finally { sftpGate.Release(); }
    }

    /// <summary>Writes a remote file through a same-directory temporary file and rename.</summary>
    public async Task WriteFileAtomicAsync(string path, byte[] bytes, bool overwrite, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            if (!overwrite && client.Exists(path)) throw new IOException("Remote file already exists.");
            var temporary = $"{path}.ofs-edit-{Guid.NewGuid():N}";
            try
            {
                await using (var destination = client.Open(temporary, FileMode.Create, FileAccess.Write))
                {
                    await destination.WriteAsync(bytes, token);
                    await destination.FlushAsync(token);
                }
                if (client.Exists(path))
                {
                    var backup = $"{path}.ofs-backup-{Guid.NewGuid():N}";
                    await RenameExactAsync(client, path, backup, token);
                    try { await RenameExactAsync(client, temporary, path, token); }
                    catch { try { await RenameExactAsync(client, backup, path, CancellationToken.None); } catch { } throw; }
                    try { await client.DeleteFileAsync(backup, CancellationToken.None); } catch { }
                }
                else await RenameExactAsync(client, temporary, path, token);
            }
            finally { try { if (client.Exists(temporary)) await client.DeleteFileAsync(temporary, CancellationToken.None); } catch { } }
        }
        finally { sftpGate.Release(); }
    }

    private static RemoteEntry ToRemoteEntry(ISftpFile item)
    {
        var type = item.IsDirectory ? NativeRemoteEntryType.Directory
            : item.IsSymbolicLink ? NativeRemoteEntryType.Symlink
            : item.IsRegularFile ? NativeRemoteEntryType.File
            : NativeRemoteEntryType.Other;
        var mode = PermissionMode(item.Attributes);
        return new(item.Name, item.FullName, item.Length, item.IsDirectory, item.LastWriteTime, type, mode, item.UserId, item.GroupId, item.IsSymbolicLink);
    }

    private static int PermissionMode(SftpFileAttributes attributes)
    {
        var mode = 0;
        if (attributes.OwnerCanRead) mode |= 256; if (attributes.OwnerCanWrite) mode |= 128; if (attributes.OwnerCanExecute) mode |= 64;
        if (attributes.GroupCanRead) mode |= 32; if (attributes.GroupCanWrite) mode |= 16; if (attributes.GroupCanExecute) mode |= 8;
        if (attributes.OthersCanRead) mode |= 4; if (attributes.OthersCanWrite) mode |= 2; if (attributes.OthersCanExecute) mode |= 1;
        if (attributes.IsUIDBitSet) mode |= 2048; if (attributes.IsGroupIDBitSet) mode |= 1024; if (attributes.IsStickyBitSet) mode |= 512;
        return mode;
    }

    public async Task CreateDirectoryAsync(string path, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try { await (await GetSftp(token)).CreateDirectoryAsync(path, token); }
        finally { sftpGate.Release(); }
    }

    public async Task DeleteAsync(string path, bool recursive, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try
        {
            var client = await GetSftp(token);
            var entry = client.Get(path);
            if (!entry.IsDirectory) { await client.DeleteFileAsync(path, token); return; }
            if (recursive)
            {
                await foreach (var child in client.ListDirectoryAsync(path, token))
                    if (child.Name is not "." and not "..") await DeleteEntryAsync(client, child, token);
            }
            await client.DeleteDirectoryAsync(path, token);
        }
        finally { sftpGate.Release(); }
    }

    private static async Task DeleteEntryAsync(SftpClient client, Renci.SshNet.Sftp.ISftpFile entry, CancellationToken token)
    {
        if (entry.IsDirectory)
        {
            await foreach (var child in client.ListDirectoryAsync(entry.FullName, token))
                if (child.Name is not "." and not "..") await DeleteEntryAsync(client, child, token);
            await client.DeleteDirectoryAsync(entry.FullName, token);
        }
        else await client.DeleteFileAsync(entry.FullName, token);
    }

    public async Task RenameAsync(string from, string to, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try { await RenameExactAsync(await GetSftp(token), from, to, token); }
        finally { sftpGate.Release(); }
    }

    private static async Task RenameExactAsync(SftpClient client, string from, string to, CancellationToken token)
    {
        var oldPath = NormalizeRemotePath(from);
        var newPath = NormalizeRemotePath(to);
        var sessionProperty = typeof(SftpClient).GetProperty("SftpSession", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (sessionProperty?.GetValue(client) is { } session)
        {
            var method = session.GetType().GetMethod("RequestRenameAsync", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, binder: null,
                types: [typeof(string), typeof(string), typeof(CancellationToken)], modifiers: null);
            if (method?.Invoke(session, [oldPath, newPath, token]) is Task request)
            {
                await request;
                return;
            }
        }
        await client.RenameFileAsync(oldPath, newPath, token);
    }

    public async Task ChmodAsync(string path, short mode, CancellationToken token)
    {
        await sftpGate.WaitAsync(token);
        try { (await GetSftp(token)).ChangePermissions(path, mode); }
        finally { sftpGate.Release(); }
    }
    private static string NormalizeRemotePath(string value)
    {
        var parts = value.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var output = new List<string>();
        foreach (var part in parts)
        {
            if (part == ".") continue;
            if (part == "..") { if (output.Count > 0) output.RemoveAt(output.Count - 1); continue; }
            output.Add(part);
        }
        return "/" + string.Join('/', output);
    }
    public void StartForward(JsonObject rule) => StartForward(Guid.NewGuid().ToString("N"), rule);
    public void StartForward(string id, JsonObject rule)
    {
        if (forwards.ContainsKey(id)) throw new InvalidOperationException("Forward is already active.");
        var bridge = new NativeForwardBridge(client, id, rule);
        bridge.TelemetryChanged += PublishForwardTelemetry;
        Action<Exception> failed = error => ForwardFailed?.Invoke(id, error);
        bridge.Failed += failed;
        try
        {
            bridge.Start(); forwards.Add(id, bridge); forwardFailureHandlers[id] = failed;
            PublishForwardTelemetry(new(id, 0, 0));
        }
        catch { bridge.Dispose(); throw; }
    }
    public void StopForward(string id)
    {
        if (!forwards.Remove(id, out var bridge)) return;
        if (forwardFailureHandlers.Remove(id, out var failed)) bridge.Failed -= failed;
        bridge.TelemetryChanged -= PublishForwardTelemetry;
        bridge.Dispose();
        PublishForwardTelemetry(new(id, 0, bridge.Snapshot.TotalBytes));
    }
    public ForwardTelemetrySnapshot? ForwardTelemetryOf(string id) => forwardTelemetry.GetValueOrDefault(id);
    private void PublishForwardTelemetry(ForwardTelemetrySnapshot snapshot)
    {
        forwardTelemetry[snapshot.ForwardId] = snapshot;
        ForwardTelemetryChanged?.Invoke(snapshot);
    }
    public async Task<string> ExecuteAsync(string command, CancellationToken token)
    {
        using var cmd = client.CreateCommand(command); cmd.CommandTimeout = TimeSpan.FromSeconds(30);
        await cmd.ExecuteAsync(token); return cmd.Result;
    }
    public void Dispose() { shell?.Dispose(); sftp?.Dispose(); foreach (var id in forwards.Keys.ToArray()) StopForward(id); foreach (var tunnel in jumpTunnels) { try { tunnel.Stop(); } catch { } tunnel.Dispose(); } jumpTunnels.Clear(); client.Dispose(); foreach (var item in owned) item.Dispose(); }
}
