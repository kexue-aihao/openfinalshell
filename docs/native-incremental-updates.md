# Native file updates

The legacy `native-update-<arch>.json` remains schema 1 so older clients can obtain the full installer. Its optional `incremental` entry describes a separately signed file inventory. Updated clients use this entry instead of downloading the installer.

`native-files-<arch>.json` contains the target version, channel, architecture, payload URL and each relative file's size, SHA-256, offset and compressed length. The corresponding `.ofsdata` asset concatenates independent gzip members. The client verifies the inventory signature before using paths, rejects traversal/reparse points, hashes local files, copies matching files into staging and requests byte ranges only for missing/changed files. Each decompressed file must match its signed size and hash. A server ignoring a range request is rejected without a full-download fallback.

The update helper is published as a self-contained single executable. The application copies its installed helper to a separate runner directory, launches a watcher with the current user token and waits on a random, current-user-only named pipe. The elevated worker checks the parent PID/start time/install path and verifies the complete staged payload before signaling readiness. Only then does the UI close its confirmed documents/sessions and exit. The worker waits for process exit, backs up changed files and commits replacements; an exception restores the backup. An interrupted transaction is recovered on retry. The original watcher restarts the application after the worker finishes. Elevation using another Windows account is not supported by the current-user-only handshake; it fails before the application exits.

Only files recorded in the previous signed inventory are eligible for obsolete-file removal, and only if their contents still match that inventory. Unknown or user-modified obsolete files are retained. Installation metadata is updated only when its registered install directory matches the target; portable and test copies never rewrite another installation's registration.

Power-loss recovery may require rerunning the updater if the application itself cannot start. The backup directory is retained until commit, and full-install repair remains available. No claim is made that file-by-file replacement is a filesystem-wide atomic operation.

## Repeatable checks

Run from the repository root in PowerShell 7 with .NET 10 available:

```powershell
node test/fixtures/nativeExport.mjs
dotnet run --project windows/OpenFinalShell.Core.Tests -c Release
pwsh -NoProfile -File scripts/testNativeFilePayload.ps1
pwsh -NoProfile -File scripts/testNativeUpdateProcess.ps1
```

The process fixture compiles a separate helper with a disposable test key and runs against an isolated directory under `build/`. The production key is not changed and no private release key is used. The process test needs an elevated Windows runner (or interactive UAC consent). Generated test keys and binaries must not be committed. Real non-elevated-user UAC cancellation and alternate-account policies require desktop acceptance.
