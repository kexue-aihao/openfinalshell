using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Input;
using OpenFinalShell.Core;
using OpenFinalShell.App.ViewModels;
using OpenFinalShell.App.Controls;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace OpenFinalShell.App;

public sealed partial class MainWindow : Window
{
    private static readonly IReadOnlyDictionary<string, string> ActivityIconGlyphs = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["connections"] = "\uE774",
        ["commands"] = "\uE943",
        ["forwards"] = "\uE8AB",
        ["transfers"] = "\uE896",
        ["ai"] = "\uE99A",
        ["theme"] = "\uE793",
        ["settings"] = "\uE713"
    };

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
    private Controls.NativeConnectionTree? connectionTree;
    private string? newProfileGroup;
    private readonly Dictionary<string, Controls.NativeSessionWorkspace> sessionWorkspaces = new(StringComparer.Ordinal);
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
    private readonly NativeEditorWindowHost editorWindowHost;
    private Windows.UI.ViewManagement.AccessibilitySettings? accessibilitySettings;
    private bool accessibilitySubscribed;
    private readonly Dictionary<string, TabViewItem> sessionTabs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ConnectionProfile> sessionProfiles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FrameworkElement> sessionContents = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Controls.NativeTerminalCanvas> sessionTerminals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SessionTerminalSink> sessionOutputSinks = new(StringComparer.Ordinal);
    private string? selectedAiImagePath;
    private bool updatingAiTargets;
    private readonly List<Controls.NativeAiMessageView> aiMessageViews = [];
    private readonly Dictionary<string, RdpSessionViewModel> rdpSessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Controls.NativeRdpSurface> rdpSurfaces = new(StringComparer.Ordinal);
    private NativeSettings settings;
    private bool loadingSettings;
    private string activeActivity = "connections";
    private string? activeOverlay;
    private bool responsiveSidebarCollapsed;
    private bool responsiveSidebarOpen;
    private bool forwardDialogActive;
    private readonly NativeUpdateCoordinator updateCoordinator;
    private readonly NativeUpdateService updateService;
    private readonly CancellationTokenSource updateCancellation = new();
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? updateTimer;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? transferSummaryTimer;
    private bool updateCheckRunning;
    private bool initialUpdateCheckStarted;

    public MainWindow(PlatformEnvironment environment, NativeInstanceCoordinator? coordinator = null)
    {
        this.environment = environment; this.coordinator = coordinator;
        store = new NativeStore(NativeStore.DefaultDirectory, new DpapiProtector());
        if (store.Find("nativeWorkspace", "nativeWorkspace")?["parityDataVersion"]?.GetValue<int>() != 1)
        {
            store.Backup("parity-v1");
            store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["parityDataVersion"] = 1 });
        }
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
        editorWindowHost = new NativeEditorWindowHost(remoteEditorService, key => localization[key], () => settings, HandleNativeEditorShortcut);
        editorWindowHost.Failed += ShowError;
        sessionsManager = new NativeSessionManager(store);
        forwardManager = new NativeForwardManager(store, sessionsManager);
        forwardViewModel = new ForwardViewModel(forwardManager, key => localization[key]);
        lanSyncService = new NativeLanSyncService(store);
        lanSyncViewModel = new NativeLanSyncViewModel(lanSyncService);
        transferQueue = new NativeTransferQueue(sessionsManager,
            () => settings.Get("sftp.packedTransfer", false), key => localization[key], localization);
        transferViewModel = new TransferQueueViewModel(transferQueue, localization);
        var currentVersion = typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        updateCoordinator = new NativeUpdateCoordinator(sessionsManager, transferQueue, forwardManager, NativeUpdateService.DefaultPublicKey, NativeStore.DefaultDirectory);
        updateService = new NativeUpdateService(updateCoordinator, currentVersion, NativeUpdateService.DefaultPublicKey);
        updateService.StateChanged += OnUpdateStateChanged;
        sessionsManager.StateChanged += OnSessionStateChanged;
        InitializeComponent();
        InitializeElectronLayout();
        try
        {
            var accessibility = new Windows.UI.ViewManagement.AccessibilitySettings();
            accessibilitySettings = accessibility;
            accessibilitySubscribed = NativeAccessibilityGuard.TryRegister(
                () => accessibility.HighContrastChanged += AccessibilitySettings_HighContrastChanged);
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            accessibilitySettings = null;
        }
        AppWindow.Changed += OnAppWindowChanged;
        InitializeWorkbenchShortcuts();
        var appIconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "OpenFinalShell.ico");
        if (File.Exists(appIconPath)) AppWindow.SetIcon(appIconPath);
        Closed += MainWindowClosed;
        AppWindow.Closing += MainWindowClosing;
        ApplyPlatformResources();
        Title = $"OpenFinalShell Native Preview · {environment.Profile}" + (Environment.GetEnvironmentVariable("OFS_NATIVE_TEST_MODE") == "1" ? " · isolated test" : "");
        ProfilesList.ItemsSource = connections.Profiles;
        connectionTree = new Controls.NativeConnectionTree(store, key => localization[key]);
        connectionTree.ActionRequested += ConnectionTreeAction;
        connectionTree.Failed += ShowError;
        connectionTree.Changed += LoadProfiles;
        ConnectionTreeHost.Content = connectionTree;
        activeActivity = store.Find("nativeWorkspace", "nativeWorkspace")?["activeSidebar"]?.GetValue<string>() is { } savedActivity &&
            savedActivity is "connections" or "commands" or "forwards" or "transfers" ? savedActivity : "connections";
        TransferList.ItemsSource = transferViewModel.Tasks;
        transferViewModel.PropertyChanged += (_, _) => DispatcherQueue.TryEnqueue(UpdateTransferControls);
        transferSummaryTimer = DispatcherQueue.CreateTimer();
        transferSummaryTimer.Interval = TimeSpan.FromSeconds(1);
        transferSummaryTimer.Tick += (_, _) => transferViewModel.RefreshSummary();
        transferSummaryTimer.Start();
        ForwardList.ItemsSource = forwardViewModel.Rules;
        LanSyncHost.Text = "127.0.0.1"; LanSyncPort.Value = 52133; LanSyncIncludeSecrets.IsOn = true;
        AiProviderChoice.ItemsSource = aiViewModel.Providers;
        SettingsAiProviderChoice.ItemsSource = aiViewModel.Providers;
        SettingsAiProviderChoice.SelectionChanged += (_, _) => { if (!ReferenceEquals(AiProviderChoice.SelectedItem, SettingsAiProviderChoice.SelectedItem)) AiProviderChoice.SelectedItem = SettingsAiProviderChoice.SelectedItem; };
        AiProviderChoice.SelectionChanged += (_, _) => { if (!ReferenceEquals(SettingsAiProviderChoice.SelectedItem, AiProviderChoice.SelectedItem)) SettingsAiProviderChoice.SelectedItem = AiProviderChoice.SelectedItem; };
        AiTargetChoice.ItemsSource = aiViewModel.TerminalTargets;
        aiViewModel.Messages.CollectionChanged += (_, _) => RefreshAiMessageViews();
        CommandGroups.SelectedItem = CommandViewModel.SelectedGroup;
        CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet;
        aiViewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(NativeAiViewModel.SelectedProvider)) { AiProviderChoice.SelectedItem = aiViewModel.SelectedProvider; UpdateAiProviderActions(); }
            if (args.PropertyName == nameof(NativeAiViewModel.Status)) Status.Text = aiViewModel.Status;
            if (args.PropertyName == nameof(NativeAiViewModel.IsRunning)) { RefreshAiMessageViews(); UpdateAiAssistantControls(); }
        };
        LoadProfiles();
        ConfigureLabels();
        ConfigureSettings();
        ApplyUpdateState(updateService.State);
        Root.Loaded += OnRootLoaded;
        ActivatePage(activeActivity);
        UpdateWorkbenchLayout();
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
        WelcomeDescription.Text = localization["welcome.subtitle"];
        ConfigureElectronLayoutLabels();
        WelcomeNewTitle.Text = localization["welcome.newConnection"];
        WelcomeImportButton.Content = localization["native.migrationImportButton"];
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(WelcomeImportButton, localization["native.migrationImportButton"]);
        QuickConnectInput.PlaceholderText = "ssh user@host[:port]";
        QuickConnectButton.Content = localization["native.workbench.quickConnect"];
        RecentHeading.Text = localization["welcome.recent"];
        ToolTipService.SetToolTip(ConnectionsItem, localization["activity.connections"]);
        ToolTipService.SetToolTip(TransfersItem, localization["activity.transfers"]);
        ToolTipService.SetToolTip(CommandsItem, localization["native.workbench.commands"]);
        ToolTipService.SetToolTip(ForwardItem, localization["activity.forwards"]);
        ToolTipService.SetToolTip(AiItem, localization["aiAssistant.title"]);
        ToolTipService.SetToolTip(ThemeItem, localization["activity.toggleTheme"]);
        ToolTipService.SetToolTip(SettingsItem, localization["activity.settings"]);
        ToolTipService.SetToolTip(CloseAiButton, localization["common.close"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(ConnectionsItem, localization["activity.connections"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(TransfersItem, localization["activity.transfers"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(CommandsItem, localization["native.workbench.commands"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(ForwardItem, localization["activity.forwards"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(AiItem, localization["aiAssistant.title"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(ThemeItem, localization["activity.toggleTheme"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(SettingsItem, localization["activity.settings"]);
        ContextHeading.Text = activeActivity switch
        {
            "commands" => localization["native.workbench.commands"],
            "forwards" => localization["activity.forwards"],
            "transfers" => localization["activity.transfers"],
            _ => localization["activity.connections"]
        };
        SettingsPreferencesButton.Content = localization["settings.section_general"];
        SettingsLanSyncButton.Content = localization["native.lansync.title"];
        SettingsAboutButton.Content = localization["settings.section_about"];
        UpdateActivityMarkers();
        NewButton.Label = localization["welcome.newConnection"];
        ImportButton.Label = localization["native.common.import"];
        MigrationImportButton.Label = localization["native.migrationImportButton"];
        // Keep the first-run shortcut available until any portable entity has
        // been imported or created, including keys/proxies/trust and snippets.
        var hasNativeData = new[] { "profiles", "groups", "forwards", "proxies", "privateKeys", "knownHosts", "snippetGroups", "snippets", "aiProfiles" }
            .Any(kind => store.List(kind).Count > 0);
        MigrationImportButton.Visibility = hasNativeData ? Visibility.Collapsed : Visibility.Visible;
        WelcomeImportButton.Visibility = hasNativeData ? Visibility.Collapsed : Visibility.Visible;
        ExportButton.Label = localization["native.common.export"];
        SettingsHeading.Text = localization["activity.settings"];
        AiHeading.Text = localization["aiAssistant.title"];
        ApplyActivityIcons();
        CloseSettingsButton.Content = "×";
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(CloseSettingsButton, localization["common.close"]);
        ConfigureShortcutList();
        ResetTrustButton.Content = localization["native.settings.resetTrust"];
        UpdateHeading.Text = localization["native.update.title"];
        UpdateCurrentLabel.Text = localization.Format("native.update.current", ("version", updateService.CurrentVersion));
        CheckUpdatesButton.Content = localization["native.update.check"];
        DownloadUpdateButton.Content = localization["native.update.download"];
        InstallUpdateButton.Content = localization["native.update.install"];
        UpdateReleaseNotesButton.Content = localization["native.update.releaseNotes"];
        ApplyUpdateState(updateService.State);
        ConfigureAbout();
        ManageKeysButton.Content = localization["native.keys.manage"];
        ManageProxiesButton.Content = localization["native.proxies.manage"];
        ManageKnownHostsButton.Content = localization["native.knownHosts.manage"];
        FinalShellImportButton.Content = localization["settings.fsImportButton"];
        ConnectionGroupsHeading.Text = localization["native.groups.title"];
        NewConnectionGroupButton.Content = localization["native.groups.new"];
        EditConnectionGroupButton.Content = localization["native.common.edit"];
        DeleteConnectionGroupButton.Content = localization["native.common.delete"];
        MoveConnectionGroupUpButton.Content = localization["native.groups.moveUp"];
        MoveConnectionGroupDownButton.Content = localization["native.groups.moveDown"];
        EnvironmentLabel.Text = $"{environment.Profile} · build {environment.Build} · " +
            (environment.Supported ? localization["platform.available"] : localization["platform.unavailable"]);
        EditButton.Label = localization["native.common.edit"];
        DuplicateButton.Label = localization["native.common.duplicateConnection"];
        DeleteButton.Label = localization["native.common.delete"];
        ReconnectButton.Label = localization["native.common.reconnect"];
        ConfigureConnectionControls();
        PauseTransferButton.Label = localization["native.common.pause"];
        PauseAllTransfersButton.Label = localization["transfer.pauseAll"];
        CancelAllTransfersButton.Label = localization["transfer.cancelAll"];
        ResumeTransferButton.Label = localization["native.common.resume"];
        CancelTransferButton.Label = localization["native.common.cancelTransfer"];
        RetryTransferButton.Label = localization["native.common.retry"];
        OpenTransferLocationButton.Label = localization["transfer.openFolder"];
        ClearTransferButton.Label = localization["native.common.clearFinished"];
        UpdateTransferControls();
        Status.Text = localization["status.notConnected"];
        AiTestButton.Content = localization["native.ai.test"];
        AiDiscoverButton.Content = localization["native.ai.discover"];
        AiCapabilityButton.Content = localization["native.ai.capability"];
        AiConfigureButton.Content = localization["native.ai.configure"];
        AiClearTokenButton.Content = localization["native.ai.clearToken"];
        AiDeleteProviderButton.Content = localization["native.ai.deleteProvider"];
        AiImageButton.Content = localization["native.ai.image"];
        AiSendButton.Content = localization["native.ai.send"];
        AiCancelButton.Content = localization["native.ai.cancel"];
        AiClearButton.Content = localization["native.ai.clear"];
        AiInput.PlaceholderText = localization["native.ai.message"];
        AiTargetLabel.Text = localization["aiCommands.targetSsh"];
        AiTargetChoice.PlaceholderText = localization["aiCommands.selectSsh"];
        AiTargetWarning.Text = localization["aiCommands.terminalUnavailable"];
        AiResponseModeLabel.Text = localization["aiAssistant.responseMode"];
        AiResponseModeChoice.Items.Clear();
        AiResponseModeChoice.Items.Add(new ComboBoxItem { Content = localization["aiAssistant.stream"], Tag = "stream" });
        AiResponseModeChoice.Items.Add(new ComboBoxItem { Content = localization["aiAssistant.nonstream"], Tag = "nonstream" });
        AiResponseModeChoice.SelectedIndex = aiViewModel.StreamResponses ? 0 : 1;
        AiTargetWarning.Visibility = aiViewModel.SelectedTerminalSessionId != null && !aiViewModel.SelectedTerminalAvailable ? Visibility.Visible : Visibility.Collapsed;
        RefreshAiMessageViews();
        UpdateAiProviderActions();
        UpdateAiAssistantControls();
        NewGroupButton.Label = localization["native.commands.newGroup"];
        EditGroupButton.Label = localization["native.common.edit"];
        DeleteGroupButton.Label = localization["native.common.delete"];
        NewSnippetButton.Label = localization["native.commands.new"];
        EditSnippetButton.Label = localization["native.common.edit"];
        DuplicateSnippetButton.Label = localization["native.common.duplicate"];
        DeleteSnippetButton.Label = localization["native.common.delete"];
        SendSnippetButton.Label = localization["native.commands.send"];
        ClearHistoryButton.Label = localization["native.commands.clearHistory"];
        CommandSearch.PlaceholderText = localization["native.workbench.search"];
        CommandMoveUp.Content = localization["native.groups.moveUp"];
        CommandMoveDown.Content = localization["native.groups.moveDown"];
        CommandGroupsHeading.Text = localization["native.group"];
        ComposeCommandButton.Label = localization["commandEditor.title"];
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(CommandGroupMoveUp, localization["native.group"] + " · " + localization["native.groups.moveUp"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(CommandGroupMoveDown, localization["native.group"] + " · " + localization["native.groups.moveDown"]);
        ToolTipService.SetToolTip(CommandGroupMoveUp, localization["native.groups.moveUp"]);
        ToolTipService.SetToolTip(CommandGroupMoveDown, localization["native.groups.moveDown"]);
        NewForwardButton.Label = localization["native.forward.new"];
        EditForwardButton.Label = localization["native.common.edit"];
        DeleteForwardButton.Label = localization["native.common.delete"];
        StartForwardButton.Label = localization["native.forward.start"];
        StopForwardButton.Label = localization["native.forward.stop"];
        RefreshForwardButton.Label = localization["native.common.refresh"];
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
        ThemeChoice.Items.Clear();
        ThemeChoice.Items.Add(new ComboBoxItem { Tag = "system", Content = localization["settings.themeSystem"] });
        ThemeChoice.Items.Add(new ComboBoxItem { Tag = "light", Content = localization["settings.themeLight"] });
        ThemeChoice.Items.Add(new ComboBoxItem { Tag = "dark", Content = localization["settings.themeDark"] });
        LanguageChoice.ItemsSource = NativeSettings.Languages;
        ThemeChoice.SelectedItem = ThemeChoice.Items.OfType<ComboBoxItem>().First(item => Equals(item.Tag, settings.ThemeMode));
        LanguageChoice.SelectedItem = settings.Language;
        TransparencyChoice.IsOn = settings.ReduceTransparency;
        ConfigureDefaultProxy();
        PreferencesHost.Content = new Controls.NativePreferencesPanel(settings, key => localization[key], patch =>
        {
            try
            {
                settings = NativeSettings.Update(store, patch);
                ApplyAppearance();
                UpdateAiAssistantControls();
                transferQueue.ConfigureLimits(settings.Get("sftp.maxConcurrentGlobal", 4), settings.Get("sftp.maxConcurrentPerSession", 2));
                foreach (var workspace in sessionWorkspaces.Values) workspace.Configure(settings);
                if (patch.ContainsKey("connection")) LoadProfiles();
                Status.Text = localization["native.common.saved"];
            }
            catch (Exception error) { ShowError(error); }
        }, async () =>
        {
            try
            {
                var picker = new FolderPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, WindowHandle());
                var folder = await picker.PickSingleFolderAsync();
                return folder?.Path;
            }
            catch (Exception error) { ShowError(error); return null; }
        });
        ShowSettingsSection(selectedSettingsSection);
        transferQueue.ConfigureLimits(settings.Get("sftp.maxConcurrentGlobal", 4), settings.Get("sftp.maxConcurrentPerSession", 2));
        loadingSettings = false;
        ApplyAppearance();
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
        connectionTree?.Reload(connections.Profiles.ToArray(), ConnectionGroups.Groups.ToArray());
        RecentConnections.ItemsSource = connections.Profiles.Where(p => p.Data["lastUsedAt"] != null || p.Data["lastConnectedAt"] != null)
            .OrderByDescending(p => (p.Data["lastUsedAt"]?.GetValue<long>() ?? p.Data["lastConnectedAt"]!.GetValue<long>())).Take(8).ToArray();
        UpdateRecentEmptyState();
    }

    private void ApplyActivityIcons()
    {
        ConnectionsIcon.Glyph = ActivityIconGlyphs["connections"];
        CommandsIcon.Glyph = ActivityIconGlyphs["commands"];
        ForwardIcon.Glyph = ActivityIconGlyphs["forwards"];
        TransfersIcon.Glyph = ActivityIconGlyphs["transfers"];
        AiIcon.Glyph = ActivityIconGlyphs["ai"];
        ThemeIcon.Glyph = ActivityIconGlyphs["theme"];
        SettingsIcon.Glyph = ActivityIconGlyphs["settings"];
    }

    private void ActivityItemClicked(object sender, RoutedEventArgs args)
    {
        if (sender is not Button { Tag: string tag }) return;
        if (tag == "theme") { ToggleTheme(); return; }
        if (tag is "settings" or "ai") { ActivatePage(tag); return; }
        SelectActivity(tag, toggle: true);
    }

    private void ToggleTheme()
    {
        var next = settings.ThemeMode.Equals("dark", StringComparison.OrdinalIgnoreCase) ? "light" : "dark";
        settings = (settings with { ThemeMode = next }).Save(store);
        loadingSettings = true;
        ThemeChoice.SelectedItem = ThemeChoice.Items.OfType<ComboBoxItem>().FirstOrDefault(item => Equals(item.Tag, next));
        loadingSettings = false;
        ApplyAppearance();
        UpdateActivityMarkers();
        Status.Text = localization.Format("native.themeStatus", ("value", next));
    }

    private void SelectActivity(string tag, bool toggle)
    {
        if (tag is not ("connections" or "commands" or "forwards" or "transfers")) return;
        var same = activeActivity == tag;
        activeActivity = tag;
        activeOverlay = null;
        SettingsOverlay.Visibility = Visibility.Collapsed;
        AiPage.Visibility = Visibility.Collapsed;
        ConnectionSidebarPage.Visibility = tag == "connections" ? Visibility.Visible : Visibility.Collapsed;
        CommandsPage.Visibility = tag == "commands" ? Visibility.Visible : Visibility.Collapsed;
        ForwardPage.Visibility = tag == "forwards" ? Visibility.Visible : Visibility.Collapsed;
        TransfersPage.Visibility = tag == "transfers" ? Visibility.Visible : Visibility.Collapsed;
        if (!same)
        {
            if (responsiveSidebarCollapsed) responsiveSidebarOpen = true;
            else store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["sidebarCollapsed"] = false });
        }
        else if (toggle)
        {
            if (responsiveSidebarCollapsed) responsiveSidebarOpen = !responsiveSidebarOpen;
            else
            {
                var currentlyCollapsed = store.Find("nativeWorkspace", "nativeWorkspace")?["sidebarCollapsed"]?.GetValue<bool>() ?? false;
                store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["sidebarCollapsed"] = !currentlyCollapsed });
            }
        }
        store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["activeSidebar"] = tag });
        ConfigureActivityHeading();
        UpdateOverlayLayout();
        UpdateWorkbenchLayout();
        ShowSelectedSessionContent();
    }

    private void ConfigureActivityHeading()
    {
        ContextHeading.Text = activeActivity switch
        {
            "commands" => localization["native.workbench.commands"],
            "forwards" => localization["activity.forwards"],
            "transfers" => localization["activity.transfers"],
            _ => localization["activity.connections"]
        };
        UpdateActivityMarkers();
    }

    private void UpdateActivityMarkers()
    {
        var overlay = activeOverlay;
        var connectionsSelected = overlay == null && activeActivity == "connections";
        var commandsSelected = overlay == null && activeActivity == "commands";
        var forwardsSelected = overlay == null && activeActivity == "forwards";
        var transfersSelected = overlay == null && activeActivity == "transfers";
        var aiSelected = overlay == "ai";
        var settingsSelected = overlay is "settings" or "lansync" or "about";
        ConnectionsMarker.Visibility = connectionsSelected ? Visibility.Visible : Visibility.Collapsed;
        CommandsMarker.Visibility = commandsSelected ? Visibility.Visible : Visibility.Collapsed;
        ForwardMarker.Visibility = forwardsSelected ? Visibility.Visible : Visibility.Collapsed;
        TransfersMarker.Visibility = transfersSelected ? Visibility.Visible : Visibility.Collapsed;
        ConnectionsSelection.Visibility = connectionsSelected ? Visibility.Visible : Visibility.Collapsed;
        CommandsSelection.Visibility = commandsSelected ? Visibility.Visible : Visibility.Collapsed;
        ForwardSelection.Visibility = forwardsSelected ? Visibility.Visible : Visibility.Collapsed;
        TransfersSelection.Visibility = transfersSelected ? Visibility.Visible : Visibility.Collapsed;
        AiSelection.Visibility = aiSelected ? Visibility.Visible : Visibility.Collapsed;
        SettingsSelection.Visibility = settingsSelected ? Visibility.Visible : Visibility.Collapsed;
        ThemeSelection.Visibility = Root.ActualTheme == ElementTheme.Dark ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ActivatePage(string? tag)
    {
        var previousOverlay = activeOverlay;
        switch (tag)
        {
            case "settings":
                activeOverlay = "settings";
                ShowSettingsSection(selectedSettingsSection);
                SettingsPage.Visibility = Visibility.Visible;
                LanSyncPage.Visibility = Visibility.Collapsed;
                AboutPage.Visibility = Visibility.Collapsed;
                SettingsOverlay.Visibility = Visibility.Visible;
                AiPage.Visibility = Visibility.Collapsed;
                UpdateActivityMarkers();
                break;
            case "lansync":
                activeOverlay = "lansync";
                SettingsPage.Visibility = Visibility.Collapsed;
                LanSyncPage.Visibility = Visibility.Visible;
                AboutPage.Visibility = Visibility.Collapsed;
                SettingsOverlay.Visibility = Visibility.Visible;
                AiPage.Visibility = Visibility.Collapsed;
                UpdateActivityMarkers();
                break;
            case "about":
                activeOverlay = "about";
                SettingsPage.Visibility = Visibility.Collapsed;
                LanSyncPage.Visibility = Visibility.Collapsed;
                AboutPage.Visibility = Visibility.Visible;
                SettingsOverlay.Visibility = Visibility.Visible;
                AiPage.Visibility = Visibility.Collapsed;
                ConfigureAbout();
                UpdateActivityMarkers();
                break;
            case "ai":
                RefreshAiTargets();
                activeOverlay = "ai";
                SettingsOverlay.Visibility = Visibility.Collapsed;
                AiPage.Visibility = Visibility.Visible;
                UpdateActivityMarkers();
                break;
            case "connections": case "commands": case "forwards": case "transfers":
                SelectActivity(tag, toggle: false);
                return;
            default:
                return;
        }
        UpdateOverlayLayout();
        if (previousOverlay != activeOverlay)
        {
            if (activeOverlay == "ai") AiInput.Focus(FocusState.Programmatic);
            else CloseSettingsButton.Focus(FocusState.Programmatic);
        }
        ShowSelectedSessionContent();
    }

    private void ShowSettingsPreferences(object sender, RoutedEventArgs args) { ShowSettingsSection("general"); ActivatePage("settings"); }
    private void ShowLanSyncSettings(object sender, RoutedEventArgs args) => ActivatePage("lansync");
    private void CloseOverlay(object sender, RoutedEventArgs args)
        => CloseOverlayCore();

    private void CloseOverlayCore()
    {
        activeOverlay = null;
        SettingsOverlay.Visibility = Visibility.Collapsed;
        AboutPage.Visibility = Visibility.Collapsed;
        AiPage.Visibility = Visibility.Collapsed;
        UpdateActivityMarkers();
        UpdateOverlayLayout();
        ShowSelectedSessionContent();
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
        var protocol = new ComboBox { Header = localization["native.protocol"], HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = new[] { "ssh", "rdp" }, SelectedItem = data["protocol"]?.GetValue<string>() ?? "ssh" };
        var domain = new TextBox { Header = localization["conn.rdpDomain"], Text = NativeRdpProfileOptions.FromProfile(data).Domain ?? "", PlaceholderText = localization["conn.rdpDomainPlaceholder"] };
        ToolTipService.SetToolTip(domain, localization["conn.rdpDomainHint"]);
        var method = new ComboBox { Header = localization["native.authMethod"], HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = new[] { "password", "privateKey", "agent" }, SelectedItem = data["auth"]?["method"]?.GetValue<string>() ?? "password" };
        var password = new PasswordBox { Header = localization["native.password"] };
        var keyChoice = new ComboBox { Header = localization["native.keys.savedKey"], HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = savedKeys.Items, DisplayMemberPath = nameof(SavedKeyItem.Name), SelectedValuePath = nameof(SavedKeyItem.Id), SelectedValue = data["auth"]?["privateKeyId"]?.GetValue<string>() };
        var proxyChoices = new ComboBox { Header = localization["native.proxies.savedProxy"], HorizontalAlignment = HorizontalAlignment.Stretch };
        proxyChoices.Items.Add(new ComboBoxItem { Content = localization["native.proxies.direct"], Tag = "" });
        foreach (var proxy in savedProxies.Items) proxyChoices.Items.Add(new ComboBoxItem { Content = $"{proxy.Name} · {proxy.Type} · {proxy.Host}:{proxy.Port}", Tag = proxy.Id });
        proxyChoices.Items.Insert(0, new ComboBoxItem { Content = localization["native.workbench.followProxy"], Tag = "@follow" });
        var existingProxyId = existing == null || NativeProxyResolver.Mode(data) == "follow" ? "@follow" : data["proxyId"]?.GetValue<string>() ?? "";
        proxyChoices.SelectedItem = proxyChoices.Items.OfType<ComboBoxItem>().FirstOrDefault(item => Equals(item.Tag, existingProxyId));
        var group = new ComboBox { Header = localization["native.group"], HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = new[] { new ConnectionGroup("", localization["conn.noGroup"], 0, 0) }.Concat(ConnectionGroups.Groups).ToArray(), DisplayMemberPath = nameof(ConnectionGroup.Name), SelectedValuePath = nameof(ConnectionGroup.Id), SelectedValue = data["groupId"]?.GetValue<string>() ?? data["group"]?.GetValue<string>() ?? newProfileGroup ?? "" };
        var jumpHost = new ComboBox { Header = localization["native.jumpHost"], HorizontalAlignment = HorizontalAlignment.Stretch };
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
        var charset = new ComboBox { Header = localization["native.charset"], HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = new[] { "utf8", "gb18030", "gbk", "big5", "latin1" }, SelectedItem = charsetValue };
        var termType = new TextBox { Header = localization["native.termType"], Text = data["terminal"]?["termType"]?.GetValue<string>() ?? "xterm-256color" };
        var startup = new TextBox { Header = localization["native.startupCommand"], Text = data["terminal"]?["startupCommand"]?.GetValue<string>() ?? "" };
        var keepAlive = new NumberBox { Header = localization["native.keepAlive"], Value = data["options"]?["keepaliveInterval"]?.GetValue<int>() ?? 15000, Minimum = 0, Maximum = 600000 };
        var timeout = new NumberBox { Header = localization["native.readyTimeout"], Value = data["options"]?["readyTimeout"]?.GetValue<int>() ?? 20000, Minimum = 1000, Maximum = 600000 };
        var flag = new ComboBox { Header = localization["conn.flag"], HorizontalAlignment = HorizontalAlignment.Stretch };
        var flagOptions = new[] { "", "lan", "CN", "HK", "TW", "JP", "KR", "SG", "US", "CA", "GB", "DE", "FR", "NL", "RU", "IN", "AU", "BR", "globe" };
        foreach (var code in flagOptions)
        {
            var label = string.IsNullOrWhiteSpace(code) ? localization["conn.flagNone"] : localization[$"region.{code}"];
            var item = new ComboBoxItem { Tag = code, HorizontalContentAlignment = HorizontalAlignment.Stretch };
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            if (!string.IsNullOrWhiteSpace(code)) row.Children.Add(NativeRegionMarker.Create(code, 16));
            row.Children.Add(new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center });
            item.Content = row;
            flag.Items.Add(item);
        }
        var currentFlag = data["flag"]?.GetValue<string>() ?? "";
        if (!string.IsNullOrWhiteSpace(currentFlag) && !flagOptions.Contains(currentFlag, StringComparer.Ordinal))
        {
            var legacy = new ComboBoxItem { Tag = currentFlag, Content = currentFlag };
            flag.Items.Add(legacy);
        }
        flag.SelectedItem = flag.Items.OfType<ComboBoxItem>().FirstOrDefault(item => string.Equals(item.Tag?.ToString(), currentFlag, StringComparison.Ordinal)) ?? flag.Items[0];
        ToolTipService.SetToolTip(flag, localization["conn.flagHint"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(flag, localization["conn.flag"]);
        var note = new TextBox { Header = localization["conn.note"], AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Text = data["note"]?.GetValue<string>() ?? "" };
        var autoReconnect = new CheckBox { Content = localization["native.workbench.autoReconnect"], IsChecked = data["options"]?["autoReconnect"]?.GetValue<bool>() ?? true };
        var monitorEnabled = new CheckBox { Content = localization["conn.monitorEnabled"], IsChecked = data["options"]?["monitorEnabled"]?.GetValue<bool>() ?? true };
        var compress = new CheckBox { Content = localization["conn.compress"], IsChecked = data["options"]?["compress"]?.GetValue<bool>() ?? false };
        var legacyAlgorithms = new CheckBox { Content = localization["conn.legacyAlgorithms"], IsChecked = data["options"]?["legacyAlgorithms"]?.GetValue<bool>() ?? false };
        var rdpOptions = NativeRdpProfileOptions.FromProfile(data);
        var clipboard = new CheckBox { Content = localization["conn.rdpClipboard"], IsChecked = rdpOptions.Clipboard };
        var audio = new CheckBox { Content = localization["conn.rdpAudioPlayback"], IsChecked = rdpOptions.AudioPlayback };
        var certificate = new ComboBox { Header = localization["conn.rdpCertificatePolicy"], HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = new[] { "prompt", "strict" }, SelectedItem = rdpOptions.CertificatePolicy };
        var clearPassword = new CheckBox { Content = localization["conn.rdpClearPassword"] };
        var sshOnly = new Control[] { method, keyChoice, proxyChoices, jumpHost, charset, termType, startup, keepAlive, timeout, autoReconnect, monitorEnabled, compress, legacyAlgorithms };
        var rdpOnly = new Control[] { domain, clipboard, audio, certificate, clearPassword };
        void UpdateProtocolFields()
        {
            var isRdp = Equals(protocol.SelectedItem, "rdp");
            foreach (var control in rdpOnly) control.Visibility = isRdp ? Visibility.Visible : Visibility.Collapsed;
            foreach (var control in sshOnly) control.Visibility = isRdp ? Visibility.Collapsed : Visibility.Visible;
            if (existing == null && isRdp && port.Value == 22) port.Value = 3389;
            else if (existing == null && !isRdp && port.Value == 3389) port.Value = 22;
        }
        protocol.SelectionChanged += (_, _) => UpdateProtocolFields();
        UpdateProtocolFields();
        var addressRow = new Grid { ColumnSpacing = 12 };
        addressRow.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        addressRow.ColumnDefinitions.Add(new() { Width = new GridLength(100) });
        addressRow.Children.Add(host); addressRow.Children.Add(port); Grid.SetColumn(port, 1);
        var advanced = new Expander { Header = localization["conn.advanced"], HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = new StackPanel { Spacing = 12, Children = { charset, termType, startup, keepAlive, timeout, autoReconnect, monitorEnabled, compress, legacyAlgorithms } } };
        var proxySection = new Expander { Header = localization["conn.proxy"], HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = new StackPanel { Spacing = 12, Children = { proxyChoices, jumpHost } } };
        protocol.SelectionChanged += (_, _) => { advanced.Visibility = proxySection.Visibility = Equals(protocol.SelectedItem, "rdp") ? Visibility.Collapsed : Visibility.Visible; };
        advanced.Visibility = proxySection.Visibility = Equals(protocol.SelectedItem, "rdp") ? Visibility.Collapsed : Visibility.Visible;
        var panel = new ScrollViewer { HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Content = new StackPanel { Padding = new Thickness(20), Spacing = 12, Children = { name, protocol, group, addressRow, user, domain, method, password, keyChoice, clipboard, audio, certificate, clearPassword, flag, note, advanced, proxySection } } };
        if (!await ShowConnectionDrawerAsync(panel, existing == null ? localization["native.newConnection"] : localization["native.common.edit"], name)) return;
        if (string.IsNullOrWhiteSpace(name.Text) || string.IsNullOrWhiteSpace(host.Text) || (protocol.SelectedItem?.ToString() == "ssh" && string.IsNullOrWhiteSpace(user.Text))) { ShowError(localization["native.validationFailed"]); return; }
        var id = existing?.Id ?? Guid.NewGuid().ToString("N");
        var isRdp = Equals(protocol.SelectedItem, "rdp");
        var secretRef = isRdp ? rdpOptions.PasswordRef : data["auth"]?["passwordRef"]?.GetValue<string>();
        var payload = (JsonObject)data.DeepClone();
        payload["id"] = id; payload["name"] = name.Text.Trim(); payload["host"] = host.Text.Trim(); payload["port"] = (int)port.Value;
        payload["username"] = user.Text.Trim(); payload["protocol"] = protocol.SelectedItem?.ToString() ?? "ssh";
        var selectedFlag = (flag.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
        if (string.IsNullOrWhiteSpace(selectedFlag)) payload.Remove("flag"); else payload["flag"] = selectedFlag;
        payload["note"] = note.Text;
        if (payload["protocol"]?.GetValue<string>() == "rdp")
        {
            if (domain.Text.Length > 120) { ShowError(localization["conn.rdpDomainTooLong"]); return; }
            var rdp = payload["rdp"] as JsonObject ?? new JsonObject();
            rdp["domain"] = domain.Text.Trim(); rdp["clipboard"] = clipboard.IsChecked == true;
            rdp["audioPlayback"] = audio.IsChecked == true; rdp["certificatePolicy"] = certificate.SelectedItem?.ToString() ?? "prompt";
            payload["rdp"] = rdp; payload.Remove("domain");
        }
        var auth = payload["auth"] as JsonObject ?? new JsonObject();
        auth["method"] = payload["protocol"]?.GetValue<string>() == "rdp" ? "password" : method.SelectedItem?.ToString() ?? "password";
        if (!isRdp) auth["passwordRef"] = secretRef;
        if (payload["protocol"]?.GetValue<string>() != "rdp") auth["privateKeyId"] = keyChoice.SelectedValue?.ToString();
        payload["auth"] = auth;
        var selectedProxy = (proxyChoices.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        if (!isRdp) payload["proxyMode"] = string.IsNullOrEmpty(selectedProxy) ? "direct" : selectedProxy == "@follow" ? "follow" : "custom";
        if (!isRdp) payload["proxyId"] = selectedProxy == "@follow" || string.IsNullOrEmpty(selectedProxy) ? null : selectedProxy;
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
        options["keepaliveInterval"] = (int)keepAlive.Value; options["readyTimeout"] = (int)timeout.Value;
        if (!isRdp) { options["autoReconnect"] = autoReconnect.IsChecked == true; options["monitorEnabled"] = monitorEnabled.IsChecked == true;
            options["compress"] = compress.IsChecked == true; options["legacyAlgorithms"] = legacyAlgorithms.IsChecked == true; }
        payload["options"] = options;
        if (isRdp && clearPassword.IsChecked == true) secretRef = null;
        if (!string.IsNullOrEmpty(password.Password)) secretRef = store.SaveSecret(password.Password);
        if (isRdp) { payload["rdp"]!["passwordRef"] = secretRef; payload["auth"]!.AsObject().Remove("passwordRef"); }
        else payload["auth"]!["passwordRef"] = secretRef;
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

    private async void DeleteConnection(object sender, RoutedEventArgs args)
    {
        try { await ConfirmDeleteProfileAsync(); } catch (Exception error) { ShowError(error); }
    }

    private async void OpenConnection(object sender, ItemClickEventArgs args)
    {
        if (args.ClickedItem is not ConnectionProfile profile) return;
        await OpenProfileAsync(profile);
    }

    private readonly HashSet<string> pendingProfileOpens = new(StringComparer.Ordinal);
    private async Task OpenProfileAsync(ConnectionProfile profile, bool duplicate = false)
    {
        if (!pendingProfileOpens.Add(profile.Id)) return;
        ActivatePage("connections");
        try
        {
            if (string.Equals(profile.Data["protocol"]?.GetValue<string>(), "rdp", StringComparison.OrdinalIgnoreCase))
            {
                await OpenRdpConnectionAsync(profile);
                return;
            }
            var existing = sessionsManager.List().FirstOrDefault(snapshot => snapshot.ProfileId == profile.Id && snapshot.State is NativeSessionState.Ready or NativeSessionState.Connecting or NativeSessionState.Reconnecting);
            if (existing != null && !duplicate)
            {
                if (sessionTabs.TryGetValue(existing.SessionId, out var existingTab)) Sessions.SelectedItem = existingTab;
                else
                {
                    var terminal = new Controls.NativeTerminalCanvas { Margin = new Thickness(8, 4, 0, 4) };
                    if (sessionOutputSinks.TryGetValue(existing.SessionId, out var sink)) { sink.Error = ShowError; sink.Attach(terminal); }
                    CreateSessionTerminalTab(profile, existing.SessionId, terminal);
                }
                RecordSuccessfulConnection(profile.Id);
                return;
            }
            var initialTerminal = new Controls.NativeTerminalCanvas { Margin = new Thickness(8, 4, 0, 4) };
            var terminalSink = new SessionTerminalSink(sessionsManager) { Error = ShowError };
            terminalSink.Attach(initialTerminal);
            var connectingId = "connecting:" + Guid.NewGuid().ToString("N");
            var connectingTab = new TabViewItem { Header = profile.Name, Tag = connectingId, IsClosable = false };
            var progressRing = new ProgressRing { IsActive = true, Width = 36, Height = 36, HorizontalAlignment = HorizontalAlignment.Center };
            var connectionLabel = new TextBlock
            {
                Text = localization.Format("terminal.connecting", ("target", profile.Name)),
                FontSize = 16,
                FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap
            };
            var connectionTarget = new TextBlock
            {
                Text = $"{profile.Username}@{profile.Host}:{profile.Port}",
                FontSize = 12,
                Opacity = .7,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                IsTextSelectionEnabled = true
            };
            var connectionCard = new StackPanel
            {
                Spacing = 14,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                MaxWidth = 480,
                Children = { progressRing, connectionLabel, connectionTarget }
            };
            var connectionProgress = new Border
            {
                Padding = new Thickness(32),
                CornerRadius = new CornerRadius(8),
                BorderThickness = new Thickness(1),
                BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush,
                Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Child = connectionCard
            };
            var progressHost = new Grid { Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush };
            progressHost.Children.Add(connectionProgress);
            AddSessionTab(connectingTab, progressHost);
            NativeSessionSnapshot snapshot;
            try { snapshot = await sessionsManager.OpenAsync(profile, ConfirmHostAsync, PromptAsync, CancellationToken.None, terminalSink.WriteAsync); }
            catch { RemoveSessionTab(connectingTab); terminalSink.Detach(initialTerminal); initialTerminal.Dispose(); throw; }
            RemoveSessionTab(connectingTab);
            terminalSink.Bind(snapshot.SessionId);
            sessionOutputSinks[snapshot.SessionId] = terminalSink;
            CreateSessionTerminalTab(profile, snapshot.SessionId, initialTerminal);
            RecordSuccessfulConnection(profile.Id);
            Status.Text = $"{profile.Host}:{profile.Port} · {localization["native.connected"]}";
        }
        catch (Exception error) { ShowError(error); }
        finally { pendingProfileOpens.Remove(profile.Id); }
    }

    private void CreateSessionTerminalTab(ConnectionProfile profile, string sessionId, Controls.NativeTerminalCanvas terminal)
    {
        terminal.Configure(settings, key => localization[key]);
        terminal.HistoryRequested += () => _ = ShowTerminalHistoryAsync(terminal, sessionId);
        terminal.CommandEntered += command =>
        {
            if (settings.SaveCommandHistory) CommandViewModel.AddHistory(sessionId, command);
            if (sessionWorkspaces.TryGetValue(sessionId, out var workspace)) workspace.FollowShellCommand(command);
        };
        terminal.SearchRequested += () => _ = ShowTerminalSearchAsync(terminal);
        sessionTerminals[sessionId] = terminal;
        var openSftp = new Button { Content = localization["native.openSftp"], HorizontalAlignment = HorizontalAlignment.Left };
        openSftp.Click += (_, _) => OpenSftpTab(sessionId, profile.Name);
        var openMonitor = new Button { Content = localization["native.openMonitor"], HorizontalAlignment = HorizontalAlignment.Left };
        openMonitor.Click += (_, _) => OpenMonitorTab(sessionId, profile.Name);
        var openPortTraffic = new Button { Content = localization["native.portTraffic.title"], HorizontalAlignment = HorizontalAlignment.Left };
        openPortTraffic.Click += (_, _) => OpenPortTrafficTab(sessionId, profile.Name);
        void Tool(Button button, string glyph)
        {
            var label = button.Content?.ToString() ?? "";
            ToolTipService.SetToolTip(button, label);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, label);
            button.Content = new FontIcon { Glyph = glyph, FontSize = 14 };
            button.Width = button.Height = 28; button.Padding = new Thickness(0); button.BorderThickness = new Thickness(0);
        }
        Tool(openSftp, "\uE8B7"); Tool(openMonitor, "\uE9D9"); Tool(openPortTraffic, "\uE968");
        var search = new Button { Content = localization["terminal.search"] };
        search.Click += async (_, _) => await ShowTerminalSearchAsync(terminal); Tool(search, "\uE721");
        var history = new Button { Content = localization["terminal.historyTip"] };
        history.Click += async (_, _) => await ShowTerminalHistoryAsync(terminal, sessionId); Tool(history, "\uE81C");
        var clear = new Button { Content = localization["terminal.clear"] };
        clear.Click += (_, _) => terminal.ClearScreen(); Tool(clear, "\uE75C");
        var disconnect = new Button { Content = localization["terminal.disconnect"] };
        disconnect.Click += async (_, _) => { if (sessionTabs.TryGetValue(sessionId, out var closing)) await CloseSessionTabAsync(closing); }; Tool(disconnect, "\uE8CD");
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Children = { openSftp, openMonitor, search, history, openPortTraffic, clear, disconnect } };
        var session = sessionsManager.Get(sessionId);
        var content = new Controls.NativeSessionWorkspace(terminal, toolbar, store,
            () => new Controls.NativeSftpBrowser(session, transferQueue, WindowHandle, key => localization[key], path => OpenRemoteEditorTab(sessionId, profile.Name, path), settings),
            () => new Controls.NativeMonitorPanel(session, settings.MonitorIntervalMs, key => localization[key]),
            path => new Controls.NativeRemoteEditor(session, remoteEditorService, key => localization[key], WindowHandle(), Root, settings, HandleNativeEditorShortcut) { Tag = path });
        sessionWorkspaces[sessionId] = content;
        if (settings.Data["sftp"]?["autoOpenOnConnect"]?.GetValue<bool>() ?? true) content.ToggleFiles(true);
        var tab = new TabViewItem { Header = profile.Name, Tag = sessionId };
        sessionTabs[sessionId] = tab;
        sessionProfiles[sessionId] = profile;
        AddSessionTab(tab, content);
        if (profile.Data["options"]?["monitorEnabled"]?.GetValue<bool>() ?? true)
            content.ToggleMonitor(true);
        RefreshAiTargets();
    }

    private void RecordSuccessfulConnection(string profileId)
    {
        try
        {
            var current = store.Find("profiles", profileId);
            if (current == null) return;
            current["lastUsedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var revision = store.Save("profiles", profileId, current, current["_revision"]?.GetValue<long>() ?? 0);
            _ = coordinator?.NotifyConfigurationChangedAsync("profiles", revision);
            LoadProfiles();
            connections.Selected = connections.Profiles.FirstOrDefault(item => item.Id == profileId);
            ProfilesList.SelectedItem = connections.Selected;
        connectionTree?.Reload(connections.Profiles.ToArray(), ConnectionGroups.Groups.ToArray());
        RecentConnections.ItemsSource = connections.Profiles.Where(p => p.Data["lastUsedAt"] != null || p.Data["lastConnectedAt"] != null)
            .OrderByDescending(p => (p.Data["lastUsedAt"]?.GetValue<long>() ?? p.Data["lastConnectedAt"]!.GetValue<long>())).Take(8).ToArray();
        UpdateRecentEmptyState();
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
        var query = new TextBox { PlaceholderText = localization["terminal.searchPlaceholder"], MinWidth = 360 };
        var result = new TextBlock { Text = "", VerticalAlignment = VerticalAlignment.Center, MinWidth = 48 };
        var caseSensitive = new CheckBox { Content = localization["terminal.searchCase"] };
        var regex = new CheckBox { Content = localization["terminal.searchRegex"] };
        var previous = new Button { Content = localization["terminal.searchPrev"] };
        var next = new Button { Content = localization["terminal.searchNext"] };
        var count = 0;
        void UpdateResult()
        {
            count = terminal.Search(query.Text, caseSensitive.IsChecked == true, regex.IsChecked == true);
            result.Text = count > 0 ? $"1/{count}" : string.IsNullOrEmpty(query.Text) ? "" : "0/0";
        }
        query.TextChanged += (_, _) => UpdateResult();
        caseSensitive.Checked += (_, _) => UpdateResult();
        caseSensitive.Unchecked += (_, _) => UpdateResult();
        regex.Checked += (_, _) => UpdateResult();
        regex.Unchecked += (_, _) => UpdateResult();
        query.KeyDown += (_, args) =>
        {
            if (args.Key != Windows.System.VirtualKey.Enter) return;
            var index = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)
                ? terminal.SearchPrevious()
                : terminal.SearchNext();
            result.Text = count > 0 ? $"{index}/{count}" : "0/0";
            args.Handled = true;
        };
        previous.Click += (_, _) => { var index = terminal.SearchPrevious(); result.Text = count > 0 ? $"{index}/{count}" : "0/0"; };
        next.Click += (_, _) => { var index = terminal.SearchNext(); result.Text = count > 0 ? $"{index}/{count}" : "0/0"; };
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { previous, next, result, caseSensitive, regex } };
        var content = new StackPanel { Spacing = 8, Children = { query, actions } };
        var dialog = new ContentDialog
        {
            Title = localization["shortcut.search"], Content = content,
            PrimaryButtonText = localization["common.close"],
            XamlRoot = Root.XamlRoot
        };
        dialog.Opened += (_, _) => { query.Focus(FocusState.Programmatic); UpdateResult(); };
        await dialog.ShowGatedAsync();
    }

    private async Task OpenRdpConnectionAsync(ConnectionProfile profile)
    {
        var id = Guid.NewGuid().ToString("N");
        var passwordRef = NativeRdpProfileOptions.FromProfile(profile.Data).PasswordRef;
        var storedPassword = store.ReadSecret(passwordRef);
        var rdp = new RdpSessionViewModel(profile.Data);
        rdpSessions[id] = rdp;
        rdp.CertificateRequested += prompt => _ = HandleRdpCertificatePromptAsync(rdp, prompt);
        var surface = new Controls.NativeRdpSurface(rdp);
        rdpSurfaces[id] = surface;
        var state = new TextBlock { Text = localization["conn.rdpTitle"], VerticalAlignment = VerticalAlignment.Center };
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
                DispatcherQueue.TryEnqueue(() => state.Text = rdp.Error == null ? $"{localization["conn.rdpTitle"]} · {rdp.State}" : $"{localization["conn.rdpTitle"]} · {rdp.State} · {rdp.Error}");
        };
        rdp.CapabilitiesChanged += capabilities => DispatcherQueue.TryEnqueue(() =>
        {
            var audio = capabilities.AudioPlayback ? "✓" : "—";
            var files = capabilities.ClipboardFilesUpload && capabilities.ClipboardFilesPaste ? "✓" : "—";
            state.Text = $"{localization["conn.rdpTitle"]} · {rdp.State} · {localization["native.rdp.fileClipboard"]} {files} · {localization["native.rdp.audio"]} {audio}";
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
            Status.Text = audioError == null ? $"{localization["conn.rdpTitle"]} · audio: {audioState}" : $"{localization["conn.rdpTitle"]} · audio: {audioError}");
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(8), Children = { state, copy, paste, pasteFiles, downloadFiles, systemRdp, disconnect } };
        var content = new Grid { RowDefinitions = { new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = new GridLength(1, GridUnitType.Star) } } };
        content.Children.Add(toolbar); Grid.SetRow(surface, 1); content.Children.Add(surface);
        var tab = new TabViewItem { Header = profile.Name, Tag = id };
        sessionTabs[id] = tab;
        sessionProfiles[id] = profile;
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
            Status.Text = localization["conn.rdpLaunched"];
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
            var dialog = new ContentDialog { Title = localization["conn.rdpCertificatePolicy"], Content = new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap }, PrimaryButtonText = localization["native.common.continue"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
            try { decision.TrySetResult(await dialog.ShowGatedAsync() == ContentDialogResult.Primary); }
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
        if (sessionWorkspaces.TryGetValue(sessionId, out var workspace)) { workspace.ToggleFiles(); return; }
        var session = sessionsManager.Get(sessionId);
        var browser = new Controls.NativeSftpBrowser(session, transferQueue, WindowHandle, key => localization[key], path => OpenRemoteEditorTab(sessionId, profileName, path), settings);
        var tab = new TabViewItem { Header = $"{profileName} · SFTP", Tag = $"sftp:{sessionId}" };
        AddSessionTab(tab, browser);
    }

    private void OpenRemoteEditorTab(string sessionId, string profileName, string path)
    {
        try
        {
            editorWindowHost.Open(sessionsManager.Get(sessionId), profileName, path);
        }
        catch (Exception error) { ShowError(error); }
        return;
    }

    private void OpenMonitorTab(string sessionId, string profileName)
    {
        if (sessionWorkspaces.TryGetValue(sessionId, out var workspace)) { workspace.ToggleMonitor(); return; }
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
        ConfigureSessionTabPresentation(tab);
        sessionContents[tag] = content;
        Sessions.TabItems.Add(tab);
        Sessions.SelectedItem = tab;
        ShowSelectedSessionContent();
    }

    private void SessionSelectionChanged(object sender, SelectionChangedEventArgs args) => ShowSelectedSessionContent();

    private void ShowSelectedSessionContent()
    {
        // Activity-bar navigation and settings/AI overlays must not tear down
        // the selected session. Keep its monitor collector and shell-directory
        // follower active while the session remains selected; only a different
        // session or an explicit close should deactivate it.
        foreach (var (id, workspace) in sessionWorkspaces)
            workspace.SetActive((Sessions.SelectedItem as TabViewItem)?.Tag?.ToString() == id);
        WelcomePage.Visibility = Sessions.TabItems.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        SessionContent.Content = Sessions.SelectedItem is TabViewItem tab &&
            tab.Tag?.ToString() is { } tag && sessionContents.TryGetValue(tag, out var content)
                ? content
                : null;
    }
    private void RemoveSessionTab(TabViewItem tab)
    {
        if (tab.Tag?.ToString() is { } tag) { sessionContents.Remove(tag); sessionProfiles.Remove(tag); }
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
            if (snapshot.State != NativeSessionState.Ready && sessionWorkspaces.TryGetValue(snapshot.SessionId, out var workspace)) workspace.ResetRemoteDirectory();
            editorWindowHost.SetSessionState(snapshot.SessionId, snapshot.State == NativeSessionState.Ready);
            if (snapshot.State == NativeSessionState.Failed && !string.IsNullOrWhiteSpace(snapshot.Error)) ShowError(snapshot.Error);
            if (sessionTabs.TryGetValue(snapshot.SessionId, out var sessionTab)) UpdateSessionTabState(sessionTab, snapshot.State);
            Status.Text = $"{snapshot.ProfileName} · {snapshot.State}";
            RefreshAiTargets();
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
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
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
        if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary)
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
        var resultText = lanSyncViewModel.LastResult is { } result && lanSyncViewModel.State.Phase == "applied"
            ? " · " + localization.Format("native.migrationCategories",
                ("groups", result.Groups.ToString()), ("keys", result.PrivateKeys.ToString()),
                ("proxies", result.Proxies.ToString()), ("knownHosts", result.KnownHosts.ToString()),
                ("forwards", result.Forwards.ToString()), ("aiProfiles", result.AiProfiles.ToString()))
            : string.Empty;
        LanSyncStatus.Text = (lanSyncViewModel.State.TcpPort is { } tcpPort ? $"{lanSyncViewModel.Status} · TCP {tcpPort}" : lanSyncViewModel.Status) + resultText;
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
        try
        {
            var choice = await ConfirmImportAsync(incoming.Import); if (choice == null) return;
            var result = await lanSyncViewModel.ApplyAsync(incoming.Token, choice.Value.Conflict, choice.Value.Preview);
            RefreshAfterPortableImport();
            Status.Text = FormatPortableImportResult(result);
        }
        catch (Exception error) { ShowError(error); }
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
        var name = new TextBox { Header = localization["conn.name"], Text = selected.Name, MaxLength = 120 };
        var parent = new ComboBox { Header = localization["native.group"], HorizontalAlignment = HorizontalAlignment.Stretch };
        parent.Items.Add(new ComboBoxItem { Content = localization["conn.noGroup"], Tag = "" });
        bool Descendant(ConnectionGroup candidate)
        {
            var visited = new HashSet<string>(StringComparer.Ordinal);
            for (var current = candidate; current != null && visited.Add(current.Id); current = ConnectionGroups.Groups.FirstOrDefault(g => g.Id == current.ParentId))
                if (current.Id == selected.Id) return true;
            return false;
        }
        foreach (var item in ConnectionGroups.Groups.Where(g => !Descendant(g))) parent.Items.Add(new ComboBoxItem { Content = item.Name, Tag = item.Id });
        parent.SelectedItem = parent.Items.OfType<ComboBoxItem>().FirstOrDefault(i => i.Tag?.ToString() == (selected.ParentId ?? ""));
        var dialog = new ContentDialog { Title = localization["native.common.edit"], Content = new StackPanel { Spacing = 12, Children = { name, parent } }, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary || string.IsNullOrWhiteSpace(name.Text)) return;
        try { ConnectionGroups.Save(selected.Id, name.Text, selected.Order, selected.Revision, (parent.SelectedItem as ComboBoxItem)?.Tag?.ToString() is { Length: > 0 } parentId ? parentId : null, changeParent: true); LoadProfiles(); Status.Text = localization["native.common.saved"]; }
        catch (Exception error) { ShowError(error); }
    }

    private async void DeleteConnectionGroup(object sender, RoutedEventArgs args)
    {
        if (ConnectionGroups.Selected is not { } selected) return;
        var dialog = new ContentDialog { Title = localization["native.common.delete"], Content = selected.Name, PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        try { store.DeleteConnectionGroup(selected.Id, selected.Revision); LoadProfiles(); Status.Text = localization["native.common.deleted"]; }
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
    private void CommandSnippetClicked(object sender, ItemClickEventArgs args)
    {
        if (args.ClickedItem is not NativeSnippet snippet) return;
        CommandViewModel.SelectedSnippet = snippet;
        var sessionId = SessionIdForTag((Sessions.SelectedItem as TabViewItem)?.Tag?.ToString());
        if (sessionId == null || !sessionTerminals.TryGetValue(sessionId, out var terminal))
        {
            ShowError(localization["native.commands.selectSession"]);
            return;
        }
        try
        {
            var session = sessionsManager.Get(sessionId);
            if (session.Snapshot.State != NativeSessionState.Ready) { ShowError(localization["native.commands.selectSession"]); return; }
            var profile = sessionProfiles.TryGetValue(sessionId, out var selectedProfile) ? selectedProfile : session.Profile;
            var command = NativeCommandLibrary.ExpandSnippet(snippet.Command, profile);
            session.Write(System.Text.Encoding.UTF8.GetBytes(command + (snippet.AutoEnter ? "\r" : "")));
            if (snippet.AutoEnter)
            {
                commandLibrary.AddHistory(sessionId, command);
                if (sessionWorkspaces.TryGetValue(sessionId, out var workspace)) workspace.FollowExecutedShellCommands(command);
                CommandViewModel.ReloadHistory();
            }
            ActivatePage("connections");
            terminal.Focus(FocusState.Programmatic);
            Status.Text = localization.Format("commandEditor.sent", ("count", "1"));
        }
        catch (Exception error) { ShowError(error); }
    }

    private async Task<string?> PromptTextAsync(string title, string initial = "", string? header = null)
    {
        var input = new TextBox { Header = header ?? title, Text = initial, AcceptsReturn = false };
        var dialog = new ContentDialog { Title = title, Content = input, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        return await dialog.ShowGatedAsync() == ContentDialogResult.Primary ? input.Text : null;
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
        if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary) CommandViewModel.DeleteSelectedGroup();
    }

    private async Task EditSnippetAsync(NativeSnippet? existing, bool duplicate)
    {
        var name = new TextBox { Header = localization["native.name"], Text = existing == null ? "" : existing.Name + (duplicate ? " (copy)" : "") };
        // WinUI truncates a multiline Text assignment while AcceptsReturn is false.
        var command = new TextBox { Header = localization["native.commands.command"], AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 160, Text = existing?.Command ?? "" };
        var autoEnter = new ToggleSwitch { Header = localization["native.commands.autoEnter"], IsOn = existing?.AutoEnter ?? NativeCommandLibrary.DefaultSnippetAutoEnter };
        var dialog = new ContentDialog { Title = existing == null || duplicate ? localization["native.commands.new"] : localization["native.common.edit"], Content = new StackPanel { Spacing = 8, Children = { name, command, autoEnter } }, PrimaryButtonText = localization["native.common.save"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        try { CommandViewModel.SaveSnippet(existing == null || duplicate ? null : existing.Id, name.Text, command.Text, autoEnter.IsOn); CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet; }
        catch (Exception error) { ShowError(error); }
    }

    private async void NewCommandSnippet(object sender, RoutedEventArgs args) => await EditSnippetAsync(null, false);
    private async void EditCommandSnippet(object sender, RoutedEventArgs args) => await EditSnippetAsync(CommandViewModel.SelectedSnippet, false);
    private async void DuplicateCommandSnippet(object sender, RoutedEventArgs args) => await EditSnippetAsync(CommandViewModel.SelectedSnippet, true);
    private async void DeleteCommandSnippet(object sender, RoutedEventArgs args)
    {
        var selected = CommandViewModel.SelectedSnippet; if (selected == null) return;
        var dialog = new ContentDialog { Title = localization["native.common.delete"], Content = selected.Name, PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        try { CommandViewModel.SelectedSnippet = selected; CommandViewModel.DeleteSelectedSnippet(); }
        catch (Exception error) { ShowError(error); }
    }

    private async void SendSelectedSnippet(object sender, RoutedEventArgs args)
    {
        var snippet = CommandViewModel.SelectedSnippet;
        if (snippet == null) return;
        await ShowCommandSendAsync(snippet.Command, snippet.AutoEnter);
    }

    private async void ComposeCommand(object sender, RoutedEventArgs args) => await ShowCommandSendAsync("", false);

    private async Task ShowCommandSendAsync(string initialCommand, bool appendEnter)
    {
        try
        {
            var ready = sessionsManager.List().Where(s => s.State == NativeSessionState.Ready && sessionTerminals.ContainsKey(s.SessionId)).ToArray();
            var targets = new ListView { SelectionMode = ListViewSelectionMode.Multiple, MaxHeight = 220 };
            foreach (var session in ready) targets.Items.Add(new ListViewItem { Content = session.ProfileName, Tag = session.SessionId });
            var activeId = (Sessions.SelectedItem as TabViewItem)?.Tag?.ToString();
            if (targets.Items.OfType<ListViewItem>().FirstOrDefault(i => i.Tag?.ToString() == activeId) is { } selected) targets.SelectedItems.Add(selected);
            var autoEnter = new ToggleSwitch { Header = localization["commandEditor.autoEnter"], IsOn = appendEnter };
            ToolTipService.SetToolTip(autoEnter, localization["commandEditor.autoEnterHint"]);
            var commandInput = new TextBox { PlaceholderText = localization["commandEditor.placeholder"], AcceptsReturn = true, MinHeight = 160, MaxHeight = 260, TextWrapping = TextWrapping.Wrap, Text = initialCommand };
            var expand = new CheckBox { Content = localization["commandEditor.expandVars"], IsChecked = true };
            ToolTipService.SetToolTip(expand, localization["commandEditor.expandVarsHint"] + " {{host}} {{user}} {{port}}");
            var dialog = new ContentDialog { Title = localization["commandEditor.title"], XamlRoot = Root.XamlRoot,
                Content = new ScrollViewer { MaxHeight = 540, Content = new StackPanel { Spacing = 12, Children = { commandInput, new TextBlock { Text = localization["commandEditor.sendTo"] }, targets, expand, autoEnter } } },
                PrimaryButtonText = localization["commandEditor.send"], SecondaryButtonText = localization["commandEditor.saveAsSnippet"], CloseButtonText = localization["common.cancel"] };
            bool ValidCommand() => !string.IsNullOrWhiteSpace(commandInput.Text) && !commandInput.Text.Contains('\0') && commandInput.Text.Length <= 32768;
            void UpdateSend()
            {
                dialog.IsPrimaryButtonEnabled = ValidCommand() && targets.SelectedItems.Count > 0;
                dialog.IsSecondaryButtonEnabled = ValidCommand();
            }
            commandInput.TextChanged += (_, _) => UpdateSend(); targets.SelectionChanged += (_, _) => UpdateSend(); UpdateSend();
            var keyboardSend = false;
            var sendShortcut = new KeyboardAccelerator { Key = Windows.System.VirtualKey.Enter, Modifiers = Windows.System.VirtualKeyModifiers.Control };
            sendShortcut.Invoked += (_, eventArgs) =>
            {
                eventArgs.Handled = true;
                if (!dialog.IsPrimaryButtonEnabled) return;
                keyboardSend = true; dialog.Hide();
            };
            commandInput.KeyboardAccelerators.Add(sendShortcut);
            var result = await dialog.ShowGatedAsync();
            if (result == ContentDialogResult.Secondary)
            {
                await SaveComposedSnippetAsync(commandInput.Text, autoEnter.IsOn);
                return;
            }
            if (result != ContentDialogResult.Primary && !keyboardSend) return;
            var sent = 0;
            foreach (var target in targets.SelectedItems.OfType<ListViewItem>())
            {
                var session = sessionsManager.Get((string)target.Tag);
                if (session.Snapshot.State != NativeSessionState.Ready) continue;
                var command = expand.IsChecked == true ? NativeCommandLibrary.ExpandSnippet(commandInput.Text, session.Profile) : commandInput.Text;
                session.Write(System.Text.Encoding.UTF8.GetBytes(command + (autoEnter.IsOn ? "\r" : "")));
                if (autoEnter.IsOn)
                {
                    commandLibrary.AddHistory(session.SessionId, command);
                    if (sessionWorkspaces.TryGetValue(session.SessionId, out var workspace)) workspace.FollowExecutedShellCommands(command);
                }
                sent++;
            }
            CommandViewModel.ReloadHistory();
            Status.Text = localization.Format("commandEditor.sent", ("count", sent.ToString()));
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void ClearCommandHistory(object sender, RoutedEventArgs args)
    {
        var dialog = new ContentDialog { Title = localization["native.commands.clearHistory"], Content = localization["native.commands.clearConfirm"], PrimaryButtonText = localization["native.common.delete"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary) CommandViewModel.ClearHistory();
    }

    private void AiProviderChanged(object sender, SelectionChangedEventArgs args)
    {
        aiViewModel.SelectedProvider = AiProviderChoice.SelectedItem as AiProviderProfile;
        UpdateAiProviderActions();
        UpdateAiAssistantControls();
    }

    private void AiResponseModeChanged(object sender, SelectionChangedEventArgs args)
    {
        if (AiResponseModeChoice.SelectedItem is ComboBoxItem item && item.Tag is string mode)
            aiViewModel.StreamResponses = mode == "stream";
    }

    private void UpdateAiProviderActions()
    {
        if (AiClearTokenButton == null || AiDeleteProviderButton == null) return;
        AiClearTokenButton.IsEnabled = aiViewModel.SelectedProvider?.HasToken == true;
        AiDeleteProviderButton.IsEnabled = aiViewModel.Providers.Count > 1 && aiViewModel.SelectedProvider != null;
    }

    private void UpdateAiAssistantControls()
    {
        if (AiSendButton == null || settings == null) return;
        var enabled = settings.Get("aiAssistantEnabled", false);
        // Electron only exposes the AI activity entry when the opt-in feature
        // switch is enabled. Keep configuration available from Settings, but
        // do not leave a dead conversation surface in the activity rail.
        AiItem.Visibility = enabled ? Visibility.Visible : Visibility.Collapsed;
        if (!enabled && activeOverlay == "ai")
        {
            activeOverlay = null;
            AiPage.Visibility = Visibility.Collapsed;
            UpdateActivityMarkers();
            ShowSelectedSessionContent();
        }
        AiSendButton.IsEnabled = enabled && !aiViewModel.IsRunning && aiViewModel.SelectedProvider != null
            && (!string.IsNullOrWhiteSpace(AiInput.Text) || selectedAiImagePath != null);
        AiImageButton.IsEnabled = enabled && !aiViewModel.IsRunning;
        AiCancelButton.IsEnabled = enabled && aiViewModel.IsRunning;
        AiInput.IsEnabled = enabled;
        AiTestButton.IsEnabled = enabled;
        AiDiscoverButton.IsEnabled = enabled;
        AiCapabilityButton.IsEnabled = enabled;
        AiResponseModeChoice.IsEnabled = enabled;
    }

    private void AiInputChanged(object sender, TextChangedEventArgs args) => UpdateAiAssistantControls();

    private void AiTargetChanged(object sender, SelectionChangedEventArgs args)
    {
        if (updatingAiTargets) return;
        aiViewModel.SelectedTerminalSessionId = (AiTargetChoice.SelectedItem as NativeAiTerminalTarget)?.SessionId;
        UpdateAiTargetWarning();
        RefreshAiMessageViews();
    }

    private void RefreshAiTargets()
    {
        if (AiTargetChoice == null) return;
        var ready = sessionsManager.List()
            .Where(snapshot => snapshot.State == NativeSessionState.Ready
                && sessionTerminals.ContainsKey(snapshot.SessionId)
                && sessionProfiles.TryGetValue(snapshot.SessionId, out var profile)
                && !string.Equals(profile.Data["protocol"]?.GetValue<string>(), "rdp", StringComparison.OrdinalIgnoreCase))
            .Select(snapshot => new NativeAiTerminalTarget(snapshot.SessionId,
                sessionProfiles.TryGetValue(snapshot.SessionId, out var profile) ? profile.Name : snapshot.ProfileName))
            .ToArray();
        updatingAiTargets = true;
        try
        {
            aiViewModel.RefreshTerminalTargets(ready);
            AiTargetChoice.SelectedItem = aiViewModel.TerminalTargets.FirstOrDefault(item => item.SessionId == aiViewModel.SelectedTerminalSessionId);
        }
        finally { updatingAiTargets = false; }
        UpdateAiTargetWarning();
        RefreshAiMessageViews();
    }

    private void UpdateAiTargetWarning()
    {
        if (AiTargetWarning == null) return;
        AiTargetWarning.Text = localization["aiCommands.terminalUnavailable"];
        AiTargetWarning.Visibility = aiViewModel.SelectedTerminalSessionId != null && !aiViewModel.SelectedTerminalAvailable
            ? Visibility.Visible : Visibility.Collapsed;
    }

    private string? AiInsertIssue(string value)
    {
        if (aiViewModel.IsRunning) return localization["aiCommands.waitForCompletion"];
        var id = aiViewModel.SelectedTerminalSessionId;
        if (id == null) return localization["aiCommands.selectSsh"];
        if (!aiViewModel.SelectedTerminalAvailable || !sessionTerminals.TryGetValue(id, out var terminal))
            return localization["aiCommands.terminalUnavailable"];
        return terminal.GetAiPasteIssue(value) switch
        {
            null => null,
            "tooLong" => localization["aiCommands.commandTooLong"],
            "controlCharacters" => localization["aiCommands.controlCharacters"],
            "empty" => localization["aiCommands.emptyCommand"],
            "multilineUnsupported" => localization["aiCommands.multilineUnsupported"],
            _ => localization["aiCommands.terminalUnavailable"]
        };
    }

    private void RefreshAiMessageViews()
    {
        if (AiMessages == null || localization == null) return;
        foreach (var view in aiMessageViews) view.Dispose();
        aiMessageViews.Clear();
        AiMessages.Items.Clear();
        foreach (var message in aiViewModel.Messages)
        {
            var view = new Controls.NativeAiMessageView(message, localization, AiInsertIssue);
            view.CopyRequested += CopyAiText;
            view.InsertRequested += InsertAiText;
            aiMessageViews.Add(view);
            AiMessages.Items.Add(view);
        }
        if (AiMessages.Items.Count > 0) AiMessages.ScrollIntoView(AiMessages.Items[^1]);
    }

    private void CopyAiText(object? sender, NativeAiActionEventArgs args)
    {
        try
        {
            var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
            package.SetText(args.Text);
            Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
            Status.Text = localization["aiCommands.copied"];
        }
        catch (Exception error) { ShowError(localization["aiCommands.copyFailed"] + " " + error.Message); }
    }

    private void InsertAiText(object? sender, NativeAiActionEventArgs args)
    {
        var id = aiViewModel.SelectedTerminalSessionId;
        if (id == null || !sessionTerminals.TryGetValue(id, out var terminal) || !aiViewModel.SelectedTerminalAvailable)
        {
            ShowError(localization["aiCommands.terminalUnavailable"]);
            return;
        }
        if (AiInsertIssue(args.Text) is { } issue)
        {
            ShowError(issue);
            return;
        }
        if (!terminal.TryPasteAiText(args.Text, out var problem))
        {
            ShowError(problem switch
            {
                "tooLong" => localization["aiCommands.commandTooLong"],
                "controlCharacters" => localization["aiCommands.controlCharacters"],
                "empty" => localization["aiCommands.emptyCommand"],
                "multilineUnsupported" => localization["aiCommands.multilineUnsupported"],
                _ => localization["aiCommands.terminalUnavailable"]
            });
            return;
        }
        if (sessionTabs.TryGetValue(id, out var tab)) Sessions.SelectedItem = tab;
        CloseOverlayCore();
        terminal.Focus(FocusState.Programmatic);
        Status.Text = localization["aiCommands.inserted"];
    }

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
            var token = aiService.GetToken(aiViewModel.SelectedProvider.Id);
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
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary || !Uri.TryCreate(url.Text.Trim(), UriKind.Absolute, out var baseUrl)) return;
        try
        {
            aiViewModel.Save(new AiProviderDraft(existing?.Id, name.Text, baseUrl, model.Text, enabled.IsOn, string.IsNullOrEmpty(token.Password) ? null : token.Password));
            AiProviderChoice.ItemsSource = aiViewModel.Providers;
            AiProviderChoice.SelectedItem = aiViewModel.SelectedProvider;
            UpdateAiProviderActions();
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void ClearAiProviderToken(object sender, RoutedEventArgs args)
    {
        var provider = aiViewModel.SelectedProvider;
        if (provider == null || !provider.HasToken) return;
        var dialog = new ContentDialog
        {
            Title = localization["native.ai.clearToken"],
            Content = localization["native.ai.clearTokenConfirm"],
            PrimaryButtonText = localization["native.ai.clearToken"],
            CloseButtonText = localization["native.common.cancel"],
            XamlRoot = Root.XamlRoot
        };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        try
        {
            aiViewModel.Save(new AiProviderDraft(provider.Id, provider.Name, provider.BaseUrl, provider.Model, provider.Enabled, null, true));
            AiProviderChoice.ItemsSource = aiViewModel.Providers;
            AiProviderChoice.SelectedItem = aiViewModel.SelectedProvider;
            UpdateAiProviderActions();
            Status.Text = localization["native.ai.tokenCleared"];
        }
        catch (Exception error) { ShowError(error); }
    }

    private async void DeleteAiProvider(object sender, RoutedEventArgs args)
    {
        var provider = aiViewModel.SelectedProvider;
        if (provider == null || aiViewModel.Providers.Count < 2) return;
        var dialog = new ContentDialog
        {
            Title = localization["native.ai.deleteProvider"],
            Content = localization.Format("native.ai.deleteProviderConfirm", ("name", provider.Name)),
            PrimaryButtonText = localization["native.common.delete"],
            CloseButtonText = localization["native.common.cancel"],
            XamlRoot = Root.XamlRoot
        };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        try
        {
            aiViewModel.DeleteSelectedProvider();
            AiProviderChoice.ItemsSource = aiViewModel.Providers;
            AiProviderChoice.SelectedItem = aiViewModel.SelectedProvider;
            UpdateAiProviderActions();
            Status.Text = localization["native.common.deleted"];
        }
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
        UpdateAiAssistantControls();
    }

    private async void TestAiCapability(object sender, RoutedEventArgs args)
    {
        try
        {
            var provider = aiViewModel.SelectedProvider ?? throw new InvalidOperationException("Select an AI provider first.");
            var token = aiService.GetToken(provider.Id);
            var result = await aiViewModel.TestImageCapabilityAsync(provider.BaseUrl, provider.Model, token);
            Status.Text = $"{provider.Model} · {result.Image} · {result.Outcome}";
        }
        catch (Exception error) { ShowError(error); }
    }

    private void CancelAiMessage(object sender, RoutedEventArgs args) => aiViewModel.Cancel();
    private void ClearAiConversation(object sender, RoutedEventArgs args) => aiViewModel.ClearConversation();

    private async void PauseTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("pause");
    private async void PauseAllTransfers(object sender, RoutedEventArgs args)
    {
        try { await transferViewModel.ControlAllAsync("pause"); }
        catch (Exception error) { ShowError(error); }
    }
    private async void CancelAllTransfers(object sender, RoutedEventArgs args)
    {
        var count = transferViewModel.UnfinishedCount;
        if (count == 0) return;
        var dialog = new ContentDialog
        {
            Title = localization["transfer.cancelAll"],
            Content = localization.Format("transfer.cancelAllConfirm", ("count", count.ToString())),
            PrimaryButtonText = localization["transfer.cancelAll"],
            CloseButtonText = localization["native.common.cancel"],
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Root.XamlRoot
        };
        try
        {
            if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
            await transferViewModel.ControlAllAsync("cancel");
        }
        catch (Exception error) { ShowError(error); }
    }
    private async void ResumeTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("resume");
    private async void RetryTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("retry");
    private async void CancelTransfer(object sender, RoutedEventArgs args) => await ControlSelectedTransferAsync("cancel");
    private void OpenTransferLocation(object sender, RoutedEventArgs args)
    {
        if (TransferList.SelectedItem is not NativeTransferTask task ||
            task.Direction != NativeTransferDirection.Download ||
            task.State != NativeTransferState.Completed) return;
        try
        {
            var path = Path.GetFullPath(task.Target);
            if (!File.Exists(path) && !Directory.Exists(path))
                throw new FileNotFoundException(localization["transfer.openFolderFailed"], path);
            var startInfo = Directory.Exists(path)
                ? new ProcessStartInfo("explorer.exe", $"\"{path}\"")
                : new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"");
            startInfo.UseShellExecute = true;
            Process.Start(startInfo);
        }
        catch (Exception error) { ShowError(error); }
    }
    private void TransferSelectionChanged(object sender, SelectionChangedEventArgs args) => UpdateTransferControls();
    private void UpdateTransferControls()
    {
        TransferSummary.Text = transferViewModel.SummaryText;
        var selected = TransferList.SelectedItem as NativeTransferTask;
        var unfinished = transferViewModel.Tasks.Any(task => !task.IsGroup && task.State is
            NativeTransferState.Queued or NativeTransferState.Running or NativeTransferState.Paused);
        var canOpen = selected is { Direction: NativeTransferDirection.Download, State: NativeTransferState.Completed } &&
            (File.Exists(selected.Target) || Directory.Exists(selected.Target));
        PauseAllTransfersButton.IsEnabled = unfinished;
        CancelAllTransfersButton.IsEnabled = unfinished || transferViewModel.Tasks.Any(task => !task.IsGroup && task.State == NativeTransferState.Paused);
        PauseTransferButton.IsEnabled = selected is { State: NativeTransferState.Queued or NativeTransferState.Running };
        ResumeTransferButton.IsEnabled = selected is { State: NativeTransferState.Paused };
        RetryTransferButton.IsEnabled = selected is { State: NativeTransferState.Failed or NativeTransferState.Paused or NativeTransferState.Canceled };
        CancelTransferButton.IsEnabled = selected is { State: NativeTransferState.Queued or NativeTransferState.Running or NativeTransferState.Paused };
        OpenTransferLocationButton.IsEnabled = canOpen;
        ClearTransferButton.IsEnabled = transferViewModel.Tasks.Any(task => task.State is
            NativeTransferState.Completed or NativeTransferState.Failed or NativeTransferState.Canceled or NativeTransferState.Skipped);
    }
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
            try { decision.TrySetResult(await dialog.ShowGatedAsync() == ContentDialogResult.Primary); }
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
                response.TrySetResult(await dialog.ShowGatedAsync() == ContentDialogResult.Primary
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
        try {
            if ((await file.GetBasicPropertiesAsync()).Size > ExportEnvelope.MaxBytes)
                throw new InvalidDataException("Import file exceeds the supported size limit.");
            var data = System.Text.Encoding.UTF8.GetBytes(await Windows.Storage.FileIO.ReadTextAsync(file));
            string? passphrase = null;
            if (ExportEnvelope.RequiresPassphrase(data))
            {
                passphrase = await PromptAsync(localization["native.common.passphrase"], false); if (passphrase == null) return;
            }
            var preview = ExportEnvelope.Inspect(data, passphrase);
            var choice = await ConfirmImportAsync(preview); if (choice == null) return;
            var result = store.Import(choice.Value.Preview, choice.Value.Conflict);
            RefreshAfterPortableImport();
            Status.Text = FormatPortableImportResult(result);
        } catch (Exception error) { ShowError(error); }
    }

    private async Task<(ImportPreview Preview, ImportConflict Conflict)?> ConfirmImportAsync(ImportPreview preview)
    {
        static int Count(JsonObject data, string key) => (data[key] as System.Text.Json.Nodes.JsonArray)?.Count ?? 0;
        var summary = localization.Format("native.importSummary", ("profiles", preview.Profiles.ToString()), ("secrets", preview.SecretCount.ToString())) + "\n" +
            localization.Format("native.migrationCategories", ("groups", Count(preview.Data, "groups").ToString()), ("keys", Count(preview.Data, "privateKeys").ToString()),
                ("proxies", Count(preview.Data, "proxies").ToString()), ("knownHosts", Count(preview.Data, "knownHosts").ToString()),
                ("forwards", Count(preview.Data, "forwards").ToString()), ("aiProfiles", Count(preview.Data, "aiProfiles").ToString()));
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(new TextBlock { Text = summary, TextWrapping = TextWrapping.Wrap });
        var selected = new Dictionary<string, CheckBox>();
        foreach (var (kind, key) in new[] { ("profiles", "activity.connections"), ("snippets", "native.workbench.commands"), ("forwards", "activity.forwards"), ("knownHosts", "native.knownHosts.manage"), ("settings", "activity.settings"), ("aiProfiles", "native.ai.title") })
        {
            var box = new CheckBox { Content = localization[key], IsChecked = NativeImportSelection.DefaultCategories.Contains(kind) }; selected[kind] = box; panel.Children.Add(box);
        }
        var policy = new ComboBox { ItemsSource = new[] { localization["native.common.skip"], localization["native.common.overwrite"], localization["native.common.duplicate"] }, SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        panel.Children.Add(policy);
        var dialog = new ContentDialog { Title = localization["native.common.import"], Content = new ScrollViewer { Content = panel, MaxHeight = 520 },
            PrimaryButtonText = localization["native.common.import"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return null;
        var categories = selected.Where(pair => pair.Value.IsChecked == true).Select(pair => pair.Key).ToHashSet(StringComparer.Ordinal);
        if (categories.Contains("profiles")) categories.UnionWith(new[] { "groups", "proxies", "privateKeys" });
        if (categories.Contains("snippets")) categories.Add("snippetGroups");
        var filtered = NativeImportSelection.Select(preview, categories, store);
        return (filtered, policy.SelectedIndex switch { 1 => ImportConflict.Overwrite, 2 => ImportConflict.Duplicate, _ => ImportConflict.Skip });
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
        try { await CloseSessionTabAsync(args.Tab); }
        catch (Exception error) { ShowError(error); }
    }
    private bool sessionCloseBusy;
    private async Task CloseSessionTabAsync(TabViewItem tab)
    {
        if (sessionCloseBusy || !Sessions.TabItems.Contains(tab)) return;
        sessionCloseBusy = true;
        try { await CloseSessionTabCoreAsync(tab); }
        finally { sessionCloseBusy = false; }
    }
    private async Task CloseSessionTabCoreAsync(TabViewItem tab)
    {
        var rawTag = tab.Tag?.ToString() ?? string.Empty;
        if (!await ConfirmSessionCloseAsync(rawTag, tab.Header?.ToString() ?? "")) return;
        sessionContents.TryGetValue(rawTag, out var content);
        if (content is Controls.NativeSessionWorkspace workspace)
        {
            if (!await workspace.ConfirmCloseAsync()) return;
            workspace.Dispose(); sessionWorkspaces.Remove(rawTag);
        }
        if (content is Controls.NativeRemoteEditor editor && !await editor.ConfirmCloseAsync()) return;
        if (content is Controls.NativeRemoteEditor remoteEditor) remoteEditor.Dispose();
        if (content is Controls.NativeMonitorPanel monitor) monitor.Dispose();
        if (content is Controls.NativePortTrafficPanel traffic) traffic.Dispose();
        if (content is Controls.NativeSftpBrowser files) files.Dispose();
        foreach (var task in transferQueue.List().Where(t => t.SessionId == rawTag && t.ParentId == null && t.State is NativeTransferState.Queued or NativeTransferState.Running or NativeTransferState.Paused).ToArray())
            await transferQueue.ControlAsync(task.Id, "cancel");
        RemoveSessionTab(tab);
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
        if (!string.IsNullOrWhiteSpace(sessionId) && !Sessions.TabItems.OfType<TabViewItem>().Any(item =>
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
    private void ThemeChanged(object sender, SelectionChangedEventArgs args) { if (!loadingSettings && ThemeChoice.SelectedItem is ComboBoxItem { Tag: string value }) { settings = (settings with { ThemeMode = value }).Save(store); ApplyAppearance(); Status.Text = localization.Format("native.themeStatus", ("value", value)); } }
    private void LanguageChanged(object sender, SelectionChangedEventArgs args) { if (!loadingSettings && LanguageChoice.SelectedItem is string tag) { settings = (settings with { Language = tag }).Save(store); localization.SetLanguage(tag); ConfigureLabels(); ConfigureSettings(); LoadProfiles(); } }
    private void TransparencyChanged(object sender, RoutedEventArgs args) { if (!loadingSettings) { settings = (settings with { ReduceTransparency = TransparencyChoice.IsOn }).Save(store); ApplyAppearance(); Status.Text = localization["native.settings.transparency"]; } }
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
        var result = await dialog.ShowGatedAsync();
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
                if (await editor.ShowGatedAsync() == ContentDialogResult.Primary)
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
        var result = await dialog.ShowGatedAsync();
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
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        var passwordRef = string.IsNullOrEmpty(password.Password) ? null : store.SaveSecret(password.Password);
        savedProxies.Save(existing?.Id ?? Guid.NewGuid().ToString("N"), name.Text, type.SelectedItem?.ToString() ?? "socks5", host.Text, (int)port.Value, username.Text, passwordRef, existing?.Revision);
        loadingSettings = true;
        try { ConfigureDefaultProxy(); } finally { loadingSettings = false; }
    }

    private async void ManageKnownHosts(object sender, RoutedEventArgs args)
    {
        knownHosts.Reload();
        var list = new ListView { ItemsSource = knownHosts.Items, SelectionMode = ListViewSelectionMode.Single, MinWidth = 500, MinHeight = 240 };
        list.ItemTemplate = (Microsoft.UI.Xaml.DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><StackPanel><TextBlock Text=\"{Binding Host}\"/><TextBlock Text=\"{Binding Fingerprint}\" FontSize=12/></StackPanel></DataTemplate>");
        var dialog = new ContentDialog { Title = localization["native.knownHosts.manage"], Content = list, PrimaryButtonText = localization["native.knownHosts.revoke"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot };
        if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary && list.SelectedItem is KnownHostItem selected)
        {
            try { knownHosts.Selected = selected; knownHosts.RevokeSelected(); }
            catch (Exception error) { ShowError(error); }
        }
    }

    private async void OnRootLoaded(object sender, RoutedEventArgs args)
    {
        if (initialUpdateCheckStarted) return;
        initialUpdateCheckStarted = true;
        RestoreWindowBounds();
        await ShowStartupNoticeAsync();
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
        if (automatic && Environment.GetEnvironmentVariable("OFS_NATIVE_TEST_MODE") == "1") return;
        if (automatic && settings.Data["autoCheckUpdate"]?.GetValue<bool>() == false) return;
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
        RefreshAboutUpdateStatus();
        CheckUpdatesButton.IsEnabled = !updateCheckRunning && state.Status is not (NativeUpdateStatus.Checking or NativeUpdateStatus.Downloading);
        DownloadUpdateButton.IsEnabled = !updateCheckRunning && updateService.Available != null && updateService.DownloadedArtifact == null;
        InstallUpdateButton.IsEnabled = !updateCheckRunning && updateService.DownloadedArtifact is { } artifact && File.Exists(artifact.Path);
        var notes = updateService.Available?.NotesUri;
        UpdateReleaseNotesButton.Visibility = notes == null ? Visibility.Collapsed : Visibility.Visible;
        UpdateReleaseNotesButton.NavigateUri = notes;
    }

    private async void InstallUpdate(object sender, RoutedEventArgs args)
    {
        if (updateCheckRunning || closeDialogOpen || updateService.DownloadedArtifact is not { } artifact) return;
        updateCheckRunning = true;
        closeDialogOpen = true;
        try
        {
            var activity = CurrentUpdateActivity(updateCoordinator.Activity());
            var message = localization.Format("native.update.installConfirm", ("version", artifact.Version));
            if (activity.HasActivity)
                message += "\n\n" + localization.Format("native.workbench.exitActivity",
                    ("sessions", (activity.Sessions + activity.RdpSessions).ToString()), ("transfers", activity.Transfers.ToString()),
                    ("forwards", activity.Forwards.ToString()), ("editors", activity.Editors.ToString()));
            var dialog = new ContentDialog
            {
                Title = localization["native.update.title"], Content = message,
                PrimaryButtonText = localization["native.update.install"], CloseButtonText = localization["native.common.cancel"], XamlRoot = Root.XamlRoot
            };
            if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
            if (!await editorWindowHost.ConfirmCloseAllAsync()) return;
            foreach (var workspace in sessionWorkspaces.Values.ToArray()) if (!await workspace.ConfirmCloseAsync()) return;
            foreach (var editor in sessionContents.Values.OfType<Controls.NativeRemoteEditor>().ToArray()) if (!await editor.ConfirmCloseAsync()) return;
            // Keep the workbench stable while UAC/verification is pending. A
            // canceled elevation leaves all sessions and documents intact.
            EnableWindowForUpdate(WindowHandle(), false);
            editorWindowHost.SetUpdateBusy(true);
            await updateService.InstallAsync(userConfirmed: true);
            editorWindowHost.CloseAfterConfirmation();
            foreach (var rdp in rdpSessions.Values.ToArray()) await rdp.DisposeAsync();
            rdpSessions.Clear();
            confirmedWindowClose = true;
            Close();
            Application.Current.Exit();
        }
        catch (Exception error) { ShowError(localization.Format("native.update.failed", ("detail", error.Message))); }
        finally
        {
            if (!confirmedWindowClose) { EnableWindowForUpdate(WindowHandle(), true); editorWindowHost.SetUpdateBusy(false); }
            closeDialogOpen = false;
            updateCheckRunning = false;
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "EnableWindow")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool EnableWindowForUpdate(nint window, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool enable);

    private NativeUpdateActivity CurrentUpdateActivity(NativeUpdateActivity activity) => activity with
    {
        Editors = sessionContents.Values.OfType<Controls.NativeRemoteEditor>().Count(editor => editor.HasUnsavedChanges)
            + sessionWorkspaces.Values.Sum(workspace => workspace.Editors.Count(editor => editor.HasUnsavedChanges))
            + editorWindowHost.DirtyCount,
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
        if (accessibilitySubscribed && accessibilitySettings is { } accessibility)
            NativeAccessibilityGuard.TryUnregister(() => accessibility.HighContrastChanged -= AccessibilitySettings_HighContrastChanged);
        accessibilitySubscribed = false;
        editorWindowHost.Dispose();
        windowBoundsSaveTimer?.Stop();
        SaveWindowBounds();
        AppWindow.Changed -= OnAppWindowChanged;
        updateTimer?.Stop();
        transferSummaryTimer?.Stop();
        updateCancellation.Cancel();
        updateService.StateChanged -= OnUpdateStateChanged;
        updateService.Dispose();
        updateCancellation.Dispose();
        foreach (var content in sessionContents.Values)
        {
            if (content is Controls.NativeRemoteEditor editor) editor.Dispose();
            if (content is Controls.NativeMonitorPanel monitor) monitor.Dispose();
            if (content is Controls.NativePortTrafficPanel traffic) traffic.Dispose();
            if (content is Controls.NativeSftpBrowser files) files.Dispose();
        }
        foreach (var workspace in sessionWorkspaces.Values) workspace.Dispose();
        sessionWorkspaces.Clear(); sessionContents.Clear(); sessionProfiles.Clear();
        foreach (var terminal in sessionTerminals.Values) terminal.Dispose();
        sessionOutputSinks.Clear(); sessionTerminals.Clear();
        aiViewModel.Dispose(); lanSyncViewModel.Dispose(); lanSyncService.Dispose(); forwardViewModel.Dispose(); forwardManager.Dispose(); transferViewModel.Dispose(); transferQueue.Dispose(); sessionsManager.Dispose(); store.Dispose();
        foreach (var rdp in rdpSessions.Values) _ = rdp.DisposeAsync();
        rdpSessions.Clear();
        foreach (var surface in rdpSurfaces.Values) surface.Dispose();
        rdpSurfaces.Clear();
    }

    private void AccessibilitySettings_HighContrastChanged(Windows.UI.ViewManagement.AccessibilitySettings sender, object args)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            ApplyShellPalette();
            ApplyNativeEditorTheme();
        });
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
