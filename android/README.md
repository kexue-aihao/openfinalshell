# OpenFinalShell Android

This is the native Kotlin companion client. It is intentionally separate from
the Electron process and does not load Node.js, preload, or renderer bundles.

## Local commands

From the repository root on Windows (PowerShell):

```text
npm run android:generate-schema
.\android\gradlew.bat -p android :app:checkI18n testDebugUnitTest
.\android\gradlew.bat -p android :app:assembleDebug :app:assembleDebugAndroidTest
.\android\gradlew.bat -p android :app:lintDebug :app:assembleRelease :app:bundleRelease
```

On macOS/Linux use `sh android/gradlew -p android` with the same task names.
Set `JAVA_HOME` to JDK 17 and `ANDROID_HOME` to Android SDK platform 35.
The checked-in wrapper downloads Gradle 8.10.2 from the official distribution
and verifies its SHA-256 checksum; no global Gradle installation or local proxy is required.
The debug build produces a universal APK and ABI-specific APKs for
`arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`. Android 8.0 (API 26) is the minimum supported version.

Local release checks produce unsigned APKs/AAB when no signing credentials are set.
They validate the release build but cannot be installed as published releases; use
the Debug APK for local testing. Partial signing configuration fails immediately.
Publishing uses `-PrequireReleaseSigning=true` and requires all four signing
environment variables; no debug signing fallback is used.

The client provides SSH terminals, SFTP browsing and transfers, Linux server
monitoring, port forwarding, connection management, encrypted import/export,
and LAN data transfer. This working revision adds authenticated HTTP CONNECT/SOCKS5,
SAF file/directory transfers, a command library, an OpenAI-compatible AI assistant,
and guarded remote text editing. Embedded RDP and independent multi-instance
windows remain outside this Android delivery. Gradle unit tests, Room KSP, all
debug APKs, unsigned release APKs/AAB, full lint, 70 unit tests and 12 instrumentation
tests on each API 26/35 emulator pass on the Windows development
machine. Physical-device acceptance and production signing remain pending;
see [implementation status](../docs/platform-port-status.md).

AI services are configured in Settings and opened from the SSH screen. Tokens stay
in Android Keystore-backed storage and are excluded from data export and LAN sync.
Only explicitly added terminal selections are sent. Each question uses its own
context; conversations are held in memory only. Models, image-input declarations
and optional probes, latency, streaming/JSON responses and cancellation are supported.
The image probe checks API acceptance, not visual understanding. No attachment UI
is included in this Android increment.

Command insertion accepts one line without terminal controls or Enter. Execution
is a separate explicit action. Optional encrypted command history records only
commands submitted through that action; raw keystrokes and password prompts are
not captured. The command library participates in encrypted export and LAN sync;
history and AI profiles do not.

Remote editing supports UTF-8, GB18030, GBK, Big5 and Latin-1 where the runtime
provides the charset, rejects binary/over-2-MiB inputs and checks byte round trips,
BOM, line endings and remote conflicts. Packed transfers use strict USTAR; unsupported
archive paths or unavailable remote tools show the ordinary SFTP alternative.

The Android client uses the existing SSH/SFTP and LAN Sync wire protocols. A
desktop `safeStorage`/DPAPI secret is not portable; users must import a v2
password-encrypted export or enter the credential again.

## GitHub Actions

`.github/workflows/android.yml` runs unit tests, full translation/lint checks,
debug and unsigned release builds for Android-related changes on `master` and
pull requests. API 26/35 instrumentation runs on pull requests and manual dispatches,
covering navigation, Room/Keystore and real ContentResolver file/pipe operations.
`.github/workflows/android-release.yml` runs on `v*` tags, creates signed APK/AAB
files for the four supported ABIs plus a universal APK, and uploads them to the same GitHub Release
as the desktop packages.

The release workflow requires these repository secrets:

```text
ANDROID_KEYSTORE_B64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```
