using System.Text;

namespace OpenFinalShell.Core;

/// <summary>
/// Converts terminal bytes between a remote shell charset and libvterm's UTF-8
/// input/output. Decoder state is kept across SSH chunks so multibyte characters
/// split at packet boundaries remain intact.
/// </summary>
public sealed class TerminalCharsetCodec
{
    private readonly Encoding remoteEncoding;
    private Decoder remoteDecoder;
    private Decoder terminalInputDecoder = Encoding.UTF8.GetDecoder();

    public string Charset { get; }

    public TerminalCharsetCodec(string? charset)
    {
        Charset = Normalize(charset);
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        remoteEncoding = Charset switch
        {
            "utf8" => new UTF8Encoding(false, false),
            "gb18030" => Encoding.GetEncoding(54936, EncoderFallback.ReplacementFallback, DecoderFallback.ReplacementFallback),
            "gbk" => Encoding.GetEncoding(936, EncoderFallback.ReplacementFallback, DecoderFallback.ReplacementFallback),
            "big5" => Encoding.GetEncoding(950, EncoderFallback.ReplacementFallback, DecoderFallback.ReplacementFallback),
            "latin1" => Encoding.Latin1,
            _ => throw new NotSupportedException($"Unsupported terminal charset: {charset}")
        };
        remoteDecoder = remoteEncoding.GetDecoder();
    }

    public void Reset()
    {
        remoteDecoder = remoteEncoding.GetDecoder();
        terminalInputDecoder = Encoding.UTF8.GetDecoder();
    }

    public static string Normalize(string? charset)
    {
        var value = string.IsNullOrWhiteSpace(charset) ? "utf8" : charset.Trim().ToLowerInvariant().Replace('_', '-');
        return value switch
        {
            "utf8" or "utf-8" => "utf8",
            "gb18030" => "gb18030",
            "gbk" or "cp936" or "windows-936" => "gbk",
            "big5" or "cp950" => "big5",
            "latin1" or "latin-1" or "iso-8859-1" => "latin1",
            _ => throw new NotSupportedException($"Unsupported terminal charset: {charset}")
        };
    }

    /// <summary>Decodes one remote byte chunk into UTF-8 bytes for libvterm.</summary>
    public byte[] DecodeRemote(ReadOnlySpan<byte> bytes, bool flush = false)
    {
        var input = bytes.ToArray();
        var chars = new char[remoteEncoding.GetMaxCharCount(input.Length) + 2];
        remoteDecoder.Convert(input, 0, input.Length, chars, 0, chars.Length, flush,
            out _, out var charsUsed, out _);
        return Encoding.UTF8.GetBytes(new string(chars, 0, charsUsed));
    }

    /// <summary>Encodes UTF-8 terminal input bytes into the selected remote charset.</summary>
    public byte[] EncodeInput(ReadOnlySpan<byte> bytes, bool flush = false)
    {
        var input = bytes.ToArray();
        var chars = new char[Encoding.UTF8.GetMaxCharCount(input.Length) + 2];
        terminalInputDecoder.Convert(input, 0, input.Length, chars, 0, chars.Length, flush,
            out _, out var charsUsed, out _);
        return remoteEncoding.GetBytes(new string(chars, 0, charsUsed));
    }

    public byte[] EncodeText(string text) => remoteEncoding.GetBytes(text);
}
