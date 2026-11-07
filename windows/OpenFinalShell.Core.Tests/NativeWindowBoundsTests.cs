using System.Text.Json.Nodes;
using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeWindowBoundsTests
{
    public static void Run(Action<bool, string> check)
    {
        check(NativeWindowBounds.Read(null) == null, "Window bounds are absent on first launch");
        check(NativeWindowBounds.Read(new JsonObject { ["windowWidth"] = 1024, ["windowHeight"] = 768, ["windowMaximized"] = true })
            == new NativeWindowBounds(1024, 768, true), "Valid restored window bounds preserve size and maximized state");
        check(NativeWindowBounds.Read(new JsonObject { ["windowWidth"] = 799, ["windowHeight"] = 768 }) == null,
            "Window bounds below the usable minimum are ignored");
        check(NativeWindowBounds.Read(new JsonObject { ["windowWidth"] = 1024, ["windowHeight"] = 599 }) == null,
            "Window height below the usable minimum is ignored");
        check(NativeWindowBounds.Read(new JsonObject { ["windowWidth"] = 9000, ["windowHeight"] = 768 }) == null,
            "Window bounds above the supported display range are ignored");
        check(NativeWindowBounds.Read(new JsonObject { ["windowWidth"] = "1024", ["windowHeight"] = 768 }) == null,
            "Malformed window dimensions are ignored");
    }
}
