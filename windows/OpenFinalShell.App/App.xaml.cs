using Microsoft.UI.Xaml;
using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public partial class App : Application
{
    private MainWindow? window;
    private readonly PlatformEnvironment environment;
    private readonly NativeInstanceCoordinator coordinator;
    public App()
    {
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
            var theme = environment.Profile == "windows-11" ? "Windows11" : "Windows10";
            Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri($"ms-appx:///Themes/{theme}.xaml") });
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
    private static void WriteStartupError(Exception error)
    {
        var path = Path.Combine(NativeStore.DefaultDirectory, "startup-error.log");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(path, $"{DateTimeOffset.UtcNow:O}\n{error}\n");
    }
}
