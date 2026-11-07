using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace OpenFinalShell.Core;

/// <summary>
/// Native remote text editor service. It deliberately keeps conflict baselines
/// in the Core process instead of accepting a baseline from the UI.
/// </summary>
public sealed class NativeRemoteEditorService
{
    public const int MaximumEditableBytes = 8 * 1024 * 1024;
    private sealed record Baseline(string ResolvedPath, byte[] Hash, long Length, DateTime Modified, bool Lossless);
    private readonly ConcurrentDictionary<string, Baseline> baselines = new(StringComparer.Ordinal);

    public async Task<NativeRemoteFileView> ViewAsync(NativeSession session, string path, NativeTextEncoding? requestedEncoding = null, CancellationToken cancellation = default)
    {
        var resolved = await session.RealPathAsync(path, cancellation, requireExisting: true);
        var entry = await session.TryGetAsync(resolved, cancellation) ?? throw new FileNotFoundException("Remote file not found.", path);
        if (entry.Type != NativeRemoteEntryType.File) throw new InvalidOperationException("The remote entry is not a text file.");
        EnsureSizeAllowed(entry.Size);
        var bytes = await session.ReadFileAsync(resolved, cancellation, MaximumEditableBytes);
        if (!string.Equals(resolved, await session.RealPathAsync(path, cancellation, requireExisting: true), StringComparison.Ordinal))
            throw new IOException("native.editor.targetChanged");
        var decoded = NativeTextCodec.DecodeForEditing(bytes, requestedEncoding);
        var rawText = decoded.Text;
        var lossless = decoded.Lossless;
        var (eol, mixedNewLines) = NativeTextCodec.AnalyzeNewLines(rawText);
        var hash = SHA256.HashData(bytes);
        baselines[Key(session.SessionId, path)] = new(resolved, hash, bytes.LongLength, entry.Modified, lossless);
        return new(path, resolved, NativeTextCodec.NormalizeToLf(rawText), decoded.Encoding, eol, decoded.HasBom, lossless, bytes.LongLength, entry.Mode, entry.Modified, mixedNewLines);
    }

    public async Task<NativeRemoteSaveResult> SaveAsync(
        NativeSession session,
        string path,
        string text,
        NativeTextEncoding encoding,
        string eol,
        bool hasBom,
        bool overwriteRemoteChanges,
        bool allowShrink,
        CancellationToken cancellation = default,
        bool allowNonAtomic = false)
    {
        if (!baselines.TryGetValue(Key(session.SessionId, path), out var baseline))
            throw new InvalidOperationException("Remote editor baseline is unavailable; reopen the file.");
        if (!baseline.Lossless) throw new InvalidOperationException("The file was not decoded losslessly; choose another encoding.");

        var resolved = await session.RealPathAsync(path, cancellation, requireExisting: true);
        if (!string.Equals(resolved, baseline.ResolvedPath, StringComparison.Ordinal)) throw new IOException("native.editor.targetChanged");
        var current = await session.TryGetAsync(resolved, cancellation) ?? throw new FileNotFoundException("Remote file not found.", path);
        if (current.Type != NativeRemoteEntryType.File) throw new IOException("native.editor.targetChanged");
        EnsureSizeAllowed(current.Size);
        var currentBytes = await session.ReadFileAsync(resolved, cancellation, MaximumEditableBytes);
        var currentHash = SHA256.HashData(currentBytes);
        var changed = !currentHash.AsSpan().SequenceEqual(baseline.Hash) || current.Modified != baseline.Modified || currentBytes.LongLength != baseline.Length;
        if (changed && !overwriteRemoteChanges)
            return new(NativeRemoteSaveKind.Conflict, 0, current.Mode, "The remote file changed while it was open.");

        var normalized = NativeTextCodec.NormalizeFromLf(text, eol);
        var bytes = NativeTextCodec.Encode(normalized, encoding, hasBom);
        EnsureSizeAllowed(bytes.LongLength);
        if (!allowShrink && baseline.Length > 0 && bytes.LongLength * 5 < baseline.Length)
            return new(NativeRemoteSaveKind.Shrink, bytes.LongLength, current.Mode, "The new file is substantially smaller than the original.");

        if (!string.Equals(resolved, await session.RealPathAsync(path, cancellation, requireExisting: true), StringComparison.Ordinal))
            throw new IOException("native.editor.targetChanged");
        try { await session.WriteFileAtomicAsync(resolved, bytes, true, cancellation, allowNonAtomic, currentHash); }
        catch (NativeNonAtomicSaveRequiredException)
        { return new(NativeRemoteSaveKind.NonAtomic, bytes.LongLength, current.Mode); }
        catch (NativeRemoteFileChangedException)
        { return new(NativeRemoteSaveKind.Conflict, 0, current.Mode, "native.editor.remoteChangedTitle"); }
        var after = await session.TryGetAsync(resolved, cancellation);
        var result = new NativeRemoteSaveResult(NativeRemoteSaveKind.Saved, bytes.LongLength, after?.Mode ?? current.Mode);
        baselines[Key(session.SessionId, path)] = new(resolved, SHA256.HashData(bytes), bytes.LongLength, after?.Modified ?? DateTime.UtcNow, true);
        return result;
    }

    public void ForgetSession(string sessionId)
    {
        foreach (var key in baselines.Keys.Where(x => x.StartsWith(sessionId + "::", StringComparison.Ordinal)).ToArray())
            baselines.TryRemove(key, out _);
    }

    private static string Key(string sessionId, string path) => sessionId + "::" + path;

    private static void EnsureSizeAllowed(long bytes)
    {
        if (bytes < 0 || bytes > MaximumEditableBytes)
            throw new InvalidOperationException($"Remote text files are limited to {MaximumEditableBytes / (1024 * 1024)} MiB.");
    }
}

internal sealed class NativeNonAtomicSaveRequiredException : IOException { }
internal sealed class NativeRemoteFileChangedException : IOException { }
