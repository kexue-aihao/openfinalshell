using System.Formats.Tar;
using System.Text;

namespace OpenFinalShell.Core;

public sealed record NativePackProbe(
    string TarFlavor,
    bool HasMktemp,
    string TempDirectory,
    int EntryCount,
    long SizeKb,
    long? FreeTempKb,
    long? FreeSourceKb);

public sealed record NativePackDecision(bool UsePack, string? Notice, string? TempBase = null, long SizeKb = 0);

public sealed record NativePackOutput(string? RemotePath, int? TarExitCode);

public sealed record NativeTarExtractResult(long BytesWritten, int SkippedLinks, int ExtractedFiles);

/// <summary>Native equivalent of Electron's advisory tar-directory download path.</summary>
public static class NativePackedTransfer
{
    public const int MinimumEntries = 8;
    public const long FreeSpaceSlackKb = 16 * 1024;
    public const double FreeSpaceMargin = 1.05;
    public const int MaximumArchiveEntries = 200_000;
    public static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(20);

    public static string BuildProbeScript(string remoteDirectory)
    {
        var directory = AssertRemotePath(remoteDirectory);
        var parent = RemoteParent(directory);
        var quoted = Quote(directory);
        return string.Join('\n',
            "tar --version 2>&1 | head -n 1 | awk '{print \"OFSP:TAR \" $0}'",
            "command -v mktemp >/dev/null 2>&1 && echo 'OFSP:MKTEMP yes' || echo 'OFSP:MKTEMP no'",
            "printf 'OFSP:TMPDIR %s\\n' \"${TMPDIR:-/tmp}\"",
            $"find {quoted} 2>/dev/null | wc -l | awk '{{print \"OFSP:COUNT \" $1}}'",
            $"du -sk {quoted} 2>/dev/null | awk '{{print \"OFSP:SIZEKB \" $1}}'",
            "df -Pk \"${TMPDIR:-/tmp}\" 2>/dev/null | awk 'NR==2{print \"OFSP:FREETMP \" $4}'",
            $"df -Pk {Quote(parent)} 2>/dev/null | awk 'NR==2{{print \"OFSP:FREESRC \" $4}}'");
    }

