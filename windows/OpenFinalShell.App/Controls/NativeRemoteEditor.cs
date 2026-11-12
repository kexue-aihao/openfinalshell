using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using OpenFinalShell.Core;
using Windows.System;

namespace OpenFinalShell.App.Controls;

/// <summary>
/// Native remote editor surface backed by Scintilla/Lexilla. The remote-file
/// service remains responsible for encoding, conflict and size safety.
/// </summary>
public sealed class NativeRemoteEditor : UserControl, IDisposable
{
    private readonly NativeSession session;
    private readonly NativeRemoteEditorService service;
    private readonly Func<string, string> text;
    private readonly FrameworkElement coordinateRoot;
    private readonly NativeScintillaTextSurface editor;
    private readonly TextBlock status = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock statusPath = new() { TextTrimming = TextTrimming.CharacterEllipsis, IsTextSelectionEnabled = true };
    private readonly TextBlock statusMeta = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Button save = new();
    private readonly ProgressRing saveProgressRing = new() { Width = 16, Height = 16, IsActive = false, Visibility = Visibility.Collapsed, VerticalAlignment = VerticalAlignment.Center };
    private readonly ProgressBar saveProgressBar = new() { Width = 112, Height = 4, Minimum = 0, Maximum = 100, Visibility = Visibility.Collapsed, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button reload = new();
    private readonly Button find = new();
    private readonly TextBox search = new() { Width = 220, PlaceholderText = "Find" };
    private readonly Button findNext = new();
    private readonly Button findPrevious = new();
    private readonly StackPanel searchTools = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
    private readonly StackPanel searchPanel = new() { Spacing = 6, Visibility = Visibility.Collapsed };
    private readonly TextBox replacement = new() { Width = 180 };
    private readonly CheckBox matchCase = new() { Content = "Aa" }, wholeWord = new() { Content = "ab" }, regex = new() { Content = ".*" };
    private readonly TextBlock caret = new();
    private readonly ComboBox languageChoice = new() { MinWidth = 108, Height = 32 };
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer caretTimer;
    private NativeRemoteFileView? view;
    private bool loading;
    private bool saveInProgress;
    private bool sessionAvailable = true;
    private readonly ComboBox encodingChoice = new() { MinWidth = 120 };
    private bool synchronizingEncoding;
    private NativeTextEncoding? requestedEncoding;

    public bool HasUnsavedChanges => view != null && !loading && editor.HasUnsavedChanges;
    public string RemotePath => view?.RequestedPath ?? string.Empty;
    internal event Action? StateChanged;
    private XamlRoot? DialogRoot => XamlRoot ?? coordinateRoot.XamlRoot;

    public void SetSessionAvailable(bool available)
    {
        sessionAvailable = available;
        save.IsEnabled = available && !saveInProgress && editor.IsAvailable && view?.Lossless == true && HasUnsavedChanges;
        reload.IsEnabled = available && !saveInProgress && view != null;
        if (!available)
            status.Text = Format("editor.sessionDead", ("origin", session.Profile.Name));
        else
            UpdateDirtyState();
    }

    public NativeRemoteEditor(NativeSession session, NativeRemoteEditorService service, Func<string, string> text, nint ownerWindow, FrameworkElement coordinateRoot, NativeSettings? settings = null, Func<int, bool, bool, bool, bool>? workbenchKeyRequested = null)
    {
        this.session = session;
        this.service = service;
        this.text = text;
        this.coordinateRoot = coordinateRoot;
        editor = new NativeScintillaTextSurface(ownerWindow, coordinateRoot);
        editor.WorkbenchKeyRequested = workbenchKeyRequested;
        editor.Configure(settings ?? NativeSettings.Defaults);
        AutomationProperties.SetName(editor, text("native.editor.automationName"));
        ConfigureIconButton(save, text("native.editor.save"), "\uE74E");
        AutomationProperties.SetName(saveProgressRing, text("native.editor.save"));
        AutomationProperties.SetName(saveProgressBar, text("native.editor.save"));
        ConfigureIconButton(reload, text("native.editor.reload"), "\uE72C");
        ConfigureIconButton(find, text("native.editor.find"), "\uE721");
        ConfigureIconButton(findNext, text("native.editor.findNext"), "\uE70D");
        ConfigureIconButton(findPrevious, text("native.editor.findPrevious"), "\uE70E");
        search.PlaceholderText = text("native.editor.findPlaceholder");
        save.Click += async (_, _) => await SaveAsync();
        reload.Click += async (_, _) => await ReloadAsync();
        find.Click += (_, _) => ToggleSearch();
        findNext.Click += (_, _) => FindNext();
        findPrevious.Click += (_, _) => FindNext(true);
        search.KeyDown += (_, args) =>
        {
            if (args.Key != VirtualKey.Enter) return;
            FindNext();
            args.Handled = true;
        };
        editor.DocumentChanged += UpdateDirtyState;
        editor.SaveRequested += async () => await SaveAsync();
        editor.SearchRequested += ToggleSearch;
        editor.InitializationFailed += error => status.Text = Format("native.editor.nativeUnavailable", ("detail", error.Message));
        var primaryToolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        primaryToolbar.Children.Add(save);
        primaryToolbar.Children.Add(saveProgressRing);
        primaryToolbar.Children.Add(saveProgressBar);
        primaryToolbar.Children.Add(reload);
        primaryToolbar.Children.Add(find);
        var go = new Button();
        ConfigureIconButton(go, text("native.editor.goToLine"), "\uE8A5");
        go.Click += async (_, _) =>
        {
            var line = new NumberBox { Header = text("native.editor.goToLine"), Minimum = 1, Maximum = 10000000, Value = 1 };
            var dialog = new ContentDialog { Title = text("native.editor.goToLine"), Content = line, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = DialogRoot };
            if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary && double.IsFinite(line.Value)) editor.GoToLine((int)line.Value);
        };
        var fold = new Button();
        ConfigureIconButton(fold, text("native.editor.fold"), "\uE8A0");
        var unfold = new Button();
        ConfigureIconButton(unfold, text("native.editor.unfold"), "\uE8A1");
        fold.Click += (_, _) => editor.FoldAll(true); unfold.Click += (_, _) => editor.FoldAll(false);
        primaryToolbar.Children.Add(go);
        primaryToolbar.Children.Add(fold);
        primaryToolbar.Children.Add(unfold);
        var language = languageChoice;
        language.PlaceholderText = text("native.editor.language");
        language.ItemsSource = new[] { "plain", "bash", "props", "json", "yaml", "toml", "python", "javascript", "typescript", "coffeescript", "csharp", "java", "go", "html", "xml", "css", "sql", "lua", "perl", "php", "powershell", "markdown", "makefile", "cmake", "dart", "fsharp", "rust", "nim", "nix", "zig", "d", "r", "batch", "diff", "dockerfile", "nginx" };
        language.SelectionChanged += (_, _) =>
        {
            if (language.SelectedItem is string value && value != editor.LexerLanguage)
            {
                editor.SetLanguage(value);
                UpdateDirtyState();
            }
        };
        var optionsToolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        optionsToolbar.Children.Add(language);
        var wrap = new Microsoft.UI.Xaml.Controls.Primitives.ToggleButton { Content = text("native.editor.wrap"), Style = Application.Current.Resources["EditorToolbarToggleStyle"] as Style };
        wrap.Checked += (_, _) => editor.SetWrapping(true); wrap.Unchecked += (_, _) => editor.SetWrapping(false);
        var indent = new ComboBox { MinWidth = 80 };
        AutomationProperties.SetName(indent, text("native.editor.indent")); ToolTipService.SetToolTip(indent, text("native.editor.indent"));
        indent.ItemsSource = new[] { 2, 4, 8 }; indent.SelectedItem = 2;
        var useTabs = new Microsoft.UI.Xaml.Controls.Primitives.ToggleButton { Content = text("native.editor.useTabs"), Style = Application.Current.Resources["EditorToolbarToggleStyle"] as Style };
        void UpdateIndent() => editor.SetIndentation(indent.SelectedItem is int width ? width : 2, useTabs.IsChecked == true);
        indent.SelectionChanged += (_, _) => UpdateIndent(); useTabs.Checked += (_, _) => UpdateIndent(); useTabs.Unchecked += (_, _) => UpdateIndent();
        optionsToolbar.Children.Add(wrap); optionsToolbar.Children.Add(indent); optionsToolbar.Children.Add(useTabs);
        encodingChoice.ItemsSource = Enum.GetValues<NativeTextEncoding>();
        encodingChoice.Height = 32;
        AutomationProperties.SetName(encodingChoice, text("native.editor.encoding"));
        ToolTipService.SetToolTip(encodingChoice, text("editor.charsetHint"));
        encodingChoice.SelectionChanged += async (_, _) =>
        {
            if (loading || synchronizingEncoding || view == null || encodingChoice.SelectedItem is not NativeTextEncoding selected || selected == view.Encoding) return;
            if (HasUnsavedChanges && !await ConfirmDiscardAsync()) { SynchronizeEncoding(); return; }
            try { await LoadAsync(view.RequestedPath, encoding: selected); }
            catch (Exception error) { status.Text = error.Message; SynchronizeEncoding(); }
        };
        editor.Loaded += (_, _) => { UpdateIndent(); editor.SetWrapping(wrap.IsChecked == true); };
        replacement.PlaceholderText = text("native.editor.replace");
        AutomationProperties.SetName(matchCase, text("native.editor.matchCase")); AutomationProperties.SetName(wholeWord, text("native.editor.wholeWord")); AutomationProperties.SetName(regex, text("native.editor.regex"));
        var replaceAll = new Button();
        ConfigureIconButton(replaceAll, text("native.editor.replaceAll"), "\uE8AB");
        replaceAll.Click += (_, _) =>
        {
            try { status.Text = $"{text("native.editor.replaceAll")}: {editor.ReplaceAll(search.Text, replacement.Text, matchCase.IsChecked == true, wholeWord.IsChecked == true, regex.IsChecked == true)}"; }
            catch (Exception error) { status.Text = error.Message; }
        };
        replacement.Width = 220;
        foreach (var item in new UIElement[] { replacement, replaceAll, matchCase, wholeWord, regex }) searchTools.Children.Add(item);
        var searchRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        searchRow.Children.Add(search); searchRow.Children.Add(findPrevious); searchRow.Children.Add(findNext);
        searchPanel.Children.Add(searchRow);
        searchPanel.Children.Add(searchTools);
        var toolbar = new StackPanel { Spacing = 6, Padding = new Thickness(8, 8, 8, 6), Children = { primaryToolbar, optionsToolbar } };
        var toolbarSurface = new Border
        {
            Background = Application.Current.Resources["ShellBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush,
            BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Microsoft.UI.Xaml.Media.Brush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = toolbar
        };
        var searchSurface = new Border
        {
            Padding = new Thickness(8, 0, 8, 8),
            Background = Application.Current.Resources["ShellBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush,
            Child = searchPanel
        };
        caretTimer = DispatcherQueue.CreateTimer(); caretTimer.Interval = TimeSpan.FromMilliseconds(250);
        caretTimer.Tick += (_, _) => caret.Text = editor.CaretStatus;
        Loaded += (_, _) => caretTimer.Start(); Unloaded += (_, _) => caretTimer.Stop();
        var root = new Grid
        {
            RowDefinitions =
            {
                new RowDefinition { Height = GridLength.Auto },
                new RowDefinition { Height = GridLength.Auto },
                new RowDefinition { Height = new GridLength(1, GridUnitType.Star) },
                new RowDefinition { Height = GridLength.Auto }
            }
        };
        root.Children.Add(toolbarSurface);
        root.Children.Add(searchSurface);
        root.Children.Add(editor);
        var statusBar = new Grid { Padding = new Thickness(8, 3, 8, 3), ColumnSpacing = 12, Background = Application.Current.Resources["ShellBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush, BorderBrush = Application.Current.Resources["CardStrokeColorDefaultBrush"] as Microsoft.UI.Xaml.Media.Brush, BorderThickness = new Thickness(0, 1, 0, 0) };
        statusBar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        statusBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        statusBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        statusBar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        statusBar.Children.Add(statusPath); Grid.SetColumn(statusPath, 0);
        statusBar.Children.Add(caret); Grid.SetColumn(caret, 1);
        statusBar.Children.Add(statusMeta); Grid.SetColumn(statusMeta, 2);
        statusBar.Children.Add(status); Grid.SetColumn(status, 3);
        root.Children.Add(statusBar);
        Grid.SetRow(searchSurface, 1);
        Grid.SetRow(editor, 2);
        Grid.SetRow(statusBar, 3);
        Content = root;
        Loaded += async (_, _) =>
        {
            if (view == null && Tag is string path) { try { await LoadAsync(path); } catch (Exception error) { status.Text = error.Message; } }
        };
    }

    public async Task LoadAsync(string path, CancellationToken cancellation = default, NativeTextEncoding? encoding = null)
    {
        loading = true;
        encodingChoice.IsEnabled = false;
        string? loadError = null;
        try
        {
            var loaded = await Task.Run(() => service.ViewAsync(session, path, encoding ?? requestedEncoding, cancellation), cancellation);
            view = loaded;
            requestedEncoding = encoding ?? requestedEncoding;
            SynchronizeEncoding();
            editor.IsReadOnly = !loaded.Lossless;
            await editor.SetDocumentAsync(loaded.ResolvedPath, loaded.Text);
            languageChoice.SelectedItem = editor.LexerLanguage;
            status.Text = NativeScintillaTextSurface.RuntimeFilesPresent
                ? FormatStatus(loaded)
                : Format("native.editor.nativeUnavailable", ("detail", "Scintilla.dll or Lexilla.dll is missing for this architecture."));
            UpdateDirtyState();
            editor.FocusEditor();
        }
        catch (Exception error)
        {
            loadError = error.Message.StartsWith("native.", StringComparison.Ordinal) ? text(error.Message) : error.Message;
            throw;
        }
        finally
        {
            loading = false; encodingChoice.IsEnabled = true; UpdateDirtyState();
            if (loadError != null) status.Text = loadError;
        }
    }

    private void SynchronizeEncoding()
    {
        synchronizingEncoding = true;
        try { encodingChoice.SelectedItem = view?.Encoding; }
        finally { synchronizingEncoding = false; }
    }

    private async Task ReloadAsync()
    {
        if (!sessionAvailable || view == null) return;
        if (HasUnsavedChanges && !await ConfirmDiscardAsync()) return;
        try { await LoadAsync(view.RequestedPath); }
        catch (Exception error) { status.Text = error.Message; }
    }

    public async Task<bool> SaveAsync(bool overwriteRemoteChanges = false, bool allowShrink = false, bool allowNonAtomic = false)
    {
        if (!sessionAvailable || view == null || saveInProgress) return false;
        if (!editor.IsAvailable)
        {
            status.Text = Format("native.editor.nativeUnavailable", ("detail", "The native editor window could not be initialized."));
            return false;
        }
        var saveView = view;
        var wasReadOnly = editor.IsReadOnly;
        saveInProgress = true;
        saveProgressBar.Visibility = Visibility.Collapsed;
        saveProgressRing.Visibility = Visibility.Visible;
        saveProgressRing.IsActive = true;
        save.IsEnabled = false;
        reload.IsEnabled = false;
        encodingChoice.IsEnabled = false;
        editor.IsReadOnly = true;
        try
        {
            // Let WinUI paint the saving indicator before the native document snapshot.
            await Task.Yield();
            var editedText = await editor.ReadTextAsync();
            var dispatcher = coordinateRoot.DispatcherQueue;
            Action<NativeRemoteEditorService.SaveProgress> reportProgress = progress =>
                dispatcher.TryEnqueue(() => UpdateSaveProgress(progress));
            while (true)
            {
                var result = await Task.Run(
                    () => service.SaveAsync(session, saveView.RequestedPath, editedText, saveView.Encoding, saveView.NewLine,
                        saveView.HasBom, overwriteRemoteChanges, allowShrink, allowNonAtomic: allowNonAtomic, progress: reportProgress));
                if (result.Kind == NativeRemoteSaveKind.Conflict && !overwriteRemoteChanges)
                {
                    PauseSaveProgress();
                    var dialog = new ContentDialog
                    {
                        Title = text("native.editor.remoteChangedTitle"),
                        Content = text("native.editor.remoteChanged"),
                        PrimaryButtonText = text("native.editor.overwrite"),
                        CloseButtonText = text("native.common.cancel"),
                        XamlRoot = DialogRoot
                    };
                    if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return false;
                    overwriteRemoteChanges = true;
                    ResumeSaveProgress();
                    continue;
                }
                if (result.Kind == NativeRemoteSaveKind.Shrink && !allowShrink)
                {
                    PauseSaveProgress();
                    var dialog = new ContentDialog
                    {
                        Title = text("native.editor.shrinkTitle"),
                        Content = text("native.editor.shrinkMessage"),
                        PrimaryButtonText = text("native.editor.allowShrink"),
                        CloseButtonText = text("native.common.cancel"),
                        XamlRoot = DialogRoot
                    };
                    if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return false;
                    allowShrink = true;
                    ResumeSaveProgress();
                    continue;
                }
                if (result.Kind == NativeRemoteSaveKind.NonAtomic && !allowNonAtomic)
                {
                    PauseSaveProgress();
                    var dialog = new ContentDialog
                    {
                        Title = text("editor.nonAtomicTitle"), Content = new TextBlock { Text = text("editor.nonAtomicDesc"), TextWrapping = TextWrapping.Wrap },
                        PrimaryButtonText = text("editor.nonAtomicOk"), CloseButtonText = text("native.common.cancel"), XamlRoot = DialogRoot
                    };
                    if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return false;
                    allowNonAtomic = true;
                    ResumeSaveProgress();
                    continue;
                }
                if (result.Kind != NativeRemoteSaveKind.Saved)
                {
                    status.Text = result.Message is { } message ? (message.StartsWith("native.", StringComparison.Ordinal) ? text(message) : message) : text("native.editor.saveFailed");
                    return false;
                }
                editor.SetSavePoint();
                view = saveView with { Text = editedText, Bytes = result.Bytes, Modified = DateTime.UtcNow, MixedNewLines = false };
                status.Text = text("native.editor.saved");
                UpdateDirtyState();
                return true;
            }
        }
        catch (Exception error)
        {
            status.Text = error.Message.StartsWith("native.", StringComparison.Ordinal) ? text(error.Message) : error.Message;
            return false;
        }
        finally
        {
            editor.IsReadOnly = wasReadOnly;
            saveInProgress = false;
            saveProgressRing.IsActive = false;
            saveProgressRing.Visibility = Visibility.Collapsed;
            saveProgressBar.Visibility = Visibility.Collapsed;
            encodingChoice.IsEnabled = true;
            UpdateDirtyState();
        }
    }

    private void UpdateSaveProgress(NativeRemoteEditorService.SaveProgress progress)
    {
        if (!saveInProgress) return;
        saveProgressBar.IsIndeterminate = false;
        saveProgressBar.Visibility = Visibility.Visible;
        saveProgressBar.Value = progress.TotalBytes <= 0
            ? 100
            : Math.Clamp(progress.BytesWritten * 100d / progress.TotalBytes, 0, 100);
    }

    private void PauseSaveProgress()
    {
        saveProgressRing.IsActive = false;
        saveProgressRing.Visibility = Visibility.Collapsed;
        saveProgressBar.Visibility = Visibility.Collapsed;
    }

    private void ResumeSaveProgress()
    {
        saveProgressBar.Value = 0;
        saveProgressBar.IsIndeterminate = true;
        saveProgressRing.Visibility = Visibility.Visible;
        saveProgressRing.IsActive = true;
    }

    public async Task<bool> ConfirmCloseAsync()
    {
        if (!HasUnsavedChanges) return true;
        var dialog = new ContentDialog
        {
            Title = text("native.editor.unsavedTitle"),
            Content = text("native.editor.unsavedMessage"),
            PrimaryButtonText = text("native.editor.saveBeforeClose"),
            SecondaryButtonText = text("native.editor.discard"),
            CloseButtonText = text("native.common.cancel"),
            XamlRoot = DialogRoot
        };
        return await dialog.ShowGatedAsync() switch
        {
            ContentDialogResult.Primary => await SaveAsync(),
            ContentDialogResult.Secondary => true,
            _ => false
        };
    }

    private bool ConfirmDiscardRequired() => HasUnsavedChanges;

    private async Task<bool> ConfirmDiscardAsync()
    {
        if (!ConfirmDiscardRequired()) return true;
        var dialog = new ContentDialog
        {
            Title = text("native.editor.unsavedTitle"),
            Content = text("native.editor.unsavedMessage"),
            PrimaryButtonText = text("native.editor.discard"),
            CloseButtonText = text("native.common.cancel"),
            XamlRoot = DialogRoot
        };
        return await dialog.ShowGatedAsync() == ContentDialogResult.Primary;
    }

    private void UpdateDirtyState()
    {
        if (loading || view == null) return;
        UpdateStatusParts(view);
        save.IsEnabled = sessionAvailable && !saveInProgress && editor.IsAvailable && view.Lossless && HasUnsavedChanges;
        reload.IsEnabled = sessionAvailable && !saveInProgress;
        if (!sessionAvailable)
        {
            status.Text = Format("editor.sessionDead", ("origin", session.Profile.Name));
            return;
        }
        if (!editor.IsAvailable)
        {
            status.Text = NativeScintillaTextSurface.RuntimeFilesPresent
                ? Format("native.editor.nativeUnavailable", ("detail", "The native editor window could not be initialized."))
                : Format("native.editor.nativeUnavailable", ("detail", "Scintilla.dll or Lexilla.dll is missing for this architecture."));
            return;
        }
        status.Text = !view.Lossless ? text("editor.readOnlyLossless") : HasUnsavedChanges ? text("native.editor.modified") : FormatStatus(view);
        if (view.MixedNewLines) status.Text += " · ⚠ " + text("editor.mixedEol");
        ToolTipService.SetToolTip(status, view.MixedNewLines ? text("editor.mixedEolHint") : null);
        StateChanged?.Invoke();
    }

    private string FormatStatus(NativeRemoteFileView file) =>
        $"{file.ResolvedPath} · {editor.LexerLanguage} · {file.Encoding}{(file.HasBom ? " + BOM" : "")} · {(file.NewLine == "\r\n" ? "CRLF" : "LF")} · {file.Bytes} B";

    private void UpdateStatusParts(NativeRemoteFileView file)
    {
        statusPath.Text = file.ResolvedPath;
        ToolTipService.SetToolTip(statusPath, file.ResolvedPath);
        statusMeta.Text = $"{editor.LexerLanguage} · {file.Encoding}{(file.HasBom ? " + BOM" : "")} · {(file.NewLine == "\r\n" ? "CRLF" : "LF")} · {file.Bytes} B";
    }

    private string Format(string key, params (string Key, string Value)[] values)
    {
        var result = text(key);
        foreach (var (name, value) in values) result = result.Replace("{{" + name + "}}", value, StringComparison.Ordinal);
        return result;
    }

    public void Configure(NativeSettings settings) => editor.Configure(settings);
    public void Dispose() { caretTimer.Stop(); editor.Dispose(); }

    private void ToggleSearch()
    {
        var opening = searchPanel.Visibility != Visibility.Visible;
        searchPanel.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        if (opening)
        {
            search.Focus(FocusState.Programmatic);
            search.SelectAll();
        }
        else editor.FocusEditor();
    }

    private void FindNext(bool backwards = false)
    {
        if (searchPanel.Visibility != Visibility.Visible) ToggleSearch();
        try { if (!editor.Find(search.Text, backwards, matchCase.IsChecked == true, wholeWord.IsChecked == true, regex.IsChecked == true)) status.Text = text("native.editor.noMatches"); }
        catch (Exception error) { status.Text = error.Message; }
    }

    private static void ConfigureIconButton(Button button, string label, string glyph)
    {
        button.Style = Application.Current.Resources["EditorToolbarButtonStyle"] as Style;
        button.Content = new FontIcon { Glyph = glyph, FontSize = 16 };
        AutomationProperties.SetName(button, label);
        ToolTipService.SetToolTip(button, label);
    }
}
