using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace OpenFinalShell.Core;

public sealed record PlatformEnvironment(int Build, byte ProductType, string Profile, bool Supported, bool MicaEligible)
{
    public static PlatformEnvironment Resolve(int major, int build, byte productType) => new(
        build, productType, major == 10 && productType == 1 && build >= 22000 ? "windows-11" : "windows-10",
        major == 10 && productType == 1 && build >= 19045,
        major == 10 && productType == 1 && build >= 22000);

    [SupportedOSPlatform("windows")]
    public static PlatformEnvironment Detect()
    {
        var version = new OsVersion { Size = (uint)Marshal.SizeOf<OsVersion>(), ServicePack = "" };
        return RtlGetVersion(ref version) == 0 ? Resolve((int)version.Major, (int)version.Build, version.ProductType) : Resolve(0, 0, 0);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OsVersion
    {
        public uint Size, Major, Minor, Build, Platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
        public ushort ServicePackMajor, ServicePackMinor, SuiteMask;
        public byte ProductType, Reserved;
    }
    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)] private static extern int RtlGetVersion(ref OsVersion version);
}
