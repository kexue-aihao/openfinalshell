using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

public sealed record NativeRdpProfileOptions(string? Domain, string? PasswordRef, bool Clipboard = true, bool AudioPlayback = true, string CertificatePolicy = "prompt")
{
    public static NativeRdpProfileOptions FromProfile(JsonObject profile) => new(
        profile["rdp"]?["domain"]?.GetValue<string>() ?? profile["domain"]?.GetValue<string>(),
        profile["rdp"]?["passwordRef"]?.GetValue<string>() ?? profile["auth"]?["passwordRef"]?.GetValue<string>(),
        profile["rdp"]?["clipboard"]?.GetValue<bool>() ?? true,
        profile["rdp"]?["audioPlayback"]?.GetValue<bool>() ?? true,
        profile["rdp"]?["certificatePolicy"]?.GetValue<string>() == "strict" ? "strict" : "prompt");

    public JsonObject Features() => new() { ["clipboard"] = Clipboard, ["clipboardFilesUpload"] = Clipboard,
        ["clipboardFilesPaste"] = Clipboard, ["audioPlayback"] = AudioPlayback, ["certificatePolicy"] = CertificatePolicy };
}
