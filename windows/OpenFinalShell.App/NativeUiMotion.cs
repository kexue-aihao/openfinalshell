using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Hosting;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace OpenFinalShell.App;

internal enum NativeMotionKind
{
    Overlay,
    DrawerRight,
    Fade,
    Content
}

/// <summary>Short composition-only transitions that never animate layout or block input.</summary>
internal static class NativeUiMotion
{
    private static readonly TimeSpan EnterDuration = TimeSpan.FromMilliseconds(180);
    private static readonly TimeSpan ExitDuration = TimeSpan.FromMilliseconds(120);
    private static readonly TimeSpan ContentEnterDuration = TimeSpan.FromMilliseconds(160);
    private static readonly TimeSpan ContentExitDuration = TimeSpan.FromMilliseconds(90);
    private static readonly TimeSpan ScrimDuration = TimeSpan.FromMilliseconds(120);

    // UISettings and AccessibilitySettings are COM-backed. Creating them for
    // every transition is far more expensive than reading the cached flags,
    // and the OS change event lets us refresh high contrast on demand.
    private static readonly Lazy<Windows.UI.ViewManagement.UISettings?> AnimationSettings = new(() =>
    {
        try { return new Windows.UI.ViewManagement.UISettings(); }
        catch (COMException) { return null; }
    });
    private static readonly Lazy<Windows.UI.ViewManagement.AccessibilitySettings?> AccessibilitySettings = new(() =>
    {
        try { return new Windows.UI.ViewManagement.AccessibilitySettings(); }
        catch (COMException) { return null; }
    });
    private static bool? highContrast;

    // Each element owns a motion generation. A newer transition supersedes an
    // in-flight one, so a rapid open/close can never restore the wrong state.
    private static readonly ConditionalWeakTable<FrameworkElement, StrongBox<int>> MotionVersions = new();

    public static bool AnimationsEnabled
    {
        get
        {
            try
            {
                if (AnimationSettings.Value is not { AnimationsEnabled: true }) return false;
                return !HighContrast;
            }
            catch (COMException)
            {
                return false;
            }
        }
    }

    /// <summary>High-contrast state shared by animation, backdrop and theme paths.</summary>
    public static bool HighContrast
    {
        get
        {
            if (highContrast is { } cached) return cached;
            var value = NativeAccessibilityGuard.ReadHighContrast(
                () => AccessibilitySettings.Value?.HighContrast == true);
            highContrast = value;
            return value;
        }
    }

    /// <summary>Call after the OS high-contrast setting changes.</summary>
    public static void InvalidateAccessibilityCache() => highContrast = null;

    public static async Task AnimateInAsync(FrameworkElement surface, UIElement? scrim,
        NativeMotionKind kind, CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested) return;
        surface.IsHitTestVisible = true;
        surface.Opacity = 1;
        if (scrim != null) scrim.Opacity = 1;

        var version = NextVersion(surface);
        var visual = GetVisual(surface);
        if (visual == null || !AnimationsEnabled)
        {
            if (visual != null) ResetVisible(visual);
            ResetScrim(scrim);
            return;
        }

        var compositor = visual.Compositor;
        ElementCompositionPreview.SetIsTranslationEnabled(surface, true);
        var offset = EnterOffset(kind);
        var duration = EnterDurationFor(kind);
        var easing = compositor.CreateCubicBezierEasingFunction(new Vector2(.1f, .9f), new Vector2(.2f, 1));

        visual.Properties.InsertVector3("Translation", offset);
        visual.Opacity = 0;
        visual.CenterPoint = new Vector3((float)surface.ActualWidth / 2, (float)surface.ActualHeight / 2, 0);
        visual.Scale = kind == NativeMotionKind.Overlay ? new Vector3(.98f, .98f, 1) : Vector3.One;

        var batch = compositor.CreateScopedBatch(CompositionBatchTypes.Animation);
        var opacity = compositor.CreateScalarKeyFrameAnimation();
        opacity.InsertKeyFrame(1, 1, easing);
        opacity.Duration = duration;
        visual.StartAnimation("Opacity", opacity);
        if (offset != Vector3.Zero)
        {
            var translation = compositor.CreateVector3KeyFrameAnimation();
            translation.InsertKeyFrame(1, Vector3.Zero, easing);
            translation.Duration = duration;
            visual.StartAnimation("Translation", translation);
        }
        if (kind == NativeMotionKind.Overlay)
        {
            var scale = compositor.CreateVector3KeyFrameAnimation();
            scale.InsertKeyFrame(1, Vector3.One, easing);
            scale.Duration = duration;
            visual.StartAnimation("Scale", scale);
        }
        var scrimVisual = GetVisual(scrim);
        if (scrimVisual != null)
        {
            scrimVisual.Opacity = 0;
            var scrimOpacity = compositor.CreateScalarKeyFrameAnimation();
            scrimOpacity.InsertKeyFrame(1, 1, easing);
            scrimOpacity.Duration = ScrimDuration;
            scrimVisual.StartAnimation("Opacity", scrimOpacity);
        }

