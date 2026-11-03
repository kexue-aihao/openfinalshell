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
        var entry = await session.TryGetAsync(path, cancellation) ?? throw new FileNotFoundException("Remote file not found.", path);
        if (entry.IsDirectory || entry.Type is NativeRemoteEntryType.Other) throw new InvalidOperationException("The remote entry is not a text file.");
        EnsureSizeAllowed(entry.Size);
        var bytes = await session.ReadFileAsync(path, cancellation, MaximumEditableBytes);
        var detected = NativeTextCodec.Detect(bytes);
        if (NativeTextCodec.LooksBinary(bytes, detected.Encoding)) throw new InvalidOperationException("The remote file appears to contain binary data; download it instead of opening it as text.");
        var encoding = requestedEncoding ?? detected.Encoding;
        var rawText = NativeTextCodec.Decode(bytes, encoding, encoding == NativeTextEncoding.Utf8Bom ? 3 : detected.BomLength);
        var lossless = NativeTextCodec.IsLossless(rawText, bytes, encoding, detected.HasBom);
        var eol = rawText.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var hash = SHA256.HashData(bytes);
        baselines[Key(session.SessionId, path)] = new(path, hash, bytes.LongLength, entry.Modified, lossless);
        return new(path, path, NativeTextCodec.NormalizeToLf(rawText), encoding, eol, detected.HasBom, lossless, bytes.LongLength, entry.Mode, entry.Modified);
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
        CancellationToken cancellation = default)
    {
        if (!baselines.TryGetValue(Key(session.SessionId, path), out var baseline))
            throw new InvalidOperationException("Remote editor baseline is unavailable; reopen the file.");
        if (!baseline.Lossless) throw new InvalidOperationException("The file was not decoded losslessly; choose another encoding.");

        var current = await session.TryGetAsync(path, cancellation) ?? throw new FileNotFoundException("Remote file not found.", path);
        EnsureSizeAllowed(current.Size);
        var currentBytes = await session.ReadFileAsync(path, cancellation, MaximumEditableBytes);
        var currentHash = SHA256.HashData(currentBytes);
        var changed = !currentHash.AsSpan().SequenceEqual(baseline.Hash) || current.Modified != baseline.Modified || currentBytes.LongLength != baseline.Length;
        if (changed && !overwriteRemoteChanges)
            return new(NativeRemoteSaveKind.Conflict, 0, current.Mode, "The remote file changed while it was open.");

        var normalized = NativeTextCodec.NormalizeFromLf(text, eol);
        var bytes = NativeTextCodec.Encode(normalized, encoding, hasBom);
        EnsureSizeAllowed(bytes.LongLength);
        if (!allowShrink && baseline.Length > 0 && bytes.LongLength * 5 < baseline.Length)
            return new(NativeRemoteSaveKind.Shrink, bytes.LongLength, current.Mode, "The new file is substantially smaller than the original.");

        await session.WriteFileAtomicAsync(path, bytes, true, cancellation);
        var after = await session.TryGetAsync(path, cancellation);
        var result = new NativeRemoteSaveResult(NativeRemoteSaveKind.Saved, bytes.LongLength, after?.Mode ?? current.Mode);
        baselines[Key(session.SessionId, path)] = new(path, SHA256.HashData(bytes), bytes.LongLength, after?.Modified ?? DateTime.UtcNow, true);
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
