using System.Text.RegularExpressions;

namespace OpenFinalShell.Core;

public enum NativeAiAnswerPartKind { Text, Code }

public sealed record NativeAiAnswerPart(
    NativeAiAnswerPartKind Kind,
    string Text,
    string Language = "",
    bool Complete = true);

public sealed record NativeAiTerminalPaste(string? Data, string? Issue)
{
    public bool Succeeded => Issue == null;
}

/// <summary>Safe presentation and terminal-fill rules shared with the Electron AI workflow.</summary>
public static partial class NativeAiAnswer
{
    [GeneratedRegex("^\\s{0,3}(`{3,}|~{3,})([^\\n]*)$")]
    private static partial Regex OpeningFence();

    [GeneratedRegex("^\\s{0,3}(`{3,}|~{3,})[ \\t]*$")]
    private static partial Regex ClosingFence();

    private static readonly HashSet<string> ShellLanguages = new(StringComparer.Ordinal)
    {
        "", "bash", "sh", "shell", "zsh", "fish", "powershell", "pwsh", "cmd", "bat",
        "console", "terminal", "shell-session", "shellscript"
    };

    public static IReadOnlyList<NativeAiAnswerPart> Parse(string? answer)
    {
        var parts = new List<NativeAiAnswerPart>();
        var text = new List<string>();
        string? marker = null;
        string language = "";
        var code = new List<string>();
        foreach (var line in (answer ?? "").Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            if (marker != null)
            {
                var closing = ClosingFence().Match(line);
                if (closing.Success && closing.Groups[1].Value[0] == marker[0] && closing.Groups[1].Value.Length >= marker.Length)
                {
                    parts.Add(new(NativeAiAnswerPartKind.Code, string.Join('\n', code), language, true));
                    marker = null;
                    continue;
                }
                code.Add(line);
                continue;
            }

            var opening = OpeningFence().Match(line);
            if (opening.Success && !(opening.Groups[1].Value[0] == '`' && opening.Groups[2].Value.Contains('`')))
            {
                if (text.Count > 0) parts.Add(new(NativeAiAnswerPartKind.Text, string.Join('\n', text)));
                text.Clear();
                marker = opening.Groups[1].Value;
                language = opening.Groups[2].Value.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.ToLowerInvariant() ?? "";
                code.Clear();
            }
            else text.Add(line);
        }

        if (marker != null) parts.Add(new(NativeAiAnswerPartKind.Code, string.Join('\n', code), language, false));
        if (text.Count > 0) parts.Add(new(NativeAiAnswerPartKind.Text, string.Join('\n', text)));
        return parts;
    }

    public static bool IsShellLanguage(string? language) => ShellLanguages.Contains((language ?? "").ToLowerInvariant());

    public static NativeAiTerminalPaste PrepareTerminalPaste(string? text, bool bracketedPaste)
    {
        text ??= "";
        if (text.Length > 32_768) return new(null, "tooLong");
        var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd('\n');
        if (string.IsNullOrWhiteSpace(normalized)) return new(null, "empty");
        foreach (var character in normalized)
            if (character is >= '\0' and <= '\b' or >= '\u000b' and <= '\u001f' or >= '\u007f' and <= '\u009f')
                return new(null, "controlCharacters");
        if (!bracketedPaste && (normalized.Contains('\n') || normalized.Contains('\t')))
            return new(null, "multilineUnsupported");
        return new(normalized, null);
    }
}
