using System.Text;

namespace OpenFinalShell.Core;

/// <summary>
/// Shared text conversion for local and remote editor flows. The editor buffer
/// uses LF internally; the original encoding, BOM and EOL are retained in the
/// document/view metadata and are required when saving.
/// </summary>
public static class NativeTextCodec
{
    static NativeTextCodec() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    public static (string Text, NativeTextEncoding Encoding, bool HasBom, bool Lossless) DecodeForEditing(ReadOnlySpan<byte> bytes, NativeTextEncoding? requested = null)
    {
        var detected = Detect(bytes);
        var encoding = requested ?? detected.Encoding;
        if (LooksBinary(bytes, encoding)) throw new InvalidDataException("The file appears to contain binary data; download it instead of opening it as text.");
        // A requested charset is a re-decode, not an encoding conversion. Strip
        // only a real BOM that belongs to that charset; never drop leading bytes.
        var sameUnicode = encoding == detected.Encoding ||
            (encoding is NativeTextEncoding.Utf8 or NativeTextEncoding.Utf8Bom) && (detected.Encoding is NativeTextEncoding.Utf8 or NativeTextEncoding.Utf8Bom);
        var bomLength = sameUnicode ? detected.BomLength : 0;
        var text = Decode(bytes, encoding, bomLength);
        var hasBom = bomLength > 0;
        return (text, encoding, hasBom, IsLossless(text, bytes, encoding, hasBom));
    }
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

    public static (string NewLine, bool Mixed) AnalyzeNewLines(string text)
    {
        var lf = 0; var crlf = 0; var bareCr = 0;
        for (var index = 0; index < text.Length; index++)
        {
            if (text[index] == '\n') { lf++; if (index > 0 && text[index - 1] == '\r') crlf++; }
            else if (text[index] == '\r' && (index + 1 == text.Length || text[index + 1] != '\n')) bareCr++;
        }
        // Match the shared editor's majority choice (ties choose LF). A bare
        // CR will also be normalized on save, so expose that warning as well.
        return (crlf * 2 > lf ? "\r\n" : "\n", crlf > 0 && crlf < lf || bareCr > 0);
    }

    public static string NormalizeFromLf(string text, string eol) => eol == "\r\n"
        ? NormalizeToLf(text).Replace("\n", "\r\n", StringComparison.Ordinal)
        : NormalizeToLf(text);

    public static bool IsLossless(string text, ReadOnlySpan<byte> original, NativeTextEncoding encoding, bool hasBom)
    {
        try { return Encode(text, encoding, hasBom).AsSpan().SequenceEqual(original); }
        catch (EncoderFallbackException) { return false; }
    }

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

    private static Encoding GetEncoding(NativeTextEncoding encoding) => Encoding.GetEncoding(encoding switch
    {
        NativeTextEncoding.Utf16Le => 1200,
        NativeTextEncoding.Utf16Be => 1201,
        NativeTextEncoding.Windows1252 => 1252,
        NativeTextEncoding.ShiftJis => 932,
        NativeTextEncoding.Gb18030 => 54936,
        NativeTextEncoding.Gbk => 936,
        NativeTextEncoding.Big5 => 950,
        NativeTextEncoding.Latin1 => 28591,
        _ => 65001
    }, EncoderFallback.ExceptionFallback, DecoderFallback.ReplacementFallback);

    private static bool LooksUtf8(ReadOnlySpan<byte> bytes)
    {
        try { _ = new UTF8Encoding(false, true).GetString(bytes); return true; }
        catch (DecoderFallbackException) { return false; }
    }
}
