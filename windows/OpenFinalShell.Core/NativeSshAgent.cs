using System.Buffers.Binary;
using System.IO.MemoryMappedFiles;
using System.IO.Pipes;
using System.Linq.Expressions;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Renci.SshNet;
using Renci.SshNet.Common;
using Renci.SshNet.Messages;
using Renci.SshNet.Messages.Authentication;

namespace OpenFinalShell.Core;

/// <summary>OpenSSH agent protocol client. It only asks the system agent to sign.</summary>
internal sealed class NativeSshAgent
{
    private const byte RequestIdentities = 11;
    private const byte IdentitiesAnswer = 12;
    private const byte SignRequest = 13;
    private const byte SignResponse = 14;
    private const byte Failure = 5;
    private const int MaxPacketLength = 1024 * 1024 - 4;
    private const string OpenSshPipe = @"\\.\pipe\openssh-ssh-agent";
    private readonly string endpoint;

    internal NativeSshAgent(string endpoint) => this.endpoint = endpoint;

    public static NativeSshAgent Discover()
    {
        var configured = Environment.GetEnvironmentVariable("SSH_AUTH_SOCK");
        var endpoint = SelectEndpoint(configured, OperatingSystem.IsWindows(),
            OperatingSystem.IsWindows() && CanConnectPipe(OpenSshPipe),
            OperatingSystem.IsWindows() && PageantTransport.IsAvailable);
        return endpoint is null ? throw new SshAuthenticationException("native.errors.agentUnavailable") : new(endpoint);
    }

    internal static string? SelectEndpoint(string? sshAuthSock, bool windows, bool openSshAvailable, bool pageantAvailable)
    {
        if (!string.IsNullOrWhiteSpace(sshAuthSock)) return sshAuthSock;
        if (!windows) return null;
        if (openSshAvailable) return OpenSshPipe;
        return pageantAvailable ? "pageant" : null;
    }

    public IReadOnlyList<AgentIdentity> ListIdentities()
    {
        var response = Send([RequestIdentities]);
        if (response.Length == 0 || response[0] == Failure)
            throw new SshAuthenticationException("native.errors.agentUnavailable");
        if (response[0] != IdentitiesAnswer) throw new InvalidDataException("Invalid SSH agent identities response.");
        var reader = new SshAgentReader(response.AsSpan(1));
        var count = reader.ReadUInt32();
        if (count > 4096) throw new InvalidDataException("SSH agent returned too many identities.");
        var identities = new List<AgentIdentity>(checked((int)count));
        for (var index = 0; index < count; index++)
            identities.Add(new(reader.ReadString(), reader.ReadString()));
        if (!reader.AtEnd) throw new InvalidDataException("Trailing data in SSH agent identities response.");
        return identities;
    }

    public byte[] Sign(byte[] keyBlob, byte[] data, uint flags)
    {
        using var request = new MemoryStream();
        request.WriteByte(SignRequest);
        SshAgentWriter.WriteString(request, keyBlob);
        SshAgentWriter.WriteString(request, data);
        Span<byte> flagBytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(flagBytes, flags);
        request.Write(flagBytes);
        var response = Send(request.ToArray());
        if (response.Length == 0 || response[0] == Failure)
            throw new SshAuthenticationException("native.errors.agentSignFailed");
        if (response[0] != SignResponse) throw new InvalidDataException("Invalid SSH agent signature response.");
        var reader = new SshAgentReader(response.AsSpan(1));
        var signature = reader.ReadString();
        if (!reader.AtEnd) throw new InvalidDataException("Trailing data in SSH agent signature response.");
        return signature;
    }

    private byte[] Send(byte[] payload)
    {
        if (payload.Length is < 1 or > MaxPacketLength) throw new InvalidDataException("SSH agent request is too large.");
        if (endpoint.Equals("pageant", StringComparison.OrdinalIgnoreCase))
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Pageant is only available on Windows.");
            return PageantTransport.Send(payload);
        }

        using Stream stream = IsPipe(endpoint) ? OpenPipe(endpoint) : OpenSocket(endpoint);
        Span<byte> header = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, checked((uint)payload.Length));
        stream.Write(header);
        stream.Write(payload);
        stream.Flush();
        stream.ReadExactly(header);
        var responseLength = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (responseLength is < 1 or > MaxPacketLength) throw new InvalidDataException("SSH agent response length is invalid.");
        var response = new byte[responseLength];
        stream.ReadExactly(response);
        return response;
    }

    private static bool CanConnectPipe(string pipe)
    {
        try
        {
            using var stream = OpenPipe(pipe, 150);
            return true;
        }
        catch { return false; }
    }

    private static bool IsPipe(string value) => value.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase);
    private static Stream OpenPipe(string path, int timeoutMs = 5000)
    {
        var name = IsPipe(path) ? path[@"\\.\pipe\".Length..] : path;
        if (string.IsNullOrWhiteSpace(name)) throw new IOException("SSH_AUTH_SOCK names an empty Windows pipe.");
        var stream = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.None);
        try { stream.Connect(timeoutMs); return stream; }
        catch { stream.Dispose(); throw; }
    }

    private static Stream OpenSocket(string path)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            socket.Connect(new UnixDomainSocketEndPoint(path));
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch { socket.Dispose(); throw; }
    }
}

