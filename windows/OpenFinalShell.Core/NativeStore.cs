using Microsoft.Data.Sqlite;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed class NativeReferenceInUseException(IReadOnlyList<NativeStore.EntityReference> references)
    : InvalidOperationException("A saved reference is still in use.")
{
    public IReadOnlyList<NativeStore.EntityReference> References { get; } = references;
}

public sealed class NativeStore : IDisposable
{
    public sealed record EntityReference(string Kind, string Id, string Name);
    public const string PreviewProduct = "OpenFinalShell.NativePreview";
    public static string DefaultDirectory
    {
        get
        {
            // Acceptance/UI smoke launches use a disposable store so they never
            // touch a developer's preview profile. Production keeps the stable
            // per-user directory unless the explicit test switch is present.
            if (string.Equals(Environment.GetEnvironmentVariable("OFS_NATIVE_TEST_MODE"), "1", StringComparison.Ordinal))
            {
                var testDirectory = Environment.GetEnvironmentVariable("OFS_NATIVE_TEST_DATA_DIR");
                if (string.IsNullOrWhiteSpace(testDirectory))
                    throw new InvalidOperationException("OFS_NATIVE_TEST_DATA_DIR is required when native test mode is enabled.");
                return Path.GetFullPath(testDirectory);
            }

            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), PreviewProduct);
        }
    }
    private readonly object gate = new();
    private readonly SqliteConnection connection;
    private readonly byte[] key;
    public string DatabasePath { get; }

    public NativeStore(string directory, ISecretProtector protector)
    {
        Directory.CreateDirectory(directory);
        DatabasePath = Path.Combine(directory, "native.db");
        connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = DatabasePath, Pooling = false }.ToString());
        connection.Open();
        using (var version = Command("PRAGMA user_version"))
            if (Convert.ToInt64(version.ExecuteScalar()) > 1) { connection.Dispose(); throw new InvalidDataException("native.errors.databaseVersion"); }
        Execute("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v BLOB NOT NULL); CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,payload BLOB NOT NULL);");
        using var tx = connection.BeginTransaction(deferred: false);
        using var read = Command("SELECT v FROM meta WHERE k='key-v1'", tx);
        if (read.ExecuteScalar() is byte[] wrapped) key = protector.Unprotect(wrapped);
        else
        {
            key = RandomNumberGenerator.GetBytes(32);
            using var create = Command("INSERT INTO meta(k,v) VALUES('key-v1',$v)", tx);
            create.Parameters.AddWithValue("$v", protector.Protect(key));
            create.ExecuteNonQuery();
        }
        if (key.Length != 32) throw new CryptographicException("Invalid store key");
        tx.Commit();
        Execute("PRAGMA user_version=1;");
    }
    private SqliteCommand Command(string sql, SqliteTransaction? tx = null)
    {
        var cmd = connection.CreateCommand(); cmd.CommandText = sql; cmd.Transaction = tx; return cmd;
    }
    private void Execute(string sql) { using var cmd = Command(sql); cmd.ExecuteNonQuery(); }
    // Host names and key algorithms are sensitive metadata. Keep their lookup token
    // deterministic for conflict checks, while the display value remains inside the
    // authenticated encrypted payload.
    private static string StorageId(string kind, string id) => kind == "knownHosts"
        ? "h_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant()
        : id;
    private byte[] Seal(JsonObject data)
    {
        var bytes = Encoding.UTF8.GetBytes(data.ToJsonString());
        try { return FieldCipher.Seal(key, bytes); } finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    private JsonObject Open(byte[] cipher)
    {
        var bytes = FieldCipher.Open(key, cipher);
        try { return JsonNode.Parse(bytes)!.AsObject(); } finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    public IReadOnlyList<JsonObject> List(string kind)
    {
        lock (gate)
        {
            using var cmd = Command("SELECT payload,revision FROM entities WHERE kind=$kind ORDER BY rowid");
            cmd.Parameters.AddWithValue("$kind", kind);
            using var rows = cmd.ExecuteReader(); var result = new List<JsonObject>();
            while (rows.Read()) { var value = Open((byte[])rows[0]); value["_revision"] = rows.GetInt64(1); result.Add(value); }
            return result;
        }
    }
    public JsonObject? Find(string kind, string id) => List(kind).FirstOrDefault(v => (v["id"] ?? v["key"])?.GetValue<string>() == id);

    /// <summary>Returns human-readable entities that refer to a saved key/proxy.</summary>
    public IReadOnlyList<EntityReference> FindReferences(string referenceId)
    {
        if (string.IsNullOrWhiteSpace(referenceId)) return [];
        var result = new List<EntityReference>();
        lock (gate)
        {
            using var cmd = Command("SELECT kind,payload FROM entities");
            using var rows = cmd.ExecuteReader();
            while (rows.Read())
            {
                var kind = rows.GetString(0);
                var entity = Open((byte[])rows[1]);
                if (!ContainsReference(entity, referenceId)) continue;
                var id = entity["id"]?.GetValue<string>() ?? entity["key"]?.GetValue<string>() ?? "";
                var name = entity["name"]?.GetValue<string>() ?? id;
                result.Add(new(kind, id, name));
            }
        }
        return result;
    }
    public long Save(string kind, string id, JsonObject value, long? expectedRevision = null)
    {
        lock (gate)
        {
            using var tx = connection.BeginTransaction(deferred: false);
            var revision = Upsert(kind, id, value, tx, expectedRevision); tx.Commit(); return revision;
        }
    }
    private long Upsert(string kind, string id, JsonObject value, SqliteTransaction tx, long? expectedRevision)
    {
        using var check = Command("SELECT revision FROM entities WHERE kind=$k AND id=$id", tx);
        check.Parameters.AddWithValue("$k", kind); check.Parameters.AddWithValue("$id", StorageId(kind, id));
        var old = check.ExecuteScalar(); var revision = old is long number ? number : 0;
        if (expectedRevision.HasValue && expectedRevision.Value != revision) throw new InvalidOperationException("Configuration revision conflict");
        var clean = (JsonObject)value.DeepClone(); clean.Remove("_revision");
        using var cmd = Command("INSERT INTO entities(kind,id,payload,revision) VALUES($k,$id,$p,$r) ON CONFLICT(kind,id) DO UPDATE SET payload=$p,revision=$r", tx);
        cmd.Parameters.AddWithValue("$k", kind); cmd.Parameters.AddWithValue("$id", StorageId(kind, id));
        cmd.Parameters.AddWithValue("$p", Seal(clean)); cmd.Parameters.AddWithValue("$r", revision + 1);
        cmd.ExecuteNonQuery(); return revision + 1;
    }
    private bool Exists(string kind, string id, SqliteTransaction tx)
    {
        using var cmd = Command("SELECT 1 FROM entities WHERE kind=$k AND id=$id", tx);
        cmd.Parameters.AddWithValue("$k", kind); cmd.Parameters.AddWithValue("$id", StorageId(kind, id));
        return cmd.ExecuteScalar() != null;
    }
    public void Delete(string kind, string id, long expectedRevision)
    {
        lock (gate)
        {
            using var cmd = Command("DELETE FROM entities WHERE kind=$k AND id=$id AND revision=$r");
            cmd.Parameters.AddWithValue("$k", kind); cmd.Parameters.AddWithValue("$id", StorageId(kind, id)); cmd.Parameters.AddWithValue("$r", expectedRevision);
            if (cmd.ExecuteNonQuery() != 1) throw new InvalidOperationException("Configuration revision conflict");
        }
    }

    /// <summary>Atomically removes a connection group and detaches its profiles.</summary>
    public void DeleteConnectionGroup(string groupId, long expectedGroupRevision)
    {
        lock (gate)
        {
            using var tx = connection.BeginTransaction(deferred: false);
            using (var check = Command("SELECT revision FROM entities WHERE kind='groups' AND id=$id", tx))
            {
                check.Parameters.AddWithValue("$id", StorageId("groups", groupId));
                if (check.ExecuteScalar() is not long revision || revision != expectedGroupRevision)
                    throw new InvalidOperationException("Configuration revision conflict");
            }

            var profiles = new List<(string Id, JsonObject Data, long Revision)>();
            using (var read = Command("SELECT payload,revision FROM entities WHERE kind='profiles'", tx))
            using (var rows = read.ExecuteReader())
            {
                while (rows.Read())
                {
                    var data = Open((byte[])rows[0]);
                    if (data["groupId"]?.GetValue<string>() != groupId) continue;
                    var id = data["id"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    profiles.Add((id, data, rows.GetInt64(1)));
                }
            }

            foreach (var profile in profiles)
            {
                profile.Data.Remove("groupId");
                Upsert("profiles", profile.Id, profile.Data, tx, profile.Revision);
            }
            using (var delete = Command("DELETE FROM entities WHERE kind='groups' AND id=$id AND revision=$revision", tx))
            {
                delete.Parameters.AddWithValue("$id", StorageId("groups", groupId));
                delete.Parameters.AddWithValue("$revision", expectedGroupRevision);
                if (delete.ExecuteNonQuery() != 1) throw new InvalidOperationException("Configuration revision conflict");
            }
            tx.Commit();
        }
    }

    public void ReorderConnectionGroups(IReadOnlyList<(string Id, double Order, long Revision)> groups)
    {
        lock (gate)
        {
            using var tx = connection.BeginTransaction(deferred: false);
            foreach (var group in groups)
            {
                JsonObject current;
                using (var read = Command("SELECT payload,revision FROM entities WHERE kind='groups' AND id=$id", tx))
                {
                    read.Parameters.AddWithValue("$id", StorageId("groups", group.Id));
                    using var row = read.ExecuteReader();
                    if (!row.Read() || row.GetInt64(1) != group.Revision)
                        throw new InvalidOperationException("Configuration revision conflict");
                    current = Open((byte[])row[0]);
                }
                current["order"] = double.IsFinite(group.Order) ? group.Order : throw new ArgumentException("Invalid group order.");
                Upsert("groups", group.Id, current, tx, group.Revision);
            }
            tx.Commit();
        }
    }
    public string SaveSecret(string secret)
    {
        lock (gate)
        {
            var id = Guid.NewGuid().ToString();
            using var cmd = Command("INSERT INTO secrets(id,payload) VALUES($id,$p)");
            cmd.Parameters.AddWithValue("$id", id); cmd.Parameters.AddWithValue("$p", Seal(new() { ["value"] = secret })); cmd.ExecuteNonQuery(); return id;
        }
    }
    public string? ReadSecret(string? id)
    {
        if (id == null) return null;
        lock (gate)
        {
            using var cmd = Command("SELECT payload FROM secrets WHERE id=$id"); cmd.Parameters.AddWithValue("$id", id);
            return cmd.ExecuteScalar() is byte[] bytes ? Open(bytes)["value"]?.GetValue<string>() : null;
        }
    }
    public void Import(ImportPreview preview, ImportConflict conflict)
    {
        lock (gate)
        {
            // Snapshot encrypted data before committing any migration. Never touch legacy data.
            using (var backup = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = Path.Combine(Path.GetDirectoryName(DatabasePath)!, $"before-import-{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}.db"), Pooling = false }.ToString()))
            { backup.Open(); connection.BackupDatabase(backup); }
            using var tx = connection.BeginTransaction(deferred: false);
            var secretIds = preview.Secrets.ToDictionary(v => v.Key, _ => Guid.NewGuid().ToString());
            var entityIds = new Dictionary<string, string>();
            if (conflict == ImportConflict.Duplicate)
                foreach (var (_, node) in preview.Data)
                    if (node is JsonArray array)
                        foreach (var item in array.OfType<JsonObject>())
                        {
                        var sourceId = item["id"]?.GetValue<string>() ?? item["key"]?.GetValue<string>();
                        if (sourceId is { Length: > 0 }) entityIds[sourceId] = Guid.NewGuid().ToString();
                        }
            foreach (var (id, node) in preview.Secrets)
            {
                using var cmd = Command("INSERT INTO secrets(id,payload) VALUES($id,$p)", tx);
                cmd.Parameters.AddWithValue("$id", secretIds[id]); cmd.Parameters.AddWithValue("$p", Seal(new() { ["value"] = node!.GetValue<string>() })); cmd.ExecuteNonQuery();
            }
            foreach (var (kind, node) in preview.Data)
            {
                if (kind == "settings" && node is JsonObject settings)
                {
                    if (conflict != ImportConflict.Skip || !Exists(kind, "settings", tx))
                    {
                        var clean = Rewrite(settings, entityIds, secretIds); clean["id"] = "settings";
                        Upsert(kind, "settings", clean, tx, null);
                    }
                    continue;
                }
                if (node is not JsonArray array) continue;
                foreach (var original in array.OfType<JsonObject>())
                {
                    var value = Rewrite(original, entityIds, secretIds);
                    var id = (value["id"] ?? value["key"])?.GetValue<string>() ?? throw new InvalidDataException("Missing entity id");
                    if (conflict == ImportConflict.Skip && Exists(kind, id, tx)) continue;
                    Upsert(kind, id, value, tx, null);
                }
            }
            // Skip imports may leave a newly generated secret unreferenced. Remove
            // those rows before commit so repeated imports do not grow a secret
            // graveyard that can never be reached by an entity.
            foreach (var (_, generated) in secretIds)
            {
                var referenced = false;
                {
                    using var rows = Command("SELECT payload FROM entities", tx).ExecuteReader();
                    while (rows.Read() && !referenced)
                    {
                        var entity = Open((byte[])rows[0]);
                        referenced = ContainsReference(entity, generated);
                    }
                }
                if (!referenced)
                {
                    using var remove = Command("DELETE FROM secrets WHERE id=$id", tx);
                    remove.Parameters.AddWithValue("$id", generated); remove.ExecuteNonQuery();
                }
            }
            tx.Commit();
        }
    }
    private static JsonObject Rewrite(JsonObject obj, Dictionary<string, string> entityIds, Dictionary<string, string> secretIds)
    {
        var result = (JsonObject)obj.DeepClone();
        void Visit(JsonNode? node)
        {
            if (node is JsonObject o)
                foreach (var (key, value) in o.ToArray())
                {
                    if (value is JsonValue v && v.TryGetValue<string>(out var text))
                    {
                        if (key.EndsWith("Ref", StringComparison.Ordinal)) o[key] = secretIds.TryGetValue(text, out var secret) ? JsonValue.Create(secret) : null;
                        else if ((key == "id" || key == "key" || key.EndsWith("Id", StringComparison.Ordinal)) && entityIds.TryGetValue(text, out var id)) o[key] = id;
                    }
                    else Visit(value);
                }
            else if (node is JsonArray a) foreach (var value in a) Visit(value);
        }
        Visit(result); return result;
    }
    private static bool ContainsReference(JsonNode? node, string id)
    {
        if (node is JsonObject obj)
            return obj.Any(pair => ((pair.Key.EndsWith("Ref", StringComparison.Ordinal) || pair.Key is "privateKeyId" or "proxyId") && pair.Value is JsonValue value && value.TryGetValue<string>(out var text) && text == id) || ContainsReference(pair.Value, id));
        return node is JsonArray array && array.Any(item => ContainsReference(item, id));
    }
    public void Dispose() { lock (gate) { connection.Dispose(); CryptographicOperations.ZeroMemory(key); } }
}
