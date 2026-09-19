package io.github.openfinalshell.android.core.local

import io.github.openfinalshell.android.core.ssh.AtomicReplaceUnavailable
import io.github.openfinalshell.android.core.ssh.SftpEntry
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Split by platform on purpose.
 *
 * The filesystem mechanics run everywhere. The delete-guard integration runs only on a POSIX host,
 * because the guard requires rooted `/`-paths by design — it is Android code and has no reason to
 * understand a drive letter — so a Windows `TemporaryFolder` cannot supply a path it accepts.
 * Those cases are covered by the Linux CI run rather than weakened to run here.
 */
class LocalFileChannelTest {
    @get:Rule val temp = TemporaryFolder()

    private val roots get() = LocalRoots(
        readable = listOf(temp.root.absolutePath),
        writable = listOf(temp.root.absolutePath)
    )

    private fun channel(roots: LocalRoots = this.roots) = LocalFileChannel(roots)

    private fun posixOnly() = assumeTrue("requires a POSIX host", File.separatorChar == '/')

    @Test fun listsEntriesWithTypeSizeAndMode() = runTest {
        val file = temp.newFile("note.txt").apply { writeBytes("hello".toByteArray()) }
        temp.newFolder("nested")
        val entries = channel().list(temp.root.absolutePath).associateBy { it.name }
        assertEquals(SftpEntry.Type.FILE, entries.getValue("note.txt").type)
        assertEquals(5L, entries.getValue("note.txt").size)
        assertEquals(SftpEntry.Type.DIRECTORY, entries.getValue("nested").type)
        assertEquals(temp.root.absolutePath.trimEnd('/') + "/note.txt", entries.getValue("note.txt").path)
        assertEquals("hello", File(file.path).readText())
    }

    @Test fun reportsSymbolicLinksAsLinksRatherThanTheirTargets() = runTest {
        val target = temp.newFile("target.txt").apply { writeBytes("x".toByteArray()) }
        val link = File(temp.root, "link.txt")
        val created = runCatching { Files.createSymbolicLink(link.toPath(), target.toPath()) }.isSuccess
        assumeTrue("requires the privilege to create symbolic links", created)
        val entry = channel().list(temp.root.absolutePath).first { it.name == "link.txt" }
        assertEquals(SftpEntry.Type.SYMLINK, entry.type)
    }

    @Test fun readsAndWritesWholeFiles() = runTest {
        val path = File(temp.root, "whole.bin").path
        val sut = channel()
        sut.write(path, "first".toByteArray())
        assertArrayEquals("first".toByteArray(), sut.read(path))
        // A whole-file write replaces the contents rather than appending.
        sut.write(path, "second".toByteArray())
        assertArrayEquals("second".toByteArray(), sut.read(path))
    }

    @Test fun readsAndWritesAtOffsets() = runTest {
        val path = File(temp.root, "ranged.bin").path
        val sut = channel()
        // The transfer queue sends the first chunk with truncate=true, which is what establishes
        // the file; later chunks arrive at their own offsets.
        sut.writeChunk(path, "0123456789".toByteArray(), offset = 0, truncate = true)
        sut.writeChunk(path, "ABC".toByteArray(), offset = 3, truncate = false)
        assertArrayEquals("012ABC6789".toByteArray(), sut.read(path))
        assertArrayEquals("ABC".toByteArray(), sut.readChunk(path, offset = 3, maxBytes = 3))
        assertArrayEquals("789".toByteArray(), sut.readChunk(path, offset = 7, maxBytes = 32))
        // Reading at or past the end is empty, never a failure: the queue uses that as its stop signal.
        assertArrayEquals(ByteArray(0), sut.readChunk(path, offset = 10, maxBytes = 8))
        assertArrayEquals(ByteArray(0), sut.readChunk(path, offset = 99, maxBytes = 8))
    }

    /**
     * Replace-on-rename is POSIX behaviour: `rename(2)` overwrites the destination, and that is what
     * Android's `File.renameTo` resolves to. Windows maps it to `MoveFile`, which refuses an existing
     * destination, so this case cannot be exercised on a Windows host.
     */
    @Test fun atomicReplaceMovesTheStagingFileOverTheTarget() = runTest {
        posixOnly()
        val target = File(temp.root, "doc.txt").apply { writeBytes("old".toByteArray()) }
        val staging = File(temp.root, ".ofs-edit-1.tmp").apply { writeBytes("new".toByteArray()) }
        channel().atomicReplace(staging.path, target.path)
        assertEquals("new", target.readText())
        assertFalse("the staging file must be consumed by the rename", staging.exists())
    }

