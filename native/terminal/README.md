# Native terminal parser

`ofs-terminal.dll` is a C ABI wrapper around libvterm 0.3.3. It is the parser
layer for the WinUI terminal host; it is not a terminal UI fallback. The UI
host must render the screen grid with Win2D/DirectWrite and provide keyboard,
IME, selection, scrollback, search, links, mouse protocols and UI Automation.

The source archive is pinned in `.local/native-deps` for local builds. The
upstream libvterm source is MIT licensed; retain its `LICENSE` file in any
redistribution. LLVM-MinGW is used only as a build tool and is not shipped.

## Render grid contract

`ofs-terminal.dll` reports each character's terminal cell width. The WinUI3
host must preserve that grid rather than measuring each glyph independently:

- adjacent cells with the same ANSI background are filled as one
  physical-pixel-aligned span;
- single-cell text with the same foreground and style is drawn as one run;
- wide CJK, emoji, and combining-character clusters are centered and clipped
  within their reported `width * cellWidth` span;
- continuation cells expose `codepoint == 0xFFFFFFFF` and must not draw text
  again.

The host uses the selected terminal font plus the system CJK fallback. It does
not bundle a separate CJK font. `scripts/nativeTerminalLayoutFixture.sh`
provides ANSI badges, wide text, block characters, box drawing, and mixed
ASCII/CJK columns for visual regression checks at multiple font sizes and DPI
scales.
