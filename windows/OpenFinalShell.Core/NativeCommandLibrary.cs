using System.Text.Json.Nodes;
using System.Security.Cryptography;
using System.Text;

namespace OpenFinalShell.Core;

public sealed class NativeCommandLibrary
{
    public const bool DefaultSnippetAutoEnter = true;
    private readonly NativeStore store;
    public NativeCommandLibrary(NativeStore store) => this.store = store;

    private sealed record DefaultGroup(string Id, string NameKey);
    private sealed record DefaultSnippet(string Id, string GroupId, string NameKey, string Command, bool AutoEnter);

    private static readonly DefaultGroup[] DefaultGroups =
    [
        new("builtin-system", "native.commands.defaults.groups.system"),
        new("builtin-network", "native.commands.defaults.groups.network"),
        new("builtin-audit", "native.commands.defaults.groups.audit"),
        new("builtin-tools", "native.commands.defaults.groups.tools"),
        new("builtin-scan", "native.commands.defaults.groups.scan")
    ];

    private static readonly DefaultSnippet[] DefaultSnippets =
    [
        new("builtin-uname", "builtin-system", "native.commands.defaults.snippets.uname", "uname -a", true),
        new("builtin-uptime", "builtin-system", "native.commands.defaults.snippets.uptime", "uptime", true),
        new("builtin-identity", "builtin-system", "native.commands.defaults.snippets.identity", "id", true),
        new("builtin-disk", "builtin-system", "native.commands.defaults.snippets.disk", "df -hT", true),
        new("builtin-memory", "builtin-system", "native.commands.defaults.snippets.memory", "free -h", true),
        new("builtin-cpu", "builtin-system", "native.commands.defaults.snippets.cpu", "ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 11", true),
        new("builtin-memory-processes", "builtin-system", "native.commands.defaults.snippets.memoryProcesses", "ps -eo pid,comm,%mem,%cpu --sort=-%mem | head -n 11", true),
        new("builtin-addresses", "builtin-system", "native.commands.defaults.snippets.addresses", "ip -br address", true),
        new("builtin-routes", "builtin-system", "native.commands.defaults.snippets.routes", "ip route", true),
        new("builtin-listeners", "builtin-system", "native.commands.defaults.snippets.listeners", "ss -lntup", true),
        new("builtin-systemd-failed", "builtin-system", "native.commands.defaults.snippets.systemdFailed", "systemctl --failed --no-pager", true),
        new("builtin-journal-warnings", "builtin-system", "native.commands.defaults.snippets.journalWarnings", "journalctl -p warning --since \"24 hours ago\" --no-pager", true),
        new("builtin-openrc-status", "builtin-system", "native.commands.defaults.snippets.openrcStatus", "rc-status --all", true),
        new("builtin-alpine-log", "builtin-system", "native.commands.defaults.snippets.alpineLog", "logread | tail -n 100", true),
        new("builtin-dns", "builtin-network", "native.commands.defaults.snippets.dns", "dig +short {{host}}", false),
        new("builtin-https", "builtin-network", "native.commands.defaults.snippets.https", "curl -I --max-time 10 https://{{host}}", false),
        new("builtin-ping", "builtin-network", "native.commands.defaults.snippets.ping", "ping -c 4 {{host}}", false),
        new("builtin-apt-updates", "builtin-audit", "native.commands.defaults.snippets.aptUpdates", "apt list --upgradable", true),
        new("builtin-dnf-updates", "builtin-audit", "native.commands.defaults.snippets.dnfUpdates", "dnf check-update", true),
        new("builtin-apk-updates", "builtin-audit", "native.commands.defaults.snippets.apkUpdates", "apk version -l '<'", true),
        new("builtin-sshd-effective", "builtin-audit", "native.commands.defaults.snippets.sshdEffective", "sshd -T | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication) '", true),
        new("builtin-install-debian", "builtin-tools", "native.commands.defaults.snippets.installDebian", "sudo apt-get update && sudo apt-get install -y curl dnsutils iproute2 procps nmap", false),
        new("builtin-install-rpm", "builtin-tools", "native.commands.defaults.snippets.installRpm", "sudo dnf install -y curl bind-utils iproute procps-ng nmap", false),
        new("builtin-install-alpine", "builtin-tools", "native.commands.defaults.snippets.installAlpine", "apk add curl bind-tools iproute2 procps nmap", false),
        new("builtin-scan-top100", "builtin-scan", "native.commands.defaults.snippets.scanTop100", "nmap -sT -T2 -Pn --top-ports 100 --open {{host}}", false),
        new("builtin-scan-port", "builtin-scan", "native.commands.defaults.snippets.scanPort", "nmap -sT -T2 -Pn -p {{port}} --open {{host}}", false)
    ];

