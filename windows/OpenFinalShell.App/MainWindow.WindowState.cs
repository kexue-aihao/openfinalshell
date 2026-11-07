using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Dispatching;
using OpenFinalShell.Core;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Windows.Graphics;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private DispatcherQueueTimer? windowBoundsSaveTimer;

    private void RestoreWindowBounds()
    {
        var bounds = NativeWindowBounds.Read(store.Find("nativeWorkspace", "nativeWorkspace"));
        if (bounds == null) return;

        try
        {
            AppWindow.Resize(new SizeInt32(bounds.Width, bounds.Height));
            if (bounds.Maximized && AppWindow.Presenter is OverlappedPresenter presenter)
                presenter.Maximize();
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Could not restore native window bounds: {error.Message}");
        }
    }

    private void OnAppWindowChanged(AppWindow sender, AppWindowChangedEventArgs args)
    {
        if (!args.DidSizeChange && !args.DidPresenterChange) return;
        if (windowBoundsSaveTimer == null)
        {
            windowBoundsSaveTimer = DispatcherQueue.CreateTimer();
            windowBoundsSaveTimer.Interval = TimeSpan.FromMilliseconds(400);
            windowBoundsSaveTimer.IsRepeating = false;
            windowBoundsSaveTimer.Tick += (_, _) => SaveWindowBounds();
        }
        windowBoundsSaveTimer.Stop();
        windowBoundsSaveTimer.Start();
    }

    private void SaveWindowBounds()
    {
        if (AppWindow.Presenter is not OverlappedPresenter presenter) return;
        var patch = new JsonObject();
        if (presenter.State == OverlappedPresenterState.Maximized)
            patch["windowMaximized"] = true;
        if (presenter.State == OverlappedPresenterState.Restored)
        {
            patch["windowMaximized"] = false;
            var size = AppWindow.Size;
            if (size.Width >= NativeWindowBounds.MinimumWidth && size.Height >= NativeWindowBounds.MinimumHeight)
            {
                patch["windowWidth"] = size.Width;
                patch["windowHeight"] = size.Height;
            }
        }
        if (patch.Count == 0) return;
        try { store.Patch("nativeWorkspace", "nativeWorkspace", patch); }
        catch (Exception error) { Debug.WriteLine($"Could not save native window bounds: {error.Message}"); }
    }
}
