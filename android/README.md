# OpenFinalShell Android

This is the native Kotlin companion client. It is intentionally separate from
the Electron process and does not load Node.js, preload, or renderer bundles.

## Local commands

From the repository root:

```text
npm run android:generate-schema
gradle -p android testDebugUnitTest
gradle -p android :app:assembleDebug
```

The Android module requires JDK 17, Android SDK platform 35, and Gradle 8.10.2.
The debug build produces a universal APK and ABI-specific APKs for
`arm64-v8a`, `armeabi-v7a`, and `x86_64`.

The Android client uses the existing SSH/SFTP and LAN Sync wire protocols. A
desktop `safeStorage`/DPAPI secret is not portable; users must import a v2
password-encrypted export or enter the credential again.

## GitHub Actions

`.github/workflows/android.yml` runs unit tests, debug APK builds, and API 26/35
instrumentation tests for Android-related changes on `master` and pull requests.
`.github/workflows/android-release.yml` runs on `v*` tags, creates signed APK/AAB
files for the three supported ABIs, and uploads them to the same GitHub Release
as the desktop packages.

The release workflow requires these repository secrets:

```text
ANDROID_KEYSTORE_B64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```
