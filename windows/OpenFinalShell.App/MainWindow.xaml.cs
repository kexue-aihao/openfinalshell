using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.UI.Xaml.Input;
using OpenFinalShell.Core;
using OpenFinalShell.App.ViewModels;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace OpenFinalShell.App;

public sealed partial class MainWindow : Window
{
    private sealed class SessionTerminalSink
    {
        private readonly NativeSessionManager sessions;
        private readonly object gate = new();
        private readonly Queue<byte[]> pendingInput = new();
        private string? sessionId;
        public Controls.NativeTerminalCanvas? Terminal { get; set; }
        public Action<Exception>? Error { get; set; }
        public SessionTerminalSink(NativeSessionManager sessions) => this.sessions = sessions;
        public Task WriteAsync(byte[] bytes) => Terminal?.EnqueueOutputAsync(bytes) ?? Task.CompletedTask;
        public void Attach(Controls.NativeTerminalCanvas terminal)
        {
            if (Terminal is { } previous)
            {
                previous.Input -= WriteInput;
                previous.TerminalSizeChanged -= Resize;
            }
            Terminal = terminal;
            terminal.Input += WriteInput;
            terminal.TerminalSizeChanged += Resize;
        }
        public void Detach(Controls.NativeTerminalCanvas terminal)
        {
            if (!ReferenceEquals(Terminal, terminal)) return;
            terminal.Input -= WriteInput;
            terminal.TerminalSizeChanged -= Resize;
            Terminal = null;
        }
        public void Bind(string id)
        {
            byte[][] pending;
            lock (gate) { sessionId = id; pending = pendingInput.ToArray(); pendingInput.Clear(); }
            foreach (var bytes in pending) WriteInput(bytes);
            if (Terminal is { } terminal) Resize(terminal.Columns, terminal.Rows);
        }
        private void WriteInput(byte[] bytes)
        {
            string? target;
            lock (gate)
            {
                target = sessionId;
                if (target == null) { pendingInput.Enqueue(bytes.ToArray()); return; }
            }
            try { sessions.Get(target).Write(bytes); } catch (Exception error) { Error?.Invoke(error); }
        }
        private void Resize(int columns, int rows)
        {
            string? target;
            lock (gate) target = sessionId;
            if (target == null || columns <= 0 || rows <= 0) return;
            try { sessions.Get(target).Resize((uint)columns, (uint)rows); } catch (Exception error) { Error?.Invoke(error); }
        }
    }

    private readonly NativeInstanceCoordinator? coordinator;
    private readonly PlatformEnvironment environment;
    private readonly Localization localization = new();
    private readonly NativeStore store;
    private readonly ConnectionListViewModel connections = new();
    public ConnectionGroupViewModel ConnectionGroups { get; }
    private readonly SavedKeyViewModel savedKeys;
    private readonly SavedProxyViewModel savedProxies;
    private readonly KnownHostViewModel knownHosts;
    private readonly NativeAiService aiService;
    private readonly NativeAiViewModel aiViewModel;
    private readonly NativeCommandLibrary commandLibrary;
    public CommandLibraryViewModel CommandViewModel { get; }
    public NativeLanSyncViewModel LanSyncViewModel => lanSyncViewModel;
    private readonly NativeSessionManager sessionsManager;
    private readonly NativeForwardManager forwardManager;
    private readonly ForwardViewModel forwardViewModel;
    private readonly NativeLanSyncService lanSyncService;
    private readonly NativeLanSyncViewModel lanSyncViewModel;
    private readonly NativeTransferQueue transferQueue;
    private readonly TransferQueueViewModel transferViewModel;
    private readonly NativeRemoteEditorService remoteEditorService = new();
    private readonly Dictionary<string, TabViewItem> sessionTabs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FrameworkElement> sessionContents = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Controls.NativeTerminalCanvas> sessionTerminals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SessionTerminalSink> sessionOutputSinks = new(StringComparer.Ordinal);
    private string? selectedAiImagePath;
    private readonly Dictionary<string, RdpSessionViewModel> rdpSessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Controls.NativeRdpSurface> rdpSurfaces = new(StringComparer.Ordinal);
    private NativeSettings settings;
    private bool loadingSettings;
    private bool forwardDialogActive;
    private readonly NativeUpdateCoordinator updateCoordinator;
    private readonly NativeUpdateService updateService;
    private readonly CancellationTokenSource updateCancellation = new();
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? updateTimer;
    private bool updateCheckRunning;
    private bool initialUpdateCheckStarted;

