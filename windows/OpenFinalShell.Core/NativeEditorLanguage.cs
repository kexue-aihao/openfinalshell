namespace OpenFinalShell.Core;

/// <summary>Maps common remote file names and shebangs to editor lexer names.</summary>
public static class NativeEditorLanguage
{
    public static string Resolve(string path, string text)
    {
        var name = path.Replace('\\', '/').Split('/').LastOrDefault() ?? string.Empty;
        var lowerName = name.ToLowerInvariant();
        if (lowerName is "dockerfile" or "containerfile" || lowerName.StartsWith("dockerfile.", StringComparison.Ordinal)) return "dockerfile";
        if (lowerName is "makefile" or "gnumakefile") return "makefile";
        if (lowerName == "cmakelists.txt") return "cmake";
        if (lowerName == "nginx.conf") return "nginx";
        if (lowerName.StartsWith(".env", StringComparison.Ordinal) || lowerName is ".bashrc" or ".bash_profile" or ".bash_logout" or ".bash_aliases" or ".profile" or ".zshrc" or ".zprofile" or ".zshenv" or ".kshrc" or "crontab" or "sshd_config" or "ssh_config" or "my.cnf" or "php.ini" or "redis.conf" or "supervisord.conf" or "httpd.conf" or "smb.conf" or "resolv.conf" or "sysctl.conf" or "limits.conf" or "logrotate.conf" or "fstab" or "hosts" or "hostname" or "gitconfig" or ".gitconfig" or ".gitignore" or ".gitattributes" or ".gitmodules" or ".npmrc" or ".editorconfig" or ".inputrc")
            return lowerName is ".bashrc" or ".bash_profile" or ".bash_logout" or ".bash_aliases" or ".profile" or ".zshrc" or ".zprofile" or ".zshenv" or ".kshrc" or "crontab" ? "bash" : "props";

        var extension = Path.GetExtension(lowerName).TrimStart('.');
        var lexer = extension switch
        {
            "json" or "jsonc" or "json5" => "json",
            "yaml" or "yml" => "yaml",
            "sh" or "bash" or "zsh" or "ksh" => "bash",
            "conf" or "cnf" or "cfg" or "ini" or "properties" or "service" or "socket" or "timer" or "target" or "mount" or "desktop" or "repo" or "list" => "props",
            "toml" => "toml",
            "diff" or "patch" => "diff",
            "lua" => "lua",
            "pl" or "pm" => "perl",
            "py" or "pyw" => "python",
            "js" or "mjs" or "cjs" or "jsx" => "javascript",
            "ts" or "mts" or "cts" or "tsx" => "typescript",
            "cs" => "csharp",
            "java" => "java",
            "go" => "go",
            "c" or "h" or "cc" or "hh" or "cxx" or "hxx" or "cpp" or "hpp" or "m" or "mm" => "cpp",
            "rs" => "rust",
            "rb" or "rake" or "gemspec" => "ruby",
            "php" or "phtml" => "php",
            "xml" or "xsl" or "xsd" or "plist" or "svg" or "rss" => "xml",
            "html" or "htm" => "html",
            "sql" => "sql",
            "css" or "scss" or "less" => "css",
            "md" or "markdown" or "mdown" or "mkd" => "markdown",
            "ps1" or "psm1" or "psd1" => "powershell",
            "bat" or "cmd" => "batch",
            "cmake" => "cmake",
            "mk" => "makefile",
            "dart" => "dart",
            "fs" or "fsi" or "fsx" => "fsharp",
            "nim" => "nim",
            "nix" => "nix",
            "zig" => "zig",
            "d" => "d",
            "r" => "r",
            "coffee" => "coffeescript",
            _ => "plain"
        };
        if (lexer != "plain") return lexer;

        var lineEnd = text.IndexOf('\n');
        var firstLine = (lineEnd < 0 ? text : text[..lineEnd]).TrimEnd('\r');
        if (firstLine.StartsWith("#!", StringComparison.Ordinal))
        {
            if (firstLine.Contains("python", StringComparison.OrdinalIgnoreCase)) return "python";
            if (firstLine.Contains("perl", StringComparison.OrdinalIgnoreCase)) return "perl";
            if (firstLine.Contains("node", StringComparison.OrdinalIgnoreCase) || firstLine.Contains("deno", StringComparison.OrdinalIgnoreCase) || firstLine.Contains("bun", StringComparison.OrdinalIgnoreCase)) return "javascript";
            if (firstLine.Contains("lua", StringComparison.OrdinalIgnoreCase)) return "lua";
            if (firstLine.Contains("bash", StringComparison.OrdinalIgnoreCase) || firstLine.Contains("/sh", StringComparison.OrdinalIgnoreCase) || firstLine.Contains("zsh", StringComparison.OrdinalIgnoreCase)) return "bash";
            if (firstLine.Contains("pwsh", StringComparison.OrdinalIgnoreCase) || firstLine.Contains("powershell", StringComparison.OrdinalIgnoreCase)) return "powershell";
            if (firstLine.Contains("ruby", StringComparison.OrdinalIgnoreCase)) return "ruby";
            if (firstLine.Contains("php", StringComparison.OrdinalIgnoreCase)) return "php";
        }
        return "plain";
    }
}
