using Microsoft.Data.Sqlite;
using OpenFinalShell.Core;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core.Tests;

internal static class NativeStoreRecoveryTests
{
    public static void Run(string root, Action<bool, string> check)
    {
        var directory = Path.Combine(root, "recovery-" + Guid.NewGuid().ToString("N"));
        var protector = new RecoveryTestProtector();
        string snapshot;
        string expectedSecret = "recovery-secret-🔐";
        using (var store = new NativeStore(directory, protector))
        {
            var secret = store.SaveSecret(expectedSecret);
            store.Save("profiles", "recovery-profile", new JsonObject
            {
                ["id"] = "recovery-profile",
                ["name"] = "Recovery fixture",
                ["auth"] = new JsonObject { ["passwordRef"] = secret }
            });
            NativeSettings.Update(store, new() { ["language"] = "zh-CN", ["themeMode"] = "dark" });
            snapshot = store.Backup("recovery-test");
        }

        var intactDatabaseHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(directory, "native.db"))));
        check(NativeStoreRecovery.ValidateDirectory(directory, protector).IsValid,
            "Recovery preflight validates intact entities and encrypted credentials");
        check(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(directory, "native.db")))) == intactDatabaseHash,
            "Read-only recovery preflight leaves the active database unchanged");
        check(NativeStoreRecovery.ValidateDatabase(snapshot, protector) is { IsValid: true, EntityCount: 2, SecretCount: 1 },
            "SQLite backup snapshot is integrity checked and all encrypted payloads decrypt");
        check(!NativeStoreRecovery.ValidateDatabase(snapshot, new RejectingProtector()).IsValid
            && NativeStoreRecovery.FindValidSnapshots(directory, new RejectingProtector()).Count == 0,
            "Recovery rejects backups whose protected store key cannot be decrypted");

        var backupOnlyDirectory = Path.Combine(root, "recovery-backup-only-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(backupOnlyDirectory);
        File.Copy(snapshot, Path.Combine(backupOnlyDirectory, "before-retained.db"));
        check(NativeStoreRecovery.ValidateDirectory(backupOnlyDirectory, protector).FailureCode == "database-missing-with-backups",
            "Missing active database with a valid backup opens recovery instead of silently initializing blank data");
        NativeStoreRecovery.RestoreSnapshot(backupOnlyDirectory, Path.Combine(backupOnlyDirectory, "before-retained.db"), protector);
        check(NativeStoreRecovery.ValidateDirectory(backupOnlyDirectory, protector).IsValid,
            "A verified backup restores successfully when the active database is missing");

        var malformedPayloadSnapshot = Path.Combine(directory, "malformed-payload.db");
        File.Copy(snapshot, malformedPayloadSnapshot);
        using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = malformedPayloadSnapshot, Pooling = false }.ToString()))
        {
            connection.Open();
            using var malformed = connection.CreateCommand();
            malformed.CommandText = "UPDATE entities SET payload='not-a-blob' WHERE kind='profiles'";
            malformed.ExecuteNonQuery();
        }
        check(!NativeStoreRecovery.ValidateDatabase(malformedPayloadSnapshot, protector).IsValid,
            "Recovery routes structurally malformed payloads to the recovery flow instead of crashing startup");

        using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(directory, "native.db"), Pooling = false }.ToString()))
        {
            connection.Open();
            using var corrupt = connection.CreateCommand();
            corrupt.CommandText = "UPDATE entities SET payload=randomblob(length(payload)) WHERE kind='profiles'";
            corrupt.ExecuteNonQuery();
        }
        check(!NativeStoreRecovery.ValidateDirectory(directory, protector).IsValid,
            "Authentication tag failure is detected before loading the shell");
        var damagedDatabaseHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(directory, "native.db"))));
        File.WriteAllBytes(Path.Combine(directory, "before-invalid.db"), [1, 2, 3, 4]);
        check(NativeStoreRecovery.FindValidSnapshots(directory, protector).Single().Path == Path.GetFullPath(snapshot),
            "Recovery lists only snapshots whose database, entities and credentials validate");

        var failedRestorePreservedSource = false;
        try { NativeStoreRecovery.RestoreSnapshot(directory, snapshot, new FailOnThirdUnprotectProtector(protector)); }
        catch (InvalidDataException) { failedRestorePreservedSource = true; }
        check(failedRestorePreservedSource
            && Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(directory, "native.db")))) == damagedDatabaseHash
            && File.Exists(snapshot),
            "A failed restore rolls back to the original database and retains the selected snapshot");

        var archive = NativeStoreRecovery.RestoreSnapshot(directory, snapshot, protector);
        check(archive != null && File.Exists(Path.Combine(archive, "native.db")),
            "Restoring a snapshot retains the previous database as an immutable recovery archive");
        check(NativeStoreRecovery.ValidateDirectory(directory, protector).IsValid
            && !NativeStoreRecovery.ValidateDatabase(Path.Combine(archive!, "native.db"), protector).IsValid,
            "Restored snapshot opens while the damaged source remains preserved");
        using (var restored = new NativeStore(directory, protector))
        {
            var profile = restored.Find("profiles", "recovery-profile");
            var secretId = profile?["auth"]?["passwordRef"]?.GetValue<string>();
            check(profile != null && restored.ReadSecret(secretId) == expectedSecret
                && NativeSettings.Load(restored).Language == "zh-CN",
                "Snapshot restore recovers settings, profile and its encrypted secret");
        }

        var freshDirectory = Path.Combine(root, "recovery-fresh-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(freshDirectory);
        File.WriteAllBytes(Path.Combine(freshDirectory, "native.db-wal"), [5, 4, 3]);
        check(NativeStoreRecovery.ValidateDirectory(freshDirectory, protector).FailureCode == "orphaned-database-files",
            "Orphaned SQLite sidecars trigger recovery instead of silently starting an empty store");
        File.Delete(Path.Combine(freshDirectory, "native.db-wal"));
        string originalHash;
        using (var store = new NativeStore(freshDirectory, protector))
        {
            store.Save("profiles", "kept-profile", new JsonObject { ["id"] = "kept-profile", ["name"] = "Kept" });
        }
        // NativeStore keeps a pooled SQLite connection alive until disposal;
        // read the database only after the connection has been closed.
        originalHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(freshDirectory, "native.db"))));
        var oldShm = Path.Combine(freshDirectory, "native.db-shm");
        File.WriteAllBytes(oldShm, [9, 8, 7]);
        var freshArchive = NativeStoreRecovery.StartFreshProfile(freshDirectory, protector);
        check(freshArchive != null && File.Exists(Path.Combine(freshArchive, "native.db-shm"))
            && Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(freshArchive, "native.db")))) == originalHash,
            "Starting an empty profile archives the original database and SQLite sidecars without deleting them");
        check(NativeStoreRecovery.ValidateDirectory(freshDirectory, protector).IsValid,
            "New empty recovery profile is initialized and validates successfully");
        using (var fresh = new NativeStore(freshDirectory, protector))
            check(fresh.List("profiles").Count == 0, "Fresh profile starts empty without importing damaged records");
    }

    private sealed class RecoveryTestProtector : ISecretProtector
    {
        private static readonly byte[] Key = SHA256.HashData("recovery-test-protector"u8);
        public byte[] Protect(byte[] value) => value.Select((item, index) => (byte)(item ^ Key[index % Key.Length])).ToArray();
        public byte[] Unprotect(byte[] value) => Protect(value);
    }

    private sealed class RejectingProtector : ISecretProtector
    {
        public byte[] Protect(byte[] value) => throw new CryptographicException("Test protector cannot protect this profile.");
        public byte[] Unprotect(byte[] value) => throw new CryptographicException("Test protector cannot decrypt this profile.");
    }

    private sealed class FailOnThirdUnprotectProtector(ISecretProtector inner) : ISecretProtector
    {
        private int attempts;
        public byte[] Protect(byte[] value) => inner.Protect(value);
        public byte[] Unprotect(byte[] value)
            => Interlocked.Increment(ref attempts) == 3
                ? throw new CryptographicException("Simulated verification failure after replacement.")
                : inner.Unprotect(value);
    }
}
