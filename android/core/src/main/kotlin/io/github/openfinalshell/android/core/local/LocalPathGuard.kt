package io.github.openfinalshell.android.core.local

import java.io.File

/** The filesystem scope a local session may read from and write to. */
data class LocalRoots(
    val readable: List<String>,
    val writable: List<String>,
    /**
     * Directories this session owns outright, listable and deletable even though they sit inside a
     * protected container.
     *
     * This exists because of one Android detail that a simpler rule gets wrong: `/data/data/<pkg>`
     * is a symlink to `/data/user/0/<pkg>`, so the app's own files live inside the very tree that
     * has to be protected against every *other* package. Without this carve-out the guard refuses
     * the app's own home directory.
     *
     * Deliberately narrower than "the app's data directory": the caller lists the directories the
     * session may manage and leaves `databases/` and `shared_prefs/` out, so a mis-click in the file
     * panel cannot destroy the saved credential store. A shell can still reach them — it runs as the
     * same uid — but the panel will not offer it.
     */
    val owned: List<String> = emptyList()
) {
    /**
     * Canonicalises every root.
     *
     * This is not cosmetic. On Android `/sdcard` is a symlink to `/storage/self/primary`, which is
     * itself a symlink to `/storage/emulated/0`. Comparing a canonicalised path against a
     * non-canonical root would report every ordinary delete under `/sdcard` as an escape.
     */
    fun canonicalized(): LocalRoots = LocalRoots(
        readable = canonicalPaths(readable),
        writable = canonicalPaths(writable),
        owned = canonicalPaths(owned)
    )

    private fun canonicalPaths(paths: List<String>): List<String> =
        paths.map { runCatching { File(it).canonicalPath }.getOrDefault(File(it).absolutePath) }
            .distinct()
}

/**
 * Reasons a local delete is refused.
 *
 * The user-facing message maps one-to-one onto these values, so adding a value means adding a
 * localized string in every supported locale. That is deliberate: a refusal a user cannot
 * understand is a refusal they will try to work around.
 */
enum class LocalDeleteRefusal {
    /** Not an absolute path, blank, carries a control character, or contains a `.`/`..` segment. */
    INVALID_PATH,

    /** A protected system location, a mount point, or outside the declared writable roots. */
    PROTECTED_PATH,

    /** Fewer than two path segments. A floor on top of [PROTECTED_PATH], not a substitute for it. */
    TOO_SHALLOW,

    /** The path could not be resolved, or resolving it left the readable roots. */
    SYMLINK_TRAVERSAL,

    /** A directory without a recursive request, or a file with one. */
    DIRECTORY_WITHOUT_RECURSIVE
}

class UnsafeLocalDelete(val refusal: LocalDeleteRefusal, val path: String) :
    SecurityException("refusing to delete $path: $refusal")

/**
 * The delete guard for local (on-device) filesystem operations.
 *
 * This exists because a local recursive delete is the most destructive operation the app can
 * perform: it runs against the user's own phone under a uid that may be the app's, the ADB shell's,
 * or root. Remote SFTP delete has no equivalent guard because a wrong path there costs the user a
 * server, not the device holding their data.
 *
 * The desktop counterpart (`src/main/sftp/fastDelete.ts`) refuses paths with fewer than two
 * segments. That rule does not transplant: on Android `/data` and `/system` have one segment, while
 * `/storage/emulated/0` has four and is *the user's entire shared storage*, so a depth rule alone
 * would permit wiping all of it. Depth is therefore only a floor; the load-bearing rules are the
 * protected subtrees, the mount points, and the positive writable-root allow-list.
 *
 * Every check runs on the **canonical** path. That is a deliberate fail-closed choice: unlinking a
 * symlink that points into a protected location is refused even though removing the link alone
 * would be harmless. Paying that with a rare refusal is better than the alternative, where a link
 * planted inside a writable root turns an ordinary delete into a system-file delete.
 *
 * Callers must treat this as one of two checks, never the only one. The same reasoning as the
 * desktop guard: a preview or pre-check exists for the user, and the authoritative refusal happens
 * immediately before the I/O.
 */
object LocalPathGuard {
    /** Refused at the path itself and anywhere beneath it, at every tier including root. */
    private val PROTECTED_SUBTREES = listOf(
        "/system", "/system_ext", "/vendor", "/product", "/apex", "/odm", "/oem",
        "/data/system", "/data/adb", "/data/misc",
        "/data/vendor", "/data/tombstones", "/data/backup",
        "/proc", "/sys", "/dev", "/etc", "/boot", "/init", "/sbin", "/root",
        "/cache", "/config", "/metadata", "/efs", "/persist", "/firmware"
    )

    /**
     * The trees that hold application data, refused unless the path is inside a
     * [LocalRoots.owned] directory.
     *
     * Kept separate from [PROTECTED_SUBTREES] so ownership can never override a system tree: the
     * carve-out exists for an app's own private storage, not as a general escape hatch.
     */
    private val PROTECTED_APP_DATA = listOf("/data/data", "/data/user")

    /**
     * Refused only at the path itself; entries beneath them stay deletable. These are containers
     * and mount points, so `/storage/emulated/0/Download/report.pdf` must remain deletable while
     * `/storage/emulated/0` itself must not be.
     */
    private val PROTECTED_CONTAINERS = listOf(
        "/", "/data", "/storage", "/mnt", "/sdcard", "/data/local",
        "/storage/emulated", "/storage/self", "/tmp", "/var", "/usr", "/bin", "/lib"
    )

