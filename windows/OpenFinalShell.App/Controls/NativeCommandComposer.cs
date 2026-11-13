using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace OpenFinalShell.App.Controls;

/// <summary>The full editor and compact terminal input share one session-owned draft.</summary>
public sealed class NativeCommandComposer : UserControl
{
    private readonly Func<string, string> text;
    private readonly Func<string, bool, bool, bool, bool> sendCommand;
    private readonly Func<IReadOnlyList<string>> readHistory;
    private readonly TextBox input = new()
    {
        AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Consolas"),
        FontSize = 13, MinWidth = 0, MinHeight = 0, MaxLength = 32768, Padding = new Thickness(8),
        HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch
    };
    private readonly TextBox quickInput = new()
    {
        AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap, FontFamily = new FontFamily("Consolas"),
        FontSize = 12, MinWidth = 0, MinHeight = 28, Height = 28, MaxLength = 32768, Padding = new Thickness(8, 2, 8, 2)
    };
    private readonly TextBlock previewText = new() { FontFamily = new FontFamily("Consolas"), FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Button quickPreview = new() { Height = 28, MinHeight = 28, Padding = new Thickness(8, 2, 8, 2), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Visibility = Visibility.Collapsed };
    private readonly TextBlock heading = new() { FontSize = 12, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock sendTo = new() { FontSize = 12, VerticalAlignment = VerticalAlignment.Center };
    private readonly CheckBox autoEnter = new() { IsChecked = false };
    private readonly CheckBox expandVariables = new() { IsChecked = true };
    private readonly Button options = new() { MinHeight = 28, FontSize = 12, Padding = new Thickness(8, 2, 8, 2) };
    private readonly Button send = new() { MinHeight = 28, FontSize = 12, Padding = new Thickness(12, 2, 12, 2) };
    private readonly Button quickSend = new() { Content = new FontIcon { Glyph = "\uE724", FontSize = 14 }, Width = 28, Height = 28, Padding = new Thickness(2) };
    private readonly Button openEditor = new() { Content = new FontIcon { Glyph = "\uE70F", FontSize = 14 }, Width = 28, Height = 28, Padding = new Thickness(2) };
    private readonly Button history = new(), save = new(), selectTargets = new();
    private readonly ComboBox targets = new() { MinWidth = 100, MinHeight = 28, Padding = new Thickness(8, 2, 24, 2), FontSize = 12 };
    private bool composing;
    private bool syncing;
    private Action? revealEditor;
    private string Command => input.Text.Replace("\r\n", "\n").Replace('\r', '\n');
    public event Action? ReturnToTerminal;

    public NativeCommandComposer(Func<string, string> text, Func<string, bool, bool, bool, bool> sendCommand,
        Func<IReadOnlyList<string>> readHistory, Action<string, bool> saveSnippet, Action<string, bool> chooseTargets)
    {
        this.text = text; this.sendCommand = sendCommand; this.readHistory = readHistory;
        AutomationProperties.SetAutomationId(input, "CommandEditorInput");
        AutomationProperties.SetAutomationId(send, "CommandEditorSend");
        AutomationProperties.SetAutomationId(this, "NativeCommandComposer");
        ScrollViewer.SetVerticalScrollBarVisibility(input, ScrollBarVisibility.Auto);
        ScrollViewer.SetVerticalScrollBarVisibility(quickInput, ScrollBarVisibility.Hidden);
        quickPreview.Content = previewText;
        var choices = new StackPanel { Spacing = 6, Children = { autoEnter, expandVariables, history, save, selectTargets } };
        options.Flyout = new Flyout { Content = choices };
        history.Click += (_, _) => { options.Flyout.Hide(); ShowHistory(); };
        save.Click += (_, _) => { options.Flyout.Hide(); saveSnippet(Command, autoEnter.IsChecked == true); };
        selectTargets.Click += (_, _) => { options.Flyout.Hide(); chooseTargets(Command, autoEnter.IsChecked == true); };
        send.Click += (_, _) => Send(targets.SelectedIndex == 1);
        quickSend.Click += (_, _) => Send(false);
        openEditor.Click += (_, _) => { revealEditor?.Invoke(); Edit(); };
        quickPreview.Click += (_, _) => { revealEditor?.Invoke(); Edit(); };
        var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            Children = { options, sendTo, targets, send } };
        var layout = new Grid { Padding = new Thickness(6, 0, 6, 0), RowSpacing = 2 };
        layout.RowDefinitions.Add(new() { Height = new(28) });
        layout.RowDefinitions.Add(new() { Height = new(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new() { Height = new(32) });
        layout.Children.Add(heading); layout.Children.Add(input); Grid.SetRow(input, 1);
        var footerScroll = new ScrollViewer { Content = footer, HorizontalScrollMode = ScrollMode.Enabled, HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
        layout.Children.Add(footerScroll); Grid.SetRow(footerScroll, 2);
        Content = layout;
        input.TextChanged += (_, _) => SynchronizeDraft(input, quickInput);
        quickInput.TextChanged += (_, _) => SynchronizeDraft(quickInput, input);
        foreach (var editor in new[] { input, quickInput })
        {
            editor.TextCompositionStarted += (_, _) => composing = true;
            editor.TextCompositionEnded += (_, _) => composing = false;
            var submit = new KeyboardAccelerator { Key = VirtualKey.Enter, Modifiers = VirtualKeyModifiers.Control };
            submit.Invoked += (_, args) => { args.Handled = true; if (!composing) Send(editor == input && targets.SelectedIndex == 1); };
            editor.KeyboardAccelerators.Add(submit);
            editor.KeyDown += (_, args) =>
            {
                if (args.Key != VirtualKey.Escape || composing) return;
                args.Handled = true; ReturnToTerminal?.Invoke();
            };
        }
        quickInput.KeyDown += (_, args) =>
        {
            if (args.Key != VirtualKey.Enter || composing ||
                (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control) & Windows.UI.Core.CoreVirtualKeyStates.Down) != 0) return;
            args.Handled = true; revealEditor?.Invoke(); Edit();
        };
        ConfigureLabels(); UpdateActions();
    }

    public FrameworkElement CreateQuickInput(Action showEditor)
    {
        revealEditor = showEditor;
        var layout = new Grid { ColumnSpacing = 2 };
        layout.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) });
        layout.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        layout.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        layout.Children.Add(quickInput); layout.Children.Add(quickPreview);
        layout.Children.Add(quickSend); Grid.SetColumn(quickSend, 1);
        layout.Children.Add(openEditor); Grid.SetColumn(openEditor, 2);
        return new Border { Child = layout, MaxWidth = 1200, Margin = new Thickness(12, 4, 12, 6), HorizontalAlignment = HorizontalAlignment.Stretch };
    }

