namespace OpenFinalShell.Core;

public enum NativeWorkbenchAction { DuplicateSession, CloseSession, NextSession, PreviousSession, SelectSession }

public readonly record struct NativeWorkbenchShortcut(NativeWorkbenchAction Action, int Index = -1)
{
    // Key values are Windows virtual-key codes, kept independent of WinUI so
    // the same arbitration serves the XAML tree and the native editor HWND.
    public static NativeWorkbenchShortcut? Resolve(int key, bool control, bool shift, bool alt, bool textEntry, bool composing, bool modal)
    {
        if (composing || modal || key == 229) return null;
        if (control && !alt && key == 9) return new(shift ? NativeWorkbenchAction.PreviousSession : NativeWorkbenchAction.NextSession);
        if (control && !alt && shift && key == 0x54) return new(NativeWorkbenchAction.DuplicateSession);
        if (control && !alt && !shift && key == 0x57 && !textEntry) return new(NativeWorkbenchAction.CloseSession);
        if (alt && !control && !shift && key is >= 0x31 and <= 0x39) return new(NativeWorkbenchAction.SelectSession, key - 0x31);
        return null;
    }
}
