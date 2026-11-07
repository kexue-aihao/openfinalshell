namespace OpenFinalShell.Core;

public sealed record NativeUploadCandidate(string Name, bool IsDirectory);
public sealed record NativeUploadRemoteEntry(string Name, bool IsDirectory, bool IsSymbolicLink, long Size = 0);
public sealed record NativeUploadPlanItem(NativeUploadCandidate Candidate, string RemoteName, bool Overwrite, bool Skipped);
public sealed record NativeUploadConflictPlan(
    IReadOnlyList<NativeUploadPlanItem> Items,
    IReadOnlyList<NativeUploadRemoteEntry> Conflicts,
    bool RequiresDecision);

/// <summary>Applies one Electron-compatible conflict decision to a batch of top-level uploads.</summary>
public static class NativeUploadConflictPlanner
{
    public static NativeUploadConflictPlan Plan(
        IReadOnlyList<NativeUploadCandidate> candidates,
        IReadOnlyList<NativeUploadRemoteEntry> remoteEntries,
        string action)
    {
        if (action is not ("ask" or "overwrite" or "skip" or "rename"))
            throw new ArgumentOutOfRangeException(nameof(action));

        var candidateNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate.Name) || candidate.Name is "." or ".." ||
                candidate.Name.Contains('/') || candidate.Name.Contains('\\'))
                throw new InvalidDataException("Upload names must be single path segments.");
            if (!candidateNames.Add(candidate.Name))
                throw new InvalidDataException($"The upload batch contains the same remote name more than once: {candidate.Name}");
        }

        var existing = new Dictionary<string, NativeUploadRemoteEntry>(StringComparer.Ordinal);
        foreach (var entry in remoteEntries)
            existing.TryAdd(entry.Name, entry);

        var conflicts = candidates
            .Where(candidate => existing.ContainsKey(candidate.Name))
            .Select(candidate => existing[candidate.Name])
            .ToArray();
        var requiresDecision = action == "ask" && conflicts.Length > 0;
        if (requiresDecision)
            return new(candidates.Select(item => new NativeUploadPlanItem(item, item.Name, false, false)).ToArray(), conflicts, true);

        var reservedNames = new HashSet<string>(existing.Keys, StringComparer.Ordinal);
        reservedNames.UnionWith(candidateNames);
        var planned = new List<NativeUploadPlanItem>(candidates.Count);
        foreach (var candidate in candidates)
        {
            if (!existing.TryGetValue(candidate.Name, out var target))
            {
                // Electron leaves conflict policy on the queued item so a collision
                // arriving after the probe is handled using the selected action.
                planned.Add(new(candidate, candidate.Name, action == "overwrite", false));
                continue;
            }

            switch (action)
            {
                case "skip":
                    planned.Add(new(candidate, candidate.Name, false, true));
                    break;
                case "overwrite":
                    if (target.IsSymbolicLink || target.IsDirectory != candidate.IsDirectory)
                        throw new IOException($"The existing remote item cannot be safely overwritten: {candidate.Name}");
                    planned.Add(new(candidate, candidate.Name, true, false));
                    break;
                case "rename":
                    planned.Add(new(candidate, Deduplicate(candidate.Name, reservedNames), false, false));
                    break;
                default:
                    // ask with no collisions: keep late-arriving conflicts subject to the transfer worker's guard.
                    planned.Add(new(candidate, candidate.Name, false, false));
                    break;
            }
        }

        return new(planned, conflicts, false);
    }

    private static string Deduplicate(string name, HashSet<string> reservedNames)
    {
        var dot = name.LastIndexOf('.');
        var stem = dot > 0 ? name[..dot] : name;
        var extension = dot > 0 ? name[dot..] : string.Empty;
        for (var index = 2; index < 1000; index++)
        {
            var candidate = $"{stem} ({index}){extension}";
            if (reservedNames.Add(candidate)) return candidate;
        }
        throw new IOException($"Could not find an available remote name for {name}.");
    }
}
