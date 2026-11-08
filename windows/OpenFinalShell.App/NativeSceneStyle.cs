using Microsoft.UI.Xaml;

namespace OpenFinalShell.App;

internal static class NativeSceneStyle
{
    public static CornerRadius CornerRadius(string resourceKey, double fallback = 0)
    {
        try
        {
            if (Application.Current?.Resources[resourceKey] is CornerRadius radius) return radius;
        }
        catch (KeyNotFoundException)
        {
            // Keep custom surfaces safe if an optional platform dictionary is absent.
        }

        return new CornerRadius(fallback);
    }
}
