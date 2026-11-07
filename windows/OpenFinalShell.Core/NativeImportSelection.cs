using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

/// <summary>Category selection never changes the decrypted source preview.</summary>
public static class NativeImportSelection
{
    /// <summary>Mirror the shared import flow defaults: data categories are selected, local settings are opt-in.</summary>
    public static IReadOnlySet<string> DefaultCategories { get; } = new HashSet<string>(
        ["profiles", "aiProfiles", "snippets", "forwards", "knownHosts"], StringComparer.Ordinal);

    public static ImportPreview Select(ImportPreview source, IEnumerable<string> categories, NativeStore store)
    {
        var included = categories.ToHashSet(StringComparer.Ordinal);
        var data = new JsonObject();
        foreach (var (kind, value) in source.Data) if (included.Contains(kind)) data[kind] = value?.DeepClone();
        bool Exists(string kind, string id) => (data[kind] as JsonArray)?.OfType<JsonObject>().Any(item => (item["id"] ?? item["key"])?.GetValue<string>() == id) == true || store.Find(kind, id) != null;
        void Check(JsonNode? node, string category)
        {
            if (node is JsonObject obj)
                foreach (var (key, value) in obj)
                {
                    var kind = key switch { "groupId" => category == "snippets" ? "snippetGroups" : "groups", "parentId" when category is "groups" or "snippetGroups" => category, "privateKeyId" => "privateKeys", "proxyId" or "defaultProxyId" => "proxies", "profileId" or "jumpHostId" => "profiles", _ => null };
                    if (kind != null && value is JsonValue scalar && scalar.TryGetValue<string>(out var id) && !string.IsNullOrEmpty(id) && !Exists(kind, id))
                        throw new InvalidDataException("native.workbench.importDependency");
                    Check(value, category);
                }
            else if (node is JsonArray array) foreach (var item in array) Check(item, category);
        }
        foreach (var (category, value) in data) Check(value, category);
        var refs = new HashSet<string>(StringComparer.Ordinal);
        void Collect(JsonNode? node)
        {
            if (node is JsonObject obj) foreach (var (key, value) in obj)
            {
                if (key.EndsWith("Ref", StringComparison.Ordinal) && key != "materialRef" && value is JsonValue scalar && scalar.TryGetValue<string>(out var id)) refs.Add(id);
                else Collect(value);
            }
            else if (node is JsonArray array) foreach (var item in array) Collect(item);
        }
        Collect(data);
        var secrets = new JsonObject();
        foreach (var (id, value) in source.Secrets) if (refs.Contains(id)) secrets[id] = value?.DeepClone();
        return new(data, secrets, (data["profiles"] as JsonArray)?.Count ?? 0, secrets.Count, source.MissingPrivateKeys);
    }
}
