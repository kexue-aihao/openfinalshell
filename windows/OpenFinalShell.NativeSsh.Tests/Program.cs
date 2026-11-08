using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using OpenFinalShell.Core;

var total = 0;
void Check(bool condition, string description)
{
    total++;
    if (!condition) throw new InvalidOperationException($"FAIL: {description}");
    Console.WriteLine($"PASS: {description}");
}

var values = new[]
{
    ("utf8", "你好、雪🙂"),
    ("gb18030", "中文与𠀀"),
    ("gbk", "中文测试"),
    ("big5", "繁體中文"),
    ("latin1", "café naïve")
};
foreach (var (charset, text) in values)
{
    var codec = new TerminalCharsetCodec(charset);
    var encodedRemote = codec.EncodeText(text);
    var cut = Math.Max(1, encodedRemote.Length / 2);
    var decoded = Encoding.UTF8.GetString(codec.DecodeRemote(encodedRemote.AsSpan(0, cut))) +
                  Encoding.UTF8.GetString(codec.DecodeRemote(encodedRemote.AsSpan(cut)));
    Check(decoded == text, $"{charset} remote output round-trips over split SSH chunks");

    var input = Encoding.UTF8.GetBytes(text);
    var inputCut = Math.Max(1, input.Length / 2);
    var encodedInput = codec.EncodeInput(input.AsSpan(0, inputCut)).Concat(codec.EncodeInput(input.AsSpan(inputCut))).ToArray();
    Check(TerminalCharsetCodec.Normalize(charset) == charset && Encoding.GetEncoding(CharsetCodePage(charset)).GetString(encodedInput) == text,
        $"{charset} UTF-8 terminal input converts to the selected remote encoding");
}

Check(TerminalCharsetCodec.Normalize("utf-8") == "utf8", "legacy utf-8 spelling normalizes compatibly");
Check(TerminalCharsetCodec.Normalize("CP936") == "gbk", "Windows code page aliases normalize");
try { _ = new TerminalCharsetCodec("windows-1252"); Check(false, "unsupported terminal charset is rejected"); }
catch (NotSupportedException) { Check(true, "unsupported terminal charset is rejected"); }

await TestAgentNamedPipeAsync();
await TestWindowsOpenSshPipeDiscoveryAsync();
await TestSshAuthSockUnixEndpointAsync();
TestPageantCopyDataTransport();
await TestJumpHostEndToEndAsync();
await TestForwardBridgeEndToEndAsync();
Console.WriteLine($"Native SSH contract checks passed: {total}");

static int CharsetCodePage(string charset) => charset switch
{
    "utf8" => 65001,
    "gb18030" => 54936,
    "gbk" => 936,
    "big5" => 950,
    "latin1" => 28591,
    _ => throw new ArgumentOutOfRangeException(nameof(charset))
};

async Task TestAgentNamedPipeAsync()
{
    var pipeName = "ofs-agent-test-" + Guid.NewGuid().ToString("N");
    var keyBlob = BuildSshString(Encoding.ASCII.GetBytes("ssh-ed25519"))
        .Concat(BuildSshString(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray())).ToArray();
    var signature = BuildSshString(Encoding.ASCII.GetBytes("ssh-ed25519"))
        .Concat(BuildSshString(Enumerable.Range(1, 64).Select(i => (byte)i).ToArray())).ToArray();
    uint observedFlags = uint.MaxValue;
    using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
    var serverTask = Task.Run(async () =>
    {
        await server.WaitForConnectionAsync();
        var identitiesRequest = await ReadAgentPacketAsync(server);
        if (identitiesRequest.Length != 1 || identitiesRequest[0] != 11) throw new InvalidDataException("Expected agent identities request.");
        using (var response = new MemoryStream())
        {
            response.WriteByte(12);
            WriteUInt32(response, 1);
            WriteAgentString(response, keyBlob);
            WriteAgentString(response, Encoding.UTF8.GetBytes("test-key"));
            await WriteAgentPacketAsync(server, response.ToArray());
        }
        server.Disconnect();
        await server.WaitForConnectionAsync();
        var signRequest = await ReadAgentPacketAsync(server);
        if (signRequest.Length < 1 || signRequest[0] != 13) throw new InvalidDataException("Expected agent sign request.");
        var offset = 1;
        _ = ReadAgentString(signRequest, ref offset);
        _ = ReadAgentString(signRequest, ref offset);
        observedFlags = BinaryPrimitives.ReadUInt32BigEndian(signRequest.AsSpan(offset, 4));
        using var signed = new MemoryStream();
        signed.WriteByte(14);
        WriteAgentString(signed, signature);
        await WriteAgentPacketAsync(server, signed.ToArray());
        server.Disconnect();
    });

    var previous = Environment.GetEnvironmentVariable("SSH_AUTH_SOCK");
    Environment.SetEnvironmentVariable("SSH_AUTH_SOCK", @"\\.\pipe\" + pipeName);
    var agent = NativeSshAgent.Discover();
    var identities = agent.ListIdentities();
    if (identities.Count != 1 || !identities[0].KeyBlob.SequenceEqual(keyBlob)) throw new InvalidOperationException("Agent identity parsing failed.");
    var signedResult = agent.Sign(keyBlob, [1, 2, 3, 4], 0);
    await serverTask.WaitAsync(TimeSpan.FromSeconds(5));
    Environment.SetEnvironmentVariable("SSH_AUTH_SOCK", previous);
    if (!signedResult.SequenceEqual(signature) || observedFlags != 0) throw new InvalidOperationException("Agent signature protocol failed.");
    total++;
    Console.WriteLine("PASS: SSH_AUTH_SOCK named pipe discovery and identity/signature protocol framing");
}

async Task TestWindowsOpenSshPipeDiscoveryAsync()
{
    if (!OperatingSystem.IsWindows()) return;
    var pipeName = "openssh-ssh-agent";
    var serverReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var serverTask = Task.Run(async () =>
    {
        for (var connection = 0; connection < 2; connection++)
        {
            using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            if (connection == 0) serverReady.TrySetResult();
            await server.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(5));
            if (connection == 0) continue; // Discover's pipe availability probe.
            var request = await ReadAgentPacketAsync(server);
            if (request.Length != 1 || request[0] != 11) throw new InvalidDataException("Expected identities request.");
            await WriteAgentPacketAsync(server, [12, 0, 0, 0, 0]);
        }
    });
    await serverReady.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var previous = Environment.GetEnvironmentVariable("SSH_AUTH_SOCK");
    Environment.SetEnvironmentVariable("SSH_AUTH_SOCK", null);
    var identities = NativeSshAgent.Discover().ListIdentities();
    await serverTask.WaitAsync(TimeSpan.FromSeconds(5));
    Environment.SetEnvironmentVariable("SSH_AUTH_SOCK", previous);
    if (identities.Count != 0) throw new InvalidOperationException("OpenSSH pipe fixture should have no identities.");
    total++;
    Console.WriteLine("PASS: Windows OpenSSH named pipe is discovered and speaks agent framing");
}

