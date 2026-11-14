using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.Controls;

/// <summary>A session picker shared by the snippet library and each command editor.</summary>
public sealed class NativeCommandTargets : DropDownButton
{
    private readonly NativeCommandTargetSelection selection = new();
    private readonly ListView sessions = new() { SelectionMode = ListViewSelectionMode.None, MaxHeight = 280 };
    private readonly Button current = new() { MinWidth = 0, FontSize = 12 };
    private readonly Button all = new() { MinWidth = 0, FontSize = 12 };
    private readonly TextBlock hint = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap, Opacity = .75 };
    private readonly TextBlock empty = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock label = new() { FontSize = 12, MaxWidth = 110, TextTrimming = TextTrimming.CharacterEllipsis };
    private Func<string, string> text = key => key;
    private Func<IReadOnlyList<NativeSessionSnapshot>> readSessions = () => [];
    private Func<string?> readCurrent = () => null;
    private bool open;

    public NativeCommandTargets()
    {
        MinWidth = 100; MinHeight = 28; Padding = new Thickness(8, 2, 8, 2); Content = label;
        var choices = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { current, all } };
        Flyout = new Flyout { Content = new StackPanel { Width = 300, Spacing = 8, Children = { choices, hint, sessions, empty } } };
        Flyout.Opening += (_, _) => { open = true; RefreshChoices(); };
        Flyout.Closed += (_, _) => open = false;
        current.Click += (_, _) => { selection.UseCurrent(); RefreshChoices(); };
        all.Click += (_, _) => { selection.UseAll(); RefreshChoices(); };
    }

    public void Configure(Func<string, string> localize, Func<IReadOnlyList<NativeSessionSnapshot>> availableSessions, Func<string?> currentSession)
    {
        text = localize; readSessions = availableSessions; readCurrent = currentSession;
        ConfigureLabels();
    }

    public void ConfigureLabels()
    {
        current.Content = text("commandEditor.targetCurrent"); all.Content = text("commandEditor.targetAll");
        hint.Text = text("commandEditor.targetSelectionHint"); empty.Text = text("commandEditor.noSessions");
        AutomationProperties.SetName(this, text("commandEditor.sendTo"));
        AutomationProperties.SetName(sessions, hint.Text);
        RefreshLabel();
    }

    public IReadOnlyList<string> ResolveSessionIds(bool currentOnly = false)
    {
        return selection.Resolve(readCurrent(), readSessions().Select(session => session.SessionId), currentOnly);
    }

    public void RefreshAvailableSessions()
    {
        if (open) RefreshChoices(); else RefreshLabel();
    }

    public void RefreshLabel()
    {
        var ready = readSessions();
        var selected = ready.Where(session => selection.SelectedSessionIds.Contains(session.SessionId)).ToArray();
        label.Text = selection.Mode switch
        {
            NativeCommandTargetMode.Current => text("commandEditor.targetCurrent"),
            NativeCommandTargetMode.All => text("commandEditor.targetAll"),
            _ when selected.Length == 1 => selected[0].ProfileName,
            _ => text("commandEditor.targetSelected").Replace("{{count}}", selected.Length.ToString())
        };
        ToolTipService.SetToolTip(this, selection.Mode == NativeCommandTargetMode.Selected && selected.Length > 0
            ? string.Join("\n", selected.Select(session => session.ProfileName)) : label.Text);
    }

    private void RefreshChoices()
    {
        var ready = readSessions();
        var selected = ResolveSessionIds().ToHashSet(StringComparer.Ordinal);
        sessions.Items.Clear();
        foreach (var session in ready)
        {
            var duplicateName = ready.Count(other => other.ProfileName == session.ProfileName) > 1;
            var name = session.ProfileName + (duplicateName ? " · " + session.SessionId[..Math.Min(6, session.SessionId.Length)] : "");
            var item = new CheckBox { Content = name, Tag = session.SessionId, IsChecked = selected.Contains(session.SessionId), MinHeight = 30 };
            item.Checked += SessionSelectionChanged;
            item.Unchecked += SessionSelectionChanged;
            sessions.Items.Add(item);
        }
        empty.Visibility = ready.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        sessions.Visibility = ready.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        RefreshLabel();
    }

    private void SessionSelectionChanged(object sender, RoutedEventArgs args)
    {
        if (sender is not CheckBox) return;
        selection.SetSelected(sessions.Items.OfType<CheckBox>().Where(checkBox => checkBox.IsChecked == true)
            .Select(checkBox => (string)checkBox.Tag));
        RefreshLabel();
    }
}