        await CompleteBatchAsync(batch, duration);
        if (cancellationToken.IsCancellationRequested || !IsCurrent(surface, version)) return;
        ResetVisible(visual);
        if (scrimVisual != null) scrimVisual.Opacity = 1;
    }

    public static async Task AnimateOutAsync(FrameworkElement surface, UIElement? scrim,
        NativeMotionKind kind, CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested) return;
        surface.IsHitTestVisible = false;
        var version = NextVersion(surface);
        var visual = GetVisual(surface);
        if (visual == null || !AnimationsEnabled)
        {
            surface.Opacity = 0;
            if (scrim != null) scrim.Opacity = 0;
            if (visual != null) ResetVisible(visual);
            return;
        }

        var compositor = visual.Compositor;
        ElementCompositionPreview.SetIsTranslationEnabled(surface, true);
        var offset = ExitOffset(kind);
        var duration = ExitDurationFor(kind);
        var easing = compositor.CreateCubicBezierEasingFunction(new Vector2(.7f, 0), new Vector2(1, 1));

        var batch = compositor.CreateScopedBatch(CompositionBatchTypes.Animation);
        var opacity = compositor.CreateScalarKeyFrameAnimation();
        opacity.InsertKeyFrame(1, 0, easing);
        opacity.Duration = duration;
        visual.StartAnimation("Opacity", opacity);
        if (offset != Vector3.Zero)
        {
            var translation = compositor.CreateVector3KeyFrameAnimation();
            translation.InsertKeyFrame(1, offset, easing);
            translation.Duration = duration;
            visual.StartAnimation("Translation", translation);
        }
        var scrimVisual = GetVisual(scrim);
        if (scrimVisual != null)
        {
            var scrimOpacity = compositor.CreateScalarKeyFrameAnimation();
            scrimOpacity.InsertKeyFrame(1, 0, easing);
            scrimOpacity.Duration = duration;
            scrimVisual.StartAnimation("Opacity", scrimOpacity);
        }

        await CompleteBatchAsync(batch, duration);
        if (cancellationToken.IsCancellationRequested || !IsCurrent(surface, version)) return;
        // Stay hidden instead of restoring Opacity=1. Callers collapse the
        // surface next, and a fast reopen starts a fresh AnimateIn.
        visual.Opacity = 0;
        visual.Properties.InsertVector3("Translation", offset);
        if (scrimVisual != null) scrimVisual.Opacity = 0;
    }

    public static Task FadeInAsync(FrameworkElement element) =>
        AnimateInAsync(element, null, NativeMotionKind.Fade);

    private static int NextVersion(FrameworkElement element) =>
        Interlocked.Increment(ref MotionVersions.GetOrCreateValue(element).Value);

    private static bool IsCurrent(FrameworkElement element, int version) =>
        MotionVersions.TryGetValue(element, out var current) && Volatile.Read(ref current.Value) == version;

    private static Visual? GetVisual(UIElement? element)
    {
        if (element?.XamlRoot == null) return null;
        try { return ElementCompositionPreview.GetElementVisual(element); }
        catch (Exception) { return null; }
    }

    private static void ResetVisible(Visual visual)
    {
        visual.Opacity = 1;
        visual.Scale = Vector3.One;
        visual.Properties.InsertVector3("Translation", Vector3.Zero);
    }

    private static void ResetScrim(UIElement? scrim)
    {
        var scrimVisual = GetVisual(scrim);
        if (scrimVisual != null) scrimVisual.Opacity = 1;
    }

    private static Vector3 EnterOffset(NativeMotionKind kind) => kind switch
    {
        NativeMotionKind.Overlay => new Vector3(0, 12, 0),
        NativeMotionKind.DrawerRight => new Vector3(24, 0, 0),
        NativeMotionKind.Content => new Vector3(0, 6, 0),
        _ => Vector3.Zero
    };

    private static Vector3 ExitOffset(NativeMotionKind kind) => kind switch
    {
        NativeMotionKind.Overlay => new Vector3(0, 8, 0),
        NativeMotionKind.DrawerRight => new Vector3(18, 0, 0),
        NativeMotionKind.Content => new Vector3(0, 4, 0),
        _ => Vector3.Zero
    };

    private static TimeSpan EnterDurationFor(NativeMotionKind kind) =>
        kind == NativeMotionKind.Content ? ContentEnterDuration : EnterDuration;

    private static TimeSpan ExitDurationFor(NativeMotionKind kind) =>
        kind == NativeMotionKind.Content ? ContentExitDuration : ExitDuration;

    private static async Task CompleteBatchAsync(CompositionScopedBatch batch, TimeSpan duration)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Completed(object? sender, CompositionBatchCompletedEventArgs args) => completion.TrySetResult(true);
        batch.Completed += Completed;
        try
        {
            try { batch.End(); }
            catch (Exception)
            {
                batch.Completed -= Completed;
                return;
            }
            // Occluded windows may not tick composition animations, so never
            // let a caller wait forever for a batch that will not complete.
            await Task.WhenAny(completion.Task, Task.Delay(duration + TimeSpan.FromMilliseconds(250)));
        }
        finally
        {
            batch.Completed -= Completed;
        }
    }
}
