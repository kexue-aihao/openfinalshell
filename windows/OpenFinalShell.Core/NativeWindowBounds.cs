using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

/// <summary>Validated normal window bounds persisted in the native-only workspace state.</summary>
public sealed record NativeWindowBounds(int Width, int Height, bool Maximized)
{
    public const int MinimumWidth = 800;
    public const int MinimumHeight = 600;
    public const int MaximumWidth = 7680;
    public const int MaximumHeight = 4320;

    public static NativeWindowBounds? Read(JsonNode? workspace)
    {
        if (workspace is not JsonObject data
            || !TryInteger(data["windowWidth"], out var width)
            || !TryInteger(data["windowHeight"], out var height)
            || width is < MinimumWidth or > MaximumWidth
            || height is < MinimumHeight or > MaximumHeight)
            return null;

        var maximized = data["windowMaximized"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        return new(width, height, maximized);
    }

    private static bool TryInteger(JsonNode? node, out int result)
    {
        result = 0;
        return node is JsonValue value
            && value.GetValueKind() == System.Text.Json.JsonValueKind.Number
            && value.TryGetValue(out result);
    }
}
