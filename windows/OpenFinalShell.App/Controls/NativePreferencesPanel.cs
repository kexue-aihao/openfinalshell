using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using OpenFinalShell.Core;
using System.Text.Json.Nodes;
using Windows.UI;

namespace OpenFinalShell.App.Controls;

/// <summary>Native controls patch shared preference fields individually.</summary>
public sealed class NativePreferencesPanel : StackPanel
{
    private readonly Dictionary<string, StackPanel> sections = new(StringComparer.Ordinal);

    public void ShowSection(string section)
    {
        foreach (var (key, panel) in sections)
            panel.Visibility = key == "settings.section_" + section ? Visibility.Visible : Visibility.Collapsed;
    }

    public NativePreferencesPanel(NativeSettings settings, Func<string, string> text, Action<JsonObject> save, Func<Task<string?>>? chooseDownloadDirectory = null)
    {
        Spacing = 12;
        StackPanel Section(string key)
        {
            var section = new StackPanel { Spacing = 0, Visibility = Visibility.Collapsed };
            sections.Add(key, section);
            Children.Add(section);
            return section;
        }
        void Row(StackPanel section, string key, FrameworkElement input)
        {
            var label = new TextBlock { Text = text(key), FontSize = 13, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0) };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(input, text(key));
            var row = new Grid { ColumnSpacing = 16, RowSpacing = 8, Padding = new Thickness(0, 10, 0, 10) };
            row.ColumnDefinitions.Add(new() { Width = new GridLength(180) });
            row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            row.RowDefinitions.Add(new() { Height = GridLength.Auto });
            row.RowDefinitions.Add(new() { Height = GridLength.Auto });
            row.Children.Add(label); row.Children.Add(input); Grid.SetColumn(input, 1);
            input.HorizontalAlignment = HorizontalAlignment.Stretch;
            row.SizeChanged += (_, _) =>
            {
                var narrow = row.ActualWidth < 440;
                row.ColumnDefinitions[0].Width = narrow ? new GridLength(1, GridUnitType.Star) : new GridLength(180);
                row.ColumnDefinitions[1].Width = narrow ? new GridLength(0) : new GridLength(1, GridUnitType.Star);
                Grid.SetColumn(input, narrow ? 0 : 1); Grid.SetRow(input, narrow ? 1 : 0);
            };
            section.Children.Add(row);
        }
        void Commit(string path, JsonNode? value)
        {
            var parts = path.Split('.'); var patch = new JsonObject(); var target = patch;
            for (var i = 0; i < parts.Length - 1; i++) { var child = new JsonObject(); target[parts[i]] = child; target = child; }
            target[parts[^1]] = value; save(patch);
        }
        void Flag(StackPanel section, string path, string key, bool fallback)
        {
            var input = new ToggleSwitch { IsOn = settings.Get(path, fallback) };
            input.Toggled += (_, _) => Commit(path, JsonValue.Create(input.IsOn)); Row(section, key, input);
        }
        void Number(StackPanel section, string path, string key, double fallback, double min, double max, double step = 1)
        {
            var input = new NumberBox { Value = Math.Clamp(settings.Get(path, fallback), min, max), Minimum = min, Maximum = max, SmallChange = step, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
            input.ValueChanged += (_, args) => { if (double.IsFinite(args.NewValue)) Commit(path, path == "terminal.lineHeight" ? JsonValue.Create(args.NewValue) : JsonValue.Create((int)Math.Round(args.NewValue))); };
            Row(section, key, input);
        }
        void Choice(StackPanel section, string path, string key, string fallback, params (string Value, string Key)[] values)
        {
            var input = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
            foreach (var item in values) input.Items.Add(new ComboBoxItem { Tag = item.Value, Content = text(item.Key) });
            input.SelectedItem = input.Items.OfType<ComboBoxItem>().FirstOrDefault(i => Equals(i.Tag, settings.Get(path, fallback))) ?? input.Items[0];
            input.SelectionChanged += (_, _) => { if (input.SelectedItem is ComboBoxItem item) Commit(path, JsonValue.Create(item.Tag?.ToString())); }; Row(section, key, input);
        }
        void Input(StackPanel section, string path, string key, string fallback)
        {
            var current = settings.Get(path, fallback);
            var input = new TextBox { Text = current, MaxLength = 1024 };
            input.LostFocus += (_, _) => { if (input.Text != current) { Commit(path, JsonValue.Create(input.Text)); current = input.Text; } }; Row(section, key, input);
        }
        void DirectoryInput(StackPanel section, string path, string key, string fallback)
        {
            var current = settings.Get(path, fallback);
            var input = new TextBox { Text = current, MaxLength = 1024, MinWidth = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
            input.LostFocus += (_, _) => { if (input.Text != current) { Commit(path, JsonValue.Create(input.Text)); current = input.Text; } };
            var browse = new Button { Content = text("conn.browse"), VerticalAlignment = VerticalAlignment.Bottom, IsEnabled = chooseDownloadDirectory != null };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(browse, text("settings.downloadDir") + " · " + text("conn.browse"));
            browse.Click += async (_, _) =>
            {
                if (chooseDownloadDirectory == null) return;
                var selected = await chooseDownloadDirectory();
                if (string.IsNullOrWhiteSpace(selected)) return;
                input.Text = selected;
                current = selected;
                Commit(path, JsonValue.Create(selected));
            };
            var row = new Grid { ColumnSpacing = 8 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(input, 0); Grid.SetColumn(browse, 1);
            row.Children.Add(input); row.Children.Add(browse);
            Row(section, key, row);
        }
        var general = Section("settings.section_general");
        Flag(general, "confirmOnCloseTab", "settings.confirmOnCloseTab", true);
        Flag(general, "autoCheckUpdate", "settings.autoCheckUpdate", true);
        var ai = Section("settings.section_ai");
        Flag(ai, "aiAssistantEnabled", "native.ai.assistantEnabled", false);
        Flag(general, "connection.maskHostInList", "settings.maskHostInList", true);
        Number(general, "uiZoom", "settings.uiZoom", 100, 50, 200, 5);
        var appearance = Section("settings.section_appearance");
        appearance.Children.Add(new TextBlock { Text = text("settings.accent"), FontWeight = Microsoft.UI.Text.FontWeights.SemiBold });
        var accentPalette = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        var accentButtons = new List<Button>();
        var selectedAccent = settings.Accent;
        void RefreshAccentSelection()
        {
            foreach (var button in accentButtons)
            {
                var color = (string)button.Tag;
                button.BorderThickness = color.Equals(selectedAccent, StringComparison.OrdinalIgnoreCase) ? new Thickness(2) : new Thickness(0);
                button.BorderBrush = new SolidColorBrush(ParseColor(color));
            }
        }
        foreach (var color in NativeSettings.AccentColors)
        {
            var button = new Button
            {
                Tag = color, Width = 36, Height = 36, Padding = new Thickness(6),
                Content = new Ellipse { Width = 18, Height = 18, Fill = new SolidColorBrush(ParseColor(color)) }
            };
            var accessibleName = $"{text("settings.accent")}: {color}";
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, accessibleName);
            ToolTipService.SetToolTip(button, accessibleName);
            button.Click += (_, _) =>
            {
                selectedAccent = color;
                RefreshAccentSelection();
                Commit("accent", JsonValue.Create(color));
            };
            accentButtons.Add(button);
            accentPalette.Children.Add(button);
        }
        RefreshAccentSelection();
        appearance.Children.Add(new ScrollViewer
        {
            Content = accentPalette,
            HorizontalScrollMode = ScrollMode.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled
        });
        var terminal = Section("settings.section_terminal");
        Input(terminal, "terminal.fontFamily", "settings.fontFamily", "Cascadia Mono");
        Number(terminal, "terminal.fontSize", "settings.fontSize", 14, 8, 48);
        Number(terminal, "terminal.lineHeight", "settings.lineHeight", 1.2, 1, 3, .1);
        Number(terminal, "terminal.scrollback", "settings.scrollback", 5000, 0, 100000, 1000);
        Choice(terminal, "terminal.cursorStyle", "settings.cursorStyle", "bar", ("bar", "settings.cursorBar"), ("block", "settings.cursorBlock"), ("underline", "settings.cursorUnderline"));
        Choice(terminal, "terminal.rightClick", "settings.rightClick", NativeSettings.DefaultTerminalRightClick, ("menu", "settings.rightClickMenu"), ("paste", "settings.rightClickPaste"));
        var themes = new ComboBox { Header = text("settings.terminalTheme"), HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var id in new[] { "auto", "one-dark", "dracula", "nord", "solarized-dark", "github-light", "solarized-light" }) themes.Items.Add(new ComboBoxItem { Tag = id, Content = id == "auto" ? text("settings.terminalThemeAuto") : id });
        themes.SelectedItem = themes.Items.OfType<ComboBoxItem>().FirstOrDefault(i => Equals(i.Tag, settings.Get("terminal.themeId", "auto"))) ?? themes.Items[0];
        themes.SelectionChanged += (_, _) => { if (themes.SelectedItem is ComboBoxItem item) Commit("terminal.themeId", JsonValue.Create(item.Tag?.ToString())); }; terminal.Children.Add(themes);
        Flag(terminal, "terminal.cursorBlink", "settings.cursorBlink", true);
        Flag(terminal, "terminal.copyOnSelect", "settings.copyOnSelect", NativeSettings.DefaultTerminalCopyOnSelect);
        Flag(terminal, "terminal.confirmMultilinePaste", "settings.confirmMultilinePaste", true);
        Flag(terminal, "terminal.saveCommandHistory", "settings.saveCommandHistory", true);
        var files = Section("settings.section_sftp");
        DirectoryInput(files, "sftp.downloadDir", "settings.downloadDir", "");
        Number(files, "sftp.maxConcurrentGlobal", "settings.maxConcurrentGlobal", 4, 1, 32);
        Number(files, "sftp.maxConcurrentPerSession", "settings.maxConcurrentPerSession", 2, 1, 16);
        Choice(files, "sftp.conflictPolicy", "settings.conflictPolicy", "ask", ("ask", "settings.conflictAsk"), ("overwrite", "settings.conflictOverwrite"), ("skip", "settings.conflictSkip"), ("rename", "settings.conflictRename"));
        Choice(files, "sftp.doubleClickAction", "settings.doubleClickAction", NativeSettings.DefaultSftpDoubleClickAction, ("open", "settings.doubleClickOpen"), ("download", "settings.doubleClickDownload"));
        Flag(files, "sftp.showHiddenFiles", "settings.showHiddenFiles", NativeSettings.DefaultSftpShowHiddenFiles);
        Flag(files, "sftp.autoOpenOnConnect", "settings.autoOpenOnConnect", true);
        Flag(files, "sftp.packedTransfer", "settings.packedTransfer", false);
        files.Children.Add(new TextBlock { Text = text("settings.packedTransferHint"), TextWrapping = TextWrapping.Wrap });
        Flag(files, "sftp.fastDelete", "settings.fastDelete", true);
        Flag(files, "sftp.followTerminalCd", "settings.followTerminalCd", true);
        files.Children.Add(new TextBlock { Text = text("native.sftp.followDirectoryHint"), TextWrapping = TextWrapping.Wrap });
        Number(files, "monitor.intervalMs", "settings.monitorInterval", 2000, 500, 60000, 500);
    }

    private static Color ParseColor(string value) => Color.FromArgb(255,
        Convert.ToByte(value.Substring(1, 2), 16), Convert.ToByte(value.Substring(3, 2), 16), Convert.ToByte(value.Substring(5, 2), 16));
}
