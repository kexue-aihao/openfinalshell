using Microsoft.UI.Xaml;
using OpenFinalShell.Core;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace OpenFinalShell.App;

public partial class App : Application
{
    private MainWindow? window;
    private NativeStoreRecoveryWindow? recoveryWindow;
    private TerminalLayoutFixtureWindow? terminalFixtureWindow;
    private StartupWindow? startupWindow;
    private readonly PlatformEnvironment environment;
    private readonly NativeInstanceCoordinator coordinator;
    public App()
    {
        TraceStartup("App constructor entered");
        if (Environment.GetEnvironmentVariable("OFS_NATIVE_TEST_MODE") == "1")
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(NativeStore.DefaultDirectory)))[..12];
            SetCurrentProcessExplicitAppUserModelID("OpenFinalShell.NativeTest." + hash);
        }
        UnhandledException += (_, args) => WriteStartupError(args.Exception);
        try
        {
            InitializeComponent();
            environment = PlatformEnvironment.Detect();
            coordinator = new NativeInstanceCoordinator(NativeStore.DefaultDirectory);
            TraceStartup("App services constructed");
        }
        catch (Exception error) { WriteStartupError(error); throw; }
    }
    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        TraceStartup("OnLaunched entered");
        try
        {
            if (Environment.GetEnvironmentVariable("OFS_NATIVE_TERMINAL_LAYOUT_FIXTURE") == "1")
            {
                LoadPlatformTheme();
                terminalFixtureWindow = new TerminalLayoutFixtureWindow();
                terminalFixtureWindow.Activate();
                return;
            }
            if (coordinator.Start() == NativeInstanceRole.Secondary)
            {
                TraceStartup("Secondary instance requested primary focus");
                await coordinator.RequestFocusAsync();
                await coordinator.DisposeAsync();
                Exit();
                return;
            }
            // Theme dictionaries are loaded after the application resource root
            // is ready. The shell uses explicit fallback colors during markup
            // construction, so a missing material resource cannot block startup.
            LoadPlatformTheme();
            TraceStartup("Platform theme loaded");
            startupWindow = new StartupWindow(NativeSettings.DefaultLanguage);
            startupWindow.Activate();
            // Let the shell paint before the integrity check and encrypted-record
            // validation run on a worker thread.
            await Task.Yield();
            var validation = await Task.Run(() =>
                NativeStoreRecovery.ValidateDirectory(NativeStore.DefaultDirectory, new DpapiProtector()));
            TraceStartup($"Store validation completed valid={validation.IsValid}");
            if (!validation.IsValid)
            {
                await ShowRecoveryWindowAsync(validation);
                return;
            }
            LaunchMainWindow();
            startupWindow?.Close();
            startupWindow = null;
            TraceStartup("Main window launched");
        }
        catch (Exception error)
        {
            TraceStartup($"Startup failed: {error}");
            WriteStartupError(error);
            startupWindow?.Close();
            startupWindow = null;
            throw;
        }
    }

    private void LaunchMainWindow()
    {
        window = new MainWindow(environment, coordinator);
        var mainWindow = window;
        coordinator.FocusRequested += () => mainWindow.DispatcherQueue.TryEnqueue(() => mainWindow.Activate());
        coordinator.ConfigurationChanged += change => mainWindow.DispatcherQueue.TryEnqueue(() => mainWindow.ApplyExternalConfiguration(change));
        mainWindow.Activate();
    }

    private async Task ShowRecoveryWindowAsync(NativeStoreValidation validation)
    {
        var localization = new Localization();
        startupWindow ??= new StartupWindow(NativeSettings.DefaultLanguage);
        startupWindow.SetStatus(localization["native.recovery.title"]);
        startupWindow.Activate();
        await Task.Yield();
        var snapshots = await Task.Run(() =>
            NativeStoreRecovery.FindValidSnapshots(NativeStore.DefaultDirectory, new DpapiProtector()));
        var recovery = new NativeStoreRecoveryWindow(localization, validation, snapshots);
        recoveryWindow = recovery;
        var transitioning = false;
        Action focusRecovery = () => recovery.DispatcherQueue.TryEnqueue(() => recovery.Activate());
        coordinator.FocusRequested += focusRecovery;
        recovery.Closed += (_, _) =>
        {
            coordinator.FocusRequested -= focusRecovery;
            recoveryWindow = null;
            if (!transitioning) UiTaskRunner.Run(() => coordinator.DisposeAsync().AsTask());
        };
        recovery.RestoreRequested += path => UiTaskRunner.Run(async () =>
        {
            await CompleteRecoveryAsync(recovery, () => transitioning = true,
                () => NativeStoreRecovery.RestoreSnapshot(NativeStore.DefaultDirectory, path, new DpapiProtector()), startingFresh: false);
        }, error => recovery.ShowFailure(false));
        recovery.StartFreshRequested += () => UiTaskRunner.Run(async () =>
        {
            await CompleteRecoveryAsync(recovery, () => transitioning = true,
                () => NativeStoreRecovery.StartFreshProfile(NativeStore.DefaultDirectory, new DpapiProtector()), startingFresh: true);
        }, error => recovery.ShowFailure(true));
        recovery.ExitRequested += () =>
        {
            recovery.Close();
            Exit();
        };
        recovery.Activate();
        startupWindow.Close();
        startupWindow = null;

        async Task CompleteRecoveryAsync(NativeStoreRecoveryWindow owner, Action transitioning,
            Func<string?> operation, bool startingFresh)
        {
            try
            {
                await Task.Run(operation);
                transitioning();
                owner.Close();
                LaunchMainWindow();
            }
            catch
            {
                owner.ShowFailure(startingFresh);
            }
        }
    }

    private void LoadPlatformTheme()
    {
        var preferred = environment.Profile == "windows-11" ? "Windows11" : "Windows10";
        try
        {
            Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri($"ms-appx:///Themes/{preferred}.xaml") });
        }
        catch (COMException)
        {
            // Older unpackaged/publish layouts may omit the optional theme
            // dictionary.  Keep the WinUI controls usable with App.xaml's
            // fallback brushes instead of failing before MainWindow exists.
            try
            {
                Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("ms-appx:///Themes/Windows10.xaml") });
            }
            catch (COMException)
            {
                // The control resource dictionary is still loaded by App.xaml;
                // cosmetic theme resources are optional at startup.
            }
        }
    }
    private static void WriteStartupError(Exception error)
    {
        var path = Path.Combine(NativeStore.DefaultDirectory, "startup-error.log");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(path, $"{DateTimeOffset.UtcNow:O}\n{error}\n");
    }

    internal static void TraceStartup(string message)
    {
        if (Environment.GetEnvironmentVariable("OFS_NATIVE_DIAGNOSTICS") != "1") return;
        try
        {
            var directory = NativeStore.DefaultDirectory;
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "startup-trace.log"),
                $"{DateTimeOffset.UtcNow:O} {message}\n");
        }
        catch
        {
        }
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
