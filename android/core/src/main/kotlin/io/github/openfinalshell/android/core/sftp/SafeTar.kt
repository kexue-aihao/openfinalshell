package io.github.openfinalshell.android.core.sftp

import java.io.File
import java.io.RandomAccessFile

data class TarItem(val path: String, val directory: Boolean, val size: Long, val offset: Long)

/** Strict USTAR reader. Unsupported extended/link entries fall back to ordinary SFTP. */
object SafeTar {
    fun header(path: String, size: Long, directory: Boolean): ByteArray {
        val name = safePath(path).toByteArray(Charsets.UTF_8)
        require(name.size <= 100 && size in 0..(8L * 1024 * 1024 * 1024 - 1))
        val header = ByteArray(512)
        name.copyInto(header)
        fun number(offset: Int, length: Int, value: Long) {
            val encoded = value.toString(8).padStart(length - 1, '0') + "\u0000"
            require(encoded.length == length)
            encoded.toByteArray(Charsets.US_ASCII).copyInto(header, offset)
        }
        number(100, 8, if (directory) 493 else 420)
        number(108, 8, 0); number(116, 8, 0)
        number(124, 12, if (directory) 0 else size)
        number(136, 12, System.currentTimeMillis() / 1000)
        for (i in 148..155) header[i] = 32
        header[156] = (if (directory) '5' else '0').code.toByte()
        "ustar\u000000".toByteArray(Charsets.US_ASCII).copyInto(header, 257)
        number(148, 7, header.sumOf { it.toInt() and 255 }.toLong())
        return header
    }

    fun entries(file: File): List<TarItem> = RandomAccessFile(file, "r").use { input ->
        val result = mutableListOf<TarItem>()
        val seen = mutableSetOf<String>()
        var expanded = 0L
        var ended = false
        while (input.filePointer + 512 <= input.length()) {
            val header = ByteArray(512).also(input::readFully)
            if (header.all { it == 0.toByte() }) {
                val second = ByteArray(512).also(input::readFully)
                require(second.all { it == 0.toByte() })
                ended = true
                break
            }
            val checksum = octal(header, 148, 8)
            val actual = header.mapIndexed { index, byte -> if (index in 148..155) 32 else byte.toInt() and 255 }.sum()
            require(checksum == actual.toLong())
            val prefix = text(header, 345, 155)
            val raw = (if (prefix.isEmpty()) "" else "$prefix/") + text(header, 0, 100)
            val path = safePath(raw.trimEnd('/'))
            val directory = header[156] == '5'.code.toByte()
            require(directory || header[156] == '0'.code.toByte() || header[156] == 0.toByte()) { "unsupported archive entry" }
            val size = octal(header, 124, 12)
            require(!directory || size == 0L)
            require(size <= 8L * 1024 * 1024 * 1024 && expanded <= 32L * 1024 * 1024 * 1024 - size)
            expanded += size
            require(seen.add(path) && result.size < 10_000)
            val offset = input.filePointer
            val next = offset + ((size + 511) / 512) * 512
            require(next <= input.length())
            result += TarItem(path, directory, size, offset)
            input.seek(next)
        }
        require(ended) { "incomplete archive" }
        // Reject a file used as another entry's parent before writing any output.
        val files = result.filterNot { it.directory }.mapTo(mutableSetOf()) { it.path }
        result.forEach { item ->
            val segments = item.path.split('/')
            for (count in 1 until segments.size) require(segments.take(count).joinToString("/") !in files)
        }
        result
    }

    fun safePath(path: String): String {
        require(path.isNotBlank() && !path.startsWith('/') && !path.contains('\\') && !path.contains(':'))
        require(path.split('/').all { it.isNotBlank() && it != "." && it != ".." && !it.contains('\u0000') })
        return path
    }

    fun quote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
    private fun text(bytes: ByteArray, offset: Int, length: Int): String = bytes.copyOfRange(offset, offset + length)
        .takeWhile { it != 0.toByte() }.toByteArray().toString(Charsets.UTF_8)
    private fun octal(bytes: ByteArray, offset: Int, length: Int): Long = text(bytes, offset, length).trim().ifEmpty { "0" }.toLong(8).also { require(it >= 0) }
}
