namespace OpenFinalShell.Core;

public static class NativeConnectionHierarchy
{
    public static IReadOnlyDictionary<string, string> Issues(IEnumerable<ConnectionGroup> groups)
    {
        var byId = groups.ToDictionary(g => g.Id, StringComparer.Ordinal);
        var errors = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in byId.Values)
        {
            var visited = new HashSet<string>(StringComparer.Ordinal) { group.Id };
            var parent = group.ParentId;
            while (parent != null)
            {
                if (!visited.Add(parent)) { errors[group.Id] = "native.workbench.groupCycle"; break; }
                if (!byId.TryGetValue(parent, out var ancestor)) { errors[group.Id] = "native.workbench.groupMissing"; break; }
                parent = ancestor.ParentId;
            }
        }
        return errors;
    }
}