void TestPageantCopyDataTransport()
{
    if (!OperatingSystem.IsWindows()) return;
    using var pageant = new FakePageantWindow();
    var result = PageantTransport.SendToWindow(pageant.Handle, [11]);
    if (!result.SequenceEqual(new byte[] { 12, 0, 0, 0, 0 })) throw new InvalidOperationException("Pageant shared-memory response framing failed.");
    total++;
    Console.WriteLine("PASS: Pageant WM_COPYDATA/shared-memory request framing");
    if (NativeSshAgent.SelectEndpoint(null, true, false, true) != "pageant") throw new InvalidOperationException("Pageant fallback selection failed.");
    total++;
    Console.WriteLine("PASS: Pageant is selected when SSH_AUTH_SOCK and OpenSSH Agent are unavailable");
}

static async Task TestSshAuthSockUnixEndpointAsync()
{
    if (OperatingSystem.IsWindows() || !Socket.OSSupportsUnixDomainSockets) return;
    var socketPath = Path.Combine(Path.GetTempPath(), "a" + Guid.NewGuid().ToString("N")[..8] + ".sock");
    var keyBlob = BuildSshString(Encoding.ASCII.GetBytes("ssh-ed25519"))
        .Concat(BuildSshString(Enumerable.Range(0, 32).Select(i => (byte)(255 - i)).ToArray())).ToArray();
    var signature = BuildSshString(Encoding.ASCII.GetBytes("ssh-ed25519"))
        .Concat(BuildSshString(Enumerable.Range(1, 64).Select(i => (byte)(255 - i)).ToArray())).ToArray();
    uint observedFlags = uint.MaxValue;
    using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
    listener.Bind(new UnixDomainSocketEndPoint(socketPath)); listener.Listen(2);
    var serverTask = Task.Run(async () =>
    {
        for (var requestIndex = 0; requestIndex < 2; requestIndex++)
        {
            using var client = await listener.AcceptAsync().WaitAsync(TimeSpan.FromSeconds(5));
            using var network = new NetworkStream(client, ownsSocket: false);
            var packet = await ReadAgentPacketAsync(network);
            if (requestIndex == 0)
            {
                using var response = new MemoryStream(); response.WriteByte(12); WriteUInt32(response, 1);
                WriteAgentString(response, keyBlob); WriteAgentString(response, Encoding.UTF8.GetBytes("socket-key"));
                await WriteAgentPacketAsync(network, response.ToArray());
            }
            else
            {
                if (packet[0] != 13) throw new InvalidDataException("Expected sign request over SSH_AUTH_SOCK.");
                var offset = 1; _ = ReadAgentString(packet, ref offset); _ = ReadAgentString(packet, ref offset);
                observedFlags = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(offset, 4));
                using var response = new MemoryStream(); response.WriteByte(14); WriteAgentString(response, signature);
                await WriteAgentPacketAsync(network, response.ToArray());
            }
        }
    });
    var previous = Environment.GetEnvironmentVariable("SSH_AUTH_SOCK");
    Environment.SetEnvironmentVariable("SSH_AUTH_SOCK", socketPath);
    var agent = NativeSshAgent.Discover();
    var identities = agent.ListIdentities();
    var signed = agent.Sign(keyBlob, [9, 8, 7], 0);
    await serverTask.WaitAsync(TimeSpan.FromSeconds(5));
    Environment.SetEnvironmentVariable("SSH_AUTH_SOCK", previous);
    try { File.Delete(socketPath); } catch { }
    if (identities.Count != 1 || !identities[0].KeyBlob.SequenceEqual(keyBlob) || !signed.SequenceEqual(signature) || observedFlags != 0)
        throw new InvalidOperationException("SSH_AUTH_SOCK UDS protocol failed.");
    Console.WriteLine("PASS: SSH_AUTH_SOCK Unix-domain-socket identity and signature framing");
}

