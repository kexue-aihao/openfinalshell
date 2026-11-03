using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.App.ViewModels;
using OpenFinalShell.Core;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace OpenFinalShell.App.Controls;

/// <summary>Native SFTP browser backed by the same session as its terminal tab.</summary>
public sealed class NativeSftpBrowser : UserControl
{
    private const int MaximumDirectoryTransferFiles = 5000;
    private const int MaximumDirectoryDepth = 32;
    private readonly NativeSession session;
    private readonly NativeTransferQueue transfers;
    private readonly SftpBrowserViewModel viewModel;
    private readonly Func<nint> windowHandle;
    private readonly Func<string, string> text;
    private readonly Action<string> openFile;
    private readonly TextBox path = new() { MinWidth = 260 };
    private readonly ListView entries = new() { SelectionMode = ListViewSelectionMode.Single, IsItemClickEnabled = true };
    private readonly TextBlock status = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Button up = new(), refresh = new(), upload = new(), uploadFolder = new(), download = new(), newFolder = new(), newFile = new(), rename = new(), chmod = new(), delete = new();
    private string browseLabel = "Refresh";
    private string uploadLabel = "Upload";
    private string downloadLabel = "Download";
    private string newFolderLabel = "New folder";
    private string deleteLabel = "Delete";
    private bool initialized;

