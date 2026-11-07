using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using OpenFinalShell.App.Controls;
using OpenFinalShell.Core;
using WinRT.Interop;
using Windows.Graphics;

namespace OpenFinalShell.App;

/// <summary>
/// Owns the single, cross-session native editor window. Documents stay alive
/// when their session tab is closed, matching the Electron editor workflow.
/// </summary>
internal sealed class NativeEditorWindowHost : IDisposable
{
    private const int MaximumOpenDocuments = 10;

    private sealed record Document(string Key, string SessionId, NativeRemoteEditor Editor, TabViewItem Tab);

    private readonly NativeRemoteEditorService service;
    private readonly Func<string, string> text;
    private readonly Func<NativeSettings> settings;
    private readonly Func<int, bool, bool, bool, bool> shortcut;
    private readonly Dictionary<string, Document> documents = new(StringComparer.Ordinal);
    private Window? window;
    private Grid? root;
    private TabView? tabs;
    private ContentControl? content;
    private bool allowClose;
    private bool closePromptOpen;
    private bool disposed;

    public NativeEditorWindowHost(
        NativeRemoteEditorService service,
        Func<string, string> text,
        Func<NativeSettings> settings,
        Func<int, bool, bool, bool, bool> shortcut)
    {
        this.service = service;
        this.text = text;
        this.settings = settings;
        this.shortcut = shortcut;
    }

    public bool HasDocuments => documents.Count > 0;
    public int DirtyCount => documents.Values.Count(item => item.Editor.HasUnsavedChanges);

    public event Action<string>? Failed;

    public void Open(NativeSession session, string profileName, string remotePath)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        EnsureWindow();

        var key = Key(session.SessionId, remotePath);
        if (documents.TryGetValue(key, out var existing))
        {
            tabs!.SelectedItem = existing.Tab;
            window!.Activate();
            return;
        }
        if (documents.Count >= MaximumOpenDocuments)
        {
            Failed?.Invoke(text("editor.tooManyOpen").Replace("{{max}}", MaximumOpenDocuments.ToString(), StringComparison.Ordinal));
            return;
        }

