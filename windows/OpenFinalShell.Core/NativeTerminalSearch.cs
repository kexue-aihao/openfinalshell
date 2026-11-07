using System.Text.RegularExpressions;

namespace OpenFinalShell.Core;

public readonly record struct NativeTerminalSearchMatch(int Index, int Length);

/// <summary>Pure, bounded matcher shared by the WinUI terminal and contract tests.</summary>
public static class NativeTerminalSearch
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(250);

    public static IReadOnlyList<NativeTerminalSearchMatch> Find(string line, string query, bool caseSensitive, bool regex)
    {
        if (string.IsNullOrEmpty(line) || string.IsNullOrEmpty(query)) return [];
        try
        {
            if (regex)
            {
                var options = RegexOptions.CultureInvariant | (caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase);
                return Regex.Matches(line, query, options, RegexTimeout)
                    .Cast<Match>()
                    .Where(match => match.Length > 0)
                    .Select(match => new NativeTerminalSearchMatch(match.Index, match.Length))
                    .ToArray();
            }

            var comparison = caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            var results = new List<NativeTerminalSearchMatch>();
            var offset = 0;
            while (offset <= line.Length - query.Length)
            {
                var index = line.IndexOf(query, offset, comparison);
                if (index < 0) break;
                results.Add(new(index, query.Length));
                offset = index + Math.Max(1, query.Length);
            }
            return results;
        }
        catch (ArgumentException) { return []; }
        catch (RegexMatchTimeoutException) { return []; }
    }
}
