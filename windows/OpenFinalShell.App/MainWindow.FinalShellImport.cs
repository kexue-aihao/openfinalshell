using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.Core;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace OpenFinalShell.App;

public sealed partial class MainWindow
{
    private readonly NativeFinalShellImporter finalShellImporter = new();

    private async void ImportFinalShell(object sender, RoutedEventArgs args)
    {
        FinalShellImportButton.IsEnabled = false;
        try
        {
            var picker = new FolderPicker();
            picker.FileTypeFilter.Add("*");
            InitializeWithWindow.Initialize(picker, WindowHandle());
            var folder = await picker.PickSingleFolderAsync();
            if (folder == null) return;

            var scan = await finalShellImporter.ScanAsync(folder.Path, localization);
            var policy = await ConfirmFinalShellImportAsync(scan);
            if (policy == null) { finalShellImporter.Cancel(scan.Token); return; }

            var result = finalShellImporter.Apply(store, scan.Token, policy.Value, localization);
            RefreshAfterPortableImport();
            Status.Text = localization.Format("settings.fsImportResult", ("profiles", result.Profiles.ToString()),
                ("groups", result.Groups.ToString()), ("skipped", result.Skipped.ToString()));
            var resultPanel = new StackPanel { Spacing = 8 };
            resultPanel.Children.Add(new TextBlock { Text = Status.Text, TextWrapping = TextWrapping.Wrap });
            foreach (var note in result.Notes)
                resultPanel.Children.Add(new TextBlock { Text = note, TextWrapping = TextWrapping.Wrap });
            await new ContentDialog
            {
                Title = localization["settings.importResultTitle"], Content = resultPanel,
                CloseButtonText = localization["common.close"], XamlRoot = Root.XamlRoot
            }.ShowGatedAsync();
        }
        catch (Exception error) { ShowError(error); }
        finally { FinalShellImportButton.IsEnabled = true; }
    }

    private async Task<bool?> ConfirmFinalShellImportAsync(NativeFinalShellScan scan)
    {
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(new TextBlock { Text = scan.Directory, TextWrapping = TextWrapping.Wrap, Opacity = .75 });
        panel.Children.Add(new TextBlock
        {
            Text = localization.Format("settings.fsImportCounts", ("profiles", scan.Counts.Profiles.ToString()), ("groups", scan.Counts.Groups.ToString())),
            TextWrapping = TextWrapping.Wrap
        });
        if (scan.Samples.Count > 0)
        {
            var samples = new StackPanel { Spacing = 4, Padding = new Thickness(10) };
            foreach (var sample in scan.Samples)
                samples.Children.Add(new TextBlock { Text = $"{sample.Name} — {sample.Username}@{sample.Host}:{sample.Port}", TextWrapping = TextWrapping.Wrap });
            if (scan.Counts.Profiles > scan.Samples.Count)
                samples.Children.Add(new TextBlock { Text = localization.Format("settings.fsImportMore", ("count", (scan.Counts.Profiles - scan.Samples.Count).ToString())) });
            panel.Children.Add(samples);
        }
        foreach (var note in scan.Notes)
            panel.Children.Add(new TextBlock { Text = "⚠ " + note, TextWrapping = TextWrapping.Wrap, Foreground = new Microsoft.UI.Xaml.Media.SolidColorBrush(Windows.UI.Color.FromArgb(255, 255, 69, 0)) });
        if (scan.Counts.Invalid > 0 || scan.Counts.NotSsh > 0)
            panel.Children.Add(new TextBlock
            {
                Text = localization.Format("settings.fsImportSkipped", ("invalid", scan.Counts.Invalid.ToString()), ("notSsh", scan.Counts.NotSsh.ToString())),
                TextWrapping = TextWrapping.Wrap, Opacity = .75
            });
        panel.Children.Add(new TextBlock { Text = localization["settings.fsImportConflict"], TextWrapping = TextWrapping.Wrap });
        var conflict = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, SelectedIndex = 0 };
        conflict.Items.Add(new ComboBoxItem { Content = localization["settings.fsImportConflictSkip"], Tag = false });
        conflict.Items.Add(new ComboBoxItem { Content = localization["settings.fsImportConflictDuplicate"], Tag = true });
        panel.Children.Add(conflict);

        var dialog = new ContentDialog
        {
            Title = localization["settings.fsImportModalTitle"],
            Content = new ScrollViewer { Content = panel, MaxHeight = 520 },
            PrimaryButtonText = localization["settings.importConfirm"],
            CloseButtonText = localization["common.cancel"], XamlRoot = Root.XamlRoot
        };
        if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return null;
        return conflict.SelectedItem is ComboBoxItem { Tag: bool duplicate } && duplicate;
    }
}
