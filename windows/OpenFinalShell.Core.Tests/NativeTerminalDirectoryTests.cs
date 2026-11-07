using System.Text;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeTerminalDirectoryTests
{
    public static void Run(Action<bool, string> check)
    {
        var tracker = new NativeTerminalDirectoryTracker();
        string? Feed(string value) => tracker.Feed(Encoding.UTF8.GetBytes(value));
        check(Feed("cd /tmp\r\nuser@host:/tmp$ ") == null, "Directory following never guesses from commands or prompt text");
        check(Feed("\u001b]7;file://fixture/tmp/work%20space\a") == "/tmp/work space", "Explicit OSC 7 BEL report decodes a remote path without executing a command");
        var split = Encoding.UTF8.GetBytes("\u001b]7;file://fixture/中文\u001b\\");
        string? decoded = null;
        foreach (var item in split) decoded = tracker.Feed(new[] { item }) ?? decoded;
        check(decoded == "/中文", "OSC 7 UTF-8 and ST terminators survive byte-by-byte chunk boundaries");
        check(Feed("\u001b]7;file://fixture/中文\a") == null && tracker.CurrentDirectory == "/中文", "Duplicate directory reports do not issue duplicate navigation requests");
        check(Feed("\u001b]7;file://fixture/old\a\u001b]7;file://fixture/new\a") == "/new", "A terminal chunk coalesces directory reports to its newest path");
        var rejected = new[] { "https://fixture/tmp", "file://user@fixture/tmp", "file://fixture/tmp?query", "file://fixture/tmp#fragment", "file://fixture/%00", "file://fixture/%1b", "file://fixture/%5cetc", "file://fixture/%zz", "file://fixture/" + new string('x', 4097) };
        check(rejected.All(value => Feed("\u001b]7;" + value + "\a") == null) && tracker.CurrentDirectory == "/new", "Malformed, non-file, credential, control, backslash and oversized directory URIs are ignored");
        check(Feed("\u001bPignored\u001b]7;file://fixture/embedded\a\u001b\\") == null
            && Feed("\u001b]0;file://fixture/title\a") == null, "OSC inside DCS payloads and window titles cannot trigger directory following");
        check(Feed("\u001b]7;file://fixture/" + new string('x', 17000) + "\a\u001b]7;file:///recovered\a") == "/recovered", "Oversized OSC reports are bounded and the parser recovers at the next report");
        _ = Feed("\u001b]7;file:///partial"); tracker.Reset();
        check(Feed("\a") == null && tracker.CurrentDirectory == null && Feed("\u001b]7;file:///fresh\a") == "/fresh", "Session reset discards incomplete and stale remote directory state");
        var invalidUtf8 = Encoding.ASCII.GetBytes("\u001b]7;file://fixture/").Concat(new byte[] { 0xff, 7 }).ToArray();
        check(tracker.Feed(invalidUtf8) == null, "Invalid UTF-8 directory reports are rejected without replacement-character paths");
    }
}
