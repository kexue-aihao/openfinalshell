package io.github.openfinalshell.android.core.sftp

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class SafeTarTest {
    @Test fun generatedHeaderRoundTripsWithUtf8AndPadding() {
        val file = File.createTempFile("ofs-safe-write", ".tar")
        try {
            file.writeBytes(SafeTar.header("工具", 0, true) + SafeTar.header("工具/test.txt", 3, false) + "abc".toByteArray() + ByteArray(509) + ByteArray(1024))
            val entries = SafeTar.entries(file)
            assertEquals(listOf("工具", "工具/test.txt"), entries.map { it.path })
            assertEquals(3L, entries[1].size)
        } finally { file.delete() }
    }
    private fun header(name: String, size: Int = 0, type: Char = '0'): ByteArray {
        val bytes = ByteArray(512)
        name.toByteArray().copyInto(bytes)
        (size.toString(8).padStart(11, '0') + "\u0000").toByteArray().copyInto(bytes, 124)
        bytes[156] = type.code.toByte()
        for (i in 148..155) bytes[i] = 32
        val checksum = bytes.sumOf { it.toInt() and 255 }
        (checksum.toString(8).padStart(6, '0') + "\u0000 ").toByteArray().copyInto(bytes, 148)
        return bytes
    }
    @Test fun validatesBeforeExtractionAndRejectsLinksTraversalAndTruncation() {
        val file = File.createTempFile("ofs-safe-tar", ".tar")
        try {
            file.writeBytes(header("dir", type = '5') + header("dir/file", 3) + "abc".toByteArray() + ByteArray(509) + ByteArray(1024))
            assertEquals(listOf("dir", "dir/file"), SafeTar.entries(file).map { it.path })
            for (bad in listOf(header("../out"), header("/absolute"), header("link", type = '2'), header("file", 9999))) {
                file.writeBytes(bad + ByteArray(1024))
                assertTrue(runCatching { SafeTar.entries(file) }.isFailure)
            }
        } finally { file.delete() }
    }
}
