using Org.BouncyCastle.Crypto.Generators;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

/** Compatible with Electron/Android v2: scrypt(N=32768,r=8,p=1) + AES-256-GCM. */
public static class ExportEnvelope
{
    public const int MaxBytes = 32 * 1024 * 1024;
    private static readonly HashSet<string> Collections = ["groups", "profiles", "snippetGroups", "snippets", "proxies", "privateKeys", "forwards", "knownHosts", "aiProfiles"];
    public static ImportPreview Inspect(ReadOnlySpan<byte> file, string passphrase)
    {
        if (file.Length > MaxBytes || passphrase.Length is < 1 or > 4096) throw new InvalidDataException("Invalid import size or passphrase");
        var root = JsonNode.Parse(file, documentOptions: new JsonDocumentOptions { MaxDepth = 32 })?.AsObject() ?? throw new InvalidDataException("Invalid envelope");
        if (root["app"]?.GetValue<string>() != "openfinalshell" || root["formatVersion"]?.GetValue<int>() != 2)
            throw new InvalidDataException("Only encrypted v2 exports are accepted");
        var block = root["enc"]?.AsObject() ?? throw new InvalidDataException("Missing encryption block");
        if (block["kdf"]?.GetValue<string>() != "scrypt" || block["n"]?.GetValue<int>() != 32768) throw new InvalidDataException("Invalid KDF parameters");
        byte[] Decode(string name, int? length = null)
        {
            var value = Convert.FromBase64String(block[name]!.GetValue<string>());
            if (length.HasValue && value.Length != length || value.Length > MaxBytes) throw new InvalidDataException("Invalid encrypted field");
            return value;
        }
        var salt = Decode("salt"); if (salt.Length is < 16 or > 64) throw new InvalidDataException("Invalid salt");
        var iv = Decode("iv", 12); var tag = Decode("tag", 16); var cipher = Decode("cipher");
        var password = Encoding.UTF8.GetBytes(passphrase); byte[]? key = null; var plain = new byte[cipher.Length];
        try
        {
            key = SCrypt.Generate(password, salt, 32768, 8, 1, 32);
            using var aes = new AesGcm(key, 16); aes.Decrypt(iv, cipher, tag, plain);
            var payload = JsonNode.Parse(plain, documentOptions: new JsonDocumentOptions { MaxDepth = 32 })!.AsObject();
            var data = payload["data"]?.AsObject() ?? throw new InvalidDataException("Missing export data");
            var secrets = payload["secrets"]?.AsObject() ?? new();
            if (secrets.Count > 10000 || secrets.Any(v => v.Key.Length > 128 || v.Value is not JsonValue j || !j.TryGetValue<string>(out _))) throw new InvalidDataException("Invalid secret map");
            var clean = new JsonObject();
            foreach (var kind in Collections)
            {
                if (data[kind] is not JsonArray array) continue;
                if (array.Count > 10000 || array.Any(v => v is not JsonObject)) throw new InvalidDataException("Invalid collection");
                var ids = new HashSet<string>();
                foreach (var item in array.OfType<JsonObject>())
                {
                    var id = (item["id"] ?? item["key"])?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(id) || id.Length > 512 || !ids.Add(id)) throw new InvalidDataException("Invalid or duplicate entity id");
                    if (kind == "profiles") _ = ConnectionProfile.FromJson(item);
                }
                clean[kind] = array.DeepClone();
            }
            // Imported settings never select executables, environment facts or an update channel.
            if (data["settings"] is JsonObject settings)
            {
                var safe = new JsonObject();
                if (settings["themeMode"]?.GetValue<string>() is "dark" or "light" or "system") safe["themeMode"] = settings["themeMode"]!.DeepClone();
                if (settings["language"] is JsonValue language && language.TryGetValue<string>(out var languageTag) && languageTag.Length <= 32) safe["language"] = languageTag;
                if (settings["reduceTransparency"] is JsonValue transparency && transparency.TryGetValue<bool>(out var reduce)) safe["reduceTransparency"] = reduce;
                clean["settings"] = safe;
            }
            var missing = (clean["privateKeys"] as JsonArray ?? []).OfType<JsonObject>()
                .Select(k => k["path"]?.GetValue<string>() ?? k["name"]?.GetValue<string>() ?? k["id"]!.GetValue<string>())
                .Where(p => !File.Exists(p)).ToArray();
            return new(clean, (JsonObject)secrets.DeepClone(), (clean["profiles"] as JsonArray)?.Count ?? 0, secrets.Count, missing);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(password); CryptographicOperations.ZeroMemory(plain);
            if (key != null) CryptographicOperations.ZeroMemory(key);
        }
    }
    public static byte[] Export(NativeStore store, string passphrase, bool includeSecrets = true)
    {
        if (passphrase.Length is < 1 or > 4096) throw new InvalidDataException("Invalid passphrase");
        var data = new JsonObject(); var secrets = new JsonObject();
        void Collect(JsonNode? node)
        {
            if (node is JsonObject o) foreach (var (key, value) in o)
            {
                if (key.EndsWith("Ref", StringComparison.Ordinal) && key != "materialRef" && value is JsonValue v && v.TryGetValue<string>(out var id))
                { if (store.ReadSecret(id) is { } secret) secrets[id] = secret; }
                else Collect(value);
            }
            else if (node is JsonArray a) foreach (var item in a) Collect(item);
        }
        foreach (var kind in Collections)
        {
            var items = store.List(kind).Select(v => { var copy = (JsonObject)v.DeepClone(); copy.Remove("_revision"); copy.Remove("materialRef"); return (JsonNode)copy; }).ToArray();
            data[kind] = new JsonArray(items);
        }
        if (store.Find("settings", "settings") is { } settings) { settings.Remove("_revision"); settings.Remove("id"); data["settings"] = settings; }
        if (includeSecrets) Collect(data);
        var bytes = Encoding.UTF8.GetBytes(new JsonObject { ["data"] = data, ["secrets"] = secrets }.ToJsonString());
        var password = Encoding.UTF8.GetBytes(passphrase); var salt = RandomNumberGenerator.GetBytes(16);
        var keyBytes = SCrypt.Generate(password, salt, 32768, 8, 1, 32);
        try
        {
            var iv = RandomNumberGenerator.GetBytes(12); var tag = new byte[16]; var cipher = new byte[bytes.Length];
            using var aes = new AesGcm(keyBytes, 16); aes.Encrypt(iv, bytes, cipher, tag);
            return Encoding.UTF8.GetBytes(new JsonObject {
                ["app"] = "openfinalshell", ["formatVersion"] = 2, ["appVersion"] = "native-preview", ["exportedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["includesSecrets"] = true, ["note"] = "Encrypted native preview export",
                ["enc"] = new JsonObject { ["kdf"] = "scrypt", ["n"] = 32768, ["salt"] = Convert.ToBase64String(salt), ["iv"] = Convert.ToBase64String(iv), ["tag"] = Convert.ToBase64String(tag), ["cipher"] = Convert.ToBase64String(cipher) }
            }.ToJsonString());
        }
        finally { CryptographicOperations.ZeroMemory(keyBytes); CryptographicOperations.ZeroMemory(password); CryptographicOperations.ZeroMemory(bytes); }
    }
}
