package io.github.openfinalshell.android.transfer

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import io.github.openfinalshell.android.core.sftp.TransferSink
import io.github.openfinalshell.android.core.sftp.TransferSource
import java.io.InputStream
import java.io.OutputStream
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import java.nio.ByteBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class SafEntry(val uri: Uri, val name: String, val size: Long, val directory: Boolean)

/** SAF paths stay as URIs, including cloud/document providers and scoped storage. */
class SafDocuments(private val resolver: ContentResolver) {
    fun info(uri: Uri): SafEntry {
        val directory = resolver.getType(uri) == DocumentsContract.Document.MIME_TYPE_DIR
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            check(cursor.moveToFirst())
            return SafEntry(uri, safeName(cursor.getString(0)), if (cursor.isNull(1)) -1 else cursor.getLong(1), directory)
        }
        error("document is unavailable")
    }

    fun root(tree: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

    fun children(parent: Uri): List<SafEntry> {
        val list = DocumentsContract.buildChildDocumentsUriUsingTree(parent, DocumentsContract.getDocumentId(parent))
        val fields = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_MIME_TYPE)
        return resolver.query(list, fields, null, null, null)?.use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(SafEntry(DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0)),
                    safeName(cursor.getString(1)), if (cursor.isNull(2)) -1 else cursor.getLong(2), cursor.getString(3) == DocumentsContract.Document.MIME_TYPE_DIR))
            }
        } ?: error("document directory is unavailable")
    }

    fun create(parent: Uri, name: String, directory: Boolean): Uri = requireNotNull(DocumentsContract.createDocument(resolver, parent,
        if (directory) DocumentsContract.Document.MIME_TYPE_DIR else "application/octet-stream", safeName(name)))

    fun source(entry: SafEntry): TransferSource = object : TransferSource {
        override val size: Long = entry.size.also { require(it >= 0) { "document size is unavailable" } }
        // Pipe-backed SAF documents cannot seek. Reopen from byte zero after pause/retry.
        override val supportsResume = canSeek(entry.uri, "r")
        private var input: InputStream? = null
        private var position = 0L
        override suspend fun read(offset: Long, maxBytes: Int): ByteArray = withContext(Dispatchers.IO) {
            if (supportsResume) return@withContext ParcelFileDescriptor.AutoCloseInputStream(requireNotNull(resolver.openFileDescriptor(entry.uri, "r"))).use { stream ->
                stream.channel.position(offset)
                val data = ByteBuffer.allocate(maxBytes)
                stream.channel.read(data)
                data.array().copyOf(data.position())
            }
            if (input == null || offset != position) {
                input?.close()
                input = requireNotNull(resolver.openInputStream(entry.uri))
                position = 0
                while (position < offset) {
                    val skipped = input!!.skip(offset - position)
                    check(skipped > 0) { "document cannot resume" }
                    position += skipped
                }
            }
            val data = ByteArray(maxBytes)
            val count = input!!.read(data)
            if (count < 0) ByteArray(0) else data.copyOf(count).also { position += count }
        }
        override suspend fun close() { input?.close(); input = null }
    }

    fun sink(uri: Uri): TransferSink = object : TransferSink {
        override val supportsResume = canSeek(uri, "rw")
        private var output: OutputStream? = null
        private var position = 0L
        override suspend fun reset() = withContext(Dispatchers.IO) {
            output?.close()
            output = requireNotNull(resolver.openOutputStream(uri, "wt"))
            position = 0
        }
        override suspend fun write(offset: Long, data: ByteArray) = withContext(Dispatchers.IO) {
            if (supportsResume) {
                output?.close(); output = null
                ParcelFileDescriptor.AutoCloseOutputStream(requireNotNull(resolver.openFileDescriptor(uri, "rw"))).use { stream ->
                    stream.channel.position(offset)
                    val buffer = ByteBuffer.wrap(data)
                    while (buffer.hasRemaining()) stream.channel.write(buffer)
                }
                position = offset + data.size
                return@withContext
            }
            check(offset == position) { "document stream offset changed" }
            requireNotNull(output).write(data)
            position += data.size
        }
        override suspend fun complete(totalBytes: Long) { output?.close(); output = null }
        override suspend fun abort() { output?.close(); output = null }
        override suspend fun pause() { output?.close(); output = null }
    }

    private fun canSeek(uri: Uri, mode: String): Boolean = try {
        resolver.openFileDescriptor(uri, mode)?.use { Os.lseek(it.fileDescriptor, 0, OsConstants.SEEK_CUR); true } ?: false
    } catch (denied: SecurityException) {
        // Revoked access needs a new user selection, not a non-seekable fallback.
        throw denied
    } catch (_: Exception) {
        false
    }

    companion object {
        fun safeName(name: String): String {
            require(name.isNotBlank() && name != "." && name != ".." && name.none { it == '/' || it == '\\' || it == '\u0000' })
            return name
        }
    }
}
