using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeUploadConflictTests
{
    public static void Run(Action<bool, string> check, Action<Action, string> reject)
    {
        var batch = new NativeUploadCandidate[]
        {
            new("report.tar.gz", false),
            new("logs", true),
            new("new.txt", false)
        };
        var remote = new NativeUploadRemoteEntry[]
        {
            new("report.tar.gz", false, false, 8),
            new("report.tar (2).gz", false, false, 4),
            new("logs", true, false)
        };

        var ask = NativeUploadConflictPlanner.Plan(batch, remote, "ask");
        check(ask.RequiresDecision && ask.Conflicts.Count == 2 && ask.Items.All(item => !item.Overwrite && !item.Skipped),
            "Native upload conflict planning requests one decision for the whole batch");
        check(!NativeUploadConflictPlanner.Plan([new("clean.txt", false)], [], "ask").RequiresDecision,
            "Native upload ask policy does not show a conflict decision when the target names are free");

        var skip = NativeUploadConflictPlanner.Plan(batch, remote, "skip");
        check(skip.Items.Count(item => item.Skipped) == 2 && skip.Items.Single(item => item.Candidate.Name == "new.txt").RemoteName == "new.txt",
            "Native upload batch skip omits only the colliding top-level items");

        var overwrite = NativeUploadConflictPlanner.Plan(batch, remote, "overwrite");
        check(overwrite.Items.Count(item => item.Overwrite) == 3 && overwrite.Items.All(item => !item.Skipped),
            "Native upload batch overwrite applies to matching items and protects against late conflicts");

        var rename = NativeUploadConflictPlanner.Plan(batch, remote, "rename");
        check(rename.Items.Single(item => item.Candidate.Name == "report.tar.gz").RemoteName == "report.tar (3).gz" &&
            rename.Items.Single(item => item.Candidate.Name == "logs").RemoteName == "logs (2)",
            "Native upload batch rename uses Electron naming and reserves existing names");

        reject(() => NativeUploadConflictPlanner.Plan([new("logs", false)], [new("logs", true, false)], "overwrite"),
            "Native upload overwrite rejects a file-directory type mismatch");
        reject(() => NativeUploadConflictPlanner.Plan([new("link", false)], [new("link", false, true)], "overwrite"),
            "Native upload overwrite rejects a symbolic-link target");
        reject(() => NativeUploadConflictPlanner.Plan([new("same", false), new("same", false)], [], "skip"),
            "Native upload planning rejects duplicate names within one batch");
    }
}