    public MainWindow(PlatformEnvironment environment, NativeInstanceCoordinator? coordinator = null)
    {
        this.environment = environment; this.coordinator = coordinator;
        store = new NativeStore(NativeStore.DefaultDirectory, new DpapiProtector());
        ConnectionGroups = new ConnectionGroupViewModel(store);
        savedKeys = new SavedKeyViewModel(store);
        savedProxies = new SavedProxyViewModel(store);
        knownHosts = new KnownHostViewModel(store);
        aiService = new NativeAiService(store);
        aiViewModel = new NativeAiViewModel(aiService);
        commandLibrary = new NativeCommandLibrary(store);
        CommandViewModel = new CommandLibraryViewModel(commandLibrary);
        settings = NativeSettings.Load(store);
        localization.SetLanguage(settings.Language);
        sessionsManager = new NativeSessionManager(store);
        forwardManager = new NativeForwardManager(store, sessionsManager);
        forwardViewModel = new ForwardViewModel(forwardManager, key => localization[key]);
        lanSyncService = new NativeLanSyncService(store);
        lanSyncViewModel = new NativeLanSyncViewModel(lanSyncService);
        transferQueue = new NativeTransferQueue(sessionsManager);
        transferViewModel = new TransferQueueViewModel(transferQueue);
        var currentVersion = typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        updateCoordinator = new NativeUpdateCoordinator(sessionsManager, transferQueue, forwardManager, NativeUpdateService.DefaultPublicKey, NativeStore.DefaultDirectory);
        updateService = new NativeUpdateService(updateCoordinator, currentVersion, NativeUpdateService.DefaultPublicKey);
        updateService.StateChanged += OnUpdateStateChanged;
        sessionsManager.StateChanged += OnSessionStateChanged;
        InitializeComponent();
        var appIconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "OpenFinalShell.ico");
        if (File.Exists(appIconPath)) AppWindow.SetIcon(appIconPath);
        Closed += MainWindowClosed;
        ApplyPlatformResources();
        Title = $"OpenFinalShell Native Preview · {environment.Profile}";
        ProfilesList.ItemsSource = connections.Profiles;
        TransferList.ItemsSource = transferViewModel.Tasks;
        ForwardList.ItemsSource = forwardViewModel.Rules;
        LanSyncHost.Text = "127.0.0.1"; LanSyncPort.Value = 52133; LanSyncIncludeSecrets.IsOn = true;
        AiProviderChoice.ItemsSource = aiViewModel.Providers;
        AiMessages.ItemsSource = aiViewModel.Messages;
        CommandGroups.SelectedItem = CommandViewModel.SelectedGroup;
        CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet;
        aiViewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(NativeAiViewModel.SelectedProvider)) AiProviderChoice.SelectedItem = aiViewModel.SelectedProvider;
            if (args.PropertyName == nameof(NativeAiViewModel.Status)) Status.Text = aiViewModel.Status;
        };
        LoadProfiles();
        ConfigureLabels();
        ConfigureSettings();
        ApplyUpdateState(updateService.State);
        Root.Loaded += OnRootLoaded;
        Navigation.SelectedItem = ConnectionsItem;
    }

    private void ApplyPlatformResources()
    {
        if (Application.Current.Resources["ShellBackgroundBrush"] is Brush shellBackground)
            Root.Background = shellBackground;

        if (environment.Profile == "windows-11" && environment.MicaEligible)
        {
            // Mica is cosmetic and may be unavailable because of policy,
            // accessibility settings, remote sessions, or an older compositor.
            // Keep the same layout and fall back to the solid theme brush.
            try { SystemBackdrop = new MicaBackdrop(); }
            catch { SystemBackdrop = null; }
        }
    }

    private void ConfigureLabels()
    {
        ConnectionsItem.Content = localization["activity.connections"];
        TransfersItem.Content = localization["activity.transfers"];
        CommandsItem.Content = localization["snippet.new"];
        ForwardItem.Content = localization["activity.forwards"];
        AiItem.Content = localization["aiAssistant.title"];
        LanSyncItem.Content = localization["native.lansync.title"];
        NewButton.Content = localization["welcome.newConnection"];
        ImportButton.Content = localization["native.common.import"];
        MigrationImportButton.Content = localization["native.migrationImportButton"];
        // Keep the first-run shortcut available until any portable entity has
        // been imported or created, including keys/proxies/trust and snippets.
        var hasNativeData = new[] { "profiles", "groups", "forwards", "proxies", "privateKeys", "knownHosts", "snippetGroups", "snippets", "aiProfiles" }
            .Any(kind => store.List(kind).Count > 0);
        MigrationImportButton.Visibility = hasNativeData ? Visibility.Collapsed : Visibility.Visible;
        ExportButton.Content = localization["native.common.export"];
        SettingsHeading.Text = localization["activity.settings"];
        ResetTrustButton.Content = localization["native.settings.resetTrust"];
        UpdateHeading.Text = localization["native.update.title"];
        UpdateCurrentLabel.Text = localization.Format("native.update.current", ("version", updateService.CurrentVersion));
        CheckUpdatesButton.Content = localization["native.update.check"];
        DownloadUpdateButton.Content = localization["native.update.download"];
        InstallUpdateButton.Content = localization["native.update.install"];
        UpdateReleaseNotesButton.Content = localization["native.update.releaseNotes"];
        ApplyUpdateState(updateService.State);
        ManageKeysButton.Content = localization["native.keys.manage"];
        ManageProxiesButton.Content = localization["native.proxies.manage"];
        ManageKnownHostsButton.Content = localization["native.knownHosts.manage"];
        ConnectionGroupsHeading.Text = localization["native.groups.title"];
        NewConnectionGroupButton.Content = localization["native.groups.new"];
        EditConnectionGroupButton.Content = localization["native.common.edit"];
        DeleteConnectionGroupButton.Content = localization["native.common.delete"];
        MoveConnectionGroupUpButton.Content = localization["native.groups.moveUp"];
        MoveConnectionGroupDownButton.Content = localization["native.groups.moveDown"];
        EnvironmentLabel.Text = $"{environment.Profile} · build {environment.Build} · " +
            (environment.Supported ? localization["platform.available"] : localization["platform.unavailable"]);
        EditButton.Content = localization["native.common.edit"];
        DuplicateButton.Content = localization["native.common.duplicateConnection"];
        DeleteButton.Content = localization["native.common.delete"];
        ReconnectButton.Content = localization["native.common.reconnect"];
        ConfigureConnectionControls();
        PauseTransferButton.Content = localization["native.common.pause"];
        ResumeTransferButton.Content = localization["native.common.resume"];
        CancelTransferButton.Content = localization["native.common.cancelTransfer"];
        RetryTransferButton.Content = localization["native.common.retry"];
        ClearTransferButton.Content = localization["native.common.clearFinished"];
        Status.Text = localization["status.notConnected"];
        AiTestButton.Content = localization["native.ai.test"];
        AiDiscoverButton.Content = localization["native.ai.discover"];
        AiCapabilityButton.Content = localization["native.ai.capability"];
        AiConfigureButton.Content = localization["native.ai.configure"];
        AiImageButton.Content = localization["native.ai.image"];
        AiSendButton.Content = localization["native.ai.send"];
        AiCancelButton.Content = localization["native.ai.cancel"];
        AiClearButton.Content = localization["native.ai.clear"];
        AiInput.PlaceholderText = localization["native.ai.message"];
        NewGroupButton.Content = localization["native.commands.newGroup"];
        EditGroupButton.Content = localization["native.common.edit"];
        DeleteGroupButton.Content = localization["native.common.delete"];
        NewSnippetButton.Content = localization["native.commands.new"];
        EditSnippetButton.Content = localization["native.common.edit"];
        DuplicateSnippetButton.Content = localization["native.common.duplicate"];
        DeleteSnippetButton.Content = localization["native.common.delete"];
        SendSnippetButton.Content = localization["native.commands.send"];
        ClearHistoryButton.Content = localization["native.commands.clearHistory"];
        NewForwardButton.Content = localization["native.forward.new"];
        EditForwardButton.Content = localization["native.common.edit"];
        DeleteForwardButton.Content = localization["native.common.delete"];
        StartForwardButton.Content = localization["native.forward.start"];
        StopForwardButton.Content = localization["native.forward.stop"];
        RefreshForwardButton.Content = localization["native.common.refresh"];
        StartLanSyncButton.Content = localization["native.lansync.startReceive"];
        StopLanSyncButton.Content = localization["native.lansync.stopReceive"];
        SendLanSyncButton.Content = localization["native.lansync.send"];
        ScanLanSyncButton.Content = localization["native.lansync.scan"];
        CancelLanSyncButton.Content = localization["native.lansync.cancel"];
        LanSyncCodeLabel.Text = localization["native.lansync.code"];
        LanSyncPairingCode.Header = localization["native.lansync.code"];
        LanSyncIncludeSecrets.Header = localization["native.lansync.includeSecrets"];
        LanSyncHost.Header = localization["native.lansync.host"];
        LanSyncPort.Header = localization["native.lansync.port"];
        ApplyLanSyncButton.Content = localization["native.lansync.apply"];
        RejectLanSyncButton.Content = localization["native.lansync.reject"];
        lanSyncViewModel.PropertyChanged += LanSyncChanged;
        UpdateLanSyncUi();
    }

    private void ConfigureSettings()
    {
        loadingSettings = true;
        ThemeChoice.ItemsSource = new[] { "system", "light", "dark" };
        LanguageChoice.ItemsSource = new[] { "en-US", "zh-CN" };
        ThemeChoice.SelectedItem = settings.ThemeMode;
        LanguageChoice.SelectedItem = settings.Language;
        TransparencyChoice.IsOn = settings.ReduceTransparency;
        loadingSettings = false;
    }

    private void ConfigureConnectionControls()
    {
        if (ConnectionSortChoice == null || ConnectionGroupingChoice == null) return;
        var sort = settings.ConnectionSort;
        var grouping = settings.ConnectionGrouping;
        loadingSettings = true;
        ConnectionSortChoice.Header = localization["native.connections.sort"];
        ConnectionSortChoice.Items.Clear();
        ConnectionSortChoice.Items.Add(new ComboBoxItem { Content = localization["native.connections.sortName"], Tag = "name" });
        ConnectionSortChoice.Items.Add(new ComboBoxItem { Content = localization["native.connections.sortHost"], Tag = "host" });
        ConnectionSortChoice.Items.Add(new ComboBoxItem { Content = localization["native.connections.sortRecent"], Tag = "recent" });
        ConnectionSortChoice.SelectedItem = ConnectionSortChoice.Items.OfType<ComboBoxItem>().First(item => Equals(item.Tag, sort));
        ConnectionGroupingChoice.Header = localization["native.connections.grouping"];
        ConnectionGroupingChoice.Items.Clear();
        ConnectionGroupingChoice.Items.Add(new ComboBoxItem { Content = localization["native.connections.groupNone"], Tag = "none" });
        ConnectionGroupingChoice.Items.Add(new ComboBoxItem { Content = localization["native.connections.groupBy"], Tag = "group" });
        ConnectionGroupingChoice.SelectedItem = ConnectionGroupingChoice.Items.OfType<ComboBoxItem>().First(item => Equals(item.Tag, grouping));
        loadingSettings = false;
    }

    private void LoadProfiles()
    {
        connections.Configure(settings.ConnectionSort, settings.ConnectionGrouping);
        ConnectionGroups.Reload();
        connections.Reload(store, ConnectionGroups.Groups);
        ConnectionGroupsList.SelectedItem = ConnectionGroups.Selected;
        ProfilesList.SelectedItem = connections.Selected;
    }

    private void NavigationChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        var selected = args.SelectedItemContainer as NavigationViewItem
            ?? args.SelectedItem as NavigationViewItem
            ?? Navigation.SelectedItem as NavigationViewItem;
        var tag = args.IsSettingsSelected ? "settings" : selected?.Tag?.ToString();
        var itemIndex = sender.MenuItems.IndexOf(args.SelectedItem);
        if (string.IsNullOrWhiteSpace(tag) && itemIndex >= 0)
        {
            tag = itemIndex switch
            {
                0 => "connections",
                1 => "transfers",
                2 => "commands",
                3 => "forwards",
                4 => "ai",
                5 => "lansync",
                _ => null
            };
        }
        // NavigationView can materialize menu items through its generated
        // repeater without carrying the XAML Tag value on every WinAppSDK
        // build. Resolve the named items as a stable native fallback so a
        // selectable menu entry never silently opens the placeholder page.
        if (string.IsNullOrWhiteSpace(tag) && selected != null)
        {
            var label = selected.Content?.ToString();
            tag = selected == ConnectionsItem || label == localization["activity.connections"] ? "connections"
                : selected == TransfersItem || label == localization["activity.transfers"] ? "transfers"
                : selected == CommandsItem || label == localization["snippet.new"] ? "commands"
                : selected == ForwardItem || label == localization["activity.forwards"] ? "forwards"
                : selected == AiItem || label == localization["aiAssistant.title"] ? "ai"
                : selected == LanSyncItem || label == localization["native.lansync.title"] ? "lansync"
                : null;
        }
        // A generated container can raise a second selection notification
        // with no item after the direct Tapped route has already activated a
        // page. Do not replace the valid page with the placeholder in that
        // transient notification.
        if (tag is "connections" or "settings" or "transfers" or "commands" or "ai" or "forwards" or "lansync") ActivatePage(tag);
    }

    private void NavigationItemInvoked(NavigationView sender, NavigationViewItemInvokedEventArgs args)
    {
        if (args.IsSettingsInvoked) { ActivatePage("settings"); return; }
        var invoked = args.InvokedItemContainer as NavigationViewItem;
        var tag = invoked?.Tag?.ToString();
        if (string.IsNullOrWhiteSpace(tag))
        {
            var label = args.InvokedItem?.ToString();
            tag = label == localization["activity.connections"] ? "connections"
                : label == localization["activity.transfers"] ? "transfers"
                : label == localization["snippet.new"] ? "commands"
                : label == localization["activity.forwards"] ? "forwards"
                : label == localization["aiAssistant.title"] ? "ai"
                : label == localization["native.lansync.title"] ? "lansync"
                : null;
        }
        if (tag is "connections" or "settings" or "transfers" or "commands" or "ai" or "forwards" or "lansync") ActivatePage(tag);
    }

    private void NavigationMenuItemTapped(object sender, TappedRoutedEventArgs args)
    {
        if (sender is NavigationViewItem item && item.Tag?.ToString() is { } tag)
            ActivatePage(tag);
    }

    private void ActivatePage(string? tag)
    {
        ConnectionPage.Visibility = tag == "connections" ? Visibility.Visible : Visibility.Collapsed;
        SettingsPage.Visibility = tag == "settings" ? Visibility.Visible : Visibility.Collapsed;
        TransfersPage.Visibility = tag == "transfers" ? Visibility.Visible : Visibility.Collapsed;
        CommandsPage.Visibility = tag == "commands" ? Visibility.Visible : Visibility.Collapsed;
        AiPage.Visibility = tag == "ai" ? Visibility.Visible : Visibility.Collapsed;
        ForwardPage.Visibility = tag == "forwards" ? Visibility.Visible : Visibility.Collapsed;
        LanSyncPage.Visibility = tag == "lansync" ? Visibility.Visible : Visibility.Collapsed;
        FeaturePage.Visibility = tag is not ("connections" or "settings" or "transfers" or "commands" or "ai" or "forwards" or "lansync") ? Visibility.Visible : Visibility.Collapsed;
        if (FeaturePage.Visibility == Visibility.Visible)
        {
            FeatureHeading.Text = tag ?? "";
            FeatureDescription.Text = localization["platform.reason.awaiting-acceptance"];
        }
    }

    private async void NewConnection(object sender, RoutedEventArgs args)
    {
        await ShowConnectionEditorAsync(null);
    }

    private async void EditConnection(object sender, RoutedEventArgs args) => await ShowConnectionEditorAsync(connections.Selected);

    private async Task ShowConnectionEditorAsync(ConnectionProfile? existing)
    {
        var data = existing?.Data ?? new JsonObject();
        var name = new TextBox { Header = localization["native.name"], Text = existing?.Name ?? "", PlaceholderText = localization["native.productionPlaceholder"] };
        var host = new TextBox { Header = localization["native.host"], Text = existing?.Host ?? "", PlaceholderText = localization["native.hostPlaceholder"] };
        var port = new NumberBox { Header = localization["native.port"], Value = existing?.Port ?? 22, Minimum = 1, Maximum = 65535, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
        var user = new TextBox { Header = localization["native.username"], Text = existing?.Username ?? "", PlaceholderText = localization["native.usernamePlaceholder"] };
        var protocol = new ComboBox { Header = localization["native.protocol"], ItemsSource = new[] { "ssh", "rdp" }, SelectedItem = data["protocol"]?.GetValue<string>() ?? "ssh" };
        var domain = new TextBox { Header = localization["rdp.rdpDomain"], Text = data["domain"]?.GetValue<string>() ?? "", PlaceholderText = localization["rdp.rdpDomainPlaceholder"] };
        ToolTipService.SetToolTip(domain, localization["rdp.rdpDomainHint"]);
        var method = new ComboBox { Header = localization["native.authMethod"], ItemsSource = new[] { "password", "privateKey", "agent" }, SelectedItem = data["auth"]?["method"]?.GetValue<string>() ?? "password" };
        var password = new PasswordBox { Header = localization["native.password"] };
        var keyChoice = new ComboBox { Header = localization["native.keys.savedKey"], ItemsSource = savedKeys.Items, DisplayMemberPath = nameof(SavedKeyItem.Name), SelectedValuePath = nameof(SavedKeyItem.Id), SelectedValue = data["auth"]?["privateKeyId"]?.GetValue<string>() };
        var proxyChoices = new ComboBox { Header = localization["native.proxies.savedProxy"] };
        proxyChoices.Items.Add(new ComboBoxItem { Content = localization["native.proxies.direct"], Tag = "" });
        foreach (var proxy in savedProxies.Items) proxyChoices.Items.Add(new ComboBoxItem { Content = $"{proxy.Name} · {proxy.Type} · {proxy.Host}:{proxy.Port}", Tag = proxy.Id });
        var existingProxyId = data["proxyId"]?.GetValue<string>() ?? "";
        proxyChoices.SelectedItem = proxyChoices.Items.OfType<ComboBoxItem>().FirstOrDefault(item => Equals(item.Tag, existingProxyId));
        var group = new ComboBox { Header = localization["native.group"], ItemsSource = ConnectionGroups.Groups, DisplayMemberPath = nameof(ConnectionGroup.Name), SelectedValuePath = nameof(ConnectionGroup.Id), SelectedValue = data["groupId"]?.GetValue<string>() ?? data["group"]?.GetValue<string>() };
        var jumpHost = new ComboBox { Header = localization["native.jumpHost"] };
        jumpHost.Items.Add(new ComboBoxItem { Content = localization["native.jumpHostNone"], Tag = "" });
        foreach (var candidate in connections.Profiles.Where(item => item.Id != existing?.Id &&
                     item.Data["protocol"]?.GetValue<string>() != "rdp" && item.Data["jumpHostId"] == null))
        {
            jumpHost.Items.Add(new ComboBoxItem
            {
                Content = $"{candidate.Name} · {candidate.Username}@{candidate.Host}:{candidate.Port}",
                Tag = candidate.Id
            });
        }
        var existingJumpId = data["jumpHostId"]?.GetValue<string>();
        var selectedJumpItem = jumpHost.Items.OfType<ComboBoxItem>().FirstOrDefault(item => Equals(item.Tag?.ToString(), existingJumpId ?? ""));
        if (selectedJumpItem == null && !string.IsNullOrWhiteSpace(existingJumpId))
        {
            selectedJumpItem = new ComboBoxItem { Content = localization.Format("native.jumpHostMissing", ("id", existingJumpId)), Tag = existingJumpId };
            jumpHost.Items.Add(selectedJumpItem);
        }
        jumpHost.SelectedItem = selectedJumpItem ?? jumpHost.Items[0];
        var charsetValue = data["terminal"]?["charset"]?.GetValue<string>() ?? "utf8";
        charsetValue = charsetValue.ToLowerInvariant() switch { "utf-8" => "utf8", "gb-18030" => "gb18030", _ => charsetValue.ToLowerInvariant() };
        var charset = new ComboBox { Header = localization["native.charset"], ItemsSource = new[] { "utf8", "gb18030", "gbk", "big5", "latin1" }, SelectedItem = charsetValue };
        var termType = new TextBox { Header = localization["native.termType"], Text = data["terminal"]?["termType"]?.GetValue<string>() ?? "xterm-256color" };
        var startup = new TextBox { Header = localization["native.startupCommand"], Text = data["terminal"]?["startupCommand"]?.GetValue<string>() ?? "" };
        var keepAlive = new NumberBox { Header = localization["native.keepAlive"], Value = data["options"]?["keepaliveInterval"]?.GetValue<int>() ?? 15000, Minimum = 0, Maximum = 600000 };
        var timeout = new NumberBox { Header = localization["native.readyTimeout"], Value = data["options"]?["readyTimeout"]?.GetValue<int>() ?? 20000, Minimum = 1000, Maximum = 600000 };
        var sshOnly = new Control[] { group, method, keyChoice, proxyChoices, jumpHost, charset, termType, startup, keepAlive, timeout };
        void UpdateProtocolFields()
        {
            var isRdp = Equals(protocol.SelectedItem, "rdp");
            domain.Visibility = isRdp ? Visibility.Visible : Visibility.Collapsed;
            foreach (var control in sshOnly) control.Visibility = isRdp ? Visibility.Collapsed : Visibility.Visible;
            if (existing == null && isRdp && port.Value == 22) port.Value = 3389;
            else if (existing == null && !isRdp && port.Value == 3389) port.Value = 22;
        }
        protocol.SelectionChanged += (_, _) => UpdateProtocolFields();
        UpdateProtocolFields();
        var panel = new ScrollViewer { Content = new StackPanel { Spacing = 10, Children = { name, host, port, user, protocol, domain, group, method, password, keyChoice, proxyChoices, jumpHost, charset, termType, startup, keepAlive, timeout } }, MaxHeight = 640 };
        var dialog = new ContentDialog { Title = existing == null ? localization["native.newConnection"] : localization["native.common.edit"], Content = panel,
            PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        if (string.IsNullOrWhiteSpace(name.Text) || string.IsNullOrWhiteSpace(host.Text) || (protocol.SelectedItem?.ToString() == "ssh" && string.IsNullOrWhiteSpace(user.Text))) { ShowError(localization["native.validationFailed"]); return; }
        var id = existing?.Id ?? Guid.NewGuid().ToString("N");
        var secretRef = existing?.Data["auth"]?["passwordRef"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(password.Password)) secretRef = store.SaveSecret(password.Password);
        var payload = (JsonObject)data.DeepClone();
        payload["id"] = id; payload["name"] = name.Text.Trim(); payload["host"] = host.Text.Trim(); payload["port"] = (int)port.Value;
        payload["username"] = user.Text.Trim(); payload["protocol"] = protocol.SelectedItem?.ToString() ?? "ssh";
        if (payload["protocol"]?.GetValue<string>() == "rdp")
        {
            if (domain.Text.Length > 120) { ShowError(localization["rdp.rdpDomainTooLong"]); return; }
            if (string.IsNullOrWhiteSpace(domain.Text)) payload.Remove("domain"); else payload["domain"] = domain.Text.Trim();
        }
        var auth = payload["auth"] as JsonObject ?? new JsonObject();
        auth["method"] = payload["protocol"]?.GetValue<string>() == "rdp" ? "password" : method.SelectedItem?.ToString() ?? "password";
        auth["passwordRef"] = secretRef;
        if (payload["protocol"]?.GetValue<string>() != "rdp") auth["privateKeyId"] = keyChoice.SelectedValue?.ToString();
        payload["auth"] = auth;
        var selectedProxy = (proxyChoices.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        payload["proxyMode"] = payload["protocol"]?.GetValue<string>() == "rdp" || string.IsNullOrEmpty(selectedProxy) ? "direct" : "saved";
        payload["proxyId"] = payload["protocol"]?.GetValue<string>() == "rdp" || string.IsNullOrEmpty(selectedProxy) ? null : selectedProxy;
        var selectedJumpId = (jumpHost.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        if (payload["protocol"]?.GetValue<string>() == "rdp" || string.IsNullOrWhiteSpace(selectedJumpId)) payload.Remove("jumpHostId");
        else
        {
            if (selectedJumpId == id)
            {
                ShowError(localization["native.jumpHostInvalid"]);
                return;
            }
            var jumpData = store.Find("profiles", selectedJumpId);
            if (jumpData == null || jumpData["protocol"]?.GetValue<string>() == "rdp" || jumpData["jumpHostId"] != null)
            {
                ShowError(localization["native.jumpHostInvalid"]);
                return;
            }
            payload["jumpHostId"] = selectedJumpId;
        }
        payload.Remove("group");
        if (group.SelectedValue is string selectedGroup && !string.IsNullOrWhiteSpace(selectedGroup)) payload["groupId"] = selectedGroup;
        else payload.Remove("groupId");
        var terminal = payload["terminal"] as JsonObject ?? new JsonObject();
        terminal["charset"] = charset.SelectedItem?.ToString() ?? "utf8"; terminal["termType"] = termType.Text.Trim(); terminal["startupCommand"] = startup.Text; payload["terminal"] = terminal;
        var options = payload["options"] as JsonObject ?? new JsonObject();
        options["keepaliveInterval"] = (int)keepAlive.Value; options["readyTimeout"] = (int)timeout.Value; payload["options"] = options;
        var revision = store.Save("profiles", id, payload, existing?.Data["_revision"]?.GetValue<long>() ?? 0);
        _ = coordinator?.NotifyConfigurationChangedAsync("profiles", revision);
        LoadProfiles();
        connections.Selected = connections.Profiles.FirstOrDefault(x => x.Id == id);
        Status.Text = localization["native.common.saved"];
    }

    private async void DuplicateConnection(object sender, RoutedEventArgs args)
    {
        var selected = connections.Selected; if (selected == null) return;
        var id = Guid.NewGuid().ToString("N"); var copy = (JsonObject)selected.Data.DeepClone(); copy["id"] = id; copy["name"] = selected.Name + " (copy)"; copy.Remove("_revision");
        var revision = store.Save("profiles", id, copy); _ = coordinator?.NotifyConfigurationChangedAsync("profiles", revision); LoadProfiles(); connections.Selected = connections.Profiles.FirstOrDefault(x => x.Id == id);
        await Task.CompletedTask;
    }

    private void DeleteConnection(object sender, RoutedEventArgs args)
    {
        var selected = connections.Selected; if (selected == null) return;
        try { store.Delete("profiles", selected.Id, selected.Data["_revision"]?.GetValue<long>() ?? 0); _ = coordinator?.NotifyConfigurationChangedAsync("profiles", (selected.Data["_revision"]?.GetValue<long>() ?? 0) + 1); LoadProfiles(); Status.Text = localization["native.common.deleted"]; }
        catch (Exception error) { ShowError(error); }
    }

    private async void OpenConnection(object sender, ItemClickEventArgs args)
    {
        if (args.ClickedItem is not ConnectionProfile profile) return;
        try
        {
            if (string.Equals(profile.Data["protocol"]?.GetValue<string>(), "rdp", StringComparison.OrdinalIgnoreCase))
            {
                await OpenRdpConnectionAsync(profile);
                return;
            }
            var existing = sessionsManager.List().FirstOrDefault(snapshot => snapshot.ProfileId == profile.Id && snapshot.State is NativeSessionState.Ready or NativeSessionState.Connecting or NativeSessionState.Reconnecting);
            if (existing != null)
            {
                if (sessionTabs.TryGetValue(existing.SessionId, out var existingTab)) Sessions.SelectedItem = existingTab;
                else
                {
                    var terminal = new Controls.NativeTerminalCanvas { Margin = new Thickness(8) };
                    if (sessionOutputSinks.TryGetValue(existing.SessionId, out var sink)) { sink.Error = ShowError; sink.Attach(terminal); }
                    CreateSessionTerminalTab(profile, existing.SessionId, terminal);
                }
                RecordSuccessfulConnection(profile.Id);
                return;
            }
            var initialTerminal = new Controls.NativeTerminalCanvas { Margin = new Thickness(8) };
            var terminalSink = new SessionTerminalSink(sessionsManager) { Error = ShowError };
            terminalSink.Attach(initialTerminal);
            var snapshot = await sessionsManager.OpenAsync(profile, ConfirmHostAsync, PromptAsync, CancellationToken.None, terminalSink.WriteAsync);
            terminalSink.Bind(snapshot.SessionId);
            sessionOutputSinks[snapshot.SessionId] = terminalSink;
            CreateSessionTerminalTab(profile, snapshot.SessionId, initialTerminal);
            RecordSuccessfulConnection(profile.Id);
            Status.Text = $"{profile.Host}:{profile.Port} · {localization["native.connected"]}";
        }
        catch (Exception error) { ShowError(error); }
    }

    private void CreateSessionTerminalTab(ConnectionProfile profile, string sessionId, Controls.NativeTerminalCanvas terminal)
    {
        terminal.CommandEntered += command => CommandViewModel.AddHistory(sessionId, command);
        terminal.SearchRequested += () => _ = ShowTerminalSearchAsync(terminal);
        sessionTerminals[sessionId] = terminal;
        var openSftp = new Button { Content = localization["native.openSftp"], HorizontalAlignment = HorizontalAlignment.Left };
        openSftp.Click += (_, _) => OpenSftpTab(sessionId, profile.Name);
        var openMonitor = new Button { Content = localization["native.openMonitor"], HorizontalAlignment = HorizontalAlignment.Left };
        openMonitor.Click += (_, _) => OpenMonitorTab(sessionId, profile.Name);
        var openPortTraffic = new Button { Content = localization["native.portTraffic.title"], HorizontalAlignment = HorizontalAlignment.Left };
        openPortTraffic.Click += (_, _) => OpenPortTrafficTab(sessionId, profile.Name);
        var content = new Grid { RowDefinitions = { new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = new GridLength(1, GridUnitType.Star) } } };
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { openSftp, openMonitor, openPortTraffic } };
        content.Children.Add(toolbar); Grid.SetRow(terminal, 1); content.Children.Add(terminal);
        var tab = new TabViewItem { Header = profile.Name, Tag = sessionId };
        sessionTabs[sessionId] = tab;
        AddSessionTab(tab, content);
    }

    private void RecordSuccessfulConnection(string profileId)
    {
        try
        {
            var current = store.Find("profiles", profileId);
            if (current == null) return;
            current["lastConnectedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var revision = store.Save("profiles", profileId, current, current["_revision"]?.GetValue<long>() ?? 0);
            _ = coordinator?.NotifyConfigurationChangedAsync("profiles", revision);
            LoadProfiles();
            connections.Selected = connections.Profiles.FirstOrDefault(item => item.Id == profileId);
            ProfilesList.SelectedItem = connections.Selected;
        }
        catch (InvalidOperationException error) when (error.Message.Contains("revision conflict", StringComparison.OrdinalIgnoreCase))
        {
            // A second writer may update the profile while a session is opening.
            // Session success must not be turned into a connection failure merely
            // because its optional recent-use timestamp lost that race.
        }
    }

    private async Task ShowTerminalSearchAsync(Controls.NativeTerminalCanvas terminal)
    {
        var query = new TextBox { PlaceholderText = localization["searchPlaceholder"], MinWidth = 360 };
        var result = new TextBlock { Text = "0", VerticalAlignment = VerticalAlignment.Center };
        var previous = new Button { Content = localization["searchPrev"] };
        var next = new Button { Content = localization["searchNext"] };
        void UpdateResult() => result.Text = terminal.Search(query.Text).ToString();
        query.TextChanged += (_, _) => UpdateResult();
        previous.Click += (_, _) => result.Text = terminal.SearchPrevious().ToString();
        next.Click += (_, _) => result.Text = terminal.SearchNext().ToString();
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { previous, next, result } };
        var content = new StackPanel { Spacing = 8, Children = { query, actions } };
        var dialog = new ContentDialog
        {
            Title = localization["shortcut.search"], Content = content,
            PrimaryButtonText = localization["common.close"],
            XamlRoot = Root.XamlRoot
        };
        dialog.Opened += (_, _) => { query.Focus(FocusState.Programmatic); UpdateResult(); };
        await dialog.ShowAsync();
    }

    private async Task OpenRdpConnectionAsync(ConnectionProfile profile)
    {
        var id = Guid.NewGuid().ToString("N");
        var passwordRef = profile.Data["auth"]?["passwordRef"]?.GetValue<string>();
        var storedPassword = store.ReadSecret(passwordRef);
        var rdp = new RdpSessionViewModel(profile.Data);
        rdpSessions[id] = rdp;
        rdp.CertificateRequested += prompt => _ = HandleRdpCertificatePromptAsync(rdp, prompt);
        var surface = new Controls.NativeRdpSurface(rdp);
        rdpSurfaces[id] = surface;
        var state = new TextBlock { Text = localization["rdp.rdpTitle"], VerticalAlignment = VerticalAlignment.Center };
        var copy = new Button { Content = localization["native.rdp.copyRemoteClipboard"] };
        var paste = new Button { Content = localization["native.rdp.pasteLocalClipboard"] };
        var pasteFiles = new Button { Content = localization["native.rdp.pasteLocalFiles"] };
        var downloadFiles = new Button { Content = localization["native.rdp.downloadRemoteFiles"], IsEnabled = false };
        IReadOnlyList<NativeRdpRemoteFile> remoteFiles = [];
        var systemRdp = new Button { Content = localization["native.rdp.systemFallback"] };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(copy, localization["native.rdp.copyRemoteClipboard"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(paste, localization["native.rdp.pasteLocalClipboard"]);
        var disconnect = new Button { Content = localization["native.common.cancel"] };
        copy.Click += async (_, _) =>
        {
            try { await rdp.RequestClipboardTextAsync(); }
            catch (Exception error) { ShowError(error); }
        };
        paste.Click += async (_, _) =>
        {
            try { await rdp.SetClipboardTextAsync(await ReadWindowsClipboardTextAsync()); }
            catch (Exception error) { ShowError(error); }
        };
        pasteFiles.Click += async (_, _) =>
        {
            var picker = new FileOpenPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, WindowHandle());
            var selected = await picker.PickMultipleFilesAsync(); if (selected.Count == 0) return;
            try
            {
                var files = new List<NativeRdpClipboardFile>();
                foreach (var file in selected.Take(64))
                {
                    var properties = await file.GetBasicPropertiesAsync();
                    files.Add(new(file.Path, file.Name, checked((long)properties.Size)));
                }
                await rdp.SetClipboardFilesAsync(files);
                Status.Text = $"{localization["native.rdp.pasteLocalFiles"]} · {files.Count}";
            }
            catch (Exception error) { ShowError(error); }
        };
        downloadFiles.Click += async (_, _) =>
        {
            if (remoteFiles.Count == 0) return;
            var picker = new FolderPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, WindowHandle());
            var folder = await picker.PickSingleFolderAsync(); if (folder == null) return;
            try { await rdp.DownloadRemoteClipboardFilesAsync(folder.Path); Status.Text = localization["native.rdp.downloadRemoteFiles"]; }
            catch (Exception error) { ShowError(error); }
        };
        systemRdp.Click += (_, _) =>
        {
            try
            {
                Process.Start(new ProcessStartInfo("mstsc.exe", $"/v:{profile.Host}:{profile.Port}") { UseShellExecute = true });
                Status.Text = localization["native.rdp.systemFallback"];
            }
            catch (Exception error) { ShowError(error); }
        };
        disconnect.Click += async (_, _) => await rdp.StopAsync("user");
        rdp.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName is nameof(RdpSessionViewModel.State) or nameof(RdpSessionViewModel.Error))
                DispatcherQueue.TryEnqueue(() => state.Text = rdp.Error == null ? $"{localization["rdp.rdpTitle"]} · {rdp.State}" : $"{localization["rdp.rdpTitle"]} · {rdp.State} · {rdp.Error}");
        };
        rdp.CapabilitiesChanged += capabilities => DispatcherQueue.TryEnqueue(() =>
        {
            var audio = capabilities.AudioPlayback ? "✓" : "—";
            var files = capabilities.ClipboardFilesUpload && capabilities.ClipboardFilesPaste ? "✓" : "—";
            state.Text = $"{localization["rdp.rdpTitle"]} · {rdp.State} · {localization["native.rdp.fileClipboard"]} {files} · {localization["native.rdp.audio"]} {audio}";
            pasteFiles.IsEnabled = capabilities.ClipboardFilesUpload;
            downloadFiles.IsEnabled = capabilities.ClipboardFilesPaste && remoteFiles.Count > 0;
        });
        rdp.RemoteFilesReceived += files => DispatcherQueue.TryEnqueue(() =>
        {
            remoteFiles = files;
            downloadFiles.IsEnabled = files.Count > 0;
            Status.Text = $"{localization["native.rdp.downloadRemoteFiles"]} · {files.Count}";
        });
        rdp.ClipboardTextReceived += async value =>
        {
            DispatcherQueue.TryEnqueue(() =>
            {
                var package = new Windows.ApplicationModel.DataTransfer.DataPackage(); package.SetText(value);
                Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
                Status.Text = localization["native.rdp.clipboardCopied"];
            });
        };
        rdp.AudioStateChanged += (audioState, audioError) => DispatcherQueue.TryEnqueue(() =>
            Status.Text = audioError == null ? $"{localization["rdp.rdpTitle"]} · audio: {audioState}" : $"{localization["rdp.rdpTitle"]} · audio: {audioError}");
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(8), Children = { state, copy, paste, pasteFiles, downloadFiles, systemRdp, disconnect } };
        var content = new Grid { RowDefinitions = { new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = new GridLength(1, GridUnitType.Star) } } };
        content.Children.Add(toolbar); Grid.SetRow(surface, 1); content.Children.Add(surface);
        var tab = new TabViewItem { Header = profile.Name, Tag = id };
        sessionTabs[id] = tab;
        AddSessionTab(tab, content);
        try
        {
            await rdp.StartAsync();
            var credential = storedPassword;
            if (string.IsNullOrEmpty(credential))
            {
                credential = await PromptAsync(localization["native.password"], false);
            }
            if (string.IsNullOrEmpty(credential))
            {
                surface.Dispose(); rdpSurfaces.Remove(id);
                await rdp.StopAsync("credential-cancelled");
                await rdp.DisposeAsync(); rdpSessions.Remove(id); sessionTabs.Remove(id); RemoveSessionTab(tab);
                return;
            }
            await rdp.ProvidePasswordAsync(credential);
            Status.Text = localization["rdp.rdpLaunched"];
        }
        catch
        {
            surface.Dispose(); rdpSurfaces.Remove(id);
            await rdp.DisposeAsync(); rdpSessions.Remove(id); sessionTabs.Remove(id); RemoveSessionTab(tab);
            throw;
        }
    }

    private async Task HandleRdpCertificatePromptAsync(RdpSessionViewModel session, RdpCertificatePrompt prompt)
    {
        var decision = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!DispatcherQueue.TryEnqueue(async () =>
        {
            var detail = $"{prompt.Host}:{prompt.Port}\n{prompt.Subject}\n{prompt.Issuer}\n{prompt.Fingerprint}";
            var dialog = new ContentDialog { Title = localization["rdp.rdpCertificatePolicy"], Content = new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap }, PrimaryButtonText = localization["native.common.continue"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
            try { decision.TrySetResult(await dialog.ShowAsync() == ContentDialogResult.Primary); }
            catch (Exception error) { decision.TrySetException(error); }
        })) return;
        await session.AcceptCertificateAsync(prompt.RequestId, await decision.Task);
    }

    private static async Task<string> ReadWindowsClipboardTextAsync()
    {
        var view = Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
        return view.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text) ? await view.GetTextAsync() : string.Empty;
    }

    private void OpenSftpTab(string sessionId, string profileName)
    {
        var session = sessionsManager.Get(sessionId);
        var browser = new Controls.NativeSftpBrowser(session, transferQueue, WindowHandle, key => localization[key], path => OpenRemoteEditorTab(sessionId, profileName, path));
        var tab = new TabViewItem { Header = $"{profileName} · SFTP", Tag = $"sftp:{sessionId}" };
        AddSessionTab(tab, browser);
    }

    private void OpenRemoteEditorTab(string sessionId, string profileName, string path)
    {
        var existing = Sessions.TabItems.OfType<TabViewItem>().FirstOrDefault(item =>
            string.Equals(item.Tag?.ToString(), $"editor:{sessionId}:{path}", StringComparison.Ordinal));
        if (existing != null) { Sessions.SelectedItem = existing; return; }
        NativeSession session;
        try { session = sessionsManager.Get(sessionId); }
        catch (Exception error) { ShowError(error); return; }
        var editor = new Controls.NativeRemoteEditor(session, remoteEditorService, key => localization[key], WindowHandle(), Root) { Tag = path };
        var tab = new TabViewItem { Header = $"{profileName} · {Path.GetFileName(path)}", Tag = $"editor:{sessionId}:{path}" };
        sessionTabs[$"editor:{sessionId}:{path}"] = tab;
        AddSessionTab(tab, editor);
    }

    private void OpenMonitorTab(string sessionId, string profileName)
    {
        var session = sessionsManager.Get(sessionId);
        var panel = new Controls.NativeMonitorPanel(session, settings.MonitorIntervalMs, key => localization[key]);
        var tab = new TabViewItem { Header = $"{profileName} · {localization["native.monitor.title"]}", Tag = $"monitor:{sessionId}" };
        AddSessionTab(tab, panel);
    }

    private void OpenPortTrafficTab(string sessionId, string profileName)
    {
        var session = sessionsManager.Get(sessionId);
        var panel = new Controls.NativePortTrafficPanel(session, settings.MonitorIntervalMs, key => localization[key]);
        var tab = new TabViewItem { Header = $"{profileName} · {localization["native.portTraffic.title"]}", Tag = $"portTraffic:{sessionId}" };
        AddSessionTab(tab, panel);
    }

    private void AddSessionTab(TabViewItem tab, FrameworkElement content)
    {
        if (tab.Tag is not string tag) throw new ArgumentException("Every native session tab requires a tag.", nameof(tab));
        sessionContents[tag] = content;
        Sessions.TabItems.Add(tab);
        Sessions.SelectedItem = tab;
        ShowSelectedSessionContent();
    }

    private void SessionSelectionChanged(object sender, SelectionChangedEventArgs args) => ShowSelectedSessionContent();

    private void ShowSelectedSessionContent()
    {
        SessionContent.Content = Sessions.SelectedItem is TabViewItem tab &&
            tab.Tag?.ToString() is { } tag && sessionContents.TryGetValue(tag, out var content)
                ? content
                : null;
    }
    private void RemoveSessionTab(TabViewItem tab)
    {
        if (tab.Tag?.ToString() is { } tag) sessionContents.Remove(tag);
        Sessions.TabItems.Remove(tab);
        ShowSelectedSessionContent();
    }
    private static string? SessionIdForTag(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        if (tag.StartsWith("editor:", StringComparison.Ordinal))
        {
            var separator = tag.IndexOf(':', "editor:".Length);
            return separator > "editor:".Length ? tag["editor:".Length..separator] : null;
        }
        return tag.StartsWith("sftp:", StringComparison.Ordinal) ||
               tag.StartsWith("monitor:", StringComparison.Ordinal) ||
               tag.StartsWith("portTraffic:", StringComparison.Ordinal)
            ? tag[(tag.IndexOf(':') + 1)..]
            : tag;
    }
    private void OnSessionStateChanged(NativeSessionSnapshot snapshot)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            if (snapshot.State == NativeSessionState.Failed && !string.IsNullOrWhiteSpace(snapshot.Error)) ShowError(snapshot.Error);
            Status.Text = $"{snapshot.ProfileName} · {snapshot.State}";
        });
    }

    private async void ReconnectSession(object sender, RoutedEventArgs args)
    {
        if (Sessions.SelectedItem is not TabViewItem tab) return;
        var sessionId = SessionIdForTag(tab.Tag?.ToString());
        if (string.IsNullOrWhiteSpace(sessionId)) return;
        try { await sessionsManager.ReconnectAsync(sessionId, CancellationToken.None); Status.Text = localization["native.connected"]; }
        catch (Exception error) { ShowError(error); }
    }

    private void ForwardSelectionChanged(object sender, SelectionChangedEventArgs args) => forwardViewModel.Selected = ForwardList.SelectedItem as NativeForwardRow;

    private async Task EditForwardAsync(NativeForwardRule? existing)
    {
        if (forwardDialogActive) return;
        forwardDialogActive = true;
        try { await EditForwardCoreAsync(existing); }
        finally { forwardDialogActive = false; }
    }

    private async Task EditForwardCoreAsync(NativeForwardRule? existing)
    {
        var profiles = connections.Profiles.ToList();
        if (profiles.Count == 0) { ShowError(localization["native.forward.noConnections"]); return; }
        var profile = new ComboBox { Header = localization["native.forward.connection"], ItemsSource = profiles, DisplayMemberPath = nameof(ConnectionProfile.Name), SelectedItem = profiles.FirstOrDefault(x => x.Id == existing?.ProfileId) ?? connections.Selected ?? profiles[0] };
        var type = new ComboBox { Header = localization["native.forward.type"], ItemsSource = new[] { "local", "remote", "dynamic" }, SelectedItem = existing?.Type.ToString().ToLowerInvariant() ?? "local" };
        var label = new TextBox { Header = localization["native.name"], Text = existing?.Label ?? "" };
        var bind = new TextBox { Header = localization["native.forward.bindAddress"], Text = existing?.BindAddress ?? "127.0.0.1" };
        var bindPort = new NumberBox { Header = localization["native.forward.bindPort"], Value = existing?.BindPort ?? 8080, Minimum = 1, Maximum = 65535 };
        var destination = new TextBox { Header = localization["native.forward.destinationHost"], Text = existing?.DestinationHost ?? "127.0.0.1" };
        var destinationPort = new NumberBox { Header = localization["native.forward.destinationPort"], Value = existing?.DestinationPort ?? 80, Minimum = 1, Maximum = 65535 };
        var autoStart = new ToggleSwitch { Header = localization["native.forward.autoStart"], IsOn = existing?.AutoStart ?? false };
        void UpdateDestinationState() { var dynamic = Equals(type.SelectedItem, "dynamic"); destination.IsEnabled = !dynamic; destinationPort.IsEnabled = !dynamic; }
        type.SelectionChanged += (_, _) => UpdateDestinationState(); UpdateDestinationState();
        var dialog = new ContentDialog { Title = existing == null ? localization["native.forward.new"] : localization["native.common.edit"],
            Content = new ScrollViewer { MaxHeight = 600, Content = new StackPanel { Spacing = 8, Children = { profile, type, label, bind, bindPort, destination, destinationPort, autoStart } } },
            PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        if (profile.SelectedItem is not ConnectionProfile selectedProfile || string.IsNullOrWhiteSpace(label.Text) || string.IsNullOrWhiteSpace(bind.Text)) { ShowError(localization["native.validationFailed"]); return; }
        try
        {
            var typeValue = type.SelectedItem?.ToString() switch { "remote" => NativeForwardType.Remote, "dynamic" => NativeForwardType.Dynamic, _ => NativeForwardType.Local };
            var draft = new NativeForwardRule(existing?.Id ?? Guid.NewGuid().ToString("N"), selectedProfile.Id, typeValue,
                label.Text.Trim(), bind.Text.Trim(), (int)bindPort.Value, typeValue == NativeForwardType.Dynamic ? null : destination.Text.Trim(),
                typeValue == NativeForwardType.Dynamic ? null : (int)destinationPort.Value, autoStart.IsOn, existing?.Revision ?? 0);
            var saved = forwardViewModel.Save(draft); _ = coordinator?.NotifyConfigurationChangedAsync("forwards", saved.Revision);
            Status.Text = localization["native.common.saved"];
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void NewForward(object sender, RoutedEventArgs args) => await EditForwardAsync(null);
    private async void EditForward(object sender, RoutedEventArgs args) => await EditForwardAsync(forwardViewModel.Selected?.Rule);
    private async void DeleteForward(object sender, RoutedEventArgs args)
    {
        if (forwardViewModel.Selected == null) return;
        var dialog = new ContentDialog { Title = localization["native.common.delete"], Content = forwardViewModel.Selected.Label,
            PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
            try { forwardViewModel.DeleteSelected(); } catch (Exception error) { ShowError(error); }
    }
    private async void StartForward(object sender, RoutedEventArgs args)
    {
        try { await forwardViewModel.StartSelectedAsync(); Status.Text = localization["native.forward.active"]; }
        catch (Exception error) { ShowError(error); }
    }
    private void StopForward(object sender, RoutedEventArgs args) { forwardViewModel.StopSelected(); Status.Text = localization["native.forward.stopped"]; }
    private void RefreshForwards(object sender, RoutedEventArgs args) => forwardViewModel.Reload();

    private void LanSyncChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args) => DispatcherQueue.TryEnqueue(UpdateLanSyncUi);
    private void UpdateLanSyncUi()
    {
        LanSyncStatus.Text = lanSyncViewModel.State.TcpPort is { } tcpPort ? $"{lanSyncViewModel.Status} · TCP {tcpPort}" : lanSyncViewModel.Status;
        LanSyncCode.Text = lanSyncViewModel.State.PairingCode;
        LanSyncIncoming.Text = lanSyncViewModel.Incoming is { } incoming ? localization.Format("native.lansync.incoming", ("device", incoming.DeviceName), ("profiles", incoming.Import.Profiles.ToString()), ("secrets", incoming.Import.SecretCount.ToString()), ("missingKeys", incoming.Import.MissingPrivateKeys.Count.ToString())) : string.Empty;
        ApplyLanSyncButton.IsEnabled = lanSyncViewModel.Incoming != null; RejectLanSyncButton.IsEnabled = lanSyncViewModel.Incoming != null;
    }
    private async void StartLanSync(object sender, RoutedEventArgs args)
    {
        try
        {
            await lanSyncViewModel.StartReceiveAsync();
            UpdateLanSyncUi();
        }
        catch (Exception error) { ShowError(error); }
    }
    private void StopLanSync(object sender, RoutedEventArgs args)
    {
        lanSyncViewModel.StopReceive();
        UpdateLanSyncUi();
    }
    private async void ScanLanSync(object sender, RoutedEventArgs args) { try { await lanSyncViewModel.ScanAsync(); } catch (Exception error) { ShowError(error); } }
    private void LanSyncDeviceChanged(object sender, SelectionChangedEventArgs args)
    {
        if (LanSyncDevices.SelectedItem is not NativeLanSyncDevice device) return;
        lanSyncViewModel.SelectDevice(device); LanSyncHost.Text = device.Address; LanSyncPort.Value = device.TcpPort;
    }
    private void CancelLanSync(object sender, RoutedEventArgs args) => lanSyncService.CancelSend();
    private async void SendLanSync(object sender, RoutedEventArgs args)
    {
        if (!int.TryParse(LanSyncPort.Text, out var port) || port is < 1 or > 65535) { ShowError(localization["native.validationFailed"]); return; }
        try { await lanSyncViewModel.SendAsync(LanSyncHost.Text.Trim(), port, LanSyncPairingCode.Password.Trim(), LanSyncIncludeSecrets.IsOn); Status.Text = localization["native.lansync.sent"]; }
        catch (Exception error) { ShowError(error); }
    }
    private async void ApplyLanSync(object sender, RoutedEventArgs args)
    {
        if (lanSyncViewModel.Incoming is not { } incoming) return;
        var dialog = new ContentDialog { Title = localization["native.lansync.apply"], Content = LanSyncIncoming.Text, PrimaryButtonText = localization["native.common.overwrite"], SecondaryButtonText = localization["native.common.duplicate"], CloseButtonText = localization["native.common.skip"], XamlRoot = Root.XamlRoot };
        var choice = await dialog.ShowAsync(); var conflict = choice switch { ContentDialogResult.Primary => ImportConflict.Overwrite, ContentDialogResult.Secondary => ImportConflict.Duplicate, ContentDialogResult.None => ImportConflict.Skip, _ => (ImportConflict?)null };
        if (conflict == null) return;
        try { await lanSyncViewModel.ApplyAsync(incoming.Token, conflict.Value); LoadProfiles(); Status.Text = localization["native.common.imported"]; } catch (Exception error) { ShowError(error); }
    }
    private void RejectLanSync(object sender, RoutedEventArgs args) { if (lanSyncViewModel.Incoming is { } incoming) lanSyncViewModel.Reject(incoming.Token); }

    private void ProfileSelectionChanged(object sender, SelectionChangedEventArgs args) => connections.Selected = ProfilesList.SelectedItem as ConnectionProfile;

    private void ConnectionSortChanged(object sender, SelectionChangedEventArgs args)
    {
        if (loadingSettings || ConnectionSortChoice.SelectedItem is not ComboBoxItem { Tag: string sort }) return;
        settings = (settings with { ConnectionSort = sort }).Save(store);
        LoadProfiles();
    }

    private void ConnectionGroupingChanged(object sender, SelectionChangedEventArgs args)
    {
        if (loadingSettings || ConnectionGroupingChoice.SelectedItem is not ComboBoxItem { Tag: string grouping }) return;
        settings = (settings with { ConnectionGrouping = grouping }).Save(store);
        LoadProfiles();
    }

    private void ConnectionGroupSelectionChanged(object sender, SelectionChangedEventArgs args) => ConnectionGroups.Selected = ConnectionGroupsList.SelectedItem as ConnectionGroup;

    private async void NewConnectionGroup(object sender, RoutedEventArgs args)
    {
        var name = await PromptTextAsync(localization["native.groups.new"]);
        if (string.IsNullOrWhiteSpace(name)) return;
        try { ConnectionGroups.Save(null, name, ConnectionGroups.Groups.Count == 0 ? 0 : ConnectionGroups.Groups.Max(group => group.Order) + 1); LoadProfiles(); Status.Text = localization["native.common.saved"]; }
        catch (Exception error) { ShowError(error); }
    }

    private async void EditConnectionGroup(object sender, RoutedEventArgs args)
    {
        if (ConnectionGroups.Selected is not { } selected) return;
        var name = await PromptTextAsync(localization["native.common.edit"], selected.Name);
        if (string.IsNullOrWhiteSpace(name)) return;
        try { ConnectionGroups.Save(selected.Id, name, selected.Order, selected.Revision); LoadProfiles(); Status.Text = localization["native.common.saved"]; }
        catch (Exception error) { ShowError(error); }
    }

    private async void DeleteConnectionGroup(object sender, RoutedEventArgs args)
    {
        if (ConnectionGroups.Selected is not { } selected) return;
        var dialog = new ContentDialog { Title = localization["native.common.delete"], Content = selected.Name, PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        try { ConnectionGroups.DeleteSelected(); LoadProfiles(); Status.Text = localization["native.common.deleted"]; }
        catch (Exception error) { ShowError(error); }
    }

    private void MoveConnectionGroupUp(object sender, RoutedEventArgs args) => MoveConnectionGroup(-1);
    private void MoveConnectionGroupDown(object sender, RoutedEventArgs args) => MoveConnectionGroup(1);

    private void MoveConnectionGroup(int direction)
    {
        try { ConnectionGroups.MoveSelected(direction); LoadProfiles(); }
        catch (Exception error) { ShowError(error); }
    }

    private void CommandGroupChanged(object sender, SelectionChangedEventArgs args)
    {
        CommandViewModel.SelectedGroup = CommandGroups.SelectedItem as NativeSnippetGroup;
        CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet;
    }

    private void CommandSnippetChanged(object sender, SelectionChangedEventArgs args) => CommandViewModel.SelectedSnippet = CommandSnippets.SelectedItem as NativeSnippet;
    private void CommandSnippetClicked(object sender, ItemClickEventArgs args) => CommandViewModel.SelectedSnippet = args.ClickedItem as NativeSnippet;

    private async Task<string?> PromptTextAsync(string title, string initial = "", string? header = null)
    {
        var input = new TextBox { Header = header ?? title, Text = initial, AcceptsReturn = false };
        var dialog = new ContentDialog { Title = title, Content = input, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? input.Text : null;
    }

    private async void NewCommandGroup(object sender, RoutedEventArgs args)
    {
        var name = await PromptTextAsync(localization["native.commands.newGroup"]);
        if (string.IsNullOrWhiteSpace(name)) return;
        try { CommandViewModel.SaveGroup(null, name); CommandGroups.SelectedItem = CommandViewModel.SelectedGroup; }
        catch (Exception error) { ShowError(error); }
    }

    private async void EditCommandGroup(object sender, RoutedEventArgs args)
    {
        var selected = CommandViewModel.SelectedGroup; if (selected == null) return;
        var name = await PromptTextAsync(localization["native.common.edit"], selected.Name);
        if (string.IsNullOrWhiteSpace(name)) return;
        try { CommandViewModel.SaveGroup(selected.Id, name); CommandGroups.SelectedItem = CommandViewModel.SelectedGroup; }
        catch (Exception error) { ShowError(error); }
    }

    private async void DeleteCommandGroup(object sender, RoutedEventArgs args)
    {
        if (CommandViewModel.SelectedGroup == null) return;
        var dialog = new ContentDialog { Title = localization["native.common.delete"], Content = CommandViewModel.SelectedGroup.Name, PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) CommandViewModel.DeleteSelectedGroup();
    }

    private async Task EditSnippetAsync(NativeSnippet? existing, bool duplicate)
    {
        var name = new TextBox { Header = localization["native.name"], Text = existing == null ? "" : existing.Name + (duplicate ? " (copy)" : "") };
        var command = new TextBox { Header = localization["native.commands.command"], Text = existing?.Command ?? "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 160 };
        var autoEnter = new ToggleSwitch { Header = localization["native.commands.autoEnter"], IsOn = existing?.AutoEnter ?? false };
        var dialog = new ContentDialog { Title = existing == null || duplicate ? localization["native.commands.new"] : localization["native.common.edit"], Content = new StackPanel { Spacing = 8, Children = { name, command, autoEnter } }, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        try { CommandViewModel.SaveSnippet(existing == null || duplicate ? null : existing.Id, name.Text, command.Text, autoEnter.IsOn); }
        catch (Exception error) { ShowError(error); }
    }

    private async void NewCommandSnippet(object sender, RoutedEventArgs args) => await EditSnippetAsync(null, false);
    private async void EditCommandSnippet(object sender, RoutedEventArgs args) => await EditSnippetAsync(CommandViewModel.SelectedSnippet, false);
    private async void DuplicateCommandSnippet(object sender, RoutedEventArgs args) => await EditSnippetAsync(CommandViewModel.SelectedSnippet, true);
    private void DeleteCommandSnippet(object sender, RoutedEventArgs args) { try { CommandViewModel.DeleteSelectedSnippet(); } catch (Exception error) { ShowError(error); } }

    private void SendSelectedSnippet(object sender, RoutedEventArgs args)
    {
        var snippet = CommandViewModel.SelectedSnippet;
        if (snippet == null || Sessions.SelectedItem is not TabViewItem tab || tab.Tag is not string sessionId || !sessionTabs.ContainsKey(sessionId)) { ShowError(localization["native.commands.selectSession"]); return; }
        try
        {
            sessionsManager.Get(sessionId).Write(System.Text.Encoding.UTF8.GetBytes(snippet.Command + (snippet.AutoEnter ? "\r" : "")));
            commandLibrary.AddHistory(sessionId, snippet.Command);
            CommandViewModel.ReloadHistory(sessionId);
            Sessions.SelectedItem = sessionTabs[sessionId];
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void ClearCommandHistory(object sender, RoutedEventArgs args)
    {
        var dialog = new ContentDialog { Title = localization["native.commands.clearHistory"], Content = localization["native.commands.clearConfirm"], PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) CommandViewModel.ClearHistory();
    }

    private void AiProviderChanged(object sender, SelectionChangedEventArgs args) => aiViewModel.SelectedProvider = AiProviderChoice.SelectedItem as AiProviderProfile;

    private async void TestAiProvider(object sender, RoutedEventArgs args)
    {
        try { await aiViewModel.TestAsync(); }
        catch (Exception error) { ShowError(error); }
    }

    private async void DiscoverAiModels(object sender, RoutedEventArgs args)
    {
        try
        {
            if (aiViewModel.SelectedProvider == null) throw new InvalidOperationException("Select an AI provider first.");
            var token = aiViewModel.SelectedProvider.HasToken ? store.ReadSecret(store.Find("aiProviders", aiViewModel.SelectedProvider.Id)?["tokenRef"]?.GetValue<string>()) : null;
            await aiViewModel.DiscoverAsync(aiViewModel.SelectedProvider.BaseUrl, token);
            Status.Text = localization.Format("native.ai.discovered", ("count", aiViewModel.Models.Count.ToString()));
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void ConfigureAiProvider(object sender, RoutedEventArgs args)
    {
        var existing = aiViewModel.SelectedProvider;
        var name = new TextBox { Header = localization["native.ai.name"], Text = existing?.Name ?? "" };
        var url = new TextBox { Header = localization["native.ai.baseUrl"], Text = existing?.BaseUrl.ToString() ?? "https://api.openai.com/v1" };
        var model = new TextBox { Header = localization["native.ai.model"], Text = existing?.Model ?? "" };
        var token = new PasswordBox { Header = localization["native.ai.token"] };
        var enabled = new ToggleSwitch { Header = localization["native.ai.enabled"], IsOn = existing?.Enabled ?? true };
        var modelList = new ListView { ItemsSource = aiViewModel.Models, DisplayMemberPath = nameof(AiModelInfo.Id), IsItemClickEnabled = true, Height = 120 };
        modelList.ItemClick += (_, eventArgs) => { if (eventArgs.ClickedItem is AiModelInfo discovered) model.Text = discovered.Id; };
        var dialog = new ContentDialog { Title = localization["native.ai.configure"], Content = new ScrollViewer { MaxHeight = 650, Content = new StackPanel { Spacing = 8, Children = { name, url, model, modelList, token, enabled } } }, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary || !Uri.TryCreate(url.Text.Trim(), UriKind.Absolute, out var baseUrl)) return;
        try { aiViewModel.Save(new AiProviderDraft(existing?.Id, name.Text, baseUrl, model.Text, enabled.IsOn, string.IsNullOrEmpty(token.Password) ? null : token.Password)); AiProviderChoice.ItemsSource = aiViewModel.Providers; AiProviderChoice.SelectedItem = aiViewModel.SelectedProvider; }
        catch (Exception error) { ShowError(error); }
    }

    private async void SendAiMessage(object sender, RoutedEventArgs args)
    {
        var message = AiInput.Text; AiInput.Text = "";
        try
        {
            if (selectedAiImagePath != null)
            {
                await aiViewModel.SendWithImageAsync(message, selectedAiImagePath);
                selectedAiImagePath = null;
                AiImageButton.Content = localization["native.ai.image"];
            }
            else await aiViewModel.SendAsync(message);
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void SelectAiImage(object sender, RoutedEventArgs args)
    {
        var picker = new FileOpenPicker();
        foreach (var extension in new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif" }) picker.FileTypeFilter.Add(extension);
        InitializeWithWindow.Initialize(picker, WindowHandle());
        var file = await picker.PickSingleFileAsync();
        if (file == null) return;
        selectedAiImagePath = file.Path;
        AiImageButton.Content = $"{localization["native.ai.image"]}: {file.Name}";
    }

    private async void TestAiCapability(object sender, RoutedEventArgs args)
    {
        try
        {
            var provider = aiViewModel.SelectedProvider ?? throw new InvalidOperationException("Select an AI provider first.");
            var token = provider.HasToken ? store.ReadSecret(store.Find("aiProviders", provider.Id)?["tokenRef"]?.GetValue<string>()) : null;
            var result = await aiViewModel.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, token);
            Status.Text = $"{provider.Model} · {result.Image} · {result.Outcome}";
        }
        catch (Exception error) { ShowError(error); }
    }

    private void CancelAiMessage(object sender, RoutedEventArgs args) => aiViewModel.Cancel();
    private void ClearAiConversation(object sender, RoutedEventArgs args) => aiViewModel.ClearConversation();

    private async void PauseTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("pause");
    private async void ResumeTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("resume");
    private async void RetryTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("retry");
    private async void CancelTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("cancel");
    private void ClearFinishedTransfers(object sender, RoutedEventArgs args) => transferViewModel.ClearFinished();
    private async Task ControlSelectedTransferAsync(string operation)
    {
        if (TransferList.SelectedItem is not NativeTransferTask task) return;
        try { await transferViewModel.ControlAsync(task.Id, operation); }
        catch (Exception error) { ShowError(error); }
    }

    private async Task<bool> ConfirmHostAsync(HostKeyChallenge challenge)
    {
        var decision = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!DispatcherQueue.TryEnqueue(async () =>
        {
            var dialog = new ContentDialog { Title = localization["native.hostKeyTitle"],
                Content = $"{challenge.Host}:{challenge.Port}\n{challenge.Algorithm}\n{challenge.Fingerprint}",
                PrimaryButtonText = localization["native.common.continue"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
            try { decision.TrySetResult(await dialog.ShowAsync() == ContentDialogResult.Primary); }
            catch (Exception error) { decision.TrySetException(error); }
        })) throw new InvalidOperationException("Unable to show the SSH host-key confirmation.");
        return await decision.Task;
    }

    private async Task<string?> PromptAsync(string prompt, bool echo)
    {
        const string passwordContextPrefix = "native.password (";
        var promptLabel = prompt.StartsWith(passwordContextPrefix, StringComparison.Ordinal)
            ? $"{localization["native.password"]} · {prompt[passwordContextPrefix.Length..].TrimEnd(')')}"
            : prompt;
        var response = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!DispatcherQueue.TryEnqueue(async () =>
        {
            Control input = echo ? new TextBox { Header = promptLabel } : new PasswordBox { Header = promptLabel };
            var dialog = new ContentDialog { Title = promptLabel, Content = input, PrimaryButtonText = localization["native.common.continue"],
                CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
            try
            {
                response.TrySetResult(await dialog.ShowAsync() == ContentDialogResult.Primary
                    ? input switch { TextBox text => text.Text, PasswordBox secret => secret.Password, _ => null }
                    : null);
            }
            catch (Exception error) { response.TrySetException(error); }
        })) throw new InvalidOperationException("Unable to show the SSH authentication prompt.");
        return await response.Task;
    }

    private async void ImportData(object sender, RoutedEventArgs args)
    {
        var picker = new FileOpenPicker(); picker.FileTypeFilter.Add(".json");
        InitializeWithWindow.Initialize(picker, WindowHandle());
        var file = await picker.PickSingleFileAsync(); if (file == null) return;
        var passphrase = await PromptAsync(localization["native.common.passphrase"], false); if (passphrase == null) return;
        try {
            var preview = ExportEnvelope.Inspect(System.Text.Encoding.UTF8.GetBytes(await Windows.Storage.FileIO.ReadTextAsync(file)), passphrase);
            var choice = await ConfirmImportAsync(preview); if (choice == null) return;
            store.Import(preview, choice.Value); LoadProfiles();
            MigrationImportButton.Visibility = Visibility.Collapsed;
            Status.Text = localization["native.common.imported"];
        } catch (Exception error) { ShowError(error); }
    }

    private async Task<ImportConflict?> ConfirmImportAsync(ImportPreview preview)
    {
        static int Count(JsonObject data, string key) => (data[key] as System.Text.Json.Nodes.JsonArray)?.Count ?? 0;
        var summary = localization.Format("native.importSummary", ("profiles", preview.Profiles.ToString()), ("secrets", preview.SecretCount.ToString())) + "\n" +
            localization.Format("native.migrationCategories", ("groups", Count(preview.Data, "groups").ToString()), ("keys", Count(preview.Data, "privateKeys").ToString()),
                ("proxies", Count(preview.Data, "proxies").ToString()), ("knownHosts", Count(preview.Data, "knownHosts").ToString()), ("forwards", Count(preview.Data, "forwards").ToString()));
        var dialog = new ContentDialog { Title = localization["native.common.import"], Content = summary,
            PrimaryButtonText = localization["native.common.overwrite"], SecondaryButtonText = localization["native.common.duplicate"], CloseButtonText = localization["native.common.skip"], XamlRoot = Root.XamlRoot };
        var result = await dialog.ShowAsync(); return result switch { ContentDialogResult.Primary => ImportConflict.Overwrite,
            ContentDialogResult.Secondary => ImportConflict.Duplicate, ContentDialogResult.None => ImportConflict.Skip, _ => null };
    }

    private async void ExportData(object sender, RoutedEventArgs args)
    {
        var passphrase = await PromptAsync(localization["native.common.passphrase"], false); if (passphrase == null) return;
        var picker = new FileSavePicker { SuggestedFileName = "openfinalshell-native-preview.json" }; picker.FileTypeChoices.Add("JSON", [".json"]);
        InitializeWithWindow.Initialize(picker, WindowHandle());
        var file = await picker.PickSaveFileAsync(); if (file == null) return;
        try { await Windows.Storage.FileIO.WriteBytesAsync(file, ExportEnvelope.Export(store, passphrase)); Status.Text = localization["native.common.exported"]; }
        catch (Exception error) { ShowError(error); }
    }

    private async void SessionCloseRequested(TabView sender, TabViewTabCloseRequestedEventArgs args)
    {
        var rawTag = args.Tab.Tag?.ToString() ?? string.Empty;
        sessionContents.TryGetValue(rawTag, out var content);
        if (content is Controls.NativeRemoteEditor editor && !await editor.ConfirmCloseAsync()) return;
        if (content is Controls.NativeRemoteEditor remoteEditor) remoteEditor.Dispose();
        if (content is Controls.NativeMonitorPanel monitor) monitor.Dispose();
        if (content is Controls.NativePortTrafficPanel traffic) traffic.Dispose();
        RemoveSessionTab(args.Tab);
        if (sessionTerminals.Remove(rawTag, out var terminal))
        {
            if (sessionOutputSinks.TryGetValue(rawTag, out var sink)) sink.Detach(terminal);
            terminal.Dispose();
        }
        if (rawTag.StartsWith("editor:", StringComparison.Ordinal))
        {
            sessionTabs.Remove(rawTag);
            return;
        }
        var sessionId = rawTag.Contains(':') ? rawTag[(rawTag.IndexOf(':') + 1)..] : rawTag;
        if (!string.IsNullOrWhiteSpace(sessionId) && !sender.TabItems.OfType<TabViewItem>().Any(item =>
        {
            var tag = item.Tag?.ToString();
            return tag == sessionId
                || tag == "sftp:" + sessionId
                || tag == "monitor:" + sessionId
                || tag == "portTraffic:" + sessionId
                || tag?.StartsWith("editor:" + sessionId + ":", StringComparison.Ordinal) == true;
        }))
        {
            sessionTabs.Remove(sessionId);
            sessionTerminals.Remove(sessionId);
            sessionOutputSinks.Remove(sessionId);
            if (rdpSessions.Remove(sessionId, out var rdp)) await rdp.DisposeAsync();
            if (rdpSurfaces.Remove(sessionId, out var surface)) surface.Dispose();
            else sessionsManager.Close(sessionId);
        }
    }
    private void ThemeChanged(object sender, SelectionChangedEventArgs args) { if (!loadingSettings && ThemeChoice.SelectedItem is string value) { settings = (settings with { ThemeMode = value }).Save(store); Status.Text = localization.Format("native.themeStatus", ("value", value)); } }
    private void LanguageChanged(object sender, SelectionChangedEventArgs args) { if (!loadingSettings && LanguageChoice.SelectedItem is string tag) { settings = (settings with { Language = tag }).Save(store); localization.SetLanguage(tag); ConfigureLabels(); } }
    private void TransparencyChanged(object sender, RoutedEventArgs args) { if (!loadingSettings) { settings = (settings with { ReduceTransparency = TransparencyChoice.IsOn }).Save(store); Status.Text = localization["native.settings.transparency"]; } }
    private void ResetHostTrust(object sender, RoutedEventArgs args)
    {
        foreach (var host in store.List("knownHosts"))
            if (host["key"]?.GetValue<string>() is { } key && host["_revision"]?.GetValue<long>() is { } revision)
                try { store.Delete("knownHosts", key, revision); } catch { /* another instance won the race */ }
        Status.Text = localization["native.settings.resetTrust"];
    }

    private async void ManageKeys(object sender, RoutedEventArgs args)
    {
        savedKeys.Reload();
        var list = new ListView { ItemsSource = savedKeys.Items, DisplayMemberPath = nameof(SavedKeyItem.Name), SelectionMode = ListViewSelectionMode.Single, MinWidth = 420, MinHeight = 220 };
        var dialog = new ContentDialog { Title = localization["native.keys.manage"], Content = list, PrimaryButtonText = localization["native.common.delete"], SecondaryButtonText = localization["native.keys.add"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        var result = await dialog.ShowAsync();
        try
        {
            if (result == ContentDialogResult.Primary && list.SelectedItem is SavedKeyItem selected) { savedKeys.Selected = selected; savedKeys.DeleteSelected(); }
            else if (result == ContentDialogResult.Secondary)
            {
                var picker = new FileOpenPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, WindowHandle());
                var file = await picker.PickSingleFileAsync(); if (file == null) return;
                var name = new TextBox { Header = localization["native.name"], Text = Path.GetFileNameWithoutExtension(file.Name) };
                var passphrase = new PasswordBox { Header = localization["native.common.passphrase"] };
                var editor = new ContentDialog { Title = localization["native.keys.add"], Content = new StackPanel { Spacing = 8, Children = { name, passphrase } }, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
                if (await editor.ShowAsync() == ContentDialogResult.Primary)
                {
                    var reference = string.IsNullOrEmpty(passphrase.Password) ? null : store.SaveSecret(passphrase.Password);
                    savedKeys.Save(Guid.NewGuid().ToString("N"), name.Text, file.Path, reference);
                }
            }
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void ManageProxies(object sender, RoutedEventArgs args)
    {
        savedProxies.Reload();
        var list = new ListView { ItemsSource = savedProxies.Items, DisplayMemberPath = nameof(SavedProxyItem.Name), SelectionMode = ListViewSelectionMode.Single, MinWidth = 460, MinHeight = 220 };
        var dialog = new ContentDialog { Title = localization["native.proxies.manage"], Content = list, PrimaryButtonText = localization["native.common.delete"], SecondaryButtonText = localization["native.proxies.add"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        var result = await dialog.ShowAsync();
        try
        {
            if (result == ContentDialogResult.Primary && list.SelectedItem is SavedProxyItem selected) { savedProxies.Selected = selected; savedProxies.DeleteSelected(); }
            else if (result == ContentDialogResult.Secondary) await ShowProxyEditorAsync(null);
        }
        catch (Exception error) { ShowError(error); }
    }

    private async Task ShowProxyEditorAsync(SavedProxyItem? existing)
    {
        var name = new TextBox { Header = localization["native.name"], Text = existing?.Name ?? "" };
        var type = new ComboBox { Header = localization["native.proxies.type"], ItemsSource = new[] { "http", "socks5" }, SelectedItem = existing?.Type ?? "socks5" };
        var host = new TextBox { Header = localization["native.host"], Text = existing?.Host ?? "" };
        var port = new NumberBox { Header = localization["native.port"], Value = existing?.Port ?? 1080, Minimum = 1, Maximum = 65535 };
        var username = new TextBox { Header = localization["native.username"] };
        var password = new PasswordBox { Header = localization["native.password"] };
        var dialog = new ContentDialog { Title = localization["native.proxies.add"], Content = new StackPanel { Spacing = 8, Children = { name, type, host, port, username, password } }, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var passwordRef = string.IsNullOrEmpty(password.Password) ? null : store.SaveSecret(password.Password);
        savedProxies.Save(existing?.Id ?? Guid.NewGuid().ToString("N"), name.Text, type.SelectedItem?.ToString() ?? "socks5", host.Text, (int)port.Value, username.Text, passwordRef, existing?.Revision);
    }

    private async void ManageKnownHosts(object sender, RoutedEventArgs args)
    {
        knownHosts.Reload();
        var list = new ListView { ItemsSource = knownHosts.Items, SelectionMode = ListViewSelectionMode.Single, MinWidth = 500, MinHeight = 240 };
        list.ItemTemplate = (Microsoft.UI.Xaml.DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><StackPanel><TextBlock Text=\"{Binding Host}\"/><TextBlock Text=\"{Binding Fingerprint}\" FontSize=12/></StackPanel></DataTemplate>");
        var dialog = new ContentDialog { Title = localization["native.knownHosts.manage"], Content = list, PrimaryButtonText = localization["native.knownHosts.revoke"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary && list.SelectedItem is KnownHostItem selected)
        {
            try { knownHosts.Selected = selected; knownHosts.RevokeSelected(); }
            catch (Exception error) { ShowError(error); }
        }
    }

    private async void OnRootLoaded(object sender, RoutedEventArgs args)
    {
        if (initialUpdateCheckStarted) return;
        initialUpdateCheckStarted = true;
        try
        {
            var interrupted = updateService.RecoverInterruptedInstall();
            if (string.Equals(interrupted, updateService.CurrentVersion, StringComparison.OrdinalIgnoreCase))
                updateService.MarkInstallCompleted();
            else if (!string.IsNullOrWhiteSpace(interrupted))
                UpdateStatusText.Text = localization["native.update.recovered"];

            await Task.Delay(TimeSpan.FromSeconds(10), updateCancellation.Token);
            await CheckForUpdatesAsync(automatic: true);
            updateTimer = DispatcherQueue.CreateTimer();
            updateTimer.Interval = TimeSpan.FromHours(6);
            updateTimer.Tick += async (_, _) => await CheckForUpdatesAsync(automatic: true);
            updateTimer.Start();
        }
        catch (OperationCanceledException) when (updateCancellation.IsCancellationRequested) { }
    }

    private async void CheckForUpdates(object sender, RoutedEventArgs args) => await CheckForUpdatesAsync(automatic: false);
    private async void DownloadUpdate(object sender, RoutedEventArgs args) => await DownloadUpdateAsync();

    private async Task CheckForUpdatesAsync(bool automatic)
    {
        if (updateCheckRunning || updateCancellation.IsCancellationRequested) return;
        updateCheckRunning = true;
        try { await updateService.CheckAndDownloadAsync(updateCancellation.Token); }
        catch (OperationCanceledException) when (updateCancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (!automatic) ShowError(localization.Format("native.update.failed", ("detail", error.Message)));
        }
        finally
        {
            updateCheckRunning = false;
            ApplyUpdateState(updateService.State);
        }
    }

    private async Task DownloadUpdateAsync()
    {
        if (updateCheckRunning || updateCancellation.IsCancellationRequested) return;
        updateCheckRunning = true;
        try { await updateService.DownloadAsync(updateCancellation.Token); }
        catch (OperationCanceledException) when (updateCancellation.IsCancellationRequested) { }
        catch (Exception error) { ShowError(localization.Format("native.update.failed", ("detail", error.Message))); }
        finally
        {
            updateCheckRunning = false;
            ApplyUpdateState(updateService.State);
        }
    }

    private void OnUpdateStateChanged(NativeUpdateSnapshot state)
    {
        if (DispatcherQueue.HasThreadAccess) ApplyUpdateState(state);
        else DispatcherQueue.TryEnqueue(() => ApplyUpdateState(state));
    }

    private void ApplyUpdateState(NativeUpdateSnapshot state)
    {
        UpdateCurrentLabel.Text = localization.Format("native.update.current", ("version", updateService.CurrentVersion));
        UpdateProgress.Visibility = state.Status is NativeUpdateStatus.Checking or NativeUpdateStatus.Downloading or NativeUpdateStatus.Ready
            ? Visibility.Visible
            : Visibility.Collapsed;
        UpdateProgress.Value = state.ProgressPercent;
        UpdateProgress.IsIndeterminate = state.Status == NativeUpdateStatus.Checking || (state.Status == NativeUpdateStatus.Downloading && state.ProgressPercent == 0);
        UpdateStatusText.Text = state.Status switch
        {
            NativeUpdateStatus.Idle => localization["native.update.idle"],
            NativeUpdateStatus.Checking => localization["native.update.checking"],
            NativeUpdateStatus.UpToDate => localization["native.update.upToDate"],
            NativeUpdateStatus.Available => localization.Format("native.update.available", ("version", state.AvailableVersion ?? "")),
            NativeUpdateStatus.Downloading => localization.Format("native.update.downloading", ("version", state.AvailableVersion ?? ""), ("percent", state.ProgressPercent.ToString())),
            NativeUpdateStatus.Ready => localization.Format("native.update.ready", ("version", state.AvailableVersion ?? "")),
            NativeUpdateStatus.Failed => localization.Format("native.update.failed", ("detail", state.Error ?? "")),
            _ => localization["native.update.idle"]
        };
        CheckUpdatesButton.IsEnabled = !updateCheckRunning && state.Status is not (NativeUpdateStatus.Checking or NativeUpdateStatus.Downloading);
        DownloadUpdateButton.IsEnabled = !updateCheckRunning && updateService.Available != null && updateService.DownloadedArtifact == null;
        InstallUpdateButton.IsEnabled = !updateCheckRunning && updateService.DownloadedArtifact is { } artifact && File.Exists(artifact.Path);
        var notes = updateService.Available?.NotesUri;
        UpdateReleaseNotesButton.Visibility = notes == null ? Visibility.Collapsed : Visibility.Visible;
        UpdateReleaseNotesButton.NavigateUri = notes;
    }

    private async void InstallUpdate(object sender, RoutedEventArgs args)
    {
        if (updateCheckRunning || updateService.DownloadedArtifact is not { } artifact) return;
        var decision = updateCoordinator.PrepareInstall();
        var activity = CurrentUpdateActivity(decision.Activity);
        if (activity.HasActivity)
        {
            ShowUpdateActivity(activity);
            return;
        }
        var dialog = new ContentDialog
        {
            Title = localization["native.update.title"],
            Content = localization.Format("native.update.installConfirm", ("version", artifact.Version)),
            PrimaryButtonText = localization["native.update.install"],
            CloseButtonText = localization["native.common.cancel"],
            XamlRoot = Root.XamlRoot
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        activity = CurrentUpdateActivity(updateCoordinator.Activity());
        if (activity.HasActivity)
        {
            ShowUpdateActivity(activity);
            return;
        }
        try
        {
            updateCheckRunning = true;
            updateService.Install(userConfirmed: true);
            Close();
        }
        catch (Exception error)
        {
            updateCheckRunning = false;
            ShowError(localization.Format("native.update.failed", ("detail", error.Message)));
        }
    }

    private NativeUpdateActivity CurrentUpdateActivity(NativeUpdateActivity activity) => activity with
    {
        Editors = sessionContents.Values.OfType<Controls.NativeRemoteEditor>().Count(editor => editor.HasUnsavedChanges),
        RdpSessions = rdpSurfaces.Count
    };

    private void ShowUpdateActivity(NativeUpdateActivity activity) => ShowError(localization.Format("native.update.activity",
        ("sessions", activity.Sessions.ToString()), ("transfers", activity.Transfers.ToString()),
        ("forwards", activity.Forwards.ToString()), ("editors", activity.Editors.ToString()), ("rdp", activity.RdpSessions.ToString())));

    private void ShowError(string message)
    {
        var translated = localization[message];
        Notice.Message = translated == message ? message : translated;
        Notice.IsOpen = true;
    }

    private void ShowError(Exception error)
    {
        if (error is NativeReferenceInUseException references)
        {
            ShowError(localization.Format("native.errors.referenceInUse", ("names", string.Join(", ", references.References.Select(x => x.Name)))));
            return;
        }
        if (error is InvalidOperationException && error.Message.Contains("revision conflict", StringComparison.OrdinalIgnoreCase))
        {
            ShowError(localization["native.errors.revisionConflict"]);
            return;
        }
        ShowError(error.Message);
    }
    private nint WindowHandle() => WindowNative.GetWindowHandle(this);
    private void MainWindowClosed(object sender, WindowEventArgs args)
    {
        updateTimer?.Stop();
        updateCancellation.Cancel();
        updateService.StateChanged -= OnUpdateStateChanged;
        updateService.Dispose();
        updateCancellation.Dispose();
        foreach (var content in sessionContents.Values)
        {
            if (content is Controls.NativeRemoteEditor editor) editor.Dispose();
            if (content is Controls.NativeMonitorPanel monitor) monitor.Dispose();
            if (content is Controls.NativePortTrafficPanel traffic) traffic.Dispose();
        }
        sessionContents.Clear();
        sessionOutputSinks.Clear(); sessionTerminals.Clear();
        foreach (var terminal in sessionTerminals.Values) terminal.Dispose();
        aiViewModel.Dispose(); lanSyncViewModel.Dispose(); lanSyncService.Dispose(); forwardViewModel.Dispose(); forwardManager.Dispose(); transferViewModel.Dispose(); transferQueue.Dispose(); sessionsManager.Dispose(); store.Dispose();
        foreach (var rdp in rdpSessions.Values) _ = rdp.DisposeAsync();
        rdpSessions.Clear();
        foreach (var surface in rdpSurfaces.Values) surface.Dispose();
        rdpSurfaces.Clear();
    }
    public void ApplyExternalConfiguration(NativeInstanceChange change)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            if (change.Entity is "profiles" or "settings") { settings = NativeSettings.Load(store); LoadProfiles(); }
            if (change.Entity == "forwards") forwardViewModel.Reload();
            if (change.Entity == "ai") aiViewModel.ReloadProviders();
            if (change.Entity == "snippets") CommandViewModel.Reload();
        });
    }
}
