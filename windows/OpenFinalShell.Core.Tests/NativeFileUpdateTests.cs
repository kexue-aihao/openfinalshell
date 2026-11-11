using OpenFinalShell.Core;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenFinalShell.Core.Tests;

internal static class NativeFileUpdateTests
{
    public static async Task RunAsync(Action<bool, string> check, string root)
    {
        var test = Path.Combine(root, "file-update-" + Guid.NewGuid().ToString("N"));
        var installed = Path.Combine(test, "installed"); var staging = Path.Combine(test, "staging");
        Directory.CreateDirectory(installed); Directory.CreateDirectory(staging);
        using var rsa = RSA.Create(2048); var key = rsa.ExportSubjectPublicKeyInfoPem();
        var files = new Dictionary<string, string>
        {
            ["OpenFinalShell.App.exe"] = "new application",
            ["UpdateHost/OpenFinalShell.UpdateHost.exe"] = "unchanged helper",
            ["shared.dll"] = "unchanged runtime",
            ["Assets/new.txt"] = "新内容🙂",
            ["large.bin"] = new string('x', 512 * 1024)
        };
        using var payload = new MemoryStream();
        var entries = new List<NativeFileEntry>();
        foreach (var (path, value) in files)
        {
            var bytes = Encoding.UTF8.GetBytes(value); var offset = payload.Position;
            using (var gzip = new GZipStream(payload, CompressionLevel.SmallestSize, true)) gzip.Write(bytes);
            entries.Add(new(path, bytes.Length, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), offset, payload.Position - offset));
            if (path != "Assets/new.txt")
            {
                var local = NativeFileUpdate.SafePath(installed, path); Directory.CreateDirectory(Path.GetDirectoryName(local)!);
                File.WriteAllText(local, path == "OpenFinalShell.App.exe" ? "old application" : value);
            }
        }
        var inventory = new NativeFileInventory(1, "1.2.3", "preview", RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), "http://127.0.0.1/update.ofsdata", entries);
        Sign(staging, inventory, rsa);
        var verified = NativeFileUpdate.ReadVerified(staging, key);
        var signed = JsonSerializer.Deserialize<NativeFileSignature>(File.ReadAllText(Path.Combine(staging, NativeFileUpdate.SignatureName)))!;
        var descriptor = new
        {
            schemaVersion = 1, version = "1.2.3", channel = "preview", architecture = inventory.Architecture,
            fileName = "inventory.json", downloadUrl = "http://127.0.0.1/inventory", sha256 = signed.Sha256,
            signature = signed.SignatureBase64, bytes = new FileInfo(Path.Combine(staging, NativeFileUpdate.InventoryName)).Length
        };
        var feed = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1, version = "1.2.3", channel = "preview", architecture = inventory.Architecture,
            fileName = "unused.exe", downloadUrl = "http://127.0.0.1/unused.exe", sha256 = signed.Sha256,
            signature = signed.SignatureBase64, bytes = descriptor.bytes, incremental = descriptor
        });
        using (var store = new NativeStore(Path.Combine(test, "service-store"), new TestProtector()))
        using (var sessions = new NativeSessionManager(store))
        using (var transfers = new NativeTransferQueue(sessions))
        using (var forwards = new NativeForwardManager(store, sessions))
        using (var serviceHandler = new Ranges(payload.ToArray(), false, feed, File.ReadAllBytes(Path.Combine(staging, NativeFileUpdate.InventoryName))))
        using (var serviceClient = new HttpClient(serviceHandler))
        using (var service = new NativeUpdateService(new NativeUpdateCoordinator(sessions, transfers, forwards, key, test), "1.2.2", key,
            new Uri("http://127.0.0.1/feed"), Path.Combine(test, "download"), serviceClient, installed))
        {
            var states = new List<NativeUpdateSnapshot>();
            service.StateChanged += states.Add;
            var artifact = await service.CheckAndDownloadAsync();
            check(artifact?.StagingDirectory != null && service.State.Status == NativeUpdateStatus.Ready && serviceHandler.Requests == 2,
                "Update service selects the signed incremental inventory and never requests the full installer");
            var applyingIndex = states.FindIndex(state => state.Status == NativeUpdateStatus.Applying);
            check(applyingIndex >= 0 && states.Take(applyingIndex).All(state => state.Status != NativeUpdateStatus.Ready)
                && states[^1].Status == NativeUpdateStatus.Ready && states.Any(state => state.Status == NativeUpdateStatus.Verifying),
                "Incremental updates report applying and verification phases without a false ready state between stages");
        }
        using var handler = new Ranges(payload.ToArray()); using var client = new HttpClient(handler);
        var stageProgress = new List<int>();
        await NativeFileUpdate.StageAsync(verified, installed, staging, client, stageProgress.Add, CancellationToken.None);
        check(stageProgress.Count > 4 && stageProgress[^1] == 100 && stageProgress.All(value => value is >= 0 and <= 100)
            && stageProgress.SequenceEqual(stageProgress.OrderBy(value => value)),
            "Incremental staging reports monotonic byte-level progress through final verification");
        check(handler.Requests == 2, "Incremental updater downloads only the two changed/new files, reusing two local files");
        check(handler.Bytes < payload.Length, "Incremental transfer is smaller than the full payload");
        NativeFileUpdate.VerifyStaged(verified, staging);
        File.WriteAllText(Path.Combine(installed, "personal.txt"), "retain user file");
        File.WriteAllText(Path.Combine(installed, "obsolete.dll"), "old signed file");
        var obsolete = new NativeFileEntry("obsolete.dll", 15, NativeFileUpdate.Hash(Path.Combine(installed, "obsolete.dll")), 0, 1);
        Sign(installed, inventory with { Version = "1.2.2", Files = [.. entries, obsolete] }, rsa);
        NativeFileUpdate.Apply(verified, staging, installed, key);
        check(File.ReadAllText(Path.Combine(installed, "OpenFinalShell.App.exe")) == files["OpenFinalShell.App.exe"] && !File.Exists(Path.Combine(installed, "obsolete.dll")), "Update replaces changed files and removes obsolete signed files");
        check(File.ReadAllText(Path.Combine(installed, "personal.txt")) == "retain user file", "Incremental update preserves unknown user files");
        check(NativeFileUpdate.ReadVerified(installed, key).Version == "1.2.3", "Successful update commits its signed inventory");
        File.WriteAllText(Path.Combine(installed, "OpenFinalShell.App.exe"), "rollback baseline");
        File.WriteAllText(Path.Combine(installed, "shared.dll"), "locked baseline");
        var rolledBack = false;
        using (var locked = new FileStream(Path.Combine(installed, "shared.dll"), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            try { NativeFileUpdate.Apply(verified, staging, installed, key); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { rolledBack = true; }
            check(rolledBack && File.ReadAllText(Path.Combine(installed, "OpenFinalShell.App.exe")) == "rollback baseline",
                "A locked file rolls back files already replaced and leaves the old application intact");
        }
        NativeFileUpdate.Apply(verified, staging, installed, key);
        check(!Directory.Exists(Path.Combine(installed, ".native-update-backup")), "Retry after failed update succeeds and removes the completed transaction backup");
        var rejected = false;
        File.AppendAllText(Path.Combine(staging, "OpenFinalShell.App.exe"), "tamper");
        try { NativeFileUpdate.Apply(verified, staging, installed, key); } catch (CryptographicException) { rejected = true; }
        check(rejected && File.ReadAllText(Path.Combine(installed, "OpenFinalShell.App.exe")) == files["OpenFinalShell.App.exe"], "Staged file tampering is rejected before installation changes");
        foreach (var path in new[] { "../outside", "C:/outside", "folder/../file", "file:stream", "CON.txt", "file.", "/absolute" })
        {
            rejected = false; try { NativeFileUpdate.SafePath(test, path); } catch (InvalidDataException) { rejected = true; }
            check(rejected, "Update rejects unsafe path: " + path);
        }
        using var ignored = new HttpClient(new Ranges(payload.ToArray(), true));
        rejected = false;
        try { await NativeFileUpdate.StageAsync(verified, installed, staging, ignored, null, CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
        // The corrupted cached file is repaired locally, without any download.
        check(!rejected && File.ReadAllText(Path.Combine(staging, "OpenFinalShell.App.exe")) == files["OpenFinalShell.App.exe"], "A corrupted staging cache is repaired from verified installed bytes");
        var empty = Path.Combine(test, "empty"); Directory.CreateDirectory(empty);
        var fresh = Path.Combine(test, "fresh"); Directory.CreateDirectory(fresh);
        rejected = false;
        try { await NativeFileUpdate.StageAsync(verified, empty, fresh, ignored, null, CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
        check(rejected, "Range-ignoring server fails without silently downloading the full program");
        Sign(staging, inventory with { Architecture = "wrong" }, rsa);
        rejected = false; try { NativeFileUpdate.ReadVerified(staging, key); } catch (InvalidDataException) { rejected = true; }
        check(rejected, "Incremental inventory rejects wrong architecture even with a valid signature");
        Sign(staging, inventory, rsa);
        File.AppendAllText(Path.Combine(staging, NativeFileUpdate.InventoryName), " ");
        rejected = false; try { NativeFileUpdate.ReadVerified(staging, key); } catch (CryptographicException) { rejected = true; }
        check(rejected, "Incremental inventory rejects signature/hash mismatch");
    }

    private static void Sign(string directory, NativeFileInventory inventory, RSA rsa)
    {
        var path = Path.Combine(directory, NativeFileUpdate.InventoryName);
        File.WriteAllText(path, JsonSerializer.Serialize(inventory));
        var hash = NativeFileUpdate.Hash(path);
        var signature = Convert.ToBase64String(rsa.SignData(Encoding.UTF8.GetBytes($"{inventory.Version}\n{inventory.Channel}\n{hash}\n"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        File.WriteAllText(Path.Combine(directory, NativeFileUpdate.SignatureName), JsonSerializer.Serialize(new NativeFileSignature(inventory.Version, inventory.Channel, hash, signature)));
    }

    private sealed class Ranges(byte[] payload, bool ignore = false, byte[]? feed = null, byte[]? inventory = null) : HttpMessageHandler
    {
        public int Requests; public long Bytes;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri?.AbsolutePath == "/feed" && feed != null)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(feed), RequestMessage = request });
            if (request.RequestUri?.AbsolutePath == "/inventory" && inventory != null)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(inventory), RequestMessage = request });
            var range = request.Headers.Range?.Ranges.Single() ?? throw new Exception("Missing byte range");
            var from = (int)range.From!; var to = (int)range.To!;
            var content = new ByteArrayContent(payload[from..(to + 1)]);
            content.Headers.ContentRange = new ContentRangeHeaderValue(from, to, payload.Length);
            Requests++; Bytes += to - from + 1;
            return Task.FromResult(new HttpResponseMessage(ignore ? HttpStatusCode.OK : HttpStatusCode.PartialContent) { RequestMessage = request, Content = content });
        }
    }
}
