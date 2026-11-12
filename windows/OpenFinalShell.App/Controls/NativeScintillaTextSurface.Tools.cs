using System.Runtime.InteropServices;
using System.Text;
using Microsoft.UI.Xaml;
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
        var highContrast = OpenFinalShell.App.NativeAccessibilityGuard.ReadHighContrast(() => new AccessibilitySettings().HighContrast);
        var background = ThemeColor("EditorBackgroundBrush", darkTheme ? Color.FromArgb(255, 39, 39, 39) : Color.FromArgb(255, 251, 251, 251));
        var foreground = ThemeColor("EditorForegroundBrush", darkTheme ? Color.FromArgb(255, 215, 215, 215) : Color.FromArgb(255, 32, 32, 32));
        var gutter = ThemeColor("EditorGutterBrush", darkTheme ? Color.FromArgb(255, 32, 32, 32) : Color.FromArgb(255, 243, 243, 243));
        var gutterForeground = ThemeColor("EditorGutterForegroundBrush", darkTheme ? Color.FromArgb(255, 139, 139, 139) : Color.FromArgb(255, 96, 96, 96));
        var currentLine = ThemeColor("EditorCurrentLineBrush", darkTheme ? Color.FromArgb(255, 51, 51, 51) : Color.FromArgb(255, 244, 244, 244));
        var selection = ThemeColor("EditorSelectionBrush", darkTheme ? Color.FromArgb(255, 49, 75, 101) : Color.FromArgb(255, 220, 235, 250));
        var selectionForeground = ThemeColor("EditorSelectionForegroundBrush", darkTheme ? Color.FromArgb(255, 255, 255, 255) : Color.FromArgb(255, 32, 32, 32));
        var comment = ThemeColor("EditorCommentForegroundBrush", darkTheme ? Color.FromArgb(255, 139, 194, 152) : Color.FromArgb(255, 32, 128, 80));
        var keyword = ThemeColor("EditorKeywordForegroundBrush", darkTheme ? Color.FromArgb(255, 198, 161, 231) : Color.FromArgb(255, 112, 48, 160));
        var literal = ThemeColor("EditorLiteralForegroundBrush", darkTheme ? Color.FromArgb(255, 229, 195, 145) : Color.FromArgb(255, 160, 112, 64));
        if (highContrast)
        {
            try
            {
                var uiSettings = new UISettings();
                background = uiSettings.GetColorValue(UIColorType.Background);
                foreground = uiSettings.GetColorValue(UIColorType.Foreground);
            }
            catch (System.Runtime.InteropServices.COMException) { highContrast = false; }
            if (highContrast)
            {
                gutter = background;
                gutterForeground = comment = keyword = literal = foreground;
                currentLine = selectionForeground = background;
                selection = foreground;
            }
        }
        var back = ToScintillaColor(background);
        var fore = ToScintillaColor(foreground);
        Send(SciStyleSetFore, StyleDefault, fore); Send(SciStyleSetBack, StyleDefault, back); Send(SciStyleClearAll);
        Send(SciStyleSetFore, StyleLineNumber, ToScintillaColor(gutterForeground));
        Send(SciStyleSetBack, StyleLineNumber, ToScintillaColor(gutter));
        Send(2069, ToScintillaColor(selectionForeground)); Send(SciSetCaretLineBack, ToScintillaColor(currentLine));
        Send(2068, 1, ToScintillaColor(selection));
        void Style(int id, int color) => Send(SciStyleSetFore, id, color);
        var commentColor = ToScintillaColor(comment);
        var keywordColor = ToScintillaColor(keyword);
        var literalColor = ToScintillaColor(literal);
        switch (LexerLanguage)
        {
            case "python": Style(1, commentColor); Style(3, literalColor); Style(4, literalColor); Style(5, keywordColor); Style(6, literalColor); Style(7, literalColor); Style(12, commentColor); break;
            case "javascript": case "typescript": case "cpp": case "csharp": case "java": case "go": case "css": case "sql":
                Style(1, commentColor); Style(2, commentColor); Style(3, commentColor); Style(5, keywordColor); Style(6, literalColor); Style(7, literalColor); break;
            case "html": case "xml":
                Style(1, keywordColor); Style(2, keywordColor); Style(3, keywordColor); Style(4, keywordColor); Style(5, literalColor); Style(6, literalColor); Style(7, literalColor); Style(9, commentColor); Style(10, literalColor); break;
            case "bash": case "dockerfile": Style(2, commentColor); Style(4, keywordColor); Style(5, literalColor); Style(6, literalColor); break;
            case "props": case "nginx": Style(1, commentColor); Style(2, keywordColor); Style(3, keywordColor); Style(4, literalColor); break;
            case "php": Style(1, commentColor); Style(2, commentColor); Style(3, commentColor); Style(4, literalColor); Style(5, keywordColor); Style(6, literalColor); Style(7, literalColor); break;
            case "json": Style(2, literalColor); Style(4, keywordColor); Style(6, commentColor); Style(7, commentColor); Style(11, keywordColor); break;
            case "yaml": Style(1, commentColor); Style(2, keywordColor); Style(3, keywordColor); Style(4, literalColor); break;
            case "markdown": Style(1, keywordColor); Style(2, keywordColor); Style(3, keywordColor); Style(7, keywordColor); Style(8, keywordColor); Style(9, literalColor); Style(10, literalColor); Style(14, commentColor); Style(17, literalColor); Style(18, literalColor); break;
        }
        var keywords = LexerLanguage switch
        {
            "python" => "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
            "javascript" or "typescript" => "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
            "cpp" => "alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new noexcept not nullptr operator or private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while xor",
            "csharp" => "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while",
            "java" => "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while",
            "go" => "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false nil",
            "php" => "abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public require require_once return static switch throw trait try unset use var while xor yield",
            "powershell" => "begin break catch class continue data do dynamicparam else elseif end endfor endfunction endif endprocess endregion endswitch endwhile enum exit filter finally for foreach from function if in inline input process return switch throw trap try until using var while workflow",
            "dockerfile" => "ADD ARG CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL MAINTAINER ONBUILD RUN SHELL STOPSIGNAL USER VOLUME WORKDIR",
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

    private static Color ThemeColor(string key, Color fallback)
        => Application.Current.Resources.TryGetValue(key, out var resource) && resource is Microsoft.UI.Xaml.Media.SolidColorBrush brush
            ? brush.Color
            : fallback;

    private static int ToScintillaColor(Color color) => color.R | color.G << 8 | color.B << 16;
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
