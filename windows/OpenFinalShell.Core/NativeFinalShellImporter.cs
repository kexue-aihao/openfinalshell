using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record NativeFinalShellSample(string Name, string Host, int Port, string Username);
public sealed record NativeFinalShellCounts(int Profiles, int Groups, int Invalid, int NotSsh, int LockedPasswords);
public sealed record NativeFinalShellScan(string Token, string Directory, NativeFinalShellCounts Counts,
    IReadOnlyList<NativeFinalShellSample> Samples, IReadOnlyList<string> Notes);
public sealed record NativeFinalShellImportResult(int Profiles, int Groups, int Skipped, int Invalid, int Secrets, IReadOnlyList<string> Notes);

/// <summary>Scans FinalShell JSON without attempting to decrypt its private password format.</summary>
public sealed class NativeFinalShellImporter
{
    private const int MaxFiles = 5000;
    private const long MaxFileBytes = 1024 * 1024;
    private const long MaxTotalBytes = 64 * 1024 * 1024;
    private const int SshConnectionType = 100;
    private readonly object gate = new();
    private Pending? pending;
    private bool applying;

    private sealed record SourceRecord(string Id, string Name, string? ParentId, string? Host, int? Port,
        string? Username, string Charset, string? UnknownCharset, string? Note, long CreatedAt, long UpdatedAt,
        long? LastUsedAt, bool LockedPassword, bool HasProxy, bool UsesKey, int Forwards, bool IsSsh);
    private sealed record Pending(string Token, string Directory, IReadOnlyList<SourceRecord> Groups,
        IReadOnlyList<SourceRecord> Profiles, int Invalid, int NotSsh, IReadOnlySet<string> UnknownCharsets);

    public async Task<NativeFinalShellScan> ScanAsync(string directory, Localization localization, CancellationToken cancellation = default)
    {
        var fullDirectory = Path.GetFullPath(directory);
        if (!Directory.Exists(fullDirectory)) throw new DirectoryNotFoundException(fullDirectory);
        var records = new List<JsonNode?>();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var fileCount = 0;
        long totalBytes = 0;
        foreach (var root in new[] { fullDirectory, Path.Combine(fullDirectory, "conn") })
        {
            string[] files;
            try { files = Directory.GetFiles(root, "*.json", SearchOption.TopDirectoryOnly); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or DirectoryNotFoundException) { continue; }
            foreach (var path in files)
            {
                cancellation.ThrowIfCancellationRequested();
                if (fileCount >= MaxFiles) break;
                string canonical;
                try { canonical = Path.GetFullPath(path); }
                catch { continue; }
                if (!visited.Add(canonical)) continue;
                try
                {
                    if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) continue;
                    var length = new FileInfo(path).Length;
                    if (length > MaxFileBytes || totalBytes + length > MaxTotalBytes) continue;
                    fileCount++; totalBytes += length;
                    var json = await File.ReadAllTextAsync(path, cancellation).ConfigureAwait(false);
                    var parsed = JsonNode.Parse(json);
                    if (parsed is JsonArray array) records.AddRange(array.Select(item => item?.DeepClone()));
                    else records.Add(parsed?.DeepClone());
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { }
            }
        }
        if (fileCount == 0) throw new InvalidDataException(localization["err.data.noJsonFiles"]);

        var groups = new List<SourceRecord>();
        var profiles = new List<SourceRecord>();
        var unknownCharsets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var invalid = 0; var notSsh = 0;
        var groupIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in records)
        {
            cancellation.ThrowIfCancellationRequested();
            if (Parse(raw) is not { } record) { invalid++; continue; }
            if (record.UnknownCharset is { } unknown) unknownCharsets.Add(unknown);
            if (record.Host == null && record.Port == null)
            {
                if (!groupIds.Add(record.Id)) { invalid++; continue; }
                groups.Add(record);
                continue;
            }
            if (record.Host == null || record.Port == null) { invalid++; continue; }
            if (!record.IsSsh) { notSsh++; continue; }
            profiles.Add(record);
        }
        if (profiles.Count == 0)
            throw new InvalidDataException(localization.Format("err.data.noSshConnections",
                ("files", fileCount.ToString()), ("invalid", invalid.ToString()), ("notSsh", notSsh.ToString())));

