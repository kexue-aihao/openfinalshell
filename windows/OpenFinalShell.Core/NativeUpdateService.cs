using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public enum NativeUpdateStatus { Idle, Checking, UpToDate, Available, Downloading, Applying, Verifying, Ready, Failed }

public sealed record NativeUpdateSnapshot(
    NativeUpdateStatus Status,
    string CurrentVersion,
    string? AvailableVersion = null,
    int ProgressPercent = 0,
    string? Error = null);

public sealed record NativeUpdateManifest(
    string Version,
    string Channel,
    string Architecture,
    string FileName,
    Uri DownloadUri,
    string Sha256,
    string SignatureBase64,
    long Bytes,
    DateTimeOffset? PublishedAt,
    Uri? NotesUri)
{
    public NativeUpdateManifest? Incremental { get; init; }
}

/// <summary>
/// Signed, architecture-specific update feed for the unpackaged WinUI client.
/// The installer itself is verified again by NativeUpdateCoordinator immediately
/// before launch, so a changed file cannot cross the download-to-install gap.
/// </summary>
public sealed partial class NativeUpdateService : IDisposable
{
    private const int MaximumManifestBytes = 64 * 1024;
    private const long MaximumInstallerBytes = 2L * 1024 * 1024 * 1024;
    private readonly NativeUpdateCoordinator coordinator;
    private readonly HttpClient client;
    private readonly bool ownsClient;
    private readonly Uri manifestUri;
    private readonly string trustedPublicKeyPem;
    private readonly string downloadDirectory;
    private readonly string installDirectory;
    private readonly SemaphoreSlim gate = new(1, 1);
    private int disposed;

    public string CurrentVersion { get; }
    public NativeUpdateManifest? Available { get; private set; }
    public NativeUpdateArtifact? DownloadedArtifact { get; private set; }
    public NativeUpdateSnapshot State { get; private set; }
    public event Action<NativeUpdateSnapshot>? StateChanged;

    public static Uri DefaultManifestUri => Uri.TryCreate(Environment.GetEnvironmentVariable("OFS_NATIVE_UPDATE_FEED"), UriKind.Absolute, out var configured)
        ? configured
        : new($"https://github.com/kexue-aihao/openfinalshell/releases/latest/download/native-update-{ArchitectureName()}.json");
    public static string DefaultPublicKey => ReadEmbeddedPublicKey();

