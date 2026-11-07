using Microsoft.UI.Xaml.Controls;

namespace OpenFinalShell.App;

/// <summary>
/// WinUI permits only one ContentDialog per XamlRoot. Native session,
/// transfer and editor callbacks can request prompts concurrently, so all
/// dialogs use this gate before calling ShowAsync.
/// </summary>
internal static class NativeDialogGate
{
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static async Task<ContentDialogResult> ShowGatedAsync(this ContentDialog dialog)
    {
        ArgumentNullException.ThrowIfNull(dialog);
        await Gate.WaitAsync().ConfigureAwait(true);
        try
        {
            return await dialog.ShowAsync();
        }
        finally
        {
            Gate.Release();
        }
    }
}
