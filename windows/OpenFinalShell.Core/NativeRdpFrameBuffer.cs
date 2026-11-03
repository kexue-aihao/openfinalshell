using System.Buffers.Binary;

namespace OpenFinalShell.Core;

public sealed record NativeRdpFramePatch(int X, int Y, uint Width, uint Height, byte[] RgbaPixels);

/// <summary>Retains a validated RGBA desktop frame while applying dirty rectangles.</summary>
public sealed class NativeRdpFrameBuffer
{
    private const uint MaxDimension = 8192;
    private const ulong MaxPixels = 16_777_216;
    private readonly object gate = new();
    private byte[]? pixels;
    private uint width;
    private uint height;

    public (uint Width, uint Height) Size { get { lock (gate) return (width, height); } }

    public IReadOnlyList<NativeRdpFramePatch> Apply(NativeRdpFrame frame)
    {
        if (frame.CanvasWidth < 320 || frame.CanvasHeight < 320 || frame.CanvasWidth > MaxDimension || frame.CanvasHeight > MaxDimension || (ulong)frame.CanvasWidth * frame.CanvasHeight > MaxPixels)
            throw new InvalidDataException("RDP frame dimensions are invalid.");

        var patches = Parse(frame.Rectangles, frame.CanvasWidth, frame.CanvasHeight);
        lock (gate)
        {
            if (pixels == null || width != frame.CanvasWidth || height != frame.CanvasHeight)
            {
                width = frame.CanvasWidth; height = frame.CanvasHeight;
                pixels = new byte[checked((int)((ulong)width * height * 4))];
            }
            foreach (var patch in patches)
            {
                for (var row = 0u; row < patch.Height; row++)
                {
                    var source = checked(patch.Offset + (int)(row * patch.Stride));
                    var target = checked(((int)(patch.Y + row) * (int)width + patch.X) * 4);
                    Buffer.BlockCopy(frame.Rectangles, source, pixels, target, checked((int)patch.Width * 4));
                }
            }
            return patches.Select(patch => new NativeRdpFramePatch(
                patch.X, patch.Y, patch.Width, patch.Height,
                CopyPatch(frame.Rectangles, patch))).ToArray();
        }
    }

    public byte[]? CopyPixels(out uint frameWidth, out uint frameHeight)
    {
        lock (gate)
        {
            frameWidth = width; frameHeight = height;
            return pixels?.ToArray();
        }
    }

    private static IReadOnlyList<Patch> Parse(byte[] data, uint canvasWidth, uint canvasHeight)
    {
        List<Patch> patches = [];
        var offset = 0;
        while (offset < data.Length)
        {
            if (patches.Count == 1024 || offset + 24 > data.Length) throw new InvalidDataException("RDP frame rectangle header is invalid.");
            var x = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset));
            var y = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 4));
            var rw = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset + 8));
            var rh = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset + 12));
            var stride = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset + 16));
            var bytes = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset + 20));
            offset += 24;
            if (x < 0 || y < 0 || rw == 0 || rh == 0 || (ulong)x + rw > canvasWidth || (ulong)y + rh > canvasHeight ||
                stride < (ulong)rw * 4 || (ulong)stride * rh != bytes || bytes > data.Length - offset)
                throw new InvalidDataException("RDP frame rectangle bounds are invalid.");
            patches.Add(new(x, y, rw, rh, stride, offset));
            offset += checked((int)bytes);
        }
        if (patches.Count == 0) throw new InvalidDataException("RDP frame has no rectangles.");
        return patches;
    }

    private static byte[] CopyPatch(byte[] source, Patch patch)
    {
        var rowBytes = checked((int)patch.Width * 4);
        var result = new byte[checked(rowBytes * (int)patch.Height)];
        for (var row = 0u; row < patch.Height; row++)
            Buffer.BlockCopy(source, checked(patch.Offset + (int)(row * patch.Stride)), result, checked((int)row * rowBytes), rowBytes);
        return result;
    }

    private sealed record Patch(int X, int Y, uint Width, uint Height, uint Stride, int Offset);
}
