# Windows RDP file clipboard diagnostics

The embedded worker must call `freerdp_check_event_handles`, including while
waiting for a clipboard reply. `freerdp_check_fds` only checks the transport;
it does not drain the virtual-channel write queue. A successful
`ClientFormatList` / `ClientFileContentsRequest` return therefore does not
prove that a clipboard PDU reached the server.

This distinction is visible in the bundled SDK version's
[FreeRDP 3.30.0 event loop](https://github.com/FreeRDP/FreeRDP/blob/3.30.0/libfreerdp/core/freerdp.c):
`freerdp_check_event_handles` calls both the transport check and
`freerdp_channels_check_fds`.

The native `worker_cliprdr` regression uses the adapter's actual callbacks with
a queued peer. It covers file announcement and acknowledgement, delayed local
file reads, remote size/range responses, 64-bit offsets, directory downloads,
empty responses, and selection invalidation. `worker_file_clipboard` also
marshals `IDataObject` and `IStream` across Windows COM apartments. These tests
do not replace an Explorer-to-Explorer test against a Windows RDP server.

## Collect a transfer trace

Close the application before launching a newly built copy with tracing enabled:

```powershell
$env:OFS_RDP_CLIPBOARD_TRACE = '1'
& 'E:\openfinalshell\release\win-unpacked\OpenFinalShell.exe'
```

This is an opt-in worker diagnostic. It records capability flags, selection
numbers, response status, file indices and byte counts, not file content or
credentials. The main process collects worker stderr into its log on worker
exit; close the RDP tab after reproducing to flush that record. The stderr
buffer is bounded, so use a small file for the first reproduction.

Expected evidence:

- Local Explorer copy → remote Ctrl+V: `client-capabilities`,
  `format-list-response`, then `file-request-index` for actual content reads.
- Remote Explorer copy → local Ctrl+V: `server-format-list`,
  `request-descriptors`, `descriptors-accepted`, then matching
  `request-file-bytes` and `file-response-bytes` records.
- `OleSetClipboard failed` identifies local OLE publication failure separately
  from a server channel failure.

Test a file, a nested folder and an empty folder in both directions. Compare
file lengths and SHA256 hashes on both machines. Also copy remotely, close the
tab, then paste locally: the old stream must fail promptly. Record the build
commit and test time together with the main log. Existing published versions
do not gain this fix until a build containing it is installed.
