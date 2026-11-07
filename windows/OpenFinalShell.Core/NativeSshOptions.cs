using Renci.SshNet;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public static class NativeSshOptions
{
    public static void Apply(ConnectionInfo info, JsonObject? options)
    {
        var compression = info.CompressionAlgorithms.ToArray();
        info.CompressionAlgorithms.Clear();
        if (options?["compress"]?.GetValue<bool>() == true)
            foreach (var pair in compression.Where(p => p.Key != "none")) info.CompressionAlgorithms.Add(pair);
        foreach (var pair in compression.Where(p => p.Key == "none")) info.CompressionAlgorithms.Add(pair);
        if (options?["legacyAlgorithms"]?.GetValue<bool>() == true) return;
        foreach (var key in info.KeyExchangeAlgorithms.Keys.Where(k => k.Contains("sha1", StringComparison.Ordinal)).ToArray()) info.KeyExchangeAlgorithms.Remove(key);
        foreach (var key in info.HostKeyAlgorithms.Keys.Where(k => k is "ssh-rsa" or "ssh-dss").ToArray()) info.HostKeyAlgorithms.Remove(key);
        foreach (var key in info.Encryptions.Keys.Where(k => k.EndsWith("-cbc", StringComparison.Ordinal) || k.Contains("arcfour", StringComparison.Ordinal)).ToArray()) info.Encryptions.Remove(key);
    }
}