    public static NativePackProbe ParseProbe(string output)
    {
        string Get(string key) => System.Text.RegularExpressions.Regex.Match(output, $"^OFSP:{key} (.*)$", System.Text.RegularExpressions.RegexOptions.Multiline).Groups[1].Value.Trim();
        long? Number(string key) => long.TryParse(Get(key), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : null;
        var line = Get("TAR");
        var flavor = line.Contains("GNU tar", StringComparison.OrdinalIgnoreCase) ? "gnu"
            : line.Contains("bsdtar", StringComparison.OrdinalIgnoreCase) || line.Contains("libarchive", StringComparison.OrdinalIgnoreCase) ? "bsd"
            : line.Contains("busybox", StringComparison.OrdinalIgnoreCase) || line.Contains("unrecognized option", StringComparison.OrdinalIgnoreCase)
                || line.Contains("invalid option", StringComparison.OrdinalIgnoreCase) || line.Contains("usage: tar", StringComparison.OrdinalIgnoreCase) ? "busybox"
            : "unknown";
        return new(flavor, Get("MKTEMP") == "yes", Get("TMPDIR"), checked((int)Math.Clamp(Number("COUNT") ?? 0, 0, int.MaxValue)),
            Number("SIZEKB") ?? 0, Number("FREETMP"), Number("FREESRC"));
    }

    public static NativePackDecision Decide(
        NativePackProbe probe,
        string remoteDirectory,
        string localTarget,
        string conflictPolicy,
        Localization localization)
    {
        var remote = AssertRemotePath(remoteDirectory);
        var targetName = Path.GetFileName(Path.TrimEndingDirectorySeparator(localTarget));
        var remoteName = RemoteName(remote);
        if (remoteName.Length == 0) return Fallback("err.sftp.nameNeedsRewrite");
        if (probe.TarFlavor == "unknown") return Fallback("err.sftp.noRemoteTar");
        if (!probe.HasMktemp) return Fallback("err.sftp.noRemoteMktemp");
        if (probe.EntryCount < MinimumEntries)
            return Fallback("err.sftp.tooFewEntries", ("count", probe.EntryCount.ToString()));
        if (Directory.Exists(localTarget) || File.Exists(localTarget))
        {
            if (conflictPolicy != "overwrite") return Fallback("err.sftp.targetExistsConflict");
            if (!Directory.Exists(localTarget)) return Fallback("err.sftp.targetExistsConflict");
        }
        if (!string.Equals(targetName, remoteName, StringComparison.Ordinal)) return Fallback("err.sftp.nameNeedsRewrite");

        var requiredKb = checked((long)Math.Ceiling(probe.SizeKb * FreeSpaceMargin) + FreeSpaceSlackKb);
        var tempHasSpace = probe.FreeTempKb is { } tempFree && tempFree >= requiredKb;
        var sourceHasSpace = probe.FreeSourceKb is { } sourceFree && sourceFree >= requiredKb;
        if (tempHasSpace)
        {
            if (!TryRemoteDirectory(probe.TempDirectory, out var temp)) return Fallback("err.sftp.badRemoteTmpdir");
            return new(true, null, temp, probe.SizeKb);
        }
        if (sourceHasSpace) return new(true, null, RemoteParent(remote), probe.SizeKb);
        return Fallback("err.sftp.noSpaceForPack");

        NativePackDecision Fallback(string key, params (string Key, string Value)[] values) =>
            new(false, localization.Format(key, values));
    }

    public static string BuildArchiveCommand(string remoteDirectory, string tempBase)
    {
        var directory = AssertRemotePath(remoteDirectory);
        var safeTempBase = NormalizeRemoteDirectory(AssertRemotePath(tempBase));
        var template = safeTempBase == "/" ? "/ofs-pack.XXXXXXXX" : safeTempBase + "/ofs-pack.XXXXXXXX";
        var parent = RemoteParent(directory);
        var name = RemoteName(directory);
        return string.Join('\n',
            $"t=$(mktemp {Quote(template)}) || exit 90",
            $"tar -c -f \"$t\" -C {Quote(parent)} -- {Quote(name)}",
            "rc=$?",
            "if [ $rc -gt 1 ]; then rm -f \"$t\"; exit 91; fi",
            "printf 'OFSP:PATH %s\\n' \"$t\"",
            "printf 'OFSP:RC %s\\n' \"$rc\"");
    }

    public static string ValidateRemotePath(string path) => AssertRemotePath(path);

    public static string ValidateGeneratedArchivePath(string path, string tempBase)
    {
        var archive = AssertRemotePath(path);
        var baseDirectory = AssertRemotePath(tempBase).TrimEnd('/');
        if (baseDirectory.Length == 0) baseDirectory = "/";
        var prefix = baseDirectory == "/" ? "/" : baseDirectory + "/";
        if (!archive.StartsWith(prefix, StringComparison.Ordinal))
            throw new InvalidDataException("Remote archive path is outside the selected temporary directory.");
        var name = archive[prefix.Length..];
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^ofs-pack\\.[A-Za-z0-9_-]{6,}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
            throw new InvalidDataException("Remote archive path was not generated by the expected mktemp template.");
        return archive;
    }

    public static TimeSpan TarTimeout(long bytes) => TimeSpan.FromMilliseconds(Math.Max(120_000, Math.Round(bytes / (5d * 1024 * 1024)) * 1000));

    public static NativePackOutput ParseArchiveOutput(string output)
    {
        var path = System.Text.RegularExpressions.Regex.Match(output, "^OFSP:PATH (.*)$", System.Text.RegularExpressions.RegexOptions.Multiline);
        var rc = System.Text.RegularExpressions.Regex.Match(output, "^OFSP:RC ([0-9]+)$", System.Text.RegularExpressions.RegexOptions.Multiline);
        return new(path.Success ? path.Groups[1].Value.Trim() : null,
            rc.Success && int.TryParse(rc.Groups[1].Value, out var value) ? value : null);
    }

    /// <summary>
    /// Reads the whole archive once to validate every path before creating user files,
    /// then reopens it and extracts only regular files/directories. Link entries are skipped.
    /// </summary>
    public static async Task<NativeTarExtractResult> ExtractAsync(
        string archivePath,
        string localTarget,
        string expectedTop,
        CancellationToken cancellationToken = default)
    {
        var target = Path.GetFullPath(localTarget);
        var parent = Path.GetDirectoryName(target) ?? throw new InvalidDataException("Archive target has no parent directory.");
        if (!string.Equals(Path.GetFileName(target), expectedTop, StringComparison.Ordinal))
            throw new InvalidDataException("The archive root does not match the selected download folder.");

        var entries = await InspectAsync(archivePath, expectedTop, cancellationToken);
        EnsureNoReparseParents(parent, target);
        Directory.CreateDirectory(parent);
        long bytesWritten = 0;
        var files = 0;
        var skippedLinks = 0;
        await using var stream = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var reader = new TarReader(stream);
        foreach (var entry in entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var tarEntry = reader.GetNextEntry(copyData: true) ?? throw new InvalidDataException("Archive changed during extraction.");
            var destination = ResolveEntryPath(parent, entry.Name);
            EnsureNoReparseParents(parent, destination);
            switch (entry.Type)
            {
                case TarEntryType.Directory:
                    Directory.CreateDirectory(destination);
                    break;
                case TarEntryType.RegularFile:
                case TarEntryType.V7RegularFile:
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    await using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
                    {
                        if (tarEntry.DataStream != null) await tarEntry.DataStream.CopyToAsync(output, 128 * 1024, cancellationToken);
                        await output.FlushAsync(cancellationToken);
                        bytesWritten = checked(bytesWritten + output.Length);
                    }
                    files++;
                    break;
                case TarEntryType.SymbolicLink:
                case TarEntryType.HardLink:
                    skippedLinks++;
                    break;
            }
        }
        return new(bytesWritten, skippedLinks, files);
    }

    private sealed record ValidatedEntry(string Name, TarEntryType Type);

    private static async Task<IReadOnlyList<ValidatedEntry>> InspectAsync(string archivePath, string expectedTop, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var reader = new TarReader(stream);
        var result = new List<ValidatedEntry>();
        var top = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var paths = new Dictionary<string, (string Original, TarEntryType Type)>(StringComparer.OrdinalIgnoreCase);
        TarEntry? entry;
        while ((entry = reader.GetNextEntry(copyData: false)) != null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (result.Count >= MaximumArchiveEntries) throw new InvalidDataException("Archive contains too many entries to validate safely.");
            var normalized = NormalizeArchiveEntry(entry.Name);
            var parts = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) throw new InvalidDataException("Archive contains an empty entry path.");
            top.Add(parts[0]);
            if (top.Count > 1) throw new InvalidDataException("Archive contains multiple top-level items.");
            if (parts[0] != expectedTop) throw new InvalidDataException("Archive root does not match the selected remote folder.");
            foreach (var part in parts) EnsureSafeWindowsSegment(part);
            if (parts.Length == 1 && entry.EntryType != TarEntryType.Directory)
                throw new InvalidDataException("Archive top-level item is not a directory.");
            if (paths.TryGetValue(normalized, out var prior))
            {
                if (!string.Equals(prior.Original, normalized, StringComparison.Ordinal) || prior.Type != entry.EntryType)
                    throw new InvalidDataException("Archive contains conflicting entries for the same Windows path.");
            }
            else paths[normalized] = (normalized, entry.EntryType);
            if (entry.EntryType is TarEntryType.Directory or TarEntryType.RegularFile or TarEntryType.V7RegularFile or TarEntryType.SymbolicLink or TarEntryType.HardLink)
                result.Add(new(normalized, entry.EntryType));
            else
                throw new InvalidDataException($"Archive contains an unsupported special entry ({entry.EntryType}).");
        }
        if (result.Count == 0) throw new InvalidDataException("Archive is empty.");
        foreach (var path in paths)
        {
            var components = path.Key.Split('/');
            for (var i = 1; i < components.Length; i++)
            {
                var parent = string.Join('/', components.Take(i));
                if (paths.TryGetValue(parent, out var parentEntry) && parentEntry.Type is TarEntryType.RegularFile or TarEntryType.V7RegularFile)
                    throw new InvalidDataException("Archive places an item beneath a regular file.");
            }
        }
        return result;
    }

