package io.github.openfinalshell.android.core.local

import io.github.openfinalshell.android.core.ssh.AtomicReplaceUnavailable
import io.github.openfinalshell.android.core.ssh.SftpChannel
import io.github.openfinalshell.android.core.ssh.SftpEntry
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * An [SftpChannel] over the device's own filesystem.
 *
 * Everything above this class — the transfer queue, the remote text editor, the SFTP panel —
 * consumes only the [SftpChannel] byte and metadata contract, so a local session gets the file
 * panel, resumable transfers and conflict-safe editing without any of them learning about local
 * files. The one behavioural addition is the delete guard, because here a wrong path costs the
 * user their device rather than a server.
 *
 * [roots] must already be canonical (see [LocalRoots.canonicalized]); the guard compares a
 * canonicalised target against them, and a symlinked root such as `/sdcard` would otherwise make
 * every ordinary delete look like an escape.
 */
class LocalFileChannel(
    roots: LocalRoots,
    private val mounts: Set<String> = emptySet()
) : SftpChannel {
    private val roots = roots.canonicalized()

    override suspend fun list(path: String): List<SftpEntry> = withContext(Dispatchers.IO) {
        val directory = File(path)
        val children = directory.listFiles()
            ?: throw IOException("cannot list ${directory.path}")
        val prefix = path.trimEnd('/')
        children.map { child ->
            // NOFOLLOW_LINKS keeps a symlink reported as a link rather than as whatever it points
            // at, which is what the SFTP panel and the recursive delete walk both rely on.
            val attributes = runCatching {
                Files.readAttributes(child.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            }.getOrNull()
            val type = when {
                attributes == null -> SftpEntry.Type.OTHER
                attributes.isDirectory -> SftpEntry.Type.DIRECTORY
                attributes.isRegularFile -> SftpEntry.Type.FILE
                attributes.isSymbolicLink -> SftpEntry.Type.SYMLINK
                else -> SftpEntry.Type.OTHER
            }
            SftpEntry(
                name = child.name,
                path = "$prefix/${child.name}",
                type = type,
                size = attributes?.size(),
                permissions = readMode(child)
            )
        }
    }

    override suspend fun read(path: String): ByteArray = withContext(Dispatchers.IO) {
        File(path).readBytes()
    }

    override suspend fun readChunk(path: String, offset: Long, maxBytes: Int): ByteArray = withContext(Dispatchers.IO) {
        require(offset >= 0 && maxBytes > 0)
        RandomAccessFile(path, "r").use { file ->
            if (offset >= file.length()) return@use ByteArray(0)
            file.seek(offset)
            val length = minOf(maxBytes.toLong(), file.length() - offset).toInt()
            val buffer = ByteArray(length)
            file.readFully(buffer)
            buffer
        }
    }

    override suspend fun write(path: String, data: ByteArray) = withContext(Dispatchers.IO) {
        File(path).writeBytes(data)
    }

    override suspend fun writeChunk(path: String, data: ByteArray, offset: Long, truncate: Boolean) = withContext(Dispatchers.IO) {
        RandomAccessFile(path, "rw").use { file ->
            if (truncate) file.setLength(0)
            file.seek(offset)
            file.write(data)
        }
    }

    override suspend fun mkdir(path: String) = withContext(Dispatchers.IO) {
        val directory = File(path)
        // Single level, matching SFTP's mkdir rather than mkdirs.
        if (!directory.mkdir() && !directory.isDirectory) {
            throw IOException("cannot create directory ${directory.path}")
        }
    }

    override suspend fun rename(from: String, to: String) = withContext(Dispatchers.IO) {
        if (!File(from).renameTo(File(to))) {
            throw IOException("cannot rename $from to $to")
        }
    }

    /**
     * `rename(2)` on the same filesystem is atomic and has replace semantics, so a local save is
     * genuinely atomic. A cross-device move cannot be, and reports [AtomicReplaceUnavailable] so
     * the editor can ask the user before falling back to a plain overwrite.
     */
    override suspend fun atomicReplace(from: String, to: String) = withContext(Dispatchers.IO) {
        if (!File(from).renameTo(File(to))) throw AtomicReplaceUnavailable()
    }

    /**
     * Best effort, and deliberately never throws.
     *
     * The editor calls this to carry a file's mode across an atomic replace. Failing that call
     * would abort a save the user already confirmed and delete the staged temp file with it — the
     * user would lose their edit over a permission bit. Locally the bit is also only advisory:
     * ownership can never be preserved without root, and on FUSE-backed shared storage the mode is
     * synthetic and `chmod` is refused outright. There is nothing here worth failing a save for.
     */
    override suspend fun permissions(path: String, mode: Int) = withContext(Dispatchers.IO) {
        runCatching { Files.setPosixFilePermissions(File(path).toPath(), modeToPermissions(mode)) }
        Unit
    }

    /**
     * Guarded twice on purpose: [MainViewModel] refuses before opening a channel so a refusal costs
     * no I/O, and this refuses again immediately before unlinking so the authoritative check cannot
     * be skipped by a caller that never ran the pre-check.
     */
    override suspend fun delete(path: String, recursive: Boolean) = withContext(Dispatchers.IO) {
        val target = File(path)
        val exists = target.exists() || Files.isSymbolicLink(target.toPath())
        if (!exists) throw IOException("cannot delete ${target.path}: no such file")
        LocalPathGuard.assertDeletable(path, recursive, target.isDirectory, roots, mounts) { File(it).canonicalPath }
        if (target.isDirectory) removeRecursively(target) else if (!target.delete()) {
            throw IOException("cannot delete ${target.path}")
        }
    }

    override suspend fun close() = Unit

    /**
     * Removes a tree without ever descending a symbolic link.
     *
     * A link inside the tree is unlinked, not followed: NOFOLLOW_LINKS reports it as a link rather
     * than a directory, so the recursion stops there and the target of the link is untouched.
     */
    private fun removeRecursively(file: File) {
        val attributes = runCatching {
            Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        }.getOrNull()
        if (attributes?.isDirectory == true) {
            file.listFiles()?.forEach { removeRecursively(it) }
        }
        if (!file.delete()) throw IOException("cannot delete ${file.path}")
    }

    /** Returns the POSIX mode as an int, or null when the filesystem does not report one. */
    private fun readMode(file: File): Int? = runCatching {
        Files.getPosixFilePermissions(file.toPath(), LinkOption.NOFOLLOW_LINKS)
            .fold(0) { mode, permission -> mode or permission.bit() }
    }.getOrNull()

    private fun PosixFilePermission.bit(): Int = when (this) {
        PosixFilePermission.OWNER_READ -> 0x100
        PosixFilePermission.OWNER_WRITE -> 0x080
        PosixFilePermission.OWNER_EXECUTE -> 0x040
        PosixFilePermission.GROUP_READ -> 0x020
        PosixFilePermission.GROUP_WRITE -> 0x010
        PosixFilePermission.GROUP_EXECUTE -> 0x008
        PosixFilePermission.OTHERS_READ -> 0x004
        PosixFilePermission.OTHERS_WRITE -> 0x002
        PosixFilePermission.OTHERS_EXECUTE -> 0x001
    }

    private fun modeToPermissions(mode: Int): Set<PosixFilePermission> = buildSet {
        if (mode and 0x100 != 0) add(PosixFilePermission.OWNER_READ)
        if (mode and 0x080 != 0) add(PosixFilePermission.OWNER_WRITE)
        if (mode and 0x040 != 0) add(PosixFilePermission.OWNER_EXECUTE)
        if (mode and 0x020 != 0) add(PosixFilePermission.GROUP_READ)
        if (mode and 0x010 != 0) add(PosixFilePermission.GROUP_WRITE)
        if (mode and 0x008 != 0) add(PosixFilePermission.GROUP_EXECUTE)
        if (mode and 0x004 != 0) add(PosixFilePermission.OTHERS_READ)
        if (mode and 0x002 != 0) add(PosixFilePermission.OTHERS_WRITE)
        if (mode and 0x001 != 0) add(PosixFilePermission.OTHERS_EXECUTE)
    }
}