    public NativeSftpBrowser(NativeSession session, NativeTransferQueue transfers, Func<nint> windowHandle, Func<string, string> text, Action<string>? openFile = null)
    {
        this.session = session; this.transfers = transfers; this.windowHandle = windowHandle; this.text = text;
        this.openFile = openFile ?? (_ => { });
        viewModel = new SftpBrowserViewModel(session);
        browseLabel = text("native.sftp.refresh"); uploadLabel = text("native.sftp.upload"); downloadLabel = text("native.sftp.download");
        newFolderLabel = text("native.sftp.newFolder"); deleteLabel = text("native.sftp.delete");
        up.Content = text("native.sftp.up"); refresh.Content = browseLabel; upload.Content = uploadLabel; uploadFolder.Content = text("native.sftp.uploadFolder"); download.Content = downloadLabel;
        newFolder.Content = newFolderLabel; newFile.Content = text("native.sftp.newFile"); rename.Content = text("native.sftp.rename"); chmod.Content = text("native.sftp.chmod"); delete.Content = deleteLabel;
        path.KeyDown += async (_, args) => { if (args.Key == Windows.System.VirtualKey.Enter) { await NavigateAsync(path.Text); args.Handled = true; } };
        up.Click += async (_, _) => await RunAsync(() => viewModel.GoUpAsync());
        refresh.Click += async (_, _) => await RunAsync(() => viewModel.RefreshAsync());
        upload.Click += async (_, _) => await UploadAsync();
        uploadFolder.Click += async (_, _) => await UploadFolderAsync();
        download.Click += async (_, _) => await DownloadAsync();
        newFolder.Click += async (_, _) => await CreateFolderAsync();
        newFile.Click += async (_, _) => await CreateFileAsync();
        rename.Click += async (_, _) => await RenameAsync();
        chmod.Click += async (_, _) => await ChmodAsync();
        delete.Click += async (_, _) => await DeleteAsync();
        entries.ItemsSource = viewModel.Entries;
        entries.ItemTemplate = (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><StackPanel Orientation=\"Horizontal\" Spacing=\"8\"><TextBlock Text=\"{Binding Name}\"/><TextBlock Text=\"{Binding Type}\" Opacity=\"0.65\"/><TextBlock Text=\"{Binding Size}\" Opacity=\"0.65\"/></StackPanel></DataTemplate>");
        entries.ItemClick += async (_, args) =>
        {
            if (args.ClickedItem is not RemoteEntry item) return;
            if (item.IsDirectory) await NavigateAsync(item.Path);
            else if (item.Type is NativeRemoteEntryType.File or NativeRemoteEntryType.Symlink) this.openFile(item.Path);
        };
        entries.SelectionChanged += (_, _) => viewModel.Selected = entries.SelectedItem as RemoteEntry;
        viewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(SftpBrowserViewModel.CurrentPath)) path.Text = viewModel.CurrentPath;
            if (args.PropertyName == nameof(SftpBrowserViewModel.Status)) status.Text = viewModel.Status;
        };

        entries.SelectionMode = ListViewSelectionMode.Extended;
        entries.AllowDrop = true;
        entries.DragOver += (_, args) =>
        {
            if (!args.DataView.Contains(StandardDataFormats.StorageItems)) return;
            args.AcceptedOperation = DataPackageOperation.Copy;
            args.Handled = true;
        };
        entries.Drop += async (_, args) => await DropFilesAsync(args);
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        foreach (var item in new Control[] { up, path, refresh, upload, uploadFolder, download, newFolder, newFile, rename, chmod, delete }) toolbar.Children.Add(item);
        Content = new Grid
        {
            RowDefinitions = { new RowDefinition { Height = GridLength.Auto }, new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }, new RowDefinition { Height = GridLength.Auto } },
            Children = { toolbar, entries, status }
        };
        Grid.SetRow(entries, 1); Grid.SetRow(status, 2);
        Loaded += async (_, _) =>
        {
            if (initialized) return;
            initialized = true;
            await NavigateAsync("/");
        };
    }

    private async Task NavigateAsync(string target)
    {
        try { await viewModel.NavigateAsync(await session.RealPathAsync(target, CancellationToken.None)); }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task RunAsync(Func<Task> action)
    {
        try { await action(); }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task UploadAsync()
    {
        var picker = new FileOpenPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, windowHandle());
        var file = await picker.PickSingleFileAsync(); if (file == null) return;
        var target = SftpBrowserViewModel.Combine(viewModel.CurrentPath, file.Name);
        var overwrite = await ConfirmOverwriteAsync(file.Name, target);
        if (!overwrite.HasValue) return;
        try
        {
            var stagedPath = await StageLocalFileAsync(file.Path);
            transfers.EnqueueUpload(session.SessionId, stagedPath, target, overwrite.Value, cleanupSource: true);
            status.Text = $"{file.Name} · {uploadLabel}";
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task<bool?> ConfirmOverwriteAsync(string name, string target)
    {
        if (await session.TryGetAsync(target, CancellationToken.None) == null) return false;
        var dialog = new ContentDialog
        {
            Title = text("native.sftp.conflictTitle"), Content = target,
            PrimaryButtonText = text("native.sftp.overwrite"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? true : null;
    }

    private async Task DropFilesAsync(DragEventArgs args)
    {
        if (!args.DataView.Contains(StandardDataFormats.StorageItems)) return;
        var targetDirectory = FindDropDirectory(args.OriginalSource) ?? viewModel.CurrentPath;
        try
        {
            var items = await args.DataView.GetStorageItemsAsync();
            var queued = 0;
            foreach (var item in items)
            {
                if (item is StorageFile file)
                {
                    var target = SftpBrowserViewModel.Combine(targetDirectory, file.Name);
                    var overwrite = await ConfirmOverwriteAsync(file.Name, target);
                    if (!overwrite.HasValue) continue;
                    var stagedPath = await StageLocalFileAsync(file.Path);
                    transfers.EnqueueUpload(session.SessionId, stagedPath, target, overwrite.Value, cleanupSource: true);
                    queued++;
                }
                else if (item is StorageFolder folder)
                {
                    var remoteRoot = SftpBrowserViewModel.Combine(targetDirectory, folder.Name);
                    queued += await EnqueueUploadTreeAsync(folder.Path, folder.Name, remoteRoot);
                }
            }
            status.Text = $"{queued} · {uploadLabel}";
            args.Handled = true;
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private string? FindDropDirectory(object? source)
    {
        var current = source as DependencyObject;
        while (current != null)
        {
            if (current is FrameworkElement element && element.DataContext is RemoteEntry { IsDirectory: true } entry)
                return entry.Path;
            current = VisualTreeHelper.GetParent(current);
        }
        return null;
    }

    private async Task DownloadAsync()
    {
        var selected = entries.SelectedItems.OfType<RemoteEntry>().ToArray();
        if (selected.Length == 0) return;
        if (selected.Length == 1 && !selected[0].IsDirectory)
        {
            var item = selected[0];
            var picker = new FileSavePicker { SuggestedFileName = item.Name }; var extension = Path.GetExtension(item.Name); picker.FileTypeChoices.Add("File", [string.IsNullOrWhiteSpace(extension) ? ".bin" : extension]); InitializeWithWindow.Initialize(picker, windowHandle());
            var file = await picker.PickSaveFileAsync(); if (file == null) return;
            try { EnsureDownloadTargetIsNotLink(file.Path); transfers.EnqueueDownload(session.SessionId, item.Path, file.Path); status.Text = $"{item.Name} · {downloadLabel}"; }
            catch (Exception error) { status.Text = error.Message; }
            return;
        }
        var folderPicker = new FolderPicker(); folderPicker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(folderPicker, windowHandle());
        var target = await folderPicker.PickSingleFolderAsync(); if (target == null) return;
        try
        {
            var destinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in selected)
            {
                var destination = GetSafeLocalPath(target.Path, item.Name);
                if (!destinations.Add(destination)) throw new IOException("Selected remote names collide on the case-insensitive local filesystem.");
                if (item.IsDirectory) await EnqueueDownloadTreeAsync(item, target.Path, destination);
                else { EnsureDownloadTargetIsNotLink(destination); transfers.EnqueueDownload(session.SessionId, item.Path, destination); }
            }
            status.Text = $"{selected.Length} · {downloadLabel}";
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private async Task EnqueueDownloadTreeAsync(RemoteEntry item, string localParent, string? knownLocalRoot = null)
    {
        var localRoot = knownLocalRoot ?? GetSafeLocalPath(localParent, item.Name);
        if (Directory.Exists(localRoot) && (File.GetAttributes(localRoot) & System.IO.FileAttributes.ReparsePoint) != 0)
            throw new IOException("A local symbolic link blocks the selected download path.");
        Directory.CreateDirectory(localRoot);
        var files = new List<(string RemotePath, string LocalPath, long Bytes)>();
        await CollectDownloadTreeAsync(item, localRoot, localRoot, files, 0, [0]);
        if (files.Select(file => file.LocalPath).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Count)
            throw new IOException("Remote filenames collide on the case-insensitive local filesystem.");
        var group = transfers.CreateGroup(session.SessionId, NativeTransferDirection.Download, item.Name, localRoot,
            files.Sum(file => file.Bytes), files.Count);
        foreach (var file in files)
            transfers.EnqueueDownload(session.SessionId, file.RemotePath, file.LocalPath, group);
    }

    private async Task CollectDownloadTreeAsync(RemoteEntry item, string localRoot, string localParent, List<(string RemotePath, string LocalPath, long Bytes)> files, int depth, int[] visited)
    {
        if (depth > MaximumDirectoryDepth) throw new IOException($"Directory transfers are limited to {MaximumDirectoryDepth} levels.");
        if (++visited[0] > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} entries.");
        if (files.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
        if (item.IsSymbolicLink) throw new IOException("Directory transfers do not follow remote symbolic links.");
        if (item.IsDirectory)
        {
            var children = await session.ListAsync(item.Path, CancellationToken.None);
            if (children.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} entries.");
            foreach (var child in children)
            {
                var childPath = GetSafeLocalPath(localParent, child.Name, localRoot);
                if (child.IsSymbolicLink) throw new IOException("Directory transfers do not follow remote symbolic links.");
                if (child.IsDirectory)
                {
                    if (Directory.Exists(childPath) && (File.GetAttributes(childPath) & System.IO.FileAttributes.ReparsePoint) != 0)
                        throw new IOException("A local symbolic link blocks the selected download path.");
                    Directory.CreateDirectory(childPath);
                    if (files.Count >= MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
                    await CollectDownloadTreeAsync(child, localRoot, childPath, files, depth + 1, visited);
                }
                else
                {
                    if (files.Count >= MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
                    files.Add((child.Path, childPath, Math.Max(0, child.Size)));
                }
            }
            return;
        }
        files.Add((item.Path, GetSafeLocalPath(localParent, item.Name, localRoot), Math.Max(0, item.Size)));
    }

    private async Task UploadFolderAsync()
    {
        var picker = new FolderPicker(); picker.FileTypeFilter.Add("*"); InitializeWithWindow.Initialize(picker, windowHandle());
        var folder = await picker.PickSingleFolderAsync(); if (folder == null) return;
        var remoteRoot = SftpBrowserViewModel.Combine(viewModel.CurrentPath, folder.Name);
        try
        {
            _ = await EnqueueUploadTreeAsync(folder.Path, folder.Name, remoteRoot);
            status.Text = $"{folder.Name} · {uploadLabel}";
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void CollectUploadTreeAsync(string localDirectory, string remoteDirectory, List<(string LocalPath, string RemotePath)> files, List<string> remoteDirectories, int depth, int[] visited)
    {
        if (depth > MaximumDirectoryDepth) throw new IOException($"Directory transfers are limited to {MaximumDirectoryDepth} levels.");
        if (++visited[0] > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} entries.");
        foreach (var child in Directory.EnumerateDirectories(localDirectory))
        {
            if ((File.GetAttributes(child) & System.IO.FileAttributes.ReparsePoint) != 0) continue;
            var remoteChild = SftpBrowserViewModel.Combine(remoteDirectory, Path.GetFileName(child));
            remoteDirectories.Add(remoteChild);
            CollectUploadTreeAsync(child, remoteChild, files, remoteDirectories, depth + 1, visited);
            if (files.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
        }
        foreach (var filePath in Directory.EnumerateFiles(localDirectory))
        {
            if ((File.GetAttributes(filePath) & System.IO.FileAttributes.ReparsePoint) != 0) continue;
            files.Add((filePath, SftpBrowserViewModel.Combine(remoteDirectory, Path.GetFileName(filePath))));
            if (files.Count > MaximumDirectoryTransferFiles) throw new IOException($"Directory transfers are limited to {MaximumDirectoryTransferFiles} files.");
        }
    }

    private async Task<int> EnqueueUploadTreeAsync(string localDirectory, string displayName, string remoteDirectory)
    {
        var files = new List<(string LocalPath, string RemotePath)>();
        var remoteDirectories = new List<string> { remoteDirectory };
        CollectUploadTreeAsync(localDirectory, remoteDirectory, files, remoteDirectories, 0, [0]);
        var conflicts = new List<string>();
        foreach (var file in files)
        {
            var existing = await session.TryGetAsync(file.RemotePath, CancellationToken.None);
            if (existing?.IsDirectory == true) throw new IOException($"Remote target is a directory: {file.RemotePath}");
            if (existing != null) conflicts.Add(file.RemotePath);
        }
        var overwrite = false;
        if (conflicts.Count > 0)
        {
            var dialog = new ContentDialog
            {
                Title = text("native.sftp.conflictTitle"),
                Content = $"{conflicts.Count} remote file(s) already exist. Overwrite them?\n{string.Join("\n", conflicts.Take(8))}",
                PrimaryButtonText = text("native.sftp.overwrite"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary) return 0;
            overwrite = true;
        }
        var staged = new List<(string TemporaryPath, string RemotePath)>();
        try
        {
            foreach (var filePath in files)
            {
                staged.Add((await StageLocalFileAsync(filePath.LocalPath), filePath.RemotePath));
            }
            foreach (var directory in remoteDirectories) await EnsureRemoteDirectoryAsync(directory);
            var group = transfers.CreateGroup(session.SessionId, NativeTransferDirection.Upload, displayName, remoteDirectory,
                staged.Sum(file => new FileInfo(file.TemporaryPath).Length), staged.Count);
            foreach (var file in staged)
                transfers.EnqueueUpload(session.SessionId, file.TemporaryPath, file.RemotePath, overwrite, cleanupSource: true, parentId: group);
            return staged.Count;
        }
        catch
        {
            foreach (var file in staged) { try { File.Delete(file.TemporaryPath); } catch { } }
            throw;
        }
    }

    private static Task<string> StageLocalFileAsync(string source)
    {
        return Task.Run(() =>
        {
            var directory = Path.Combine(Path.GetTempPath(), "OpenFinalShell.NativeTransfers");
            Directory.CreateDirectory(directory);
            var destination = Path.Combine(directory, Guid.NewGuid().ToString("N"), Path.GetFileName(source));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(source, destination, true);
            return destination;
        });
    }
    private static string GetSafeLocalPath(string parent, string name, string? root = null)
    {
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.Contains('/') || name.Contains('\\'))
            throw new IOException("Remote filename is not a safe local path segment.");
        if (name.EndsWith(' ') || name.EndsWith('.') || IsWindowsDeviceName(name))
            throw new IOException("Remote filename is reserved or ambiguous on Windows.");
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new IOException("Remote filename contains characters that are not valid on this Windows device.");
        var fullPath = Path.GetFullPath(Path.Combine(parent, name));
        var fullRoot = Path.GetFullPath(root ?? parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Remote filename escapes the selected local download folder.");
        return fullPath;
    }

    private static bool IsWindowsDeviceName(string name)
    {
        var stem = Path.GetFileNameWithoutExtension(name).TrimEnd(' ', '.');
        return stem.Equals("CON", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && stem[3] is >= '1' and <= '9');
    }

    private static void EnsureDownloadTargetIsNotLink(string path)
    {
        if (File.Exists(path) && (File.GetAttributes(path) & System.IO.FileAttributes.ReparsePoint) != 0)
            throw new IOException("A local symbolic link blocks the selected download path.");
    }

    private async Task EnsureRemoteDirectoryAsync(string path)
    {
        var existing = await session.TryGetAsync(path, CancellationToken.None);
        if (existing != null)
        {
            if (!existing.IsDirectory) throw new IOException($"Remote target is not a directory: {path}");
            return;
        }
        try { await session.CreateDirectoryAsync(path, CancellationToken.None); }
        catch
        {
            var raced = await session.TryGetAsync(path, CancellationToken.None);
            if (raced == null || !raced.IsDirectory) throw;
        }
    }

    private async Task CreateFolderAsync()
    {
        var input = new TextBox { Header = newFolderLabel, PlaceholderText = "folder" };
        var dialog = new ContentDialog { Title = newFolderLabel, Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary || string.IsNullOrWhiteSpace(input.Text)) return;
        await RunAsync(() => viewModel.CreateDirectoryAsync(input.Text));
    }

    private async Task CreateFileAsync()
    {
        var input = new TextBox { Header = text("native.sftp.newFile"), PlaceholderText = "file.txt" };
        var dialog = new ContentDialog { Title = text("native.sftp.newFile"), Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary || string.IsNullOrWhiteSpace(input.Text)) return;
        await RunAsync(() => viewModel.CreateFileAsync(input.Text));
    }

    private async Task RenameAsync()
    {
        if (entries.SelectedItem is not RemoteEntry item) return;
        var input = new TextBox { Header = text("native.sftp.rename"), Text = item.Name };
        var dialog = new ContentDialog { Title = text("native.sftp.rename"), Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await RunAsync(() => viewModel.RenameAsync(item, input.Text));
    }

    private async Task ChmodAsync()
    {
        if (entries.SelectedItem is not RemoteEntry item) return;
        var input = new TextBox { Header = text("native.sftp.chmod"), Text = "644", PlaceholderText = "644" };
        var dialog = new ContentDialog { Title = text("native.sftp.chmod"), Content = input, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        short mode;
        try { mode = checked((short)Convert.ToInt32(input.Text, 8)); }
        catch (Exception) { status.Text = text("native.validationFailed"); return; }
        if (mode is < 0 or > 511) { status.Text = text("native.validationFailed"); return; }
        await RunAsync(() => viewModel.ChmodAsync(item, mode));
    }

    private async Task DeleteAsync()
    {
        if (entries.SelectedItem is not RemoteEntry item) return;
        NativeDeletePreview? preview = null;
        try { preview = await session.PreviewDeleteAsync(item.Path, CancellationToken.None); }
        catch (Exception error) { status.Text = error.Message; return; }
        var deletePreview = preview!;
        var summary = deletePreview.Truncated
            ? $"{item.Path}\n{deletePreview.Entries}+ {text("native.sftp.entries")}"
            : $"{item.Path}\n{deletePreview.Entries} {text("native.sftp.entries")} · {deletePreview.Files} {text("native.sftp.files")} · {deletePreview.Bytes} B";
        if (deletePreview.ContainsSymlink) summary += $"\n{text("native.sftp.symlinkWarning")}";
        var dialog = new ContentDialog { Title = deleteLabel, Content = summary, PrimaryButtonText = deleteLabel, CloseButtonText = text("native.common.cancel"), XamlRoot = XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await RunAsync(() => viewModel.DeleteAsync(item));
    }
}
