using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security;

namespace OpenFinalShell.Core;

public sealed record PlatformEnvironment(int Build, byte ProductType, string Profile, bool Supported, bool MicaEligible)
{
    public int Major { get; init; }
    public int Minor { get; init; }
    public string WindowsName { get; init; } = "Windows";
    public string? DisplayVersion { get; init; }
    public string FullVersion { get; init; } = "0.0.0";
    public string OperatingSystemArchitecture { get; init; } = "unknown";

    public string DisplayText => $"{WindowsName}{(string.IsNullOrWhiteSpace(DisplayVersion) ? "" : $" {DisplayVersion}")} · {FullVersion} · {OperatingSystemArchitecture}";

    // Retain the original overload for existing in-process callers and tests.
    public static PlatformEnvironment Resolve(int major, int build, byte productType) =>
        Resolve(major, 0, build, productType, null, null, RuntimeInformation.OSArchitecture.ToString());

    public static PlatformEnvironment Resolve(
        int major,
        int minor,
        int build,
        byte productType,
        string? displayVersion,
        uint? updateBuildRevision,
        string? operatingSystemArchitecture)
    {
        var isWindowsVersion = major == 10;
        var isWindows11 = isWindowsVersion && build >= 22000;
        var profile = isWindows11 ? "windows-11" : "windows-10";
        var name = isWindowsVersion ? (isWindows11 ? "Windows 11" : "Windows 10") : "Windows";
        var fullVersion = $"{Math.Max(0, major)}.{Math.Max(0, minor)}.{Math.Max(0, build)}" +
            (updateBuildRevision is { } ubr ? $".{ubr}" : "");

        return new PlatformEnvironment(
            Math.Max(0, build), productType, profile,
            isWindowsVersion && productType == 1 && build >= 19045,
            isWindowsVersion && productType == 1 && build >= 22000)
        {
            Major = Math.Max(0, major),
            Minor = Math.Max(0, minor),
            WindowsName = name,
            DisplayVersion = NormalizeDisplayVersion(displayVersion),
            FullVersion = fullVersion,
            OperatingSystemArchitecture = NormalizeArchitecture(operatingSystemArchitecture)
        };
    }

    [SupportedOSPlatform("windows")]
    public static PlatformEnvironment Detect()
    {
        var version = new OsVersion { Size = (uint)Marshal.SizeOf<OsVersion>(), ServicePack = "" };
        if (RtlGetVersion(ref version) != 0)
        {
            // This path is deliberately conservative: version details can still
            // be shown, but an unknown product type must not enable Win11-only UI.
            var fallback = Environment.OSVersion.Version;
            var registryFallback = ReadRegistryVersionInfo();
            return Resolve(fallback.Major, fallback.Minor, fallback.Build, 0,
                registryFallback.DisplayVersion, registryFallback.UpdateBuildRevision,
                RuntimeInformation.OSArchitecture.ToString());
        }

        var registry = ReadRegistryVersionInfo();
        return Resolve((int)version.Major, (int)version.Minor, (int)version.Build, version.ProductType,
            registry.DisplayVersion, registry.UpdateBuildRevision, RuntimeInformation.OSArchitecture.ToString());
    }

    [SupportedOSPlatform("windows")]
    private static (string? DisplayVersion, uint? UpdateBuildRevision) ReadRegistryVersionInfo()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion", writable: false);
            var displayVersion = key?.GetValue("DisplayVersion") as string;
            var revision = key?.GetValue("UBR") switch
            {
                int value when value >= 0 => (uint?)value,
                uint value => value,
                long value when value is >= 0 and <= uint.MaxValue => (uint)value,
                _ => null
            };
            return (displayVersion, revision);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or PlatformNotSupportedException)
        {
            return (null, null);
        }
    }

    private static string? NormalizeDisplayVersion(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Trim();
        return normalized.Length <= 32 && normalized.All(character => char.IsLetterOrDigit(character) || character is '.' or '-')
            ? normalized
            : null;
    }

    private static string NormalizeArchitecture(string? value) => value?.Trim().ToUpperInvariant() switch
    {
        "X64" or "AMD64" => "x64",
        "X86" or "I386" => "x86",
        "ARM64" or "AARCH64" => "ARM64",
        "ARM" => "ARM",
        { Length: > 0 } other => other,
        _ => "unknown"
    };

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OsVersion
    {
        public uint Size, Major, Minor, Build, Platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
        public ushort ServicePackMajor, ServicePackMinor, SuiteMask;
        public byte ProductType, Reserved;
    }

    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
    private static extern int RtlGetVersion(ref OsVersion version);
}
