using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed class NativeCommandLibrary
{
    private readonly NativeStore store;
    public NativeCommandLibrary(NativeStore store) => this.store = store;

    public IReadOnlyList<NativeSnippetGroup> ListGroups() => store.List("snippetGroups")
        .Select(value => new NativeSnippetGroup(value["id"]?.GetValue<string>() ?? "", value["name"]?.GetValue<string>() ?? "", value["order"]?.GetValue<double>() ?? 0))
        .Where(value => value.Id.Length > 0 && value.Name.Length > 0).OrderBy(value => value.Order).ThenBy(value => value.Name).ToArray();

    public IReadOnlyList<NativeSnippet> ListSnippets(string? groupId = null) => store.List("snippets")
        .Select(value => new NativeSnippet(value["id"]?.GetValue<string>() ?? "", value["groupId"]?.GetValue<string>() ?? "", value["name"]?.GetValue<string>() ?? "", value["command"]?.GetValue<string>() ?? "", value["autoEnter"]?.GetValue<bool>() ?? false, value["order"]?.GetValue<double>() ?? 0))
        .Where(value => value.Id.Length > 0 && value.Name.Length > 0 && value.Command.Length > 0 && (groupId == null || value.GroupId == groupId))
        .OrderBy(value => value.Order).ThenBy(value => value.Name).ToArray();

    public NativeSnippetGroup SaveGroup(string? id, string name, double order = 0)
    {
        var groupId = string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id.Trim();
        var existing = store.Find("snippetGroups", groupId);
        var value = new JsonObject { ["id"] = groupId, ["name"] = Require(name, 200), ["order"] = double.IsFinite(order) ? order : 0 };
        store.Save("snippetGroups", groupId, value, existing?["_revision"]?.GetValue<long>());
        return new(groupId, value["name"]!.GetValue<string>(), value["order"]!.GetValue<double>());
    }

    public NativeSnippet SaveSnippet(string? id, string groupId, string name, string command, bool autoEnter, double order = 0)
    {
        if (store.Find("snippetGroups", groupId) == null) throw new InvalidDataException("Command group not found.");
        var snippetId = string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id.Trim();
        var existing = store.Find("snippets", snippetId);
        var value = new JsonObject { ["id"] = snippetId, ["groupId"] = groupId, ["name"] = Require(name, 200), ["command"] = Require(command, 32768), ["autoEnter"] = autoEnter, ["order"] = double.IsFinite(order) ? order : 0 };
        store.Save("snippets", snippetId, value, existing?["_revision"]?.GetValue<long>());
        return new(snippetId, groupId, value["name"]!.GetValue<string>(), value["command"]!.GetValue<string>(), autoEnter, value["order"]!.GetValue<double>());
    }

    public void DeleteGroup(string id)
    {
        foreach (var snippet in ListSnippets(id)) DeleteSnippet(snippet.Id);
        var value = store.Find("snippetGroups", id) ?? throw new KeyNotFoundException("Command group not found.");
        store.Delete("snippetGroups", id, value["_revision"]?.GetValue<long>() ?? 0);
    }

    public void DeleteSnippet(string id)
    {
        var value = store.Find("snippets", id) ?? throw new KeyNotFoundException("Command not found.");
        store.Delete("snippets", id, value["_revision"]?.GetValue<long>() ?? 0);
    }

    public void AddHistory(string sessionId, string command)
    {
        if (string.IsNullOrWhiteSpace(command) || command.Length > 32768) return;
        var value = new JsonObject { ["id"] = Guid.NewGuid().ToString("N"), ["sessionId"] = sessionId, ["command"] = command, ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        store.Save("commandHistory", value["id"]!.GetValue<string>(), value);
        var history = store.List("commandHistory").OrderByDescending(item => item["createdAt"]?.GetValue<long>() ?? 0).Skip(1000).ToArray();
        foreach (var old in history) if (old["id"]?.GetValue<string>() is { } id) try { store.Delete("commandHistory", id, old["_revision"]?.GetValue<long>() ?? 0); } catch { }
    }

    public IReadOnlyList<string> ListHistory(string? sessionId = null, int max = 200) => store.List("commandHistory")
        .Where(value => sessionId == null || value["sessionId"]?.GetValue<string>() == sessionId)
        .OrderByDescending(value => value["createdAt"]?.GetValue<long>() ?? 0)
        .Select(value => value["command"]?.GetValue<string>()).OfType<string>().Take(Math.Clamp(max, 1, 1000)).ToArray();

    public void ClearHistory(string? sessionId = null)
    {
        foreach (var value in store.List("commandHistory"))
            if ((sessionId == null || value["sessionId"]?.GetValue<string>() == sessionId) && value["id"]?.GetValue<string>() is { } id)
                try { store.Delete("commandHistory", id, value["_revision"]?.GetValue<long>() ?? 0); } catch { }
    }

    private static string Require(string value, int max) => !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= max ? value.Trim() : throw new ArgumentException("Command library value is invalid.");
}
