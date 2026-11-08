using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Input;
using OpenFinalShell.Core;
using System.Text.Json.Nodes;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;

namespace OpenFinalShell.App.Controls;

public sealed class NativeConnectionTree : UserControl
{
    private sealed record Item(string Id, bool Group, string Label)
    {
        public override string ToString() => Label;
    }
    private readonly TreeView tree = new() { CanDragItems = true, CanReorderItems = false, AllowDrop = true };
    private readonly TextBox search = new();
    private readonly TextBlock warning = new() { TextWrapping = TextWrapping.Wrap };
    private readonly NativeStore store;
    private readonly Func<string, string> text;
    private readonly HashSet<string> expanded = new(StringComparer.Ordinal);
    private IReadOnlyList<ConnectionProfile> profiles = [];
    private IReadOnlyList<ConnectionGroup> groups = [];
    private bool rebuilding;
    private string? selectedId;
    private bool selectedGroup;
    public event Action<string, string?, bool>? ActionRequested;
    public event Action<Exception>? Failed;
    public event Action? Changed;

    public NativeConnectionTree(NativeStore store, Func<string, string> text)
    {
        this.store = store; this.text = text;
        tree.ItemTemplate = (DataTemplate)Application.Current.Resources["NativeConnectionTreeNodeTemplate"];
        AutomationProperties.SetName(tree, text("activity.connections"));
        search.TextChanged += (_, _) => Rebuild();
        tree.ItemInvoked += (_, args) =>
        {
            var item = Unwrap(args.InvokedItem);
            if (item is { Group: false }) ActionRequested?.Invoke("connect", item.Id, false);
        };
        tree.SelectionChanged += (_, _) =>
        {
            if (Unwrap(tree.SelectedItem) is not { } item) return;
            selectedId = item.Id; selectedGroup = item.Group;
            ActionRequested?.Invoke("select", item.Id, item.Group);
        };
        tree.Expanding += (_, args) => { if (!rebuilding && Unwrap(args.Node) is { } item) { expanded.Add(item.Id); SaveExpanded(); } };
        tree.Collapsed += (_, args) => { if (!rebuilding && Unwrap(args.Node) is { } item) { expanded.Remove(item.Id); SaveExpanded(); } };
        tree.RightTapped += ShowMenu;
        tree.KeyDown += (_, args) =>
        {
            if (args.Key == Windows.System.VirtualKey.F2) { ActionRequested?.Invoke("edit", selectedId, selectedGroup); args.Handled = true; }
            if (args.Key == Windows.System.VirtualKey.Delete) { ActionRequested?.Invoke("delete", selectedId, selectedGroup); args.Handled = true; }
            if (args.Key == Windows.System.VirtualKey.Application ||
                args.Key == Windows.System.VirtualKey.F10 &&
                (InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift) & Windows.UI.Core.CoreVirtualKeyStates.Down) != 0)
            {
                var selected = selectedId == null ? null : new Item(selectedId, selectedGroup,
                    selectedGroup ? groups.FirstOrDefault(group => group.Id == selectedId)?.Name ?? selectedId :
                    profiles.FirstOrDefault(profile => profile.Id == selectedId)?.Name ?? selectedId);
                var point = new Point(8, 8);
                if (selected != null)
                {
                    var node = Flatten(tree.RootNodes).FirstOrDefault(item => Unwrap(item) is { } value && value.Id == selected.Id && value.Group == selected.Group);
                    if (node != null && tree.ContainerFromNode(node) is UIElement container)
                    {
                        try { point = container.TransformToVisual(tree).TransformPoint(new Point(4, Math.Max(0, container.RenderSize.Height / 2))); }
                        catch { /* use the safe tree origin when the item is virtualized */ }
                    }
                }
                ShowMenu(selected, point);
                args.Handled = true;
            }
        };
        tree.DragItemsStarting += (_, args) =>
        {
            var item = args.Items.Select(Unwrap).FirstOrDefault(x => x != null);
            if (item == null) { args.Cancel = true; return; }
            args.Data.SetData("OpenFinalShell.ConnectionTree", (item.Group ? "group:" : "profile:") + item.Id);
            args.Data.RequestedOperation = DataPackageOperation.Move;
        };
        tree.DragOver += (_, args) => { if (args.DataView.Contains("OpenFinalShell.ConnectionTree")) { args.AcceptedOperation = DataPackageOperation.Move; args.Handled = true; } };
        tree.Drop += async (_, args) =>
        {
            if (!args.DataView.Contains("OpenFinalShell.ConnectionTree")) return;
            args.Handled = true;
            var deferral = args.GetDeferral();
            var target = Target(args.OriginalSource as DependencyObject);
            var parentId = target is { Group: true } ? target.Id : profiles.FirstOrDefault(p => p.Id == target?.Id)?.Data["groupId"]?.GetValue<string>();
            try
            {
                var value = (await args.DataView.GetDataAsync("OpenFinalShell.ConnectionTree"))?.ToString() ?? "";
                var colon = value.IndexOf(':'); if (colon < 0) return;
                var id = value[(colon + 1)..]; var isGroup = value[..colon] == "group";
                var kind = isGroup ? "groups" : "profiles";
                var current = store.Find(kind, id) ?? throw new InvalidOperationException(text("native.validationFailed"));
                current[isGroup ? "parentId" : "groupId"] = parentId;
                if (isGroup) store.SaveConnectionGroup(id, current, current["_revision"]!.GetValue<long>());
                else store.Save(kind, id, current, current["_revision"]!.GetValue<long>());
                Changed?.Invoke();
            }
            catch (Exception error) { Failed?.Invoke(error); }
            finally { deferral.Complete(); }
        };
        if (store.Find("nativeWorkspace", "nativeWorkspace")?["expandedGroups"] is JsonArray saved)
            foreach (var id in saved) if (id?.GetValue<string>() is { } value) expanded.Add(value);
        var root = new Grid { RowSpacing = 8, RowDefinitions = { new() { Height = GridLength.Auto }, new() { Height = GridLength.Auto }, new() { Height = new(1, GridUnitType.Star) } } };
        var toolbar = new Grid { ColumnSpacing = 4 };
        toolbar.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        toolbar.ColumnDefinitions.Add(new() { Width = GridLength.Auto }); toolbar.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var add = new Button { Content = new FontIcon { Glyph = "\uE710", FontSize = 14 }, Width = 28, Height = 28, Padding = new Thickness(0) };
        var folder = new Button { Content = new FontIcon { Glyph = "\uE8F4", FontSize = 14 }, Width = 28, Height = 28, Padding = new Thickness(0) };
        AutomationProperties.SetName(add, text("sidebar.newConnection")); AutomationProperties.SetName(folder, text("sidebar.newGroup"));
        ToolTipService.SetToolTip(add, text("sidebar.newConnection")); ToolTipService.SetToolTip(folder, text("sidebar.newGroup"));
        add.Click += (_, _) => ActionRequested?.Invoke("new", null, false);
        folder.Click += (_, _) => ActionRequested?.Invoke("newGroup", null, true);
        toolbar.Children.Add(search); toolbar.Children.Add(add); toolbar.Children.Add(folder);
        Grid.SetColumn(add, 1); Grid.SetColumn(folder, 2);
        root.Children.Add(toolbar); root.Children.Add(warning); root.Children.Add(tree);
        Grid.SetRow(warning, 1); Grid.SetRow(tree, 2); Content = root;
    }
    private void SaveExpanded()
    {
        try { store.Patch("nativeWorkspace", "nativeWorkspace", new() { ["expandedGroups"] = new JsonArray(expanded.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()) }); }
        catch (Exception error) { Failed?.Invoke(error); }
    }
    private static Item? Unwrap(object? value) => value switch
    {
        TreeViewNode node => Unwrap(node.Content),
        FrameworkElement element => element.Tag as Item,
        Item item => item,
        _ => null
    };
    private static FrameworkElement ItemVisual(Item item, FrameworkElement marker, string title, string? detail = null)
    {
        var row = new Grid { ColumnSpacing = 8, MinHeight = detail == null ? 32 : 42, Padding = new Thickness(2, 3, 2, 3), Tag = item };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        marker.VerticalAlignment = VerticalAlignment.Top;
        row.Children.Add(marker);
        var labels = new StackPanel { Spacing = 1 };
        labels.Children.Add(new TextBlock { Text = title, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 12, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold });
        if (detail != null) labels.Children.Add(new TextBlock { Text = detail, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 11, Opacity = .7 });
        row.Children.Add(labels);
        Grid.SetColumn(labels, 1);
        return row;
    }
    private static IEnumerable<TreeViewNode> Flatten(IEnumerable<TreeViewNode> roots)
    {
        foreach (var node in roots)
        {
            yield return node;
            foreach (var child in Flatten(node.Children)) yield return child;
        }
    }
    private Item? Target(DependencyObject? source)
    {
        while (source != null)
        {
            if (source is TreeViewItem container) return Unwrap(tree.NodeFromContainer(container));
            source = VisualTreeHelper.GetParent(source);
        }
        return null;
    }
    private void ShowMenu(object sender, RightTappedRoutedEventArgs args)
    {
        args.Handled = true;
        var target = Target(args.OriginalSource as DependencyObject);
        ShowMenu(target, args.GetPosition(tree));
    }

    private void ShowMenu(Item? target, Point position)
    {
        var menu = new MenuFlyout();
        void Add(string action, string key)
        {
            var button = new MenuFlyoutItem { Text = text(key) };
            AutomationProperties.SetName(button, button.Text);
            button.Click += (_, _) => ActionRequested?.Invoke(action, target?.Id, target?.Group ?? false);
            menu.Items.Add(button);
        }
        if (target is { Group: false })
        {
            Add("connect", "conn.connect"); Add("edit", "common.edit"); Add("duplicate", "conn.duplicate"); Add("copy", "conn.copySshCommand"); Add("delete", "common.delete");
        }
        else
        {
            Add("new", "sidebar.newConnection"); Add("newGroup", "sidebar.newGroup");
            if (target != null) { Add("edit", "common.rename"); Add("delete", "common.delete"); }
        }
        if (target != null) Add("ungroup", "native.workbench.moveToRoot");
        menu.ShowAt(tree, position);
    }
    public void Reload(IReadOnlyList<ConnectionProfile> profiles, IReadOnlyList<ConnectionGroup> groups)
    {
        this.profiles = profiles; this.groups = groups; search.PlaceholderText = text("native.workbench.search"); Rebuild();
    }
    private void Rebuild()
    {
        rebuilding = true;
        try
        {
            tree.RootNodes.Clear();
            var query = search.Text.Trim();
            var issues = NativeConnectionHierarchy.Issues(groups);
            var preferences = NativeSettings.Load(store);
            var grouped = preferences.ConnectionGrouping == "group";
            var warnings = issues.Select(pair => $"⚠ {groups.First(g => g.Id == pair.Key).Name}: {text(pair.Value)}").ToList();
            var groupIds = groups.Select(g => g.Id).ToHashSet(StringComparer.Ordinal);
            warnings.AddRange(profiles.Where(p => p.Data["groupId"]?.GetValue<string>() is { } id && !groupIds.Contains(id))
                .Select(p => $"⚠ {p.Name}: {text("native.workbench.groupMissing")}"));
            warning.Text = string.Join("\n", warnings);
            var nodes = groups.ToDictionary(g => g.Id, g =>
            {
                var item = new Item(g.Id, true, g.Name);
                return new TreeViewNode
                {
                    Content = ItemVisual(item, new FontIcon { Glyph = "\uE8B7", FontSize = 15 }, g.Name),
                    IsExpanded = query.Length > 0 || expanded.Contains(g.Id)
                };
            });
            var visible = new HashSet<string>(StringComparer.Ordinal);
            void Include(string? id)
            {
                while (id != null && visible.Add(id)) id = issues.ContainsKey(id) ? null : groups.FirstOrDefault(g => g.Id == id)?.ParentId;
            }
            var mask = preferences.MaskHostInList;
            var matchingGroups = new HashSet<string>(StringComparer.Ordinal);
            if (query.Length > 0)
            {
                foreach (var group in groups)
                {
                    var visited = new HashSet<string>(StringComparer.Ordinal);
                    var current = group;
                    while (current != null && visited.Add(current.Id))
                    {
                        if (current.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase)) { matchingGroups.Add(group.Id); break; }
                        current = groups.FirstOrDefault(g => g.Id == current.ParentId);
                    }
                }
            }
            foreach (var profile in profiles)
            {
                var group = profile.Data["groupId"]?.GetValue<string>();
                if (query.Length > 0 && !($"{profile.Name} {profile.Host} {profile.Username}".Contains(query, StringComparison.CurrentCultureIgnoreCase)) && (group == null || !matchingGroups.Contains(group))) continue;
                Include(group);
                var host = mask && profile.Host.Length > 6 ? profile.Host[..3] + "•••" + profile.Host[^3..] : profile.Host;
                var item = new Item(profile.Id, false, profile.Name);
                var markerCode = NativeRegionMarker.EffectiveCode(profile.Data["flag"]?.GetValue<string>(), profile.Host);
                FrameworkElement marker = markerCode == null
                    ? new FontIcon { Glyph = profile.Data["protocol"]?.GetValue<string>() == "rdp" ? "\uE9D9" : "\uE756", FontSize = 15 }
                    : NativeRegionMarker.Create(markerCode, 16);
                var node = new TreeViewNode
                {
                    Content = ItemVisual(item, marker, profile.Name, $"{profile.Username}@{host}:{profile.Port}")
                };
                if (grouped && group != null && nodes.TryGetValue(group, out var parent)) parent.Children.Add(node); else tree.RootNodes.Add(node);
                if (selectedId == profile.Id && !selectedGroup) tree.SelectedNode = node;
            }
            if (!grouped) return;
            foreach (var group in groups) if (query.Length == 0 || matchingGroups.Contains(group.Id)) Include(group.Id);
            foreach (var group in groups.OrderBy(g => g.Order).ThenBy(g => g.Name))
            {
                if (!visible.Contains(group.Id)) continue;
                var node = nodes[group.Id];
                if (!issues.ContainsKey(group.Id) && group.ParentId != null && nodes.TryGetValue(group.ParentId, out var parent)) parent.Children.Add(node);
                else tree.RootNodes.Add(node);
                if (selectedGroup && selectedId == group.Id) tree.SelectedNode = node;
            }
        }
        finally { rebuilding = false; }
    }
}