    @Test fun atomicReplaceReportsUnavailableWhenTheRenameCannotHappen() = runTest {
        val missing = File(temp.root, "gone.tmp")
        val target = File(temp.root, "doc.txt")
        val error = runCatching { channel().atomicReplace(missing.path, target.path) }.exceptionOrNull()
        assertTrue("expected AtomicReplaceUnavailable but got $error", error is AtomicReplaceUnavailable)
    }

    @Test fun mkdirRenameAndDeleteRoundTrip() = runTest {
        val sut = channel()
        val directory = File(temp.root, "made")
        sut.mkdir(directory.path)
        assertTrue(directory.isDirectory)
        val source = File(directory, "a.txt").apply { writeBytes("a".toByteArray()) }
        val moved = File(directory, "b.txt")
        sut.rename(source.path, moved.path)
        assertFalse(source.exists())
        assertTrue(moved.exists())
        posixOnly()
        sut.delete(moved.path, recursive = false)
        assertFalse(moved.exists())
    }

    @Test fun deleteRefusesAMissingTarget() = runTest {
        val error = runCatching { channel().delete(File(temp.root, "absent.txt").path, false) }.exceptionOrNull()
        assertTrue("expected IOException but got $error", error is IOException)
    }

    @Test fun deleteRefusesDirectoriesWithoutRecursiveAndFilesWithIt() = runTest {
        posixOnly()
        val directory = temp.newFolder("tree")
        val error = runCatching { channel().delete(directory.path, recursive = false) }.exceptionOrNull()
        assertTrue(error is UnsafeLocalDelete)
        assertEquals(LocalDeleteRefusal.DIRECTORY_WITHOUT_RECURSIVE, (error as UnsafeLocalDelete).refusal)
        val file = temp.newFile("plain.txt")
        val other = runCatching { channel().delete(file.path, recursive = true) }.exceptionOrNull()
        assertTrue(other is UnsafeLocalDelete)
        assertEquals(LocalDeleteRefusal.DIRECTORY_WITHOUT_RECURSIVE, (other as UnsafeLocalDelete).refusal)
    }

    /**
     * A target that exists but sits outside the declared writable roots is refused by the guard,
     * and is left alone.
     *
     * The target has to exist: `delete` fails on a missing path *before* the guard is consulted, so
     * asserting the refusal without creating the file would pass for the wrong reason on any machine
     * where it actually ran. It did exactly that here — this case is gated to POSIX hosts, so it had
     * never executed until CI ran it on Linux.
     */
    @Test fun deleteRefusesPathsOutsideTheWritableRoots() = runTest {
        posixOnly()
        val outside = temp.newFolder("outside")
        val target = File(outside, "a.txt").apply { writeBytes("keep me".toByteArray()) }
        val narrow = LocalRoots(
            readable = listOf(temp.root.absolutePath),
            writable = listOf(File(temp.root, "outside/allowed").apply { mkdirs() }.path)
        )
        val error = runCatching { channel(narrow).delete(target.path, false) }.exceptionOrNull()
        assertTrue("expected a guard refusal, got $error", error is UnsafeLocalDelete)
        assertEquals(LocalDeleteRefusal.PROTECTED_PATH, (error as UnsafeLocalDelete).refusal)
        assertTrue("a refused delete must not have deleted anything", target.exists())
    }

    /**
     * A link planted inside the tree must be unlinked, not followed: following it would delete the
     * link's target, which is the classic way a recursive delete escapes its directory.
     */
    @Test fun recursiveDeleteUnlinksSymlinksWithoutFollowingThem() = runTest {
        posixOnly()
        val outside = temp.newFolder("outside")
        val keep = File(outside, "keep.txt").apply { writeBytes("keep".toByteArray()) }
        val tree = temp.newFolder("tree")
        File(tree, "inside.txt").writeBytes("inside".toByteArray())
        val link = File(tree, "escape")
        val created = runCatching { Files.createSymbolicLink(link.toPath(), outside.toPath()) }.isSuccess
        assumeTrue("requires the privilege to create symbolic links", created)
        channel().delete(tree.path, recursive = true)
        assertFalse("the tree must be gone", tree.exists())
        assertTrue("the link target must survive", keep.exists())
        assertEquals("keep", keep.readText())
    }
}
