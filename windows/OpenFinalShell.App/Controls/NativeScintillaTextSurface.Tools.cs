using System.Runtime.InteropServices;
using System.Text;
using OpenFinalShell.Core;
using Windows.UI;
using Windows.UI.ViewManagement;

namespace OpenFinalShell.App.Controls;

public sealed partial class NativeScintillaTextSurface
{
    private bool darkTheme;
    public void SetWrapping(bool wrap) { if (editorWindow != 0) Send(SciSetWrapMode, wrap ? 1 : 0); }
    public void SetIndentation(int width, bool useTabs)
    {
        if (editorWindow == 0) return;
        Send(SciSetTabWidth, Math.Clamp(width, 1, 8));
        Send(SciSetIndent, Math.Clamp(width, 1, 8));
        Send(SciSetUseTabs, useTabs ? 1 : 0);
    }
    public string CaretStatus
    {
        get { if (editorWindow == 0) return ""; var pos = Send(2008); return $"{Send(2166, checked((int)pos)) + 1}:{Send(2129, checked((int)pos)) + 1}"; }
    }
    public void GoToLine(int line)
    {
        if (editorWindow == 0) return;
        Send(2024, Math.Clamp(line - 1, 0, Math.Max(0, (int)Send(2154) - 1))); FocusEditor();
    }
    public void FoldAll(bool collapse) { if (editorWindow != 0) Send(2662, collapse ? 0 : 1); }
    public void SetLanguage(string language)
    {
        LexerLanguage = language; if (editorWindow != 0) SetLexer(language);
    }
    public void Configure(NativeSettings settings)
    {
        darkTheme = settings.ThemeMode == "dark" || settings.ThemeMode == "system" && ActualTheme == Microsoft.UI.Xaml.ElementTheme.Dark;
        if (editorWindow != 0) ConfigureSyntaxStyles();
    }
    private nint SendUtf8(int message, int parameter, string value)
    {
        var pointer = Marshal.StringToCoTaskMemUTF8(value);
        try { return Send(message, parameter, pointer); } finally { Marshal.FreeCoTaskMem(pointer); }
    }
    private void ConfigureSyntaxStyles()
    {
        if (editorWindow == 0) return;
        var accessibility = new AccessibilitySettings();
        var highContrast = accessibility.HighContrast;
        var uiSettings = new UISettings();
        var background = highContrast
            ? uiSettings.GetColorValue(UIColorType.Background)
            : darkTheme ? Color.FromArgb(255, 39, 39, 39) : Color.FromArgb(255, 251, 251, 251);
        var foreground = highContrast
            ? uiSettings.GetColorValue(UIColorType.Foreground)
            : darkTheme ? Color.FromArgb(255, 215, 215, 215) : Color.FromArgb(255, 32, 32, 32);
        var gutter = highContrast
            ? background
            : darkTheme ? Color.FromArgb(255, 32, 32, 32) : Color.FromArgb(255, 243, 243, 243);
        var gutterForeground = highContrast
            ? foreground
            : darkTheme ? Color.FromArgb(255, 139, 139, 139) : Color.FromArgb(255, 96, 96, 96);
        var currentLine = highContrast
            ? background
            : darkTheme ? Color.FromArgb(255, 51, 51, 51) : Color.FromArgb(255, 244, 244, 244);
        var selection = highContrast
            ? foreground
            : darkTheme ? Color.FromArgb(255, 74, 58, 48) : Color.FromArgb(255, 245, 214, 179);
        var selectionForeground = highContrast
            ? background
            : darkTheme ? Color.FromArgb(255, 255, 255, 255) : Color.FromArgb(255, 32, 32, 32);
        var back = ToScintillaColor(background);
        var fore = ToScintillaColor(foreground);
        Send(SciStyleSetFore, StyleDefault, fore); Send(SciStyleSetBack, StyleDefault, back); Send(SciStyleClearAll);
        Send(SciStyleSetFore, StyleLineNumber, ToScintillaColor(gutterForeground));
        Send(SciStyleSetBack, StyleLineNumber, ToScintillaColor(gutter));
        Send(2069, ToScintillaColor(selectionForeground)); Send(SciSetCaretLineBack, ToScintillaColor(currentLine));
        Send(2068, 1, ToScintillaColor(selection));
        void Style(int id, int color) => Send(SciStyleSetFore, id, color);
        var comment = darkTheme ? 0x008BC298 : 0x00508020;
        var keyword = darkTheme ? 0x00E7A1C6 : 0x00A03070;
        var literal = darkTheme ? 0x0091C3E5 : 0x004070A0;
        switch (LexerLanguage)
        {
            case "python": Style(1, comment); Style(3, literal); Style(4, literal); Style(5, keyword); Style(6, literal); Style(7, literal); Style(12, comment); break;
            case "javascript": case "cpp": case "css": case "sql": Style(1, comment); Style(2, comment); Style(3, comment); Style(5, keyword); Style(6, literal); Style(7, literal); break;
            case "bash": Style(2, comment); Style(4, keyword); Style(5, literal); Style(6, literal); break;
            case "props": Style(1, comment); Style(2, keyword); Style(3, keyword); Style(4, literal); break;
            case "json": Style(2, literal); Style(4, keyword); Style(6, comment); Style(7, comment); Style(11, keyword); break;
            case "yaml": Style(1, comment); Style(2, keyword); Style(3, keyword); Style(4, literal); break;
        }
        var keywords = LexerLanguage switch
        {
            "python" => "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
            "javascript" => "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
            "bash" => "if then else elif fi case esac for while do done function in select until time export local return",
            "sql" => "select from where insert into update delete create table alter drop join left right on group order by having limit union distinct null as and or not values set begin commit rollback",
            _ => ""
        };
        SendUtf8(4005, 0, keywords);
        var key = Marshal.StringToCoTaskMemUTF8("fold"); var value = Marshal.StringToCoTaskMemUTF8("1");
        try { Send(4004, unchecked((nuint)key), value); } finally { Marshal.FreeCoTaskMem(key); Marshal.FreeCoTaskMem(value); }
        Send(2240, 1, 0); Send(2242, 1, 16); Send(2244, 1, unchecked((int)0xFE000000));
        Send(2040, 30, 12); Send(2040, 31, 14);
        Send(4003, 0, -1); // Colourise all text after changing lexer properties.
    }

    private static int ToScintillaColor(Color color) => color.R << 16 | color.G << 8 | color.B;
    public int ReplaceAll(string query, string replacement, bool matchCase, bool wholeWord, bool regex)
    {
        if (editorWindow == 0 || IsReadOnly || string.IsNullOrEmpty(query)) return 0;
        var queryBytes = Encoding.UTF8.GetByteCount(query); var replacementBytes = Encoding.UTF8.GetByteCount(replacement);
        Send(2198, (matchCase ? 4 : 0) | (wholeWord ? 2 : 0) | (regex ? 0x00200000 | 0x00800000 : 0));
        var count = 0; var start = 0;
        Send(2078);
        try
        {
            while (start <= Send(SciGetLength))
            {
                Send(2190, start); Send(2192, checked((int)Send(SciGetLength)));
                var found = SendUtf8(2197, queryBytes, query);
                if (found < 0) break;
                var end = Send(2193); var zeroLength = end == found;
                SendUtf8(regex ? 2195 : 2194, replacementBytes, replacement);
                count++;
                start = checked((int)Send(2193));
                if (zeroLength) start = checked((int)Send(2418, start)); // Next UTF-8 character.
                if (zeroLength && start <= (int)Send(2193)) break;
            }
        }
        finally { Send(2079); }
        DocumentChanged?.Invoke(); return count;
    }
}
