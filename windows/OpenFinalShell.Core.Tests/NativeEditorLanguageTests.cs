using OpenFinalShell.Core;

namespace OpenFinalShell.Core.Tests;

public static class NativeEditorLanguageTests
{
    public static void Run(Action<bool, string> check)
    {
        check(NativeEditorLanguage.Resolve("/srv/index.html", "<html></html>") == "html"
            && NativeEditorLanguage.Resolve("/srv/app.js", "const value = 'x';") == "javascript"
            && NativeEditorLanguage.Resolve("/srv/app.ts", "const value: string = 'x';") == "typescript"
            && NativeEditorLanguage.Resolve("/srv/Program.cs", "class Program {}") == "csharp",
            "Native editor recognizes HTML, TypeScript and C# files");
        check(NativeEditorLanguage.Resolve("/srv/README.md", "# Notes") == "markdown"
            && NativeEditorLanguage.Resolve("/srv/Makefile", "all: build") == "makefile"
            && NativeEditorLanguage.Resolve("/srv/CMakeLists.txt", "project(sample)") == "cmake",
            "Native editor recognizes documentation and build files");
        check(NativeEditorLanguage.Resolve("/srv/.env.production", "KEY=value") == "props"
            && NativeEditorLanguage.Resolve("/srv/nginx.conf", "server {}") == "nginx"
            && NativeEditorLanguage.Resolve("/srv/tool", "#!/usr/bin/env python3\nprint('ok')") == "python",
            "Native editor recognizes config files and extensionless scripts");
    }
}
