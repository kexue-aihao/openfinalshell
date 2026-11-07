using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

internal static class NativeUpdateProcessFixture
{
    public static void Prepare(string root, string helper)
    {
        var installed = Path.Combine(root, "installed"); var staging = Path.Combine(root, "staging");
        Directory.CreateDirectory(installed); Directory.CreateDirectory(staging);
        foreach (var source in Directory.EnumerateFiles(AppContext.BaseDirectory, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(installed, Path.GetRelativePath(AppContext.BaseDirectory, source));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!); File.Copy(source, destination, true);
        }
        File.Copy(Path.Combine(installed, "OpenFinalShell.Core.Tests.exe"), Path.Combine(installed, "OpenFinalShell.App.exe"), true);
        Directory.CreateDirectory(Path.Combine(installed, "UpdateHost"));
        File.Copy(helper, Path.Combine(installed, "UpdateHost", "OpenFinalShell.UpdateHost.exe"), true);
        var names = new[] { "OpenFinalShell.App.exe", "UpdateHost/OpenFinalShell.UpdateHost.exe" };
        foreach (var name in names)
        {
            var path = Path.Combine(staging, name); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.Copy(Path.Combine(installed, name), path, true);
        }
        File.WriteAllText(Path.Combine(staging, "update-probe.txt"), "incremental-update-completed");
        var entries = names.Append("update-probe.txt").Select(name => new NativeFileEntry(name, new FileInfo(Path.Combine(staging, name)).Length, NativeFileUpdate.Hash(Path.Combine(staging, name)), 0, 1)).ToArray();
        var inventory = new NativeFileInventory(1, "1.2.3", "preview", RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), "http://127.0.0.1/unused", entries);
        var manifest = Path.Combine(staging, NativeFileUpdate.InventoryName);
        File.WriteAllText(manifest, JsonSerializer.Serialize(inventory));
        using var rsa = RSA.Create(); rsa.ImportFromPem(File.ReadAllText(Path.Combine(root, "test-private.pem")));
        var hash = NativeFileUpdate.Hash(manifest);
        var signature = Convert.ToBase64String(rsa.SignData(Encoding.UTF8.GetBytes($"1.2.3\npreview\n{hash}\n"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        File.WriteAllText(Path.Combine(staging, NativeFileUpdate.SignatureName), JsonSerializer.Serialize(new NativeFileSignature("1.2.3", "preview", hash, signature)));
        Console.WriteLine("Prepared isolated updater process fixture.");
    }

    public static async Task RunParentAsync(string root)
    {
        var complete = Path.Combine(root, "parent-exited");
        if (File.Exists(complete))
        {
            File.WriteAllText(Path.Combine(root, "restarted"), File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "update-probe.txt")));
            return;
        }
        try
        {
            using var store = new NativeStore(Path.Combine(root, "data"), new TestProtector());
            using var sessions = new NativeSessionManager(store);
            using var transfers = new NativeTransferQueue(sessions);
            using var forwards = new NativeForwardManager(store, sessions);
            var key = File.ReadAllText(Path.Combine(root, "test-public.pem"));
            var coordinator = new NativeUpdateCoordinator(sessions, transfers, forwards, key, root);
            var staging = Path.Combine(root, "staging");
            var signature = JsonSerializer.Deserialize<NativeFileSignature>(File.ReadAllText(Path.Combine(staging, NativeFileUpdate.SignatureName)))!;
            var artifact = new NativeUpdateArtifact(signature.Version, Path.Combine(staging, NativeFileUpdate.InventoryName), signature.Sha256, signature.SignatureBase64, signature.Channel, staging);
            await coordinator.LaunchVerifiedInstallerAsync(artifact, true, AppContext.BaseDirectory);
            File.WriteAllText(complete, Process.GetCurrentProcess().Id.ToString());
        }
        catch (Exception error) { File.WriteAllText(Path.Combine(root, "parent-error.txt"), error.ToString()); }
    }
}
