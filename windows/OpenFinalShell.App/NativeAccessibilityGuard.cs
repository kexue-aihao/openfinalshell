using System.Runtime.InteropServices;

namespace OpenFinalShell.App;

/// <summary>Accessibility APIs are optional: failures must not prevent the shell from opening.</summary>
internal static class NativeAccessibilityGuard
{
    public static bool ReadHighContrast(Func<bool> read)
    {
        try { return read(); }
        catch (COMException) { return false; }
    }

    public static bool TryRegister(Action register)
    {
        try { register(); return true; }
        catch (COMException) { return false; }
    }

    public static void TryUnregister(Action unregister)
    {
        try { unregister(); }
        catch (COMException) { }
    }
}