async Task TestJumpHostEndToEndAsync()
{
    if (!OperatingSystem.IsWindows()) return;
    var repositoryRoot = FindRepositoryRoot();
    var fixture = Path.Combine(repositoryRoot, "test", "fixtures", "testSshServer.mjs");
    var temp = Path.Combine(Path.GetTempPath(), "ofs-native-jump-test-" + Guid.NewGuid().ToString("N"));
    var jumpRoot = Path.Combine(temp, "jump-root");
    var targetRoot = Path.Combine(temp, "target-root");
    Directory.CreateDirectory(jumpRoot); Directory.CreateDirectory(targetRoot);
    await File.WriteAllTextAsync(Path.Combine(jumpRoot, "jump-marker.txt"), "jump");
    await File.WriteAllTextAsync(Path.Combine(targetRoot, "target-marker.txt"), "target");
    var jumpPort = FindFreePort();
    var targetPort = FindFreePort();
    using var jumpFixture = StartFixture(fixture, jumpPort, jumpRoot);
    using var targetFixture = StartFixture(fixture, targetPort, targetRoot);
    await WaitForPortAsync(jumpPort); await WaitForPortAsync(targetPort);

    var dataRoot = Path.Combine(temp, "native-data");
    using var store = new NativeStore(dataRoot, new TestProtector());
    var secret = store.SaveSecret("test123");
    JsonObject ProfileJson(string id, string name, int port, string? jump = null) => new()
    {
        ["id"] = id, ["name"] = name, ["host"] = "127.0.0.1", ["port"] = port, ["username"] = "test",
        ["auth"] = new JsonObject { ["method"] = "password", ["passwordRef"] = secret },
        ["terminal"] = new JsonObject { ["charset"] = "utf8", ["termType"] = "xterm-256color" },
        ["options"] = new JsonObject { ["readyTimeout"] = 8000, ["keepaliveInterval"] = 15000 },
        ["jumpHostId"] = jump
    };
    var jumpJson = ProfileJson("jump-fixture", "Jump fixture", jumpPort);
    var targetJson = ProfileJson("target-fixture", "Target fixture", targetPort, "jump-fixture");
    targetJson["options"] = new JsonObject { ["autoReconnect"] = true };
    store.Save("profiles", "jump-fixture", jumpJson);
    store.Save("profiles", "target-fixture", targetJson);
    using var sessions = new NativeSessionManager(store);
    var confirmed = new List<string>();
    var jumpProgress = new ConcurrentQueue<NativeConnectionProgress>();
    var output = new StringBuilder();
    var outputReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    sessions.Output += (_, bytes) =>
    {
        lock (output)
        {
            output.Append(Encoding.UTF8.GetString(bytes));
            if (output.ToString().Contains("single-hop-ok", StringComparison.Ordinal)) outputReady.TrySetResult();
        }
    };
    var snapshot = await sessions.OpenAsync(ConnectionProfile.FromJson(targetJson), challenge =>
    {
        confirmed.Add($"{challenge.Host}:{challenge.Port}"); return Task.FromResult(true);
    }, (_, _) => Task.FromResult<string?>("test123"), CancellationToken.None,
        onConnectionProgress: progress => jumpProgress.Enqueue(progress));
    if (snapshot.State != NativeSessionState.Ready) throw new InvalidOperationException("Single-hop target session did not reach Ready.");
    var observedProgress = jumpProgress.ToArray();
    if (observedProgress.Length < 10 || observedProgress[^1].Percent != 100
        || observedProgress.Select((item, index) => (item, index)).Any(pair => pair.index > 0 && pair.item.Percent < observedProgress[pair.index - 1].Percent)
        || observedProgress.Select((item, index) => (item, index)).Any(pair => pair.index > 0 && pair.item.StepIndex < observedProgress[pair.index - 1].StepIndex)
        || !observedProgress.Any(item => item.StepKey == "native.connection.jumpTunnelReady")
        || !observedProgress.Any(item => item.StepKey == "native.connection.establishingJumpTunnel")
        || !observedProgress.Any(item => item.StepKey == "native.connection.connectingTarget")
        || !observedProgress.Any(item => item.WaitingForUser && item.WaitingReasonKey == "native.connection.waitingForHostKey"))
        throw new InvalidOperationException("Jump-host connection progress did not report monotonic milestone and host-key waiting states.");
    if (!confirmed.Contains($"127.0.0.1:{jumpPort}") || !confirmed.Contains($"127.0.0.1:{targetPort}"))
        throw new InvalidOperationException("Jump and target host keys were not confirmed independently.");
    var session = sessions.Get(snapshot.SessionId);
    session.Write(Encoding.UTF8.GetBytes("echo single-hop-ok\r"));
    await outputReady.Task.WaitAsync(TimeSpan.FromSeconds(8));
    var entries = await session.ListAsync("/", CancellationToken.None);
    if (!entries.Any(entry => entry.Name == "target-marker.txt")) throw new InvalidOperationException("SFTP did not reach target through jump tunnel.");
    var reconnected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var rememberedSize = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    session.StateChanged += state => { if (state.State == NativeSessionState.Ready) reconnected.TrySetResult(); };
    session.Output += bytes => { if (Encoding.UTF8.GetString(bytes).Contains("97x23", StringComparison.Ordinal)) rememberedSize.TrySetResult(); };
    session.Resize(97, 23);
    session.Write(Encoding.UTF8.GetBytes("exit\r"));
    await reconnected.Task.WaitAsync(TimeSpan.FromSeconds(12));
    session.Write(Encoding.UTF8.GetBytes("size\r"));
    await rememberedSize.Task.WaitAsync(TimeSpan.FromSeconds(8));
    Check((await session.ListAsync("/", CancellationToken.None)).Any(e => e.Name == "target-marker.txt"), "Automatic single-hop reconnect restores SFTP and remembers terminal dimensions");
    var retryScheduled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var resurrected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    session.StateChanged += state => { if (state.State == NativeSessionState.Reconnecting) retryScheduled.TrySetResult(); };
    session.Write(Encoding.UTF8.GetBytes("exit\r"));
    await retryScheduled.Task.WaitAsync(TimeSpan.FromSeconds(8));
    sessions.Close(snapshot.SessionId);
    session.StateChanged += state => { if (state.State == NativeSessionState.Ready) resurrected.TrySetResult(); };
    Check(await Task.WhenAny(resurrected.Task, Task.Delay(1600)) != resurrected.Task && session.Snapshot.State == NativeSessionState.Closed, "Closing a session cancels a scheduled reconnect without resurrecting it");
    total++;
    Console.WriteLine("PASS: two local SSH fixtures connect through one jump; host keys, terminal, and SFTP reach target independently");

    var missing = ProfileJson("missing-jump-target", "Missing jump target", targetPort, "does-not-exist");
    var failedProgress = new ConcurrentQueue<NativeConnectionProgress>();
    try
    {
        await sessions.OpenAsync(ConnectionProfile.FromJson(missing), _ => Task.FromResult(true),
            (_, _) => Task.FromResult<string?>("test123"), CancellationToken.None,
            onConnectionProgress: progress => failedProgress.Enqueue(progress));
        throw new InvalidOperationException("Missing jump host was accepted.");
    }
    catch (KeyNotFoundException error) when (error.Message == "native.errors.jumpHostMissing") { }
    if (failedProgress.IsEmpty || failedProgress.Last().Percent >= 100)
        throw new InvalidOperationException("A failed connection must not report successful completion.");
    total++;
    Console.WriteLine("PASS: missing jump-host references fail explicitly");

    var nested = ProfileJson("nested-jump", "Nested jump", targetPort, "jump-fixture"); store.Save("profiles", "nested-jump", nested);
    var nestedTarget = ProfileJson("nested-target", "Nested target", targetPort, "nested-jump");
    try { await sessions.OpenAsync(ConnectionProfile.FromJson(nestedTarget), _ => Task.FromResult(true), (_, _) => Task.FromResult<string?>("test123"), CancellationToken.None); throw new InvalidOperationException("Nested jump host was accepted."); }
    catch (InvalidDataException error) when (error.Message == "native.errors.jumpNestedUnsupported") { }
    total++;
    Console.WriteLine("PASS: nested jump-host references fail explicitly in first-version single-hop scope");
}

