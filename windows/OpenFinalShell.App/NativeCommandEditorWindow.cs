using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenFinalShell.Core;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Windows.Graphics;
using Windows.System;
using WinRT.Interop;

namespace OpenFinalShell.App;

internal enum NativeCommandEditorAction { Cancel, Send, SaveSnippet }

/// <summary>
/// A real owned HWND: Windows handles title-bar dragging, resizing and monitor
/// transitions. A translated ContentDialog can only move within its XamlRoot.
/// </summary>
internal sealed class NativeCommandEditorWindow : Window
{
    private readonly Window owner;
    private readonly NativeStore store;
    private readonly Grid viewport;
    private readonly Grid root;
    private readonly TextBox commandInput;
    private readonly ListView targets;
    private readonly CheckBox expand;
    private readonly ToggleSwitch autoEnter;
    private readonly Button send;
    private readonly Button save;
    private readonly double zoom;
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer saveSizeTimer;
    private readonly TaskCompletionSource<NativeCommandEditorAction> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private NativeCommandEditorAction action;
    private bool composing;
    private double? lastRestoredWidthDip;
    private double? lastRestoredHeightDip;

    internal NativeCommandEditorWindow(Window owner, NativeStore store, NativeSettings settings, Localization text,
        IReadOnlyList<NativeSessionSnapshot> sessions, string? activeSessionId, string initialCommand, bool appendEnter)
    {
        this.owner = owner;
        this.store = store;
        zoom = settings.UiScale / 100d;
        Title = text["commandEditor.title"];
        var hwnd = WindowNative.GetWindowHandle(this);
        var ownerHandle = WindowNative.GetWindowHandle(owner);
        // GWLP_HWNDPARENT sets an owner for a top-level window, not a child HWND.
        Marshal.SetLastPInvokeError(0);
        var previousOwner = IntPtr.Size == 8
            ? SetWindowLongPtr(hwnd, -8, ownerHandle)
            : new nint(SetWindowLong(hwnd, -8, ownerHandle.ToInt32()));
        if (previousOwner == 0 && Marshal.GetLastPInvokeError() is var error && error != 0)
            throw new System.ComponentModel.Win32Exception(error);
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.SetBorderAndTitleBar(true, true);
            presenter.IsResizable = true;
            presenter.IsMaximizable = true;
            presenter.IsMinimizable = false;
        }
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "OpenFinalShell.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);

