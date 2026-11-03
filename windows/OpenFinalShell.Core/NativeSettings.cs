using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record NativeSettings(
    string ThemeMode,
    string Language,
    bool ReduceTransparency,
    int UiScale,
    int MonitorIntervalMs,
    string ConnectionSort = "name",
    string ConnectionGrouping = "none")
{
    public static NativeSettings Defaults => new("system", "en-US", false, 100, 2000, "name", "none");

    public static NativeSettings Load(NativeStore store)
    {
        var data = store.Find("settings", "settings");
        if (data == null) return Defaults;
        return new(
            NormalizeTheme(data["themeMode"]?.GetValue<string>()),
            NormalizeLanguage(data["language"]?.GetValue<string>()),
            data["reduceTransparency"]?.GetValue<bool>() ?? false,
            Math.Clamp(data["uiScale"]?.GetValue<int>() ?? 100, 100, 200),
            Math.Clamp(data["monitorIntervalMs"]?.GetValue<int>() ?? 2000, 500, 60000),
            data["connectionSort"]?.GetValue<string>() is "name" or "host" or "recent" ? data["connectionSort"]!.GetValue<string>() : "name",
            data["connectionGrouping"]?.GetValue<string>() is "none" or "group" ? data["connectionGrouping"]!.GetValue<string>() : "none");
    }

    public NativeSettings Save(NativeStore store)
    {
        store.Save("settings", "settings", ToJson());
        return this;
    }

    public JsonObject ToJson() => new()
    {
        ["id"] = "settings",
        ["themeMode"] = ThemeMode,
        ["language"] = Language,
        ["reduceTransparency"] = ReduceTransparency,
        ["uiScale"] = UiScale,
        ["monitorIntervalMs"] = MonitorIntervalMs,
        ["connectionSort"] = ConnectionSort,
        ["connectionGrouping"] = ConnectionGrouping
    };

    private static string NormalizeTheme(string? value) => value is "light" or "dark" ? value : "system";
    private static string NormalizeLanguage(string? value) => value is "zh-CN" or "en-US" ? value : "en-US";
}
