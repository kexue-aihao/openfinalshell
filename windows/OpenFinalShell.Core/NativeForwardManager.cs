using System.Collections.Concurrent;

namespace OpenFinalShell.Core;

/// <summary>
/// Owns native SSH port forwards and their persisted rules. A rule is never
/// reported active until SSH.NET has successfully bound/registered it.
/// </summary>
public sealed class NativeForwardManager : IDisposable
{
    private readonly NativeStore store;
    private readonly NativeSessionManager sessions;
    private readonly ConcurrentDictionary<string, NativeForwardRuntime> runtime = new(StringComparer.Ordinal);
    private bool disposed;

    public event Action<NativeForwardRuntime>? StateChanged;

    public NativeForwardManager(NativeStore store, NativeSessionManager sessions)
    {
        this.store = store;
        this.sessions = sessions;
        sessions.StateChanged += OnSessionStateChanged;
        foreach (var session in sessions.List())
        {
            sessions.Get(session.SessionId).ForwardTelemetryChanged += OnForwardTelemetryChanged;
            sessions.Get(session.SessionId).ForwardFailed += OnForwardFailed;
        }
        foreach (var rule in ListRules())
            runtime[rule.Id] = new(rule.Id, NativeForwardState.Stopped, null, 0, 0, null);
    }

    public IReadOnlyList<NativeForwardRule> ListRules()
    {
        var rules = new List<NativeForwardRule>();
        foreach (var value in store.List("forwards"))
        {
            try { rules.Add(NativeForwardRule.FromJson(value)); }
            catch { /* keep a corrupt rule from hiding the valid rules */ }
        }
        return rules;
    }

    public NativeForwardRule SaveRule(NativeForwardRule rule)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (store.Find("profiles", rule.ProfileId) == null) throw new InvalidOperationException("Connection profile not found.");
        Validate(rule);
        var revision = store.Save("forwards", rule.Id, rule.ToJson(), rule.Revision);
        var saved = rule with { Revision = revision };
        runtime.TryAdd(saved.Id, new(saved.Id, NativeForwardState.Stopped, null, 0, 0, null));
        return saved;
    }

    public void DeleteRule(string id, long expectedRevision)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        Stop(id);
        store.Delete("forwards", id, expectedRevision);
        runtime.TryRemove(id, out _);
    }

    public NativeForwardRuntime RuntimeOf(string id) => runtime.TryGetValue(id, out var value)
        ? value : new(id, NativeForwardState.Stopped, null, 0, 0, null);

    public IReadOnlyList<NativeForwardRuntime> ListRuntimes() => runtime.Values.OrderBy(x => x.ForwardId).ToArray();

    public async Task StartAsync(string id, CancellationToken cancellation = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var rule = FindRule(id) ?? throw new KeyNotFoundException("Forwarding rule not found.");
        if (RuntimeOf(id).State == NativeForwardState.Active) return;
        var session = sessions.List().FirstOrDefault(x => x.ProfileId == rule.ProfileId && x.State == NativeSessionState.Ready)
            ?? throw new InvalidOperationException("Open the connection before starting this forward.");
        cancellation.ThrowIfCancellationRequested();
        try
        {
            var nativeSession = sessions.Get(session.SessionId);
            nativeSession.ForwardTelemetryChanged -= OnForwardTelemetryChanged;
            nativeSession.ForwardTelemetryChanged += OnForwardTelemetryChanged;
            nativeSession.ForwardFailed -= OnForwardFailed;
            nativeSession.ForwardFailed += OnForwardFailed;
            nativeSession.StartForward(rule.Id, rule.ToJson());
            var telemetry = nativeSession.ForwardTelemetryOf(id);
            Publish(new(id, NativeForwardState.Active, session.SessionId, telemetry?.ActiveConnections ?? 0, telemetry?.TotalBytes ?? 0, null));
            await Task.CompletedTask;
        }
        catch (Exception error)
        {
            Publish(new(id, NativeForwardState.Error, session.SessionId, 0, 0, error.Message));
            throw;
        }
    }

    public void Stop(string id)
    {
        if (!runtime.TryGetValue(id, out var current)) return;
        if (current.SessionId is { } sessionId)
        {
            try { sessions.Get(sessionId).StopForward(id); } catch { /* session may already be gone */ }
            current = RuntimeOf(id);
        }
        Publish(new(id, NativeForwardState.Stopped, null, 0, current.TotalBytes, null));
    }

    public void StopAll() { foreach (var item in ListRuntimes()) if (item.State == NativeForwardState.Active) Stop(item.ForwardId); }

    private NativeForwardRule? FindRule(string id) => ListRules().FirstOrDefault(x => x.Id == id);

    private void OnSessionStateChanged(NativeSessionSnapshot snapshot)
    {
        foreach (var item in ListRuntimes().Where(x => x.SessionId == snapshot.SessionId))
        {
            if (snapshot.State is NativeSessionState.Closed or NativeSessionState.Failed)
                Publish(item with { State = NativeForwardState.Error, SessionId = null, ActiveConnections = 0, Error = snapshot.Error ?? "SSH session closed" });
        }
        if (snapshot.State != NativeSessionState.Ready) return;
        foreach (var rule in ListRules().Where(x => x.ProfileId == snapshot.ProfileId && x.AutoStart))
            _ = StartAsync(rule.Id).ContinueWith(_ => { }, TaskScheduler.Default);
    }

    private void OnForwardTelemetryChanged(ForwardTelemetrySnapshot telemetry)
    {
        if (!runtime.TryGetValue(telemetry.ForwardId, out var current) || current.State != NativeForwardState.Active) return;
        Publish(current with { ActiveConnections = Math.Max(0, telemetry.ActiveConnections), TotalBytes = Math.Max(0, telemetry.TotalBytes) });
    }

    private void OnForwardFailed(string forwardId, Exception error)
    {
        if (!runtime.TryGetValue(forwardId, out var current) || current.State != NativeForwardState.Active) return;
        Publish(current with { State = NativeForwardState.Error, SessionId = null, ActiveConnections = 0, Error = error.Message });
    }

    private void Publish(NativeForwardRuntime value)
    {
        runtime[value.ForwardId] = value;
        StateChanged?.Invoke(value);
    }

    private static void Validate(NativeForwardRule rule)
    {
        if (rule.Id.Length is < 1 or > 200 || rule.ProfileId.Length is < 1 or > 200 || rule.Label.Length is < 1 or > 120)
            throw new InvalidDataException("Invalid forwarding rule text.");
        if (rule.BindPort is < 1 or > 65535 || string.IsNullOrWhiteSpace(rule.BindAddress)) throw new InvalidDataException("Invalid forwarding bind address.");
        if (rule.Type != NativeForwardType.Dynamic && (string.IsNullOrWhiteSpace(rule.DestinationHost) || rule.DestinationPort is < 1 or > 65535))
            throw new InvalidDataException("Invalid forwarding destination.");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        sessions.StateChanged -= OnSessionStateChanged;
        foreach (var session in sessions.List())
        {
            sessions.Get(session.SessionId).ForwardTelemetryChanged -= OnForwardTelemetryChanged;
            sessions.Get(session.SessionId).ForwardFailed -= OnForwardFailed;
        }
        StopAll();
    }
}