internal sealed record AgentIdentity(byte[] KeyBlob, byte[] Comment);

/// <summary>SSH.NET authentication method that signs with an external SSH agent.</summary>
internal sealed class AgentAuthenticationMethod(string username, NativeSshAgent agent) : AuthenticationMethod(username)
{
    public override string Name => "publickey";

    public override AuthenticationResult Authenticate(Session session)
    {
        var identities = agent.ListIdentities();
        if (identities.Count == 0) throw new SshAuthenticationException("native.errors.agentNoIdentities");

        var keys = new EventWaitHandle(false, EventResetMode.AutoReset);
        var completed = new EventWaitHandle(false, EventResetMode.AutoReset);
        var disconnected = new EventWaitHandle(false, EventResetMode.AutoReset);
        var error = new EventWaitHandle(false, EventResetMode.AutoReset);
        var accepted = false;
        var succeeded = false;
        FailureMessage? failure = null;
        var handlers = new List<(EventInfo Event, Delegate Handler)>();
        EventHandler<EventArgs> disconnectedHandler = (_, _) => { disconnected.Set(); completed.Set(); keys.Set(); };
        EventHandler<ExceptionEventArgs> errorHandler = (_, _) => { error.Set(); completed.Set(); keys.Set(); };

        void Subscribe(string name, Action<object?> callback)
        {
            var eventInfo = typeof(Session).GetEvent(name, BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new NotSupportedException($"SSH.NET no longer exposes its {name} authentication signal.");
            var eventHandlerType = eventInfo.EventHandlerType ?? throw new NotSupportedException("Unsupported SSH.NET event type.");
            var invoke = eventHandlerType.GetMethod("Invoke")!;
            var parameters = invoke.GetParameters().Select(parameter => Expression.Parameter(parameter.ParameterType, parameter.Name)).ToArray();
            var body = Expression.Call(Expression.Constant(callback), typeof(Action<object?>).GetMethod("Invoke")!,
                Expression.Convert(parameters[^1], typeof(object)));
            var handler = Expression.Lambda(eventHandlerType, body, parameters).Compile();
            eventInfo.AddEventHandler(session, handler);
            handlers.Add((eventInfo, handler));
        }

        try
        {
            Subscribe("UserAuthenticationPublicKeyReceived", _ => { accepted = true; keys.Set(); });
            Subscribe("UserAuthenticationFailureReceived", args =>
            {
                failure = args?.GetType().GetProperty("Message")?.GetValue(args) as FailureMessage;
                accepted = false;
                completed.Set(); keys.Set();
            });
            Subscribe("UserAuthenticationSuccessReceived", _ => { succeeded = true; completed.Set(); });
            session.Disconnected += disconnectedHandler;
            session.ErrorOccured += errorHandler;
            session.RegisterMessage("SSH_MSG_USERAUTH_PK_OK");
            session.RegisterMessage("SSH_MSG_USERAUTH_FAILURE");
            session.RegisterMessage("SSH_MSG_USERAUTH_SUCCESS");

            foreach (var identity in identities)
            {
                var keyType = Encoding.UTF8.GetString(new SshAgentReader(identity.KeyBlob).ReadString());
                foreach (var (algorithm, flags) in Algorithms(keyType))
                {
                    accepted = false; succeeded = false; failure = null;
                    keys.Reset(); completed.Reset(); error.Reset(); disconnected.Reset();
                    var unsigned = new RequestMessagePublicKey(ServiceName.UserAuthentication, Username, algorithm, identity.KeyBlob);
                    SendMessage(session, unsigned);
                    WaitFor(session, keys, disconnected, error);
                    if (failure != null) AllowedAuthentications = failure.AllowedAuthentications;
                    if (!accepted) continue;

                    var signatureData = BuildSignatureData(session.SessionId, Username, algorithm, identity.KeyBlob);
                    byte[] signature;
                    try { signature = agent.Sign(identity.KeyBlob, signatureData, flags); }
                    catch (SshAuthenticationException) { continue; }
                    completed.Reset(); succeeded = false; failure = null;
                    var signed = new RequestMessagePublicKey(ServiceName.UserAuthentication, Username, algorithm, identity.KeyBlob, signature);
                    SendMessage(session, signed);
                    WaitFor(session, completed, disconnected, error);
                    if (succeeded) return AuthenticationResult.Success;
                    if (failure != null) AllowedAuthentications = failure.AllowedAuthentications;
                    if (disconnected.WaitOne(0)) throw new SshConnectionException("SSH transport disconnected during agent authentication.");
                    if (error.WaitOne(0)) throw new SshConnectionException("SSH transport failed during agent authentication.");
                    // Partial success means a second authentication method is required.
                    if (failure?.PartialSuccess == true) return AuthenticationResult.PartialSuccess;
                }
            }
            return AuthenticationResult.Failure;
        }
        finally
        {
            session.Disconnected -= disconnectedHandler;
            session.ErrorOccured -= errorHandler;
            foreach (var (eventInfo, handler) in handlers)
                try { eventInfo.RemoveEventHandler(session, handler); } catch { }
            session.UnRegisterMessage("SSH_MSG_USERAUTH_PK_OK");
            session.UnRegisterMessage("SSH_MSG_USERAUTH_FAILURE");
            session.UnRegisterMessage("SSH_MSG_USERAUTH_SUCCESS");
            keys.Dispose(); completed.Dispose(); disconnected.Dispose(); error.Dispose();
        }
    }

    private static void WaitFor(Session session, WaitHandle signal, WaitHandle disconnected, WaitHandle error)
    {
        var timeout = session.ConnectionInfo.Timeout;
        var handles = new[] { signal, disconnected, error };
        var index = WaitHandle.WaitAny(handles, timeout);
        if (index == WaitHandle.WaitTimeout) throw new SshOperationTimeoutException("Timed out waiting for SSH agent authentication response.");
        if (index == 1) throw new SshConnectionException("SSH transport disconnected during agent authentication.");
        if (index == 2) throw new SshConnectionException("SSH transport failed during agent authentication.");
    }

    private static IEnumerable<(string Algorithm, uint Flags)> Algorithms(string keyType)
    {
        if (keyType == "ssh-rsa")
        {
            yield return ("rsa-sha2-512", 4);
            yield return ("rsa-sha2-256", 2);
            yield return ("ssh-rsa", 0);
            yield break;
        }
        yield return (keyType, 0);
    }

    private static byte[] BuildSignatureData(byte[] sessionId, string username, string algorithm, byte[] keyBlob)
    {
        using var data = new MemoryStream();
        SshAgentWriter.WriteString(data, sessionId);
        data.WriteByte(50); // SSH_MSG_USERAUTH_REQUEST
        SshAgentWriter.WriteString(data, Encoding.UTF8.GetBytes(username));
        SshAgentWriter.WriteString(data, "ssh-connection"u8);
        SshAgentWriter.WriteString(data, "publickey"u8);
        data.WriteByte(1);
        SshAgentWriter.WriteString(data, Encoding.UTF8.GetBytes(algorithm));
        SshAgentWriter.WriteString(data, keyBlob);
        return data.ToArray();
    }

    private static void SendMessage(Session session, Message message)
    {
        var method = typeof(Session).GetMethod("SendMessage", BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null, types: [typeof(Message)], modifiers: null)
            ?? throw new NotSupportedException("SSH.NET no longer exposes its SSH message sender.");
        try { method.Invoke(session, [message]); }
        catch (TargetInvocationException error) when (error.InnerException != null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
        }
    }
}

internal ref struct SshAgentReader
{
    private readonly ReadOnlySpan<byte> data;
    private int offset;
    public SshAgentReader(ReadOnlySpan<byte> data) { this.data = data; offset = 0; }
    public bool AtEnd => offset == data.Length;

    public uint ReadUInt32()
    {
        Ensure(4);
        var value = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(offset, 4));
        offset += 4;
        return value;
    }