    public void ConfigureLabels()
    {
        heading.Text = text("commandEditor.title");
        quickInput.PlaceholderText = text("native.commands.command") + " · Ctrl+Enter";
        AutomationProperties.SetName(input, text("commandEditor.title"));
        AutomationProperties.SetName(quickInput, text("native.commands.command"));
        AutomationProperties.SetName(quickPreview, text("commandEditor.title"));
        autoEnter.Content = text("commandEditor.autoEnter"); expandVariables.Content = text("commandEditor.expandVars");
        ToolTipService.SetToolTip(autoEnter, text("commandEditor.autoEnterHint"));
        ToolTipService.SetToolTip(expandVariables, text("commandEditor.expandVarsHint") + " {{host}} {{user}} {{port}}");
        options.Content = text("commandEditor.options"); send.Content = text("commandEditor.send");
        history.Content = text("snippet.history"); save.Content = text("commandEditor.saveAsSnippet"); selectTargets.Content = text("commandEditor.sendTo");
        sendTo.Text = text("commandEditor.sendTo");
        var selected = targets.SelectedIndex;
        targets.Items.Clear(); targets.Items.Add(text("commandEditor.targetCurrent")); targets.Items.Add(text("commandEditor.targetAll")); targets.SelectedIndex = Math.Max(0, selected);
        AutomationProperties.SetName(targets, sendTo.Text);
        ToolTipService.SetToolTip(quickSend, text("commandEditor.sendHint")); AutomationProperties.SetName(quickSend, text("commandEditor.send"));
        ToolTipService.SetToolTip(openEditor, heading.Text); AutomationProperties.SetName(openEditor, heading.Text);
    }
    private void SynchronizeDraft(TextBox source, TextBox destination)
    {
        if (syncing) return;
        syncing = true;
        try { if (destination.Text != source.Text) destination.Text = source.Text; }
        finally { syncing = false; }
        UpdateActions();
    }
    private void UpdateActions()
    {
        var valid = !string.IsNullOrWhiteSpace(Command) && !Command.Contains('\0');
        send.IsEnabled = quickSend.IsEnabled = save.IsEnabled = valid;
        var multiline = Command.Contains('\n');
        previewText.Text = Command.Split('\n')[0] + " …";
        quickInput.Visibility = multiline ? Visibility.Collapsed : Visibility.Visible;
        quickPreview.Visibility = multiline ? Visibility.Visible : Visibility.Collapsed;
    }
    public void Edit(string? command = null, bool appendEnter = false)
    {
        if (command != null) { input.Text = command; autoEnter.IsChecked = appendEnter; SynchronizeDraft(input, quickInput); }
        input.Focus(FocusState.Programmatic); input.SelectionStart = input.Text.Length;
    }
    private void Send(bool allSessions)
    {
        if (composing || string.IsNullOrWhiteSpace(Command) || Command.Contains('\0') ||
            !sendCommand(Command, autoEnter.IsChecked == true, expandVariables.IsChecked == true, allSessions)) return;
        input.Text = ""; SynchronizeDraft(input, quickInput); ReturnToTerminal?.Invoke();
    }
    private void ShowHistory()
    {
        var list = new ListView { ItemsSource = readHistory(), IsItemClickEnabled = true, MaxHeight = 280, Width = Math.Max(160, Math.Min(480, ActualWidth - 32)) };
        AutomationProperties.SetName(list, text("snippet.history"));
        var flyout = new Flyout { Content = list };
        list.ItemClick += (_, args) => { if (args.ClickedItem is string command) { flyout.Hide(); Edit(command); } };
        DispatcherQueue.TryEnqueue(() => flyout.ShowAt(options));
    }
}
