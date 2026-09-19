package io.github.openfinalshell.android.core.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The refusal table is the specification: each case names the exact input that must be refused and
 * why. A regression here is a path that becomes deletable, so the cases are deliberately literal
 * rather than generated.
 */
class LocalPathGuardTest {
    private val appRoots = LocalRoots(
        readable = listOf("/data/user/0/io.github.openfinalshell.android", "/sdcard", "/system"),
        writable = listOf("/data/user/0/io.github.openfinalshell.android", "/sdcard/Android/data/io.github.openfinalshell.android"),
        owned = listOf("/data/user/0/io.github.openfinalshell.android/files", "/data/user/0/io.github.openfinalshell.android/cache")
    )
    private val shellRoots = LocalRoots(
        readable = listOf("/sdcard", "/data/local/tmp", "/system"),
        writable = listOf("/sdcard", "/data/local/tmp")
    )

    private fun refused(path: String, recursive: Boolean = false, isDirectory: Boolean? = false, roots: LocalRoots = shellRoots): LocalDeleteRefusal {
        val error = runCatching { LocalPathGuard.assertDeletable(path, recursive, isDirectory, roots, MOUNTS) }.exceptionOrNull()
        assertTrue("expected $path to be refused, but it was allowed", error is UnsafeLocalDelete)
        return (error as UnsafeLocalDelete).refusal
    }

    private fun allowed(path: String, recursive: Boolean = false, isDirectory: Boolean? = false, roots: LocalRoots = shellRoots) {
        LocalPathGuard.assertDeletable(path, recursive, isDirectory, roots, MOUNTS)
    }

