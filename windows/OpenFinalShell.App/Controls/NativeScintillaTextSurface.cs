using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Automation.Peers;
using OpenFinalShell.Core;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Foundation;

namespace OpenFinalShell.App.Controls;

/// <summary>
/// Hosts the x64 Scintilla HWND in the editor's WinUI layout slot. Scintilla
/// owns the document, undo stack, selection, IME and native editing behavior;
/// the HWND is positioned over this transparent XAML surface after layout.
/// </summary>
public sealed partial class NativeScintillaTextSurface : UserControl, IDisposable
{
    private const uint WsPopup = 0x80000000;
    private const uint WsTabStop = 0x00010000;
    private const uint WsClipSiblings = 0x04000000;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private const int SciGetLength = 2006;
    private const int SciStyleClearAll = 2050;
    private const int SciStyleSetFore = 2051;
    private const int SciStyleSetBack = 2052;
    private const int SciStyleSetSize = 2055;
    private const int SciStyleSetFont = 2056;
    private const int SciSetCodePage = 2037;
    private const int SciSetTabWidth = 2036;
    private const int SciSetMarginTypeN = 2240;
    private const int SciSetMarginWidthN = 2242;
    private const int SciSetCaretLineVisible = 2096;
    private const int SciSetCaretLineBack = 2098;
    private const int SciSetIndent = 2122;
    private const int SciSetUseTabs = 2124;
    private const int SciSetIndentationGuides = 2132;
    private const int SciGetModify = 2159;
    private const int SciSetReadOnly = 2171;
    private const int SciSetText = 2181;
    private const int SciGetText = 2182;
    private const int SciGetTextRangeFull = 2039;
    private const int SciClearAll = 2004;
    private const int SciSetUndoCollection = 2012;
    private const int SciAppendText = 2282;
    private const int SciSetSavePoint = 2014;
    private const int SciEmptyUndoBuffer = 2175;
    private const int SciSetWrapMode = 2268;
    private const int SciSetILexer = 4033;
    private const int SciSearchNext = 2367;
    private const int SciSearchPrevious = 2368;
    private const int SciSetSearchFlags = 2198;
    private const int SciZoomIn = 2333;
    private const int SciZoomOut = 2334;
    private const int ScMarginNumber = 1;
    private const int StyleLineNumber = 33;
    private const int StyleDefault = 32;
    private const uint LoadLibrarySearchDllLoadDir = 0x00000100;
    private const uint LoadLibrarySearchDefaultDirs = 0x00001000;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate nint CreateLexerDelegate([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint SubclassProcedure(nint hwnd, uint message, nuint wParam, nint lParam, nuint subclassId, nuint referenceData);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeTextRangeFull
    {
        public nint Start;
        public nint End;
        public nint Text;
    }

    private static readonly object LibraryGate = new();
    private static nint scintillaModule;
    private static nint lexillaModule;
    private static CreateLexerDelegate? createLexer;

    private readonly FrameworkElement coordinateRoot;
    private readonly nint ownerWindow;
    private readonly DispatcherQueueTimer pollTimer;
    private readonly SubclassProcedure subclassProcedure;
    private nint editorWindow;
    private nint editorParent;
    private bool disposed;
    private bool lastModified;
    private string pendingText = string.Empty;
    private string pendingPath = string.Empty;
    private bool readOnly;
    private (int X, int Y, int Width, int Height)? lastBounds;
    private bool editorVisible;
    private int layoutUpdateScheduled;

    public event Action? DocumentChanged;
    public event Action? SaveRequested;
    public event Action? SearchRequested;
    public event Action<Exception>? InitializationFailed;

    public string Text
    {
        get => editorWindow == 0 ? pendingText : ReadText();
        set
        {
            pendingText = value ?? string.Empty;
            if (editorWindow == 0) return;
            WriteText(pendingText);
        }
    }

    public async Task<string> ReadTextAsync()
    {
        if (editorWindow == 0) return pendingText;
        var length = Math.Max(0, checked((int)Send(SciGetLength)));
        if (length == 0) return string.Empty;

        // Scintilla belongs to the UI thread. Read bounded ranges and yield
        // between them so large documents do not monopolize the message loop.
        const int chunkSize = 256 * 1024;
        using var buffer = new MemoryStream(length);
        var rangePointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeTextRangeFull>());
        var textPointer = Marshal.AllocHGlobal(chunkSize + 1);
        try
        {
            for (var start = 0; start < length;)
            {
                var count = Math.Min(chunkSize, length - start);
                Marshal.StructureToPtr(new NativeTextRangeFull { Start = start, End = start + count, Text = textPointer }, rangePointer, false);
                Send(SciGetTextRangeFull, 0, rangePointer);
                var bytes = new byte[count];
                Marshal.Copy(textPointer, bytes, 0, count);
                buffer.Write(bytes);
                start += count;
                if (start < length) await Task.Yield();
            }
            return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));
        }
        finally
        {
            Marshal.FreeHGlobal(textPointer);
            Marshal.FreeHGlobal(rangePointer);
        }
    }

    public string LexerLanguage { get; private set; } = "plain";
    public bool IsAvailable { get; private set; }
    public Func<int, bool, bool, bool, bool>? WorkbenchKeyRequested { get; set; }
    private bool nativeComposing;
    public static bool RuntimeFilesPresent => File.Exists(Path.Combine(AppContext.BaseDirectory, "Scintilla.dll")) &&
        File.Exists(Path.Combine(AppContext.BaseDirectory, "Lexilla.dll"));

    public bool IsReadOnly
    {
        get => readOnly;
        set
        {
            readOnly = value;
            if (editorWindow != 0) Send(SciSetReadOnly, value ? 1u : 0u, 0);
        }
    }

    public bool HasUnsavedChanges => editorWindow != 0 && Send(SciGetModify) != 0;

    public NativeScintillaTextSurface(nint ownerWindow, FrameworkElement coordinateRoot)
    {
        this.ownerWindow = ownerWindow;
        this.coordinateRoot = coordinateRoot;
        Content = new Grid { Background = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        IsTabStop = true;
        GotFocus += (_, _) => { if (editorWindow != 0) SetFocus(editorWindow); };
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        SizeChanged += OnSizeChanged;
        coordinateRoot.LayoutUpdated += OnRootLayoutUpdated;
        pollTimer = DispatcherQueue.CreateTimer();
        pollTimer.Interval = TimeSpan.FromMilliseconds(250);
        pollTimer.Tick += (_, _) =>
        {
            UpdateBounds();
            var modified = HasUnsavedChanges;
            if (modified == lastModified) return;
            lastModified = modified;
            DocumentChanged?.Invoke();
        };
        subclassProcedure = SubclassWindowProcedure;
    }

    public void SetDocument(string path, string text)
    {
        pendingPath = path ?? string.Empty;
        LexerLanguage = NativeEditorLanguage.Resolve(pendingPath, text);
        pendingText = text ?? string.Empty;
        if (editorWindow != 0)
        {
            SetLexer(LexerLanguage);
            WriteText(pendingText);
        }
    }

    public async Task SetDocumentAsync(string path, string text)
    {
        pendingPath = path ?? string.Empty;
        pendingText = text ?? string.Empty;
        LexerLanguage = NativeEditorLanguage.Resolve(pendingPath, pendingText);
        if (editorWindow == 0) return;

        var wasReadOnly = readOnly;
        IsReadOnly = true;
        try
        {
            var bytes = await Task.Run(() => Encoding.UTF8.GetBytes(pendingText));
            SetLexer(LexerLanguage);
            Send(SciSetUndoCollection, 0);
            IsReadOnly = false;
            Send(SciClearAll);
            IsReadOnly = true;
            const int chunkSize = 256 * 1024;
            var pointer = Marshal.AllocHGlobal(chunkSize);
            try
            {
                for (var offset = 0; offset < bytes.Length; offset += chunkSize)
                {
                    var count = Math.Min(chunkSize, bytes.Length - offset);
                    Marshal.Copy(bytes, offset, pointer, count);
                    IsReadOnly = false;
                    Send(SciAppendText, (nuint)count, pointer);
                    IsReadOnly = true;
                    if (offset + count < bytes.Length) await Task.Yield();
                }
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        finally
        {
            Send(SciSetUndoCollection, 1);
            Send(SciEmptyUndoBuffer);
            Send(SciSetSavePoint);
            IsReadOnly = wasReadOnly;
        }
        lastModified = false;
        DocumentChanged?.Invoke();
    }

    public bool Find(string query, bool backwards = false, bool matchCase = false, bool wholeWord = false, bool regex = false)
    {
        if (editorWindow == 0 || string.IsNullOrEmpty(query)) return false;
        var flags = (matchCase ? 4 : 0) | (wholeWord ? 2 : 0) | (regex ? 0x00200000 | 0x00800000 : 0);
        Send(2160, checked((int)Send(backwards ? 2143 : 2145)), Send(backwards ? 2143 : 2145));
        Send(2366); // Anchor at the edge of the current selection.
        var bytes = Encoding.UTF8.GetBytes(query + "\0");
        var pointer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            var found = Send(backwards ? SciSearchPrevious : SciSearchNext, flags, pointer);
            if (found < 0)
            {
                var position = backwards ? Send(SciGetLength) : 0;
                Send(2160, checked((int)position), position); Send(2366);
                found = Send(backwards ? SciSearchPrevious : SciSearchNext, flags, pointer);
            }
            return found >= 0;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    public void FocusEditor()
    {
        if (editorWindow != 0) { SetActiveWindow(editorWindow); SetFocus(editorWindow); }
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new EditorAutomationPeer(this);
    private sealed class EditorAutomationPeer(NativeScintillaTextSurface owner) : FrameworkElementAutomationPeer(owner)
    {
        protected override string GetClassNameCore() => "Scintilla";
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Document;
        protected override bool IsKeyboardFocusableCore() => true;
        protected override bool HasKeyboardFocusCore() => owner.editorWindow != 0 && GetFocus() == owner.editorWindow;
        protected override void SetFocusCore() => owner.FocusEditor();
    }

    public void SetSavePoint()
    {
        if (editorWindow == 0) return;
        Send(SciSetSavePoint);
        lastModified = false;
        DocumentChanged?.Invoke();
    }

    private void OnLoaded(object sender, RoutedEventArgs args)
    {
        if (disposed) return;
        try
        {
            if (editorWindow == 0) CreateEditorWindow();
            IsAvailable = true;
            pollTimer.Start();
            UpdateBounds();
            SetFocus(editorWindow);
        }
        catch (Exception error)
        {
            IsAvailable = false;
            InitializationFailed?.Invoke(error);
        }
    }

    private void OnUnloaded(object sender, RoutedEventArgs args)
    {
        pollTimer.Stop();
        HideEditor();
    }

    private void OnSizeChanged(object sender, SizeChangedEventArgs args) => UpdateBounds();
    private void OnRootLayoutUpdated(object? sender, object args)
    {
        if (disposed || Interlocked.Exchange(ref layoutUpdateScheduled, 1) != 0) return;
        if (!DispatcherQueue.TryEnqueue(() =>
        {
            Volatile.Write(ref layoutUpdateScheduled, 0);
            UpdateBounds();
        }))
        {
            Volatile.Write(ref layoutUpdateScheduled, 0);
        }
    }

    private void CreateEditorWindow()
    {
        EnsureLibrariesLoaded();
        // WinUI's composition surface occludes ordinary child HWNDs. Use an
        // owned native window for the editor's layout slot, never a topmost
        // window. Its owner controls minimization and lifetime.
        editorParent = ownerWindow;
        editorWindow = CreateWindowExW(
            0, // An owned popup stays off the taskbar and accepts native focus.
            "Scintilla",
            "OpenFinalShell Native Editor",
            WsPopup | WsTabStop | WsClipSiblings,
            0, 0, 1, 1,
            editorParent,
            0,
            scintillaModule,
            0);
        if (editorWindow == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create the Scintilla editor window.");
        if (!SetWindowSubclass(editorWindow, subclassProcedure, 0x4F4653, 0))
        {
            DestroyWindow(editorWindow);
            editorWindow = 0;
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to install the Scintilla keyboard bridge.");
        }
        ConfigureEditor();
        SetLexer(LexerLanguage);
        WriteText(pendingText);
        Send(SciSetReadOnly, readOnly ? 1u : 0u, 0);
        lastModified = false;
        UpdateBounds();
    }

    private void ConfigureEditor()
    {
        Send(SciSetCodePage, 65001, 0);
        Send(SciSetWrapMode, 0, 0);
        Send(SciSetTabWidth, 4, 0);
        Send(SciSetIndent, 4, 0);
        Send(SciSetUseTabs, 0, 0);
        Send(SciSetIndentationGuides, 1, 0);
        Send(SciSetCaretLineVisible, 1, 0);
        Send(SciSetCaretLineBack, unchecked((int)0x00F4F4F4), 0);

        var font = Encoding.UTF8.GetBytes("Cascadia Mono\0");
        var fontPointer = Marshal.AllocHGlobal(font.Length);
        try
        {
            Marshal.Copy(font, 0, fontPointer, font.Length);
            Send(SciStyleSetFont, StyleDefault, fontPointer);
        }
        finally { Marshal.FreeHGlobal(fontPointer); }

        Send(SciStyleSetSize, StyleDefault, 12);
        Send(SciStyleSetFore, StyleDefault, 0x00202020);
        Send(SciStyleSetBack, StyleDefault, 0x00FFFFFF);
        Send(SciStyleClearAll);
        Send(SciSetMarginTypeN, 0, ScMarginNumber);
        Send(SciSetMarginWidthN, 0, 48);
        Send(SciStyleSetFore, StyleLineNumber, 0x00606060);
        Send(SciStyleSetBack, StyleLineNumber, 0x00F0F0F0);
        Send(SciSetSearchFlags, 0, 0);
    }

    private void SetLexer(string language)
    {
        if (editorWindow == 0) return;
        nint lexer = 0;
        if (!string.Equals(language, "plain", StringComparison.Ordinal))
        {
            var lexillaName = language switch
            {
                "html" => "hypertext",
                "javascript" or "typescript" => "escript",
                "nginx" => "conf",
                "php" => "phpscript",
                "dockerfile" => "bash",
                "csharp" or "java" or "go" => "cpp",
                _ => language
            };
            lexer = createLexer?.Invoke(lexillaName) ?? 0;
            if (lexer == 0) LexerLanguage = "plain";
        }
        Send(SciSetILexer, 0, lexer);
        ConfigureSyntaxStyles();
    }

    private void WriteText(string text)
    {
        if (editorWindow == 0) return;
        var bytes = Encoding.UTF8.GetBytes(text + "\0");
        var pointer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            Send(SciSetText, 0, pointer);
            Send(SciEmptyUndoBuffer);
            Send(SciSetSavePoint);
        }
        finally { Marshal.FreeHGlobal(pointer); }
        lastModified = false;
        DocumentChanged?.Invoke();
    }

    private string ReadText()
    {
        var length = Math.Max(0, checked((int)Send(SciGetLength)));
        if (length == 0) return string.Empty;
        var pointer = Marshal.AllocHGlobal(length + 1);
        try
        {
            Send(SciGetText, (nuint)(length + 1), pointer);
            var bytes = new byte[length];
            Marshal.Copy(pointer, bytes, 0, length);
            return Encoding.UTF8.GetString(bytes);
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private void UpdateBounds()
    {
        if (editorWindow == 0 || disposed) return;
        var foreground = GetForegroundWindow();
        var visible = IsLoaded && IsWindowVisible(ownerWindow) && !IsIconic(ownerWindow) && (foreground == ownerWindow || foreground == editorWindow);
        DependencyObject? ancestor = this;
        while (ancestor != null)
        {
            if (ancestor is UIElement element && element.Visibility != Visibility.Visible) { visible = false; break; }
            ancestor = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetParent(ancestor);
        }
        var popupCount = XamlRoot == null ? 0 : Microsoft.UI.Xaml.Media.VisualTreeHelper.GetOpenPopupsForXamlRoot(XamlRoot).Count;
        if (popupCount > 0) visible = false;
        if (!visible || ActualWidth < 2 || ActualHeight < 2)
        {
            HideEditor();
            return;
        }
        try
        {
            var transform = TransformToVisual(null);
            var point = transform.TransformPoint(new Point(0, 0));
            var bottomRight = transform.TransformPoint(new Point(ActualWidth, ActualHeight));
            var scale = XamlRoot?.RasterizationScale ?? 1.0;
            var x = (int)Math.Round(point.X * scale);
            var y = (int)Math.Round(point.Y * scale);
            var origin = new NativePoint { X = x, Y = y };
            ClientToScreen(ownerWindow, ref origin);
            x = origin.X; y = origin.Y;
            var width = Math.Max(1, (int)Math.Round((bottomRight.X - point.X) * scale));
            var height = Math.Max(1, (int)Math.Round((bottomRight.Y - point.Y) * scale));
            var bounds = (x, y, width, height);
            if (!editorVisible || lastBounds != bounds)
            {
                SetWindowPos(editorWindow, 0, x, y, width, height, SwpNoActivate | SwpShowWindow);
                lastBounds = bounds;
                editorVisible = true;
            }
            if (Environment.GetEnvironmentVariable("OFS_NATIVE_TEST_MODE") == "1")
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetHelpText(this, $"Scintilla HWND {editorWindow}; host={editorParent}; owner={ownerWindow}; bounds={x},{y},{width},{height}; popups={popupCount}");
        }
        catch (InvalidOperationException)
        {
            HideEditor();
        }
    }

    private void HideEditor()
    {
        if (editorWindow != 0 && editorVisible) ShowWindow(editorWindow, 0);
        editorVisible = false;
    }

    private nint SubclassWindowProcedure(nint hwnd, uint message, nuint wParam, nint lParam, nuint subclassId, nuint referenceData)
    {
        const uint WmKeyDown = 0x0100;
        if (message == 0x010D) nativeComposing = true; // WM_IME_STARTCOMPOSITION
        if (message == 0x010E) nativeComposing = false; // WM_IME_ENDCOMPOSITION
        if (!nativeComposing && (message == WmKeyDown || message == 0x0104) && WorkbenchKeyRequested?.Invoke((int)wParam,
            (GetKeyState(0x11) & 0x8000) != 0, (GetKeyState(0x10) & 0x8000) != 0, (GetKeyState(0x12) & 0x8000) != 0) == true) return 0;
        if (message == 0x0201) SetFocus(hwnd); // WM_LBUTTONDOWN
        if (message == 0x0007 && FrameworkElementAutomationPeer.FromElement(this) is { } peer)
            peer.RaiseAutomationEvent(AutomationEvents.AutomationFocusChanged);
        const uint WmMouseWheel = 0x020A;
        const int VkControl = 0x11;
        const int VkS = 0x53;
        const int VkF = 0x46;
        const int VkOemPlus = 0xBB;
        const int VkOemMinus = 0xBD;
        if (!nativeComposing && message == WmKeyDown && (GetKeyState(VkControl) & 0x8000) != 0)
        {
            if ((int)wParam == VkS) { SaveRequested?.Invoke(); return 0; }
            if ((int)wParam == VkF) { SearchRequested?.Invoke(); return 0; }
            if ((int)wParam is VkOemPlus or 0x6B) { Send(SciZoomIn); return 0; }
            if ((int)wParam is VkOemMinus or 0x6D) { Send(SciZoomOut); return 0; }
        }
        if (message == WmMouseWheel && (GetKeyState(VkControl) & 0x8000) != 0)
        {
            var delta = unchecked((short)(((long)wParam >> 16) & 0xFFFF));
            Send(delta >= 0 ? SciZoomIn : SciZoomOut);
            return 0;
        }
        return DefSubclassProc(hwnd, message, wParam, lParam);
    }

    private nint Send(int message, nuint wParam = 0, nint lParam = 0) =>
        SendMessageW(editorWindow, (uint)message, wParam, lParam);

    private nint Send(int message, int wParam, nint lParam = 0) =>
        SendMessageW(editorWindow, (uint)message, unchecked((nuint)wParam), lParam);

    private static void EnsureLibrariesLoaded()
    {
        lock (LibraryGate)
        {
            if (createLexer != null) return;
            var baseDirectory = AppContext.BaseDirectory;
            var scintillaPath = Path.Combine(baseDirectory, "Scintilla.dll");
            var lexillaPath = Path.Combine(baseDirectory, "Lexilla.dll");
            if (!File.Exists(scintillaPath) || !File.Exists(lexillaPath))
                throw new FileNotFoundException("The native Scintilla and Lexilla x64 runtime files are not present beside the application.");
            scintillaModule = LoadLibraryExW(scintillaPath, 0, LoadLibrarySearchDllLoadDir | LoadLibrarySearchDefaultDirs);
            if (scintillaModule == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to load Scintilla.dll.");
            lexillaModule = LoadLibraryExW(lexillaPath, 0, LoadLibrarySearchDllLoadDir | LoadLibrarySearchDefaultDirs);
            if (lexillaModule == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to load Lexilla.dll.");
            var entry = GetProcAddress(lexillaModule, "CreateLexer");
            if (entry == 0) throw new EntryPointNotFoundException("Lexilla.dll does not export CreateLexer.");
            createLexer = Marshal.GetDelegateForFunctionPointer<CreateLexerDelegate>(entry);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        pollTimer.Stop();
        coordinateRoot.LayoutUpdated -= OnRootLayoutUpdated;
        Loaded -= OnLoaded;
        Unloaded -= OnUnloaded;
        SizeChanged -= OnSizeChanged;
        if (editorWindow != 0)
        {
            RemoveWindowSubclass(editorWindow, subclassProcedure, 0x4F4653);
            DestroyWindow(editorWindow);
            editorWindow = 0;
            IsAvailable = false;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint LoadLibraryExW(string fileName, nint file, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GetProcAddress(nint module, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X; public int Y; }
    [DllImport("user32.dll")] private static extern bool ClientToScreen(nint hwnd, ref NativePoint point);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint SendMessageW(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(nint hwnd, nint insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] private static extern nint SetFocus(nint hwnd);
    [DllImport("user32.dll")] private static extern nint SetActiveWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetFocus();
    [DllImport("user32.dll")] private static extern short GetKeyState(int virtualKey);
    [DllImport("comctl32.dll", SetLastError = true)] private static extern bool SetWindowSubclass(nint hwnd, SubclassProcedure procedure, nuint subclassId, nuint referenceData);
    [DllImport("comctl32.dll", SetLastError = true)] private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProcedure procedure, nuint subclassId);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(nint hwnd);
}
