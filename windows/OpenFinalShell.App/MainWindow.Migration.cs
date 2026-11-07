using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private void RefreshAfterPortableImport()
    {
        settings = NativeSettings.Load(store);
        localization.SetLanguage(settings.Language);
        savedKeys.Reload();
        savedProxies.Reload();
        knownHosts.Reload();
        forwardViewModel.Reload();
        CommandViewModel.Reload();
        aiViewModel.ReloadProviders();
        ConfigureLabels();
        ConfigureSettings();
        LoadProfiles();
        UpdateLanSyncUi();
    }

    private string FormatPortableImportResult(NativeImportResult result) =>
        localization.Format("settings.importResultSummary",
            ("profiles", result.Profiles.ToString()),
            ("aiProfiles", result.AiProfiles.ToString()),
            ("snippets", result.Snippets.ToString()),
            ("forwards", result.Forwards.ToString()),
            ("knownHosts", result.KnownHosts.ToString()),
            ("secrets", result.Secrets.ToString())) + " · " +
        localization.Format("native.migrationCategories",
            ("groups", result.Groups.ToString()),
            ("keys", result.PrivateKeys.ToString()),
            ("proxies", result.Proxies.ToString()),
            ("knownHosts", result.KnownHosts.ToString()),
            ("forwards", result.Forwards.ToString()),
            ("aiProfiles", result.AiProfiles.ToString())) + " · " +
        localization.Format("settings.importResultSkipped", ("skipped", result.Skipped.ToString()), ("invalid", "0"));

    private string FormatPortableImportResult(NativeLanSyncImportResult result) =>
        localization.Format("settings.importResultSummary",
            ("profiles", result.Profiles.ToString()),
            ("aiProfiles", result.AiProfiles.ToString()),
            ("snippets", result.Snippets.ToString()),
            ("forwards", result.Forwards.ToString()),
            ("knownHosts", result.KnownHosts.ToString()),
            ("secrets", result.Secrets.ToString())) + " · " +
        localization.Format("native.migrationCategories",
            ("groups", result.Groups.ToString()),
            ("keys", result.PrivateKeys.ToString()),
            ("proxies", result.Proxies.ToString()),
            ("knownHosts", result.KnownHosts.ToString()),
            ("forwards", result.Forwards.ToString()),
            ("aiProfiles", result.AiProfiles.ToString())) + " · " +
        localization.Format("settings.importResultSkipped", ("skipped", result.Skipped.ToString()), ("invalid", "0"));
}
