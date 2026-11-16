using System.Runtime.InteropServices;
namespace OpenFinalShell.Core;
public sealed partial class NativeTerminalProcessor
{
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nint ofs_terminal_create(int rows, int cols);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern void ofs_terminal_destroy(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nuint ofs_terminal_feed(nint terminal, byte[] bytes, nuint length);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nuint ofs_terminal_read_text(nint terminal, byte[] buffer, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_resize(nint terminal, int rows, int cols);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_set_scrollback_limit(nint terminal, int lines);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern void ofs_terminal_clear(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_cursor_row(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_cursor_col(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_cell(nint terminal, int row, int col, out NativeTerminalCell cell);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_cell_codepoints(nint terminal, int row, int col, [Out] uint[] codepoints, int capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_scrollback_lines(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_scrollback_cell(nint terminal, int line, int col, out NativeTerminalCell cell);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_get_scrollback_codepoints(nint terminal, int line, int col, [Out] uint[] codepoints, int capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_copy_screen(nint terminal, [Out] NativeTerminalSnapshotCell[] cells, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_copy_scrollback(nint terminal, int firstLine, int lineCount, [Out] NativeTerminalSnapshotCell[] cells, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_key(nint terminal, int key, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_unichar(nint terminal, uint codepoint, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_paste_utf8(nint terminal, byte[] bytes, nuint length);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_mouse_mode(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_bracketed_paste(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_alt_screen(nint terminal);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_mouse_move(nint terminal, int row, int col, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_mouse_button(nint terminal, int button, int pressed, int modifiers);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern nuint ofs_terminal_read_output(nint terminal, [Out] byte[] buffer, nuint capacity);
    [DllImport("ofs-terminal.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int ofs_terminal_take_output_error(nint terminal);

}
    [StructLayout(LayoutKind.Sequential)]
    public struct NativeTerminalCell
    {
        public uint CodePoint;
        public byte FgType;
        public byte FgR;
        public byte FgG;
        public byte FgB;
        public byte FgIndex;
        public byte BgType;
        public byte BgR;
        public byte BgG;
        public byte BgB;
        public byte BgIndex;
        public ushort Attributes;
        public byte Width;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NativeTerminalSnapshotCell
    {
        public NativeTerminalCell Cell;
        public byte CodepointCount;
        public byte Valid;
        public byte Reserved0;
        public byte Reserved1;
        public uint Codepoint0;
        public uint Codepoint1;
        public uint Codepoint2;
        public uint Codepoint3;
        public uint Codepoint4;
        public uint Codepoint5;
        public uint Codepoint6;
        public uint Codepoint7;

        public readonly uint CodepointAt(int index) => index switch
        {
            0 => Codepoint0,
            1 => Codepoint1,
            2 => Codepoint2,
            3 => Codepoint3,
            4 => Codepoint4,
            5 => Codepoint5,
            6 => Codepoint6,
            7 => Codepoint7,
            _ => 0
        };
    }