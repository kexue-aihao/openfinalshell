using Microsoft.Data.Sqlite;
using System.Security.Cryptography;
using System.Text.Json;

namespace OpenFinalShell.Core;

internal sealed record NativeStoreValidation(bool IsValid, string FailureCode, int EntityCount, int SecretCount);
internal sealed record NativeStoreRecoverySnapshot(string Path, DateTimeOffset LastWriteTimeUtc, int EntityCount, int SecretCount);

/// <summary>Read-only validation and explicit, reversible recovery for the local native database.</summary>
internal static class NativeStoreRecovery
{
    private static readonly string[] DatabaseFiles = ["native.db", "native.db-wal", "native.db-shm", "native.db-journal"];

    public static NativeStoreValidation ValidateDirectory(string directory, ISecretProtector protector)
    {
        var database = Path.Combine(directory, "native.db");
        if (File.Exists(database)) return ValidateDatabase(database, protector);

        if (DatabaseFiles.Skip(1).Any(name => File.Exists(Path.Combine(directory, name))))
            return new(false, "orphaned-database-files", 0, 0);

        // A crash between moving the active files during recovery must not be
        // mistaken for a fresh install. The original files remain recoverable.
        if (Directory.Exists(directory) && Directory.EnumerateDirectories(directory, "recovery-original-*")
                .Any(path => File.Exists(Path.Combine(path, "native.db"))))
            return new(false, "interrupted-recovery", 0, 0);

        if (Directory.Exists(directory) && Directory.EnumerateFiles(directory, "before-*.db", SearchOption.TopDirectoryOnly).Any())
            return new(false, "database-missing-with-backups", 0, 0);

        return new(true, string.Empty, 0, 0);
    }

