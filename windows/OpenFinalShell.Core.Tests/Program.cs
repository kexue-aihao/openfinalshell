using OpenFinalShell.Core;
using OpenFinalShell.Core.Tests;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

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
foreach (var build in new[] { 19045, 21999, 22000, 22621 }) {
    var env = PlatformEnvironment.Resolve(10, build, 1);
    Check(env.Supported && (env.Profile == "windows-11") == (build >= 22000), $"Windows boundary {build}");
}
Check(!PlatformEnvironment.Resolve(10, 26100, 3).Supported && !PlatformEnvironment.Resolve(10, 26100, 3).MicaEligible, "Server conservative fallback");
Check(!PlatformEnvironment.Resolve(10, 17763, 1).Supported, "Unsupported Windows rejected");
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
    store.Import(preview, ImportConflict.Skip);
    var profile = store.List("profiles").Single();
    Check(store.ReadSecret(profile["auth"]!["passwordRef"]!.GetValue<string>()) == "secret-密码", "Imported secret remapped");
    store.Import(preview, ImportConflict.Skip);
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
    Check(library.ListGroups().Single().Name == "Operations" && library.ListSnippets(group.Id).Single().AutoEnter && snippet.Command == "ls -la", "Command library follows shared schema fields");
    library.AddHistory("session-a", "pwd"); library.AddHistory("session-b", "whoami");
    Check(library.ListHistory("session-a").SequenceEqual(["pwd"]), "Command history can be scoped to a session");
    library.ClearHistory("session-a"); Check(library.ListHistory("session-a").Count == 0 && library.ListHistory("session-b").Count == 1, "Command history clear is session scoped");
}
using (var aiStore = new NativeStore(Path.Combine(root, "ai-" + Guid.NewGuid().ToString("N")), new TestProtector())) {
    var handler = new FakeAiHandler((request, _) => {
        var response = request.RequestUri!.AbsolutePath.EndsWith("/models", StringComparison.Ordinal)
            ? new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("{\"data\":[{\"id\":\"model-a\"}]}") }
            : new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new System.Net.Http.StringContent("data: {\"choices\":[{\"delta\":{\"content\":\"native\"}}]}\n\ndata: [DONE]\n", Encoding.UTF8, "text/event-stream") };
        return Task.FromResult(response);
    });
    using var http = new HttpClient(handler);
    using var ai = new NativeAiService(aiStore, http);
    var provider = ai.SaveProvider(new(null, "Local", new Uri("http://127.0.0.1:8000"), "model-a", true, "api-secret"));
    Check(provider.BaseUrl.AbsolutePath == "/v1" && provider.HasToken, "Native AI endpoint defaults to OpenAI-compatible v1 and stores token reference");
    await ai.TestConnectionAsync(provider.Id);
    Check(handler.LastAuthorization == "Bearer api-secret", "Native AI resolves encrypted token per request");
    var models = await ai.DiscoverModelsAsync(provider.BaseUrl, "api-secret");
    Check(models.Single().Id == "model-a", "Native AI model discovery parses the provider response");
    var chunks = new List<string>(); await foreach (var chunk in ai.StreamChatAsync(provider.Id, [new("user", "hello")])) chunks.Add(chunk);
    Check(string.Concat(chunks) == "native", "Native AI streaming yields response deltas");
    var imageData = "data:image/png;base64," + Convert.ToBase64String(Convert.FromHexString("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000B49444154789C636000020000050001A5F645400000000049454E44AE426082"));
    var capability = await ai.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, "api-secret");
    Check(capability.Outcome == "accepted" && capability.Image == "yes", "Native AI image capability probe uses a bounded PNG request");
    var imageChunks = new List<string>(); await foreach (var chunk in ai.StreamChatAsync(provider.Id, [new("user", "describe", [new(imageData, "low")])])) imageChunks.Add(chunk);
    var imagePayload = JsonNode.Parse(handler.LastBody ?? "{}")!.AsObject();
    Check(imagePayload["messages"]?[0]?["content"] is JsonArray imageContent && imageContent.OfType<JsonObject>().Any(item => item["type"]?.GetValue<string>() == "image_url"), "Native AI sends multimodal messages as image_url content parts");
    var invalidImageRejected = false;
    try { await foreach (var _ in ai.StreamChatAsync(provider.Id, [new("user", "bad", [new("data:image/png;base64,not-base64")])])) { } } catch (ArgumentException) { invalidImageRejected = true; }
    Check(invalidImageRejected, "Native AI rejects malformed image data before network I/O");
    Reject(() => ai.SaveProvider(new(null, "Insecure", new Uri("http://example.com"), "model-a", true, null)), "Native AI rejects non-loopback HTTP endpoints");
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
    var syncResult = await receiver.ApplyIncomingAsync(syncPreview.Token, ImportConflict.Overwrite);
    Check(syncResult.Profiles == 1 && lanReceiverStore.List("profiles").Count == 1, "LAN sync applies the user-approved preview transactionally");
    var receivedProfile = lanReceiverStore.Find("profiles", "sync-profile")!;
    Check(lanReceiverStore.ReadSecret(receivedProfile["auth"]!["passwordRef"]!.GetValue<string>()) == "sync-secret", "LAN sync re-encrypts received credentials into the native secret store");
    for (var attempt = 0; attempt < 50 && sender.State.Phase != "applied"; attempt++) await Task.Delay(20);
    Check(sender.State.Phase == "applied", "LAN sync sends the import receipt to its peer");
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
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
        LastAuthorization = request.Headers.Authorization?.ToString();
        LastBody = request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        return await respond(request, cancellationToken);
    }
}
