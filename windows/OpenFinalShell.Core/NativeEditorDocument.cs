using System.Text;

namespace OpenFinalShell.Core;

public enum NativeTextEncoding { Utf8, Utf8Bom, Utf16Le, Utf16Be, Windows1252, ShiftJis, Gb18030, Gbk, Big5, Latin1 }

public sealed record NativeEditorDocument(
    string Path,
    string Text,
    NativeTextEncoding Encoding,
    string NewLine,
    bool HasBom,
    long OriginalLength,
    string? RemotePath = null,
    string? RemoteSessionId = null)
{
    static NativeEditorDocument() => System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);

    public static async Task<NativeEditorDocument> LoadAsync(string path, CancellationToken cancellation = default)
    {
        var bytes = await File.ReadAllBytesAsync(path, cancellation);
        var (encoding, bomLength, hasBom) = DetectEncoding(bytes);
        var text = Decode(bytes.AsSpan(bomLength), encoding);
        var newLine = text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        return new(path, text, encoding, newLine, hasBom, bytes.LongLength);
    }

    public async Task SaveAsync(string path, string text, CancellationToken cancellation = default)
    {
        var normalized = NormalizeNewLines(text, NewLine);
        var bytes = Encode(normalized, Encoding, HasBom);
        var temporary = path + ".ofs-edit-" + Guid.NewGuid().ToString("N");
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, cancellation);
            File.Move(temporary, path, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
    }

    public static string NormalizeNewLines(string text, string newLine)
    {
        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
        return newLine == "\r\n" ? normalized.Replace("\n", "\r\n") : normalized;
    }

    private static (NativeTextEncoding Encoding, int BomLength, bool HasBom) DetectEncoding(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return (NativeTextEncoding.Utf8Bom, 3, true);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) return (NativeTextEncoding.Utf16Le, 2, true);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF) return (NativeTextEncoding.Utf16Be, 2, true);
        if (LooksUtf8(bytes)) return (NativeTextEncoding.Utf8, 0, false);
        return (NativeTextEncoding.Windows1252, 0, false);
    }

    private static string Decode(ReadOnlySpan<byte> bytes, NativeTextEncoding encoding) => encoding switch
    {
        NativeTextEncoding.Utf16Le => System.Text.Encoding.Unicode.GetString(bytes),
        NativeTextEncoding.Utf16Be => System.Text.Encoding.BigEndianUnicode.GetString(bytes),
        NativeTextEncoding.Windows1252 => System.Text.Encoding.GetEncoding(1252).GetString(bytes),
        NativeTextEncoding.ShiftJis => System.Text.Encoding.GetEncoding(932).GetString(bytes),
        NativeTextEncoding.Gb18030 => System.Text.Encoding.GetEncoding(54936).GetString(bytes),
        NativeTextEncoding.Gbk => System.Text.Encoding.GetEncoding(936).GetString(bytes),
        NativeTextEncoding.Big5 => System.Text.Encoding.GetEncoding(950).GetString(bytes),
        NativeTextEncoding.Latin1 => System.Text.Encoding.Latin1.GetString(bytes),
        _ => System.Text.Encoding.UTF8.GetString(bytes)
    };

    private static byte[] Encode(string text, NativeTextEncoding encoding, bool bom) => NativeTextCodec.Encode(text, encoding, encoding == NativeTextEncoding.Utf8Bom || bom);
    private static bool LooksUtf8(ReadOnlySpan<byte> bytes) { try { _ = new UTF8Encoding(false, true).GetString(bytes); return true; } catch (DecoderFallbackException) { return false; } }
}

public static class ScintillaDependencyProbe
{
    public static bool IsAvailable(string baseDirectory) => File.Exists(Path.Combine(baseDirectory, "Scintilla.dll")) && File.Exists(Path.Combine(baseDirectory, "Lexilla.dll"));
    public static string Explain(string baseDirectory) => IsAvailable(baseDirectory) ? "Scintilla and Lexilla are available." : "Scintilla/Lexilla are not bundled for this architecture; native editor remains pending.";
}
