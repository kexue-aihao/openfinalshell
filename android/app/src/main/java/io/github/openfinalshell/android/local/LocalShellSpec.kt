package io.github.openfinalshell.android.local

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import io.github.openfinalshell.android.core.local.LocalRoots
import java.io.File

/** What the local shell needs from the profile and the app, rather than from the system. */
data class LocalShellSpec(
    val shellPath: String,
    /** Persistent private home. Created if absent so the shell has somewhere writable to start. */
    val homeDirectory: File,
    /** Scratch space. Android has no `/tmp`, so TMPDIR points into the app's cache instead. */
    val tempDirectory: File,
    /** Profile override for the start directory. */
    val startDirectory: String?,
    /** Terminal scrollback, from the user's settings. */
    val transcriptRows: Int,
    val termType: String
) {
    val workingDirectory: String
        get() = startDirectory?.takeIf { it.isNotBlank() } ?: homeDirectory.path

    val environment: Array<String>
        get() = arrayOf(
            "HOME=${homeDirectory.path}",
            "TMPDIR=${tempDirectory.path}",
            "PATH=/sbin:/system/sbin:/system/bin:/system/xbin:/vendor/bin",
            "SHELL=$shellPath",
            "TERM=$termType",
            "LANG=en_US.UTF-8",
            // The PTY host overlays these entries onto the environment it inherited rather than
            // replacing it, so whatever is set here is the only thing the two tiers agree on. The
            // shell's built-in prompt is `$HOSTNAME:${PWD:-?} $`, and the app tier inherits an
            // environment with no HOSTNAME, which left its prompt starting at the colon.
            "HOSTNAME=$LOCAL_HOSTNAME"
        )

    fun prepareDirectories() {
        homeDirectory.mkdirs()
        tempDirectory.mkdirs()
    }

    companion object {
        const val DEFAULT_SHELL = "/system/bin/sh"

        /** What the prompt prints before the colon. The same host a local profile carries. */
        const val LOCAL_HOSTNAME = "localhost"

        /**
         * The session's private home. Shared rather than private to [forProfile] so the file panel
         * can open there without rebuilding a whole spec.
         */
        fun homeDirectory(context: Context): File = File(context.filesDir, "home")

        /** Builds the spec for a profile, creating the directories the shell will run in. */
        fun forProfile(
            context: Context,
            startDirectory: String?,
            transcriptRows: Int,
            termType: String
        ): LocalShellSpec = LocalShellSpec(
            shellPath = DEFAULT_SHELL,
            homeDirectory = homeDirectory(context),
            tempDirectory = File(context.cacheDir, "tmp"),
            startDirectory = startDirectory,
            transcriptRows = transcriptRows,
            termType = termType
        ).also { it.prepareDirectories() }
    }
}

/**
 * What an app-tier shell may touch.
 *
 * `readable` and `writable` are the same list, and that is deliberate. Browsing needs no allow-list
 * — the kernel and SELinux already refuse an app-uid process anything it must not read — while
 * deletion does, because nothing else stands between the guard and an unlink. `readable` exists so
 * the guard can also catch a symlink that resolves out of these roots.
 *
 * The one granted extension matters more than it looks: without all-files access an app-uid shell
 * cannot see `/sdcard` at all, which is the biggest surprise of this tier.
 */
fun appTierRoots(context: Context): LocalRoots {
    val writable = buildList {
        add(context.filesDir.path)
        add(context.cacheDir.path)
        add(context.noBackupFilesDir.path)
        context.getExternalFilesDir(null)?.let { add(it.path) }
        if (hasAllFilesAccess()) add(Environment.getExternalStorageDirectory().path)
    }.distinct()
    // `owned` is narrower than `writable` on purpose. The app's private directories live under
    // /data/user/0/<pkg>, inside a tree the guard protects against every other package, so they have
    // to be named explicitly. Listing the individual directories rather than the data directory
    // leaves `databases/` and `shared_prefs/` out: a mis-click in the file panel must not be able to
    // destroy the saved credential store. The shell can still reach them — it runs as the same uid —
    // but the panel will not offer to.
    val owned = listOfNotNull(
        context.filesDir,
        context.cacheDir,
        context.noBackupFilesDir,
        context.codeCacheDir,
        context.getExternalFilesDir(null)
    ).map { it.path }
    return LocalRoots(readable = writable, writable = writable, owned = owned)
}

/**
 * What a privileged session may reach.
 *
 * `owned` is deliberately empty at both privileged tiers. The guard's ownership carve-out exists so
 * an app-uid session can manage its own private files; a uid-0 shell has no business having the
 * app's credential database offered to it by the file panel, even though it could reach it from the
 * terminal. Leaving it out of the panel makes an accidental deletion harder, not impossible — which
 * is the most any app-level control can claim against uid 0.
 */
fun privilegedTierRoots(tier: LocalTier): LocalRoots = when (tier) {
    LocalTier.APP -> error("the app tier roots depend on a Context; use appTierRoots")
    // The ADB shell uid can write shared storage and /data/local/tmp, and may read the system tree.
    // Shared storage comes from Environment rather than a hardcoded /sdcard: the guard canonicalises
    // roots anyway, so this is about not baking in a path that differs across vendors.
    LocalTier.ADB -> LocalRoots(
        readable = listOf(Environment.getExternalStorageDirectory().path, ADB_SCRATCH, "/system"),
        writable = listOf(Environment.getExternalStorageDirectory().path, ADB_SCRATCH)
    )
    // Root can write anywhere, but the guard's protected subtrees and mount points still apply, so
    // this is a declaration of reach rather than a licence.
    LocalTier.ROOT -> LocalRoots(readable = listOf("/"), writable = listOf("/"))
}

/** Where a privileged host stages itself, and the one scratch directory the shell tier owns. */
private const val ADB_SCRATCH = "/data/local/tmp"

/** True when the user granted "all files access", which is what lifts the app tier to `/sdcard`. */
fun hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

/**
 * Opens the system's "all files access" screen, preferring the per-app page.
 *
 * Returns false when no screen could be shown, so the caller can say so instead of leaving the tap
 * with no visible effect. The fallback matters on OEM ROMs that ship only the global list: without
 * it the per-app intent throws `ActivityNotFoundException` and the button appears dead.
 */
fun openAllFilesAccessSettings(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
    val perApp = Intent(
        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        Uri.fromParts("package", context.packageName, null)
    )
    if (context.startSettingsSafely(perApp)) return true
    return context.startSettingsSafely(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
}

private fun Context.startSettingsSafely(intent: Intent): Boolean =
    runCatching { startActivity(intent) }.isSuccess

/**
 * Mount points the delete guard refuses at.
 *
 * Read rather than hardcoded because the interesting ones are device-specific: removable storage,
 * `media_rw` binds and vendor partitions all vary, while `/proc/self/mountinfo` is authoritative on
 * every device. A missing or unreadable file yields an empty set, which only makes the guard
 * marginally more permissive — the protected subtrees and the root allow-list still apply.
 */
object LocalMounts {
    private const val MOUNTINFO = "/proc/self/mountinfo"

    fun read(path: String = MOUNTINFO): Set<String> = runCatching {
        File(path).useLines { lines ->
            lines.mapNotNull { line -> line.split(' ').getOrNull(4)?.let(::unescape) }.toSet()
        }
    }.getOrDefault(emptySet())

    /** mountinfo escapes space, tab, newline and backslash in path fields. */
    private fun unescape(value: String): String = value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}
