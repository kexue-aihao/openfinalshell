using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenFinalShell.Core;

public sealed record NativeFileEntry(string Path, long Size, string Sha256, long Offset, long Length);
public sealed record NativeFileInventory(int SchemaVersion, string Version, string Channel, string Architecture, string DataUrl, IReadOnlyList<NativeFileEntry> Files);
public sealed record NativeFileSignature(string Version, string Channel, string Sha256, string SignatureBase64);

/// <summary>Signed file inventory and ranged gzip payloads. Unchanged files are copied locally.</summary>
public static class NativeFileUpdate
{
    public const string InventoryName = "native-files.json";
    public const string SignatureName = "native-files.signature.json";
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static string Hash(string path)
    {
        using var input = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
    }

    public static void VerifySignature(NativeFileSignature signature, string publicKey)
    {
        if (!Version.TryParse(signature.Version, out _) || signature.Channel is not ("preview" or "stable") ||
            signature.Sha256.Length != 64 || !signature.Sha256.All(Uri.IsHexDigit)) throw new InvalidDataException("Invalid update signature metadata.");
        using var rsa = RSA.Create(); rsa.ImportFromPem(publicKey);
        var data = Encoding.UTF8.GetBytes($"{signature.Version}\n{signature.Channel}\n{signature.Sha256.ToLowerInvariant()}\n");
        if (!rsa.VerifyData(data, Convert.FromBase64String(signature.SignatureBase64), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new CryptographicException("Native update signature verification failed.");
    }

    public static NativeFileInventory ReadVerified(string directory, string publicKey)
    {
        var manifest = Path.Combine(directory, InventoryName);
        if (new FileInfo(manifest).Length > 4 * 1024 * 1024) throw new InvalidDataException("File inventory is too large.");
        var signature = JsonSerializer.Deserialize<NativeFileSignature>(File.ReadAllText(Path.Combine(directory, SignatureName)), Json)
            ?? throw new InvalidDataException("Missing inventory signature.");
        VerifySignature(signature, publicKey);
        if (!Hash(manifest).Equals(signature.Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("File inventory hash mismatch.");
        var inventory = JsonSerializer.Deserialize<NativeFileInventory>(File.ReadAllText(manifest), Json)
            ?? throw new InvalidDataException("Missing file inventory.");
        if (inventory.SchemaVersion != 1 || inventory.Version != signature.Version || inventory.Channel != signature.Channel ||
            inventory.Architecture != RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() ||
            inventory.Files is not { Count: > 0 and <= 10000 }) throw new InvalidDataException("File inventory does not match this application.");
        ValidateUri(new Uri(inventory.DataUrl));
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long size = 0;
        foreach (var entry in inventory.Files)
        {
            SafePath(directory, entry.Path);
            if (!names.Add(entry.Path) || entry.Path.Equals(InventoryName, StringComparison.OrdinalIgnoreCase) || entry.Path.Equals(SignatureName, StringComparison.OrdinalIgnoreCase) ||
                entry.Size < 0 || entry.Size > 2L * 1024 * 1024 * 1024 || entry.Offset < 0 || entry.Length <= 0 || entry.Length > 2L * 1024 * 1024 * 1024 ||
                entry.Offset > long.MaxValue - entry.Length || entry.Sha256.Length != 64 || !entry.Sha256.All(Uri.IsHexDigit))
                throw new InvalidDataException("Unsafe file inventory entry.");
            size += entry.Size;
        }
        if (size > 4L * 1024 * 1024 * 1024 || !names.Contains("OpenFinalShell.App.exe") || !names.Contains("UpdateHost/OpenFinalShell.UpdateHost.exe"))
            throw new InvalidDataException("Incomplete or oversized native application.");
        return inventory;
    }

    public static string SafePath(string root, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || relative.Contains('\\') || relative.Contains(':') || relative.StartsWith('/') ||
            relative.Split('/').Any(part => part is "" or "." or ".." || part.EndsWith('.') || part.EndsWith(' ') ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(part.Split('.')[0], StringComparer.OrdinalIgnoreCase)))
            throw new InvalidDataException("Unsafe native update path.");
        var fullRoot = Path.GetFullPath(root);
        var result = Path.GetFullPath(Path.Combine(fullRoot, relative));
        if (!result.StartsWith(fullRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update path escapes the application directory.");
        for (var item = result; item != null; item = Path.GetDirectoryName(item))
        {
            if ((File.Exists(item) || Directory.Exists(item)) && (File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Update paths must not contain junctions or symbolic links.");
        }
        return result;
    }

    public static bool Matches(string path, NativeFileEntry entry) => File.Exists(path) && new FileInfo(path).Length == entry.Size && Hash(path).Equals(entry.Sha256, StringComparison.OrdinalIgnoreCase);

    public static async Task StageAsync(NativeFileInventory inventory, string installed, string staging, HttpClient client, Action<int>? progress, CancellationToken cancellation)
    {
        long total = inventory.Files.Sum(file => file.Size), done = 0;
        foreach (var entry in inventory.Files)
        {
            cancellation.ThrowIfCancellationRequested();
            var destination = SafePath(staging, entry.Path);
            var source = SafePath(installed, entry.Path);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            if (!Matches(destination, entry))
            {
                if (Matches(source, entry)) File.Copy(source, destination, true);
                else await DownloadFileAsync(entry, new Uri(inventory.DataUrl), destination, client, cancellation).ConfigureAwait(false);
                if (!Matches(destination, entry)) throw new CryptographicException($"Updated file failed verification: {entry.Path}");
            }
            done += entry.Size;
            progress?.Invoke(total == 0 ? 100 : (int)(100 * done / total));
        }
    }

    private static async Task DownloadFileAsync(NativeFileEntry entry, Uri uri, string destination, HttpClient client, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Range = new RangeHeaderValue(entry.Offset, entry.Offset + entry.Length - 1);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
        ValidateUri(response.RequestMessage?.RequestUri ?? uri);
        var range = response.Content.Headers.ContentRange;
        if (response.StatusCode != HttpStatusCode.PartialContent || range?.Unit != "bytes" || range.From != entry.Offset || range.To != entry.Offset + entry.Length - 1 ||
            response.Content.Headers.ContentLength != entry.Length)
            throw new InvalidDataException("The update server did not honor a byte range; a full download was not started.");
        var partial = destination + ".partial";
        try
        {
            await using var input = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false);
            await using var gzip = new GZipStream(input, CompressionMode.Decompress);
            await using (var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[128 * 1024]; long written = 0;
                while (true)
                {
                    var read = await gzip.ReadAsync(buffer, cancellation).ConfigureAwait(false);
                    if (read == 0) break;
                    written += read;
                    if (written > entry.Size) throw new InvalidDataException("Decompressed update file exceeds its signed size.");
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellation).ConfigureAwait(false);
                }
                if (written != entry.Size) throw new InvalidDataException("Truncated update file.");
            }
            if (!Matches(partial, entry)) throw new CryptographicException("Downloaded update file hash mismatch.");
            File.Move(partial, destination, true);
        }
        finally { if (File.Exists(partial)) File.Delete(partial); }
    }

    public static void ValidateUri(Uri uri)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback))
            throw new InvalidDataException("Native update URL must use HTTPS.");
    }

    public static void VerifyStaged(NativeFileInventory inventory, string staging)
    {
        foreach (var entry in inventory.Files)
            if (!Matches(SafePath(staging, entry.Path), entry)) throw new CryptographicException($"Staged update changed: {entry.Path}");
    }

    // The journal and backups are kept until every file and inventory is committed.
    // A subsequent retry recovers an interrupted replacement before applying anything.
    public static void Apply(NativeFileInventory inventory, string staging, string target, string publicKey)
    {
        VerifyStaged(inventory, staging);
        var backup = SafePath(target, ".native-update-backup");
        if (Directory.Exists(backup)) Recover(target, backup);
        NativeFileInventory? previous = null;
        if (File.Exists(Path.Combine(target, InventoryName))) previous = ReadVerified(target, publicKey);
        var entries = inventory.Files.ToDictionary(file => file.Path, StringComparer.OrdinalIgnoreCase);
        var changes = inventory.Files.Where(file => !Matches(SafePath(target, file.Path), file)).Select(file => file.Path).ToList();
        if (previous != null) changes.AddRange(previous.Files.Where(file => !entries.ContainsKey(file.Path) && Matches(SafePath(target, file.Path), file)).Select(file => file.Path));
        changes.Add(InventoryName); changes.Add(SignatureName);
        Directory.CreateDirectory(backup);
        var journal = changes.Distinct(StringComparer.OrdinalIgnoreCase).Select(path => new BackupEntry(path, File.Exists(SafePath(target, path)))).ToArray();
        // Snapshot everything before making the first change. A crash before the
        // journal is written means no target file has been touched.
        foreach (var entry in journal.Where(entry => entry.Existed))
        {
            var saved = SafePath(backup, entry.Path); Directory.CreateDirectory(Path.GetDirectoryName(saved)!);
            File.Copy(SafePath(target, entry.Path), saved, true);
        }
        File.WriteAllText(Path.Combine(backup, "journal.json"), JsonSerializer.Serialize(journal));
        try
        {
            foreach (var entry in journal)
            {
                var destination = SafePath(target, entry.Path);
                if (entries.TryGetValue(entry.Path, out var file) || entry.Path is InventoryName or SignatureName)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    var temp = SafePath(target, entry.Path + ".native-new");
                    File.Copy(SafePath(staging, entry.Path), temp, true);
                    if (file != null && !Matches(temp, file)) throw new CryptographicException("Update source changed during installation.");
                    File.Move(temp, destination, true);
                }
                else File.Delete(destination);
            }
            ReadVerified(target, publicKey);
            File.WriteAllText(Path.Combine(backup, "complete"), inventory.Version);
        }
        catch { Recover(target, backup); throw; }
        // Cleanup cannot turn a successfully committed update into a failure.
        try { Directory.Delete(backup, true); } catch (IOException) { }
    }

    private sealed record BackupEntry(string Path, bool Existed);
    private static void Recover(string target, string backup)
    {
        var journal = Path.Combine(backup, "journal.json");
        if (File.Exists(journal) && !File.Exists(Path.Combine(backup, "complete")))
        {
            foreach (var entry in (JsonSerializer.Deserialize<BackupEntry[]>(File.ReadAllText(journal)) ?? []).Reverse())
            {
                var path = SafePath(target, entry.Path);
                if (entry.Existed)
                {
                    var saved = SafePath(backup, entry.Path);
                    if (!File.Exists(path) || !Hash(path).Equals(Hash(saved), StringComparison.OrdinalIgnoreCase)) File.Copy(saved, path, true);
                }
                else if (File.Exists(path)) File.Delete(path);
                var pending = SafePath(target, entry.Path + ".native-new");
                if (File.Exists(pending)) File.Delete(pending);
            }
        }
        Directory.Delete(backup, true);
    }
}
