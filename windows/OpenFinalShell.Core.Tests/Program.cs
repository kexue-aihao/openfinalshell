using OpenFinalShell.Core;
using OpenFinalShell.Core.Tests;
using OpenFinalShell.App;
using Microsoft.Data.Sqlite;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using OpenFinalShell.App.ViewModels;

if (Environment.GetEnvironmentVariable("OFS_UPDATE_PROCESS_FIXTURE") is { Length: > 0 } processFixture)
{
    await NativeUpdateProcessFixture.RunParentAsync(processFixture);
    return;
}
if (args is ["--prepare-update-process-fixture", var fixtureRoot, var helperPath])
{
    NativeUpdateProcessFixture.Prepare(fixtureRoot, helperPath);
    return;
}

if (args.Length > 0 && args[0] == "--seed-winui-acceptance")
{
    if (args.Length != 3 || !int.TryParse(args[2], out var acceptancePort) || acceptancePort is < 1 or > 65535)
        throw new ArgumentException("Usage: --seed-winui-acceptance <isolated-data-directory> <ssh-port>");
    var dataDirectory = Path.GetFullPath(args[1]);
    using var acceptanceStore = new NativeStore(dataDirectory, new DpapiProtector());
    var passwordRef = acceptanceStore.SaveSecret("test123");
    var acceptanceProfileJson = new JsonObject
    {
        ["id"] = "win11-acceptance-ssh",
        ["name"] = "Win11 Acceptance SSH",
        ["host"] = "127.0.0.1",
        ["port"] = acceptancePort,
        ["username"] = "test",
        ["auth"] = new JsonObject { ["method"] = "password", ["passwordRef"] = passwordRef },
        ["terminal"] = new JsonObject { ["charset"] = "utf-8", ["termType"] = "xterm-256color" },
        ["options"] = new JsonObject { ["readyTimeout"] = 8000, ["keepaliveInterval"] = 15000 }
    };
    acceptanceStore.Save("profiles", "win11-acceptance-ssh", acceptanceProfileJson);
    acceptanceStore.SaveConnectionGroup("acceptance-parent", new() { ["name"] = "Acceptance", ["order"] = 0 });
    acceptanceStore.SaveConnectionGroup("acceptance-child", new() { ["name"] = "Nested SSH", ["parentId"] = "acceptance-parent", ["order"] = 0 });
    acceptanceProfileJson["groupId"] = "acceptance-child";
    acceptanceStore.Save("profiles", "win11-acceptance-ssh", acceptanceProfileJson);
    NativeSettings.Update(acceptanceStore, new() { ["language"] = "zh-CN", ["themeMode"] = "dark", ["autoCheckUpdate"] = false });
    using (var acceptanceSessions = new NativeSessionManager(acceptanceStore))
    {
        var profile = ConnectionProfile.FromJson(acceptanceProfileJson);
        var connected = acceptanceSessions.OpenAsync(
            profile,
            _ => Task.FromResult(true),
            (_, _) => Task.FromResult<string?>("test123"),
            CancellationToken.None).GetAwaiter().GetResult();
        if (connected.State != NativeSessionState.Ready) throw new InvalidOperationException("Acceptance SSH fixture did not reach Ready.");
        acceptanceSessions.Close(connected.SessionId);
    }
    Console.WriteLine("WinUI acceptance profile seeded; fixture host key is trusted in the isolated test store.");
    return;
}

var root = Path.GetFullPath(args.Length > 0 ? args[0] : Path.Combine(FindWorkspaceRoot(), ".local/native-contract"));
var bytes = File.ReadAllBytes(Path.Combine(root, "legacy-export.json"));
const string password = "迁移-passphrase-🔐";
int passed = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); Console.WriteLine($"PASS {name}"); passed++; }
void Reject(Action action, string name) { try { action(); } catch { Check(true, name); return; } throw new Exception(name); }
async Task RejectAsync(Func<Task> action, string name) { try { await action(); } catch { Check(true, name); return; } throw new Exception(name); }
await NativeFileUpdateTests.RunAsync(Check, root);
NativeEditorLanguageTests.Run(Check);
Check(NativeTerminalCursorLayout.HasChanged(double.NaN, 24)
    && NativeTerminalCursorLayout.HasChanged(double.NaN, 18)
    && !NativeTerminalCursorLayout.HasChanged(24, 24.001)
    && NativeTerminalCursorLayout.HasChanged(24, 24.02),
    "Native terminal layout cache initializes NaN values and ignores subpixel noise");
Check(NativeTerminalCursorLayout.ShouldDraw(true, true, true, false)
    && !NativeTerminalCursorLayout.ShouldDraw(false, true, true, false)
    && !NativeTerminalCursorLayout.ShouldDraw(true, false, true, false)
    && !NativeTerminalCursorLayout.ShouldDraw(true, true, false, false)
    && !NativeTerminalCursorLayout.ShouldDraw(true, true, true, true),
    "Native terminal cursor visibility follows active, scroll, blink and composition state without focus gating");
var barCursor = NativeTerminalCursorLayout.ForCell(10, 20, 8, 18, "bar");
var blockCursor = NativeTerminalCursorLayout.ForCell(10, 20, 8, 18, "block");
var underlineCursor = NativeTerminalCursorLayout.ForCell(10, 20, 8, 18, "underline");
Check(barCursor == new NativeTerminalCursorGeometry(10, 20, 2, 18)
    && blockCursor == new NativeTerminalCursorGeometry(10, 20, 8, 18)
    && underlineCursor == new NativeTerminalCursorGeometry(10, 36, 8, 2),
    "Native terminal cursor geometry preserves bar, block and underline styles");
Check(OpenFinalShell.App.Controls.SftpTimestamp.Format(new DateTime(2026, 11, 7, 9, 25, 30), "zh-CN") == "2026/11/7周六 上午 09:25:30"
    && OpenFinalShell.App.Controls.SftpTimestamp.Format(new DateTime(2026, 11, 8, 13, 2, 3), "zh-CN") == "2026/11/8周日 下午 01:02:03",
    "SFTP timestamps display the exact Chinese date, weekday, period and seconds");
var currentPackageVersion = JsonNode.Parse(File.ReadAllText(Path.Combine(FindWorkspaceRoot(), "package.json")))?["version"]?.GetValue<string>();
Check(NativeReleaseNotes.All.Count > 0 && NativeReleaseNotes.All[0].Version == currentPackageVersion && NativeReleaseNotes.All[0].Items.Count >= 1, "Native release notes embed the current Electron changelog");
Check(NativeStartupNotice.ClassifyLaunch(null, "1.2.3") is { Kind: NativeStartupNoticeKind.Fresh, FromVersion: null, ToVersion: "1.2.3" }
    && NativeStartupNotice.ClassifyLaunch("1.2.2", "1.2.3") is { Kind: NativeStartupNoticeKind.Update, FromVersion: "1.2.2" }
    && NativeStartupNotice.ClassifyLaunch("1.2.3", "1.2.3").Kind == NativeStartupNoticeKind.None,
    "Native startup notice classifies first launch, update and unchanged version");
Check(NativeShellPathSync.ParseCdTarget("cd -P '/var/log' && ls") == "/var/log"
    && NativeShellPathSync.ParseCdTarget("cd -- /srv/app") == "/srv/app"
    && NativeShellPathSync.ParseCdTarget("echo cd /tmp") == null
    && NativeShellPathSync.ParseCdTarget("cd $HOME") == null,
    "Native shell path sync parses only statically safe cd commands");
Check(NativeShellPathSync.ApplyCd("/srv/app", "../logs", null) == "/srv/logs"
    && NativeShellPathSync.ApplyCd("/srv/app", "/var/log", null) == "/var/log"
    && NativeShellPathSync.ApplyCd("/srv/app", "~", "/home/test") == "/home/test",
    "Native shell path sync resolves relative, absolute and home directories");
var sftpDropDirectory = new RemoteEntry("logs", "/var/log", 0, true, DateTime.UnixEpoch, NativeRemoteEntryType.Directory);
var sftpDropFile = new RemoteEntry("app.log", "/var/log/app.log", 16, false, DateTime.UnixEpoch);
Check(NativeSftpDropTarget.Resolve(true, true, false, "/home/test", sftpDropDirectory) is { Accepted: true, Directory: "/var/log", IsDirectoryRow: true },
    "SFTP file drops on a directory row target that directory");
Check(NativeSftpDropTarget.Resolve(true, true, false, "/home/test", sftpDropFile) is { Accepted: true, Directory: "/home/test", IsDirectoryRow: false }
    && NativeSftpDropTarget.Resolve(true, true, false, "/home/test", null) is { Accepted: true, Directory: "/home/test", IsDirectoryRow: false },
    "SFTP file rows and blank space fall back to the current directory");
