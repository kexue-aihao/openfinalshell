using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;

namespace OpenFinalShell.Core;

public interface ISecretProtector { byte[] Protect(byte[] bytes); byte[] Unprotect(byte[] bytes); }
[SupportedOSPlatform("windows")]
public sealed class DpapiProtector : ISecretProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("OpenFinalShell.NativePreview.v1");
    public byte[] Protect(byte[] bytes) => ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser);
    public byte[] Unprotect(byte[] bytes) => ProtectedData.Unprotect(bytes, Entropy, DataProtectionScope.CurrentUser);
}

internal static class FieldCipher
{
    public static byte[] Seal(byte[] key, ReadOnlySpan<byte> data)
    {
        var bytes = new byte[28 + data.Length];
        RandomNumberGenerator.Fill(bytes.AsSpan(0, 12));
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(bytes.AsSpan(0, 12), data, bytes.AsSpan(28), bytes.AsSpan(12, 16));
        return bytes;
    }
    public static byte[] Open(byte[] key, ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 28) throw new CryptographicException("Invalid encrypted field");
        var data = new byte[bytes.Length - 28];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(bytes[..12], bytes[28..], bytes.Slice(12, 16), data);
        return data;
    }
}
