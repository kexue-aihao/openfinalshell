using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.App.ViewModels;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.Controls;

public sealed partial class NativeSftpBrowser
{
    private sealed record DirectoryNodeInfo(string Path, string Name)
    {
        public override string ToString() => Name;
    }
    private readonly TreeView directoryTree = new() { SelectionMode = TreeViewSelectionMode.Single };
    private readonly Dictionary<string, TreeViewNode> directoryNodes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IReadOnlyList<RemoteEntry>> directoryCache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> directoryRequests = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource directoryTreeCancellation = new();
    private long directoryRequestVersion;
    private bool synchronizingDirectoryTree;

    private Grid CreateDirectoryPane(FrameworkElement table)
    {
        AutomationProperties.SetName(directoryTree, text("sftp.colName"));
        AutomationProperties.SetAutomationId(directoryTree, "SftpDirectoryTree");
        directoryTree.ItemTemplate = (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><StackPanel Orientation=\"Horizontal\" Spacing=\"4\"><FontIcon Glyph=\"&#xE8B7;\" FontSize=\"12\"/><TextBlock Text=\"{Binding Content.Name}\" FontSize=\"12\" TextTrimming=\"CharacterEllipsis\"/></StackPanel></DataTemplate>");
        directoryTree.Resources["TreeViewItemMinHeight"] = 26d;
        directoryTree.ItemContainerStyle = new Style(typeof(TreeViewItem))
        {
            Setters = { new Setter(Control.MinHeightProperty, 26d), new Setter(Control.FontSizeProperty, 12d), new Setter(Control.PaddingProperty, new Thickness(0)) }
        };
        EnsureDirectoryNode("/");
        directoryTree.Expanding += async (_, args) =>
        {
            if (synchronizingDirectoryTree || disposed) return;
            if (args.Node.Content is DirectoryNodeInfo { Path: string directory } && !directoryCache.ContainsKey(directory))
                await LoadDirectoryNodeAsync(directory);
        };
        directoryTree.ItemInvoked += async (_, args) =>
        {
            if (disposed || args.InvokedItem is not TreeViewNode { Content: DirectoryNodeInfo { Path: string directory } }) return;
            if (directory != viewModel.CurrentPath) await NavigateAsync(directory);
        };
        var pane = new Grid();
        var treeColumn = new ColumnDefinition { Width = new(180) };
        pane.ColumnDefinitions.Add(treeColumn); pane.ColumnDefinitions.Add(new() { Width = new(6) }); pane.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) });
        var splitter = new Thumb { Width = 6, Background = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Brush };
        splitter.DragDelta += (_, args) => treeColumn.Width = new(Math.Clamp(treeColumn.ActualWidth + args.HorizontalChange, 120, Math.Max(120, Math.Min(320, pane.ActualWidth * .4))));
        pane.Children.Add(directoryTree); pane.Children.Add(splitter); Grid.SetColumn(splitter, 1);
        pane.Children.Add(table); Grid.SetColumn(table, 2);
        return pane;
    }

    private TreeViewNode EnsureDirectoryNode(string directory)
    {
        if (!directoryNodes.TryGetValue(directory, out var node))
        {
            var name = directory == "/" ? "/" : directory[(directory.LastIndexOf('/') + 1)..];
            node = new TreeViewNode
            {
                HasUnrealizedChildren = true,
                Content = new DirectoryNodeInfo(directory, name)
            };
            directoryNodes[directory] = node;
        }
        if (directory == "/")
        { if (!directoryTree.RootNodes.Contains(node)) directoryTree.RootNodes.Add(node); }
        else
        {
            var parent = EnsureDirectoryNode(SftpBrowserViewModel.ParentPath(directory));
            if (!ReferenceEquals(node.Parent, parent)) parent.Children.Add(node);
        }
        return node;
    }

    private void PopulateDirectoryNode(string directory, IReadOnlyList<RemoteEntry> children)
    {
        if (!directoryNodes.TryGetValue(directory, out var node)) return;
        var allPaths = children.Select(entry => entry.Path).ToHashSet(StringComparer.Ordinal);
        // Forget deleted directories, including cached descendants and pending
        // requests, so later filtering cannot bring an obsolete branch back.
        foreach (var path in directoryNodes.Keys.Where(path => path != "/" && SftpBrowserViewModel.ParentPath(path) == directory && !allPaths.Contains(path)).ToArray())
            ForgetDirectoryNode(path);
        var visible = children.Where(entry => hidden.IsOn || !entry.Name.StartsWith('.')).OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        var wanted = visible.Select(entry => entry.Path).ToHashSet(StringComparer.Ordinal);
        foreach (var child in node.Children.ToArray())
            if (child.Content is DirectoryNodeInfo { Path: string path } && !wanted.Contains(path)) node.Children.Remove(child);
        for (var index = 0; index < visible.Length; index++)
        {
            var entry = visible[index];
            if (!directoryNodes.TryGetValue(entry.Path, out var child))
            {
                child = new TreeViewNode { HasUnrealizedChildren = true, Content = new DirectoryNodeInfo(entry.Path, entry.Name) };
                directoryNodes[entry.Path] = child;
            }
            if (index < node.Children.Count && ReferenceEquals(node.Children[index], child)) continue;
            var expanded = child.IsExpanded;
            node.Children.Remove(child);
            node.Children.Insert(index, child);
            child.IsExpanded = expanded;
        }
        node.HasUnrealizedChildren = false;
    }

    private void ForgetDirectoryNode(string directory)
    {
        foreach (var path in directoryNodes.Keys.Where(path => path == directory || path.StartsWith(directory + "/", StringComparison.Ordinal)).ToArray())
        {
            var node = directoryNodes[path];
            node.Parent?.Children.Remove(node);
            directoryNodes.Remove(path); directoryCache.Remove(path); directoryRequests.Remove(path);
        }
    }

    private void SynchronizeDirectoryTree()
    {
        if (disposed || !viewModel.HasLoadedDirectory) return;
        synchronizingDirectoryTree = true;
        try
        {
            var directory = viewModel.CurrentPath;
            directoryRequests[directory] = ++directoryRequestVersion;
            var children = viewModel.DirectoryEntries.Where(entry => entry.IsDirectory && entry.Name is not ("." or "..")).ToArray();
            directoryCache[directory] = children;
            var node = EnsureDirectoryNode(directory);
            PopulateDirectoryNode(directory, children);
            for (var ancestor = node; ancestor != null; ancestor = ancestor.Parent) ancestor.IsExpanded = true;
            directoryTree.SelectedNode = node;
        }
        finally { synchronizingDirectoryTree = false; }
    }

    private void RefreshDirectoryTreeFilter()
    {
        if (disposed) return;
        synchronizingDirectoryTree = true;
        try
        {
            // Traverse attached branches only. Hidden cached descendants must
            // not recreate their detached ancestors while the filter is off.
            void Refresh(TreeViewNode node)
            {
                if (node.Content is DirectoryNodeInfo { Path: string path } && directoryCache.TryGetValue(path, out var children))
                    PopulateDirectoryNode(path, children);
                foreach (var child in node.Children.ToArray()) Refresh(child);
            }
            foreach (var root in directoryTree.RootNodes.ToArray()) Refresh(root);
        }
        finally { synchronizingDirectoryTree = false; }
        SynchronizeDirectoryTree();
    }

    private async Task LoadDirectoryNodeAsync(string directory)
    {
        var request = ++directoryRequestVersion;
        directoryRequests[directory] = request;
        try
        {
            var values = await session.ListAsync(directory, directoryTreeCancellation.Token);
            if (disposed || directoryRequests.GetValueOrDefault(directory) != request) return;
            var children = values.Where(entry => entry.IsDirectory && entry.Name is not ("." or "..")).ToArray();
            directoryCache[directory] = children;
            PopulateDirectoryNode(directory, children);
        }
        catch (OperationCanceledException) when (disposed) { }
        catch (Exception error) { if (!disposed) status.Text = error.Message; }
    }
}
