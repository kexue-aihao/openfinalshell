using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private void CommandSearchChanged(object sender, TextChangedEventArgs args)
    {
        CommandViewModel.Query = ((TextBox)sender).Text;
        if (CommandSnippets != null) CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet;
    }
    private void MoveCommandUp(object sender, RoutedEventArgs args) => MoveCommand(-1);
    private void MoveCommandDown(object sender, RoutedEventArgs args) => MoveCommand(1);
    private void MoveCommandGroupUp(object sender, RoutedEventArgs args) => MoveCommandGroup(-1);
    private void MoveCommandGroupDown(object sender, RoutedEventArgs args) => MoveCommandGroup(1);
    private void MoveCommandGroup(int direction)
    {
        try { CommandViewModel.MoveGroup(direction); CommandGroups.SelectedItem = CommandViewModel.SelectedGroup; }
        catch (Exception error) { ShowError(error); }
    }
    private void MoveCommand(int direction)
    {
        try { CommandViewModel.MoveSnippet(direction); CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet; }
        catch (Exception error) { ShowError(error); }
    }
    private void RefillCommandHistory(object sender, ItemClickEventArgs args)
    {
        if (args.ClickedItem is not string command) return;
        if ((Sessions.SelectedItem as TabViewItem)?.Tag is not string id || !sessionTerminals.TryGetValue(id, out var terminal))
        { ShowError(localization["native.commands.selectSession"]); return; }
        // History clicks refill only. No Enter or other terminal control bytes.
        var line = new string(command.Replace('\r', ' ').Replace('\n', ' ').Where(c => !char.IsControl(c)).ToArray());
        terminal.Send(line);
    }

    private void CommandSnippetRightTapped(object sender, RightTappedRoutedEventArgs args)
    {
        args.Handled = true;
        var source = args.OriginalSource as DependencyObject;
        while (source != null && source != CommandSnippets && source is not ListViewItem)
            source = VisualTreeHelper.GetParent(source);
        if (source is not ListViewItem container || CommandSnippets.ItemFromContainer(container) is not NativeSnippet snippet) return;

        SelectCommandSnippet(snippet);
        ShowCommandSnippetMenu(snippet, container, args.GetPosition(container));
    }

    private void CommandSnippetKeyDown(object sender, KeyRoutedEventArgs args)
    {
        var keyboardMenu = args.Key == Windows.System.VirtualKey.Application ||
            args.Key == Windows.System.VirtualKey.F10 &&
            (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift) & Windows.UI.Core.CoreVirtualKeyStates.Down) != 0;
        if (!keyboardMenu || CommandSnippets.SelectedItem is not NativeSnippet snippet ||
            CommandSnippets.ContainerFromItem(snippet) is not FrameworkElement container) return;

        args.Handled = true;
        ShowCommandSnippetMenu(snippet, container, new Windows.Foundation.Point(container.ActualWidth / 2, container.ActualHeight / 2));
    }

    private void SelectCommandSnippet(NativeSnippet snippet)
    {
        CommandSnippets.SelectedItem = snippet;
        CommandViewModel.SelectedSnippet = snippet;
    }

    private void ShowCommandSnippetMenu(NativeSnippet snippet, FrameworkElement target, Windows.Foundation.Point position)
    {
        SelectCommandSnippet(snippet);
        var menu = new MenuFlyout();
        void Add(string label, Symbol symbol, Action action)
        {
            var item = new MenuFlyoutItem { Text = label, Icon = new SymbolIcon(symbol) };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(item, label);
            item.Click += (_, _) => action();
            menu.Items.Add(item);
        }

        Add(localization["native.commands.send"], Symbol.Send, () => _ = ShowCommandSendAsync(snippet.Command, snippet.AutoEnter));
        Add(localization["native.common.edit"], Symbol.Edit, () => _ = EditSnippetAsync(snippet, false));
        Add(localization["conn.duplicate"], Symbol.Copy, () => _ = EditSnippetAsync(snippet, true));
        menu.Items.Add(new MenuFlyoutSeparator());
        Add(localization["native.common.delete"], Symbol.Delete, () => _ = DeleteSnippetAsync(snippet));
        menu.ShowAt(target, position);
    }

    private async void FindDuplicateCommands(object sender, RoutedEventArgs args)
    {
        try
        {
            var duplicates = CommandViewModel.FindDuplicates();
            if (duplicates.Count == 0)
            {
                var emptyDialog = new ContentDialog
                {
                    Title = localization["native.commands.findDuplicates"],
                    Content = localization["native.commands.noDuplicates"],
                    CloseButtonText = localization["common.close"],
                    XamlRoot = Root.XamlRoot
                };
                await emptyDialog.ShowGatedAsync();
                return;
            }

            var selectors = new Dictionary<string, ComboBox>(StringComparer.Ordinal);
            var selectorItems = new Dictionary<string, IReadOnlyList<NativeSnippet>>(StringComparer.Ordinal);
            var content = new StackPanel { Spacing = 14 };
            content.Children.Add(new TextBlock
            {
                Text = localization.Format("native.commands.duplicatePreview", ("groups", duplicates.Count.ToString(System.Globalization.CultureInfo.CurrentCulture))),
                TextWrapping = TextWrapping.Wrap
            });
            foreach (var duplicate in duplicates)
            {
                var selector = new ComboBox
                {
                    Header = localization.Format("native.commands.keepCommand", ("group", duplicate.GroupName)),
                    ItemsSource = duplicate.Snippets.Select((item, index) =>
                        $"#{index + 1} · {item.Name} · {(item.AutoEnter ? localization["native.commands.autoEnterOn"] : localization["native.commands.autoEnterOff"])}").ToArray(),
                    SelectedIndex = 0,
                    HorizontalAlignment = HorizontalAlignment.Stretch
                };
                selectors.Add(duplicate.Key, selector);
                selectorItems.Add(duplicate.Key, duplicate.Snippets);
                var commandPreview = new TextBlock
                {
                    Text = duplicate.Snippets[0].Command,
                    TextWrapping = TextWrapping.Wrap,
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 12,
                    IsTextSelectionEnabled = true
                };
                content.Children.Add(new StackPanel
                {
                    Spacing = 5,
                    Children =
                    {
                        selector,
                        commandPreview,
                        new TextBlock
                        {
                            Text = string.Join(" · ", duplicate.Snippets.Select(item => item.Name)),
                            FontSize = 12,
                            Opacity = .7,
                            TextWrapping = TextWrapping.Wrap
                        }
                    }
                });
            }

            var removeCount = duplicates.Sum(group => group.Snippets.Count - 1);
            var dialog = new ContentDialog
            {
                Title = localization["native.commands.findDuplicates"],
                Content = new ScrollViewer { Content = content, MaxHeight = 500, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
                PrimaryButtonText = localization.Format("native.commands.removeDuplicates", ("count", removeCount.ToString(System.Globalization.CultureInfo.CurrentCulture))),
                CloseButtonText = localization["native.common.cancel"],
                DefaultButton = ContentDialogButton.Close,
                XamlRoot = Root.XamlRoot
            };
            if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;

            var selections = selectors.Select(item => new NativeSnippetDuplicateSelection(
                item.Key,
                selectorItems[item.Key][Math.Clamp(item.Value.SelectedIndex, 0, selectorItems[item.Key].Count - 1)].Id,
                selectorItems[item.Key].Select(snippet => snippet.Id).ToArray())).ToArray();
            var removed = CommandViewModel.RemoveDuplicates(selections);
            CommandGroups.SelectedItem = CommandViewModel.SelectedGroup;
            CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet;
            Status.Text = localization.Format("native.commands.duplicatesRemoved", ("count", removed.ToString(System.Globalization.CultureInfo.CurrentCulture)));
        }
        catch (Exception error) { ShowError(error); }
    }

    private async Task SaveComposedSnippetAsync(string command, bool autoEnter)
    {
        var name = new TextBox { Header = localization["snippet.name"], MaxLength = 200 };
        var groups = commandLibrary.ListGroups();
        var group = new ComboBox
        {
            Header = localization["native.group"], ItemsSource = groups,
            DisplayMemberPath = nameof(NativeSnippetGroup.Name), HorizontalAlignment = HorizontalAlignment.Stretch
        };
        group.SelectedItem = groups.FirstOrDefault(item => item.Id == CommandViewModel.SelectedGroup?.Id) ?? groups.FirstOrDefault();
        // An empty library needs a group, but create it only after Save.
        var newGroup = new TextBox { Header = localization["native.commands.newGroup"], MaxLength = 200, Visibility = groups.Count == 0 ? Visibility.Visible : Visibility.Collapsed };
        group.Visibility = groups.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        var dialog = new ContentDialog
        {
            Title = localization["commandEditor.saveAsSnippetName"], XamlRoot = Root.XamlRoot,
            PrimaryButtonText = localization["common.save"], CloseButtonText = localization["common.cancel"],
            Content = new StackPanel { Spacing = 12, Children = { name, group, newGroup } }
        };
        void Validate() => dialog.IsPrimaryButtonEnabled = !string.IsNullOrWhiteSpace(name.Text) && (group.SelectedItem is NativeSnippetGroup || !string.IsNullOrWhiteSpace(newGroup.Text));
        name.TextChanged += (_, _) => Validate(); newGroup.TextChanged += (_, _) => Validate(); group.SelectionChanged += (_, _) => Validate(); Validate();
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return;
        var selected = group.SelectedItem as NativeSnippetGroup ?? CommandViewModel.SaveGroup(null, newGroup.Text);
        CommandViewModel.SelectedGroup = selected;
        CommandViewModel.Query = ""; CommandSearch.Text = "";
        CommandViewModel.SaveSnippet(null, name.Text, command, autoEnter);
        CommandGroups.SelectedItem = CommandViewModel.Groups.FirstOrDefault(item => item.Id == selected.Id);
        CommandSnippets.SelectedItem = CommandViewModel.SelectedSnippet;
        Status.Text = localization["conn.saved"];
    }
}