    public byte[] ReadString()
    {
        var length = ReadUInt32();
        if (length > MaxFieldLength) throw new InvalidDataException("SSH agent field is too large.");
        Ensure(checked((int)length));
        var result = data.Slice(offset, checked((int)length)).ToArray();
        offset += checked((int)length);
        return result;
    }

    private const uint MaxFieldLength = 1024 * 1024;
    private void Ensure(int size)
    {
        if (size < 0 || offset > data.Length - size) throw new EndOfStreamException("Truncated SSH agent packet.");
    }
}

internal static class SshAgentWriter
{
    public static void WriteString(Stream stream, ReadOnlySpan<byte> data)
    {
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(length, checked((uint)data.Length));
        stream.Write(length);
        stream.Write(data);
    }
}

/// <summary>Pageant's WM_COPYDATA + named shared-memory transport.</summary>
[SupportedOSPlatform("windows")]
internal static class PageantTransport
{
    private const uint WmCopyData = 0x004A;
    private const nuint AgentCopyDataId = 0x804E50BA;
    private const uint SmtoAbortIfHung = 0x0002;

    public static bool IsAvailable => OperatingSystem.IsWindows() && FindPageantWindow() != 0;

    public static byte[] Send(byte[] request)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Pageant is only available on Windows.");
        var window = FindPageantWindow();
        if (window == 0) throw new IOException("Pageant is not running.");
        return SendToWindow(window, request);
    }

    internal static byte[] SendToWindow(nint window, byte[] request)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Pageant is only available on Windows.");
        if (window == 0) throw new ArgumentOutOfRangeException(nameof(window));
        var mapName = $"PageantRequest{GetCurrentThreadId():X8}";
        using var mapping = new PageantMappedSection(mapName, 1024 * 1024);
        var packet = new byte[request.Length + 4];
        BinaryPrimitives.WriteUInt32BigEndian(packet, checked((uint)request.Length));
        request.CopyTo(packet, 4);
        Marshal.Copy(packet, 0, mapping.View, packet.Length);

        var nameBytes = Encoding.ASCII.GetBytes(mapName + "\0");
        var namePointer = Marshal.AllocHGlobal(nameBytes.Length);
        var copyDataPointer = Marshal.AllocHGlobal(Marshal.SizeOf<CopyDataStruct>());
        try
        {
            Marshal.Copy(nameBytes, 0, namePointer, nameBytes.Length);
            Marshal.StructureToPtr(new CopyDataStruct { DataId = AgentCopyDataId, ByteCount = nameBytes.Length, Data = namePointer }, copyDataPointer, false);
            var delivered = SendMessageTimeout(window, WmCopyData, 0, copyDataPointer, SmtoAbortIfHung, 5000, out var result);
            if (delivered == 0 || result == 0) throw new IOException("Pageant did not respond to the SSH agent request.");
        }
        finally
        {
            Marshal.FreeHGlobal(copyDataPointer);
            Marshal.FreeHGlobal(namePointer);
        }

        Marshal.Copy(mapping.View, packet, 0, 4);
        var responseLength = BinaryPrimitives.ReadUInt32BigEndian(packet);
        if (responseLength is < 1 or > 1024 * 1024 - 4) throw new InvalidDataException("Pageant returned an invalid SSH agent response length.");
        var response = new byte[responseLength];
        Marshal.Copy(mapping.View + 4, response, 0, response.Length);
        return response;
    }

    private static nint FindPageantWindow() => FindWindow("Pageant", "Pageant") is var matched && matched != 0
        ? matched : FindWindow(null, "Pageant");

    private sealed class PageantMappedSection : IDisposable
    {
        private nint handle;
        public nint View { get; }

        public PageantMappedSection(string name, int size)
        {
            using var identity = WindowsIdentity.GetCurrent();
            var userSid = identity.User?.Value ?? throw new IOException("Cannot determine the current Windows user for Pageant IPC.");
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor($"O:{userSid}D:(A;;GA;;;{userSid})", 1, out var descriptor, out _))
                throw new IOException("Cannot create the Pageant shared-memory security descriptor.");
            try
            {
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), InheritHandle = true, SecurityDescriptor = descriptor };
                handle = CreateFileMapping(new nint(-1), ref attributes, 0x04, 0, checked((uint)size), name);
                if (handle == 0) throw new IOException("Cannot create Pageant shared memory.", Marshal.GetExceptionForHR(Marshal.GetHRForLastWin32Error()));
                View = MapViewOfFile(handle, 0xF001F, 0, 0, checked((nuint)size));
                if (View == 0) throw new IOException("Cannot map Pageant shared memory.", Marshal.GetExceptionForHR(Marshal.GetHRForLastWin32Error()));
            }
            catch { Dispose(); throw; }
            finally { LocalFree(descriptor); }
        }

        public void Dispose()
        {
            if (View != 0) UnmapViewOfFile(View);
            if (handle != 0) { CloseHandle(handle); handle = 0; }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public nint SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CopyDataStruct { public nuint DataId; public int ByteCount; public nint Data; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint FindWindow(string? className, string? windowName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor, uint revision, out nint securityDescriptor, out uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateFileMapping(nint file, ref SecurityAttributes attributes, uint protection, uint maximumSizeHigh, uint maximumSizeLow, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint MapViewOfFile(nint file, uint access, uint offsetHigh, uint offsetLow, nuint bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnmapViewOfFile(nint view);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint memory);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SendMessageTimeout(nint window, uint message, nint wParam, nint lParam,
        uint flags, uint timeout, out nint result);
}