    /**
     * Validates a local delete and returns [path] unchanged so callers can chain.
     *
     * Pure when [resolveRealPath] is passed as the identity, which is how the rules are tested
     * without touching the filesystem. Production callers pass a canonicalising resolver and
     * [LocalRoots] that has been through [LocalRoots.canonicalized].
     *
     * @param recursive whether the caller intends to remove a directory tree.
     * @param isDirectory the target's type, or null when the caller has not stat'ed it yet. A null
     *   skips only the type rule; the caller performing the I/O is still expected to pass the real
     *   value, because a directory removed without `recursive` is exactly the accident this guard
     *   exists to prevent.
     */
    fun assertDeletable(
        path: String,
        recursive: Boolean,
        isDirectory: Boolean?,
        roots: LocalRoots,
        mounts: Set<String> = emptySet(),
        resolveRealPath: (String) -> String = { it }
    ): String {
        val rawSegments = lexicalSegments(path)
            ?: throw UnsafeLocalDelete(LocalDeleteRefusal.INVALID_PATH, path)
        // The raw form is checked before the depth floor so that a one-segment system location such
        // as /data, /system or /storage reports as protected rather than merely shallow. Both are
        // refusals, but only one of them tells the user what they actually ran into. Application data
        // is deliberately excluded here: ownership can only be judged against a canonical path.
        if (isProtected(path, rawSegments.size, mounts, roots.owned, includeAppData = false)) {
            throw UnsafeLocalDelete(LocalDeleteRefusal.PROTECTED_PATH, path)
        }
        val canonical = runCatching { resolveRealPath(path) }.getOrNull()
            ?.takeIf { it.startsWith('/') }
            ?: throw UnsafeLocalDelete(LocalDeleteRefusal.SYMLINK_TRAVERSAL, path)
        val segments = lexicalSegments(canonical)
            ?: throw UnsafeLocalDelete(LocalDeleteRefusal.SYMLINK_TRAVERSAL, path)
        if (isProtected(canonical, segments.size, mounts, roots.owned, includeAppData = true)) {
            throw UnsafeLocalDelete(LocalDeleteRefusal.PROTECTED_PATH, path)
        }
        if (!roots.writable.any { isInside(canonical, it) }) {
            throw UnsafeLocalDelete(LocalDeleteRefusal.PROTECTED_PATH, path)
        }
        if (rawSegments.size < MIN_SEGMENTS || segments.size < MIN_SEGMENTS) {
            throw UnsafeLocalDelete(LocalDeleteRefusal.TOO_SHALLOW, path)
        }
        if (isDirectory != null && (isDirectory != recursive)) {
            throw UnsafeLocalDelete(LocalDeleteRefusal.DIRECTORY_WITHOUT_RECURSIVE, path)
        }
        return path
    }

    /**
     * True when [path] is a protected location and must never be removed. Pass a canonical path and
     * canonical mount points; a lexical path may report a false negative for a symlinked root.
     *
     * This is the strict predicate, without any ownership carve-out, so it also reports an app's own
     * directory as protected. Use it for a "should this ever be offered for deletion" pre-check;
     * [assertDeletable] is what decides whether a specific session may proceed.
     */
    fun isProtected(path: String, mounts: Set<String> = emptySet()): Boolean =
        lexicalSegments(path)?.let { isProtected(path, it.size, mounts, emptyList(), includeAppData = true) } ?: true

    private fun isProtected(
        path: String,
        depth: Int,
        mounts: Set<String>,
        owned: List<String>,
        includeAppData: Boolean
    ): Boolean {
        if (depth == 0) return true
        if (PROTECTED_SUBTREES.any { isInside(path, it) }) return true
        // Decided on the canonical form only. On Android `/data/user/0/<pkg>` canonicalises to
        // `/data/data/<pkg>`, so comparing a raw path against a canonical owned root compares two
        // different strings for the same directory — and the directory a session owns would look
        // like one it must not touch.
        if (includeAppData && PROTECTED_APP_DATA.any { isInside(path, it) } && !owned.any { isInside(path, it) }) return true
        if (PROTECTED_CONTAINERS.any { path.trimEnd('/') == it.trimEnd('/').ifEmpty { "/" } }) return true
        // A mount point itself is never removable, but anything mounted beneath it is ordinary data.
        if (mounts.any { path.trimEnd('/') == it.trimEnd('/') }) return true
        return false
    }

    /**
     * Splits an absolute path into segments, returning null when the path is unusable.
     *
     * `.` and `..` segments are rejected outright rather than resolved: `..` is how a caller
     * smuggles a path out of a known-good directory, and resolving it here would make the guard's
     * decision depend on the very resolution it is trying to validate.
     */
    private fun lexicalSegments(path: String): List<String>? {
        if (path.isBlank()) return null
        if (!path.startsWith('/')) return null
        if (path.any { it == '\u0000' || it == '\n' || it == '\r' }) return null
        val segments = path.split('/').filter { it.isNotEmpty() }
        if (segments.any { it == "." || it == ".." }) return null
        return segments
    }

    private fun isInside(path: String, root: String): Boolean {
        val normalizedRoot = root.trimEnd('/')
        if (normalizedRoot.isEmpty()) return path.startsWith('/')
        return path == normalizedRoot || path.startsWith("$normalizedRoot/")
    }

    /** Two segments: `/foo` is never deletable, `/foo/bar` may be. */
    private const val MIN_SEGMENTS = 2
}
