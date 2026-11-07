using System.Text.Json.Nodes;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeFinalShellImporterTests
{
    public static void Run(string root, Action<bool, string> check, Action<Action, string> reject)
    {
        var directory = Path.Combine(root, "finalshell-fixture-" + Guid.NewGuid().ToString("N"));
        var conn = Path.Combine(directory, "conn");
        Directory.CreateDirectory(conn);
        var data = new JsonArray
        {
            new JsonObject { ["id"] = "group-parent", ["name"] = "Operations", ["create_time"] = 1, ["modified_time"] = 1 },
            new JsonObject { ["id"] = "group-child", ["name"] = "Production", ["parent_id"] = "group-parent", ["create_time"] = 2, ["modified_time"] = 2 },
            new JsonObject { ["id"] = "conflict", ["name"] = "Existing", ["host"] = "192.0.2.1", ["port"] = 22, ["user_name"] = "root", ["parent_id"] = "group-child", ["terminal_encoding"] = "GBK", ["password"] = Convert.ToBase64String(new byte[16]), ["proxy_id"] = "proxy", ["secret_key_id"] = "key", ["port_forwarding_list"] = new JsonArray(new JsonObject()), ["remote_port_forwarding"] = new JsonObject { ["x"] = "y" } },
            new JsonObject { ["id"] = "new-host", ["name"] = "Fixture SSH", ["host"] = "198.51.100.4", ["port"] = 2222, ["user_name"] = "deploy", ["parent_id"] = "group-child", ["terminal_encoding"] = "UTF-8", ["description"] = "fixture note" },
            new JsonObject { ["id"] = "not-ssh", ["name"] = "RDP", ["host"] = "192.0.2.5", ["port"] = 3389, ["conection_type"] = 200 },
            new JsonObject { ["host"] = "invalid" }
        };
        File.WriteAllText(Path.Combine(conn, "connections.json"), data.ToJsonString());
        var localization = new Localization(); localization.SetLanguage("en-US");
        var importer = new NativeFinalShellImporter();
        var scan = importer.ScanAsync(directory, localization).GetAwaiter().GetResult();
        check(scan.Counts is { Profiles: 2, Groups: 2, Invalid: 1, NotSsh: 1, LockedPasswords: 1 }
            && scan.Samples.Count == 2 && scan.Samples[0].Username == "root"
            && scan.Notes.Count >= 4, "FinalShell scan reads nested directory, classifies SSH/groups and previews unsupported credentials");
        var scanFromConn = importer.ScanAsync(conn, localization).GetAwaiter().GetResult();
        check(scanFromConn.Counts.Profiles == 2 && scanFromConn.Counts.Groups == 2, "Selecting FinalShell conn folder does not scan its files twice");
        importer.Cancel(scanFromConn.Token);
        scan = importer.ScanAsync(directory, localization).GetAwaiter().GetResult();

        var storeDirectory = Path.Combine(root, "finalshell-store-" + Guid.NewGuid().ToString("N"));
        using var store = new NativeStore(storeDirectory, new TestProtector());
        store.Save("profiles", "existing", new JsonObject { ["id"] = "existing", ["name"] = "Existing", ["protocol"] = "ssh", ["host"] = "192.0.2.1", ["port"] = 22, ["username"] = "root", ["auth"] = new JsonObject { ["method"] = "password" } });
        var result = importer.Apply(store, scan.Token, duplicate: false, localization: localization);
        var imported = store.List("profiles").Single(item => item["host"]?.GetValue<string>() == "198.51.100.4");
        var importedChild = store.List("groups").Single(item => item["name"]?.GetValue<string>() == "Production");
        check(result is { Profiles: 1, Groups: 2, Skipped: 1, Invalid: 1, Secrets: 0 }
            && imported["groupId"]?.GetValue<string>() == importedChild["id"]?.GetValue<string>()
            && imported["terminal"]?["charset"]?.GetValue<string>() == "utf-8"
            && imported["auth"]?["passwordRef"] == null && imported["note"]?.GetValue<string>() == "fixture note",
            "FinalShell skip import preserves group references and never imports encrypted passwords or proxy/key refs");
        var childParent = importedChild["parentId"]?.GetValue<string>();
        check(childParent != null && store.Find("groups", childParent)?["name"]?.GetValue<string>() == "Operations", "FinalShell nested group hierarchy survives transactional import");
        reject(() => importer.Apply(store, scan.Token, duplicate: false, localization: localization), "FinalShell preview token is single use");

        var duplicateScan = importer.ScanAsync(directory, localization).GetAwaiter().GetResult();
        var duplicateResult = importer.Apply(store, duplicateScan.Token, duplicate: true, localization: localization);
        check(duplicateResult.Profiles == 2 && duplicateResult.Groups == 2 && duplicateResult.Skipped == 0
            && store.List("profiles").Count == 4 && store.List("groups").Count == 4,
            "FinalShell duplicate policy creates a separate remapped connection and group graph");
    }
}
