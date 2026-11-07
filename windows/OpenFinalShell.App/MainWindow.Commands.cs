using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
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
        terminal.Send(line); ActivatePage("connections"); terminal.Focus(FocusState.Programmatic);
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
