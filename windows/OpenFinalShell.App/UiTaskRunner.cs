using System.Diagnostics;

namespace OpenFinalShell.App;

/// <summary>Keeps framework event handlers from turning asynchronous failures into process exits.</summary>
internal static class UiTaskRunner
{
    public static async void Run(Func<Task> operation, Action<Exception>? report = null)
    {
        try
        {
            await operation();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Guarded UI operation failed: {error}");
            try { report?.Invoke(error); } catch { }
        }
    }
}
