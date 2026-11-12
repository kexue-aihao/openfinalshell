using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using OpenFinalShell.App.ViewModels;
using OpenFinalShell.Core;
using Windows.Foundation;
using Windows.Graphics.DirectX;
using Microsoft.UI.Input;
using System.Collections.Generic;
using OpenFinalShell.App;

namespace OpenFinalShell.App.Controls;

/// <summary>
/// Win2D presentation surface for the worker's RGBA8888 dirty-rectangle
/// protocol. The surface keeps a complete frame so partial updates never
/// expose uninitialized pixels after a resize.
/// </summary>
public sealed class NativeRdpSurface : UserControl, IDisposable
{
    private readonly CanvasControl canvas = new() { ClearColor = Colors.Black };
    private readonly NativeRdpFrameBuffer frameBuffer = new();
    private readonly Queue<PendingFrame> pendingFrames = new();
    private CanvasRenderTarget? renderedFrame;
    private uint renderedWidth;
    private uint renderedHeight;
    private CancellationTokenSource? resizeCancellation;
    private readonly object queueGate = new();
    private int invalidationScheduled;
    private int pointerScheduled;
    private int pendingPointerVersion;
    private int sentPointerVersion;
    private uint pendingPointerX;
    private uint pendingPointerY;
    private uint pendingPointerButtons;
    private bool disposed;
    private readonly RdpSessionViewModel session;

    public NativeRdpSurface(RdpSessionViewModel session)
    {
        this.session = session;
        Content = canvas;
        canvas.Draw += Draw;
        canvas.PointerPressed += HandlePointerPressed;
        canvas.PointerReleased += HandlePointerReleased;
        canvas.PointerMoved += HandlePointerMoved;
        canvas.PointerWheelChanged += HandlePointerWheelChanged;
        canvas.KeyDown += HandleKeyDown;
        canvas.KeyUp += HandleKeyUp;
        canvas.CharacterReceived += HandleCharacterReceived;
        canvas.SizeChanged += HandleSizeChanged;
        canvas.IsTabStop = true;
        session.Frame += OnFrame;
        session.PropertyChanged += SessionPropertyChanged;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(this, $"RDP desktop · {session.Host}");
    }

    private void OnFrame(NativeRdpFrame frame)
    {
        try
        {
            var patches = frameBuffer.Apply(frame);
            lock (queueGate)
            {
                if (pendingFrames.Count >= 30)
                {
                    pendingFrames.Clear();
                    var pixels = frameBuffer.CopyPixels(out var width, out var height);
                    if (pixels != null) pendingFrames.Enqueue(new(width, height, new[] { new NativeRdpFramePatch(0, 0, width, height, pixels) }));
                }
                else pendingFrames.Enqueue(new(frame.CanvasWidth, frame.CanvasHeight, patches));
            }
            if (Interlocked.Exchange(ref invalidationScheduled, 1) == 0 &&
                !canvas.DispatcherQueue.TryEnqueue(() =>
                {
                    Volatile.Write(ref invalidationScheduled, 0);
                    canvas.Invalidate();
                }))
                Volatile.Write(ref invalidationScheduled, 0);
        }
        catch (Exception error)
        {
            canvas.DispatcherQueue.TryEnqueue(() => Microsoft.UI.Xaml.Automation.AutomationProperties.SetHelpText(this, $"RDP frame error: {error.Message}"));
        }
    }