        targets = new ListView { SelectionMode = ListViewSelectionMode.Multiple };
        AutomationProperties.SetName(targets, text["commandEditor.sendTo"]);
        foreach (var session in sessions)
        {
            var item = new ListViewItem { Content = session.ProfileName, Tag = session.SessionId };
            targets.Items.Add(item);
            if (session.SessionId == activeSessionId) targets.SelectedItems.Add(item);
        }
        commandInput = new TextBox
        {
            PlaceholderText = text["commandEditor.placeholder"], AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Consolas"),
            MinHeight = 120, Text = initialCommand
        };
        AutomationProperties.SetName(commandInput, text["native.commands.command"]);
        AutomationProperties.SetAutomationId(commandInput, "CommandEditorInput");
        ScrollViewer.SetVerticalScrollBarVisibility(commandInput, ScrollBarVisibility.Auto);
        expand = new CheckBox { Content = text["commandEditor.expandVars"], IsChecked = true };
        ToolTipService.SetToolTip(expand, text["commandEditor.expandVarsHint"] + " {{host}} {{user}} {{port}}");
        autoEnter = new ToggleSwitch { Header = text["commandEditor.autoEnter"], IsOn = appendEnter };
        ToolTipService.SetToolTip(autoEnter, text["commandEditor.autoEnterHint"]);
        send = ActionButton(text["commandEditor.send"], NativeCommandEditorAction.Send);
        save = ActionButton(text["commandEditor.saveAsSnippet"], NativeCommandEditorAction.SaveSnippet);
        var cancel = ActionButton(text["common.cancel"], NativeCommandEditorAction.Cancel);
        AutomationProperties.SetAutomationId(send, "CommandEditorSend");
        AutomationProperties.SetAutomationId(save, "CommandEditorSaveSnippet");
        AutomationProperties.SetAutomationId(cancel, "CommandEditorCancel");
        var actions = new Grid { ColumnSpacing = 8, Margin = new Thickness(0, 16, 0, 0) };
        foreach (var button in new[] { send, save, cancel })
        {
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(button, actions.Children.Count);
            actions.Children.Add(button);
        }
        var body = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = new StackPanel
            {
                Spacing = 12,
                Children = { commandInput, new TextBlock { Text = text["commandEditor.sendTo"] }, targets, expand, autoEnter }
            }
        };
        root = new Grid
        {
            Padding = new Thickness(20), HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top, TabFocusNavigation = KeyboardNavigationMode.Cycle,
            RequestedTheme = settings.ThemeMode switch { "dark" => ElementTheme.Dark, "light" => ElementTheme.Light, _ => ElementTheme.Default },
            Background = Application.Current.Resources["WorkspaceBackgroundBrush"] as Brush,
            RenderTransform = new ScaleTransform { ScaleX = zoom, ScaleY = zoom },
            RowDefinitions = { new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }, new RowDefinition { Height = GridLength.Auto } },
            Children = { body, actions }
        };
        Grid.SetRow(actions, 1);
        AutomationProperties.SetName(root, Title);
        AutomationProperties.SetAutomationId(root, "NativeCommandEditorWindow");
        viewport = new Grid { Background = root.Background, Children = { root } };
        Content = viewport;
        // The content Grid can keep its old DesiredSize after a native resize.
        // Window.SizeChanged reports the real client size in DIPs.
        SizeChanged += (_, args) =>
        {
            UpdateLayout(args.Size.Width, args.Size.Height);
            RememberRestoredSize(args.Size.Width, args.Size.Height);
        };
        commandInput.TextChanged += (_, _) => UpdateActions();
        targets.SelectionChanged += (_, _) => UpdateActions();
        commandInput.TextCompositionStarted += (_, _) => composing = true;
        commandInput.TextCompositionEnded += (_, _) => composing = false;
        var shortcut = new KeyboardAccelerator { Key = VirtualKey.Enter, Modifiers = VirtualKeyModifiers.Control };
        shortcut.Invoked += (_, args) =>
        {
            args.Handled = true;
            if (!composing && send.IsEnabled) Finish(NativeCommandEditorAction.Send);
        };
        commandInput.KeyboardAccelerators.Add(shortcut);
        root.KeyDown += (_, args) =>
        {
            if (args.Key != VirtualKey.Escape || composing) return;
            args.Handled = true;
            Finish(NativeCommandEditorAction.Cancel);
        };
        root.Loaded += (_, _) => commandInput.Focus(FocusState.Programmatic);
        root.ActualThemeChanged += (_, _) => ApplyTitleBarTheme();
        saveSizeTimer = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread().CreateTimer();
        saveSizeTimer.Interval = TimeSpan.FromMilliseconds(350);
        saveSizeTimer.IsRepeating = false;
        saveSizeTimer.Tick += (_, _) => SaveRememberedSize(onlyWhenRestored: true);
        Closed += (_, _) =>
        {
            saveSizeTimer.Stop();
            SaveRememberedSize(onlyWhenRestored: false);
            completion.TrySetResult(action);
        };
        UpdateActions();

        var workArea = DisplayArea.GetFromWindowId(owner.AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var dpi = GetDpiForWindow(ownerHandle) / 96d;
        var workspace = store.Find("nativeWorkspace", "nativeWorkspace");
        var size = NativeCommandEditorLayoutPolicy.ResolveWindowSize(
            workArea.Width, workArea.Height, dpi, zoom,
            ReadSavedSize(workspace, "commandEditorWidthDip"), ReadSavedSize(workspace, "commandEditorHeightDip"));
        lastRestoredWidthDip = size.Width / dpi;
        lastRestoredHeightDip = size.Height / dpi;
        AppWindow.ResizeClient(new SizeInt32(size.Width, size.Height));
        var outerSize = AppWindow.Size;
        var ownerPosition = owner.AppWindow.Position;
        var ownerSize = owner.AppWindow.Size;
        AppWindow.Move(new PointInt32(
            Math.Clamp(ownerPosition.X + (ownerSize.Width - outerSize.Width) / 2, workArea.X, workArea.X + Math.Max(0, workArea.Width - outerSize.Width)),
            Math.Clamp(ownerPosition.Y + (ownerSize.Height - outerSize.Height) / 2, workArea.Y, workArea.Y + Math.Max(0, workArea.Height - outerSize.Height))));
        UpdateLayout(size.Width / dpi, size.Height / dpi);
        ApplyTitleBarTheme();
    }

    internal string Command => commandInput.Text;
    internal bool AppendEnter => autoEnter.IsOn;
    internal bool ExpandVariables => expand.IsChecked == true;
    internal string[] TargetSessionIds => targets.SelectedItems.OfType<ListViewItem>().Select(item => (string)item.Tag).ToArray();

    internal async Task<NativeCommandEditorAction> ShowAsync()
    {
        var ownerHandle = WindowNative.GetWindowHandle(owner);
        var ownerEnabled = IsWindowEnabled(ownerHandle);
        try
        {
            if (ownerEnabled) EnableWindow(ownerHandle, false);
            Activate();
            return await completion.Task;
        }
        finally
        {
            if (IsWindow(ownerHandle))
            {
                if (ownerEnabled) EnableWindow(ownerHandle, true);
                owner.Activate();
            }
        }
    }

    private Button ActionButton(string label, NativeCommandEditorAction result)
    {
        var button = new Button
        {
            Content = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center },
            HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Center
        };
        AutomationProperties.SetName(button, label);
        button.Click += (_, _) => Finish(result);
        return button;
    }

    private void Finish(NativeCommandEditorAction result) { action = result; Close(); }
    private void UpdateActions()
    {
        var valid = !string.IsNullOrWhiteSpace(commandInput.Text) && !commandInput.Text.Contains('\0') && commandInput.Text.Length <= 32768;
        send.IsEnabled = valid && targets.SelectedItems.Count > 0;
        save.IsEnabled = valid;
    }
    private void UpdateLayout(double width, double height)
    {
        viewport.Width = width;
        viewport.Height = height;
        root.Width = width / zoom;
        root.Height = height / zoom;
        commandInput.Height = Math.Clamp((root.Height - 180) * .65, 120, 760);
        targets.MaxHeight = Math.Clamp(root.Height * .2, 80, 190);
    }

    private void RememberRestoredSize(double widthDip, double heightDip)
    {
        if (AppWindow.Presenter is not OverlappedPresenter { State: OverlappedPresenterState.Restored }
            || !double.IsFinite(widthDip) || !double.IsFinite(heightDip) || widthDip <= 0 || heightDip <= 0)
            return;

        lastRestoredWidthDip = widthDip;
        lastRestoredHeightDip = heightDip;
        saveSizeTimer.Stop();
        saveSizeTimer.Start();
    }

    private void SaveRememberedSize(bool onlyWhenRestored)
    {
        if (onlyWhenRestored && AppWindow.Presenter is not OverlappedPresenter { State: OverlappedPresenterState.Restored }) return;
        if (lastRestoredWidthDip is not { } width || lastRestoredHeightDip is not { } height
            || !double.IsFinite(width) || !double.IsFinite(height)) return;
        try
        {
            store.Patch("nativeWorkspace", "nativeWorkspace", new JsonObject
            {
                ["commandEditorWidthDip"] = width,
                ["commandEditorHeightDip"] = height
            });
        }
        catch (Exception error) { System.Diagnostics.Debug.WriteLine($"Could not save command editor size: {error.Message}"); }
    }

    private static double? ReadSavedSize(JsonObject? workspace, string key)
    {
        if (workspace?[key] is not JsonValue value
            || value.GetValueKind() != System.Text.Json.JsonValueKind.Number
            || !value.TryGetValue<double>(out var size)
            || !double.IsFinite(size) || size <= 0)
            return null;
        return size;
    }

    private void ApplyTitleBarTheme()
    {
        var titleBar = AppWindow.TitleBar;
        if (NativeAccessibilityGuard.ReadHighContrast(() => new Windows.UI.ViewManagement.AccessibilitySettings().HighContrast))
        {
            titleBar.BackgroundColor = titleBar.ForegroundColor = titleBar.ButtonBackgroundColor = titleBar.ButtonForegroundColor = null;
            return;
        }
        var dark = root.ActualTheme == ElementTheme.Dark;
        var background = (root.Background as SolidColorBrush)?.Color ?? Microsoft.UI.Colors.Transparent;
        var foreground = dark ? Microsoft.UI.Colors.White : Microsoft.UI.Colors.Black;
        titleBar.BackgroundColor = titleBar.ButtonBackgroundColor = background;
        titleBar.ForegroundColor = titleBar.ButtonForegroundColor = foreground;
    }

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern int SetWindowLong(nint hwnd, int index, int value);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool EnableWindow(nint hwnd, bool enable);
}
