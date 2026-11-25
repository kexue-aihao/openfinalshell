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
    private readonly Dictionary<string, ConnectionGroup> groupById = new(StringComparer.Ordinal);
    private IReadOnlyList<ConnectionProfile> profiles = [];
    private IReadOnlyList<ConnectionGroup> groups = [];
    private IReadOnlyDictionary<string, string> issues = new Dictionary<string, string>(StringComparer.Ordinal);
    private NativeSettings preferences = NativeSettings.Defaults;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? searchTimer;
    private string warningText = "";
    private string lastQuery = "";
    private bool hasSnapshot;
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
        searchTimer = DispatcherQueue.CreateTimer();
        searchTimer.Interval = TimeSpan.FromMilliseconds(150);
        searchTimer.IsRepeating = false;
        searchTimer.Tick += (_, _) => Rebuild();
        search.TextChanged += (_, _) => QueueSearch();
        search.KeyDown += (_, args) =>
        {
            if (args.Key == Windows.System.VirtualKey.Enter) { searchTimer?.Stop(); Rebuild(); args.Handled = true; }
            else if (args.Key == Windows.System.VirtualKey.Escape && search.Text.Length > 0)
            {
                search.Text = string.Empty;
                args.Handled = true;
            }
        };
        Unloaded += (_, _) => searchTimer?.Stop();
        tree.ItemInvoked += (_, args) =>
        {
            var item = Unwrap(args.InvokedItem);
            if (item is { Group: false }) ActionRequested?.Invoke("connect", item.Id, false);
        };
        tree.SelectionChanged += (_, _) =>
        {
            if (rebuilding) return;
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
        this.profiles = profiles; this.groups = groups;
        search.PlaceholderText = text("native.workbench.search");
        groupById.Clear();
        foreach (var group in groups) groupById[group.Id] = group;
        issues = NativeConnectionHierarchy.Issues(groups);
        preferences = NativeSettings.Load(store);
        var groupIds = new HashSet<string>(groupById.Keys, StringComparer.Ordinal);
        var warnings = new List<string>();
        foreach (var (id, key) in issues)
            if (groupById.TryGetValue(id, out var group)) warnings.Add($"⚠ {group.Name}: {text(key)}");
        warnings.AddRange(profiles
            .Where(profile => profile.Data["groupId"]?.GetValue<string>() is { } id && !groupIds.Contains(id))
            .Select(profile => $"⚠ {profile.Name}: {text("native.workbench.groupMissing")}"));
        warningText = string.Join("\n", warnings);
        Rebuild(force: true);
    }

    private void QueueSearch()
    {
        if (searchTimer == null) { Rebuild(); return; }
        searchTimer.Stop();
        searchTimer.Start();
    }

    private void Rebuild(bool force = false)
    {
        var query = search.Text.Trim();
        if (!force && hasSnapshot && string.Equals(query, lastQuery, StringComparison.Ordinal)) return;
        lastQuery = query;
        hasSnapshot = true;

        var grouped = preferences.ConnectionGrouping == "group";
        var mask = preferences.MaskHostInList;
        var offset = query.Length == 0 ? CurrentScrollOffset() : 0;
        var matchingGroups = new HashSet<string>(StringComparer.Ordinal);
        if (query.Length > 0)
        {
            foreach (var group in groups)
            {
                var visited = new HashSet<string>(StringComparer.Ordinal);
                ConnectionGroup? current = group;
                while (current != null && visited.Add(current.Id))
                {
                    if (current.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase)) { matchingGroups.Add(group.Id); break; }
                    current = current.ParentId != null && groupById.TryGetValue(current.ParentId, out var parent) ? parent : null;
                }
            }
        }

        var visible = new HashSet<string>(StringComparer.Ordinal);
        void Include(string? id)
        {
            while (id != null && visible.Add(id))
                id = issues.ContainsKey(id) || !groupById.TryGetValue(id, out var group) ? null : group.ParentId;
        }

        var selectedProfileId = selectedGroup ? null : selectedId;
        var selectedGroupId = selectedGroup ? selectedId : null;
        var visibleProfiles = new List<ConnectionProfile>();
        foreach (var profile in profiles)
        {
            var group = profile.Data["groupId"]?.GetValue<string>();
            var matchesText = query.Length == 0 ||
                $"{profile.Name} {profile.Host} {profile.Username}".Contains(query, StringComparison.CurrentCultureIgnoreCase);
            if (query.Length > 0 && !matchesText && (group == null || !matchingGroups.Contains(group))) continue;
            visibleProfiles.Add(profile);
            if (grouped) Include(group);
        }
        if (grouped)
        {
            if (query.Length == 0) foreach (var group in groups) Include(group.Id);
            else foreach (var group in groups) if (matchingGroups.Contains(group.Id)) Include(group.Id);
        }

        rebuilding = true;
        try
        {
            tree.RootNodes.Clear();
            warning.Text = warningText;
            var nodes = new Dictionary<string, TreeViewNode>(StringComparer.Ordinal);
            if (grouped)
            {
                foreach (var group in groups)
                {
                    var item = new Item(group.Id, true, group.Name);
                    nodes[group.Id] = new TreeViewNode
                    {
                        Content = ItemVisual(item, new FontIcon { Glyph = "\uE8B7", FontSize = 15 }, group.Name),
                        IsExpanded = expanded.Contains(group.Id) || (query.Length > 0 && visible.Contains(group.Id))
                    };
                }
            }

            TreeViewNode? selectedNode = null;
            foreach (var profile in visibleProfiles)
            {
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
                var group = profile.Data["groupId"]?.GetValue<string>();
                if (grouped && group != null && nodes.TryGetValue(group, out var parent)) parent.Children.Add(node);
                else tree.RootNodes.Add(node);
                if (selectedProfileId == profile.Id) selectedNode = node;
            }

            if (grouped)
            {
                foreach (var group in groups.OrderBy(group => group.Order).ThenBy(group => group.Name))
                {
                    if (!visible.Contains(group.Id)) continue;
                    var node = nodes[group.Id];
                    if (!issues.ContainsKey(group.Id) && group.ParentId != null && nodes.TryGetValue(group.ParentId, out var parent)) parent.Children.Add(node);
                    else tree.RootNodes.Add(node);
                    if (selectedGroupId == group.Id) selectedNode = node;
                }
            }
            if (selectedNode != null) tree.SelectedNode = selectedNode;
            if (tree.RootNodes.Count == 0 && query.Length > 0)
                warning.Text = warningText.Length == 0
                    ? text("native.workbench.noMatches")
                    : warningText + "\n" + text("native.workbench.noMatches");
        }
        finally { rebuilding = false; }
        if (offset > 0) RestoreScrollOffset(offset);
    }

    private double CurrentScrollOffset()
    {
        try { return FindScrollViewer(tree)?.VerticalOffset ?? 0; }
        catch { return 0; }
    }

    private void RestoreScrollOffset(double offset)
    {
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            try
            {
                var viewer = FindScrollViewer(tree);
                if (viewer == null || Math.Abs(viewer.VerticalOffset - offset) < 1) return;
                tree.UpdateLayout();
                viewer.ChangeView(null, offset, null, true);
            }
            catch { /* a newer rebuild owns the viewport; let the next pass win */ }
        });
    }

    private static ScrollViewer? FindScrollViewer(DependencyObject? root)
    {
        if (root == null) return null;
        var count = VisualTreeHelper.GetChildrenCount(root);
        for (var index = 0; index < count; index++)
        {
            var child = VisualTreeHelper.GetChild(root, index);
            if (child is ScrollViewer viewer) return viewer;
            if (FindScrollViewer(child) is { } nested) return nested;
        }
        return null;
    }
}