    public bool SeedDefaultSnippets(Func<string, string> localize)
    {
        ArgumentNullException.ThrowIfNull(localize);
        var groups = DefaultGroups.Select((item, index) => new JsonObject
        {
            ["id"] = item.Id,
            ["name"] = localize(item.NameKey),
            ["order"] = index
        }).ToArray();
        var snippets = DefaultSnippets.Select((item, index) => new JsonObject
        {
            ["id"] = item.Id,
            ["groupId"] = item.GroupId,
            ["name"] = localize(item.NameKey),
            ["command"] = item.Command,
            ["autoEnter"] = item.AutoEnter,
            ["order"] = DefaultSnippets.Take(index).Count(previous => previous.GroupId == item.GroupId)
        }).ToArray();
        return store.SeedCommandLibraryOnce(groups, snippets);
    }

    public IReadOnlyList<NativeSnippetDuplicateGroup> FindDuplicates()
    {
        var groupNames = ListGroups().ToDictionary(item => item.Id, item => item.Name, StringComparer.Ordinal);
        return ListSnippets()
            .GroupBy(item => (item.GroupId, Command: NormalizeLineEndings(item.Command)))
            .Where(items => items.Count() > 1)
            .Select(items =>
            {
                var ordered = items.OrderBy(item => item.Order).ThenBy(item => item.Name, StringComparer.CurrentCulture).ToArray();
                var keyMaterial = ordered[0].GroupId + "\0" + NormalizeLineEndings(ordered[0].Command);
                var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(keyMaterial))).ToLowerInvariant();
                return new NativeSnippetDuplicateGroup(key, ordered[0].GroupId,
                    groupNames.GetValueOrDefault(ordered[0].GroupId, ordered[0].GroupId), ordered);
            })
            .OrderBy(item => groupNames.GetValueOrDefault(item.GroupId, item.GroupId), StringComparer.CurrentCulture)
            .ThenBy(item => item.Snippets[0].Order)
            .ToArray();
    }

    public int RemoveDuplicates(IReadOnlyList<NativeSnippetDuplicateSelection> selections)
    {
        ArgumentNullException.ThrowIfNull(selections);
        var groups = FindDuplicates();
        if (groups.Count == 0) return 0;
        if (selections.Count != groups.Count) throw new InvalidOperationException("The duplicate preview is out of date.");

        var deleteIds = new List<string>();
        foreach (var selection in selections)
        {
            var group = groups.FirstOrDefault(item => item.Key == selection.GroupKey);
            if (group == null || !group.Snippets.Any(item => item.Id == selection.KeepSnippetId)
                || !new HashSet<string>(group.Snippets.Select(item => item.Id), StringComparer.Ordinal)
                    .SetEquals(selection.PreviewSnippetIds))
                throw new InvalidOperationException("Choose one command to keep in each duplicate group.");
            deleteIds.AddRange(group.Snippets.Where(item => item.Id != selection.KeepSnippetId).Select(item => item.Id));
        }
        if (deleteIds.Count == 0) return 0;

        var revisions = deleteIds.Select(id =>
        {
            var value = store.Find("snippets", id) ?? throw new InvalidOperationException("The duplicate preview is out of date.");
            return new NativeStore.EntityRevision("snippets", id, value["_revision"]?.GetValue<long>() ?? 0);
        }).ToArray();
        store.DeleteWithSecrets(revisions, []);
        return revisions.Length;
    }

    private static string NormalizeLineEndings(string command) => command.Replace("\r\n", "\n", StringComparison.Ordinal);

    public IReadOnlyList<NativeSnippetGroup> ListGroups() => store.List("snippetGroups")
        .Select(value => new NativeSnippetGroup(value["id"]?.GetValue<string>() ?? "", value["name"]?.GetValue<string>() ?? "", value["order"]?.GetValue<double>() ?? 0))
        .Where(value => value.Id.Length > 0 && value.Name.Length > 0).OrderBy(value => value.Order).ThenBy(value => value.Name).ToArray();

    public IReadOnlyList<NativeSnippet> ListSnippets(string? groupId = null) => store.List("snippets")
        .Select(value => new NativeSnippet(value["id"]?.GetValue<string>() ?? "", value["groupId"]?.GetValue<string>() ?? "", value["name"]?.GetValue<string>() ?? "", value["command"]?.GetValue<string>() ?? "", value["autoEnter"]?.GetValue<bool>() ?? false, value["order"]?.GetValue<double>() ?? 0))
        .Where(value => value.Id.Length > 0 && value.Name.Length > 0 && value.Command.Length > 0 && (groupId == null || value.GroupId == groupId))
        .OrderBy(value => value.Order).ThenBy(value => value.Name).ToArray();

    public NativeSnippetGroup SaveGroup(string? id, string name, double? order = null)
    {
        var groupId = string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id.Trim();
        var existing = store.Find("snippetGroups", groupId);
        var value = existing ?? new JsonObject();
        value["id"] = groupId; value["name"] = Require(name, 200);
        value["order"] = order is { } requested && double.IsFinite(requested) ? requested : NativeSettings.ReadPath(existing, "order", 0d);
        store.Save("snippetGroups", groupId, value, existing?["_revision"]?.GetValue<long>());
        return new(groupId, value["name"]!.GetValue<string>(), value["order"]!.GetValue<double>());
    }

    public NativeSnippet SaveSnippet(string? id, string groupId, string name, string command, bool autoEnter, double? order = null)
    {
        if (store.Find("snippetGroups", groupId) == null) throw new InvalidDataException("Command group not found.");
        var snippetId = string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id.Trim();
        var existing = store.Find("snippets", snippetId);
        if (string.IsNullOrWhiteSpace(command) || command.Length > 32768 || command.Contains('\0')) throw new ArgumentException("Command library value is invalid.");
        var value = existing ?? new JsonObject();
        value["id"] = snippetId; value["groupId"] = groupId; value["name"] = Require(name, 200); value["command"] = command; value["autoEnter"] = autoEnter;
        value["order"] = order is { } requested && double.IsFinite(requested) ? requested : NativeSettings.ReadPath(existing, "order", 0d);
        store.Save("snippets", snippetId, value, existing?["_revision"]?.GetValue<long>());
        return new(snippetId, groupId, value["name"]!.GetValue<string>(), value["command"]!.GetValue<string>(), autoEnter, value["order"]!.GetValue<double>());
    }

    public void DeleteGroup(string id)
    {
        foreach (var snippet in ListSnippets(id)) DeleteSnippet(snippet.Id);
        var value = store.Find("snippetGroups", id) ?? throw new KeyNotFoundException("Command group not found.");
        store.Delete("snippetGroups", id, value["_revision"]?.GetValue<long>() ?? 0);
    }

    public void DeleteSnippet(string id)
    {
        var value = store.Find("snippets", id) ?? throw new KeyNotFoundException("Command not found.");
        store.Delete("snippets", id, value["_revision"]?.GetValue<long>() ?? 0);
    }

    public static string ExpandSnippet(string command, ConnectionProfile profile) => System.Text.RegularExpressions.Regex.Replace(
        command, @"\{\{\s*(host|user|port)\s*\}\}", match => match.Groups[1].Value switch {
            "host" => profile.Host, "user" => profile.Username, "port" => profile.Port.ToString(System.Globalization.CultureInfo.InvariantCulture), _ => match.Value });

    public void Move(string category, string id, int direction)
    {
        var value = store.Find(category, id) ?? throw new KeyNotFoundException("Command library item not found.");
        var ids = category switch {
            "snippetGroups" => ListGroups().Select(i => i.Id).ToList(),
            "snippets" => ListSnippets(value["groupId"]!.GetValue<string>()).Select(i => i.Id).ToList(),
            _ => throw new ArgumentException("Invalid command category.") };
        var index = ids.IndexOf(id); if (index < 0) return;
        var next = Math.Clamp(index + Math.Sign(direction), 0, ids.Count - 1);
        if (next == index) return;
        ids.RemoveAt(index); ids.Insert(next, id);
        for (var i = 0; i < ids.Count; i++) store.Patch(category, ids[i], new() { ["order"] = i });
    }

    public void AddHistory(string sessionId, string command)
    {
        if (!NativeSettings.Load(store).SaveCommandHistory || string.IsNullOrWhiteSpace(command) || command.Length > 2000) return;
        var value = new JsonObject { ["id"] = Guid.NewGuid().ToString("N"), ["sessionId"] = sessionId, ["command"] = command, ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        store.Save("commandHistory", value["id"]!.GetValue<string>(), value);
        var history = store.List("commandHistory").OrderByDescending(item => item["createdAt"]?.GetValue<long>() ?? 0).Skip(1000).ToArray();
        foreach (var old in history) if (old["id"]?.GetValue<string>() is { } id) try { store.Delete("commandHistory", id, old["_revision"]?.GetValue<long>() ?? 0); } catch { }
    }

    public IReadOnlyList<string> ListHistory(string? sessionId = null, int max = 200) => store.List("commandHistory")
        .Where(value => sessionId == null || value["sessionId"]?.GetValue<string>() == sessionId)
        .OrderByDescending(value => value["createdAt"]?.GetValue<long>() ?? 0)
        .Select(value => value["command"]?.GetValue<string>()).OfType<string>().Take(Math.Clamp(max, 1, 1000)).ToArray();

    public void ClearHistory(string? sessionId = null)
    {
        foreach (var value in store.List("commandHistory"))
            if ((sessionId == null || value["sessionId"]?.GetValue<string>() == sessionId) && value["id"]?.GetValue<string>() is { } id)
                try { store.Delete("commandHistory", id, value["_revision"]?.GetValue<long>() ?? 0); } catch { }
    }

    private static string Require(string value, int max) => !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= max ? value.Trim() : throw new ArgumentException("Command library value is invalid.");
}
