using System.Text.Json;

namespace OpenFinalShell.Core;

public sealed partial class NativeUpdateService
{
    private async Task<NativeUpdateArtifact> StageIncrementalAsync(NativeUpdateManifest manifest, CancellationToken cancellation)
    {
        var descriptor = manifest.Incremental!;
        var downloaded = await DownloadCoreAsync(descriptor, cancellation).ConfigureAwait(false);
        DownloadedArtifact = null;
        Publish(new(NativeUpdateStatus.Downloading, CurrentVersion, manifest.Version));
        var staging = Path.Combine(downloadDirectory, $"files-{manifest.Version}-{manifest.Architecture}-{descriptor.Sha256[..12]}");
        Directory.CreateDirectory(staging);
        File.Copy(downloaded.Path, Path.Combine(staging, NativeFileUpdate.InventoryName), true);
        File.WriteAllText(Path.Combine(staging, NativeFileUpdate.SignatureName), JsonSerializer.Serialize(
            new NativeFileSignature(descriptor.Version, descriptor.Channel, descriptor.Sha256, descriptor.SignatureBase64)));
        var inventory = NativeFileUpdate.ReadVerified(staging, trustedPublicKeyPem);
        await NativeFileUpdate.StageAsync(inventory, installDirectory, staging, client,
            percent => Publish(new(NativeUpdateStatus.Downloading, CurrentVersion, manifest.Version, percent)), cancellation).ConfigureAwait(false);
        var artifact = downloaded with { Path = Path.Combine(staging, NativeFileUpdate.InventoryName), StagingDirectory = staging };
        coordinator.VerifyArtifact(artifact);
        DownloadedArtifact = artifact;
        Publish(new(NativeUpdateStatus.Ready, CurrentVersion, manifest.Version, 100));
        return artifact;
    }
}