    private static string NormalizeArchiveEntry(string raw)
    {
        var name = raw.Replace('\\', '/');
        while (name.StartsWith("./", StringComparison.Ordinal)) name = name[2..];
        name = name.TrimEnd('/');
        if (name.Length == 0 || name.StartsWith("/", StringComparison.Ordinal) ||
            name.Length >= 2 && char.IsAsciiLetter(name[0]) && name[1] == ':')
            throw new InvalidDataException("Archive contains an absolute or empty path.");
        if (name.Split('/').Any(part => part is "" or "." or ".."))
            throw new InvalidDataException("Archive path escapes its destination.");
        if (name.Any(char.IsControl)) throw new InvalidDataException("Archive path contains a control character.");
        return name;
    }

    private static void EnsureSafeWindowsSegment(string segment)
    {
        if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith(' ') || segment.EndsWith('.') ||
            segment.IndexOfAny(['<', '>', ':', '"', '|', '?', '*']) >= 0 || segment.Any(char.IsControl))
            throw new InvalidDataException("Archive contains a filename that is unsafe or ambiguous on Windows.");
        var stem = segment.Split('.', 2)[0].TrimEnd(' ', '.');
        if (stem.Equals("CON", StringComparison.OrdinalIgnoreCase) || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("AUX", StringComparison.OrdinalIgnoreCase) || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase) ||
            stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && stem[3] is >= '1' and <= '9')
            throw new InvalidDataException("Archive contains a reserved Windows device filename.");
    }

    private static string ResolveEntryPath(string parent, string relative)
    {
        var full = Path.GetFullPath(Path.Combine(parent, relative.Replace('/', Path.DirectorySeparatorChar)));
        var root = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Archive entry escapes its destination.");
        return full;
    }

    private static void EnsureNoReparseParents(string parent, string path)
    {
        var root = Path.GetFullPath(parent);
        for (string? current = Path.GetFullPath(path); current != null && current.StartsWith(root, StringComparison.OrdinalIgnoreCase); current = Path.GetDirectoryName(current))
        {
            if (!File.Exists(current) && !Directory.Exists(current)) continue;
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Archive extraction refuses to traverse a symbolic link or reparse point.");
            if (string.Equals(current, root, StringComparison.OrdinalIgnoreCase)) break;
        }
    }

    private static string AssertRemotePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !path.StartsWith("/", StringComparison.Ordinal) || path.Length > 4096 ||
            path.IndexOfAny(['\0', '\n', '\r']) >= 0 || path.Split('/').Any(part => part is "." or ".."))
            throw new InvalidDataException("Remote path is not safe for a shell command.");
        return path;
    }

    private static bool TryRemoteDirectory(string path, out string safe)
    {
        try { safe = NormalizeRemoteDirectory(AssertRemotePath(path)); return true; }
        catch { safe = ""; return false; }
    }
    private static string NormalizeRemoteDirectory(string path)
    {
        var trimmed = path.TrimEnd('/');
        return trimmed.Length == 0 ? "/" : trimmed;
    }
    private static string RemoteName(string path) => path.TrimEnd('/').Split('/').Last();
    private static string RemoteParent(string path)
    {
        var trimmed = path.TrimEnd('/');
        var slash = trimmed.LastIndexOf('/');
        return slash <= 0 ? "/" : trimmed[..slash];
    }
    private static string Quote(string value) => "'" + value.Replace("'", "'\"'\"'", StringComparison.Ordinal) + "'";
}