async Task TestForwardBridgeEndToEndAsync()
{
    if (!OperatingSystem.IsWindows()) return;
    var repositoryRoot = FindRepositoryRoot();
    var fixture = Path.Combine(repositoryRoot, "test", "fixtures", "testSshServer.mjs");
    var temp = Path.Combine(Path.GetTempPath(), "ofs-native-forward-test-" + Guid.NewGuid().ToString("N"));
    var fixtureRoot = Path.Combine(temp, "fixture-root"); Directory.CreateDirectory(fixtureRoot);
    var auditPath = Path.Combine(temp, "sftp-protocol.jsonl");
    var sshPort = FindFreePort(); using var server = StartFixture(fixture, sshPort, fixtureRoot, writeDelayMs: 100, auditPath: auditPath, directoryDelayMs: 100);
    await WaitForPortAsync(sshPort);
    var dataRoot = Path.Combine(temp, "native-data"); using var store = new NativeStore(dataRoot, new TestProtector());
    var secret = store.SaveSecret("test123");
    var profileJson = new JsonObject
    {
        ["id"] = "forward-fixture", ["name"] = "Forward fixture", ["host"] = "127.0.0.1", ["port"] = sshPort, ["username"] = "test",
        ["auth"] = new JsonObject { ["method"] = "password", ["passwordRef"] = secret },
        ["terminal"] = new JsonObject { ["charset"] = "utf8" },
        ["options"] = new JsonObject { ["readyTimeout"] = 8000 }
    };
    profileJson["auth"] = new JsonObject { ["method"] = "password" };
    store.Save("profiles", "forward-fixture", profileJson);
    using var sessions = new NativeSessionManager(store);
    var forwardingProgress = new ConcurrentQueue<NativeConnectionProgress>();
    var opened = await sessions.OpenAsync(ConnectionProfile.FromJson(profileJson), _ => Task.FromResult(true), (_, _) => Task.FromResult<string?>("test123"), CancellationToken.None,
        onConnectionProgress: progress => forwardingProgress.Enqueue(progress));
    var directSteps = forwardingProgress.ToArray();
    if (directSteps.Length < 6 || directSteps[^1].Percent != 100
        || directSteps.Select((item, index) => (item, index)).Any(pair => pair.index > 0 && pair.item.Percent < directSteps[pair.index - 1].Percent)
        || directSteps.Select((item, index) => (item, index)).Any(pair => pair.index > 0 && pair.item.StepIndex < directSteps[pair.index - 1].StepIndex)
        || !directSteps.Any(item => item.StepKey == "native.connection.verifyingTargetHost")
        || !directSteps.Any(item => item.WaitingForUser && item.WaitingReasonKey == "native.connection.waitingForCredentials")
        || !directSteps.Any(item => item.WaitingForUser && item.WaitingReasonKey == "native.connection.waitingForHostKey")
        || directSteps[^1].StepCount != 6)
        throw new InvalidOperationException("Direct SSH connection progress did not report monotonic milestone states.");
    var session = sessions.Get(opened.SessionId);
    var navigation = new OpenFinalShell.App.ViewModels.SftpBrowserViewModel(session);
    Directory.CreateDirectory(Path.Combine(fixtureRoot, "alpha")); Directory.CreateDirectory(Path.Combine(fixtureRoot, "beta"));
    await File.WriteAllTextAsync(Path.Combine(fixtureRoot, "alpha", "alpha.txt"), "alpha");
    await File.WriteAllTextAsync(Path.Combine(fixtureRoot, "beta", "beta.txt"), "beta");
    var pathsPublished = new List<string>();
    navigation.PropertyChanged += (_, args) => { if (args.PropertyName == nameof(navigation.CurrentPath)) pathsPublished.Add(navigation.CurrentPath); };
    var oldNavigation = navigation.NavigateAsync("/alpha");
    var newNavigation = navigation.NavigateAsync("/beta");
    await Task.WhenAll(oldNavigation, newNavigation);
    Check(navigation.CurrentPath == "/beta" && navigation.Entries.Single().Name == "beta.txt" && pathsPublished.SequenceEqual(new[] { "/beta" }),
        "SFTP navigation keeps the latest requested directory and never publishes a stale in-flight listing");
    var navigationStatus = navigation.Status;
    using (var navigationCancellation = new CancellationTokenSource())
    {
        var canceledNavigation = navigation.NavigateAsync("/alpha", navigationCancellation.Token);
        navigationCancellation.Cancel();
        try { await canceledNavigation; Check(false, "Canceled SFTP navigation is interrupted"); }
        catch (OperationCanceledException)
        { Check(navigation.CurrentPath == "/beta" && !navigation.IsBusy && navigation.Status == navigationStatus, "Canceled SFTP navigation preserves the last directory and clears its busy state without a stale error"); }
    }
    await navigation.NavigateAsync("/alpha");
    Check(navigation.CurrentPath == "/alpha" && navigation.Entries.Single().Name == "alpha.txt", "SFTP navigation recovers after cancellation without dropping the next request");
    var directoryReports = new NativeTerminalDirectoryTracker();
    var directoryReceived = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    void ReceiveDirectory(byte[] bytes) { if (directoryReports.Feed(bytes) is { } directory) directoryReceived.TrySetResult(directory); }
    session.Output += ReceiveDirectory;
    session.Write(Encoding.UTF8.GetBytes("fixture-osc7-beta\r"));
    var reportedDirectory = await directoryReceived.Task.WaitAsync(TimeSpan.FromSeconds(5));
    session.Output -= ReceiveDirectory;
    await navigation.NavigateAsync(await session.RealPathAsync(reportedDirectory, CancellationToken.None, requireExisting: true));
    Check(reportedDirectory == "/beta" && navigation.CurrentPath == "/beta" && navigation.Entries.Single().Name == "beta.txt",
        "Explicit directory notification survives SSH output chunks and navigates the same session's SFTP without injecting a cd command");
    var missingPath = "/missing-" + Guid.NewGuid().ToString("N") + ".txt";
    Check(await session.TryGetAsync(missingPath, CancellationToken.None) == null, "Missing SFTP paths are distinguished from existing entries");
    var atomicPath = "/editor-atomic-" + Guid.NewGuid().ToString("N") + ".txt";
    var atomicBefore = Encoding.UTF8.GetBytes("before\n");
    var atomicAfter = Encoding.UTF8.GetBytes("after atomic save\n");
    await session.WriteFileAtomicAsync(atomicPath, atomicBefore, false, CancellationToken.None);
    Check((await session.ReadFileAsync(atomicPath, CancellationToken.None)).SequenceEqual(atomicBefore), "Atomic save creates an absent target without overwriting another path");
    var audit = (await File.ReadAllLinesAsync(auditPath)).Select(line => JsonNode.Parse(line)!.AsObject()).ToArray();
    var initialWrite = Array.FindIndex(audit, entry => entry["operation"]?.GetValue<string>() == "write");
    Check(initialWrite > 0 && audit.Take(initialWrite).Any(entry => entry["operation"]?.GetValue<string>() == "setstat" && (entry["mode"]?.GetValue<int>() & 4095) == 384),
        "New editor temporary file receives mode 0600 over SFTP before any content is written");
    await session.ChmodAsync(atomicPath, Convert.ToInt16("640", 8), CancellationToken.None);
    var chmodFrame = JsonNode.Parse((await File.ReadAllLinesAsync(auditPath)).Last())!.AsObject();
    Check(chmodFrame["operation"]?.GetValue<string>() == "setstat" && (chmodFrame["mode"]?.GetValue<int>() & 4095) == 416,
        "SFTP chmod sends the intended 0640 permission bits instead of interpreting 416 as octal digits");
    try
    {
        await session.WriteFileAtomicAsync(atomicPath, atomicAfter, false, CancellationToken.None);
        Check(false, "Atomic save requires overwrite consent for an existing target");
    }
    catch (IOException) { Check(true, "Atomic save requires overwrite consent for an existing target"); }
    Check((await session.ReadFileAsync(atomicPath, CancellationToken.None)).SequenceEqual(atomicBefore), "Rejected atomic overwrite leaves original bytes intact");
    await session.DeleteAsync(atomicPath, false, CancellationToken.None);
    await using (var upload = new MemoryStream(atomicBefore))
        await session.UploadAsync(upload, atomicPath, false, CancellationToken.None);
    await session.WriteFileAtomicAsync(atomicPath, atomicAfter, true, CancellationToken.None, allowNonAtomic: true);
    var atomicReadback = await session.ReadFileAsync(atomicPath, CancellationToken.None);
    Check(atomicReadback.SequenceEqual(atomicAfter), "Remote editor atomic save writes exact bytes through SFTP rename");
    var remoteEditor = new NativeRemoteEditorService();
    await remoteEditor.ViewAsync(session, atomicPath);
    var needsConsent = await remoteEditor.SaveAsync(session, atomicPath, "a\r\nb\n", NativeTextEncoding.Utf8, "\n", false, false, false);
    Check(needsConsent.Kind == NativeRemoteSaveKind.NonAtomic && (await session.ReadFileAsync(atomicPath, CancellationToken.None)).SequenceEqual(atomicAfter), "Editor rejects silent backup/rename fallback and leaves the original remote bytes intact");
    var consentedSave = await remoteEditor.SaveAsync(session, atomicPath, "a\nb\n", NativeTextEncoding.Utf8, "\n", false, false, false, allowNonAtomic: true);
    Check(consentedSave.Kind == NativeRemoteSaveKind.Saved && (await session.ReadFileAsync(atomicPath, CancellationToken.None)).SequenceEqual(Encoding.UTF8.GetBytes("a\nb\n")), "Explicit non-atomic consent saves exact bytes after rechecking the conflict baseline");
    var modeBefore = (await session.TryGetAsync(atomicPath, CancellationToken.None))!.Mode;
    var linkPath = Path.Combine(fixtureRoot, "editor-link.txt");
    File.CreateSymbolicLink(linkPath, Path.Combine(fixtureRoot, Path.GetFileName(atomicPath)));
    var linkedView = await remoteEditor.ViewAsync(session, "/editor-link.txt");
    Check(linkedView.RequestedPath == "/editor-link.txt" && linkedView.ResolvedPath == atomicPath, "Editor resolves a real filesystem symlink and records the requested alias independently");
    var linkedSave = await remoteEditor.SaveAsync(session, "/editor-link.txt", "saved through link\n", linkedView.Encoding, linkedView.NewLine, linkedView.HasBom, false, false, allowNonAtomic: true);
    Check(linkedSave.Kind == NativeRemoteSaveKind.Saved && new FileInfo(linkPath).LinkTarget != null
        && Encoding.UTF8.GetString(await session.ReadFileAsync(atomicPath, CancellationToken.None)) == "saved through link\n"
        && (await session.TryGetAsync(atomicPath, CancellationToken.None))!.Mode == modeBefore,
        "Saving a symlink edits its resolved target, preserves the link and retains fixture-reported permissions");
    var alternatePath = Path.Combine(fixtureRoot, "alternate-target.txt");
    await File.WriteAllTextAsync(alternatePath, "untouched\n");
    File.Delete(linkPath); File.CreateSymbolicLink(linkPath, alternatePath);
    try
    {
        await remoteEditor.SaveAsync(session, "/editor-link.txt", "wrong target\n", linkedView.Encoding, linkedView.NewLine, linkedView.HasBom, true, true, allowNonAtomic: true);
        Check(false, "Retargeting a symlink cannot be overridden by overwrite consent");
    }
    catch (IOException error) when (error.Message == "native.editor.targetChanged")
    { Check(await File.ReadAllTextAsync(alternatePath) == "untouched\n", "Retargeting a symlink rejects saving and leaves its new target unchanged"); }
    File.Delete(linkPath);
    await remoteEditor.ViewAsync(session, atomicPath);
    File.Delete(Path.Combine(fixtureRoot, Path.GetFileName(atomicPath)));
    Directory.CreateDirectory(Path.Combine(fixtureRoot, Path.GetFileName(atomicPath)));
    try
    {
        await remoteEditor.SaveAsync(session, atomicPath, "not a directory\n", NativeTextEncoding.Utf8, "\n", false, true, true, allowNonAtomic: true);
        Check(false, "A file replaced by a directory cannot be saved");
    }
    catch (IOException error) when (error.Message == "native.editor.targetChanged")
    { Check(Directory.Exists(Path.Combine(fixtureRoot, Path.GetFileName(atomicPath))), "A file replaced by a directory is rejected without modifying the directory"); }
    Directory.Delete(Path.Combine(fixtureRoot, Path.GetFileName(atomicPath)));
    await File.WriteAllBytesAsync(Path.Combine(fixtureRoot, Path.GetFileName(atomicPath)), atomicAfter);
    await session.DeleteAsync(atomicPath, false, CancellationToken.None);
    var racePath = "/editor-race-" + Guid.NewGuid().ToString("N") + ".txt";
    var pendingSave = session.WriteFileAtomicAsync(racePath, new byte[128 * 1024], false, CancellationToken.None);
    var raceDeadline = DateTime.UtcNow.AddSeconds(5);
    while (!Directory.EnumerateFiles(fixtureRoot, Path.GetFileName(racePath) + ".ofs-edit-*").Any() && !pendingSave.IsCompleted && DateTime.UtcNow < raceDeadline)
        await Task.Delay(5);
    Check(!pendingSave.IsCompleted && Directory.EnumerateFiles(fixtureRoot, Path.GetFileName(racePath) + ".ofs-edit-*").Any(), "Atomic overwrite race is injected while a temporary upload is in progress");
    var raceOriginal = Encoding.UTF8.GetBytes("created by another client\n");
    await File.WriteAllBytesAsync(Path.Combine(fixtureRoot, Path.GetFileName(racePath)), raceOriginal);
    try { await pendingSave; Check(false, "Target appearing during atomic upload still requires overwrite consent"); }
    catch (IOException) { Check(true, "Target appearing during atomic upload still requires overwrite consent"); }
    Check((await session.ReadFileAsync(racePath, CancellationToken.None)).SequenceEqual(raceOriginal)
        && !Directory.EnumerateFiles(fixtureRoot, Path.GetFileName(racePath) + ".ofs-edit-*").Any(), "Atomic conflict preserves the other client's bytes and removes its own temporary upload");
    await session.DeleteAsync(racePath, false, CancellationToken.None);
    var concurrentPath = "/editor-concurrent-" + Guid.NewGuid().ToString("N") + ".txt";
    var concurrentLocal = Path.Combine(fixtureRoot, Path.GetFileName(concurrentPath));
    await File.WriteAllTextAsync(concurrentLocal, "original baseline\n");
    await remoteEditor.ViewAsync(session, concurrentPath);
    var concurrentSave = remoteEditor.SaveAsync(session, concurrentPath, new string('x', 128 * 1024), NativeTextEncoding.Utf8, "\n", false, true, true, allowNonAtomic: true);
    var concurrentDeadline = DateTime.UtcNow.AddSeconds(5);
    while (!Directory.EnumerateFiles(fixtureRoot, Path.GetFileName(concurrentPath) + ".ofs-edit-*").Any() && !concurrentSave.IsCompleted && DateTime.UtcNow < concurrentDeadline)
        await Task.Delay(5);
    Check(!concurrentSave.IsCompleted && Directory.EnumerateFiles(fixtureRoot, Path.GetFileName(concurrentPath) + ".ofs-edit-*").Any(),
        "A second writer is injected while the editor temporary upload is in progress");
    await File.WriteAllTextAsync(concurrentLocal, "changed by another client\n");
    var concurrentResult = await concurrentSave;
    Check(concurrentResult.Kind == NativeRemoteSaveKind.Conflict && await File.ReadAllTextAsync(concurrentLocal) == "changed by another client\n"
        && !Directory.EnumerateFiles(fixtureRoot, Path.GetFileName(concurrentPath) + ".ofs-edit-*").Any(),
        "Editor rechecks bytes after upload, preserves concurrent changes even after overwrite consent, and removes only its own temporary file");
    await session.DeleteAsync(concurrentPath, false, CancellationToken.None);
    await using (var monitor = new NativeMonitorService(session))
    {
        var snapshots = 0;
        monitor.Snapshot += _ => Interlocked.Increment(ref snapshots);
        async Task WaitForSnapshotsAsync(int minimum)
        {
            var deadline = DateTime.UtcNow.AddSeconds(6);
            while (Volatile.Read(ref snapshots) < minimum && DateTime.UtcNow < deadline) await Task.Delay(25);
            Check(Volatile.Read(ref snapshots) >= minimum, "Monitor publishes fixture snapshots after start or restart");
        }
        await monitor.StartAsync(500);
        await WaitForSnapshotsAsync(2);
        await Task.WhenAll(monitor.StopAsync(), monitor.StopAsync());
        var stoppedCount = Volatile.Read(ref snapshots);
        await Task.Delay(1100);
        Check(monitor.State == NativeCollectorState.Stopped && monitor.StaticInfo == null && snapshots == stoppedCount, "Monitor stop is idempotent and publishes no stale snapshots after teardown");
        await monitor.StartAsync(500);
        await WaitForSnapshotsAsync(stoppedCount + 2);
        await monitor.StopAsync();
        using var canceledMonitor = new CancellationTokenSource(); canceledMonitor.Cancel();
        try { await monitor.StartAsync(500, canceledMonitor.Token); Check(false, "Canceled monitor startup is rejected"); }
        catch (OperationCanceledException) { Check(monitor.State == NativeCollectorState.Stopped, "Canceled monitor startup leaves the collector stopped"); }
    }
    using var echo = new LocalEchoServer();
    var payload = Encoding.UTF8.GetBytes("forward telemetry round-trip · 测试");
    var cases = new[]
    {
        (Id: "local", Type: "local", BindPort: FindFreePort()),
        (Id: "dynamic", Type: "dynamic", BindPort: FindFreePort()),
        (Id: "remote", Type: "remote", BindPort: FindFreePort())
    };
    foreach (var item in cases)
    {
        var rule = new JsonObject
        {
            ["type"] = item.Type, ["bindAddr"] = "127.0.0.1", ["bindPort"] = item.BindPort,
            ["dstHost"] = "127.0.0.1", ["dstPort"] = echo.Port
        };
        session.StartForward(item.Id, rule);
        var snapshot = item.Type == "dynamic"
            ? await SendSocksForwardTrafficAsync(item.BindPort, echo.Port, payload, session, item.Id)
            : await SendForwardTrafficAsync(item.BindPort, payload, session, item.Id);
        if (snapshot.ActiveConnections < 1 || snapshot.TotalBytes < payload.Length * 2L)
            throw new InvalidOperationException($"{item.Type} forward did not report active connections and bidirectional bytes: {snapshot}.");
        await WaitForTelemetryAsync(session, item.Id, value => value.ActiveConnections == 0);
        var totalBytes = session.ForwardTelemetryOf(item.Id)!.TotalBytes;
        session.StopForward(item.Id);
        var stopped = session.ForwardTelemetryOf(item.Id);
        if (stopped is null || stopped.ActiveConnections != 0 || stopped.TotalBytes < totalBytes)
            throw new InvalidOperationException($"{item.Type} forward did not preserve stopped telemetry.");
    }
    sessions.Close(opened.SessionId);
    total++;
    Console.WriteLine("PASS: local, dynamic SOCKS5, and remote forwards report active connections and bidirectional bytes, then clear active count on stop");
}

