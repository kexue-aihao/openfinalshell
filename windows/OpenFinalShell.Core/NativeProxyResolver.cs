using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public static class NativeProxyResolver
{
    public static string Mode(JsonObject profile) => profile["proxyMode"]?.GetValue<string>() switch
    {
        "direct" => "direct", "custom" or "saved" => "custom", "follow" => "follow",
        _ => profile["proxyId"] != null || profile["proxy"] is JsonObject ? "custom" : "direct"
    };
    public static JsonObject? Resolve(JsonObject profile, NativeStore store)
    {
        var mode = Mode(profile);
        if (mode == "direct") return null;
        var id = mode == "follow" ? NativeSettings.Load(store).DefaultProxyId : profile["proxyId"]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(id)) return store.Find("proxies", id) ?? throw new InvalidDataException("native.errors.invalidProxy");
        return mode == "custom" && profile["proxy"] is JsonObject inline && inline["type"]?.GetValue<string>() != "none" ? inline : null;
    }
}
