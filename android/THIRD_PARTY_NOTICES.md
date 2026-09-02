# Android third-party notices

## Termux terminal components

The Android terminal renderer uses the following pinned JitPack artifacts:

- `com.github.termux.termux-app:terminal-emulator:v0.118.0`
- `com.github.termux.termux-app:terminal-view:v0.118.0`

They provide the maintained VT/ANSI terminal emulator and renderer used for remote SSH
shell bytes.  No Termux process, package manager, or local PTY is bundled or started by
OpenFinalShell.

Source: <https://github.com/termux/termux-app/tree/v0.118.0>.  The upstream repository
states that its `terminal-emulator` and `terminal-view` components contain code from
Android-Terminal-Emulator, which is licensed under Apache License 2.0; the repository as
a whole is GPLv3-only.  The release process must retain applicable upstream notices and
revalidate the component licensing against the pinned source revision before distribution.

The dependency is resolved only from `https://jitpack.io`, as configured in
`android/settings.gradle.kts`; keeping the version pinned makes the supplied artifact
reproducible and reviewable.