static async Task<ForwardTelemetrySnapshot> SendForwardTrafficAsync(int port, byte[] payload, NativeSession session, string id)
{
    using var client = new TcpClient(); await client.ConnectAsync("127.0.0.1", port);
    var stream = client.GetStream(); await stream.WriteAsync(payload);
    var response = new byte[payload.Length]; await stream.ReadExactlyAsync(response);
    if (!response.SequenceEqual(payload)) throw new InvalidOperationException("TCP forward corrupted the echo payload.");
    await Task.Delay(100);
    return session.ForwardTelemetryOf(id) ?? throw new InvalidOperationException("TCP forward telemetry is missing.");
}

static async Task<ForwardTelemetrySnapshot> SendSocksForwardTrafficAsync(int port, int destinationPort, byte[] payload, NativeSession session, string id)
{
    using var client = new TcpClient(); await client.ConnectAsync("127.0.0.1", port);
    var stream = client.GetStream();
    await stream.WriteAsync(new byte[] { 5, 1, 0 });
    var selection = new byte[2]; await stream.ReadExactlyAsync(selection);
    if (!selection.SequenceEqual(new byte[] { 5, 0 })) throw new InvalidOperationException("Dynamic forward did not accept SOCKS5 no-auth negotiation.");
    var request = new byte[10]; request[0] = 5; request[1] = 1; request[3] = 1;
    request[4] = 127; request[5] = 0; request[6] = 0; request[7] = 1;
    var portBytes = new byte[2];
    BinaryPrimitives.WriteUInt16BigEndian(portBytes, checked((ushort)destinationPort));
    request[8] = portBytes[0]; request[9] = portBytes[1];
    await stream.WriteAsync(request);
    var reply = new byte[10]; await stream.ReadExactlyAsync(reply);
    if (reply[1] != 0) throw new InvalidOperationException("Dynamic forward failed SOCKS5 CONNECT.");
    await stream.WriteAsync(payload);
    var response = new byte[payload.Length]; await stream.ReadExactlyAsync(response);
    if (!response.SequenceEqual(payload)) throw new InvalidOperationException("Dynamic forward corrupted the echo payload.");
    await Task.Delay(100);
    return session.ForwardTelemetryOf(id) ?? throw new InvalidOperationException("Dynamic forward telemetry is missing.");
}

