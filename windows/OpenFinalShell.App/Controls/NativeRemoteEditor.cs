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
    private readonly NativeScintillaTextSurface editor;
    private readonly TextBlock status = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Button save = new();
    private readonly Button reload = new();
    private readonly Button find = new();
    private readonly TextBox search = new() { Width = 220, Visibility = Visibility.Collapsed, PlaceholderText = "Find" };
    private readonly Button findNext = new() { Content = "↓", Visibility = Visibility.Collapsed };
    private readonly Button findPrevious = new() { Content = "↑", Visibility = Visibility.Collapsed };
    private NativeRemoteFileView? view;
    private bool loading;

    public bool HasUnsavedChanges => view != null && !loading && editor.HasUnsavedChanges;
    public string RemotePath => view?.ResolvedPath ?? string.Empty;

    public NativeRemoteEditor(NativeSession session, NativeRemoteEditorService service, Func<string, string> text, nint ownerWindow, FrameworkElement coordinateRoot)
    {
        this.session = session;
        this.service = service;
        this.text = text;
        editor = new NativeScintillaTextSurface(ownerWindow, coordinateRoot);
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
        var root = new Grid
        {
            RowDefinitions =
            {
                new RowDefinition { Height = GridLength.Auto },
                new RowDefinition { Height = new GridLength(1, GridUnitType.Star) },
                new RowDefinition { Height = GridLength.Auto }
            }
        };
        root.Children.Add(toolbar);
        root.Children.Add(editor);
        root.Children.Add(status);
        Grid.SetRow(editor, 1);
        Grid.SetRow(status, 2);
        Content = root;
        Loaded += async (_, _) =>
        {
            if (view == null && Tag is string path) await LoadAsync(path);
        };
    }

    public async Task LoadAsync(string path, CancellationToken cancellation = default)
    {
        loading = true;
        try
        {
            var loaded = await service.ViewAsync(session, path, cancellation: cancellation);
            view = loaded;
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
            status.Text = error.Message;
            throw;
        }
        finally { loading = false; }
    }

    private async Task ReloadAsync()
    {
        if (view == null) return;
        if (HasUnsavedChanges && !await ConfirmDiscardAsync()) return;
        try { await LoadAsync(view.ResolvedPath); }
        catch (Exception error) { status.Text = error.Message; }
    }

    public async Task<bool> SaveAsync(bool overwriteRemoteChanges = false, bool allowShrink = false)
    {
        if (view == null) return false;
        if (!editor.IsAvailable)
        {
            status.Text = Format("native.editor.nativeUnavailable", ("detail", "The native editor window could not be initialized."));
            return false;
        }
        try
        {
            var editedText = editor.Text;
            var result = await service.SaveAsync(session, view.ResolvedPath, editedText, view.Encoding, view.NewLine, view.HasBom, overwriteRemoteChanges, allowShrink);
            if (result.Kind == NativeRemoteSaveKind.Conflict && !overwriteRemoteChanges)
            {
                var dialog = new ContentDialog
                {
                    Title = text("native.editor.remoteChangedTitle"),
                    Content = text("native.editor.remoteChanged"),
                    PrimaryButtonText = text("native.editor.overwrite"),
                    CloseButtonText = text("native.common.cancel"),
                    XamlRoot = XamlRoot
                };
                if (await dialog.ShowAsync() != ContentDialogResult.Primary) return false;
                return await SaveAsync(true, allowShrink);
            }
            if (result.Kind == NativeRemoteSaveKind.Shrink && !allowShrink)
            {
                var dialog = new ContentDialog
                {
                    Title = text("native.editor.shrinkTitle"),
                    Content = text("native.editor.shrinkMessage"),
                    PrimaryButtonText = text("native.editor.allowShrink"),
                    CloseButtonText = text("native.common.cancel"),
                    XamlRoot = XamlRoot
                };
                if (await dialog.ShowAsync() != ContentDialogResult.Primary) return false;
                return await SaveAsync(overwriteRemoteChanges, true);
            }
            if (result.Kind != NativeRemoteSaveKind.Saved)
            {
                status.Text = result.Message ?? text("native.editor.saveFailed");
                return false;
            }
            editor.SetSavePoint();
            view = view with { Text = editedText, Bytes = result.Bytes, Modified = DateTime.UtcNow };
            status.Text = text("native.editor.saved");
            UpdateDirtyState();
            return true;
        }
        catch (Exception error)
        {
            status.Text = error.Message;
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
            XamlRoot = XamlRoot
        };
        return await dialog.ShowAsync() switch
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
            XamlRoot = XamlRoot
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private void UpdateDirtyState()
    {
        if (loading || view == null) return;
        save.IsEnabled = editor.IsAvailable && HasUnsavedChanges;
        if (!editor.IsAvailable)
        {
            status.Text = NativeScintillaTextSurface.RuntimeFilesPresent
                ? Format("native.editor.nativeUnavailable", ("detail", "The native editor window could not be initialized."))
                : Format("native.editor.nativeUnavailable", ("detail", "Scintilla.dll or Lexilla.dll is missing for this architecture."));
            return;
        }
        status.Text = HasUnsavedChanges ? text("native.editor.modified") : FormatStatus(view);
    }

    private string FormatStatus(NativeRemoteFileView file) =>
        $"{file.ResolvedPath} · {editor.LexerLanguage} · {file.Encoding} · {(file.NewLine == "\r\n" ? "CRLF" : "LF")} · {file.Bytes} B";

    private string Format(string key, params (string Key, string Value)[] values)
    {
        var result = text(key);
        foreach (var (name, value) in values) result = result.Replace("{{" + name + "}}", value, StringComparison.Ordinal);
        return result;
    }

    public void Dispose() => editor.Dispose();

    private void ToggleSearch()
    {
        var opening = search.Visibility != Visibility.Visible;
        search.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        findPrevious.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        findNext.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
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
        if (!editor.Find(search.Text, backwards)) status.Text = text("native.editor.noMatches");
    }

}
