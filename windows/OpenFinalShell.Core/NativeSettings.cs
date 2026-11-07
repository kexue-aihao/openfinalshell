using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record NativeSettings(
    string ThemeMode, string Language, bool ReduceTransparency, int UiScale, int MonitorIntervalMs,
    string ConnectionSort = "name", string ConnectionGrouping = "none")
{
    public const string DefaultThemeMode = "dark";
    public const string DefaultLanguage = "zh-CN";
    public const string DefaultAccent = "#1677ff";
    public const string DefaultTerminalRightClick = "paste";
    public const bool DefaultTerminalCopyOnSelect = true;
    public const bool DefaultSftpShowHiddenFiles = true;
    public const string DefaultSftpDoubleClickAction = "download";
    public static readonly string[] AccentColors = ["#1677ff", "#13c2c2", "#52c41a", "#faad14", "#fa8c16", "#f5222d", "#eb2f96", "#722ed1"];
    private JsonObject? baseline;
    public string Accent { get; init; } = DefaultAccent;
    public static readonly string[] Languages = ["en-US", "zh-CN", "zh-TW", "de-DE", "es-ES", "fr-FR", "ja-JP", "ko-KR", "pt-BR", "ru-RU"];
    public static NativeSettings Defaults => new(DefaultThemeMode, DefaultLanguage, false, 100, 2000, "name", "group");
    public JsonObject Data => baseline == null ? new() : (JsonObject)baseline.DeepClone();
    public string? DefaultProxyId => Get<string?>("connection.defaultProxyId", null);
    public bool MaskHostInList => Get("connection.maskHostInList", true);
    public bool SaveCommandHistory => Get("terminal.saveCommandHistory", true);
    public string TerminalRightClick
    {
        get { var value = Get("terminal.rightClick", DefaultTerminalRightClick); return value is "menu" or "paste" ? value : DefaultTerminalRightClick; }
    }
    public bool TerminalCopyOnSelect => Get("terminal.copyOnSelect", DefaultTerminalCopyOnSelect);
    public bool SftpShowHiddenFiles => Get("sftp.showHiddenFiles", DefaultSftpShowHiddenFiles);
    public string SftpDoubleClickAction
    {
        get { var value = Get("sftp.doubleClickAction", DefaultSftpDoubleClickAction); return value is "open" or "download" ? value : DefaultSftpDoubleClickAction; }
    }
    public T Get<T>(string path, T fallback) => ReadPath(baseline, path, fallback);
    public static T ReadPath<T>(JsonNode? root, string path, T fallback)
    {
        JsonNode? current = root;
        foreach (var key in path.Split('.')) current = current is JsonObject obj ? obj[key] : null;
        if (current is not JsonValue value) return fallback;
        if (value.TryGetValue<T>(out var result))
            return result is null || result is double d && !double.IsFinite(d) || result is float f && !float.IsFinite(f) ? fallback : result;
        if (value.GetValueKind() == System.Text.Json.JsonValueKind.Number)
        {
            try { return System.Text.Json.JsonSerializer.Deserialize<T>(value.ToJsonString()) ?? fallback; }
            catch (System.Text.Json.JsonException) { }
        }
        return fallback;
    }

    public static NativeSettings Load(NativeStore store) => FromJson(store.Find("settings", "settings"));
    private static NativeSettings FromJson(JsonObject? data)
    {
        if (data == null) return Defaults;
        var accent = ReadPath(data, "accent", DefaultAccent);
        if (!AccentColors.Contains(accent, StringComparer.OrdinalIgnoreCase)) accent = DefaultAccent;
        return new NativeSettings(
            ReadPath(data, "themeMode", DefaultThemeMode) is "system" or "light" or "dark" ? ReadPath(data, "themeMode", DefaultThemeMode) : DefaultThemeMode,
            Languages.Contains(ReadPath(data, "language", DefaultLanguage)) ? ReadPath(data, "language", DefaultLanguage) : DefaultLanguage,
            ReadPath(data, "reduceTransparency", false),
            (int)Math.Clamp(Math.Round(ReadPath(data, "uiZoom", (double)ReadPath(data, "uiScale", 100))), 50, 200),
            Math.Clamp(ReadPath(data, "monitor.intervalMs", ReadPath(data, "monitorIntervalMs", 2000)), 500, 60000),
            ReadPath(data, "connectionSort", "name") is "host" or "recent" ? ReadPath(data, "connectionSort", "name") : "name",
            ReadPath(data, "connectionGrouping", "group") == "none" ? "none" : "group")
        { baseline = (JsonObject)data.DeepClone(), Accent = accent };
    }

    public NativeSettings Save(NativeStore store)
    {
        var projection = Projection();
        var previous = baseline == null ? null : FromJson(baseline).Projection();
        var patch = new JsonObject();
        foreach (var (key, value) in projection)
            if (previous == null || !JsonNode.DeepEquals(value, previous[key])) patch[key] = value?.DeepClone();
        if (patch.Count > 0) store.Patch("settings", "settings", patch);
        return Load(store);
    }
    public static NativeSettings Update(NativeStore store, JsonObject patch)
    {
        store.Patch("settings", "settings", patch); return Load(store);
    }
    public JsonObject ToJson()
    {
        var data = Data;
        foreach (var (key, value) in Projection())
        {
            if (key == "monitor" && data[key] is JsonObject monitor) monitor["intervalMs"] = MonitorIntervalMs;
            else data[key] = value?.DeepClone();
        }
        return data;
    }
    private JsonObject Projection() => new()
    {
        ["id"] = "settings", ["themeMode"] = ThemeMode, ["language"] = Language,
        ["accent"] = Accent, ["reduceTransparency"] = ReduceTransparency, ["uiZoom"] = UiScale,
        ["monitor"] = new JsonObject { ["intervalMs"] = MonitorIntervalMs },
        ["connectionSort"] = ConnectionSort, ["connectionGrouping"] = ConnectionGrouping
    };

    /// <summary>Portable preferences only; never accept executable paths or updater configuration.</summary>
    public static JsonObject Portable(JsonObject source)
    {
        var result = new JsonObject();
        void Copy(JsonObject from, JsonObject to, string booleans, string numbers, string strings)
        {
            foreach (var key in booleans.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                if (from[key] is JsonValue b && b.TryGetValue<bool>(out var flag)) to[key] = flag;
            foreach (var key in numbers.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                if (from[key] is JsonValue n && n.TryGetValue<double>(out var value) && double.IsFinite(value) && value >= 0 && value <= 1000000) to[key] = n.DeepClone();
            foreach (var key in strings.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                if (from[key] is JsonValue s && s.TryGetValue<string>(out var value) && value.Length <= 1024) to[key] = value;
        }
        Copy(source, result, "reduceTransparency confirmOnCloseTab restoreTabsOnLaunch autoCheckUpdate aiAssistantEnabled multiInstanceEnabled", "version uiZoom", "themeMode language accent");
        foreach (var (name, booleans, numbers, strings) in new[] {
            ("terminal", "cursorBlink copyOnSelect confirmMultilinePaste saveCommandHistory", "fontSize lineHeight scrollback", "fontFamily cursorStyle rightClick themeId"),
            ("sftp", "showHiddenFiles autoOpenOnConnect fastDelete packedTransfer followTerminalCd", "maxConcurrentPerSession maxConcurrentGlobal", "conflictPolicy doubleClickAction"),
            ("connection", "maskHostInList", "", "defaultProxyId"),
            ("monitor", "", "intervalMs", ""),
            ("layout", "sidePanelCollapsed monitorPanelCollapsed sftpPaneOpen", "sidePanelSizePct monitorPanelSizePct sftpPaneHeightPct editorPaneHeightPct", "activeSidebar") })
        {
            if (source[name] is not JsonObject obj) continue;
            var child = new JsonObject(); Copy(obj, child, booleans, numbers, strings); result[name] = child;
            if (name == "connection" && obj.ContainsKey("defaultProxyId") && obj["defaultProxyId"] == null) child["defaultProxyId"] = null;
        }
        return result;
    }
}