    public NativeUpdateService(
        NativeUpdateCoordinator coordinator,
        string currentVersion,
        string trustedPublicKeyPem,
        Uri? manifestUri = null,
        string? downloadDirectory = null,
        HttpClient? client = null,
        string? installDirectory = null)
    {
        this.coordinator = coordinator ?? throw new ArgumentNullException(nameof(coordinator));
        CurrentVersion = NormalizeVersion(currentVersion);
        this.trustedPublicKeyPem = string.IsNullOrWhiteSpace(trustedPublicKeyPem) ? throw new ArgumentException("A pinned update public key is required.", nameof(trustedPublicKeyPem)) : trustedPublicKeyPem;
        this.manifestUri = manifestUri ?? DefaultManifestUri;
        ValidateHttpsUri(this.manifestUri, "manifest");
        this.downloadDirectory = Path.GetFullPath(downloadDirectory ?? Path.Combine(NativeStore.DefaultDirectory, "updates"));
        this.installDirectory = Path.GetFullPath(installDirectory ?? AppContext.BaseDirectory);
        ownsClient = client == null;
        this.client = client ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = true, AutomaticDecompression = DecompressionMethods.All })
        {
            Timeout = TimeSpan.FromMinutes(10)
        };
        if (!this.client.DefaultRequestHeaders.UserAgent.Any())
            this.client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("OpenFinalShell-Native", CurrentVersion));
        State = new(NativeUpdateStatus.Idle, CurrentVersion);
    }

    public async Task<NativeUpdateArtifact?> CheckAndDownloadAsync(CancellationToken cancellation = default)
    {
        ThrowIfDisposed();
        await gate.WaitAsync(cancellation);
        try
        {
            Publish(new(NativeUpdateStatus.Checking, CurrentVersion));
            var manifest = await FetchManifestCoreAsync(cancellation).ConfigureAwait(false);
            if (manifest == null)
            {
                Available = null; DownloadedArtifact = null;
                Publish(new(NativeUpdateStatus.UpToDate, CurrentVersion));
                return null;
            }
            Available = manifest;
            Publish(new(NativeUpdateStatus.Available, CurrentVersion, manifest.Version));
            return await DownloadCoreAsync(manifest, cancellation).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch (Exception error)
        {
            Publish(new(NativeUpdateStatus.Failed, CurrentVersion, Available?.Version, Error: error.Message));
            throw;
        }
        finally { gate.Release(); }
    }

    public async Task<NativeUpdateArtifact> DownloadAsync(CancellationToken cancellation = default)
    {
        ThrowIfDisposed();
        await gate.WaitAsync(cancellation);
        try
        {
            if (DownloadedArtifact is { } current && File.Exists(current.Path)) return current;
            if (Available is not { } manifest) throw new InvalidOperationException("Check for updates before downloading.");
            return await DownloadCoreAsync(manifest, cancellation).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch (Exception error)
        {
            Publish(new(NativeUpdateStatus.Failed, CurrentVersion, Available?.Version, Error: error.Message));
            throw;
        }
        finally { gate.Release(); }
    }

    private async Task<NativeUpdateManifest?> FetchManifestCoreAsync(CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, manifestUri);
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
        EnsureAllowedResponseUri(response, manifestUri, "manifest");
        if (response.StatusCode == HttpStatusCode.NotFound) throw new HttpRequestException("Native update feed is unavailable.");
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > MaximumManifestBytes) throw new InvalidDataException("Native update manifest exceeds the safety limit.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var read = await input.ReadAsync(chunk, cancellation).ConfigureAwait(false);
            if (read == 0) break;
            if (buffer.Length + read > MaximumManifestBytes) throw new InvalidDataException("Native update manifest exceeds the safety limit.");
            buffer.Write(chunk, 0, read);
        }
        var manifest = ParseManifest(buffer.ToArray());
        if (!IsNewer(manifest.Version, CurrentVersion)) return null;
        return manifest;
    }

    private async Task<NativeUpdateArtifact> DownloadCoreAsync(NativeUpdateManifest manifest, CancellationToken cancellation, bool publishReady = true)
    {
        if (manifest.Incremental != null) return await StageIncrementalAsync(manifest, cancellation).ConfigureAwait(false);
        Directory.CreateDirectory(downloadDirectory);
        var safeName = $"{NormalizeVersion(manifest.Version)}-{manifest.Architecture}-{manifest.FileName}";
        var destination = Path.Combine(downloadDirectory, safeName);
        var partial = destination + ".partial";
        if (File.Exists(destination) && new FileInfo(destination).Length == manifest.Bytes)
        {
            var existing = ToArtifact(manifest, destination);
            try
            {
                Publish(new(NativeUpdateStatus.Verifying, CurrentVersion, manifest.Version, 100));
                coordinator.VerifyArtifact(existing);
                DownloadedArtifact = existing;
                if (publishReady) Publish(new(NativeUpdateStatus.Ready, CurrentVersion, manifest.Version, 100));
                return existing;
            }
            catch { try { File.Delete(destination); } catch { } }
        }

        Publish(new(NativeUpdateStatus.Downloading, CurrentVersion, manifest.Version));
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, manifest.DownloadUri);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
            EnsureAllowedResponseUri(response, manifest.DownloadUri, "package");
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is { } length && (length < 0 || length > MaximumInstallerBytes)) throw new InvalidDataException("Native update package exceeds the safety limit.");
            await using var input = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false);
            await using var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[128 * 1024];
            long total = 0; var lastPercent = -1;
            while (true)
            {
                var read = await input.ReadAsync(buffer, cancellation).ConfigureAwait(false);
                if (read == 0) break;
                total += read;
                if (total > MaximumInstallerBytes || total > manifest.Bytes) throw new InvalidDataException("Native update package exceeds the signed size.");
                await output.WriteAsync(buffer.AsMemory(0, read), cancellation).ConfigureAwait(false);
                hash.AppendData(buffer.AsSpan(0, read));
                var percent = manifest.Bytes == 0 ? 0 : (int)Math.Clamp(total * 100 / manifest.Bytes, 0, 100);
                if (percent != lastPercent) { lastPercent = percent; Publish(new(NativeUpdateStatus.Downloading, CurrentVersion, manifest.Version, percent)); }
            }
            await output.FlushAsync(cancellation).ConfigureAwait(false);
            if (total != manifest.Bytes) throw new InvalidDataException($"Native update size mismatch ({total}/{manifest.Bytes} bytes).");
            await output.DisposeAsync().ConfigureAwait(false);
            Publish(new(NativeUpdateStatus.Verifying, CurrentVersion, manifest.Version, 100));
            var actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            var expected = Encoding.ASCII.GetBytes(manifest.Sha256.ToLowerInvariant());
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actual), expected)) throw new CryptographicException("Native update hash verification failed.");
            File.Move(partial, destination, true);
            var artifact = ToArtifact(manifest, destination);
            coordinator.VerifyArtifact(artifact);
            DownloadedArtifact = artifact;
            if (publishReady) Publish(new(NativeUpdateStatus.Ready, CurrentVersion, manifest.Version, 100));
            return artifact;
        }
        catch
        {
            try { if (File.Exists(partial)) File.Delete(partial); } catch { }
            throw;
        }
    }

    public NativeUpdateInstallDecision PrepareInstall() => coordinator.PrepareInstall();
    public async Task InstallAsync(bool userConfirmed)
    {
        if (DownloadedArtifact is not { } artifact) throw new InvalidOperationException("No verified update package is ready.");
        await coordinator.LaunchVerifiedInstallerAsync(artifact, userConfirmed, installDirectory);
    }
    public void MarkInstallCompleted() => coordinator.MarkInstallCompleted();
    public string? RecoverInterruptedInstall() => coordinator.RecoverInterruptedInstall();

    private NativeUpdateManifest ParseManifest(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || RequiredInt(root, "schemaVersion") != 1) throw new InvalidDataException("Unsupported native update manifest.");
        var version = RequiredString(root, "version", 64);
        var channel = RequiredString(root, "channel", 16);
        var architecture = RequiredString(root, "architecture", 16).ToLowerInvariant();
        var fileName = RequiredString(root, "fileName", 160);
        var downloadUrl = RequiredString(root, "downloadUrl", 2048);
        var hash = RequiredString(root, "sha256", 64).ToLowerInvariant();
        var signature = RequiredString(root, "signature", 4096);
        var size = RequiredLong(root, "bytes");
        if (channel is not ("preview" or "stable")) throw new InvalidDataException("Unsupported native update channel.");
        if (architecture != ArchitectureName()) throw new InvalidDataException($"Native update architecture is {architecture}, expected {ArchitectureName()}.");
        if (fileName != Path.GetFileName(fileName) || fileName.IndexOfAny(['/', '\\']) >= 0) throw new InvalidDataException("Native update file name is unsafe.");
        if (hash.Length != 64 || hash.Any(c => !Uri.IsHexDigit(c))) throw new InvalidDataException("Native update hash is invalid.");
        if (size is <= 0 or > MaximumInstallerBytes) throw new InvalidDataException("Native update package size is invalid.");
        var download = new Uri(downloadUrl, UriKind.Absolute); ValidateHttpsUri(download, "package");
        Uri? notes = null;
        if (root.TryGetProperty("notesUrl", out var notesValue) && notesValue.ValueKind == JsonValueKind.String &&
            Uri.TryCreate(notesValue.GetString(), UriKind.Absolute, out var notesUri) && notesUri.Scheme == Uri.UriSchemeHttps) notes = notesUri;
        DateTimeOffset? published = null;
        if (root.TryGetProperty("publishedAt", out var publishedValue) && publishedValue.ValueKind == JsonValueKind.String &&
            DateTimeOffset.TryParse(publishedValue.GetString(), out var publishedAt)) published = publishedAt;
        NativeUpdateCoordinator.VerifySignature(version, channel, hash, signature, trustedPublicKeyPem);
        var result = new NativeUpdateManifest(version, channel, architecture, fileName, download, hash, signature, size, published, notes);
        if (root.TryGetProperty("incremental", out var incremental))
        {
            if (incremental.TryGetProperty("incremental", out _)) throw new InvalidDataException("Nested incremental feed.");
            var files = ParseManifest(Encoding.UTF8.GetBytes(incremental.GetRawText()));
            if (files.Version != version || files.Channel != channel || files.Bytes > 4 * 1024 * 1024) throw new InvalidDataException("Incremental inventory does not match the release.");
            result = result with { Incremental = files };
        }
        return result;
    }

    private NativeUpdateArtifact ToArtifact(NativeUpdateManifest manifest, string path) =>
        new(manifest.Version, path, manifest.Sha256, manifest.SignatureBase64, manifest.Channel);

    private void Publish(NativeUpdateSnapshot state) { State = state; StateChanged?.Invoke(state); }
    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        gate.Dispose();
        if (ownsClient) client.Dispose();
    }

    private static string ArchitectureName() => RuntimeInformation.ProcessArchitecture switch
    {
        System.Runtime.InteropServices.Architecture.X64 => "x64",
        System.Runtime.InteropServices.Architecture.X86 => "x86",
        System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
        var value => value.ToString().ToLowerInvariant()
    };

    private static string NormalizeVersion(string version)
    {
        var value = version.Trim().TrimStart('v', 'V');
        var suffix = value.IndexOfAny(['-', '+']);
        return suffix >= 0 ? value[..suffix] : value;
    }

    private static bool IsNewer(string candidate, string current)
    {
        static Version Parse(string value) => Version.TryParse(NormalizeVersion(value), out var parsed) ? parsed : throw new InvalidDataException("Invalid native update version.");
        var next = Parse(candidate); var installed = Parse(current);
        if (next.Major != installed.Major) return next.Major > installed.Major;
        if (next.Minor != installed.Minor) return next.Minor > installed.Minor;
        return next.Build > installed.Build;
    }

    private static void EnsureAllowedResponseUri(HttpResponseMessage response, Uri requestedUri, string label)
    {
        var finalUri = response.RequestMessage?.RequestUri ?? requestedUri;
        ValidateHttpsUri(finalUri, label);
    }

    private static void ValidateHttpsUri(Uri uri, string label)
    {
        if (!uri.IsAbsoluteUri || (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && (uri.IsLoopback || uri.Host == "localhost"))))
            throw new InvalidDataException($"Native update {label} URL must use HTTPS.");
    }

    private static string ReadEmbeddedPublicKey()
    {
        var assembly = typeof(NativeUpdateService).Assembly;
        var name = assembly.GetManifestResourceNames().SingleOrDefault(value => value.EndsWith(".UpdatePublicKey.pem", StringComparison.Ordinal))
            ?? throw new InvalidOperationException("Native update public key is missing.");
        using var stream = assembly.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static string RequiredString(JsonElement root, string name, int maximum)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) throw new InvalidDataException($"Native update manifest is missing {name}.");
        var text = value.GetString() ?? "";
        if (text.Length is 0 || text.Length > maximum) throw new InvalidDataException($"Native update manifest field {name} is invalid.");
        return text;
    }
    private static int RequiredInt(JsonElement root, string name) => root.TryGetProperty(name, out var value) && value.TryGetInt32(out var result) ? result : throw new InvalidDataException($"Native update manifest is missing {name}.");
    private static long RequiredLong(JsonElement root, string name) => root.TryGetProperty(name, out var value) && value.TryGetInt64(out var result) ? result : throw new InvalidDataException($"Native update manifest is missing {name}.");
}
