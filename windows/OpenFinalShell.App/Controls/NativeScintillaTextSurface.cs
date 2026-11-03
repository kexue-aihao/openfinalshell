using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Dispatching;
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
public sealed class NativeScintillaTextSurface : UserControl, IDisposable
{
    private const uint WsChild = 0x40000000;
    private const uint WsVisible = 0x10000000;
    private const uint WsTabStop = 0x00010000;
    private const uint WsClipSiblings = 0x04000000;
    private const uint SwpNoZOrder = 0x0004;
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

    private static readonly object LibraryGate = new();
    private static nint scintillaModule;
    private static nint lexillaModule;
    private static CreateLexerDelegate? createLexer;

    private readonly FrameworkElement coordinateRoot;
    private readonly nint ownerWindow;
    private readonly DispatcherQueueTimer pollTimer;
    private readonly SubclassProcedure subclassProcedure;
    private nint editorWindow;
    private bool disposed;
    private bool lastModified;
    private string pendingText = string.Empty;
    private string pendingPath = string.Empty;
    private bool readOnly;

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

    public string LexerLanguage { get; private set; } = "plain";
    public bool IsAvailable { get; private set; }
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
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        SizeChanged += OnSizeChanged;
        coordinateRoot.LayoutUpdated += OnRootLayoutUpdated;
        pollTimer = DispatcherQueue.CreateTimer();
        pollTimer.Interval = TimeSpan.FromMilliseconds(250);
        pollTimer.Tick += (_, _) =>
        {
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
        LexerLanguage = ResolveLexer(pendingPath, text);
        pendingText = text ?? string.Empty;
        if (editorWindow != 0)
        {
            SetLexer(LexerLanguage);
            WriteText(pendingText);
        }
    }

