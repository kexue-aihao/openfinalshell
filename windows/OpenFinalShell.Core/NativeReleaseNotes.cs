using System.Reflection;
using System.Text.Json;

namespace OpenFinalShell.Core;

public sealed record NativeReleaseNoteItem(string Type, string Zh, string En);
public sealed record NativeReleaseNote(string Version, IReadOnlyList<NativeReleaseNoteItem> Items);

public static class NativeReleaseNotes
{
    private static readonly Lazy<IReadOnlyList<NativeReleaseNote>> Cache = new(Load);
    public static IReadOnlyList<NativeReleaseNote> All => Cache.Value;

    private static IReadOnlyList<NativeReleaseNote> Load()
    {
        var assembly = typeof(NativeReleaseNotes).Assembly;
        var name = assembly.GetManifestResourceNames().FirstOrDefault(item => item.EndsWith(".ReleaseNotes.json", StringComparison.Ordinal));
        if (name == null) return Array.Empty<NativeReleaseNote>();
        using var stream = assembly.GetManifestResourceStream(name);
        return stream == null
            ? Array.Empty<NativeReleaseNote>()
            : JsonSerializer.Deserialize<List<NativeReleaseNote>>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? [];
    }

    public static int CompareVersions(string left, string right)
    {
        var a = left.Split('.').Select(part => int.TryParse(part, out var value) ? value : 0).ToArray();
        var b = right.Split('.').Select(part => int.TryParse(part, out var value) ? value : 0).ToArray();
        for (var index = 0; index < Math.Max(a.Length, b.Length); index++)
        {
            var delta = (index < a.Length ? a[index] : 0) - (index < b.Length ? b[index] : 0);
            if (delta != 0) return Math.Sign(delta);
        }
        return 0;
    }
}