        var locked = profiles.Count(record => record.LockedPassword);
        var notes = new List<string>();
        if (locked > 0) notes.Add(localization.Format("err.data.finalshellLockedPasswords", ("count", locked.ToString())));
        var withKeys = profiles.Count(record => record.UsesKey);
        if (withKeys > 0) notes.Add(localization.Format("err.data.finalshellKeyAuth", ("count", withKeys.ToString())));
        var withProxy = profiles.Count(record => record.HasProxy);
        if (withProxy > 0) notes.Add(localization.Format("err.data.finalshellProxy", ("count", withProxy.ToString())));
        var forwards = profiles.Sum(record => record.Forwards);
        if (forwards > 0) notes.Add(localization.Format("err.data.finalshellForwards", ("count", forwards.ToString())));
        if (unknownCharsets.Count > 0) notes.Add(localization.Format("err.data.unknownCharsets", ("list", string.Join(", ", unknownCharsets.OrderBy(value => value, StringComparer.OrdinalIgnoreCase)))));

        var token = Guid.NewGuid().ToString("N");
        lock (gate)
        {
            if (applying) throw new InvalidOperationException("A FinalShell import is already in progress.");
            pending = new(token, fullDirectory, groups.ToArray(), profiles.ToArray(), invalid, notSsh, unknownCharsets);
        }
        return new(token, fullDirectory,
            new(profiles.Count, groups.Count, invalid, notSsh, locked),
            profiles.Take(8).Select(record => new NativeFinalShellSample(record.Name, record.Host!, record.Port!.Value, record.Username ?? "root")).ToArray(),
            notes);
    }

    public NativeFinalShellImportResult Apply(NativeStore store, string token, bool duplicate, Localization localization)
    {
        Pending snapshot;
        lock (gate)
        {
            if (pending == null || !string.Equals(pending.Token, token, StringComparison.Ordinal))
                throw new InvalidOperationException(localization["err.data.importSessionExpiredDir"]);
            if (applying) throw new InvalidOperationException(localization["err.data.importInProgress"]);
            applying = true; snapshot = pending;
        }

        try
        {
            var resultNotes = new List<string>();
            var groupIds = snapshot.Groups.ToDictionary(record => record.Id, _ => Guid.NewGuid().ToString("N"), StringComparer.Ordinal);
            var groupParents = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var group in snapshot.Groups)
            {
                var parent = group.ParentId;
                if (parent != null && !groupIds.ContainsKey(parent)) parent = null;
                groupParents[group.Id] = parent;
            }
            var orphanCount = 0;
            foreach (var group in snapshot.Groups)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal) { group.Id };
                var cursor = groupParents[group.Id];
                while (cursor != null)
                {
                    if (!seen.Add(cursor))
                    {
                        groupParents[group.Id] = null; orphanCount++; break;
                    }
                    cursor = groupParents.TryGetValue(cursor, out var next) ? next : null;
                }
                if (group.ParentId != null && !groupIds.ContainsKey(group.ParentId)) orphanCount++;
            }

            var importGroups = new JsonArray();
            foreach (var group in snapshot.Groups)
                importGroups.Add(new JsonObject
                {
                    ["id"] = groupIds[group.Id], ["name"] = group.Name,
                    ["parentId"] = groupParents[group.Id] is { } parent ? groupIds[parent] : null,
                    ["order"] = group.UpdatedAt
                });

            var existingTargets = store.List("profiles");
            var importProfiles = new JsonArray();
            var skipped = 0;
            foreach (var source in snapshot.Profiles)
            {
                var host = source.Host!; var port = source.Port!.Value; var username = source.Username ?? "root";
                if (!duplicate && existingTargets.Any(item =>
                    string.Equals(ReadString(item, "host"), host, StringComparison.OrdinalIgnoreCase)
                    && ReadInt(item, "port") == port
                    && string.Equals(ReadString(item, "username"), username, StringComparison.Ordinal)))
                { skipped++; continue; }
                string? groupId = null;
                if (source.ParentId != null && groupIds.TryGetValue(source.ParentId, out var mappedGroup)) groupId = mappedGroup;
                else if (source.ParentId != null) orphanCount++;
                importProfiles.Add(new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"), ["name"] = source.Name, ["protocol"] = "ssh",
                    ["groupId"] = groupId, ["host"] = host, ["port"] = port, ["username"] = username,
                    ["auth"] = new JsonObject { ["method"] = "password" },
                    ["terminal"] = new JsonObject { ["charset"] = source.Charset, ["termType"] = "xterm-256color" },
                    ["options"] = new JsonObject { ["keepaliveInterval"] = 15000, ["readyTimeout"] = 20000,
                        ["legacyAlgorithms"] = false, ["autoReconnect"] = true, ["monitorEnabled"] = true, ["compress"] = false },
                    ["proxyMode"] = "direct", ["note"] = source.Note,
                    ["createdAt"] = source.CreatedAt, ["updatedAt"] = source.UpdatedAt, ["lastUsedAt"] = source.LastUsedAt
                });
            }

            var data = new JsonObject { ["groups"] = importGroups, ["profiles"] = importProfiles };
            store.Import(new(data, new JsonObject(), importProfiles.Count, 0, []), duplicate ? ImportConflict.Duplicate : ImportConflict.Skip);
            if (orphanCount > 0) resultNotes.Add(localization.Format("err.data.orphanGroups", ("count", orphanCount.ToString())));
            if (snapshot.Profiles.Any(record => record.LockedPassword)) resultNotes.Add(localization["err.data.finalshellLockedPasswordsResult"]);
            if (snapshot.NotSsh > 0) resultNotes.Add(localization.Format("err.data.skippedNonSsh", ("count", snapshot.NotSsh.ToString())));
            return new(importProfiles.Count, importGroups.Count, skipped, snapshot.Invalid, 0, resultNotes);
        }
        finally
        {
            lock (gate) { pending = null; applying = false; }
        }
    }

    public void Cancel(string token)
    {
        lock (gate) if (!applying && pending?.Token == token) pending = null;
    }

    private static SourceRecord? Parse(JsonNode? node)
    {
        if (node is not JsonObject value) return null;
        var id = ReadString(value, "id"); var name = ReadString(value, "name");
        if (string.IsNullOrWhiteSpace(id) || id.Length > 200 || string.IsNullOrWhiteSpace(name) || name.Length > 120) return null;
        var host = ReadString(value, "host");
        var portNumber = ReadNumber(value["port"]);
        int? port = portNumber is >= 1 and <= 65535 && portNumber == Math.Truncate(portNumber.Value) ? (int)portNumber.Value : null;
        var hintsConnection = host != null || value["port"] != null;
        if (hintsConnection && (host == null || host.Length > 255 || port == null)) return null;
        var username = ReadString(value, "user_name") ?? ReadString(value, "userName");
        if (username?.Length > 120) return null;
        var charset = MapCharset(ReadString(value, "terminal_encoding"));
        var type = ReadNumber(value["conection_type"]) ?? ReadNumber(value["connection_type"]);
        var forwards = (value["port_forwarding_list"] as JsonArray)?.Count ?? 0;
        if (value["remote_port_forwarding"] is JsonObject remote) forwards += remote.Count;
        return new(id, name, ReadString(value, "parent_id"), host, port, username, charset.Charset, charset.Unknown,
            ReadString(value, "description"), ReadNumber(value["create_time"]) is { } created ? ToUnixMilliseconds(created) : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ReadNumber(value["modified_time"]) is { } updated ? ToUnixMilliseconds(updated) : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ReadNumber(value["access_time"]) is { } last ? ToUnixMilliseconds(last) : null,
            LooksLikeSecret(ReadString(value, "password")), ReadString(value, "proxy_id") != null,
            ReadString(value, "secret_key_id") != null, forwards, host != null && port != null && (type == null || type == SshConnectionType));
    }

    private static (string Charset, string? Unknown) MapCharset(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return ("utf-8", null);
        var key = value.ToLowerInvariant().Replace(" ", "").Replace("_", "");
        var mapped = key switch
        {
            "utf-8" or "utf8" => "utf-8", "gbk" or "gb2312" => "gbk", "gb18030" => "gb18030",
            "big5" => "big5", "iso-8859-1" or "iso88591" or "latin1" => "latin1", _ => null
        };
        return mapped == null ? ("utf-8", value) : (mapped, null);
    }

    private static bool LooksLikeSecret(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        try
        {
            var bytes = Convert.FromBase64String(value);
            return bytes.Length >= 16 && bytes.Length % 8 == 0
                && Convert.ToBase64String(bytes).TrimEnd('=') == value.TrimEnd('=');
        }
        catch (FormatException) { return false; }
    }

    private static long ToUnixMilliseconds(double value)
    {
        if (!double.IsFinite(value)) return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return (long)Math.Clamp(Math.Truncate(value), 0, 253402300799999);
    }

    private static string? ReadString(JsonObject value, string key) => value[key] is JsonValue node && node.TryGetValue<string>(out var text)
        && !string.IsNullOrWhiteSpace(text) ? text.Trim() : null;
    private static int? ReadInt(JsonObject value, string key) => ReadNumber(value[key]) is { } number && number == Math.Truncate(number) && number is >= 1 and <= 65535 ? (int)number : null;
    private static double? ReadNumber(JsonNode? node)
    {
        if (node is not JsonValue value || value.GetValueKind() != JsonValueKind.Number) return null;
        try { var number = JsonSerializer.Deserialize<double>(value.ToJsonString()); return double.IsFinite(number) ? number : null; }
        catch (JsonException) { return null; }
    }
}
