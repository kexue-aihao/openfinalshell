using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeFastDeleteTests
{
    public static void Run(Action<bool, string> check, Action<Action, string> reject)
    {
        var localization = new Localization();
        localization.SetLanguage("en-US");

        var preview = NativeFastDelete.Preview(["/var/data/o'k", "/var/data/second"], localization);
        check(preview.Count == 2 && preview.Batches == 1 && preview.Command.Contains("'/var/data/o'\"'\"'k'", StringComparison.Ordinal),
            "Fast delete previews POSIX-quoted paths and exact item counts");
        check(preview.Command.Contains("rm -rf --", StringComparison.Ordinal) && preview.Command.Contains("OFSLEFT:", StringComparison.Ordinal),
            "Fast delete command preserves option terminator and residue reporting");

        reject(() => NativeFastDelete.Preview([], localization), "Fast delete rejects an empty selection");
        reject(() => NativeFastDelete.Preview(["/"], localization), "Fast delete rejects filesystem root");
        reject(() => NativeFastDelete.Preview(["/data"], localization), "Fast delete rejects shallow system-level paths");
        reject(() => NativeFastDelete.Preview(["/data/../etc"], localization), "Fast delete rejects dot segments");
        reject(() => NativeFastDelete.Preview(["relative/path"], localization), "Fast delete rejects relative paths");
        reject(() => NativeFastDelete.Preview(["/data/line\nbreak"], localization), "Fast delete rejects line breaks used by result framing");

        var many = Enumerable.Range(0, NativeFastDelete.BatchSize + 1).Select(index => $"/data/group/item-{index}").ToArray();
        var batches = NativeFastDelete.Preview(many, localization);
        check(batches.Count == many.Length && batches.Batches == 2, "Fast delete splits large selections into bounded batches");

        var calls = 0;
        var execution = NativeFastDelete.ExecuteAsync(many, localization, (command, _) =>
        {
            calls++;
            return Task.FromResult(calls == 1
                ? new NativeCommandResult("OFSLEFT:/data/group/item-0\n", "first warning\n", 1)
                : new NativeCommandResult("", "", null));
        }).GetAwaiter().GetResult();
        check(calls == 2 && execution.ExitCode is null && execution.Leftover.SequenceEqual(["/data/group/item-0"]) &&
            execution.StandardError == "first warning\n", "Fast delete aggregates batches and treats a missing exit code as unknown");

        var thrown = NativeFastDelete.ExecuteAsync(["/data/one"], localization,
            (_, _) => throw new IOException("fixture disconnected")).GetAwaiter().GetResult();
        check(thrown.ExitCode is null && thrown.StandardError.Contains("fixture disconnected", StringComparison.Ordinal),
            "Fast delete reports a disconnected command as an unknown result");
    }
}
