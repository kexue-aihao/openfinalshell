using OpenFinalShell.Core;
using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

if (args.Length != 11 || args[0] is not ("--watch" or "--apply")) return 2;
var parentId = int.Parse(args[1]);
var parentStart = long.Parse(args[2]);
var target = Path.GetFullPath(args[3]).TrimEnd(Path.DirectorySeparatorChar);
var package = Path.GetFullPath(args[4]);
var pipeName = args[5];
var files = args[6] == "files";
var signature = new NativeFileSignature(args[7], args[8], args[9], args[10]);
var errorFile = Path.Combine(AppContext.BaseDirectory, "update-error.txt");
var app = NativeFileUpdate.SafePath(target, "OpenFinalShell.App.exe");
var ready = false;
try
{
    if (args[0] == "--watch")
    {
        // This process is started before elevation and therefore restarts the
        // application using the user's original token, never the UAC token.
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true, Verb = "runas", WorkingDirectory = AppContext.BaseDirectory };
        foreach (var argument in new[] { "--apply" }.Concat(args.Skip(1))) start.ArgumentList.Add(argument);
        using var worker = Process.Start(start) ?? throw new IOException("Could not start update installer.");
        await worker.WaitForExitAsync();
        if (worker.ExitCode != 0)
        {
            var error = File.Exists(errorFile) ? File.ReadAllText(errorFile) : $"Update failed ({worker.ExitCode}).";
            await SignalAsync(error);
            NativeMethods.MessageBoxW(0, error, "OpenFinalShell 更新未完成 / Update failed", 0x10);
        }
        if (!ParentIsAlive() && File.Exists(app)) Process.Start(new ProcessStartInfo(app) { UseShellExecute = true, WorkingDirectory = target });
        return worker.ExitCode;
    }

    using var parent = Process.GetProcessById(parentId);
    if (parent.StartTime.ToUniversalTime().Ticks != parentStart ||
        !string.Equals(parent.MainModule?.FileName, app, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("The application to update no longer matches the running process.");
    var assembly = Assembly.GetExecutingAssembly();
    using var publicKeyStream = assembly.GetManifestResourceStream(assembly.GetManifestResourceNames().Single(name => name.EndsWith("UpdatePublicKey.pem")))!;
    using var publicKeyReader = new StreamReader(publicKeyStream);
    var publicKey = publicKeyReader.ReadToEnd();
    NativeFileInventory? inventory = null;
    if (files)
    {
        inventory = NativeFileUpdate.ReadVerified(package, publicKey);
        if (inventory.Version != signature.Version) throw new InvalidDataException("Update target version mismatch.");
        NativeFileUpdate.VerifyStaged(inventory, package);
    }
    else
    {
        NativeFileUpdate.VerifySignature(signature, publicKey);
        if (!NativeFileUpdate.Hash(package).Equals(signature.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Installer hash mismatch.");
    }
    // Check write access before asking the app to shut down.
    var probe = NativeFileUpdate.SafePath(target, ".update-access-" + Guid.NewGuid().ToString("N"));
    using (File.Create(probe)) { }
    File.Delete(probe);
    if (!await SignalAsync("ready")) throw new IOException("The application did not acknowledge the update; no files were changed.");
    ready = true;
    using (var wait = new CancellationTokenSource(TimeSpan.FromSeconds(60))) await parent.WaitForExitAsync(wait.Token);
    if (inventory != null)
    {
        NativeFileUpdate.Apply(inventory, package, target, publicKey);
        using var registry = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry32);
        using var product = registry.OpenSubKey("Software\\OpenFinalShell.NativePreview", true);
        // Portable/test directories must not rewrite another registered install.
        if (product?.GetValue("InstallDir") is string registered && string.Equals(Path.GetFullPath(registered).TrimEnd(Path.DirectorySeparatorChar), target, StringComparison.OrdinalIgnoreCase))
        {
            product.SetValue("Version", inventory.Version);
            using var uninstall = registry.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenFinalShell.NativePreview", true);
            uninstall?.SetValue("DisplayVersion", inventory.Version);
        }
    }
    else
    {
        var start = new ProcessStartInfo(package) { UseShellExecute = false, Arguments = "/S /D=" + target, WorkingDirectory = target };
        using var installer = Process.Start(start) ?? throw new IOException("Could not launch installer.");
        await installer.WaitForExitAsync();
        if (installer.ExitCode != 0) throw new IOException($"Installer failed ({installer.ExitCode}).");
    }
    return 0;
}
catch (Exception error)
{
    var message = error is System.ComponentModel.Win32Exception { NativeErrorCode: 1223 }
        ? "更新已取消，程序保持运行。 / Update canceled."
        : "更新未完成，原安装将保留或恢复。 / Update did not complete.\n" + error.Message;
    try { File.WriteAllText(errorFile, message); } catch { }
    if (!ready) await SignalAsync(message);
    return 1;
}

bool ParentIsAlive()
{
    try { using var process = Process.GetProcessById(parentId); return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == parentStart; }
    catch (ArgumentException) { return false; }
}

async Task<bool> SignalAsync(string message)
{
    try
    {
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await pipe.ConnectAsync(timeout.Token);
        using var writer = new StreamWriter(pipe) { AutoFlush = true };
        await writer.WriteLineAsync(message.Replace('\n', ' ').Replace('\r', ' '));
        return true;
    }
    catch { return false; }
}

internal static class NativeMethods
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int MessageBoxW(nint window, string text, string caption, uint type);
}
