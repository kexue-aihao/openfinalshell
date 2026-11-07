using OpenFinalShell.Core;
using Org.BouncyCastle.Crypto.Generators;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core.Tests;

public static class NativeLegacyExportTests
{
    private const string Passphrase = "迁移-passphrase-🔐";

    public static void Run(string root, Action<bool, string> check, Action<Action, string> reject)
    {
        var v2Envelope = File.ReadAllBytes(Path.Combine(root, "legacy-export.json"));
        check(ExportEnvelope.RequiresPassphrase(v2Envelope), "Electron v2 whole-file exports are identified as passphrase-protected");
        var noSecrets = Envelope(new JsonObject
        {
            ["groups"] = new JsonArray(new JsonObject { ["id"] = "group-v1", ["name"] = "Legacy group", ["parentId"] = null, ["order"] = 2 }),
            ["profiles"] = new JsonArray(new JsonObject
            {
                ["id"] = "profile-v1", ["name"] = "Legacy connection", ["host"] = "example.test", ["port"] = 22,
                ["username"] = "tester", ["groupId"] = "group-v1", ["auth"] = new JsonObject { ["method"] = "password" }
            })
        }, null, false);
        check(!ExportEnvelope.RequiresPassphrase(noSecrets), "Electron v1 export without credentials does not require a passphrase");
        var plainPreview = ExportEnvelope.Inspect(noSecrets);
        check(plainPreview.Profiles == 1 && plainPreview.Data["groups"] is JsonArray { Count: 1 }, "Electron v1 plaintext configuration imports without a passphrase");

        const string secretRef = "electron-secret-ref";
        var withSecrets = Envelope(new JsonObject
        {
            ["groups"] = new JsonArray(),
            ["profiles"] = new JsonArray(new JsonObject
            {
                ["id"] = "secret-profile", ["name"] = "Secret connection", ["host"] = "example.test", ["port"] = 22,
                ["username"] = "tester", ["groupId"] = null,
                ["auth"] = new JsonObject { ["method"] = "password", ["passwordRef"] = secretRef }
            })
        }, new JsonObject { [secretRef] = "test-only-password" }, true);
        check(ExportEnvelope.RequiresPassphrase(withSecrets), "Electron v1 credentials are identified as passphrase-protected");
        reject(() => ExportEnvelope.Inspect(withSecrets), "Electron v1 credentials cannot be imported without their passphrase");
        reject(() => ExportEnvelope.Inspect(withSecrets, "wrong-passphrase"), "Electron v1 rejects a wrong credentials passphrase");
        var protectedPreview = ExportEnvelope.Inspect(withSecrets, Passphrase);
        check(protectedPreview.Profiles == 1 && protectedPreview.SecretCount == 1
            && protectedPreview.Secrets[secretRef]?.GetValue<string>() == "test-only-password",
            "Electron v1 decrypts the credential map and retains its original references in preview");
        var lowCostSecret = Envelope(new JsonObject { ["profiles"] = new JsonArray() }, new JsonObject { [secretRef] = "legacy-secret" }, true, 1 << 12);
        check(ExportEnvelope.Inspect(lowCostSecret, Passphrase).SecretCount == 1,
            "Electron v1 accepts bounded legacy scrypt work factors supported by its import schema");
        var omittedCredentials = Envelope((JsonObject)JsonNode.Parse(Encoding.UTF8.GetString(withSecrets))!["data"]!.DeepClone(), new JsonObject { [secretRef] = "ignored" }, false);
        check(!ExportEnvelope.RequiresPassphrase(omittedCredentials) && ExportEnvelope.Inspect(omittedCredentials).SecretCount == 0,
            "Electron v1 honors includesSecrets=false and does not import an unadvertised credential block");

        var storePath = Path.Combine(root, "legacy-export-import-" + Guid.NewGuid().ToString("N"));
        using (var store = new NativeStore(storePath, new TestProtector()))
        {
            var result = store.Import(protectedPreview, ImportConflict.Skip);
            var imported = store.Find("profiles", "secret-profile")!;
            var importedRef = imported["auth"]?["passwordRef"]?.GetValue<string>();
            check(result.Profiles == 1 && result.Secrets == 1 && importedRef != secretRef
                && store.ReadSecret(importedRef) == "test-only-password",
                "Electron v1 credentials are rekeyed into the native protected store on transactional import");
        }

        var malformed = JsonNode.Parse(Encoding.UTF8.GetString(withSecrets))!.AsObject();
        malformed["secrets"]!["n"] = 1 << 20;
        reject(() => ExportEnvelope.Inspect(Encoding.UTF8.GetBytes(malformed.ToJsonString()), Passphrase), "Electron v1 rejects unsafe KDF parameters before decryption");
        reject(() => ExportEnvelope.Inspect(Encoding.UTF8.GetBytes("{\"app\":\"openfinalshell\",\"formatVersion\":3}")), "Unknown newer export formats are rejected");
    }

    private static byte[] Envelope(JsonObject data, JsonObject? secretMap, bool includesSecrets, int workFactor = 32768)
    {
        var root = new JsonObject
        {
            ["app"] = "openfinalshell", ["formatVersion"] = 1, ["appVersion"] = "0.30.34",
            ["exportedAt"] = 1794000000000L, ["includesSecrets"] = includesSecrets,
            ["note"] = "Electron v1 contract fixture", ["data"] = data
        };
        if (secretMap is not null) root["secrets"] = Seal(secretMap.ToJsonString(), Passphrase, workFactor);
        return Encoding.UTF8.GetBytes(root.ToJsonString());
    }

    private static JsonObject Seal(string plaintext, string passphrase, int workFactor)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var iv = RandomNumberGenerator.GetBytes(12);
        var password = Encoding.UTF8.GetBytes(passphrase);
        var plain = Encoding.UTF8.GetBytes(plaintext);
        var key = SCrypt.Generate(password, salt, workFactor, 8, 1, 32);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        try
        {
            using (var aes = new AesGcm(key, 16)) aes.Encrypt(iv, plain, cipher, tag);
            return new JsonObject
            {
                ["kdf"] = "scrypt", ["n"] = workFactor, ["salt"] = Convert.ToBase64String(salt),
                ["iv"] = Convert.ToBase64String(iv), ["tag"] = Convert.ToBase64String(tag),
                ["cipher"] = Convert.ToBase64String(cipher)
            };
        }
        finally
        {
            CryptographicOperations.ZeroMemory(password);
            CryptographicOperations.ZeroMemory(plain);
            CryptographicOperations.ZeroMemory(key);
        }
    }

    private sealed class TestProtector : ISecretProtector
    {
        public byte[] Protect(byte[] value) => value.ToArray();
        public byte[] Unprotect(byte[] value) => value.ToArray();
    }
}
