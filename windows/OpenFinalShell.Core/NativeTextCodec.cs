using System.Text;

namespace OpenFinalShell.Core;

/// <summary>
/// Shared text conversion for local and remote editor flows. The editor buffer
/// uses LF internally; the original encoding, BOM and EOL are retained in the
/// document/view metadata and are required when saving.
/// </summary>
public static class NativeTextCodec
{
    public static (NativeTextEncoding Encoding, int BomLength, bool HasBom) Detect(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return (NativeTextEncoding.Utf8Bom, 3, true);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) return (NativeTextEncoding.Utf16Le, 2, true);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF) return (NativeTextEncoding.Utf16Be, 2, true);
        if (LooksUtf8(bytes)) return (NativeTextEncoding.Utf8, 0, false);
        return (NativeTextEncoding.Windows1252, 0, false);
    }

    public static string Decode(ReadOnlySpan<byte> bytes, NativeTextEncoding encoding, int bomLength = 0)
    {
        var body = bytes[bomLength..];
        return GetEncoding(encoding).GetString(body);
    }

    public static byte[] Encode(string text, NativeTextEncoding encoding, bool hasBom)
    {
        var bytes = GetEncoding(encoding).GetBytes(text);
        if (!hasBom) return bytes;
        var bom = encoding switch
        {
            NativeTextEncoding.Utf16Le => new byte[] { 0xFF, 0xFE },
            NativeTextEncoding.Utf16Be => new byte[] { 0xFE, 0xFF },
            NativeTextEncoding.Utf8Bom or NativeTextEncoding.Utf8 => new byte[] { 0xEF, 0xBB, 0xBF },
            _ => []
        };
        return bom.Length == 0 ? bytes : bom.Concat(bytes).ToArray();
    }

    public static string NormalizeToLf(string text) => text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    public static string NormalizeFromLf(string text, string eol) => eol == "\r\n"
        ? NormalizeToLf(text).Replace("\n", "\r\n", StringComparison.Ordinal)
        : NormalizeToLf(text);

    public static bool IsLossless(string text, ReadOnlySpan<byte> original, NativeTextEncoding encoding, bool hasBom)
        => Encode(text, encoding, hasBom).AsSpan().SequenceEqual(original);

    public static bool LooksBinary(ReadOnlySpan<byte> bytes, NativeTextEncoding detectedEncoding)
    {
        if (bytes.IsEmpty) return false;
        var controls = 0;
        if (detectedEncoding is NativeTextEncoding.Utf16Le or NativeTextEncoding.Utf16Be)
        {
            var offset = bytes.Length >= 2 && (bytes[0] == 0xFF && bytes[1] == 0xFE || bytes[0] == 0xFE && bytes[1] == 0xFF) ? 2 : 0;
            if ((bytes.Length - offset) % 2 != 0) return true;
            for (var index = offset; index < bytes.Length; index += 2)
            {
                var codeUnit = detectedEncoding == NativeTextEncoding.Utf16Le
                    ? (ushort)(bytes[index] | bytes[index + 1] << 8)
                    : (ushort)(bytes[index] << 8 | bytes[index + 1]);
                if (codeUnit == 0) return true;
                if (codeUnit < 0x20 && codeUnit is not (0x09 or 0x0A or 0x0D)) controls++;
            }
            return controls > Math.Max(2, (bytes.Length - offset) / 200);
        }
        foreach (var value in bytes)
        {
            if (value == 0) return true;
            if (value < 0x20 && value is not (0x09 or 0x0A or 0x0D)) controls++;
        }
        return controls > Math.Max(2, bytes.Length / 100);
    }

    private static Encoding GetEncoding(NativeTextEncoding encoding) => encoding switch
    {
        NativeTextEncoding.Utf16Le => Encoding.Unicode,
        NativeTextEncoding.Utf16Be => Encoding.BigEndianUnicode,
        NativeTextEncoding.Windows1252 => Encoding.GetEncoding(1252),
        NativeTextEncoding.ShiftJis => Encoding.GetEncoding(932),
        NativeTextEncoding.Gb18030 => Encoding.GetEncoding(936),
        _ => new UTF8Encoding(false, true)
    };

    private static bool LooksUtf8(ReadOnlySpan<byte> bytes)
    {
        try { _ = new UTF8Encoding(false, true).GetString(bytes); return true; }
        catch (DecoderFallbackException) { return false; }
    }
}
