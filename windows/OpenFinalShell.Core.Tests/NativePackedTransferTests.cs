using System.Formats.Tar;
using System.Text;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativePackedTransferTests
{
    public static void Run(string root, Action<bool, string> check, Action<Action, string> reject)
    {
        var localization = new Localization();
        localization.SetLanguage("en-US");

        var probe = NativePackedTransfer.ParseProbe(string.Join('\n',
            "OFSP:TAR tar (GNU tar) 1.34", "OFSP:MKTEMP yes", "OFSP:TMPDIR /tmp", "OFSP:COUNT 12",
            "OFSP:SIZEKB 100", "OFSP:FREETMP 20000", "OFSP:FREESRC 100"));
        check(probe.TarFlavor == "gnu" && probe.HasMktemp && probe.EntryCount == 12 && probe.FreeTempKb == 20000,
            "Packed transfer parses remote GNU tar and capacity probe");
        check(NativePackedTransfer.ParseProbe("OFSP:TAR tar: unrecognized option '--version'").TarFlavor == "busybox"
            && NativePackedTransfer.ParseProbe("OFSP:TAR tar: not found").TarFlavor == "unknown",
            "Packed transfer distinguishes BusyBox tar from missing tar");

        var decision = NativePackedTransfer.Decide(probe, "/srv/o'k", Path.Combine(Path.GetTempPath(), "o'k"), "overwrite", localization);
        check(decision.UsePack && decision.TempBase == "/tmp", "Packed transfer accepts a safe target with sufficient temporary space");
        check(NativePackedTransfer.Decide(probe with { TempDirectory = "/tmp/" }, "/srv/project", Path.Combine(Path.GetTempPath(), "project"), "overwrite", localization).TempBase == "/tmp",
            "Packed transfer normalizes a trailing slash in the remote temporary directory");
        var sourceSpaceProbe = probe with { FreeTempKb = 1, FreeSourceKb = 20000 };
        check(NativePackedTransfer.Decide(sourceSpaceProbe, "/srv/project", Path.Combine(Path.GetTempPath(), "project"), "overwrite", localization).TempBase == "/srv",
            "Packed transfer falls back to source filesystem when temporary space is low");
        check(!NativePackedTransfer.Decide(probe with { EntryCount = 2 }, "/srv/project", Path.Combine(Path.GetTempPath(), "project"), "overwrite", localization).UsePack,
            "Packed transfer skips small directories");
        var existingTarget = Path.Combine(Path.GetTempPath(), "ofs-packed-conflict-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(existingTarget);
        check(!NativePackedTransfer.Decide(probe, "/srv/project", existingTarget, "rename", localization).UsePack,
            "Packed transfer respects non-overwrite conflict policy for existing targets");
        Directory.Delete(existingTarget);
        reject(() => NativePackedTransfer.BuildProbeScript("relative/path"), "Packed probe rejects relative remote paths");
        check(NativePackedTransfer.BuildProbeScript("/srv/o'k").Contains("'/srv/o'\"'\"'k'", StringComparison.Ordinal),
            "Packed probe safely quotes apostrophes in remote paths");
        check(NativePackedTransfer.BuildArchiveCommand("/srv/project", "/tmp").Contains("mktemp '/tmp/ofs-pack.XXXXXXXX'", StringComparison.Ordinal),
            "Packed archive command uses a private mktemp path");
        check(NativePackedTransfer.ValidateGeneratedArchivePath("/tmp/ofs-pack.A1b2C3d4", "/tmp") == "/tmp/ofs-pack.A1b2C3d4",
            "Packed archive path must match its generated temporary name");
        reject(() => NativePackedTransfer.ValidateGeneratedArchivePath("/home/user/.ssh/id_rsa", "/tmp"),
            "Packed archive path cannot redirect transfer or cleanup outside its temporary directory");
        reject(() => NativePackedTransfer.ValidateGeneratedArchivePath("/tmp/other-file", "/tmp"),
            "Packed archive path must use the mktemp template prefix");

        var testRoot = Path.Combine(root, "packed-transfer-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(testRoot);
        try
        {
            var archive = Path.Combine(testRoot, "valid.tar");
            CreateArchive(archive,
                ("demo", TarEntryType.Directory, null, null),
                ("demo/sub", TarEntryType.Directory, null, null),
                ("demo/sub/data.txt", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("packed bytes ✓"), null),
                ("demo/link", TarEntryType.SymbolicLink, null, "sub/data.txt"));
            var output = Path.Combine(testRoot, "output", "demo");
            var result = NativePackedTransfer.ExtractAsync(archive, output, "demo").GetAwaiter().GetResult();
            check(File.ReadAllText(Path.Combine(output, "sub", "data.txt")) == "packed bytes ✓" && result.ExtractedFiles == 1,
                "Packed extraction preserves file bytes beneath the expected root");
            check(result.SkippedLinks == 1 && !File.Exists(Path.Combine(output, "link")),
                "Packed extraction skips links without creating reparse points");

            var traversal = Path.Combine(testRoot, "traversal.tar");
            CreateArchive(traversal,
                ("demo", TarEntryType.Directory, null, null),
                ("demo/../escape.txt", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("escape"), null));
            var traversalOutput = Path.Combine(testRoot, "traversal-output", "demo");
            reject(() => NativePackedTransfer.ExtractAsync(traversal, traversalOutput, "demo").GetAwaiter().GetResult(),
                "Packed extraction rejects traversal before writing user files");
            check(!Directory.Exists(Path.GetDirectoryName(traversalOutput)) && !File.Exists(Path.Combine(testRoot, "traversal-output", "escape.txt")),
                "Rejected packed archive leaves no partially extracted directory");

            var multipleRoots = Path.Combine(testRoot, "multiple-roots.tar");
            CreateArchive(multipleRoots,
                ("demo", TarEntryType.Directory, null, null),
                ("other/file.txt", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("no"), null));
            reject(() => NativePackedTransfer.ExtractAsync(multipleRoots, Path.Combine(testRoot, "multi", "demo"), "demo").GetAwaiter().GetResult(),
                "Packed extraction rejects multiple top-level roots");

            var unsafeName = Path.Combine(testRoot, "unsafe-name.tar");
            CreateArchive(unsafeName,
                ("demo", TarEntryType.Directory, null, null),
                ("demo/file.txt:stream", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("no"), null));
            reject(() => NativePackedTransfer.ExtractAsync(unsafeName, Path.Combine(testRoot, "unsafe", "demo"), "demo").GetAwaiter().GetResult(),
                "Packed extraction rejects Windows alternate data stream names");

            var deviceName = Path.Combine(testRoot, "device-name.tar");
            CreateArchive(deviceName,
                ("demo", TarEntryType.Directory, null, null),
                ("demo/CON.backup.txt", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("no"), null));
            reject(() => NativePackedTransfer.ExtractAsync(deviceName, Path.Combine(testRoot, "device", "demo"), "demo").GetAwaiter().GetResult(),
                "Packed extraction rejects reserved Windows device names");

            var caseCollision = Path.Combine(testRoot, "case-collision.tar");
            CreateArchive(caseCollision,
                ("demo", TarEntryType.Directory, null, null),
                ("demo/Readme.txt", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("one"), null),
                ("demo/README.txt", TarEntryType.RegularFile, Encoding.UTF8.GetBytes("two"), null));
            reject(() => NativePackedTransfer.ExtractAsync(caseCollision, Path.Combine(testRoot, "case-collision", "demo"), "demo").GetAwaiter().GetResult(),
                "Packed extraction rejects case-insensitive Windows filename collisions");

            var empty = Path.Combine(testRoot, "empty.tar");
            CreateArchive(empty);
            reject(() => NativePackedTransfer.ExtractAsync(empty, Path.Combine(testRoot, "empty", "demo"), "demo").GetAwaiter().GetResult(),
                "Packed extraction rejects an empty archive");
        }
        finally { try { Directory.Delete(testRoot, true); } catch { } }
    }

    private static void CreateArchive(string path, params (string Name, TarEntryType Type, byte[]? Data, string? LinkName)[] entries)
    {
        using var stream = File.Create(path);
        using var writer = new TarWriter(stream, TarEntryFormat.Pax, leaveOpen: false);
        foreach (var item in entries)
        {
            var entry = new PaxTarEntry(item.Type, item.Name);
            if (item.LinkName is { } linkName) entry.LinkName = linkName;
            if (item.Data != null) entry.DataStream = new MemoryStream(item.Data, writable: false);
            writer.WriteEntry(entry);
            entry.DataStream?.Dispose();
        }
    }
}