        var editor = new NativeRemoteEditor(session, service, text, WindowHandle(), root!, settings(), shortcut)
        {
            Tag = remotePath
        };
        editor.SetSessionAvailable(session.Snapshot.State == NativeSessionState.Ready);
        var tab = new TabViewItem
        {
            Header = $"{profileName} · {Path.GetFileName(remotePath)}",
            Tag = key,
            IsClosable = true,
            MinHeight = 32,
            Padding = new Thickness(10, 0, 10, 0)
        };
        ToolTipService.SetToolTip(tab, remotePath);
        AutomationProperties.SetName(tab, $"{profileName} · {remotePath}");
        editor.StateChanged += () => UpdateTabHeader(tab, profileName, remotePath, editor);
        UpdateTabHeader(tab, profileName, remotePath, editor);
        var document = new Document(key, session.SessionId, editor, tab);
        documents.Add(key, document);
        tabs!.TabItems.Add(tab);
        tabs.SelectedItem = tab;
        content!.Content = editor;
        window!.Title = text("editor.windowTitle");
        window.Activate();
    }

    public void SetSessionState(string sessionId, bool available)
    {
        foreach (var document in documents.Values.Where(item => item.SessionId == sessionId))
            document.Editor.SetSessionAvailable(available);
    }

    public void Configure(NativeSettings value)
    {
        ApplyTheme(value);
        foreach (var document in documents.Values) document.Editor.Configure(value);
    }

    public async Task<bool> ConfirmCloseAllAsync()
    {
        foreach (var document in documents.Values.ToArray())
            if (!await document.Editor.ConfirmCloseAsync()) return false;
        return true;
    }

    public void CloseAfterConfirmation()
    {
        if (window == null) return;
        allowClose = true;
        window.Close();
    }

    public void SetUpdateBusy(bool busy)
    {
        if (window != null) EnableWindow(WindowHandle(), !busy);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool EnableWindow(nint window, bool enable);

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        allowClose = true;
        if (window != null)
        {
            window.AppWindow.Closing -= WindowClosing;
            window.Closed -= WindowClosed;
            window.Close();
        }
        foreach (var document in documents.Values) document.Editor.Dispose();
        documents.Clear();
        window = null;
        root = null;
        tabs = null;
        content = null;
    }

    private void EnsureWindow()
    {
        if (window != null) return;
        window = new Window { Title = text("editor.windowTitle") };
        root = new Grid
        {
            RowDefinitions =
            {
                new RowDefinition { Height = GridLength.Auto },
                new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }
            }
        };
        ApplyTheme(settings());
        tabs = new TabView
        {
            IsAddTabButtonVisible = false,
            TabWidthMode = TabViewWidthMode.SizeToContent,
            Padding = new Thickness(6, 4, 6, 0),
            Background = Application.Current.Resources["ShellBackgroundBrush"] as Microsoft.UI.Xaml.Media.Brush
        };
        tabs.TabCloseRequested += TabCloseRequested;
        tabs.SelectionChanged += (_, _) =>
        {
            content!.Content = tabs.SelectedItem is TabViewItem tab && tab.Tag is string key && documents.TryGetValue(key, out var item)
                ? item.Editor
                : null;
        };
        content = new ContentControl
        {
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Stretch
        };
        root.Children.Add(tabs);
        root.Children.Add(content);
        Grid.SetRow(content, 1);
        AutomationProperties.SetName(tabs, text("editor.windowTitle"));
        window.Content = root;
        window.AppWindow.Resize(new SizeInt32(1280, 820));
        window.AppWindow.Closing += WindowClosing;
        window.Closed += WindowClosed;
        window.Activate();
    }

    private void ApplyTheme(NativeSettings value)
    {
        if (root == null) return;
        root.RequestedTheme = value.ThemeMode switch
        {
            "dark" => ElementTheme.Dark,
            "light" => ElementTheme.Light,
            _ => ElementTheme.Default
        };
    }

    private static void UpdateTabHeader(TabViewItem tab, string profileName, string remotePath, NativeRemoteEditor editor)
    {
        var prefix = editor.HasUnsavedChanges ? "● " : string.Empty;
        tab.Header = $"{prefix}{profileName} · {Path.GetFileName(remotePath)}";
        ToolTipService.SetToolTip(tab, remotePath);
    }

    private async void TabCloseRequested(TabView sender, TabViewTabCloseRequestedEventArgs args)
    {
        if (args.Tab.Tag is not string key || !documents.TryGetValue(key, out var document)) return;
        if (!await document.Editor.ConfirmCloseAsync()) return;
        documents.Remove(key);
        document.Editor.Dispose();
        sender.TabItems.Remove(args.Tab);
        if (sender.SelectedItem is TabViewItem selected && selected.Tag is string selectedKey && documents.TryGetValue(selectedKey, out var selectedDocument))
            content!.Content = selectedDocument.Editor;
        else content!.Content = null;
        if (documents.Count == 0) CloseAfterConfirmation();
    }

    private async void WindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (allowClose) return;
        args.Cancel = true;
        if (closePromptOpen) return;
        closePromptOpen = true;
        try
        {
            if (!await ConfirmCloseAllAsync()) return;
            CloseAfterConfirmation();
        }
        catch (Exception error) { Failed?.Invoke(error.Message); }
        finally { closePromptOpen = false; }
    }

    private void WindowClosed(object sender, WindowEventArgs args)
    {
        foreach (var document in documents.Values) document.Editor.Dispose();
        documents.Clear();
        if (window != null) window.AppWindow.Closing -= WindowClosing;
        window = null;
        root = null;
        tabs = null;
        content = null;
        allowClose = false;
    }

    private nint WindowHandle() => window == null ? 0 : WindowNative.GetWindowHandle(window);
    private static string Key(string sessionId, string path) => sessionId + "\n" + path;
}
