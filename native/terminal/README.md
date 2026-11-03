# Native terminal parser

`ofs-terminal.dll` is a C ABI wrapper around libvterm 0.3.3. It is the parser
layer for the WinUI terminal host; it is not a terminal UI fallback. The UI
host must render the screen grid with Win2D/DirectWrite and provide keyboard,
IME, selection, scrollback, search, links, mouse protocols and UI Automation.

The source archive is pinned in `.local/native-deps` for local builds. The
upstream libvterm source is MIT licensed; retain its `LICENSE` file in any
redistribution. LLVM-MinGW is used only as a build tool and is not shipped.
