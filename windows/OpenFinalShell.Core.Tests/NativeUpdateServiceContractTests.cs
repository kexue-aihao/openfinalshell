using OpenFinalShell.Core;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core.Tests;

public static class NativeUpdateServiceContractTests
{
    public static async Task RunAsync(Action<bool, string> check, string root)
    {
        var bytes = Encoding.UTF8.GetBytes("signed native installer payload");
        var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        using var signer = RSA.Create(2048);
        var signature = Convert.ToBase64String(signer.SignData(Encoding.UTF8.GetBytes($"0.30.32\npreview\n{digest}\n"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        var architecture = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "x64",
            Architecture.X86 => "x86",
            Architecture.Arm64 => "arm64",
            var value => value.ToString().ToLowerInvariant()
        };
        var manifestUri = new Uri("http://127.0.0.1/native-update.json");
        var downloadUri = new Uri("http://127.0.0.1/native-update.exe");
        var manifest = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["version"] = "0.30.32",
            ["channel"] = "preview",
            ["architecture"] = architecture,
            ["fileName"] = "OpenFinalShell-NativePreview-0.30.32-Setup.exe",
            ["downloadUrl"] = downloadUri.ToString(),
            ["sha256"] = digest,
            ["signature"] = signature,
            ["bytes"] = bytes.LongLength,
            ["publishedAt"] = "2026-11-03T00:00:00Z",
            ["notesUrl"] = "https://github.com/kexue-aihao/openfinalshell/releases/tag/v0.30.32"
        };
        using var store = new NativeStore(Path.Combine(root, "update-feed-store-" + Guid.NewGuid().ToString("N")), new TestProtector());
        using var sessions = new NativeSessionManager(store);
        using var transfers = new NativeTransferQueue(sessions);
        using var forwards = new NativeForwardManager(store, sessions);
        var coordinator = new NativeUpdateCoordinator(sessions, transfers, forwards, signer.ExportSubjectPublicKeyInfoPem(), Path.Combine(root, "update-feed-state-" + Guid.NewGuid().ToString("N")));
        using var client = new HttpClient(new StaticUpdateHandler(manifestUri, downloadUri, Encoding.UTF8.GetBytes(manifest.ToJsonString()), bytes));
        var downloadDirectory = Path.Combine(root, "update-feed-download-" + Guid.NewGuid().ToString("N"));
        using var service = new NativeUpdateService(coordinator, "0.30.31", signer.ExportSubjectPublicKeyInfoPem(), manifestUri, downloadDirectory, client);
        var artifact = await service.CheckAndDownloadAsync();
        check(artifact != null && service.State.Status == NativeUpdateStatus.Ready && service.State.ProgressPercent == 100,
            "Native update service checks, downloads, hashes and verifies a signed manifest");
        check(artifact != null && File.ReadAllBytes(artifact.Path).SequenceEqual(bytes), "Native update service preserves the verified installer bytes");

        var stableManifest = (JsonObject)manifest.DeepClone();
        stableManifest["version"] = "0.30.52";
        stableManifest["channel"] = "stable";
        stableManifest["fileName"] = $"OpenFinalShell-Native-0.30.52-{architecture}-Setup.exe";
        stableManifest["signature"] = Convert.ToBase64String(signer.SignData(Encoding.UTF8.GetBytes($"0.30.52\nstable\n{digest}\n"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        using var stableClient = new HttpClient(new StaticUpdateHandler(manifestUri, downloadUri, Encoding.UTF8.GetBytes(stableManifest.ToJsonString()), bytes));
        using var stableService = new NativeUpdateService(coordinator, "0.30.51", signer.ExportSubjectPublicKeyInfoPem(), manifestUri,
            Path.Combine(root, "update-feed-stable-" + Guid.NewGuid().ToString("N")), stableClient);
        var stableArtifact = await stableService.CheckAndDownloadAsync();
        check(stableArtifact != null && stableService.State.Status == NativeUpdateStatus.Ready && File.ReadAllBytes(stableArtifact.Path).SequenceEqual(bytes),
            "Preview clients accept the signed stable full installer with the new native product name");

        var badManifest = (JsonObject)manifest.DeepClone();
        badManifest["sha256"] = new string('0', 64);
        using var badClient = new HttpClient(new StaticUpdateHandler(manifestUri, downloadUri, Encoding.UTF8.GetBytes(badManifest.ToJsonString()), bytes));
        using var badService = new NativeUpdateService(coordinator, "0.30.31", signer.ExportSubjectPublicKeyInfoPem(), manifestUri,
            Path.Combine(root, "update-feed-bad-" + Guid.NewGuid().ToString("N")), badClient);
        var rejected = false;
        try { await badService.CheckAndDownloadAsync(); } catch (CryptographicException) { rejected = true; }
        check(rejected && badService.State.Status == NativeUpdateStatus.Failed, "Native update service rejects a manifest whose signature no longer matches");

        var corruptPackage = bytes.ToArray();
        corruptPackage[0] ^= 0xff;
        using var corruptPackageClient = new HttpClient(new StaticUpdateHandler(manifestUri, downloadUri, Encoding.UTF8.GetBytes(manifest.ToJsonString()), corruptPackage));
        using var corruptPackageService = new NativeUpdateService(coordinator, "0.30.31", signer.ExportSubjectPublicKeyInfoPem(), manifestUri,
            Path.Combine(root, "update-feed-corrupt-" + Guid.NewGuid().ToString("N")), corruptPackageClient);
        var corruptRejected = false;
        try { await corruptPackageService.CheckAndDownloadAsync(); } catch (CryptographicException) { corruptRejected = true; }
        check(corruptRejected && corruptPackageService.State.Status == NativeUpdateStatus.Failed, "Native update service rejects package bytes that differ from the signed digest");

        using var redirectClient = new HttpClient(new StaticUpdateHandler(manifestUri, downloadUri, Encoding.UTF8.GetBytes(manifest.ToJsonString()), bytes,
            new Uri("http://updates.example.invalid/native-update.json")));
        using var redirectService = new NativeUpdateService(coordinator, "0.30.31", signer.ExportSubjectPublicKeyInfoPem(), manifestUri,
            Path.Combine(root, "update-feed-redirect-" + Guid.NewGuid().ToString("N")), redirectClient);
        var redirectRejected = false;
        try { await redirectService.CheckAndDownloadAsync(); } catch (InvalidDataException) { redirectRejected = true; }
        check(redirectRejected && redirectService.State.Status == NativeUpdateStatus.Failed, "Native update service rejects a redirect that ends outside HTTPS or loopback");

        using var currentClient = new HttpClient(new StaticUpdateHandler(manifestUri, downloadUri, Encoding.UTF8.GetBytes(manifest.ToJsonString()), bytes));
        using var currentService = new NativeUpdateService(coordinator, "0.30.32", signer.ExportSubjectPublicKeyInfoPem(), manifestUri,
            Path.Combine(root, "update-feed-current-" + Guid.NewGuid().ToString("N")), currentClient);
        var noUpdate = await currentService.CheckAndDownloadAsync();
        check(noUpdate == null && currentService.State.Status == NativeUpdateStatus.UpToDate, "Native update service does not offer an older or equal version");
    }

    private sealed class StaticUpdateHandler(Uri manifestUri, Uri downloadUri, byte[] manifest, byte[] package, Uri? finalManifestUri = null) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (request.RequestUri == manifestUri)
            {
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(manifest) };
                if (finalManifestUri != null) response.RequestMessage = new HttpRequestMessage(HttpMethod.Get, finalManifestUri);
                return Task.FromResult(response);
            }
            if (request.RequestUri == downloadUri)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(package) });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }
}