Check(!NativeSftpDropTarget.Resolve(false, true, false, "/home/test", null).Accepted
    && !NativeSftpDropTarget.Resolve(true, false, false, "/home/test", null).Accepted
    && !NativeSftpDropTarget.Resolve(true, true, true, "/home/test", null).Accepted,
    "SFTP drops reject non-file data, disconnected sessions and pending navigation");
Check(NativeSftpDropTarget.Resolve(true, true, false, "/home/test", sftpDropDirectory with { Path = "relative/logs" }) is { Accepted: true, Directory: "/home/test", IsDirectoryRow: false }
    && !NativeSftpDropTarget.Resolve(true, true, false, "/home/../private", null).Accepted,
    "SFTP drop target rejects non-canonical remote paths and unsafe current directories");
var bulkEntries = new BulkObservableCollection<string>();
var bulkChangeCount = 0;
bulkEntries.CollectionChanged += (_, args) => { if (args.Action == System.Collections.Specialized.NotifyCollectionChangedAction.Reset) bulkChangeCount++; };
bulkEntries.ReplaceAll(Enumerable.Range(0, 5000).Select(index => $"entry-{index}"));
Check(bulkEntries.Count == 5000 && bulkChangeCount == 1,
    "Bulk SFTP replacement publishes one reset notification for 5000 entries");
var transferBurstDirectory = Path.Combine(root, $"transfer-burst-{Guid.NewGuid():N}");
var previousSynchronizationContext = SynchronizationContext.Current;
SynchronizationContext.SetSynchronizationContext(null);
using (var transferStore = new NativeStore(transferBurstDirectory, new DpapiProtector()))
using (var transferSessions = new NativeSessionManager(transferStore))
using (var transferQueue = new NativeTransferQueue(transferSessions))
using (var transferViewModel = new TransferQueueViewModel(transferQueue, new Localization()))
{
    var transferNotifications = 0;
    transferViewModel.QueueChanged += () => Interlocked.Increment(ref transferNotifications);
    for (var index = 0; index < 5000; index++)
        transferQueue.EnqueueSkipped("burst", NativeTransferDirection.Upload,
            $"/source/{index}", $"/target/{index}", "skipped");
    await Task.Delay(250);
    Check(transferViewModel.Tasks.Count == 5000 && transferNotifications is > 0 and <= 5,
        "Transfer progress burst is coalesced into bounded UI notifications");
}
SynchronizationContext.SetSynchronizationContext(previousSynchronizationContext);
var sftpHistory = new NativeSftpNavigationHistory();
Check(sftpHistory.Push("/home/test") && sftpHistory.Push("/home/test/logs") && sftpHistory.CanGoBack
    && sftpHistory.BackTarget == "/home/test" && !sftpHistory.CanGoForward,
    "SFTP navigation history records new directories and exposes back target");
Check(sftpHistory.CommitBack("/home/test") && sftpHistory.Current == "/home/test" && sftpHistory.CanGoForward
    && sftpHistory.ForwardTarget == "/home/test/logs",
    "SFTP navigation history commits back navigation and exposes forward target");
Check(sftpHistory.CommitForward("/home/test/logs") && sftpHistory.Current == "/home/test/logs"
    && !sftpHistory.CanGoForward,
    "SFTP navigation history commits forward navigation");
Check(sftpHistory.Push("/home/test/archive") && !sftpHistory.CanGoForward && sftpHistory.Entries.SequenceEqual(["/home/test", "/home/test/logs", "/home/test/archive"]),
    "SFTP navigation history truncates forward entries after a new directory");
var sftpSortEntries = new[]
{
    new RemoteEntry("z-file", "/z-file", 20, false, DateTime.UnixEpoch, Mode: 644),
    new RemoteEntry("a-dir", "/a-dir", 0, true, DateTime.UnixEpoch.AddMinutes(1), Mode: 755),
    new RemoteEntry("b-file", "/b-file", 10, false, DateTime.UnixEpoch.AddMinutes(2), Mode: 600)
};
Check(NativeSftpSort.Apply(sftpSortEntries, "name", false).Select(item => item.Name).SequenceEqual(["a-dir", "b-file", "z-file"]),
    "SFTP sort keeps directories first and sorts names ascending");
Check(NativeSftpSort.Apply(sftpSortEntries, "size", true).Select(item => item.Name).SequenceEqual(["a-dir", "z-file", "b-file"]),
    "SFTP sort supports descending size while keeping directories first");
Check(NativeSftpSort.Apply(sftpSortEntries, "modified", false).Select(item => item.Name).SequenceEqual(["a-dir", "z-file", "b-file"]),
    "SFTP sort supports ascending modification time while keeping directories first");
var searchLiteral = NativeTerminalSearch.Find("Error error ERROR", "error", false, false);
Check(searchLiteral.Count == 3 && searchLiteral[0].Index == 0 && searchLiteral[2].Index == 12,
    "Native terminal search finds every case-insensitive literal match");
var searchCase = NativeTerminalSearch.Find("Error error ERROR", "error", true, false);
Check(searchCase.Count == 1 && searchCase[0].Index == 6,
    "Native terminal search respects case sensitivity");
var searchRegex = NativeTerminalSearch.Find("node-12 node-7", @"node-\d+", false, true);
Check(searchRegex.Count == 2 && searchRegex[0].Length == 7 && searchRegex[1].Index == 8,
    "Native terminal search supports bounded regular expressions");
Check(NativeTerminalSearch.Find("text", "[", false, true).Count == 0,
    "Native terminal search rejects malformed regular expressions safely");
var startupNoticeStorePath = Path.Combine(root, "startup-notice-" + Guid.NewGuid().ToString("N"));
using (var startupNoticeStore = new NativeStore(startupNoticeStorePath, new TestProtector()))
{
    Check(NativeStartupNotice.PendingLaunch(startupNoticeStore, "1.2.3").Kind == NativeStartupNoticeKind.Fresh
        && NativeStartupNotice.PendingLaunch(startupNoticeStore, "1.2.3").Kind == NativeStartupNoticeKind.Fresh,
        "Unacknowledged startup history remains pending until the dialog has been shown");
    Check(NativeStartupNotice.AdvanceLaunch(startupNoticeStore, "1.2.3").Kind == NativeStartupNoticeKind.Fresh,
        "Native startup notice classifies the first database launch");
}
using (var startupNoticeStore = new NativeStore(startupNoticeStorePath, new TestProtector()))
{
    Check(NativeStartupNotice.AdvanceLaunch(startupNoticeStore, "1.2.3").Kind == NativeStartupNoticeKind.None,
        "Native startup notice stays dismissed after restarting the process");
    Check(NativeStartupNotice.AdvanceLaunch(startupNoticeStore, "1.2.4") is { Kind: NativeStartupNoticeKind.Update, FromVersion: "1.2.3", ToVersion: "1.2.4" },
        "Native startup notice records an upgrade boundary");
    var startupExport = Encoding.UTF8.GetString(ExportEnvelope.Export(startupNoticeStore, "startup-export-passphrase"));
    Check(!startupExport.Contains("last_launched_version", StringComparison.Ordinal)
        && !startupExport.Contains("1.2.4", StringComparison.Ordinal),
        "Native startup marker remains outside the shared migration export");
}
NativeParityTests.Run(root, Check, Reject);
NativeWindowBoundsTests.Run(Check);
var terminalThemeForeground = new OpenFinalShell.App.TerminalRgbColor(171, 178, 191);
var terminalGreen = new OpenFinalShell.App.TerminalRgbColor(152, 195, 121);
var terminalYellow = new OpenFinalShell.App.TerminalRgbColor(229, 192, 123);
var terminalRed = new OpenFinalShell.App.TerminalRgbColor(224, 108, 117);
var terminalBlack = new OpenFinalShell.App.TerminalRgbColor(0, 0, 0);
var terminalWhite = new OpenFinalShell.App.TerminalRgbColor(255, 255, 255);
var terminalExplicitRed = new OpenFinalShell.App.TerminalRgbColor(255, 80, 80);
var adjustedGreen = OpenFinalShell.App.NativeTerminalTextContrast.Resolve(
    terminalThemeForeground, terminalGreen, usesDefaultForeground: true);
var adjustedYellow = OpenFinalShell.App.NativeTerminalTextContrast.Resolve(
    terminalThemeForeground, terminalYellow, usesDefaultForeground: true);
var adjustedRed = OpenFinalShell.App.NativeTerminalTextContrast.Resolve(
    terminalThemeForeground, terminalRed, usesDefaultForeground: true);
Check(adjustedGreen == terminalBlack && adjustedYellow == terminalBlack && adjustedRed == terminalBlack,
    "Default terminal foreground auto-contrasts on bright ANSI backgrounds");