    public bool Find(string query, bool backwards = false)
    {
        if (editorWindow == 0 || string.IsNullOrEmpty(query)) return false;
        Send(SciSetSearchFlags, 0, 0);
        var bytes = Encoding.UTF8.GetBytes(query + "\0");
        var pointer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            var found = Send(backwards ? SciSearchPrevious : SciSearchNext, 0, pointer);
            return found >= 0;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    public void FocusEditor()
    {
        if (editorWindow != 0) SetFocus(editorWindow);
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
        if (editorWindow != 0) ShowWindow(editorWindow, 0);
    }

    private void OnSizeChanged(object sender, SizeChangedEventArgs args) => UpdateBounds();
    private void OnRootLayoutUpdated(object? sender, object args) => UpdateBounds();

    private void CreateEditorWindow()
    {
        EnsureLibrariesLoaded();
        editorWindow = CreateWindowExW(
            0,
            "Scintilla",
            string.Empty,
            WsChild | WsVisible | WsTabStop | WsClipSiblings,
            0, 0, 1, 1,
            ownerWindow,
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

        Send(SciStyleSetSize, StyleDefault, 14);
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
            lexer = createLexer?.Invoke(language) ?? 0;
            if (lexer == 0) LexerLanguage = "plain";
        }
        Send(SciSetILexer, 0, lexer);
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
        if (!IsLoaded || Visibility != Visibility.Visible || ActualWidth < 2 || ActualHeight < 2)
        {
            ShowWindow(editorWindow, 0);
            return;
        }
        try
        {
            var point = TransformToVisual(coordinateRoot).TransformPoint(new Point(0, 0));
            var scale = XamlRoot?.RasterizationScale ?? 1.0;
            var x = (int)Math.Round(point.X * scale);
            var y = (int)Math.Round(point.Y * scale);
            var width = Math.Max(1, (int)Math.Round(ActualWidth * scale));
            var height = Math.Max(1, (int)Math.Round(ActualHeight * scale));
            SetWindowPos(editorWindow, 0, x, y, width, height, SwpNoZOrder | SwpNoActivate | SwpShowWindow);
        }
        catch (InvalidOperationException)
        {
            ShowWindow(editorWindow, 0);
        }
    }

    private nint SubclassWindowProcedure(nint hwnd, uint message, nuint wParam, nint lParam, nuint subclassId, nuint referenceData)
    {
        const uint WmKeyDown = 0x0100;
        const uint WmMouseWheel = 0x020A;
        const int VkControl = 0x11;
        const int VkS = 0x53;
        const int VkF = 0x46;
        const int VkOemPlus = 0xBB;
        const int VkOemMinus = 0xBD;
        if (message == WmKeyDown && (GetKeyState(VkControl) & 0x8000) != 0)
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

    private static string ResolveLexer(string path, string text)
    {
        var name = Path.GetFileName(path.Replace('\\', '/')).ToLowerInvariant();
        if (name is "dockerfile" or "containerfile" || name.StartsWith("dockerfile.", StringComparison.Ordinal)) return "dockerfile";
        if (name is ".bashrc" or ".bash_profile" or ".bash_logout" or ".bash_aliases" or ".profile" or ".zshrc" or ".zprofile" or ".zshenv" or ".kshrc" or "crontab") return "bash";
        if (name is "nginx.conf") return "nginx";
        if (name is "sshd_config" or "ssh_config" or "my.cnf" or "php.ini" or "redis.conf" or "supervisord.conf" or "httpd.conf" or "smb.conf" or "resolv.conf" or "sysctl.conf" or "limits.conf" or "logrotate.conf" or "fstab" or "hosts" or "hostname" or "gitconfig" or ".gitconfig" or ".npmrc" or ".editorconfig" or ".inputrc" or ".env") return "props";
        var extension = Path.GetExtension(name).TrimStart('.');
        var lexer = extension switch
        {
            "json" or "jsonc" or "json5" => "json",
            "yaml" or "yml" => "yaml",
            "sh" or "bash" or "zsh" or "ksh" => "bash",
            "conf" or "cnf" or "cfg" or "ini" or "properties" or "service" or "socket" or "timer" or "target" or "mount" or "desktop" or "repo" or "list" => "props",
            "toml" => "toml",
            "diff" or "patch" => "diff",
            "lua" => "lua",
            "pl" or "pm" => "perl",
            "py" or "pyw" => "python",
            "js" or "mjs" or "cjs" or "ts" or "mts" or "cts" or "jsx" or "tsx" => "javascript",
            "xml" or "xsl" or "xsd" or "plist" or "svg" or "rss" => "xml",
            "html" or "htm" => "html",
            "sql" => "sql",
            "css" or "scss" or "less" => "css",
            _ => "plain"
        };
        if (lexer != "plain") return lexer;
        var firstLine = text.Split('\n', 2)[0];
        if (firstLine.StartsWith("#!", StringComparison.Ordinal))
        {
            if (firstLine.Contains("python", StringComparison.OrdinalIgnoreCase)) return "python";
            if (firstLine.Contains("perl", StringComparison.OrdinalIgnoreCase)) return "perl";
            if (firstLine.Contains("node", StringComparison.OrdinalIgnoreCase)) return "javascript";
            if (firstLine.Contains("lua", StringComparison.OrdinalIgnoreCase)) return "lua";
            if (firstLine.Contains("bash", StringComparison.OrdinalIgnoreCase) || firstLine.Contains("/sh", StringComparison.OrdinalIgnoreCase)) return "bash";
        }
        return "plain";
    }

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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint SendMessageW(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(nint hwnd, nint insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] private static extern nint SetFocus(nint hwnd);
    [DllImport("user32.dll")] private static extern short GetKeyState(int virtualKey);
    [DllImport("comctl32.dll", SetLastError = true)] private static extern bool SetWindowSubclass(nint hwnd, SubclassProcedure procedure, nuint subclassId, nuint referenceData);
    [DllImport("comctl32.dll", SetLastError = true)] private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProcedure procedure, nuint subclassId);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(nint hwnd);
}
