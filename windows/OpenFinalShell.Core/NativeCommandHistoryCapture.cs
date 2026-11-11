using System.Text.RegularExpressions;

namespace OpenFinalShell.Core;

/// <summary>Only echoed shell lines qualify; never reconstruct history from input bytes.</summary>
public static partial class NativeCommandHistoryCapture
{
    public static string? ExtractEchoed(string line, bool alternateScreen = false)
    {
        if (alternateScreen || line.Length > 4096 || line.Any(char.IsControl)) return null;
        var prompt = PromptEnd().Match(line);
        if (!prompt.Success) return null;
        var cut = prompt.Index + prompt.Length;
        if (SecretPrompt().IsMatch(line[..cut])) return null;
        var command = line[cut..].Trim();
        return command.Length is > 0 and <= 2000 ? command : null;
    }
    // Common remote shells use $, # or %; fish and PowerShell style prompts
    // commonly end in >. These are still deliberately prompt markers rather
    // than a general input capture, so secrets typed at password prompts are
    // never reconstructed from terminal keystrokes.
    [GeneratedRegex("[$#%>❯➜»] ", RegexOptions.CultureInvariant)] private static partial Regex PromptEnd();
    [GeneratedRegex("pass(word|phrase)|密码|口令|secret|token", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex SecretPrompt();
}
