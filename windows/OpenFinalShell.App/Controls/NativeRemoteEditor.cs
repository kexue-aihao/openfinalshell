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
    private readonly Button save = new();
    private readonly Button reload = new();
    private readonly Button find = new();
    private readonly TextBox search = new() { Width = 220, Visibility = Visibility.Collapsed, PlaceholderText = "Find" };
    private readonly Button findNext = new() { Content = "↓", Visibility = Visibility.Collapsed };
    private readonly Button findPrevious = new() { Content = "↑", Visibility = Visibility.Collapsed };
    private readonly StackPanel searchTools = new() { Orientation = Orientation.Horizontal, Spacing = 8, Visibility = Visibility.Collapsed };
    private readonly TextBox replacement = new() { Width = 180 };
    private readonly CheckBox matchCase = new() { Content = "Aa" }, wholeWord = new() { Content = "ab" }, regex = new() { Content = ".*" };
    private readonly TextBlock caret = new();
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer caretTimer;
    private NativeRemoteFileView? view;
    private bool loading;
    private bool sessionAvailable = true;
    private readonly ComboBox encodingChoice = new() { MinWidth = 120 };
    private bool synchronizingEncoding;
    private NativeTextEncoding? requestedEncoding;

    public bool HasUnsavedChanges => view != null && !loading && editor.HasUnsavedChanges;
    public string RemotePath => view?.RequestedPath ?? string.Empty;
    private XamlRoot? DialogRoot => XamlRoot ?? coordinateRoot.XamlRoot;

    public void SetSessionAvailable(bool available)
    {
        sessionAvailable = available;
        save.IsEnabled = available && editor.IsAvailable && view?.Lossless == true && HasUnsavedChanges;
        reload.IsEnabled = available && view != null;
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
        save.Content = text("native.editor.save");
        reload.Content = text("native.editor.reload");
        find.Content = text("native.editor.find");
        AutomationProperties.SetName(findNext, text("native.editor.findNext"));
        AutomationProperties.SetName(findPrevious, text("native.editor.findPrevious"));
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
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(8) };
        toolbar.Children.Add(save);
        toolbar.Children.Add(reload);
        toolbar.Children.Add(find);
        toolbar.Children.Add(search);
        toolbar.Children.Add(findPrevious);
        toolbar.Children.Add(findNext);
        var go = new Button { Content = text("native.editor.goToLine") };
        go.Click += async (_, _) =>
        {
            var line = new NumberBox { Header = text("native.editor.goToLine"), Minimum = 1, Maximum = 10000000, Value = 1 };
            var dialog = new ContentDialog { Title = text("native.editor.goToLine"), Content = line, PrimaryButtonText = text("native.common.ok"), CloseButtonText = text("native.common.cancel"), XamlRoot = DialogRoot };
            if (await dialog.ShowGatedAsync() == ContentDialogResult.Primary && double.IsFinite(line.Value)) editor.GoToLine((int)line.Value);
        };
        var fold = new Button { Content = text("native.editor.fold") };
        var unfold = new Button { Content = text("native.editor.unfold") };
        fold.Click += (_, _) => editor.FoldAll(true); unfold.Click += (_, _) => editor.FoldAll(false);
        var language = new ComboBox { MinWidth = 100, PlaceholderText = text("native.editor.language") };
        language.ItemsSource = new[] { "plain", "bash", "props", "json", "yaml", "toml", "python", "javascript", "html", "xml", "css", "sql", "lua", "perl", "diff", "dockerfile", "nginx" };
        language.SelectionChanged += (_, _) => { if (language.SelectedItem is string value) { editor.SetLanguage(value); UpdateDirtyState(); } };
        toolbar.Children.Add(go); toolbar.Children.Add(fold); toolbar.Children.Add(unfold); toolbar.Children.Add(language); toolbar.Children.Add(caret);
        var wrap = new Microsoft.UI.Xaml.Controls.Primitives.ToggleButton { Content = text("native.editor.wrap") };
        wrap.Checked += (_, _) => editor.SetWrapping(true); wrap.Unchecked += (_, _) => editor.SetWrapping(false);
        var indent = new ComboBox { MinWidth = 80 };
        AutomationProperties.SetName(indent, text("native.editor.indent")); ToolTipService.SetToolTip(indent, text("native.editor.indent"));
        indent.ItemsSource = new[] { 2, 4, 8 }; indent.SelectedItem = 2;
        var useTabs = new Microsoft.UI.Xaml.Controls.Primitives.ToggleButton { Content = text("native.editor.useTabs") };
        void UpdateIndent() => editor.SetIndentation(indent.SelectedItem is int width ? width : 2, useTabs.IsChecked == true);
        indent.SelectionChanged += (_, _) => UpdateIndent(); useTabs.Checked += (_, _) => UpdateIndent(); useTabs.Unchecked += (_, _) => UpdateIndent();
        toolbar.Children.Add(wrap); toolbar.Children.Add(indent); toolbar.Children.Add(useTabs);
        encodingChoice.ItemsSource = Enum.GetValues<NativeTextEncoding>();
        AutomationProperties.SetName(encodingChoice, text("native.editor.encoding"));
        ToolTipService.SetToolTip(encodingChoice, text("editor.charsetHint"));
        encodingChoice.SelectionChanged += async (_, _) =>
        {
            if (loading || synchronizingEncoding || view == null || encodingChoice.SelectedItem is not NativeTextEncoding selected || selected == view.Encoding) return;
            if (HasUnsavedChanges && !await ConfirmDiscardAsync()) { SynchronizeEncoding(); return; }
            try { await LoadAsync(view.RequestedPath, encoding: selected); }
            catch (Exception error) { status.Text = error.Message; SynchronizeEncoding(); }
        };
        toolbar.Children.Add(encodingChoice);
        editor.Loaded += (_, _) => { UpdateIndent(); editor.SetWrapping(wrap.IsChecked == true); };
        replacement.PlaceholderText = text("native.editor.replace");
        AutomationProperties.SetName(matchCase, text("native.editor.matchCase")); AutomationProperties.SetName(wholeWord, text("native.editor.wholeWord")); AutomationProperties.SetName(regex, text("native.editor.regex"));
        var replaceAll = new Button { Content = text("native.editor.replaceAll") };
        replaceAll.Click += (_, _) =>
        {
            try { status.Text = $"{text("native.editor.replaceAll")}: {editor.ReplaceAll(search.Text, replacement.Text, matchCase.IsChecked == true, wholeWord.IsChecked == true, regex.IsChecked == true)}"; }
            catch (Exception error) { status.Text = error.Message; }
        };
        foreach (var item in new UIElement[] { replacement, replaceAll, matchCase, wholeWord, regex }) searchTools.Children.Add(item);
        var tools = new StackPanel { Spacing = 4, Children = { toolbar, searchTools } };
        caretTimer = DispatcherQueue.CreateTimer(); caretTimer.Interval = TimeSpan.FromMilliseconds(250);
        caretTimer.Tick += (_, _) => caret.Text = editor.CaretStatus;
        Loaded += (_, _) => caretTimer.Start(); Unloaded += (_, _) => caretTimer.Stop();
        var root = new Grid
        {
            RowDefinitions =
            {
                new RowDefinition { Height = GridLength.Auto },
                new RowDefinition { Height = new GridLength(1, GridUnitType.Star) },
                new RowDefinition { Height = GridLength.Auto }
            }
        };
        root.Children.Add(new ScrollViewer { Content = tools, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Enabled, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollMode = ScrollMode.Disabled });
        root.Children.Add(editor);
        root.Children.Add(status);
        Grid.SetRow(editor, 1);
        Grid.SetRow(status, 2);
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
            var loaded = await service.ViewAsync(session, path, encoding ?? requestedEncoding, cancellation);
            view = loaded;
            requestedEncoding = encoding ?? requestedEncoding;
            SynchronizeEncoding();
            editor.IsReadOnly = !loaded.Lossless;
            editor.SetDocument(loaded.ResolvedPath, loaded.Text);
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
        if (!sessionAvailable || view == null) return false;
        if (!editor.IsAvailable)
        {
            status.Text = Format("native.editor.nativeUnavailable", ("detail", "The native editor window could not be initialized."));
            return false;
        }
        try
        {
            var editedText = editor.Text;
            var result = await service.SaveAsync(session, view.RequestedPath, editedText, view.Encoding, view.NewLine, view.HasBom, overwriteRemoteChanges, allowShrink, allowNonAtomic: allowNonAtomic);
            if (result.Kind == NativeRemoteSaveKind.Conflict && !overwriteRemoteChanges)
            {
                var dialog = new ContentDialog
                {
                    Title = text("native.editor.remoteChangedTitle"),
                    Content = text("native.editor.remoteChanged"),
                    PrimaryButtonText = text("native.editor.overwrite"),
                    CloseButtonText = text("native.common.cancel"),
                    XamlRoot = DialogRoot
                };
                if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return false;
                return await SaveAsync(true, allowShrink, allowNonAtomic);
            }
            if (result.Kind == NativeRemoteSaveKind.Shrink && !allowShrink)
            {
                var dialog = new ContentDialog
                {
                    Title = text("native.editor.shrinkTitle"),
                    Content = text("native.editor.shrinkMessage"),
                    PrimaryButtonText = text("native.editor.allowShrink"),
                    CloseButtonText = text("native.common.cancel"),
                    XamlRoot = DialogRoot
                };
                if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return false;
                return await SaveAsync(overwriteRemoteChanges, true, allowNonAtomic);
            }
            if (result.Kind == NativeRemoteSaveKind.NonAtomic && !allowNonAtomic)
            {
                var dialog = new ContentDialog
                {
                    Title = text("editor.nonAtomicTitle"), Content = new TextBlock { Text = text("editor.nonAtomicDesc"), TextWrapping = TextWrapping.Wrap },
                    PrimaryButtonText = text("editor.nonAtomicOk"), CloseButtonText = text("native.common.cancel"), XamlRoot = DialogRoot
                };
                if (await dialog.ShowGatedAsync() != ContentDialogResult.Primary) return false;
                return await SaveAsync(overwriteRemoteChanges, allowShrink, true);
            }
            if (result.Kind != NativeRemoteSaveKind.Saved)
            {
                status.Text = result.Message is { } message ? (message.StartsWith("native.", StringComparison.Ordinal) ? text(message) : message) : text("native.editor.saveFailed");
                return false;
            }
            editor.SetSavePoint();
            view = view with { Text = editedText, Bytes = result.Bytes, Modified = DateTime.UtcNow, MixedNewLines = false };
            status.Text = text("native.editor.saved");
            UpdateDirtyState();
            return true;
        }
        catch (Exception error)
        {
            status.Text = error.Message.StartsWith("native.", StringComparison.Ordinal) ? text(error.Message) : error.Message;
            return false;
        }
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
        save.IsEnabled = sessionAvailable && editor.IsAvailable && view.Lossless && HasUnsavedChanges;
        reload.IsEnabled = sessionAvailable;
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
    }

    private string FormatStatus(NativeRemoteFileView file) =>
        $"{file.ResolvedPath} · {editor.LexerLanguage} · {file.Encoding}{(file.HasBom ? " + BOM" : "")} · {(file.NewLine == "\r\n" ? "CRLF" : "LF")} · {file.Bytes} B";

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
        var opening = search.Visibility != Visibility.Visible;
        search.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        findPrevious.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        findNext.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        searchTools.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        if (opening)
        {
            search.Focus(FocusState.Programmatic);
            search.SelectAll();
        }
        else editor.FocusEditor();
    }

    private void FindNext(bool backwards = false)
    {
        if (search.Visibility != Visibility.Visible) ToggleSearch();
        try { if (!editor.Find(search.Text, backwards, matchCase.IsChecked == true, wholeWord.IsChecked == true, regex.IsChecked == true)) status.Text = text("native.editor.noMatches"); }
        catch (Exception error) { status.Text = error.Message; }
    }
}