Check(OpenFinalShell.App.NativeTerminalTextContrast.ContrastRatio(adjustedGreen, terminalGreen) >= 4.5
    && OpenFinalShell.App.NativeTerminalTextContrast.ContrastRatio(adjustedYellow, terminalYellow) >= 4.5
    && OpenFinalShell.App.NativeTerminalTextContrast.ContrastRatio(adjustedRed, terminalRed) >= 4.5,
    "Auto-contrast terminal foreground reaches the WCAG AA ratio");
Check(OpenFinalShell.App.NativeTerminalTextContrast.Resolve(
        terminalThemeForeground, terminalGreen, usesDefaultForeground: false) == terminalBlack,
    "Explicit neutral ANSI foreground is corrected when contrast is insufficient");
Check(OpenFinalShell.App.NativeTerminalTextContrast.Resolve(
        terminalWhite, terminalGreen, usesDefaultForeground: false) == terminalBlack,
    "Explicit white ANSI foreground becomes black on a bright background");
Check(OpenFinalShell.App.NativeTerminalTextContrast.Resolve(
        terminalExplicitRed, terminalGreen, usesDefaultForeground: false) == terminalExplicitRed,
    "Explicit saturated ANSI foreground colors are preserved");
Check(OpenFinalShell.App.NativeTerminalTextContrast.UsesDefaultForeground(2, 1, reverse: false)
    && !OpenFinalShell.App.NativeTerminalTextContrast.UsesDefaultForeground(1, 2, reverse: false)
    && OpenFinalShell.App.NativeTerminalTextContrast.UsesDefaultForeground(1, 2, reverse: true)
    && !OpenFinalShell.App.NativeTerminalTextContrast.UsesDefaultForeground(1, 1, reverse: true),
    "Reverse video uses the actual foreground source for terminal auto-contrast");
var wideEditorLayout = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.Resolve(1600, 900);
var portraitEditorLayout = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.Resolve(360, 800);
var compactEditorLayout = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.Resolve(320, 480);
Check(wideEditorLayout.DialogWidth == 1120 && wideEditorLayout.EditorHeight == 500
    && wideEditorLayout.Portrait == false,
    "Command editor uses a wide layout on widescreen viewports");
Check(portraitEditorLayout.DialogWidth == 336 && portraitEditorLayout.EditorHeight >= 320
    && portraitEditorLayout.Portrait,
    "Command editor keeps a usable writing area in portrait");
Check(compactEditorLayout.DialogWidth >= 280 && compactEditorLayout.ContentHeight >= 260
    && compactEditorLayout.EditorHeight >= 180 && compactEditorLayout.TargetsHeight >= 96,
    "Command editor clamps compact viewports without collapsing controls");
var editorWindowSize = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.ResolveWindowSize(1920, 1080, 1, 1);
Check(editorWindowSize.Width == 1120 && editorWindowSize.Height == 840,
    "Command editor uses a separate wide window sized for the monitor work area");
foreach (var (workWidth, workHeight, dpi, zoom) in new[] { (1080, 1920, 1.25, 1d), (1200, 800, 1.5, 1.25), (640, 480, 2d, 2d) })
{
    var size = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.ResolveWindowSize(workWidth, workHeight, dpi, zoom);
    Check(size.Width > 0 && size.Width <= workWidth - Math.Ceiling(32 * dpi)
        && size.Height > 0 && size.Height <= workHeight - Math.Ceiling(80 * dpi),
        "Command editor client fits portrait, DPI and UI zoom without covering the taskbar");
}
var savedEditorWindowSize = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.ResolveWindowSize(
    3000, 2000, 1.5, 1, savedWidthDip: 960, savedHeightDip: 720);
Check(savedEditorWindowSize.Width == 1440 && savedEditorWindowSize.Height == 1080,
    "Command editor restores a custom DIP size across DPI changes");
var clampedEditorWindowSize = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.ResolveWindowSize(
    900, 700, 1.5, 1, savedWidthDip: 2400, savedHeightDip: 1600);
Check(clampedEditorWindowSize.Width == 852 && clampedEditorWindowSize.Height == 580,
    "Command editor clamps remembered custom size to the current monitor work area");
var invalidSavedEditorWindowSize = OpenFinalShell.App.NativeCommandEditorLayoutPolicy.ResolveWindowSize(
    1920, 1080, 1, 1, savedWidthDip: double.NaN, savedHeightDip: -10);
Check(invalidSavedEditorWindowSize == editorWindowSize,
    "Command editor ignores invalid persisted custom sizes and uses its default layout");
NativeStoreRecoveryTests.Run(root, Check);
Check(!OpenFinalShell.App.NativeAccessibilityGuard.ReadHighContrast(() => throw new System.Runtime.InteropServices.COMException("unavailable", unchecked((int)0x80070490))),
    "Unavailable high-contrast query falls back without failing startup");
Check(!OpenFinalShell.App.NativeAccessibilityGuard.TryRegister(() => throw new System.Runtime.InteropServices.COMException("unavailable", unchecked((int)0x80070490))),
    "Unavailable high-contrast change event does not block startup");
var unregisterAttempted = false;
OpenFinalShell.App.NativeAccessibilityGuard.TryUnregister(() =>
{
    unregisterAttempted = true;
    throw new System.Runtime.InteropServices.COMException("unavailable", unchecked((int)0x80070490));
});
Check(unregisterAttempted, "Unavailable high-contrast event cleanup is harmless");
foreach (var build in new[] { 19045, 21999, 22000, 22621 }) {
    var env = PlatformEnvironment.Resolve(10, build, 1);
    Check(env.Supported && (env.Profile == "windows-11") == (build >= 22000), $"Windows boundary {build}");
}
Check(!PlatformEnvironment.Resolve(10, 26100, 3).Supported && !PlatformEnvironment.Resolve(10, 26100, 3).MicaEligible, "Server conservative fallback");
Check(!PlatformEnvironment.Resolve(10, 17763, 1).Supported, "Unsupported Windows rejected");
var windows11Version = PlatformEnvironment.Resolve(10, 0, 26100, 1, "24H2", 1742, "AMD64");
Check(windows11Version.Profile == "windows-11" && windows11Version.WindowsName == "Windows 11"
    && windows11Version.DisplayText == "Windows 11 24H2 · 10.0.26100.1742 · x64",
    "Windows 11 displays release, full UBR version and operating system architecture");
var windows10Version = PlatformEnvironment.Resolve(10, 0, 19045, 1, "22H2", null, "X86");
Check(windows10Version.Profile == "windows-10" && windows10Version.WindowsName == "Windows 10"
    && windows10Version.DisplayText == "Windows 10 22H2 · 10.0.19045 · x86",
    "Windows 10 displays its release and falls back cleanly when UBR is unavailable");
var partialVersion = PlatformEnvironment.Resolve(10, 0, 19045, 1, "", null, null);
Check(partialVersion.DisplayText == "Windows 10 · 10.0.19045 · unknown",
    "Platform display preserves known version data when release and architecture cannot be read");
