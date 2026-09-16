# Native RDP platform integration

The Worker keeps the legacy `capabilities` array and additionally reports
`featureSupport` booleans for `clipboardText`, `clipboardFilesUpload`,
`clipboardFilesPaste`, `dragUpload`, and `audioPlayback`. A value describes
the installed native implementation; the Electron host must also apply its
platform release/acceptance gates. Self-test does not start a graphical event
loop, so native clipboard availability is false on headless Unix self-tests.

`START.features.clipboardFilesUpload` and `clipboardFilesPaste` are optional,
default to false, and must be explicitly enabled by the host. The latter
controls native publication/materialization, while explicit download-to-folder
continues to use the same remote reader. `CLIPBOARD_CANCEL` (`0x1c`) accepts
`{"op":"clipboardCancel"}`, invalidates the current selection, and acknowledges
without waiting for a remote chunk. Session close interrupts pending reads too.

`clipboardProgress` includes `direction: "upload" | "download"` and numeric
`taskId`. Upload IDs are the original `CLIPBOARD_FILES_SET` request ID; download
IDs are the Worker-local remote selection generation. `remoteFiles` carries
the same `taskId` and is always emitted before cache publication/progress begins.
Consumers must discard progress for superseded IDs even when counts and sizes
match. The terminal cancellation state is spelled `canceled`.

## Clipboard ownership and threading

- Windows retains OLE delayed `IDataObject`/`IStream` on its STA thread.
- macOS runs NSPasteboard calls on the process main AppKit run loop.
- Linux runs GTK3 clipboard calls on its main loop (X11 or Wayland). Main-loop
  dispatch always uses a source, so GTK is never called inline on the FreeRDP
  or protocol thread.
- Protocol stdin is processed on a separate thread on Unix; FreeRDP maintains
  its own event thread. Clipboard change callbacks only enqueue work.
- Unix remote file publication materializes the entire bounded selection into
  a private `0700` cache before publishing file URLs. Readers request at most
  1 MiB per chunk and validate each response length. Completed URLs represent
  copy, never move (`text/uri-list`, GNOME copy marker, KDE cut=false).
- Cache roots are unique per Worker/process and selection. Advisory lock files
  protect live caches while another Worker removes orphaned caches. Replacement,
  cancellation, disconnect and close invalidate old readers; cleanup clears only
  the clipboard still owned by this publication. User-created destination files
  are outside the cache root and are never removed.

## Audio and dependencies

The add-in provider checks real WinMM, macOS, PulseAudio or ALSA rdpsnd modules.
It wraps the device `Open` callback so `connected` means a negotiated playback
format successfully opened the device, not merely that the virtual channel
connected. The fake audio backend is rejected. Plugin discovery alone is
reported as implementation availability, not as proof of audible playback.

Build requirements add AppKit on macOS and GTK3 on Linux. Unix packaging walks
the transitive runtime library graph, explicitly includes dynamically loaded
audio modules, and removes build-host loader paths. Linux packaging requires
`patchelf`; macOS uses `otool`, `install_name_tool` and ad-hoc signing before
the enclosing app's release signing step. Missing dependencies fail packaging.

## Validation status

Windows x64 FreeRDP SDK build and native CTest suites pass locally:
CLIPRDR callbacks, OLE streams, HELLO, Unicode, frame bounds, portable descriptor
codec/path/chunk rules, protocol/cancellation gates, and audio device callbacks.
Unix cache tests are
registered in CTest and require a Unix builder. macOS/GTK compilation and native
Finder/Nautilus/Dolphin/Thunar paste, audio and package launch remain platform
CI/real-machine acceptance items; source implementation is not acceptance.

CMake selects FreeRDP 3 when both major versions are installed, and otherwise
supports the existing FreeRDP 2 detection path. It records the selected major
in `rdp-worker-sdk.json`; staging searches only that major's prefixes/plugins
to avoid loading a 2.x audio module into a 3.x Worker. The callback wrapper
derives its `Open` ABI from the installed SDK's `pcOpen` type. The local SDK
build covers FreeRDP 3; a FreeRDP 2 compile remains a CI validation item.
