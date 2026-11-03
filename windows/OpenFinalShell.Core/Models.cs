using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record ConnectionProfile(string Id, string Name, string Host, int Port, string Username, JsonObject Data)
{
    public static ConnectionProfile FromJson(JsonObject data)
    {
        string Required(string key, int max) => data[key]?.GetValue<string>() is { Length: > 0 } value && value.Length <= max
            ? value : throw new InvalidDataException($"Invalid profile {key}");
        var port = data["port"]?.GetValue<int>() ?? 22;
        if (port is < 1 or > 65535) throw new InvalidDataException("Invalid port");
        var username = data["username"]?.GetValue<string>() ?? "";
        if (username.Length > 120 || (username.Length == 0 && data["protocol"]?.GetValue<string>() != "rdp"))
            throw new InvalidDataException("Invalid profile username");
        if (data["auth"]?["method"]?.GetValue<string>() is not ("password" or "privateKey" or "agent"))
            throw new InvalidDataException("Invalid authentication method");
        return new(Required("id", 200), Required("name", 120), Required("host", 255), port, username, (JsonObject)data.DeepClone());
    }
    public override string ToString() => Name;
}

public sealed record ConnectionGroup(string Id, string Name, double Order, long Revision)
{
    public static ConnectionGroup FromJson(JsonObject data)
    {
        var id = data["id"]?.GetValue<string>()?.Trim();
        var name = data["name"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(id) || id.Length > 200 || string.IsNullOrWhiteSpace(name) || name.Length > 120)
            throw new InvalidDataException("Invalid connection group.");
        var order = data["order"] is JsonValue orderValue
            ? orderValue.TryGetValue<double>(out var decimalOrder)
                ? decimalOrder
                : orderValue.TryGetValue<long>(out var integerOrder) ? integerOrder : 0
            : 0;
        var revision = data["_revision"] is JsonValue revisionValue
            ? revisionValue.TryGetValue<long>(out var longRevision)
                ? longRevision
                : revisionValue.TryGetValue<int>(out var intRevision) ? intRevision : 0
            : 0;
        return new(id, name, order, revision);
    }

    public JsonObject ToJson() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["order"] = Order
    };
}

public enum NativeRemoteEntryType { File, Directory, Symlink, Other }

public sealed record RemoteEntry(
    string Name,
    string Path,
    long Size,
    bool IsDirectory,
    DateTime Modified,
    NativeRemoteEntryType Type = NativeRemoteEntryType.File,
    int Mode = 0,
    int OwnerId = 0,
    int GroupId = 0,
    bool IsSymbolicLink = false);

public sealed record NativeDeletePreview(
    string Path,
    long Entries,
    long Files,
    long Bytes,
    bool ContainsSymlink,
    bool Truncated);

public sealed record NativeRemoteFileView(
    string RequestedPath,
    string ResolvedPath,
    string Text,
    NativeTextEncoding Encoding,
    string NewLine,
    bool HasBom,
    bool Lossless,
    long Bytes,
    int Mode,
    DateTime Modified);

public enum NativeRemoteSaveKind { Saved, Conflict, NonAtomic, Shrink }

public sealed record NativeRemoteSaveResult(
    NativeRemoteSaveKind Kind,
    long Bytes,
    int Mode,
    string? Message = null);

public sealed record HostKeyChallenge(string Host, int Port, string Algorithm, string Fingerprint, bool Changed);
public sealed record ImportPreview(JsonObject Data, JsonObject Secrets, int Profiles, int SecretCount, IReadOnlyList<string> MissingPrivateKeys);
public enum ImportConflict { Skip, Overwrite, Duplicate }