var preview = ExportEnvelope.Inspect(bytes, password);
Check(preview.Profiles == 1 && preview.Secrets["password-1"]!.GetValue<string>() == "secret-密码", "Node v2 decrypted with Unicode passphrase");
Check(preview.Data["settings"]?["rdpClientPath"] == null && preview.Data["settings"]?["profile"] == null, "Untrusted settings stripped");
Check(preview.MissingPrivateKeys.Count == 1, "Missing private key reported");
Reject(() => ExportEnvelope.Inspect(bytes, "wrong"), "Wrong passphrase rejected");
var corrupt = JsonNode.Parse(bytes)!.AsObject(); var cipher = Convert.FromBase64String(corrupt["enc"]!["cipher"]!.GetValue<string>()); cipher[0] ^= 1;
corrupt["enc"]!["cipher"] = Convert.ToBase64String(cipher);
Reject(() => ExportEnvelope.Inspect(Encoding.UTF8.GetBytes(corrupt.ToJsonString()), password), "Ciphertext tampering rejected");
corrupt["enc"]!["n"] = 1 << 24;
Reject(() => ExportEnvelope.Inspect(Encoding.UTF8.GetBytes(corrupt.ToJsonString()), password), "Excessive KDF rejected before work");
Reject(() => ExportEnvelope.Inspect(File.ReadAllBytes(Path.Combine(root, "invalid-export.json")), password), "Duplicate IDs rejected");
var directory = Path.Combine(root, Guid.NewGuid().ToString());
using (var store = new NativeStore(directory, new TestProtector())) {
    var firstImport = store.Import(preview, ImportConflict.Skip);
    var profile = store.List("profiles").Single();
    Check(firstImport.Profiles == 1 && firstImport.Groups == 1 && firstImport.Secrets == 1,
        "Native import reports entities and only referenced credentials actually written");
    Check(store.ReadSecret(profile["auth"]!["passwordRef"]!.GetValue<string>()) == "secret-密码", "Imported secret remapped");
    var repeatedImport = store.Import(preview, ImportConflict.Skip);
    Check(repeatedImport.Skipped > 0 && repeatedImport.Profiles == 0 && repeatedImport.Secrets == 0,
        "Skip import reports conflicts without leaking unreferenced secret rows");
    store.Patch("settings", "settings", new() { ["uiZoom"] = 80 });
    var settingsResult = store.Import(new ImportPreview(new() { ["settings"] = new JsonObject { ["uiZoom"] = 135 } }, new(), 0, 0, []), ImportConflict.Skip);
    Check(settingsResult.SettingsApplied && store.Find("settings", "settings")?["uiZoom"]?.GetValue<int>() == 135,
        "Selected settings merge independently of entity conflict policy");
    var hostKey = "sync.example:22:ssh-ed25519";
    store.Save("knownHosts", hostKey, new JsonObject { ["id"] = hostKey, ["fingerprint"] = "SHA256:local" });
    var hostKeyResult = store.Import(new ImportPreview(new() { ["knownHosts"] = new JsonArray(new JsonObject {
        ["id"] = hostKey, ["fingerprint"] = "SHA256:imported"
    }) }, new(), 0, 0, []), ImportConflict.Overwrite);
    Check(hostKeyResult.KnownHosts == 0 && hostKeyResult.Skipped == 1 && store.Find("knownHosts", hostKey)?["fingerprint"]?.GetValue<string>() == "SHA256:local",
        "Import never overwrites a local host-key trust decision");
    Check(store.List("profiles").Count == 1, "Skip import is repeatable");
    File.WriteAllBytes(Path.Combine(root, "native-export.json"), ExportEnvelope.Export(store, password));
    store.Import(preview, ImportConflict.Duplicate);
    var duplicate = store.List("profiles").Last();
    Check(store.List("profiles").Count == 2 && duplicate["groupId"]!.GetValue<string>() != "group-1" &&
        store.Find("groups", duplicate["groupId"]!.GetValue<string>()) != null, "Duplicate graph references remapped");
    Reject(() => store.Save("profiles", "profile-1", profile, 0), "Stale writer rejected");
    var bad = new ImportPreview(new() { ["groups"] = new JsonArray(new JsonObject { ["id"] = "rollback", ["name"] = "rollback" }), ["snippets"] = new JsonArray(new JsonObject { ["name"] = "invalid" }) }, new(), 0, 0, []);
    Reject(() => store.Import(bad, ImportConflict.Overwrite), "Invalid transaction rejected");
    Check(store.Find("groups", "rollback") == null, "Failed import rolled back atomically");
    Check(Directory.GetFiles(directory, "before-import-*.db").Length >= 4, "Pre-import backups retained");
}
using (var store = new NativeStore(directory, new TestProtector())) Check(store.List("profiles").Count == 2, "Encrypted store survives restart");
var disk = Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(directory,"native.db")));
Check(!disk.Contains("测试.example") && !disk.Contains("secret-密码") && !disk.Contains("服务器"), "Sensitive configuration encrypted at rest");
var portCounters = NativePortTrafficParser.Parse("22 3 4096 8192 3\n443 2 100 200 1\ninvalid row\n70000 1 1 1 1\n");
Check(portCounters.Count == 2 && portCounters[0].Port == 22 && portCounters[0].RatesAvailable && !portCounters[1].RatesAvailable, "Port traffic counters validated and rate capability preserved");
using (var libraryStore = new NativeStore(Path.Combine(root, "commands-" + Guid.NewGuid().ToString("N")), new TestProtector())) {
    var library = new NativeCommandLibrary(libraryStore);
    var group = library.SaveGroup(null, "Operations");
    var snippet = library.SaveSnippet(null, group.Id, "List files", "ls -la", true);
    Check(NativeCommandLibrary.DefaultSnippetAutoEnter && library.ListGroups().Single().Name == "Operations" && library.ListSnippets(group.Id).Single().AutoEnter && snippet.Command == "ls -la", "Command library follows shared schema fields and Electron default auto-enter");
    library.AddHistory("session-a", "pwd"); library.AddHistory("session-b", "whoami");
    Check(library.ListHistory("session-a").SequenceEqual(["pwd"]), "Command history can be scoped to a session");
    library.ClearHistory("session-a"); Check(library.ListHistory("session-a").Count == 0 && library.ListHistory("session-b").Count == 1, "Command history clear is session scoped");
}
using (var seedStore = new NativeStore(Path.Combine(root, "command-seed-" + Guid.NewGuid().ToString("N")), new TestProtector()))
{
    var seededLibrary = new NativeCommandLibrary(seedStore);
    Check(seededLibrary.SeedDefaultSnippets(key => key), "An empty command library receives its first-run defaults");
    Check(seededLibrary.ListGroups().Count == 5 && seededLibrary.ListSnippets().Count == 26,
        "First-run command library contains five categorized groups and 26 operations commands");
    var snippets = seededLibrary.ListSnippets();
    Check(snippets.Single(item => item.Id == "builtin-uname").AutoEnter
        && !snippets.Single(item => item.Id == "builtin-dns").AutoEnter
        && !snippets.Single(item => item.Id == "builtin-install-debian").AutoEnter
        && !snippets.Single(item => item.Id == "builtin-scan-top100").AutoEnter,
        "Read-only defaults auto-enter while install and scan commands wait for review");
    Check(seededLibrary.SeedDefaultSnippets(_ => "changed") == false && seededLibrary.ListSnippets().Count == 26,
        "Built-in command seeding is idempotent and keeps the first localized names");
    foreach (var group in seededLibrary.ListGroups()) seededLibrary.DeleteGroup(group.Id);
    Check(!seededLibrary.SeedDefaultSnippets(_ => "again") && seededLibrary.ListGroups().Count == 0,
        "Deleting all built-ins does not cause them to be seeded again");
}
using (var existingCommandStore = new NativeStore(Path.Combine(root, "command-existing-" + Guid.NewGuid().ToString("N")), new TestProtector()))
{
    var existingLibrary = new NativeCommandLibrary(existingCommandStore);
    var group = existingLibrary.SaveGroup(null, "Personal");
    existingLibrary.SaveSnippet(null, group.Id, "My command", "printf user", false);
    Check(!existingLibrary.SeedDefaultSnippets(key => key) && existingLibrary.ListGroups().Count == 1
        && existingLibrary.ListSnippets().Single().Name == "My command",
        "Existing command data suppresses built-ins and records the one-time seed decision");
    existingLibrary.DeleteGroup(group.Id);
    Check(!existingLibrary.SeedDefaultSnippets(key => key) && existingLibrary.ListGroups().Count == 0,
        "Existing user data is never replaced by later default seeding");
}
using (var duplicateStore = new NativeStore(Path.Combine(root, "command-duplicates-" + Guid.NewGuid().ToString("N")), new TestProtector()))
{
    var duplicateLibrary = new NativeCommandLibrary(duplicateStore);
    var firstGroup = duplicateLibrary.SaveGroup(null, "First");
    var secondGroup = duplicateLibrary.SaveGroup(null, "Second");
    var first = duplicateLibrary.SaveSnippet(null, firstGroup.Id, "Original", "printf one\r\nprintf two", true);
    var second = duplicateLibrary.SaveSnippet(null, firstGroup.Id, "Alternate", "printf one\nprintf two", false);
    duplicateLibrary.SaveSnippet(null, secondGroup.Id, "Other group", "printf one\nprintf two", false);
    duplicateLibrary.SaveSnippet(null, firstGroup.Id, "Case differs", "printf ONE\nprintf two", false);
    duplicateLibrary.SaveSnippet(null, firstGroup.Id, "Whitespace differs", "printf  one\nprintf two", false);
    var duplicateGroups = duplicateLibrary.FindDuplicates();
    Check(duplicateGroups.Count == 1 && new HashSet<string>(duplicateGroups[0].Snippets.Select(item => item.Id), StringComparer.Ordinal).SetEquals([first.Id, second.Id]),
        "Duplicate detection normalizes CRLF/LF, preserves other text, and scopes matches to one group");
    Reject(() => duplicateLibrary.RemoveDuplicates([
        new NativeSnippetDuplicateSelection(duplicateGroups[0].Key, "not-a-member",
            duplicateGroups[0].Snippets.Select(item => item.Id).ToArray())
    ]), "Duplicate cleanup rejects a survivor that is not part of the matching command group");
    Check(duplicateLibrary.ListSnippets(firstGroup.Id).Count == 4, "Rejected duplicate cleanup leaves every command intact");
    Reject(() => duplicateLibrary.RemoveDuplicates([
        new NativeSnippetDuplicateSelection(duplicateGroups[0].Key, second.Id, [first.Id])
    ]), "Duplicate cleanup rejects a stale preview membership list");
    Check(duplicateLibrary.ListSnippets(firstGroup.Id).Count == 4, "Stale duplicate cleanup leaves every command intact");
    var removed = duplicateLibrary.RemoveDuplicates([
        new NativeSnippetDuplicateSelection(duplicateGroups[0].Key, second.Id,
            duplicateGroups[0].Snippets.Select(item => item.Id).ToArray())
    ]);
    Check(removed == 1 && duplicateLibrary.ListSnippets(firstGroup.Id).Any(item => item.Id == second.Id)
        && !duplicateLibrary.ListSnippets(firstGroup.Id).Any(item => item.Id == first.Id)
        && duplicateLibrary.ListSnippets(secondGroup.Id).Single().Name == "Other group",
        "Duplicate cleanup honors the selected survivor and preserves other groups atomically");
}
using (var aiStore = new NativeStore(Path.Combine(root, "ai-" + Guid.NewGuid().ToString("N")), new TestProtector())) {
    aiStore.Patch("settings", "settings", new() { ["aiAssistantEnabled"] = true });
    var handler = new FakeAiHandler(async (request, _) => {
        if (request.RequestUri!.AbsolutePath.EndsWith("/models", StringComparison.Ordinal))
            return new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("{\"data\":[{\"id\":\"model-a\"}]}") };
        var body = await request.Content!.ReadAsStringAsync();
        var nonStreaming = JsonNode.Parse(body)?["stream"]?.GetValue<bool>() == false;
        return new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent(
            nonStreaming
                ? "{\"choices\":[{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"native-\"},{\"type\":\"text\",\"text\":\"complete\"}]}}]}"
                : "data: {\"choices\":[{\"delta\":{\"content\":\"native\"}}]}\n\ndata: [DONE]\n",
            Encoding.UTF8,
            nonStreaming ? "application/json" : "text/event-stream") };
    });
    using var http = new HttpClient(handler);
    using var ai = new NativeAiService(aiStore, http);
    var provider = ai.SaveProvider(new(null, "Local", new Uri("http://127.0.0.1:8000"), "model-a", true, "api-secret"));
    Check(provider.BaseUrl.AbsolutePath == "/v1" && provider.HasToken, "Native AI endpoint defaults to OpenAI-compatible v1 and stores token reference");
    var connectionTest = await ai.TestConnectionAsync(provider.Id);
    Check(handler.LastAuthorization == "Bearer api-secret", "Native AI resolves encrypted token per request");
    var connectionPayload = JsonNode.Parse(handler.LastBody!)!.AsObject();
    Check(connectionTest.Model == "model-a" && connectionPayload["stream"]?.GetValue<bool>() == false
        && connectionPayload["max_tokens"]?.GetValue<int>() == 64
        && connectionPayload["messages"]?[0]?["content"]?.GetValue<string>() == "ping"
        && handler.LastAccept == "application/json",
        "Native AI connection test probes chat completions like Electron and returns model latency");
    var models = await ai.DiscoverModelsAsync(provider.BaseUrl, "api-secret");
    Check(models.Single().Id == "model-a", "Native AI model discovery parses the provider response");
    using (var emptyModelsHttp = new HttpClient(new FakeAiHandler((_, _) => Task.FromResult(
        new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("{\"data\":[]}") }))))
    using (var emptyModelsService = new NativeAiService(aiStore, emptyModelsHttp))
    {
        var noModelsRejected = false;
        try { await emptyModelsService.DiscoverModelsAsync(provider.BaseUrl, "api-secret"); } catch (InvalidDataException) { noModelsRejected = true; }
        Check(noModelsRejected, "Native AI model discovery rejects an empty provider model list like Electron");
    }
    var chunks = new List<string>(); await foreach (var chunk in ai.StreamChatAsync(provider.Id, [new("user", "hello")])) chunks.Add(chunk);
    Check(string.Concat(chunks) == "native", "Native AI streaming yields response deltas");
    var streamingPayload = JsonNode.Parse(handler.LastBody!)!.AsObject();
    Check(streamingPayload["temperature"]?.GetValue<double>() == 0.7 && streamingPayload["max_tokens"]?.GetValue<int>() == 4096
        && handler.LastAccept == "text/event-stream, application/json",
        "Native AI streaming request keeps Electron temperature, response limits and Accept negotiation");
    var completed = await ai.CompleteChatAsync(provider.Id, [new("user", "hello")]);
    var nonStreamingPayload = JsonNode.Parse(handler.LastBody!)!.AsObject();
    Check(completed == "native-complete" && nonStreamingPayload["stream"]?.GetValue<bool>() == false
        && nonStreamingPayload["temperature"]?.GetValue<double>() == 0.7 && nonStreamingPayload["max_tokens"]?.GetValue<int>() == 4096
        && handler.LastAccept == "application/json",
        "Native AI non-streaming mode preserves Electron request semantics and joins text content parts");
    var imageData = "data:image/png;base64," + Convert.ToBase64String(Convert.FromHexString("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000B49444154789C636000020000050001A5F645400000000049454E44AE426082"));
    var capability = await ai.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, "api-secret");
    Check(capability.Outcome == "accepted" && capability.Image == "yes", "Native AI image capability probe uses a bounded PNG request");
    using (var invalidImageHttp = new HttpClient(new FakeAiHandler((_, _) => Task.FromResult(
        new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("<html>ok</html>") }))))
    using (var invalidImageService = new NativeAiService(aiStore, invalidImageHttp))
    {
        var invalidCapability = await invalidImageService.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, "api-secret");
        Check(invalidCapability.Outcome == "inconclusive", "Native AI image capability probe rejects a successful non-JSON body");
    }
    using (var unsupportedImageHttp = new HttpClient(new FakeAiHandler((_, _) => Task.FromResult(
        new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.BadRequest) { Content = new System.Net.Http.StringContent("{\"error\":{\"code\":\"unsupported_image_input\",\"message\":\"vision not supported\"}}") }))))
    using (var unsupportedImageService = new NativeAiService(aiStore, unsupportedImageHttp))
    {
        var unsupportedCapability = await unsupportedImageService.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, "api-secret");
        Check(unsupportedCapability.Outcome == "unsupported" && unsupportedCapability.Image == "no", "Native AI image capability probe recognizes explicit provider image limitations");
    }
    using (var inconclusiveImageHttp = new HttpClient(new FakeAiHandler((_, _) => Task.FromResult(
        new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.BadRequest) { Content = new System.Net.Http.StringContent("{\"error\":{\"code\":\"bad_request\",\"message\":\"invalid prompt\"}}") }))))
    using (var inconclusiveImageService = new NativeAiService(aiStore, inconclusiveImageHttp))
    {
        var inconclusiveCapability = await inconclusiveImageService.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, "api-secret");
        Check(inconclusiveCapability.Outcome == "inconclusive" && inconclusiveCapability.Image == "unknown", "Native AI image capability probe keeps generic provider errors inconclusive");
    }
    var imageChunks = new List<string>(); await foreach (var chunk in ai.StreamChatAsync(provider.Id, [new("user", "describe", [new(imageData, "low")])])) imageChunks.Add(chunk);
    var imagePayload = JsonNode.Parse(handler.LastBody ?? "{}")!.AsObject();
    Check(imagePayload["messages"]?[0]?["content"] is JsonArray imageContent && imageContent.OfType<JsonObject>().Any(item => item["type"]?.GetValue<string>() == "image_url"), "Native AI sends multimodal messages as image_url content parts");
    var invalidImageRejected = false;
    try { await foreach (var _ in ai.StreamChatAsync(provider.Id, [new("user", "bad", [new("data:image/png;base64,not-base64")])])) { } } catch (ArgumentException) { invalidImageRejected = true; }
    Check(invalidImageRejected, "Native AI rejects malformed image data before network I/O");
    var tooManyMessagesRejected = false;
    try { await foreach (var _ in ai.StreamChatAsync(provider.Id, Enumerable.Repeat(new AiChatMessage("user", "x"), 65).ToArray())) { } } catch (ArgumentException) { tooManyMessagesRejected = true; }
    Check(tooManyMessagesRejected, "Native AI enforces Electron's message count limit");
    var tooManyContentPartsRejected = false;
    try { await foreach (var _ in ai.StreamChatAsync(provider.Id, [new("user", "text", Enumerable.Repeat(new AiImageAttachment(imageData), 32).ToArray())])) { } } catch (ArgumentException) { tooManyContentPartsRejected = true; }
    Check(tooManyContentPartsRejected, "Native AI enforces Electron's per-message multimodal content part limit");
    Reject(() => ai.SaveProvider(new(null, "Insecure", new Uri("http://example.com"), "model-a", true, null)), "Native AI rejects non-loopback HTTP endpoints");

    var originalReference = aiStore.Find("aiProfiles", provider.Id)!["apiKeyRef"]!.GetValue<string>();
    var replaced = ai.SaveProvider(new(provider.Id, provider.Name, provider.BaseUrl, provider.Model, provider.Enabled, "replacement-secret"));
    var sharedReference = aiStore.Find("aiProfiles", provider.Id)!["apiKeyRef"]!.GetValue<string>();
    Check(replaced.HasToken && sharedReference != originalReference && aiStore.ReadSecret(originalReference) == null,
        "Replacing AI token removes the now-unreferenced encrypted secret");
    aiStore.Save("aiProfiles", "shared-ai-profile", new JsonObject {
        ["id"] = "shared-ai-profile", ["name"] = "Shared", ["baseUrl"] = "https://example.com/v1", ["model"] = "shared-model",
        ["enabled"] = true, ["apiKeyRef"] = sharedReference, ["createdAt"] = 1, ["updatedAt"] = 1
    });
    ai.DeleteProvider(provider.Id);
    Check(aiStore.ReadSecret(sharedReference) == "replacement-secret" && aiStore.Find("aiProfiles", provider.Id) == null,
        "Deleting one AI provider retains a credential referenced by another profile");
    ai.DeleteProvider("shared-ai-profile");
    Check(aiStore.ReadSecret(sharedReference) == null, "Deleting the last AI provider reference removes its encrypted secret");

    var clearTest = ai.SaveProvider(new(null, "Clear token", new Uri("https://example.com/v1"), "clear-model", true, "clear-secret"));
    var clearReference = aiStore.Find("aiProfiles", clearTest.Id)!["apiKeyRef"]!.GetValue<string>();
    var cleared = ai.SaveProvider(new(clearTest.Id, clearTest.Name, clearTest.BaseUrl, clearTest.Model, clearTest.Enabled, null, true));
    Check(!cleared.HasToken && aiStore.ReadSecret(clearReference) == null, "Clearing AI token removes an unreferenced secret atomically");
    ai.DeleteProvider(clearTest.Id);

    var legacyReference = aiStore.SaveSecret("legacy-ai-secret");
    aiStore.Save("aiProviders", "legacy-ai", new JsonObject {
        ["id"] = "legacy-ai", ["name"] = "Legacy", ["baseUrl"] = "https://example.com/v1", ["model"] = "legacy-model",
        ["enabled"] = true, ["tokenRef"] = legacyReference, ["createdAt"] = 1, ["updatedAt"] = 1
    });
    var migrated = ai.SaveProvider(new("legacy-ai", "Legacy updated", new Uri("https://example.com/v1"), "legacy-model", true, null));
    Check(migrated.HasToken && aiStore.Find("aiProviders", "legacy-ai") == null && ai.GetToken("legacy-ai") == "legacy-ai-secret",
        "Saving a legacy provider atomically consolidates tokenRef into apiKeyRef");

    var beforeSecretCount = 0L;
    using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = aiStore.DatabasePath, Mode = SqliteOpenMode.ReadOnly }.ToString())) {
        db.Open(); using var count = db.CreateCommand(); count.CommandText = "SELECT COUNT(*) FROM secrets"; beforeSecretCount = (long)count.ExecuteScalar()!;
    }
    Reject(() => aiStore.SaveWithSecret("aiProfiles", "legacy-ai", new JsonObject { ["id"] = "legacy-ai", ["apiKeyRef"] = legacyReference },
        "apiKeyRef", "must-rollback", false, 0), "Stale AI secret/entity write rejected");
    using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = aiStore.DatabasePath, Mode = SqliteOpenMode.ReadOnly }.ToString())) {
        db.Open(); using var count = db.CreateCommand(); count.CommandText = "SELECT COUNT(*) FROM secrets";
        Check((long)count.ExecuteScalar()! == beforeSecretCount && ai.GetToken("legacy-ai") == "legacy-ai-secret",
            "Failed AI credential transaction leaves entity and encrypted secrets unchanged");
    }
    ai.DeleteProvider("legacy-ai");

    var duplicateIdProvider = ai.SaveProvider(new(null, "Duplicate ID", new Uri("https://example.com/v1"), "duplicate-model", true, "canonical-secret"));
    var duplicateLegacyReference = aiStore.SaveSecret("duplicate-legacy-secret");
    aiStore.Save("aiProviders", duplicateIdProvider.Id, new JsonObject {
        ["id"] = duplicateIdProvider.Id, ["name"] = "Old duplicate", ["baseUrl"] = "https://example.com/v1", ["model"] = "old-model",
        ["enabled"] = true, ["tokenRef"] = duplicateLegacyReference, ["createdAt"] = 1, ["updatedAt"] = 1
    });
    var mergedDuplicate = ai.SaveProvider(new(duplicateIdProvider.Id, "Duplicate ID", duplicateIdProvider.BaseUrl, duplicateIdProvider.Model, true, null));
    Check(mergedDuplicate.HasToken && aiStore.Find("aiProviders", duplicateIdProvider.Id) == null && aiStore.ReadSecret(duplicateLegacyReference) == null,
        "Saving a duplicated canonical/legacy AI ID consolidates records and drops only the obsolete legacy secret");
    var duplicateCanonicalReference = aiStore.Find("aiProfiles", duplicateIdProvider.Id)!["apiKeyRef"]!.GetValue<string>();
    var duplicateDeleteReference = aiStore.SaveSecret("delete-duplicate-secret");
    aiStore.Save("aiProviders", duplicateIdProvider.Id, new JsonObject {
        ["id"] = duplicateIdProvider.Id, ["name"] = "Old duplicate", ["baseUrl"] = "https://example.com/v1", ["model"] = "old-model",
        ["enabled"] = true, ["tokenRef"] = duplicateDeleteReference, ["createdAt"] = 1, ["updatedAt"] = 1
    });
    ai.DeleteProvider(duplicateIdProvider.Id);
    Check(aiStore.Find("aiProfiles", duplicateIdProvider.Id) == null && aiStore.Find("aiProviders", duplicateIdProvider.Id) == null &&
        aiStore.ReadSecret(duplicateCanonicalReference) == null && aiStore.ReadSecret(duplicateDeleteReference) == null,
        "Deleting duplicate canonical/legacy AI IDs removes both rows and cleans both unreferenced secrets");

    var disabledProvider = ai.SaveProvider(new(null, "Disabled provider", new Uri("http://127.0.0.1:8000"), "model-a", true, "disabled-secret"));
    aiStore.Patch("settings", "settings", new() { ["aiAssistantEnabled"] = false });
    var discoveryRejected = false;
    try { await ai.DiscoverModelsAsync(disabledProvider.BaseUrl, ai.GetToken(disabledProvider.Id)); } catch (InvalidOperationException) { discoveryRejected = true; }
    Check(discoveryRejected, "Native AI feature switch blocks model discovery when disabled");
    var connectionRejected = false;
    try { await ai.TestConnectionAsync(disabledProvider.Id); } catch (InvalidOperationException) { connectionRejected = true; }
    Check(connectionRejected, "Native AI feature switch blocks connection tests when disabled");
    var imageRejected = false;
    try { await ai.TestImageCapabilityAsync(disabledProvider.BaseUrl, disabledProvider.Model, ai.GetToken(disabledProvider.Id)); } catch (InvalidOperationException) { imageRejected = true; }
    Check(imageRejected, "Native AI feature switch blocks image probes when disabled");
    var chatRejected = false;
    try { await foreach (var _ in ai.StreamChatAsync(disabledProvider.Id, [new("user", "hello")])) { } } catch (InvalidOperationException) { chatRejected = true; }
    Check(chatRejected, "Native AI feature switch blocks conversation requests when disabled");
}
using (var forwardStore = new NativeStore(Path.Combine(root, "forwards-" + Guid.NewGuid().ToString("N")), new TestProtector()))
{
    var profileId = "profile-forward";
    forwardStore.Save("profiles", profileId, new JsonObject {
        ["id"] = profileId, ["name"] = "Forward test", ["host"] = "127.0.0.1", ["port"] = 22,
        ["username"] = "tester", ["auth"] = new JsonObject { ["method"] = "password" }
    });
    var parsed = NativeForwardRule.FromJson(new JsonObject {
        ["id"] = "forward-1", ["profileId"] = profileId, ["type"] = "local", ["label"] = "Web",
        ["bindAddr"] = "127.0.0.1", ["bindPort"] = 18080, ["dstHost"] = "127.0.0.1", ["dstPort"] = 8080,
        ["autoStart"] = true, ["_revision"] = 0
    });
    Check(parsed.Type == NativeForwardType.Local && parsed.AutoStart && parsed.DestinationPort == 8080, "Forward rule follows shared fields");
    Reject(() => NativeForwardRule.FromJson(new JsonObject {
        ["id"] = "bad", ["profileId"] = profileId, ["type"] = "local", ["label"] = "bad",
        ["bindAddr"] = "127.0.0.1", ["bindPort"] = 0, ["dstHost"] = "127.0.0.1", ["dstPort"] = 80
    }), "Forward rule rejects invalid port");
    using var managerSessions = new NativeSessionManager(forwardStore);
    using var forwards = new NativeForwardManager(forwardStore, managerSessions);
    var savedForward = forwards.SaveRule(parsed);
    Check(forwards.ListRules().Single().Revision == savedForward.Revision && forwards.RuntimeOf(parsed.Id).State == NativeForwardState.Stopped, "Forward rules persist with runtime state");
    Reject(() => forwards.SaveRule(parsed with { Revision = 0 }), "Forward stale writer rejected");
    forwards.DeleteRule(parsed.Id, savedForward.Revision);
    Check(forwards.ListRules().Count == 0, "Forward deletion uses CAS");
}
var lanSenderDirectory = Path.Combine(root, "lansync-sender-" + Guid.NewGuid().ToString("N"));
var lanReceiverDirectory = Path.Combine(root, "lansync-receiver-" + Guid.NewGuid().ToString("N"));
using (var lanSenderStore = new NativeStore(lanSenderDirectory, new TestProtector()))
using (var lanReceiverStore = new NativeStore(lanReceiverDirectory, new TestProtector()))
using (var receiver = new NativeLanSyncService(lanReceiverStore, "Receiver test"))
using (var sender = new NativeLanSyncService(lanSenderStore, "Sender test"))
{
    var tokenRef = lanSenderStore.SaveSecret("sync-secret");
    lanSenderStore.Save("profiles", "sync-profile", new JsonObject {
        ["id"] = "sync-profile", ["name"] = "Synced host", ["host"] = "host.example", ["port"] = 22,
        ["username"] = "tester", ["auth"] = new JsonObject { ["method"] = "password", ["passwordRef"] = tokenRef }
    });
    var state = await receiver.StartReceiveAsync();
    Check(state.Phase == "waiting" && state.PairingCode?.Length == 6 && state.TcpPort is > 0, "LAN sync receiver publishes a pairing code and TCP port");
    await sender.SendAsync("127.0.0.1", state.TcpPort!.Value, state.PairingCode!);
    Check(receiver.State.Phase == "incoming" && receiver.State.Incoming?.Import.Profiles == 1 && receiver.State.Incoming.Import.SecretCount == 1, "LAN sync authenticates and previews an encrypted v2 envelope");
    var syncPreview = receiver.State.Incoming!;
    var malformedSelected = new ImportPreview(new() { ["profiles"] = new JsonArray(new JsonObject { ["name"] = "missing id" }) }, new(), 0, 0, []);
    await RejectAsync(() => receiver.ApplyIncomingAsync(syncPreview.Token, ImportConflict.Overwrite, selected: malformedSelected), "LAN sync rolls back a failed selected import");
    Check(receiver.State.Phase == "incoming" && receiver.State.Incoming?.Token == syncPreview.Token,
        "Failed LAN sync import returns to the same retryable confirmation");
    var syncResult = await receiver.ApplyIncomingAsync(syncPreview.Token, ImportConflict.Overwrite);
    Check(syncResult.Profiles == 1 && syncResult.Secrets == 1 && lanReceiverStore.List("profiles").Count == 1,
        "LAN sync applies the user-approved preview once and reports actual writes");
    var receivedProfile = lanReceiverStore.Find("profiles", "sync-profile")!;
    Check(lanReceiverStore.ReadSecret(receivedProfile["auth"]!["passwordRef"]!.GetValue<string>()) == "sync-secret", "LAN sync re-encrypts received credentials into the native secret store");
    for (var attempt = 0; attempt < 50 && sender.State.Phase != "applied"; attempt++) await Task.Delay(20);
    Check(sender.State.Phase == "applied", "LAN sync sends the import receipt to its peer");
    Check(sender.State.LastResult?.Profiles == 1 && sender.State.LastResult.Secrets == 1,
        "LAN sync exposes applied counts from the peer receipt");
    var rotatedCode = receiver.State.PairingCode!;
    var incorrectCode = rotatedCode == "000001" ? "000002" : "000001";
    var rejected = false; try { await sender.SendAsync("127.0.0.1", state.TcpPort.Value, incorrectCode); } catch (UnauthorizedAccessException) { rejected = true; }
    Check(rejected && receiver.State.Phase == "waiting" && receiver.State.PairingCode != rotatedCode, "LAN sync burns a pairing code after a failed online guess");
}
var invalidFrame = new byte[4]; System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(invalidFrame, uint.MaxValue);
Reject(() => NativeLanSyncProtocol.DecodeFrame(invalidFrame), "LAN sync rejects oversized frame before buffering");
#pragma warning disable CA1416
var instanceRoot = Path.Combine(root, "instances-" + Guid.NewGuid().ToString("N"));
using (var primaryInstance = new NativeInstanceCoordinator(instanceRoot))
using (var secondaryInstance = new NativeInstanceCoordinator(instanceRoot))
{
    var focused = false; primaryInstance.FocusRequested += () => focused = true;
    var primaryRole = primaryInstance.Start(); var secondaryRole = await Task.Run(() => secondaryInstance.Start());
    Check(primaryRole == NativeInstanceRole.Primary && secondaryRole == NativeInstanceRole.Secondary, "Native instances elect one primary writer");
    Check(await secondaryInstance.RequestFocusAsync() && focused, "Secondary instance focuses the primary over a current-user pipe");
    Check(await secondaryInstance.NotifyConfigurationChangedAsync("profiles", 2), "Secondary instance can publish a configuration revision");
}
#pragma warning restore CA1416
var updateStateDirectory = Path.Combine(root, "update-state-" + Guid.NewGuid().ToString("N"));
using (var updateStore = new NativeStore(Path.Combine(root, "update-store-" + Guid.NewGuid().ToString("N")), new TestProtector()))
using (var updateSessions = new NativeSessionManager(updateStore))
using (var updateTransfers = new NativeTransferQueue(updateSessions))
using (var updateForwards = new NativeForwardManager(updateStore, updateSessions))
using (var signer = RSA.Create(2048))
{
    var updatePath = Path.Combine(root, "native-update-test.exe"); var updateBytes = Encoding.UTF8.GetBytes("signed-test-installer"); File.WriteAllBytes(updatePath, updateBytes);
    var digest = Convert.ToHexString(SHA256.HashData(updateBytes)).ToLowerInvariant();
    var signature = Convert.ToBase64String(signer.SignData(Encoding.UTF8.GetBytes($"1.2.3\npreview\n{digest}\n"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
    var artifact = new NativeUpdateArtifact("1.2.3", updatePath, digest, signature, "preview");
    var updates = new NativeUpdateCoordinator(updateSessions, updateTransfers, updateForwards, signer.ExportSubjectPublicKeyInfoPem(), updateStateDirectory);
    updates.VerifyArtifact(artifact);
    Check(!updates.PrepareInstall().NeedsConfirmation && updates.PrepareInstall().Allowed, "Native update gate allows install when the application is idle");
    updates.MarkInstallStarted(artifact); Check(updates.RecoverInterruptedInstall() == artifact.Version, "Native update coordinator records interrupted-install recovery state");
    File.AppendAllText(updatePath, "tamper"); Reject(() => updates.VerifyArtifact(artifact), "Native update verifies the package hash before launch");
    updates.MarkInstallCompleted(); File.Delete(updatePath);
}
await NativeUpdateServiceContractTests.RunAsync(Check, root);
var editorPath = Path.Combine(root, "editor-" + Guid.NewGuid().ToString("N") + ".txt");
File.WriteAllBytes(editorPath, [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes("第一行\r\n第二行\r\n")]);
var editorDocument = await NativeEditorDocument.LoadAsync(editorPath);
Check(editorDocument.Encoding == NativeTextEncoding.Utf8Bom && editorDocument.NewLine == "\r\n" && editorDocument.Text.Contains("第二行"), "Native editor preserves UTF-8 BOM and CRLF metadata");
await editorDocument.SaveAsync(editorPath, "更新\n内容");
var savedEditorBytes = File.ReadAllBytes(editorPath);
Check(savedEditorBytes.AsSpan(0, 3).SequenceEqual(new byte[] { 0xEF, 0xBB, 0xBF }) && Encoding.UTF8.GetString(savedEditorBytes[3..]).Contains("更新\r\n内容"), "Native editor saves with the original BOM and newline format");
File.Delete(editorPath);
var codecBytes = NativeTextCodec.Encode("第一行\r\n第二行\r\n", NativeTextEncoding.Utf8Bom, true);
var codecInfo = NativeTextCodec.Detect(codecBytes);
var codecText = NativeTextCodec.Decode(codecBytes, codecInfo.Encoding, codecInfo.BomLength);
Check(codecInfo.Encoding == NativeTextEncoding.Utf8Bom && NativeTextCodec.IsLossless(codecText, codecBytes, codecInfo.Encoding, true), "Native text codec preserves UTF-8 BOM and bytes");
Check(NativeTextCodec.NormalizeToLf(codecText) == "第一行\n第二行\n", "Native text codec normalizes editor line endings");
var parsedGroup = ConnectionGroup.FromJson(new JsonObject { ["id"] = "group-1", ["name"] = "Production", ["order"] = 1, ["_revision"] = 2 });
Check(parsedGroup.Name == "Production" && parsedGroup.Revision == 2, "Native connection group contract parses order and revision");
var referenceStorePath = Path.Combine(root, "references-" + Guid.NewGuid().ToString("N"));
using (var referenceStore = new NativeStore(referenceStorePath, new TestProtector()))
{
    referenceStore.Save("privateKeys", "key-1", new JsonObject { ["id"] = "key-1", ["name"] = "Deploy", ["path"] = "C:/deploy.key" });
    referenceStore.Save("profiles", "profile-key", new JsonObject {
        ["id"] = "profile-key", ["name"] = "Production", ["host"] = "host.example", ["port"] = 22, ["username"] = "root",
        ["auth"] = new JsonObject { ["method"] = "privateKey", ["privateKeyId"] = "key-1" }
    });
    Check(referenceStore.FindReferences("key-1").Count == 1, "Native store reports saved key references before deletion");
    _ = new NativeSettings("dark", "zh-CN", true, 125, 1500, "recent", "group").Save(referenceStore);
    var storedSettings = NativeSettings.Load(referenceStore);
    Check(storedSettings.ConnectionSort == "recent" && storedSettings.ConnectionGrouping == "group", "Connection sorting and grouping preferences persist");
    var firstGroupRevision = referenceStore.Save("groups", "group-first", new JsonObject { ["id"] = "group-first", ["name"] = "First", ["order"] = 0 });
    var secondGroupRevision = referenceStore.Save("groups", "group-second", new JsonObject { ["id"] = "group-second", ["name"] = "Second", ["order"] = 1 });
    referenceStore.ReorderConnectionGroups([("group-second", 0d, secondGroupRevision), ("group-first", 1d, firstGroupRevision)]);
    Check(referenceStore.Find("groups", "group-second")?["order"]?.GetValue<double>() == 0d && referenceStore.Find("groups", "group-first")?["order"]?.GetValue<double>() == 1d, "Connection group order is persisted atomically");
    var reorderedFirst = referenceStore.Find("groups", "group-first")!;
    var reorderedSecond = referenceStore.Find("groups", "group-second")!;
    _ = referenceStore.Save("groups", "group-second", new JsonObject { ["id"] = "group-second", ["name"] = "Second", ["order"] = 2 }, reorderedSecond["_revision"]!.GetValue<long>());
    Reject(() => referenceStore.ReorderConnectionGroups([
        ("group-first", 0d, reorderedFirst["_revision"]!.GetValue<long>()),
        ("group-second", 1d, reorderedSecond["_revision"]!.GetValue<long>())]), "Connection group reorder rejects a stale participant");
    Check(referenceStore.Find("groups", "group-first")?["order"]?.GetValue<double>() == 1d && referenceStore.Find("groups", "group-first")?["_revision"]?.GetValue<long>() == reorderedFirst["_revision"]?.GetValue<long>(), "Rejected group reorder rolls back every update");
    var groupRevision = referenceStore.Save("groups", "group-delete", new JsonObject { ["id"] = "group-delete", ["name"] = "Deploy", ["order"] = 0 });
    referenceStore.Save("profiles", "profile-group", new JsonObject { ["id"] = "profile-group", ["name"] = "Deploy host", ["groupId"] = "group-delete" });
    Reject(() => referenceStore.DeleteConnectionGroup("group-delete", groupRevision - 1), "Connection group deletion rejects stale revisions");
    Check(referenceStore.Find("groups", "group-delete") != null && referenceStore.Find("profiles", "profile-group")?["groupId"]?.GetValue<string>() == "group-delete", "Stale group deletion leaves profiles unchanged");
    referenceStore.DeleteConnectionGroup("group-delete", groupRevision);
    Check(referenceStore.Find("groups", "group-delete") == null && referenceStore.Find("profiles", "profile-group")?["groupId"] == null, "Connection group deletion atomically detaches linked profiles");
}
var frameBuffer = new NativeRdpFrameBuffer();
var firstPatch = new byte[24 + 2 * 2 * 4];
BinaryPrimitives.WriteInt32LittleEndian(firstPatch.AsSpan(0), 0);
BinaryPrimitives.WriteInt32LittleEndian(firstPatch.AsSpan(4), 0);
BinaryPrimitives.WriteUInt32LittleEndian(firstPatch.AsSpan(8), 2);
BinaryPrimitives.WriteUInt32LittleEndian(firstPatch.AsSpan(12), 2);
BinaryPrimitives.WriteUInt32LittleEndian(firstPatch.AsSpan(16), 8);
BinaryPrimitives.WriteUInt32LittleEndian(firstPatch.AsSpan(20), 16);
for (var index = 24; index < firstPatch.Length; index++) firstPatch[index] = 0x11;
frameBuffer.Apply(new NativeRdpFrame(1, 320, 320, firstPatch));
var secondPatch = new byte[24 + 4];
BinaryPrimitives.WriteInt32LittleEndian(secondPatch.AsSpan(0), 1);
BinaryPrimitives.WriteInt32LittleEndian(secondPatch.AsSpan(4), 1);
BinaryPrimitives.WriteUInt32LittleEndian(secondPatch.AsSpan(8), 1);
BinaryPrimitives.WriteUInt32LittleEndian(secondPatch.AsSpan(12), 1);
BinaryPrimitives.WriteUInt32LittleEndian(secondPatch.AsSpan(16), 4);
BinaryPrimitives.WriteUInt32LittleEndian(secondPatch.AsSpan(20), 4);
secondPatch[24] = 0x99;
frameBuffer.Apply(new NativeRdpFrame(2, 320, 320, secondPatch));
var retained = frameBuffer.CopyPixels(out var frameWidth, out var frameHeight)!;
Check(frameWidth == 320 && frameHeight == 320 && retained[0] == 0x11 && retained[(320 + 1) * 4] == 0x99, "Native RDP dirty rectangles retain and update the Win2D frame");
Reject(() => frameBuffer.Apply(new NativeRdpFrame(3, 320, 320, new byte[24])), "Native RDP rejects empty dirty rectangle payload");
await NativeFileSafetyCases.RunAsync(Check, root);
NativeMonitorContractTests.Run(Check);
NativeForwardTelemetryContractTests.Run(Check);
Console.WriteLine($"{passed} native contract checks passed");

static string FindWorkspaceRoot()
{
    for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        if (File.Exists(Path.Combine(directory.FullName, "windows", "OpenFinalShell.Core", "OpenFinalShell.Core.csproj")))
            return directory.FullName;
    throw new DirectoryNotFoundException("Could not locate the OpenFinalShell workspace root.");
}

// Tests deliberately use an ephemeral test wrapper. Production uses CurrentUser DPAPI only.
sealed class TestProtector : ISecretProtector {
    private static readonly byte[] Key = SHA256.HashData(Encoding.UTF8.GetBytes("test-only-key"));
    public byte[] Protect(byte[] value) => value.Select((b,i) => (byte)(b ^ Key[i%32])).ToArray();
    public byte[] Unprotect(byte[] value) => Protect(value);
}

sealed class FakeAiHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler {
    public string? LastAuthorization { get; private set; }
    public string? LastBody { get; private set; }
    public string? LastAccept { get; private set; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
        LastAuthorization = request.Headers.Authorization?.ToString();
        LastAccept = string.Join(", ", request.Headers.Accept.Select(item => item.MediaType));
        LastBody = request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        return await respond(request, cancellationToken);
    }
}