static async Task WaitForTelemetryAsync(NativeSession session, string id, Func<ForwardTelemetrySnapshot, bool> predicate)
{
    var deadline = DateTime.UtcNow.AddSeconds(5);
    while (DateTime.UtcNow < deadline)
    {
        var snapshot = session.ForwardTelemetryOf(id);
        if (snapshot is not null && predicate(snapshot)) return;
        await Task.Delay(30);
    }
    throw new TimeoutException($"Forward telemetry for {id} did not reach the requested state.");
}

static int FindFreePort()
{
    using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
    listener.Start(); var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port;
}

static FixtureProcess StartFixture(string fixture, int port, string root, int writeDelayMs = 0, string? auditPath = null, int directoryDelayMs = 0)
{
    var start = new ProcessStartInfo("node") { WorkingDirectory = FindRepositoryRoot(), UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
    start.ArgumentList.Add(fixture); start.ArgumentList.Add(port.ToString()); start.ArgumentList.Add(root);
    start.Environment["OFS_TEST_SFTP_WRITE_DELAY_MS"] = writeDelayMs.ToString(System.Globalization.CultureInfo.InvariantCulture);
    if (auditPath != null) start.Environment["OFS_TEST_SFTP_AUDIT_FILE"] = auditPath;
    start.Environment["OFS_TEST_SFTP_DIRECTORY_DELAY_MS"] = directoryDelayMs.ToString(System.Globalization.CultureInfo.InvariantCulture);
    var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start node SSH fixture.");
    process.OutputDataReceived += (_, _) => { }; process.ErrorDataReceived += (_, _) => { };
    process.BeginOutputReadLine(); process.BeginErrorReadLine();
    return new FixtureProcess(process);
}

static async Task WaitForPortAsync(int port)
{
    var deadline = DateTime.UtcNow.AddSeconds(10);
    while (DateTime.UtcNow < deadline)
    {
        using var client = new System.Net.Sockets.TcpClient();
        try { await client.ConnectAsync("127.0.0.1", port); return; } catch { await Task.Delay(100); }
    }
    throw new TimeoutException($"SSH fixture did not listen on {port}.");
}

static string FindRepositoryRoot()
{
    var path = Directory.GetCurrentDirectory();
    while (Directory.GetParent(path) is { } parent)
    {
        if (File.Exists(Path.Combine(path, "test", "fixtures", "testSshServer.mjs"))) return path;
        path = parent.FullName;
    }
    throw new DirectoryNotFoundException("Repository fixture was not found from the current directory.");
}

static async Task<byte[]> ReadAgentPacketAsync(Stream stream)
{
    var header = new byte[4]; await stream.ReadExactlyAsync(header);
    var length = BinaryPrimitives.ReadUInt32BigEndian(header);
    if (length is < 1 or > 1024 * 1024) throw new InvalidDataException("Invalid test packet length.");
    var payload = new byte[checked((int)length)]; await stream.ReadExactlyAsync(payload);
    return payload;
}

static async Task WriteAgentPacketAsync(Stream stream, byte[] payload)
{
    var header = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(header, checked((uint)payload.Length));
    await stream.WriteAsync(header); await stream.WriteAsync(payload); await stream.FlushAsync();
}

static byte[] BuildSshString(byte[] value)
{
    using var buffer = new MemoryStream(); WriteAgentString(buffer, value); return buffer.ToArray();
}

static void WriteAgentString(Stream stream, byte[] value)
{
    var length = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(length, checked((uint)value.Length));
    stream.Write(length); stream.Write(value);
}

static void WriteUInt32(Stream stream, uint value)
{
    var bytes = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(bytes, value); stream.Write(bytes);
}

static byte[] ReadAgentString(byte[] packet, ref int offset)
{
    var length = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(offset, 4)); offset += 4;
    var value = packet.AsSpan(offset, checked((int)length)).ToArray(); offset += checked((int)length); return value;
}

