package io.github.openfinalshell.android.core.sftp

import io.github.openfinalshell.android.core.ssh.SftpChannel
import io.github.openfinalshell.android.core.ssh.SftpEntry
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.Charset
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID

data class RemoteTextDocument(
    val path: String,
    val text: String,
    val fingerprint: String,
    val permissions: Int?,
    val encoding: String = "utf8",
    val hasBom: Boolean = false,
    val eol: String = "lf"
)
class RemoteTextConflict : IllegalStateException("remote document has changed")
class RemoteTextEncodingUnavailable : IllegalArgumentException("remote text encoding is unavailable")
class RemoteTextEncodingFailure : IllegalArgumentException("remote text cannot round-trip with this encoding")

enum class RemoteTextEncoding(val id: String, val charsetName: String, val label: String) {
    UTF8("utf8", "UTF-8", "UTF-8"),
    GB18030("gb18030", "GB18030", "GB18030"),
    GBK("gbk", "GBK", "GBK"),
    BIG5("big5", "Big5", "Big5"),
    LATIN1("latin1", "ISO-8859-1", "Latin-1")
}

/** Explicit desktop-compatible encoding choices; no guessing or replacement characters. */
object RemoteTextEditor {
    const val MAX_BYTES = 2 * 1024 * 1024
    private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

    fun isEncodingAvailable(encoding: RemoteTextEncoding): Boolean = Charset.isSupported(encoding.charsetName)

    internal fun resolveEncoding(id: String, available: (String) -> Boolean = Charset::isSupported): RemoteTextEncoding {
        val normalized = when (val name = id.trim().lowercase()) {
            "utf-8" -> "utf8"
            "gb-18030" -> "gb18030"
            "gb2312", "cp936" -> "gbk"
            "cp950" -> "big5"
            "iso-8859-1" -> "latin1"
            else -> name
        }
        return RemoteTextEncoding.entries.firstOrNull { it.id == normalized && available(it.charsetName) }
            ?: throw RemoteTextEncodingUnavailable()
    }

    suspend fun load(channel: SftpChannel, path: String, encoding: String = "utf8"): RemoteTextDocument {
        val format = resolveEncoding(encoding)
        val entry = channel.list(path.substringBeforeLast('/').ifEmpty { "/" }).first { it.path == path }
        require(entry.type == SftpEntry.Type.FILE && (entry.size ?: Long.MAX_VALUE) <= MAX_BYTES)
        val bytes = java.io.ByteArrayOutputStream()
        while (bytes.size() <= MAX_BYTES) {
            val part = channel.readChunk(path, bytes.size().toLong(), minOf(32 * 1024, MAX_BYTES + 1 - bytes.size()))
            if (part.isEmpty()) break
            bytes.write(part)
        }
        val raw = bytes.toByteArray()
        require(raw.size <= MAX_BYTES && raw.none { it == 0.toByte() }) { "unsupported remote text file" }
        val hasBom = format == RemoteTextEncoding.UTF8 && raw.take(3).toByteArray().contentEquals(UTF8_BOM)
        val body = if (hasBom) raw.copyOfRange(3, raw.size) else raw
        val charset = Charset.forName(format.charsetName)
        val text = decode(body, charset)
        if (!encode(text, charset).contentEquals(body)) throw RemoteTextEncodingFailure()
        // Keep original CR/LF bytes represented in the text. Mixed endings are never silently unified.
        return RemoteTextDocument(path, text, digest(raw), entry.permissions, format.id, hasBom, detectEol(text))
    }

    suspend fun save(channel: SftpChannel, original: RemoteTextDocument, text: String, allowNonAtomic: Boolean = false): RemoteTextDocument {
        require(text.length <= MAX_BYTES && !text.contains('\u0000')) { "unsupported remote text file" }
        val format = resolveEncoding(original.encoding)
        val charset = Charset.forName(format.charsetName)
        val outputText = if (original.eol == "mixed") text else {
            val normalized = text.replace("\r\n", "\n").replace('\r', '\n')
            when (original.eol) { "crlf" -> normalized.replace("\n", "\r\n"); "cr" -> normalized.replace('\n', '\r'); else -> normalized }
        }
        val encoded = encode(outputText, charset)
        if (decode(encoded, charset) != outputText) throw RemoteTextEncodingFailure()
        val bytes = if (original.hasBom && format == RemoteTextEncoding.UTF8) UTF8_BOM + encoded else encoded
        require(bytes.size <= MAX_BYTES && bytes.none { it == 0.toByte() })
        if (load(channel, original.path, original.encoding).fingerprint != original.fingerprint) throw RemoteTextConflict()
        if (allowNonAtomic) {
            channel.write(original.path, bytes)
        } else {
            val temp = original.path.substringBeforeLast('/').ifEmpty { "/" }.trimEnd('/') + "/.ofs-edit-${UUID.randomUUID()}.tmp"
            try {
                channel.write(temp, bytes)
                original.permissions?.let { channel.permissions(temp, it and 0xFFF) }
                // Check again immediately before replacement after the upload has finished.
                if (load(channel, original.path, original.encoding).fingerprint != original.fingerprint) throw RemoteTextConflict()
                channel.atomicReplace(temp, original.path)
            } finally { runCatching { channel.delete(temp) } }
        }
        return original.copy(text = outputText, fingerprint = digest(bytes), eol = detectEol(outputText))
    }

    private fun decode(bytes: ByteArray, charset: Charset): String = try {
        charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) { throw RemoteTextEncodingFailure() }

    private fun encode(text: String, charset: Charset): ByteArray = try {
        val encoded = charset.newEncoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(text))
        ByteArray(encoded.remaining()).also(encoded::get)
    } catch (_: CharacterCodingException) { throw RemoteTextEncodingFailure() }

    private fun detectEol(text: String): String {
        val crlf = Regex("\r\n").findAll(text).count()
        val lf = text.count { it == '\n' } - crlf
        val cr = text.count { it == '\r' } - crlf
        return when {
            listOf(crlf, lf, cr).count { it > 0 } > 1 -> "mixed"
            crlf > 0 -> "crlf"
            cr > 0 -> "cr"
            else -> "lf"
        }
    }

    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
