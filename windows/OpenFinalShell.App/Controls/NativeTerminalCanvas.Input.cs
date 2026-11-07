using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using System.Text;

namespace OpenFinalShell.App.Controls;

public sealed partial class NativeTerminalCanvas
{
    // A real WinUI text input client owns TSF/IME composition. Uncommitted
    // composition never goes to SSH; committed text uses the parser's Unicode
    // input path exactly once. Terminal shortcuts are intercepted in preview.
    private readonly TextBox textInput = new()
    {
        HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top,
        MinWidth = 1, MinHeight = 1, Width = 100, Height = 24,
        Padding = new(0), BorderThickness = new(0), Opacity = 0,
        UseSystemFocusVisuals = false,
        // WinUI can report logical focus on a hit-test-disabled TextBox while
        // its native text input client never receives keyboard messages.
        IsHitTestVisible = true, IsTabStop = true, AcceptsReturn = false,
        IsSpellCheckEnabled = false, IsTextPredictionEnabled = false,
        Background = new SolidColorBrush(Colors.Transparent)
    };
    private bool composing, clearingInput;
    public bool IsInputComposing => composing;
    private void InitializeTextInput(Grid surface)
    {
        surface.Children.Add(textInput);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(textInput, "Native terminal input");
        textInput.TextCompositionStarted += (_, _) => { composing = true; textInput.Opacity = 1; PositionTextInput(); };
        textInput.TextCompositionChanged += (_, _) => PositionTextInput();
        textInput.TextCompositionEnded += (_, _) =>
        {
            composing = false; textInput.Opacity = 0;
            // TextChanged may follow CompositionEnded in the same dispatch.
            CommitTextInput();
            DispatcherQueue.TryEnqueue(CommitTextInput);
        };
        textInput.TextChanged += (_, _) =>
        {
            // TextBox consumes CharacterReceived internally. Its committed Text
            // is the source of truth, including when it owns keyboard focus.
            if (!composing && !clearingInput) CommitTextInput();
        };
        textInput.LostFocus += (_, _) =>
        {
            CommitTextInput();
            // An interrupted composition must never execute remote input.
            ClearTextInputBuffer();
            composing = false; textInput.Opacity = 0;
            canvas.Invalidate();
        };
        textInput.GotFocus += (_, _) => { cursorOn = true; canvas.Invalidate(); };
        GotFocus += (_, args) => { if (ReferenceEquals(args.OriginalSource, this)) FocusTextInput(FocusState.Programmatic); };
    }
    private void FocusTextInput(FocusState state)
    {
        PositionTextInput();
        textInput.Focus(state);
    }
    private void CommitTextInput()
    {
        if (composing || clearingInput || textInput.Text.Length == 0) return;
        var committed = textInput.Text;
        clearingInput = true;
        try { textInput.Text = ""; } finally { clearingInput = false; }
        foreach (var rune in committed.EnumerateRunes())
            if (!System.Text.Rune.IsControl(rune)) SendCodepoint((uint)rune.Value, CurrentModifiers() & 3);
    }
    private void PositionTextInput()
    {
        var x = 8d; var y = 4d;
        if (parser != 0)
        { x += Math.Max(0, ofs_terminal_cursor_col(parser)) * cellWidth; y += Math.Max(0, ofs_terminal_cursor_row(parser)) * cellHeight; }
        textInput.Margin = new(Math.Clamp(x, 0, Math.Max(0, ActualWidth - 20)), Math.Clamp(y, 0, Math.Max(0, ActualHeight - cellHeight)), 0, 0);
        // Keep the TSF client focusable without placing an invisible editor
        // over the terminal's selectable text. Expand only for IME composition.
        textInput.Width = composing ? Math.Max(20, Math.Min(320, ActualWidth - textInput.Margin.Left)) : 1;
        textInput.Height = Math.Max(20, cellHeight + 4);
        textInput.FontFamily = new FontFamily(textFormat.FontFamily); textInput.FontSize = textFormat.FontSize;
        textInput.Foreground = new SolidColorBrush(terminalForeground); textInput.Background = new SolidColorBrush(terminalBackground);
    }
}