sealed class FakePageantWindow : IDisposable
{
    private const uint WmQuit = 0x0012;
    private const uint WmCopyData = 0x004A;
    private readonly string className = "Pageant";
    private readonly WindowProcedure procedure;
    private readonly Thread thread;
    private readonly TaskCompletionSource<nint> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private uint threadId;
    public Exception? Failure { get; private set; }
    public nint Handle => ready.Task.GetAwaiter().GetResult();

    public FakePageantWindow()
    {
        procedure = WindowProc;
        thread = new Thread(MessageLoop) { IsBackground = true, Name = "Fake Pageant agent endpoint" };
        thread.Start();
        _ = Handle;
    }

    private void MessageLoop()
    {
        threadId = GetCurrentThreadId();
        try
        {
            var instance = GetModuleHandle(null);
            var windowClass = new WindowClassEx
            {
                Size = (uint)Marshal.SizeOf<WindowClassEx>(),
                WindowProcedure = Marshal.GetFunctionPointerForDelegate(procedure),
                Instance = instance,
                ClassName = className
            };
            if (RegisterClassEx(ref windowClass) == 0) throw new InvalidOperationException("Fake Pageant window class registration failed.");
            var hwnd = CreateWindowEx(0, className, "Pageant", 0, 0, 0, 0, 0, 0, 0, instance, 0);
            if (hwnd == 0) throw new InvalidOperationException("Fake Pageant window creation failed.");
            ready.TrySetResult(hwnd);
            while (GetMessage(out var message, 0, 0, 0) > 0)
            {
                TranslateMessage(ref message); DispatchMessage(ref message);
            }
            DestroyWindow(hwnd);
            UnregisterClass(className, instance);
        }
        catch (Exception error) { Failure = error; ready.TrySetException(error); }
    }

