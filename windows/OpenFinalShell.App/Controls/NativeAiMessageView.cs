using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.App.ViewModels;
using OpenFinalShell.Core;
using Windows.UI;

namespace OpenFinalShell.App.Controls;

public sealed class NativeAiActionEventArgs(string text) : EventArgs
{
    public string Text { get; } = text;
}

/// <summary>Renders AI prose and fenced code as inert native text with explicit actions.</summary>
public sealed class NativeAiMessageView : UserControl, IDisposable
{
    private readonly NativeChatLine message;
    private readonly Localization localization;
    private readonly Func<string, string?> insertIssue;
    private readonly StackPanel content = new() { Spacing = 8 };
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer refreshTimer;
    private bool disposed;

    public event EventHandler<NativeAiActionEventArgs>? CopyRequested;
    public event EventHandler<NativeAiActionEventArgs>? InsertRequested;

    public NativeAiMessageView(NativeChatLine message, Localization localization, Func<string, string?> insertIssue)
    {
        this.message = message;
        this.localization = localization;
        this.insertIssue = insertIssue;
        Padding = new Thickness(8);
        Content = content;
        AutomationProperties.SetName(this, message.Role == "assistant" ? localization["aiAssistant.answer"] : localization["aiAssistant.userMessage"]);
        message.PropertyChanged += MessageChanged;
        refreshTimer = DispatcherQueue.CreateTimer();
        refreshTimer.Interval = TimeSpan.FromMilliseconds(120);
        refreshTimer.IsRepeating = false;
        refreshTimer.Tick += (_, _) => { if (!disposed) Render(); };
        Render();
    }

    public void Dispose()
    {
        disposed = true;
        refreshTimer.Stop();
        message.PropertyChanged -= MessageChanged;
    }

    public void RefreshAvailability() => Render();

    private void MessageChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args)
    {
        if (args.PropertyName is nameof(NativeChatLine.Content) or nameof(NativeChatLine.PreviewImage))
        {
            refreshTimer.Stop();
            refreshTimer.Start();
        }
    }

    private void Render()
    {
        content.Children.Clear();
        var isAssistant = message.Role == "assistant";
        content.Children.Add(new TextBlock
        {
            Text = isAssistant ? localization["aiAssistant.answer"] : localization["aiAssistant.userMessage"],
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Opacity = .78
        });
        if (message.PreviewImage is { } image)
            content.Children.Add(new Image { Source = image, MaxHeight = 180, MaxWidth = 320, Stretch = Microsoft.UI.Xaml.Media.Stretch.Uniform });
        if (!isAssistant)
        {
            if (message.Content.Length > 0) content.Children.Add(Prose(message.Content));
            return;
        }
        foreach (var part in NativeAiAnswer.Parse(message.Content))
        {
            if (part.Kind == NativeAiAnswerPartKind.Text)
            {
                if (part.Text.Length > 0) content.Children.Add(Prose(part.Text));
                continue;
            }
            content.Children.Add(CodeBlock(part));
        }
    }

    private static TextBlock Prose(string value) => new()
    {
        Text = value,
        TextWrapping = TextWrapping.Wrap,
        IsTextSelectionEnabled = true
    };

    private UIElement CodeBlock(NativeAiAnswerPart part)
    {
        var shell = NativeAiAnswer.IsShellLanguage(part.Language);
        var lines = part.Text.Split('\n');
        var frame = new Border
        {
            BorderThickness = new Thickness(1),
            BorderBrush = new SolidColorBrush(Color.FromArgb(48, 128, 128, 128)),
            Background = new SolidColorBrush(Color.FromArgb(20, 128, 128, 128)),
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(8)
        };
        var panel = new StackPanel { Spacing = 6 };
        frame.Child = panel;
        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(new TextBlock
        {
            Text = part.Language.Length == 0 ? localization["aiCommands.code"] : part.Language,
            VerticalAlignment = VerticalAlignment.Center
        });
        var headerActions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        Grid.SetColumn(headerActions, 1);
        header.Children.Add(headerActions);
        headerActions.Children.Add(ActionButton(lines.Length > 1 ? localization["aiCommands.copyBlock"] : localization["aiCommands.copy"], part.Text, false));
        if (shell)
        {
            var insert = ActionButton(lines.Length > 1 ? localization["aiCommands.insertBlock"] : localization["aiCommands.insertToSsh"], part.Text, true);
            ConfigureInsert(insert, part.Text, part.Complete);
            headerActions.Children.Add(insert);
        }
        panel.Children.Add(header);
        panel.Children.Add(new ScrollViewer
        {
            HorizontalScrollMode = ScrollMode.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = new TextBlock
            {
                Text = part.Text,
                FontFamily = new FontFamily("Cascadia Mono"),
                TextWrapping = TextWrapping.NoWrap,
                IsTextSelectionEnabled = true
            }
        });

        if (shell && lines.Length > 1)
        {
            foreach (var line in lines)
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
                var lineActions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right };
                lineActions.Children.Add(ActionButton(localization["aiCommands.copy"], line, false));
                var insertLine = ActionButton(localization["aiCommands.insertToSsh"], line, true);
                ConfigureInsert(insertLine, line, part.Complete);
                lineActions.Children.Add(insertLine);
                panel.Children.Add(lineActions);
            }
        }
        return frame;
    }

    private Button ActionButton(string label, string text, bool insert)
    {
        var button = new Button { Content = label, MinHeight = 30, Padding = new Thickness(8, 2, 8, 2) };
        AutomationProperties.SetName(button, label);
        if (insert) button.Click += (_, _) => InsertRequested?.Invoke(this, new(text));
        else button.Click += (_, _) => CopyRequested?.Invoke(this, new(text));
        return button;
    }

    private void ConfigureInsert(Button button, string text, bool complete)
    {
        if (!complete)
        {
            button.IsEnabled = false;
            ToolTipService.SetToolTip(button, localization["aiCommands.waitForCompletion"]);
            return;
        }
        var issue = insertIssue(text);
        button.IsEnabled = issue == null;
        ToolTipService.SetToolTip(button, issue ?? localization["aiCommands.manualEnter"]);
    }
}
