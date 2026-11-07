namespace OpenFinalShell.Core;

/// <summary>
/// Builds and executes the same guarded, batched rm workflow used by the Electron
/// client. All paths are checked again at execution time; the UI preview is not
/// treated as authorization for a later command.
/// </summary>
public static class NativeFastDelete
{
    public const int BatchSize = 64;
    public const int MaximumPathListCharacters = 8000;
    public static readonly TimeSpan CommandTimeout = TimeSpan.FromMinutes(10);

    public static NativeFastDeletePreview Preview(IReadOnlyList<string> paths, Localization localization)
    {
        var batches = Chunk(paths, localization);
        return new(BuildCommand(batches[0], localization), paths.Count, batches.Count);
    }

    public static async Task<NativeFastDeleteResult> ExecuteAsync(
        IReadOnlyList<string> paths,
        Localization localization,
        Func<string, CancellationToken, Task<NativeCommandResult>> execute,
        CancellationToken cancellationToken = default)
    {
        var batches = Chunk(paths, localization);
        var leftovers = new List<string>();
        var stderr = new System.Text.StringBuilder();
        var unknown = false;
        var failure = 0;

        foreach (var batch in batches)
        {
            NativeCommandResult result;
            try { result = await execute(BuildCommand(batch, localization), cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception error)
            {
                unknown = true;
                if (stderr.Length > 0) stderr.AppendLine();
                stderr.Append(error.Message);
                break;
            }

            leftovers.AddRange(ParseLeftovers(result.StandardOutput));
            if (!string.IsNullOrEmpty(result.StandardError)) stderr.Append(result.StandardError);
            if (result.ExitCode is null) unknown = true;
            else if (result.ExitCode != 0 && failure == 0) failure = result.ExitCode.Value;
        }

        return new(unknown ? null : failure, leftovers, stderr.ToString());
    }

    public static string BuildCommand(IReadOnlyList<string> paths, Localization localization)
    {
        if (paths.Count == 0) throw new InvalidOperationException(localization["err.sftp.noPathsToDelete"]);
        if (paths.Count > BatchSize)
            throw new InvalidOperationException(localization.Format("err.sftp.tooManyPaths", ("max", BatchSize.ToString()), ("actual", paths.Count.ToString())));
        var safe = paths.Select(path => AssertDeletable(path, localization)).ToArray();
        var list = string.Join(' ', safe.Select(Quote));
        if (list.Length > MaximumPathListCharacters)
            throw new InvalidOperationException(localization.Format("err.sftp.commandTooLong", ("chars", list.Length.ToString())));
        return string.Join('\n',
            $"rm -rf -- {list}",
            "__ofs_rm=$?",
            $"for p in {list}; do",
            "  if [ -e \"$p\" ] || [ -L \"$p\" ]; then printf 'OFSLEFT:%s\\n' \"$p\"; fi",
            "done",
            "(exit $__ofs_rm)");
    }

    public static IReadOnlyList<string> ParseLeftovers(string standardOutput) => standardOutput
        .Split('\n', StringSplitOptions.RemoveEmptyEntries)
        .Where(line => line.StartsWith("OFSLEFT:", StringComparison.Ordinal))
        .Select(line => line[8..].TrimEnd('\r'))
        .ToArray();

    private static List<string[]> Chunk(IReadOnlyList<string> paths, Localization localization)
    {
        if (paths.Count == 0) throw new InvalidOperationException(localization["err.sftp.noPathsToDelete"]);
        var safe = paths.Select(path => AssertDeletable(path, localization)).ToArray();
        var batches = new List<string[]>();
        var current = new List<string>();
        var width = 0;
        foreach (var path in safe)
        {
            var quotedWidth = Quote(path).Length + 1;
            if (current.Count > 0 && (current.Count >= BatchSize || width + quotedWidth > MaximumPathListCharacters))
            {
                batches.Add(current.ToArray()); current.Clear(); width = 0;
            }
            current.Add(path); width += quotedWidth;
        }
        if (current.Count > 0) batches.Add(current.ToArray());
        return batches;
    }

    private static string AssertDeletable(string path, Localization localization)
    {
        const int maxPathLength = 4096;
        if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException(localization.Format("err.sftp.pathEmpty", ("what", localization["err.sftp.remotePathLabel"])));
        if (path.IndexOfAny(['\0', '\n', '\r']) >= 0)
            throw new InvalidOperationException(localization.Format("err.sftp.pathControlChar", ("what", localization["err.sftp.remotePathLabel"]), ("path", System.Text.Json.JsonSerializer.Serialize(path))));
        if (path.Length > maxPathLength)
            throw new InvalidOperationException(localization.Format("err.sftp.pathTooLong", ("what", localization["err.sftp.remotePathLabel"]), ("max", maxPathLength.ToString())));
        if (!path.StartsWith("/", StringComparison.Ordinal))
            throw new InvalidOperationException(localization.Format("err.sftp.pathNotAbsolute", ("what", localization["err.sftp.remotePathLabel"]), ("path", path)));
        var segments = path.Split('/');
        if (segments.Any(segment => segment is "." or ".."))
            throw new InvalidOperationException(localization.Format("err.sftp.pathDotSegment", ("what", localization["err.sftp.remotePathLabel"]), ("path", path)));
        var depth = segments.Count(segment => segment.Length > 0);
        if (depth < 2)
            throw new InvalidOperationException(localization.Format("err.sftp.pathTooShallow", ("min", "2"), ("actual", depth.ToString()), ("path", path)));
        return path;
    }

    private static string Quote(string value) => "'" + value.Replace("'", "'\"'\"'", StringComparison.Ordinal) + "'";
}