    private nint WindowProc(nint hwnd, uint message, nint wParam, nint lParam)
    {
        if (message != WmCopyData) return DefWindowProc(hwnd, message, wParam, lParam);
        nint mappingHandle = 0, view = 0;
        try
        {
            var data = Marshal.PtrToStructure<CopyData>(lParam);
            if (data.DataId != new nint(unchecked((long)0x804E50BA))) return 0;
            var nameBytes = new byte[data.ByteCount]; Marshal.Copy(data.Data, nameBytes, 0, nameBytes.Length);
            var name = Encoding.ASCII.GetString(nameBytes).TrimEnd('\0');
            mappingHandle = OpenFileMapping(0xF001F, false, name);
            if (mappingHandle == 0) throw new IOException("Fake Pageant could not open the shared mapping.");
            view = MapViewOfFile(mappingHandle, 0xF001F, 0, 0, 1024 * 1024);
            if (view == 0) throw new IOException("Fake Pageant could not map the shared mapping.");
            var header = new byte[4]; Marshal.Copy(view, header, 0, 4);
            var requestLength = BinaryPrimitives.ReadUInt32BigEndian(header);
            if (requestLength != 1) throw new InvalidDataException("Fake Pageant expected a one-byte identity request.");
            var request = new byte[1]; Marshal.Copy(view + 4, request, 0, 1);
            if (request[0] != 11) throw new InvalidDataException("Fake Pageant expected SSH_AGENTC_REQUEST_IDENTITIES.");
            var response = new byte[] { 0, 0, 0, 5, 12, 0, 0, 0, 0 };
            Marshal.Copy(response, 0, view, response.Length);
            return new nint(1);
        }
        catch (Exception error) { Failure = error; return 0; }
        finally
        {
            if (view != 0) UnmapViewOfFile(view);
            if (mappingHandle != 0) CloseHandle(mappingHandle);
        }
    }

    public void Dispose()
    {
        if (threadId != 0) PostThreadMessage(threadId, WmQuit, 0, 0);
        if (!ReferenceEquals(Thread.CurrentThread, thread)) thread.Join(TimeSpan.FromSeconds(2));
        if (Failure is not null) throw new InvalidOperationException("Fake Pageant test endpoint failed.", Failure);
        GC.KeepAlive(procedure);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClassEx
    {
        public uint Size, Style;
        public nint WindowProcedure;
        public int ClassExtra, WindowExtra;
        public nint Instance, Icon, Cursor, Background;
        public nint MenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string ClassName;
        public nint SmallIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message { public nint Window; public uint Id; public nuint WParam; public nint LParam; public uint Time; public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CopyData { public nint DataId; public int ByteCount; public nint Data; }
    private delegate nint WindowProcedure(nint hwnd, uint message, nint wParam, nint lParam);

    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandle(string? name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClassEx windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, nint window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DispatchMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DefWindowProc(nint window, uint message, nint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClass(string className, nint instance);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, nuint wParam, nint lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenFileMapping(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint MapViewOfFile(nint file, uint access, uint offsetHigh, uint offsetLow, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UnmapViewOfFile(nint view);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
}

sealed class FixtureProcess : IDisposable
{
    private readonly Process process;
    public FixtureProcess(Process process) => this.process = process;
    public void Dispose()
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { process.Dispose(); }
    }
}
sealed class TestProtector : ISecretProtector
{
    private readonly byte[] key = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("ssh-tests-only"));
    public byte[] Protect(byte[] value) => value.Select((item, index) => (byte)(item ^ key[index % key.Length])).ToArray();
    public byte[] Unprotect(byte[] value) => Protect(value);
}

sealed class LocalEchoServer : IDisposable
{
    private readonly CancellationTokenSource cancellation = new();
    private readonly TcpListener listener = new(System.Net.IPAddress.Loopback, 0);
    private readonly Task acceptLoop;
    public int Port => ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;

    public LocalEchoServer()
    {
        listener.Start();
        acceptLoop = AcceptLoopAsync(cancellation.Token);
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(token);
                _ = EchoAsync(client, token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (token.IsCancellationRequested) { }
        catch (SocketException) when (token.IsCancellationRequested) { }
    }

    private static async Task EchoAsync(TcpClient client, CancellationToken token)
    {
        using (client)
        {
            var stream = client.GetStream(); var buffer = new byte[4096];
            try
            {
                while (true)
                {
                    var count = await stream.ReadAsync(buffer, token);
                    if (count == 0) return;
                    await stream.WriteAsync(buffer.AsMemory(0, count), token);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
            catch (IOException) { }
            catch (SocketException) { }
        }
    }

    public void Dispose()
    {
        cancellation.Cancel(); listener.Stop();
        try { acceptLoop.Wait(TimeSpan.FromSeconds(2)); } catch { }
        cancellation.Dispose();
    }
}
