using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed class Localization
{
    private readonly JsonObject fallback = Load("en-US");
    private JsonObject active = Load(CultureInfo.CurrentUICulture.Name);
    public string Language { get; private set; } = CultureInfo.CurrentUICulture.Name;
    public void SetLanguage(string tag) { active = Load(tag); Language = tag; }
    public string this[string key] => Read(active, key) ?? Read(fallback, key) ?? key;
    public string Format(string key, params (string Key, string Value)[] values)
    {
        var text = this[key];
        foreach (var (name, value) in values) text = text.Replace("{{" + name + "}}", value, StringComparison.Ordinal);
        return text;
    }
    private static string? Read(JsonObject obj, string key)
    {
        JsonNode? node = obj;
        foreach (var part in key.Split('.')) node = node is JsonObject o ? o[part] : null;
        return node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    }
    private static JsonObject Load(string tag)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var name = assembly.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith($".{tag}.json", StringComparison.Ordinal));
        if (name == null) return new();
        using var stream = assembly.GetManifestResourceStream(name)!;
        return JsonNode.Parse(stream)?.AsObject() ?? new();
    }
}
