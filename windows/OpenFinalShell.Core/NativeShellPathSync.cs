namespace OpenFinalShell.Core;

/// <summary>Conservative shell cd parsing used to keep the SFTP pane in sync.</summary>
public static class NativeShellPathSync
{
    public static string? ParseCdTarget(string command)
    {
        var first = FirstSegment(command).Trim();
        if (first != "cd" && !first.StartsWith("cd ", StringComparison.Ordinal) && !first.StartsWith("cd\t", StringComparison.Ordinal)) return null;
        var tokens = SplitTokens(first[2..]);
        var index = 0;
        while (index < tokens.Count && (tokens[index] is "-P" or "-L" or "--")) index++;
        if (index >= tokens.Count) return "~";
        var target = tokens[index];
        if (target == "-" || target.Any(c => c is '$' or '`')) return null;
        return target;
    }

    public static string? ApplyCd(string cwd, string target, string? home)
    {
        if (string.IsNullOrWhiteSpace(target)) return null;
        if (target == "~") return home is null ? null : Normalize(home);
        if (target.StartsWith("~/", StringComparison.Ordinal)) return home is null ? null : Normalize(home + "/" + target[2..]);
        if (target.StartsWith('~')) return null;
        if (target.StartsWith('/')) return Normalize(target);
        if (!cwd.StartsWith('/')) return null;
        return Normalize(cwd + "/" + target);
    }

    public static string Normalize(string path)
    {
        var parts = new List<string>();
        foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == ".") continue;
            if (part == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); continue; }
            parts.Add(part);
        }
        return "/" + string.Join('/', parts);
    }

    private static string FirstSegment(string command)
    {
        char quote = '\0';
        for (var index = 0; index < command.Length; index++)
        {
            var value = command[index];
            if (quote != '\0') { if (value == quote && !(quote == '"' && index > 0 && command[index - 1] == '\\')) quote = '\0'; continue; }
            if (value is '\'' or '"') { quote = value; continue; }
            if (value == '\\') { index++; continue; }
            if (command[index..].StartsWith("&&", StringComparison.Ordinal) || command[index..].StartsWith("||", StringComparison.Ordinal) || value is ';' or '|' or '&') return command[..index];
        }
        return command;
    }

    private static List<string> SplitTokens(string value)
    {
        var result = new List<string>(); var current = new System.Text.StringBuilder(); char quote = '\0'; var inToken = false;
        void Push() { if (inToken) result.Add(current.ToString()); current.Clear(); inToken = false; }
        for (var index = 0; index < value.Length; index++)
        {
            var ch = value[index];
            if (quote != '\0') { if (ch == quote) quote = '\0'; else current.Append(ch); continue; }
            if (ch is '\'' or '"') { quote = ch; inToken = true; continue; }
            if (ch == '\\' && index + 1 < value.Length) { current.Append(value[++index]); inToken = true; continue; }
            if (ch is ' ' or '\t') { Push(); continue; }
            current.Append(ch); inToken = true;
        }
        Push(); return result;
    }
}