    @Test fun rejectsMalformedPaths() {
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused(""))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("   "))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("sdcard/Download/a.txt"))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("relative/path"))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("/sdcard/Download/../../system/build.prop"))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("/sdcard/./Download/a.txt"))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("/sdcard/Download/a\nb.txt"))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("/sdcard/Download/a\rb.txt"))
        assertEquals(LocalDeleteRefusal.INVALID_PATH, refused("/sdcard/Download/a\u0000b.txt"))
    }

    /**
     * One-segment system locations must report as protected, not merely shallow: `/data` is refused
     * because of what it is, and saying "too shallow" would describe the rule rather than the risk.
     */
    @Test fun rejectsProtectedSubtrees() {
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/system"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/data"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/system/bin"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/system/build.prop"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/vendor/lib64/libc.so"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/proc/self/cmdline"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/dev/block"))
    }

    /**
     * `/data/data/<pkg>` stays refused even for a root-tier session, whose writable root is `/`. An
     * app has no business removing another app's private data, and at root a mistake there is
     * unrecoverable.
     */
    @Test fun refusesAppDataEvenWhenWritableRootsCoverEverything() {
        val rootRoots = LocalRoots(readable = listOf("/"), writable = listOf("/"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/data/data/com.example.app/databases", roots = rootRoots))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/data/system/users/0", roots = rootRoots))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/data/user/0/com.example.app", roots = rootRoots))
    }

    /**
     * Containers are refused only at themselves. Refusing everything beneath `/storage` would make
     * the file panel unable to delete a single user file, which is the opposite of the intent.
     */
    @Test fun refusesContainersAtThemselvesButAllowsTheirContents() {
        val rootRoots = LocalRoots(readable = listOf("/"), writable = listOf("/"))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/storage/emulated/0", roots = rootRoots))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/storage", roots = rootRoots, isDirectory = true))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/data/local", roots = rootRoots, isDirectory = true))
        allowed("/storage/emulated/0/Download/report.pdf", roots = rootRoots)
        allowed("/data/local/tmp/ofs/work", recursive = true, isDirectory = true, roots = rootRoots)
    }

    @Test fun refusesMountPointsAtThemselves() {
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/mnt/media_rw/1234-5678", roots = LocalRoots(listOf("/"), listOf("/"))))
        allowed("/mnt/media_rw/1234-5678/backup.zip", roots = LocalRoots(listOf("/"), listOf("/")))
    }

    /**
     * The Android detail that forces the ownership carve-out: `/data/data/<pkg>` is a symlink to
     * `/data/user/0/<pkg>`, so an app's own files sit inside the very tree that must be protected
     * against every other package. Without the carve-out the guard refuses the app's own directory;
     * with it too broad, it would hand over every other package's data.
     */
    @Test fun allowsDeletionInsideAnOwnedDirectoryAndNowhereElseInAppData() {
        val roots = LocalRoots(
            readable = listOf("/data/user/0/io.github.openfinalshell.android"),
            writable = listOf("/data/user/0/io.github.openfinalshell.android"),
            owned = listOf("/data/user/0/io.github.openfinalshell.android/files")
        )
        allowed("/data/user/0/io.github.openfinalshell.android/files/home/notes.txt", roots = roots)
        allowed("/data/user/0/io.github.openfinalshell.android/files", recursive = true, isDirectory = true, roots = roots)
        // Beside `files/`, outside the carve-out: this is where the saved credentials live.
        assertEquals(
            LocalDeleteRefusal.PROTECTED_PATH,
            refused("/data/user/0/io.github.openfinalshell.android/databases/ofs.db", roots = roots)
        )
        assertEquals(
            LocalDeleteRefusal.PROTECTED_PATH,
            refused("/data/user/0/io.github.openfinalshell.android/shared_prefs/prefs.xml", roots = roots)
        )
        // And another package is never reachable, owned or not.
        assertEquals(
            LocalDeleteRefusal.PROTECTED_PATH,
            refused("/data/user/0/com.example.other/files/secret", roots = roots)
        )
        assertEquals(
            LocalDeleteRefusal.PROTECTED_PATH,
            refused("/data/data/com.example.other/files/secret", roots = roots)
        )
    }

    /** Ownership must never override a system tree; it exists for an app's own storage only. */
    @Test fun ownershipDoesNotUnlockSystemTrees() {
        val roots = LocalRoots(
            readable = listOf("/"),
            writable = listOf("/"),
            owned = listOf("/system")
        )
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/system/build.prop", roots = roots))
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/data/system/users/0", roots = roots))
    }

    /**
     * The device behaviour that broke the first cut of the guard, pinned here so it cannot come back.
     *
     * On Android `/data/user/0/<pkg>` canonicalises to `/data/data/<pkg>`, so the raw path a caller
     * holds and the canonical root it owns are different strings for the same directory. Judging
     * ownership on the raw path therefore reports a session's own directory as one it must not
     * touch — which is exactly what happened on the API 35 emulator, and only there, because the
     * JVM tests had no reason to use the `/data/user` spelling.
     */
    @Test fun ownershipIsJudgedOnTheCanonicalFormNotTheRawPath() {
        val roots = LocalRoots(
            readable = listOf("/data/data/io.github.openfinalshell.android"),
            writable = listOf("/data/data/io.github.openfinalshell.android"),
            owned = listOf("/data/data/io.github.openfinalshell.android/files")
        )
        // Stands in for the filesystem's canonicalisation: /data/user/0/<pkg> -> /data/data/<pkg>.
        val resolve: (String) -> String = { it.replace("/data/user/0/", "/data/data/") }
        assertEquals(
            "/data/user/0/io.github.openfinalshell.android/files/notes.txt",
            LocalPathGuard.assertDeletable(
                "/data/user/0/io.github.openfinalshell.android/files/notes.txt",
                recursive = false,
                isDirectory = false,
                roots = roots,
                mounts = setOf("/data", "/data/user", "/data/user/0"),
                resolveRealPath = resolve
            )
        )
        // The sibling the carve-out excludes is still refused even under the /data/user spelling.
        assertEquals(
            LocalDeleteRefusal.PROTECTED_PATH,
            refused("/data/user/0/io.github.openfinalshell.android/databases/ofs.db", roots = roots)
        )
    }

    @Test fun refusesAnythingOutsideTheWritableRoots() {
        // Readable but not writable: the app-tier session may browse the system, never remove from it.
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/system/etc/hosts", roots = appRoots))
        // A shared-storage path the app tier cannot write without the all-files grant.
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/sdcard/Download/a.txt", roots = appRoots))
        // The same path is deletable once the session's writable roots actually cover it.
        allowed("/sdcard/Download/a.txt", roots = shellRoots)
    }

    /**
     * The depth floor is a floor, not the main rule. It is exercised against a session whose
     * writable root is `/`, which is the only configuration where a shallow path is not already
     * refused as protected or as outside the roots.
     */
    @Test fun enforcesTheTwoSegmentFloor() {
        val rootRoots = LocalRoots(readable = listOf("/"), writable = listOf("/"))
        assertEquals(LocalDeleteRefusal.TOO_SHALLOW, refused("/foo", roots = rootRoots))
        assertEquals(LocalDeleteRefusal.TOO_SHALLOW, refused("/foo", recursive = true, isDirectory = true, roots = rootRoots))
        allowed("/foo/bar", roots = rootRoots)
        // A shared-storage root is refused because it is a container, not because it is shallow.
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, refused("/sdcard"))
        allowed("/sdcard/a")
    }

    /** A symlink planted in a writable root must not turn an ordinary delete into a system delete. */
    @Test fun refusesWhenResolutionLeavesTheReadableRoots() {
        val resolver: (String) -> String = { path ->
            if (path == "/sdcard/Download/escape") "/system/build.prop" else path
        }
        val error = runCatching {
            LocalPathGuard.assertDeletable("/sdcard/Download/escape", false, false, shellRoots, MOUNTS, resolver)
        }.exceptionOrNull()
        assertTrue(error is UnsafeLocalDelete)
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, (error as UnsafeLocalDelete).refusal)
    }

    @Test fun refusesWhenResolutionFails() {
        val error = runCatching {
            LocalPathGuard.assertDeletable("/sdcard/a", false, false, shellRoots, MOUNTS) { throw java.io.IOException("boom") }
        }.exceptionOrNull()
        assertTrue(error is UnsafeLocalDelete)
        assertEquals(LocalDeleteRefusal.SYMLINK_TRAVERSAL, (error as UnsafeLocalDelete).refusal)
    }

    /**
     * The symlinked-root case that a lexical comparison gets wrong: `/sdcard` resolves to
     * `/storage/emulated/0`, so both the path and the roots must be canonical or every ordinary
     * delete under `/sdcard` looks like an escape.
     */
    @Test fun matchesCanonicalPathsAgainstCanonicalRoots() {
        val canonical = LocalRoots(
            readable = listOf("/storage/emulated/0"),
            writable = listOf("/storage/emulated/0/Download")
        )
        val resolver: (String) -> String = { path ->
            if (path.startsWith("/sdcard/")) "/storage/emulated/0/" + path.removePrefix("/sdcard/") else path
        }
        LocalPathGuard.assertDeletable("/sdcard/Download/a.txt", false, false, canonical, MOUNTS, resolver)
    }

    @Test fun enforcesTheTypeRule() {
        assertEquals(LocalDeleteRefusal.DIRECTORY_WITHOUT_RECURSIVE, refused("/sdcard/Download", recursive = false, isDirectory = true))
        assertEquals(LocalDeleteRefusal.DIRECTORY_WITHOUT_RECURSIVE, refused("/sdcard/Download/a.txt", recursive = true, isDirectory = false))
        allowed("/sdcard/Download", recursive = true, isDirectory = true)
        allowed("/sdcard/Download/a.txt", recursive = false, isDirectory = false)
        // An unknown type skips only this rule; the caller doing the I/O must pass the real value.
        allowed("/sdcard/Download/a.txt", recursive = false, isDirectory = null)
    }

    @Test fun returnsThePathUnchangedForChaining() {
        assertEquals("/sdcard/Download/a.txt", LocalPathGuard.assertDeletable("/sdcard/Download/a.txt", false, false, shellRoots, MOUNTS))
    }

    @Test fun exposesProtectedForCallersThatOnlyNeedAPredicate() {
        assertTrue(LocalPathGuard.isProtected("/system/build.prop", MOUNTS))
        assertTrue(LocalPathGuard.isProtected("/", MOUNTS))
        assertTrue(LocalPathGuard.isProtected("not-absolute", MOUNTS))
        assertFalse(LocalPathGuard.isProtected("/sdcard/Download/a.txt", MOUNTS))
    }

    private companion object {
        val MOUNTS = setOf("/mnt/media_rw/1234-5678", "/storage/emulated/0", "/data/local/tmp")
    }
}
