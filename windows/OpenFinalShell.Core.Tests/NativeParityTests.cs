using OpenFinalShell.Core;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core.Tests;

public static class NativeParityTests
{
    public static void Run(string root, Action<bool, string> check, Action<Action, string> reject)
    {
        NativeFinalShellImporterTests.Run(root, check, reject);
        NativeLegacyExportTests.Run(root, check, reject);
        var answerParts = NativeAiAnswer.Parse("before\n~~~bash metadata\necho one\necho two\n~~~\nafter");
        check(answerParts.Count == 3 && answerParts[0].Kind == NativeAiAnswerPartKind.Text
            && answerParts[1] is { Kind: NativeAiAnswerPartKind.Code, Language: "bash", Complete: true, Text: "echo one\necho two" }
            && answerParts[2].Text == "after", "AI response parser preserves prose, tilde-fenced shell blocks and trailing text");
        var unfinishedAi = NativeAiAnswer.Parse("```powershell\nGet-ChildItem");
        check(unfinishedAi.Single() is { Kind: NativeAiAnswerPartKind.Code, Language: "powershell", Complete: false }
            && NativeAiAnswer.IsShellLanguage("pwsh") && !NativeAiAnswer.IsShellLanguage("csharp"), "AI response parser recognizes shell languages and marks unfinished blocks");
        check(NativeAiAnswer.PrepareTerminalPaste("echo ok\r\n", false) is { Succeeded: true, Data: "echo ok" }
            && NativeAiAnswer.PrepareTerminalPaste("echo a\necho b", false).Issue == "multilineUnsupported"
            && NativeAiAnswer.PrepareTerminalPaste("echo a\necho b", true) is { Succeeded: true, Data: "echo a\necho b" },
            "AI terminal fill normalizes line endings and gates multiline text on bracketed paste");
        check(NativeAiAnswer.PrepareTerminalPaste("echo\u001b[2J", true).Issue == "controlCharacters"
            && NativeAiAnswer.PrepareTerminalPaste(new string('x', 32769), true).Issue == "tooLong"
            && NativeAiAnswer.PrepareTerminalPaste("\n", true).Issue == "empty", "AI terminal fill rejects controls, oversized and empty payloads");
        NativeTerminalDirectoryTests.Run(check);
        NativeFastDeleteTests.Run(check, reject);
        NativePackedTransferTests.Run(root, check, reject);
        NativeUploadConflictTests.Run(check, reject);
        NativeSkippedTransferTests.Run(check);
        NativeTransferTotalsTests.Run(check);
        check(NativeWorkbenchShortcut.Resolve(9, true, false, false, false, false, false)?.Action == NativeWorkbenchAction.NextSession
            && NativeWorkbenchShortcut.Resolve(9, true, true, false, false, false, false)?.Action == NativeWorkbenchAction.PreviousSession, "Workbench Ctrl+Tab arbitration switches sessions in both directions");
        check(NativeWorkbenchShortcut.Resolve(0x54, true, true, false, false, false, false)?.Action == NativeWorkbenchAction.DuplicateSession
            && NativeWorkbenchShortcut.Resolve(0x39, false, false, true, false, false, false)?.Index == 8, "Workbench duplication and Alt+1 through Alt+9 share a native-editor compatible route");
        check(NativeWorkbenchShortcut.Resolve(0x57, true, false, false, true, false, false) == null
            && NativeWorkbenchShortcut.Resolve(0x57, true, false, false, false, false, false)?.Action == NativeWorkbenchAction.CloseSession, "Ctrl+W preserves text-entry editing and closes only workbench targets");
        check(NativeWorkbenchShortcut.Resolve(9, true, false, false, false, true, false) == null
            && NativeWorkbenchShortcut.Resolve(0x54, true, true, false, false, false, true) == null
            && NativeWorkbenchShortcut.Resolve(0x43, true, false, false, false, false, false) == null, "IME, dialogs and terminal Ctrl+C are excluded from global session shortcuts");
        check(NativeTextCodec.AnalyzeNewLines("a\r\nb\nc\n") == ("\n", true)
            && NativeTextCodec.AnalyzeNewLines("a\r\nb\r\nc\n") == ("\r\n", true)
            && NativeTextCodec.AnalyzeNewLines("a\r\nb\n") == ("\n", true), "Mixed editor newlines use the shared majority rule with LF on ties");
        check(NativeTextCodec.AnalyzeNewLines("a\r\nb\r\n") == ("\r\n", false)
            && NativeTextCodec.AnalyzeNewLines("a\nb\n") == ("\n", false)
            && NativeTextCodec.AnalyzeNewLines("a\rb") == ("\n", true), "Editor exposes normalization warnings for bare CR and keeps uniform newlines unflagged");
        var gbText = "中文𠀀🙂";
        var gbBytes = NativeTextCodec.Encode(gbText, NativeTextEncoding.Gb18030, false);
        var gbView = NativeTextCodec.DecodeForEditing(gbBytes, NativeTextEncoding.Gb18030);
        check(gbView.Text == gbText && gbView.Lossless && !gbView.HasBom, "Editor GB18030 preserves four-byte characters without substituting GBK");
        reject(() => NativeTextCodec.Encode(gbText, NativeTextEncoding.Gbk, false), "Editor refuses unrepresentable GBK characters instead of writing question marks");
        reject(() => NativeTextCodec.Encode("中文", NativeTextEncoding.Windows1252, false), "Editor refuses lossy legacy-encoding saves before a remote write");
        var noBomView = NativeTextCodec.DecodeForEditing(System.Text.Encoding.UTF8.GetBytes("abc"), NativeTextEncoding.Utf8Bom);
        check(noBomView.Text == "abc" && !noBomView.HasBom && noBomView.Lossless, "Re-decoding as UTF-8 BOM never drops three bytes when no BOM exists");
        var bomBytes = NativeTextCodec.Encode("中文", NativeTextEncoding.Utf8Bom, true);
        var bomView = NativeTextCodec.DecodeForEditing(bomBytes, NativeTextEncoding.Utf8);
        check(bomView.Text == "中文" && bomView.HasBom && bomView.Lossless, "UTF-8 re-decode preserves a compatible real BOM");
        var wrongView = NativeTextCodec.DecodeForEditing(new byte[] { 0xFF, 0x61 }, NativeTextEncoding.Utf8);
        check(!wrongView.Lossless && wrongView.Text.EndsWith('a'), "Invalid sequences remain viewable but fail the lossless editing gate");
        foreach (var pair in new[] { (NativeTextEncoding.Gbk, "简体中文"), (NativeTextEncoding.Big5, "繁體中文"), (NativeTextEncoding.Latin1, "café") })
        {
            var bytes = NativeTextCodec.Encode(pair.Item2, pair.Item1, false);
            var decoded = NativeTextCodec.DecodeForEditing(bytes, pair.Item1);
            check(decoded.Text == pair.Item2 && decoded.Lossless, $"Editor {pair.Item1} round-trips its supported characters");
        }
        check(NativeCommandHistoryCapture.ExtractEchoed("test@fixture:~$ cd /etc/completed") == "cd /etc/completed", "Terminal history derives the submitted command from remote echo, including shell completion");
        check(NativeCommandHistoryCapture.ExtractEchoed("test@fixture:~$ ") == null && NativeCommandHistoryCapture.ExtractEchoed("Password: hidden-input") == null && NativeCommandHistoryCapture.ExtractEchoed("[sudo] password for test$ secret") == null, "Non-echoed input and credential prompts never become command history");
        check(NativeCommandHistoryCapture.ExtractEchoed("test$ vim", true) == null && NativeCommandHistoryCapture.ExtractEchoed("unknown prompt command") == null && NativeCommandHistoryCapture.ExtractEchoed("test$ " + new string('x', 2001)) == null, "History ignores alternate-screen, unrecognized and oversized lines");
        check(NativeCommandHistoryCapture.ExtractEchoed("test$ echo a > b.txt") == "echo a > b.txt" && NativeCommandHistoryCapture.ExtractEchoed("test$ echo 中文🙂") == "echo 中文🙂", "Echo capture preserves redirections and Unicode without recording keystrokes");
        var directory = Path.Combine(root, "parity-" + Guid.NewGuid().ToString("N"));
        using var store = new NativeStore(directory, new TestProtector());
        using var commandStore = new NativeStore(Path.Combine(root, "parity-commands-" + Guid.NewGuid().ToString("N")), new TestProtector());
        var history = new NativeCommandLibrary(commandStore);
        var commandsGroup = history.SaveGroup(null, "Commands", 4);
        var originalCommand = history.SaveSnippet(null, commandsGroup.Id, "Original", "  echo {{ host }} {{ user }} {{port}}\n", false, 3);
        commandStore.Patch("snippets", originalCommand.Id, new() { ["futureCommandField"] = true });
        var editedCommand = history.SaveSnippet(originalCommand.Id, commandsGroup.Id, "Edited", originalCommand.Command, true);
        check(editedCommand.Order == 3 && editedCommand.Command == originalCommand.Command && commandStore.Find("snippets", originalCommand.Id)?["futureCommandField"]?.GetValue<bool>() == true, "Command editing retains ordering, exact whitespace and unknown imported fields");
        var nextCommand = history.SaveSnippet(null, commandsGroup.Id, "Next", "echo next", false, 8);
        history.Move("snippets", nextCommand.Id, -1);
        check(history.ListSnippets(commandsGroup.Id).First().Id == nextCommand.Id, "Command ordering moves within its own group");
        var commandTarget = ConnectionProfile.FromJson(new() { ["id"] = "command-target", ["name"] = "Target", ["host"] = "fixture", ["username"] = "test", ["port"] = 2222, ["auth"] = new JsonObject { ["method"] = "password" } });
        check(NativeCommandLibrary.ExpandSnippet(originalCommand.Command, commandTarget) == "  echo fixture test 2222\n", "Command placeholders expand independently for the selected target without trimming command text");
        NativeSettings.Update(commandStore, new() { ["terminal"] = new JsonObject { ["saveCommandHistory"] = false } });
        history.AddHistory("fixture", "disabled command");
        check(history.ListHistory().Count == 0, "History privacy preference is enforced by the Core service for every caller");
        NativeSettings.Update(commandStore, new() { ["terminal"] = new JsonObject { ["saveCommandHistory"] = true } });
        history.AddHistory("fixture", new string('x', 2001)); history.AddHistory("fixture", "echo fixture");
        check(history.ListHistory().SequenceEqual(new[] { "echo fixture" }), "History retains the shared command length limit");
        store.Save("settings", "settings", new() {
            ["id"] = "settings", ["themeMode"] = "dark", ["language"] = "ja-JP", ["accent"] = "#f5222d", ["uiZoom"] = 125,
            ["terminal"] = new JsonObject { ["fontSize"] = 19, ["scrollback"] = 9000 },
            ["sftp"] = new JsonObject { ["packedTransfer"] = true },
            ["connection"] = new JsonObject { ["defaultProxyId"] = "proxy-1", ["maskHostInList"] = false },
            ["monitor"] = new JsonObject { ["intervalMs"] = 1500, ["future"] = true },
            ["futurePreference"] = "keep" });
        var original = NativeSettings.Load(store);
        var concurrent = NativeSettings.Load(store);
        check(original.UiScale == 125 && original.Language == "ja-JP" && original.MonitorIntervalMs == 1500 && original.Accent == "#f5222d", "Shared zoom, accent, monitor and all locale settings load");
        NativeSettings.Update(store, new() { ["themeMode"] = "system" });
        check(NativeSettings.Load(store).ThemeMode == "system", "System theme mode remains compatible with Electron settings");
        NativeSettings.Update(store, new() { ["themeMode"] = "dark" });
        check(NativeSettings.ReadPath(new JsonObject { ["value"] = 125 }, "value", 0d) == 125d && NativeSettings.ReadPath(new JsonObject { ["value"] = 14 }, "value", 0f) == 14f, "In-memory integer preferences can be read as floating point controls");
        check(NativeSettings.ReadPath(new JsonObject { ["value"] = "broken" }, "value", 14f) == 14f && NativeSettings.ReadPath(new JsonObject { ["value"] = double.NaN }, "value", 1d) == 1d, "Malformed and nonfinite numeric preferences use safe defaults");
        (original with { ThemeMode = "light" }).Save(store);
        (concurrent with { Language = "zh-TW" }).Save(store);
        var saved = store.Find("settings", "settings")!;
        check(saved["themeMode"]!.GetValue<string>() == "light" && saved["language"]!.GetValue<string>() == "zh-TW" && saved["accent"]!.GetValue<string>() == "#f5222d", "Independent setting edits do not overwrite concurrent preferences");
        check(saved["terminal"]?["fontSize"]?.GetValue<int>() == 19 && saved["sftp"]?["packedTransfer"]?.GetValue<bool>() == true && saved["futurePreference"]?.GetValue<string>() == "keep", "Preference edits retain imported and unknown fields");
        NativeSettings.Update(store, new() { ["terminal"] = new JsonObject { ["fontSize"] = 22 } });
        check(store.Find("settings", "settings")?["terminal"]?["scrollback"]?.GetValue<int>() == 9000, "Nested preference patches retain sibling fields");
        var portable = ExportEnvelope.Inspect(ExportEnvelope.Export(store, "test-pass"), "test-pass");
        check(portable.Data["settings"]?["terminal"]?["fontSize"]?.GetValue<int>() == 22 && portable.Data["settings"]?["sftp"]?["packedTransfer"]?.GetValue<bool>() == true && portable.Data["settings"]?["accent"]?.GetValue<string>() == "#f5222d", "Encrypted exports retain portable terminal, accent and SFTP preferences");
        check(portable.Data["settings"]?["futurePreference"] == null, "Unknown executable or environment settings cannot enter through import");
        NativeSettings.Update(store, new() { ["accent"] = "not-a-color" });
        check(NativeSettings.Load(store).Accent == NativeSettings.DefaultAccent, "Unknown accent values resolve to a safe shared default");
        var sftpTerminalDefaults = NativeSettings.Defaults;
        check(sftpTerminalDefaults.ThemeMode == "dark" && sftpTerminalDefaults.Language == "zh-CN"
            && sftpTerminalDefaults.SftpShowHiddenFiles && sftpTerminalDefaults.SftpDoubleClickAction == "download"
            && sftpTerminalDefaults.TerminalRightClick == "paste" && sftpTerminalDefaults.TerminalCopyOnSelect,
            "Native first-run theme, language, SFTP and terminal defaults match the shared Electron defaults");
        using (var partialSettingsStore = new NativeStore(Path.Combine(root, "partial-settings-" + Guid.NewGuid().ToString("N")), new TestProtector()))
        {
            partialSettingsStore.Save("settings", "settings", new() { ["id"] = "settings" });
            var partialSettings = NativeSettings.Load(partialSettingsStore);
            check(partialSettings.ThemeMode == "dark" && partialSettings.Language == "zh-CN",
                "Partial legacy settings resolve absent theme and language to the shared Electron defaults");
        }
        NativeSettings.Update(store, new()
        {
            ["sftp"] = new JsonObject { ["showHiddenFiles"] = false, ["doubleClickAction"] = "open" },
            ["terminal"] = new JsonObject { ["rightClick"] = "menu", ["copyOnSelect"] = false }
        });
        var explicitSftpTerminal = NativeSettings.Load(store);
        check(!explicitSftpTerminal.SftpShowHiddenFiles && explicitSftpTerminal.SftpDoubleClickAction == "open"
            && explicitSftpTerminal.TerminalRightClick == "menu" && !explicitSftpTerminal.TerminalCopyOnSelect,
            "Saved SFTP and terminal interaction preferences override Electron-compatible defaults");
        NativeSettings.Update(store, new()
        {
            ["sftp"] = new JsonObject { ["doubleClickAction"] = "future-action" },
            ["terminal"] = new JsonObject { ["rightClick"] = "future-action" }
        });
        var invalidSftpTerminal = NativeSettings.Load(store);
        check(invalidSftpTerminal.SftpDoubleClickAction == NativeSettings.DefaultSftpDoubleClickAction
            && invalidSftpTerminal.TerminalRightClick == NativeSettings.DefaultTerminalRightClick,
            "Invalid SFTP and terminal interaction values fall back to safe shared defaults");
        store.Save("proxies", "proxy-1", new() { ["id"] = "proxy-1", ["type"] = "socks5", ["host"] = "127.0.0.1", ["port"] = 1080 });
        check(NativeProxyResolver.Resolve(new() { ["proxyMode"] = "follow" }, store)?["id"]?.GetValue<string>() == "proxy-1", "Follow mode resolves the global default proxy");
        check(NativeProxyResolver.Resolve(new() { ["proxyMode"] = "direct", ["proxyId"] = "proxy-1" }, store) == null, "Direct mode ignores saved and global proxies");
        check(NativeProxyResolver.Mode(new() { ["proxyMode"] = "saved" }) == "custom", "Legacy native saved mode maps to shared custom mode");
        check(NativeProxyResolver.Resolve(new(), store) == null, "Legacy profiles without proxy mode stay direct despite a global proxy");
        reject(() => NativeProxyResolver.Resolve(new() { ["proxyMode"] = "custom", ["proxyId"] = "missing" }, store), "Missing proxy never silently dials directly");
        store.SaveConnectionGroup("parent", new() { ["name"] = "Parent" });
        store.SaveConnectionGroup("child", new() { ["name"] = "Child", ["parentId"] = "parent", ["future"] = "keep" });
        var revision = store.SaveConnectionGroup("child", new() { ["name"] = "Renamed" });
        var child = store.Find("groups", "child")!;
        check(child["parentId"]?.GetValue<string>() == "parent" && child["future"]?.GetValue<string>() == "keep", "Group edits retain hierarchy and unknown fields");
        var group = ConnectionGroup.FromJson(child);
        check(group.ParentId == "parent" && group.ToJson()["parentId"]?.GetValue<string>() == "parent", "Nested group parent survives model roundtrip");
        reject(() => store.SaveConnectionGroup("parent", new() { ["parentId"] = "child" }), "Group moves reject cycles");
        reject(() => store.SaveConnectionGroup("child", new() { ["parentId"] = "missing" }), "Group moves reject missing parents");
        check(store.Find("groups", "child")?["_revision"]?.GetValue<long>() == revision, "Rejected group moves do not write partial state");
        store.SaveConnectionGroup("grandchild", new() { ["name"] = "Grandchild", ["parentId"] = "child" });
        store.Save("profiles", "test", new() { ["id"] = "test", ["name"] = "Test", ["host"] = "localhost", ["port"] = 22, ["username"] = "test", ["auth"] = new JsonObject { ["method"] = "password" }, ["groupId"] = "child", ["future"] = true });
        store.DeleteConnectionGroup("child", revision);
        check(store.Find("groups", "grandchild")?["parentId"]?.GetValue<string>() == "parent" && store.Find("profiles", "test")?["groupId"]?.GetValue<string>() == "parent", "Deleting a nested group promotes child groups and connections to its parent");
        var issues = NativeConnectionHierarchy.Issues([new("a", "a", 0, 1, "b"), new("b", "b", 0, 1, "a"), new("c", "c", 0, 1, "missing")]);
        check(issues.Count == 3, "Imported cycles and missing parents are reported without recursion");
        check(File.Exists(store.Backup("parity-test")), "Compatibility backup uses a consistent SQLite snapshot");
        var rdp = NativeRdpProfileOptions.FromProfile(new() { ["domain"] = "legacy", ["auth"] = new JsonObject { ["passwordRef"] = "old" },
            ["rdp"] = new JsonObject { ["domain"] = "shared", ["passwordRef"] = "new", ["clipboard"] = false, ["audioPlayback"] = false, ["certificatePolicy"] = "strict" } });
        check(rdp.Domain == "shared" && rdp.PasswordRef == "new" && !rdp.Clipboard && !rdp.AudioPlayback && rdp.CertificatePolicy == "strict", "Shared RDP fields take precedence over legacy native fields");
        check(rdp.Features()["clipboardFilesPaste"]?.GetValue<bool>() == false && rdp.Features()["certificatePolicy"]?.GetValue<string>() == "strict", "RDP worker features obey the saved profile");
        check(NativeRdpProfileOptions.FromProfile(new() { ["domain"] = "legacy" }).Domain == "legacy", "Legacy native RDP domain remains readable");
        check(NativeImportSelection.DefaultCategories.SetEquals(["profiles", "aiProfiles", "snippets", "forwards", "knownHosts"]) && !NativeImportSelection.DefaultCategories.Contains("settings"), "Migration defaults import portable data but leave local settings unchanged");
        var incoming = new ImportPreview(new() {
            ["aiProfiles"] = new JsonArray(new JsonObject { ["id"] = "ai", ["apiKeyRef"] = "ai-secret" }),
            ["forwards"] = new JsonArray(new JsonObject { ["id"] = "forward", ["profileId"] = "unselected" }),
            ["settings"] = new JsonObject { ["terminal"] = new JsonObject { ["fontSize"] = 18 } }
        }, new() { ["ai-secret"] = "fixture-only" }, 0, 1, []);
        var selected = NativeImportSelection.Select(incoming, ["settings"], store);
        check(selected.Data["aiProfiles"] == null && selected.Secrets.Count == 0 && incoming.Data["aiProfiles"] != null, "Category selection excludes AI credentials without mutating the original preview");
        reject(() => NativeImportSelection.Select(incoming, ["forwards"], store), "Category selection rejects dangling forward references before any write");
        var commands = new ImportPreview(new() {
            ["snippetGroups"] = new JsonArray(new JsonObject { ["id"] = "commands" }),
            ["snippets"] = new JsonArray(new JsonObject { ["id"] = "command", ["groupId"] = "commands" }),
            ["groups"] = new JsonArray(new JsonObject { ["id"] = "orphan", ["parentId"] = "unselected-parent" })
        }, new(), 0, 0, []);
        check(NativeImportSelection.Select(commands, ["snippetGroups", "snippets"], store).Data["snippets"] is JsonArray { Count: 1 }, "Command selection resolves snippet groups separately from connection groups");
        reject(() => NativeImportSelection.Select(commands, ["snippets"], store), "Command selection rejects unselected missing snippet groups");
        reject(() => NativeImportSelection.Select(commands, ["groups"], store), "Category selection rejects missing parent groups before import");
        var collidingIds = new ImportPreview(new() {
            ["groups"] = new JsonArray(new JsonObject { ["id"] = "same", ["name"] = "Connection group" }),
            ["snippetGroups"] = new JsonArray(new JsonObject { ["id"] = "same", ["name"] = "Command group" }),
            ["profiles"] = new JsonArray(new JsonObject { ["id"] = "same", ["name"] = "Connection", ["host"] = "localhost", ["port"] = 22, ["username"] = "test", ["auth"] = new JsonObject { ["method"] = "password" }, ["groupId"] = "same", ["futureId"] = "same" }),
            ["snippets"] = new JsonArray(new JsonObject { ["id"] = "command", ["groupId"] = "same" })
        }, new(), 1, 0, []);
        store.Import(collidingIds, ImportConflict.Duplicate);
        var duplicateGroup = store.List("groups").Single(item => item["name"]?.GetValue<string>() == "Connection group")["id"]!.GetValue<string>();
        var duplicateCommands = store.List("snippetGroups").Single()["id"]!.GetValue<string>();
        var duplicateProfile = store.List("profiles").Single(item => item["name"]?.GetValue<string>() == "Connection");
        check(duplicateGroup != duplicateCommands && duplicateProfile["id"]!.GetValue<string>() != duplicateGroup && duplicateProfile["groupId"]!.GetValue<string>() == duplicateGroup && store.List("snippets").Single()["groupId"]!.GetValue<string>() == duplicateCommands, "Duplicate imports remap colliding IDs by entity category and retain correct references");
        check(duplicateProfile["futureId"]!.GetValue<string>() == "same", "Duplicate imports preserve unknown ID-shaped fields");
        store.Save("knownHosts", "localhost:22:ssh-ed25519", new() { ["key"] = "localhost:22:ssh-ed25519", ["fingerprintSha256"] = "existing-trust" });
        store.Import(new(new() { ["knownHosts"] = new JsonArray(new JsonObject { ["key"] = "localhost:22:ssh-ed25519", ["fingerprintSha256"] = "changed-trust" }, new JsonObject { ["key"] = "localhost:23:ssh-ed25519", ["fingerprintSha256"] = "new-trust" }) }, new(), 0, 0, []), ImportConflict.Duplicate);
        check(store.Find("knownHosts", "localhost:22:ssh-ed25519")?["fingerprintSha256"]?.GetValue<string>() == "existing-trust" && store.Find("knownHosts", "localhost:23:ssh-ed25519") != null, "Duplicate imports preserve natural host-key identities and existing trust decisions");
        var legacyToken = store.SaveSecret("legacy-fixture-token");
        store.Save("aiProviders", "legacy-ai", new() { ["id"] = "legacy-ai", ["name"] = "Legacy", ["baseUrl"] = "http://127.0.0.1:8000/v1", ["model"] = "legacy-model", ["enabled"] = true, ["tokenRef"] = legacyToken, ["future"] = true });
        using (var ai = new NativeAiService(store))
        {
            check(ai.ListProviders().Single().HasToken && ai.GetToken("legacy-ai") == "legacy-fixture-token", "Legacy AI providers remain usable without copying or exposing their secret");
            ai.SaveProvider(new("legacy-ai", "Edited", new Uri("http://127.0.0.1:8000/v1"), "new-model", true, null));
            check(ai.ListProviders().Count == 1 && store.Find("aiProfiles", "legacy-ai")?["future"]?.GetValue<bool>() == true && ai.GetToken("legacy-ai") == "legacy-fixture-token", "AI edits use the shared collection while retaining legacy token and unknown fields");
        }
        var aiExport = ExportEnvelope.Inspect(ExportEnvelope.Export(store, "test-pass"), "test-pass");
        check(aiExport.Data["aiProfiles"] is JsonArray { Count: 1 } aiProfiles && aiProfiles[0]?["apiKeyRef"]?.GetValue<string>() == legacyToken && aiExport.Secrets[legacyToken]?.GetValue<string>() == "legacy-fixture-token", "Native AI configurations and credentials survive the shared encrypted export format");
        store.Import(selected, ImportConflict.Overwrite);
        saved = store.Find("settings", "settings")!;
        check(saved["terminal"]?["fontSize"]?.GetValue<int>() == 18 && saved["terminal"]?["scrollback"]?.GetValue<int>() == 9000 && saved["futurePreference"]?.GetValue<string>() == "keep", "Partial settings imports retain local sibling and unknown preferences");
        var info = new Renci.SshNet.ConnectionInfo("localhost", "fixture", new Renci.SshNet.PasswordAuthenticationMethod("fixture", "fixture"));
        NativeSshOptions.Apply(info, new() { ["compress"] = true, ["legacyAlgorithms"] = true });
        check(info.CompressionAlgorithms.Keys.First() != "none" && info.CompressionAlgorithms.ContainsKey("none"), "SSH compression prefers a supported compressor and retains none fallback");
        NativeSshOptions.Apply(info, new() { ["compress"] = false, ["legacyAlgorithms"] = false });
        check(info.CompressionAlgorithms.Keys.SequenceEqual(new[] { "none" }) && !info.KeyExchangeAlgorithms.Keys.Any(k => k.Contains("sha1")) && !info.Encryptions.Keys.Any(k => k.EndsWith("-cbc")), "Modern SSH mode excludes legacy negotiation and disables compression");
        using var limiter = new NativeTransferLimiter();
        limiter.Configure(2, 1);
        using var first = limiter.AcquireAsync("a").GetAwaiter().GetResult();
        var sameSession = limiter.AcquireAsync("a");
        using var second = limiter.AcquireAsync("b").GetAwaiter().GetResult();
        var third = limiter.AcquireAsync("c");
        check(!sameSession.IsCompleted && !third.IsCompleted, "Transfer limits enforce both session and global capacity");
        limiter.Configure(3, 2);
        var any = Task.WhenAny(sameSession, third).GetAwaiter().GetResult();
        using (any.GetAwaiter().GetResult()) { }
        using var remaining = (ReferenceEquals(any, sameSession) ? third : sameSession).GetAwaiter().GetResult();
        check(true, "Increasing transfer limits wakes queued work without restarting active transfers");
        using var cancel = new CancellationTokenSource();
        limiter.Configure(1, 1);
        var canceled = limiter.AcquireAsync("waiting", cancel.Token); cancel.Cancel();
        try { canceled.GetAwaiter().GetResult(); check(false, "Canceled transfer waits release cleanly"); }
        catch (OperationCanceledException) { check(true, "Canceled transfer waits release cleanly"); }
        var restartedDirectory = Path.Combine(root, "parity-restart-" + Guid.NewGuid().ToString("N"));
        string reopenedSecret;
        using (var beforeRestart = new NativeStore(restartedDirectory, new TestProtector()))
        {
            beforeRestart.Import(ExportEnvelope.Inspect(ExportEnvelope.Export(store, "restart-pass"), "restart-pass"), ImportConflict.Overwrite);
            reopenedSecret = beforeRestart.Find("aiProfiles", "legacy-ai")!["apiKeyRef"]!.GetValue<string>();
            var connection = beforeRestart.Find("profiles", duplicateProfile["id"]!.GetValue<string>())!;
            connection["proxyMode"] = "follow";
            connection["futureProfileField"] = new JsonObject { ["enabled"] = true };
            beforeRestart.Save("profiles", connection["id"]!.GetValue<string>(), connection, connection["_revision"]!.GetValue<long>());
            (NativeSettings.Load(beforeRestart) with { ThemeMode = "dark" }).Save(beforeRestart);
        }
        using (var afterRestart = new NativeStore(restartedDirectory, new TestProtector()))
        {
            var connection = afterRestart.Find("profiles", duplicateProfile["id"]!.GetValue<string>())!;
            check(connection["groupId"]!.GetValue<string>() == duplicateGroup && connection["proxyMode"]!.GetValue<string>() == "follow" && connection["futureProfileField"]?["enabled"]?.GetValue<bool>() == true && afterRestart.Find("groups", "grandchild")?["parentId"]?.GetValue<string>() == "parent", "Encrypted migration, profile editing and store restart preserve hierarchy, proxy semantics and unknown fields");
            var restartedSettings = NativeSettings.Load(afterRestart);
            check(restartedSettings.ThemeMode == "dark" && restartedSettings.Get("terminal.scrollback", 0) == 9000 && restartedSettings.DefaultProxyId == "proxy-1" && afterRestart.ReadSecret(reopenedSecret) == "legacy-fixture-token", "Settings and rekeyed credential references survive import, edit and restart");
        }
    }
}