    private void Draw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        PendingFrame[] frames;
        lock (queueGate) { frames = pendingFrames.ToArray(); pendingFrames.Clear(); }
        foreach (var frame in frames)
        {
            if (renderedFrame == null || renderedWidth != frame.Width || renderedHeight != frame.Height)
            {
                renderedFrame?.Dispose();
                renderedWidth = frame.Width; renderedHeight = frame.Height;
                renderedFrame = new CanvasRenderTarget(sender, renderedWidth, renderedHeight, 96,
                    DirectXPixelFormat.R8G8B8A8UIntNormalized, CanvasAlphaMode.Premultiplied);
                using var clear = renderedFrame.CreateDrawingSession(); clear.Clear(Colors.Black);
            }
            using var drawing = renderedFrame.CreateDrawingSession();
            foreach (var patch in frame.Patches)
            {
                using var bitmap = CanvasBitmap.CreateFromBytes(sender, patch.RgbaPixels, checked((int)patch.Width), checked((int)patch.Height), DirectXPixelFormat.R8G8B8A8UIntNormalized);
                drawing.DrawImage(bitmap, new Rect(patch.X, patch.Y, patch.Width, patch.Height));
            }
        }
        if (renderedFrame == null) return;
        var destination = new Rect(0, 0, sender.ActualWidth, sender.ActualHeight);
        args.DrawingSession.DrawImage(renderedFrame, destination);
    }

    private async void HandleSizeChanged(object sender, SizeChangedEventArgs args)
    {
        if (args.NewSize.Width < 1 || args.NewSize.Height < 1) return;
        var scale = XamlRoot?.RasterizationScale ?? 1.0;
        resizeCancellation?.Cancel(); resizeCancellation?.Dispose();
        resizeCancellation = new CancellationTokenSource();
        var token = resizeCancellation.Token;
        try
        {
            await Task.Delay(120, token);
            await session.ResizeAsync((uint)Math.Clamp(args.NewSize.Width * scale, 320, 8192), (uint)Math.Clamp(args.NewSize.Height * scale, 320, 8192), (uint)Math.Clamp(96 * scale, 96, 384), token);
        }
        catch (OperationCanceledException) { }
        catch { /* worker state/error is surfaced by the session view model */ }
    }

    private void SessionPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs args) =>
        canvas.DispatcherQueue.TryEnqueue(canvas.Invalidate);

    private uint PointerButtons(PointerPointProperties properties) =>
        (properties.IsLeftButtonPressed ? 1u : 0u) | (properties.IsRightButtonPressed ? 2u : 0u) | (properties.IsMiddleButtonPressed ? 4u : 0u);

    private void HandlePointerPressed(object sender, PointerRoutedEventArgs args) => UiTaskRunner.Run(async () =>
    {
        canvas.Focus(FocusState.Pointer);
        canvas.CapturePointer(args.Pointer);
        await FlushPointerMoveAsync();
        await SendPointerAsync(args);
    }, ReportInteractionError);
    private void HandlePointerReleased(object sender, PointerRoutedEventArgs args) => UiTaskRunner.Run(async () =>
    {
        await FlushPointerMoveAsync();
        await SendPointerAsync(args);
        canvas.ReleasePointerCapture(args.Pointer);
    }, ReportInteractionError);
    private void HandlePointerMoved(object sender, PointerRoutedEventArgs args)
    {
        var point = args.GetCurrentPoint(canvas);
        pendingPointerX = ToPixel(point.Position.X);
        pendingPointerY = ToPixel(point.Position.Y);
        pendingPointerButtons = PointerButtons(point.Properties);
        Interlocked.Increment(ref pendingPointerVersion);
        SchedulePointerFlush();
    }
    private void SchedulePointerFlush()
    {
        if (disposed || Interlocked.Exchange(ref pointerScheduled, 1) != 0) return;
        UiTaskRunner.Run(async () =>
        {
            try { await FlushPointerMoveAsync(); }
            finally
            {
                Volatile.Write(ref pointerScheduled, 0);
                if (Volatile.Read(ref sentPointerVersion) != Volatile.Read(ref pendingPointerVersion))
                    SchedulePointerFlush();
            }
        }, ReportInteractionError);
    }
    private async Task FlushPointerMoveAsync()
    {
        if (disposed) return;
        var version = Volatile.Read(ref pendingPointerVersion);
        if (version == Volatile.Read(ref sentPointerVersion)) return;
        await session.PointerAsync(pendingPointerX, pendingPointerY, pendingPointerButtons);
        Volatile.Write(ref sentPointerVersion, version);
    }
    private void HandlePointerWheelChanged(object sender, PointerRoutedEventArgs args) => UiTaskRunner.Run(async () =>
    {
        var point = args.GetCurrentPoint(canvas); var position = point.Position;
        var delta = point.Properties.MouseWheelDelta;
        await session.PointerAsync(ToPixel(position.X), ToPixel(position.Y), PointerButtons(point.Properties), 0, delta);
        args.Handled = true;
    }, ReportInteractionError);

    private async Task SendPointerAsync(PointerRoutedEventArgs args)
    {
        var point = args.GetCurrentPoint(canvas);
        await session.PointerAsync(ToPixel(point.Position.X), ToPixel(point.Position.Y), PointerButtons(point.Properties));
    }

    private uint ToPixel(double value) => (uint)Math.Clamp(value * (XamlRoot?.RasterizationScale ?? 1), 0, 8192);

    private void HandleKeyDown(object sender, KeyRoutedEventArgs args) => UiTaskRunner.Run(async () =>
    {
        if (TryScanCode(args.Key, out var scan, out var extended)) { await session.KeyAsync(scan, true, extended); args.Handled = true; }
    }, ReportInteractionError);

    private void HandleKeyUp(object sender, KeyRoutedEventArgs args) => UiTaskRunner.Run(async () =>
    {
        if (TryScanCode(args.Key, out var scan, out var extended)) { await session.KeyAsync(scan, false, extended); args.Handled = true; }
    }, ReportInteractionError);

    private void HandleCharacterReceived(UIElement sender, CharacterReceivedRoutedEventArgs args) => UiTaskRunner.Run(async () =>
    {
        if (char.IsControl(args.Character)) return;
        await session.KeyAsync(0, true, false, args.Character);
        await session.KeyAsync(0, false, false, args.Character);
        args.Handled = true;
    }, ReportInteractionError);

    private void ReportInteractionError(Exception error) =>
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetHelpText(this, $"RDP input error: {error.Message}");

    private static bool TryScanCode(Windows.System.VirtualKey key, out uint scan, out bool extended)
    {
        extended = false;
        scan = key switch
        {
            Windows.System.VirtualKey.Enter => 0x1c,
            Windows.System.VirtualKey.Escape => 0x01,
            Windows.System.VirtualKey.Back => 0x0e,
            Windows.System.VirtualKey.Tab => 0x0f,
            Windows.System.VirtualKey.Space => 0x39,
            Windows.System.VirtualKey.Shift => 0x2a,
            Windows.System.VirtualKey.Control => 0x1d,
            Windows.System.VirtualKey.Menu => 0x38,
            Windows.System.VirtualKey.Left => 0x4b,
            Windows.System.VirtualKey.Right => 0x4d,
            Windows.System.VirtualKey.Up => 0x48,
            Windows.System.VirtualKey.Down => 0x50,
            Windows.System.VirtualKey.Home => 0x47,
            Windows.System.VirtualKey.End => 0x4f,
            Windows.System.VirtualKey.PageUp => 0x49,
            Windows.System.VirtualKey.PageDown => 0x51,
            Windows.System.VirtualKey.Delete => 0x53,
            Windows.System.VirtualKey.Insert => 0x52,
            _ => 0
        };
        if (key is Windows.System.VirtualKey.Left or Windows.System.VirtualKey.Right or Windows.System.VirtualKey.Up or Windows.System.VirtualKey.Down or Windows.System.VirtualKey.Home or Windows.System.VirtualKey.End or Windows.System.VirtualKey.PageUp or Windows.System.VirtualKey.PageDown or Windows.System.VirtualKey.Delete or Windows.System.VirtualKey.Insert) extended = true;
        return scan != 0;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        resizeCancellation?.Cancel(); resizeCancellation?.Dispose(); resizeCancellation = null;
        session.Frame -= OnFrame;
        session.PropertyChanged -= SessionPropertyChanged;
        canvas.Draw -= Draw;
        renderedFrame?.Dispose(); renderedFrame = null;
    }

    private sealed record PendingFrame(uint Width, uint Height, IReadOnlyList<NativeRdpFramePatch> Patches);
}
