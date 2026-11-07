using System.Text;

namespace OpenFinalShell.Core;

/// <summary>Observes explicit OSC 7 directory reports. Never infers or executes shell commands.</summary>
public sealed class NativeTerminalDirectoryTracker
{
    private const int MaximumReportBytes = 16 * 1024;
    private readonly byte[] report = new byte[MaximumReportBytes];
    private int state, length;
    private bool overflow;
    public string? CurrentDirectory { get; private set; }

    // Called on the terminal output thread. Returns only the newest report in
    // a chunk so a burst cannot create one SFTP request per escape sequence.
    public string? Feed(ReadOnlySpan<byte> bytes)
    {
        string? newest = null;
        foreach (var value in bytes)
        {
            if (value is 0x18 or 0x1a) { state = length = 0; overflow = false; continue; }
            switch (state)
            {
                case 0: if (value == 0x1b) state = 1; break;
                case 1:
                    if (value == (byte)']') { state = 2; length = 0; overflow = false; }
                    else if (value is (byte)'P' or (byte)'X' or (byte)'^' or (byte)'_') state = 4;
                    else state = value == 0x1b ? 1 : 0;
                    break;
                case 2:
                    if (value == 7) { Complete(ref newest); state = 0; }
                    else if (value == 0x1b) state = 3;
                    else if (length < report.Length) report[length++] = value;
                    else overflow = true;
                    break;
                case 3:
                    if (value == (byte)'\\') { Complete(ref newest); state = 0; }
                    else { state = value == 0x1b ? 5 : 4; length = 0; }
                    break;
                case 4: if (value == 0x1b) state = 5; break;
                case 5: state = value == (byte)'\\' ? 0 : value == 0x1b ? 5 : 4; break;
            }
        }
        return newest;
    }

    public void Reset() { state = length = 0; overflow = false; CurrentDirectory = null; }

    private void Complete(ref string? newest)
    {
        if (overflow || length < 3 || report[0] != (byte)'7' || report[1] != (byte)';') return;
        string value;
        try { value = new UTF8Encoding(false, true).GetString(report.AsSpan(2, length - 2)); }
        catch (DecoderFallbackException) { return; }
        if (!value.StartsWith("file://", StringComparison.OrdinalIgnoreCase) || value.Any(char.IsControl) || Uri.UnescapeDataString(value).Contains('\\')
            || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "file"
            || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || !uri.IsDefaultPort) return;
        // Reject malformed escapes before unescaping once, including NUL and
        // control characters encoded inside a URI. This is only an SFTP path,
        // never a URL navigation or a shell argument.
        for (var i = 0; i < value.Length; i++)
            if (value[i] == '%' && (i + 2 >= value.Length || !Uri.IsHexDigit(value[++i]) || !Uri.IsHexDigit(value[++i]))) return;
        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        if (path.Length is < 1 or > 4096 || path[0] != '/' || path.Contains('\\') || path.Any(char.IsControl)) return;
        if (path == CurrentDirectory) return;
        CurrentDirectory = newest = path;
    }
}
