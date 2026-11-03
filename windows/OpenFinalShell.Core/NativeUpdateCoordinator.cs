using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenFinalShell.Core;

public sealed record NativeUpdateActivity(int Sessions, int Transfers, int Forwards, int Editors, int RdpSessions)
{
    public bool HasActivity => Sessions > 0 || Transfers > 0 || Forwards > 0 || Editors > 0 || RdpSessions > 0;
}
public sealed record NativeUpdateInstallDecision(bool Allowed, bool NeedsConfirmation, NativeUpdateActivity Activity, string? Error);
public sealed record NativeUpdateArtifact(string Version, string Path, string Sha256, string SignatureBase64, string Channel);

/// <summary>
/// Native update gate. Verification is performed before an installer can be
/// launched; active sessions and transfers are reported to the UI for explicit
/// confirmation, and a marker permits recovery after an interrupted install.
/// </summary>
public sealed class NativeUpdateCoordinator
{
    private readonly NativeSessionManager sessions;
    private readonly NativeTransferQueue transfers;
    private readonly NativeForwardManager forwards;
    private readonly string markerPath;
    private readonly string trustedPublicKeyPem;
    public NativeUpdateCoordinator(NativeSessionManager sessions, NativeTransferQueue transfers, NativeForwardManager forwards, string trustedPublicKeyPem, string? stateDirectory = null)
    {
        this.sessions = sessions; this.transfers = transfers; this.forwards = forwards;
        this.trustedPublicKeyPem = string.IsNullOrWhiteSpace(trustedPublicKeyPem) ? throw new ArgumentException("A pinned update public key is required.", nameof(trustedPublicKeyPem)) : trustedPublicKeyPem;
        markerPath = Path.Combine(stateDirectory ?? NativeStore.DefaultDirectory, "update-state.json");
    }
    public NativeUpdateActivity Activity() => new(
        sessions.List().Count(x => x.State is NativeSessionState.Connecting or NativeSessionState.Ready or NativeSessionState.Reconnecting),
        transfers.List().Count(x => x.State is NativeTransferState.Queued or NativeTransferState.Running or NativeTransferState.Paused),
        forwards.ListRuntimes().Count(x => x.State == NativeForwardState.Active), 0, 0);
    public NativeUpdateInstallDecision PrepareInstall(bool force = false)
    {
        var activity = Activity(); return activity.HasActivity && !force
            ? new(false, true, activity, null)
            : new(true, false, activity, null);
    }
    public static string ComputeSha256(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 64, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
    public void VerifyArtifact(NativeUpdateArtifact artifact)
    {
        if (artifact.Channel is not ("preview" or "stable") || string.IsNullOrWhiteSpace(artifact.Version) || !File.Exists(artifact.Path)) throw new InvalidDataException("Invalid native update artifact.");
        var digest = ComputeSha256(artifact.Path);
        if (!string.Equals(digest, artifact.Sha256.Trim().ToLowerInvariant(), StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("Native update hash verification failed.");
        VerifySignature(artifact.Version, artifact.Channel, digest, artifact.SignatureBase64, trustedPublicKeyPem);
    }

    public static void VerifySignature(string version, string channel, string sha256, string signatureBase64, string trustedPublicKeyPem)
    {
        if (channel is not ("preview" or "stable") || string.IsNullOrWhiteSpace(version) || sha256.Length != 64 || sha256.Any(value => !Uri.IsHexDigit(value)))
            throw new InvalidDataException("Invalid native update signature metadata.");
        byte[] signature;
        try { signature = Convert.FromBase64String(signatureBase64); }
        catch (FormatException error) { throw new CryptographicException("Native update signature is malformed.", error); }
        if (signature.Length is < 64 or > 16 * 1024) throw new CryptographicException("Native update signature length is invalid.");
        using var rsa = RSA.Create(); rsa.ImportFromPem(trustedPublicKeyPem);
        var manifest = Encoding.UTF8.GetBytes($"{version}\n{channel}\n{sha256.ToLowerInvariant()}\n");
        if (!rsa.VerifyData(manifest, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new CryptographicException("Native update signature verification failed.");
    }
    public void MarkInstallStarted(NativeUpdateArtifact artifact)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(markerPath)!); File.WriteAllText(markerPath, JsonSerializer.Serialize(new { artifact.Version, artifact.Channel, artifact.Path, startedAt = DateTimeOffset.UtcNow }));
    }
    public void MarkInstallCompleted() { try { if (File.Exists(markerPath)) File.Delete(markerPath); } catch { } }
    public string? RecoverInterruptedInstall()
    {
        try { return File.Exists(markerPath) ? JsonDocument.Parse(File.ReadAllText(markerPath)).RootElement.GetProperty("Version").GetString() : null; } catch { return null; }
    }
    public void LaunchVerifiedInstaller(NativeUpdateArtifact artifact, bool userConfirmed)
    {
        if (!userConfirmed) throw new InvalidOperationException("User confirmation is required before launching an update.");
        var decision = PrepareInstall();
        if (decision.NeedsConfirmation) throw new InvalidOperationException("Active sessions or transfers must be closed before launching the installer.");
        VerifyArtifact(artifact); MarkInstallStarted(artifact);
        var startInfo = new ProcessStartInfo(artifact.Path)
        {
            Arguments = $"/S /WAITPID={Environment.ProcessId}",
            WorkingDirectory = Path.GetDirectoryName(artifact.Path),
            UseShellExecute = true
        };
        Process.Start(startInfo);
    }
}
