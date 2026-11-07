using Microsoft.UI.Xaml;
using OpenFinalShell.Core;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace OpenFinalShell.App;

public partial class App : Application
{
    private MainWindow? window;
    private readonly PlatformEnvironment environment;
    private readonly NativeInstanceCoordinator coordinator;
    public App()
    {
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
        }
        catch (Exception error) { WriteStartupError(error); throw; }
    }
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            if (coordinator.Start() == NativeInstanceRole.Secondary)
            {
                coordinator.RequestFocusAsync().GetAwaiter().GetResult();
                Environment.Exit(0);
                return;
            }
            // Theme dictionaries are loaded after the application resource root
            // is ready. The shell uses explicit fallback colors during markup
            // construction, so a missing material resource cannot block startup.
            LoadPlatformTheme();
            window = new MainWindow(environment, coordinator);
            coordinator.FocusRequested += () => window.DispatcherQueue.TryEnqueue(() => window.Activate());
            coordinator.ConfigurationChanged += change => window.DispatcherQueue.TryEnqueue(() => window.ApplyExternalConfiguration(change));
            window.Closed += (_, _) => coordinator.Dispose();
            window.Activate();
        }
        catch (Exception error)
        {
            WriteStartupError(error);
            throw;
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
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
