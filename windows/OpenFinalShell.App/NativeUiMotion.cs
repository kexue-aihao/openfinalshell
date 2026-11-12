using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Hosting;
using System.Numerics;

namespace OpenFinalShell.App;

internal enum NativeMotionKind
{
    Overlay,
    DrawerRight,
    Fade
}

/// <summary>Short composition-only transitions that never animate layout or block input.</summary>
internal static class NativeUiMotion
{
    private static readonly TimeSpan EnterDuration = TimeSpan.FromMilliseconds(180);
    private static readonly TimeSpan ExitDuration = TimeSpan.FromMilliseconds(120);

    public static bool AnimationsEnabled
    {
        get
        {
            try
            {
                return new Windows.UI.ViewManagement.UISettings().AnimationsEnabled &&
                    !NativeAccessibilityGuard.ReadHighContrast(
                        () => new Windows.UI.ViewManagement.AccessibilitySettings().HighContrast);
            }
            catch (System.Runtime.InteropServices.COMException)
            {
                return false;
            }
        }
    }

    public static async Task AnimateInAsync(FrameworkElement surface, UIElement? scrim,
        NativeMotionKind kind)
    {
        surface.IsHitTestVisible = true;
        surface.Opacity = 1;
        scrim?.Opacity = 1;
        if (!AnimationsEnabled || surface.XamlRoot == null) return;
        var visual = ElementCompositionPreview.GetElementVisual(surface);
        var compositor = visual.Compositor;
        ElementCompositionPreview.SetIsTranslationEnabled(surface, true);
        var offset = kind switch
        {
            NativeMotionKind.Overlay => new Vector3(0, 12, 0),
            NativeMotionKind.DrawerRight => new Vector3(24, 0, 0),
            _ => Vector3.Zero
        };
        visual.Properties.InsertVector3("Translation", offset);
        visual.Opacity = 0;
        visual.CenterPoint = new Vector3((float)surface.ActualWidth / 2, (float)surface.ActualHeight / 2, 0);
        visual.Scale = kind == NativeMotionKind.Overlay ? new Vector3(.98f, .98f, 1) : Vector3.One;

        var batch = compositor.CreateScopedBatch(CompositionBatchTypes.Animation);
        var easing = compositor.CreateCubicBezierEasingFunction(new Vector2(.1f, .9f), new Vector2(.2f, 1));
        var opacity = compositor.CreateScalarKeyFrameAnimation();
        opacity.InsertKeyFrame(1, 1, easing);
        opacity.Duration = EnterDuration;
        visual.StartAnimation("Opacity", opacity);
        if (offset != Vector3.Zero)
        {
            var translation = compositor.CreateVector3KeyFrameAnimation();
            translation.InsertKeyFrame(1, Vector3.Zero, easing);
            translation.Duration = EnterDuration;
            visual.StartAnimation("Translation", translation);
        }
        if (kind == NativeMotionKind.Overlay)
        {
            var scale = compositor.CreateVector3KeyFrameAnimation();
            scale.InsertKeyFrame(1, Vector3.One, easing);
            scale.Duration = EnterDuration;
            visual.StartAnimation("Scale", scale);
        }
        if (scrim != null)
        {
            var scrimVisual = ElementCompositionPreview.GetElementVisual(scrim);
            scrimVisual.Opacity = 0;
            var scrimOpacity = compositor.CreateScalarKeyFrameAnimation();
            scrimOpacity.InsertKeyFrame(1, 1, easing);
            scrimOpacity.Duration = TimeSpan.FromMilliseconds(120);
            scrimVisual.StartAnimation("Opacity", scrimOpacity);
        }
        batch.End();
        await Task.Delay(EnterDuration);
        visual.Properties.InsertVector3("Translation", Vector3.Zero);
        visual.Opacity = 1;
        visual.Scale = Vector3.One;
    }

    public static async Task AnimateOutAsync(FrameworkElement surface, UIElement? scrim,
        NativeMotionKind kind)
    {
        surface.IsHitTestVisible = false;
        if (!AnimationsEnabled || surface.XamlRoot == null)
        {
            surface.Opacity = 0;
            if (scrim != null) scrim.Opacity = 0;
            return;
        }
        var visual = ElementCompositionPreview.GetElementVisual(surface);
        var compositor = visual.Compositor;
        ElementCompositionPreview.SetIsTranslationEnabled(surface, true);
        var offset = kind switch
        {
            NativeMotionKind.Overlay => new Vector3(0, 8, 0),
            NativeMotionKind.DrawerRight => new Vector3(18, 0, 0),
            _ => Vector3.Zero
        };
        var easing = compositor.CreateCubicBezierEasingFunction(new Vector2(.7f, 0), new Vector2(1, 1));
        var opacity = compositor.CreateScalarKeyFrameAnimation();
        opacity.InsertKeyFrame(1, 0, easing);
        opacity.Duration = ExitDuration;
        visual.StartAnimation("Opacity", opacity);
        if (offset != Vector3.Zero)
        {
            var translation = compositor.CreateVector3KeyFrameAnimation();
            translation.InsertKeyFrame(1, offset, easing);
            translation.Duration = ExitDuration;
            visual.StartAnimation("Translation", translation);
        }
        if (scrim != null)
        {
            var scrimOpacity = compositor.CreateScalarKeyFrameAnimation();
            scrimOpacity.InsertKeyFrame(1, 0, easing);
            scrimOpacity.Duration = ExitDuration;
            ElementCompositionPreview.GetElementVisual(scrim).StartAnimation("Opacity", scrimOpacity);
        }
        await Task.Delay(ExitDuration);
        surface.Opacity = 1;
        if (scrim != null) scrim.Opacity = 1;
        if (surface.Visibility == Visibility.Collapsed) surface.Opacity = 1;
        visual.Opacity = 1;
        visual.Properties.InsertVector3("Translation", Vector3.Zero);
    }

    public static Task FadeInAsync(FrameworkElement element) => AnimateInAsync(element, null, NativeMotionKind.Fade);
}