    public static NativeStoreValidation ValidateDatabase(string databasePath, ISecretProtector protector)
    {
        if (!File.Exists(databasePath)) return new(true, string.Empty, 0, 0);
        byte[]? key = null;
        try
        {
            var builder = new SqliteConnectionStringBuilder
            {
                DataSource = Path.GetFullPath(databasePath),
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false
            };
            using var connection = new SqliteConnection(builder.ToString());
            connection.Open();

            using (var check = connection.CreateCommand())
            {
                check.CommandText = "PRAGMA integrity_check";
                using var rows = check.ExecuteReader();
                var foundResult = false;
                while (rows.Read())
                {
                    foundResult = true;
                    if (!string.Equals(rows.GetString(0), "ok", StringComparison.OrdinalIgnoreCase))
                        return new(false, "sqlite-integrity", 0, 0);
                }
                if (!foundResult) return new(false, "sqlite-integrity", 0, 0);
            }

            var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var schema = connection.CreateCommand())
            {
                schema.CommandText = "SELECT name FROM sqlite_master WHERE type='table'";
                using var rows = schema.ExecuteReader();
                while (rows.Read()) tables.Add(rows.GetString(0));
            }
            if (tables.Count == 0) return new(true, string.Empty, 0, 0);
            if (!tables.Contains("meta") || !tables.Contains("entities") || !tables.Contains("secrets"))
                return new(false, "sqlite-schema", 0, 0);

            using (var version = connection.CreateCommand())
            {
                version.CommandText = "PRAGMA user_version";
                if (Convert.ToInt64(version.ExecuteScalar()) > 1) return new(false, "database-version", 0, 0);
            }

            using (var readKey = connection.CreateCommand())
            {
                readKey.CommandText = "SELECT v FROM meta WHERE k='key-v1'";
                if (readKey.ExecuteScalar() is byte[] wrapped) key = protector.Unprotect(wrapped);
            }

            var entityCount = 0;
            var secretCount = 0;
            using (var count = connection.CreateCommand())
            {
                count.CommandText = "SELECT (SELECT COUNT(*) FROM entities), (SELECT COUNT(*) FROM secrets)";
                using var rows = count.ExecuteReader();
                if (!rows.Read()) return new(false, "sqlite-schema", 0, 0);
                entityCount = rows.GetInt32(0);
                secretCount = rows.GetInt32(1);
            }

            if (key == null && (entityCount != 0 || secretCount != 0))
                return new(false, "missing-encryption-key", entityCount, secretCount);
            if (key != null && key.Length != 32)
                return new(false, "invalid-encryption-key", entityCount, secretCount);

            if (key != null)
            {
                using (var entities = connection.CreateCommand())
                {
                    entities.CommandText = "SELECT payload FROM entities";
                    using var rows = entities.ExecuteReader();
                    while (rows.Read())
                        if (!IsValidPayload(key, (byte[])rows[0], secret: false))
                            return new(false, "encrypted-record", entityCount, secretCount);
                }
                using (var secrets = connection.CreateCommand())
                {
                    secrets.CommandText = "SELECT payload FROM secrets";
                    using var rows = secrets.ExecuteReader();
                    while (rows.Read())
                        if (!IsValidPayload(key, (byte[])rows[0], secret: true))
                            return new(false, "encrypted-secret", entityCount, secretCount);
                }
            }

            return new(true, string.Empty, entityCount, secretCount);
        }
        catch (CryptographicException) { return new(false, "protected-data", 0, 0); }
        catch (JsonException) { return new(false, "encrypted-record", 0, 0); }
        catch (SqliteException) { return new(false, "sqlite-read", 0, 0); }
        catch (InvalidCastException) { return new(false, "sqlite-read", 0, 0); }
        catch (FormatException) { return new(false, "sqlite-read", 0, 0); }
        catch (OverflowException) { return new(false, "sqlite-read", 0, 0); }
        catch (InvalidOperationException) { return new(false, "sqlite-read", 0, 0); }
        catch (IOException) { return new(false, "file-read", 0, 0); }
        catch (UnauthorizedAccessException) { return new(false, "access-denied", 0, 0); }
        finally
        {
            if (key != null) CryptographicOperations.ZeroMemory(key);
        }
    }

    public static IReadOnlyList<NativeStoreRecoverySnapshot> FindValidSnapshots(string directory, ISecretProtector protector)
    {
        if (!Directory.Exists(directory)) return [];
        var paths = Directory.EnumerateFiles(directory, "before-*.db", SearchOption.TopDirectoryOnly)
            .Concat(Directory.EnumerateDirectories(directory, "recovery-original-*", SearchOption.TopDirectoryOnly)
                .Select(path => Path.Combine(path, "native.db")))
            .Where(File.Exists)
            .Distinct(StringComparer.OrdinalIgnoreCase);
        var snapshots = new List<NativeStoreRecoverySnapshot>();
        foreach (var path in paths)
        {
            var result = ValidateDatabase(path, protector);
            if (result.IsValid)
                snapshots.Add(new(Path.GetFullPath(path), File.GetLastWriteTimeUtc(path), result.EntityCount, result.SecretCount));
        }
        return snapshots.OrderByDescending(snapshot => snapshot.LastWriteTimeUtc).ToArray();
    }

    public static string? RestoreSnapshot(string directory, string snapshotPath, ISecretProtector protector)
    {
        directory = Path.GetFullPath(directory);
        snapshotPath = Path.GetFullPath(snapshotPath);
        if (!IsWithinDirectory(snapshotPath, directory)) throw new InvalidOperationException("Recovery snapshot is outside the native data directory.");
        if (!ValidateDatabase(snapshotPath, protector).IsValid) throw new InvalidDataException("Recovery snapshot failed validation.");

        Directory.CreateDirectory(directory);
        var stagedPath = Path.Combine(directory, $".native-restore-{Guid.NewGuid():N}.db");
        try
        {
            CopyDatabaseSnapshot(snapshotPath, stagedPath);
            if (!ValidateDatabase(stagedPath, protector).IsValid)
                throw new InvalidDataException("Staged recovery snapshot failed validation.");

            var archive = ArchiveActiveDatabase(directory);
            try
            {
                File.Move(stagedPath, Path.Combine(directory, "native.db"));
                if (!ValidateDatabase(Path.Combine(directory, "native.db"), protector).IsValid)
                    throw new InvalidDataException("Restored database failed validation.");
                return archive;
            }
            catch
            {
                if (archive != null) RestoreArchivedDatabase(directory, archive);
                else _ = ArchiveActiveDatabase(directory);
                throw;
            }
        }
        finally
        {
            TryDelete(stagedPath);
        }
    }

    public static string? StartFreshProfile(string directory, ISecretProtector protector)
    {
        directory = Path.GetFullPath(directory);
        Directory.CreateDirectory(directory);
        var archive = ArchiveActiveDatabase(directory);
        try
        {
            using var store = new NativeStore(directory, protector);
            return archive;
        }
        catch
        {
            if (archive != null) RestoreArchivedDatabase(directory, archive);
            else _ = ArchiveActiveDatabase(directory);
            throw;
        }
    }

    private static bool IsValidPayload(byte[] key, byte[] encrypted, bool secret)
    {
        byte[]? clear = null;
        try
        {
            clear = FieldCipher.Open(key, encrypted);
            using var document = JsonDocument.Parse(clear);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return false;
            return !secret || document.RootElement.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.String;
        }
        catch (CryptographicException) { return false; }
        catch (JsonException) { return false; }
        finally
        {
            if (clear != null) CryptographicOperations.ZeroMemory(clear);
        }
    }

    private static void CopyDatabaseSnapshot(string sourcePath, string destinationPath)
    {
        var sourceBuilder = new SqliteConnectionStringBuilder
        {
            DataSource = sourcePath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false
        };
        using var source = new SqliteConnection(sourceBuilder.ToString());
        source.Open();
        using var destination = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destinationPath, Pooling = false }.ToString());
        destination.Open();
        source.BackupDatabase(destination);
    }

    private static string? ArchiveActiveDatabase(string directory)
    {
        var existing = DatabaseFiles.Select(name => Path.Combine(directory, name)).Where(File.Exists).ToArray();
        if (existing.Length == 0) return null;

        var archive = Path.Combine(directory, $"recovery-original-{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(archive);
        var moved = new List<(string Source, string Destination)>();
        try
        {
            foreach (var source in existing)
            {
                var destination = Path.Combine(archive, Path.GetFileName(source));
                File.Move(source, destination);
                moved.Add((source, destination));
            }
            return archive;
        }
        catch
        {
            foreach (var pair in moved.AsEnumerable().Reverse())
                if (File.Exists(pair.Destination) && !File.Exists(pair.Source)) File.Move(pair.Destination, pair.Source);
            TryDeleteDirectory(archive);
            throw;
        }
    }

    private static void RestoreArchivedDatabase(string directory, string archive)
    {
        _ = ArchiveActiveDatabase(directory); // Preserve any partially restored files before rolling back.
        var moved = new List<(string Source, string Destination)>();
        try
        {
            foreach (var name in DatabaseFiles)
            {
                var source = Path.Combine(archive, name);
                if (!File.Exists(source)) continue;
                var destination = Path.Combine(directory, name);
                File.Move(source, destination);
                moved.Add((source, destination));
            }
        }
        catch
        {
            foreach (var pair in moved.AsEnumerable().Reverse())
                if (File.Exists(pair.Destination) && !File.Exists(pair.Source)) File.Move(pair.Destination, pair.Source);
            throw;
        }
    }

    private static bool IsWithinDirectory(string filePath, string directory)
    {
        var relative = Path.GetRelativePath(directory, filePath);
        return relative != "." && !Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
