using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private bool confirmedWindowClose, closeDialogOpen;
    private async void MainWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        App.TraceStartup($"MainWindow closing requested confirmed={confirmedWindowClose} dialog={closeDialogOpen}");
        if (confirmedWindowClose) return;
        args.Cancel = true;
        if (closeDialogOpen) return;
        var activity = CurrentUpdateActivity(updateCoordinator.Activity());
        closeDialogOpen = true;
        try
        {
            if (activity.HasActivity)
            {
                var dialog = new ContentDialog { Title = localization["native.workbench.exitTitle"],
                    Content = localization.Format("native.workbench.exitActivity", ("sessions", (activity.Sessions + activity.RdpSessions).ToString()), ("transfers", activity.Transfers.ToString()), ("forwards", activity.Forwards.ToString()), ("editors", activity.Editors.ToString())),
                    PrimaryButtonText = localization["common.close"], CloseButtonText = localization["common.cancel"], XamlRoot = Root.XamlRoot };
                if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
            }
            if (!await editorWindowHost.ConfirmCloseAllAsync()) return;
            foreach (var workspace in sessionWorkspaces.Values.ToArray()) if (!await workspace.ConfirmCloseAsync()) return;
            foreach (var editor in sessionContents.Values.OfType<Controls.NativeRemoteEditor>().ToArray()) if (!await editor.ConfirmCloseAsync()) return;
            editorWindowHost.CloseAfterConfirmation();
            await ShutdownAsync();
            confirmedWindowClose = true;
            Close();
        }
        catch (Exception error) { ShowError(error); }
        finally { if (!confirmedWindowClose) closeDialogOpen = false; }
    }
    private async Task<bool> ConfirmSessionCloseAsync(string id, string title)
    {
        var transfers = transferQueue.List().Count(t => t.SessionId == id && !t.IsGroup && t.State is NativeTransferState.Running or NativeTransferState.Queued or NativeTransferState.Paused);
        var alive = sessionsManager.List().Any(s => s.SessionId == id && s.State is NativeSessionState.Ready or NativeSessionState.Reconnecting or NativeSessionState.Connecting) || rdpSessions.ContainsKey(id);
        if (transfers == 0 && (!alive || !settings.Get("confirmOnCloseTab", true))) return true;
        var dialog = new ContentDialog { Title = localization.Format("tab.closeConfirm", ("title", title)),
            Content = transfers > 0 ? localization.Format("native.workbench.transferClose", ("count", transfers.ToString())) : title,
            PrimaryButtonText = localization["common.close"], CloseButtonText = localization["common.cancel"], XamlRoot = Root.XamlRoot };
        return await dialog.ShowGatedAsync() == ContentDialogResult.Primary;
    }
}
