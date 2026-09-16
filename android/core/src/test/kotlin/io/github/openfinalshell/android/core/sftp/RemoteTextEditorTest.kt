package io.github.openfinalshell.android.core.sftp

import io.github.openfinalshell.android.core.ssh.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.nio.charset.Charset

class RemoteTextEditorTest {
    @Test fun explicitLegacyEncodingsRoundTripAndPreserveCrlf() = runTest {
        for ((encoding, text) in listOf("utf8" to "中文", "gb18030" to "中文\uD83D\uDE00", "gbk" to "中文", "big5" to "繁體中文", "latin1" to "caf\u00E9")) {
            val charset = Charset.forName(RemoteTextEditor.resolveEncoding(encoding).charsetName)
            val bytes = "$text\r\nend\r\n".toByteArray(charset)
            val files = Files().apply { this.files["/test"] = bytes }
            val document = RemoteTextEditor.load(files, "/test", encoding)
            assertEquals("$text\r\nend\r\n", document.text)
            assertEquals("crlf", document.eol)
            RemoteTextEditor.save(files, document, document.text)
            assertArrayEquals(bytes, files.read("/test"))
            val edited = RemoteTextEditor.save(files, document, document.text + "new\n")
            assertArrayEquals(("$text\r\nend\r\nnew\r\n").toByteArray(charset), files.read("/test"))
            assertEquals("crlf", edited.eol)
        }
    }

    @Test fun utf8BomSurvivesEditingWithoutBecomingVisibleText() = runTest {
        val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
        val files = Files().apply { this.files["/test"] = bom + "one\r\ntwo\r\n".toByteArray() }
        val original = RemoteTextEditor.load(files, "/test")
        assertTrue(original.hasBom)
        assertEquals("one\r\ntwo\r\n", original.text)
        val saved = RemoteTextEditor.save(files, original, "changed\ntwo\n")
        assertTrue(saved.hasBom)
        assertArrayEquals(bom + "changed\r\ntwo\r\n".toByteArray(), files.read("/test"))
    }

    @Test fun mixedAndLoneCrEndingsArePreserved() = runTest {
        for (text in listOf("one\r\ntwo\nthree\r", "one\rtwo\r")) {
            val files = Files().apply { this.files["/test"] = text.toByteArray() }
            val original = RemoteTextEditor.load(files, "/test")
            RemoteTextEditor.save(files, original, original.text)
            assertArrayEquals(text.toByteArray(), files.read("/test"))
            if (original.eol == "mixed") {
                RemoteTextEditor.save(files, original, original.text.replace("two", "edited"))
                assertArrayEquals(text.replace("two", "edited").toByteArray(), files.read("/test"))
            }
        }
    }

    @Test fun unrepresentableTextDoesNotCreateOrAlterRemoteFiles() = runTest {
        for ((encoding, badText) in listOf("gbk" to "emoji \uD83D\uDE00", "big5" to "emoji \uD83D\uDE00", "latin1" to "中文", "utf8" to "bad \uD800")) {
            val files = Files()
            val original = RemoteTextEditor.load(files, "/test", encoding)
            try { RemoteTextEditor.save(files, original, badText); fail("lossy encoding must fail") }
            catch (_: RemoteTextEncodingFailure) { }
            assertEquals(setOf("/test"), files.files.keys)
            assertEquals("original", files.read("/test").toString(Charsets.UTF_8))
        }
    }

    @Test fun unsupportedOrUnavailableCharsetsFailExplicitly() {
        assertThrows(RemoteTextEncodingUnavailable::class.java) { RemoteTextEditor.resolveEncoding("utf16") }
        assertThrows(RemoteTextEncodingUnavailable::class.java) { RemoteTextEditor.resolveEncoding("gb18030") { false } }
        assertEquals(RemoteTextEncoding.GBK, RemoteTextEditor.resolveEncoding("GB2312"))
        assertEquals(RemoteTextEncoding.LATIN1, RemoteTextEditor.resolveEncoding("ISO-8859-1"))
    }

    @Test fun invalidLegacyBytesAreRejectedBeforeEditing() = runTest {
        for (encoding in listOf("gbk", "big5", "gb18030")) {
            val files = Files().apply { this.files["/test"] = byteArrayOf(0x81.toByte()) }
            try { RemoteTextEditor.load(files, "/test", encoding); fail("incomplete sequence must fail") }
            catch (_: RemoteTextEncodingFailure) { }
        }
    }

    @Test fun encodedByteLimitAndBinaryCheckApplyToLegacyEncodings() = runTest {
        val files = Files()
        val original = RemoteTextEditor.load(files, "/test", "gbk")
        assertTrue(runCatching { RemoteTextEditor.save(files, original, "中".repeat(RemoteTextEditor.MAX_BYTES / 2 + 1)) }.isFailure)
        assertTrue(runCatching { RemoteTextEditor.save(files, original, "a\u0000b") }.isFailure)
        files.write("/test", byteArrayOf(65, 0, 66))
        assertTrue(runCatching { RemoteTextEditor.load(files, "/test", "latin1") }.isFailure)
    }

    private class Files : SftpChannel {
        val files = mutableMapOf("/test" to "original".toByteArray())
        var atomic = true
        override suspend fun list(path: String) = files.map { (name, bytes) -> SftpEntry(name.substringAfterLast('/'), name, SftpEntry.Type.FILE, bytes.size.toLong(), 420) }
        override suspend fun read(path: String) = files.getValue(path)
        override suspend fun write(path: String, data: ByteArray) { files[path] = data }
        override suspend fun permissions(path: String, mode: Int) { assertEquals(420, mode) }
        override suspend fun atomicReplace(from: String, to: String) { if (!atomic) throw AtomicReplaceUnavailable(); files[to] = files.remove(from)!! }
        override suspend fun delete(path: String, recursive: Boolean) { files.remove(path) }
        override suspend fun close() = Unit
    }

    @Test fun rejectsConflictingSaveWithoutChangingRemoteData() = runTest {
        val files = Files(); val original = RemoteTextEditor.load(files, "/test")
        files.write("/test", "external edit".toByteArray())
        try { RemoteTextEditor.save(files, original, "mine"); fail("must reject conflict") } catch (_: RemoteTextConflict) { }
        assertEquals("external edit", files.read("/test").toString(Charsets.UTF_8))
    }

    @Test fun atomicSavePreservesModeAndRemovesTemporaryFile() = runTest {
        val files = Files(); val original = RemoteTextEditor.load(files, "/test")
        val saved = RemoteTextEditor.save(files, original, "中文\n")
        assertEquals("中文\n", saved.text); assertEquals(setOf("/test"), files.files.keys)
    }

    @Test fun unsupportedAtomicSaveRequiresExplicitFallback() = runTest {
        val files = Files().apply { atomic = false }; val original = RemoteTextEditor.load(files, "/test")
        try { RemoteTextEditor.save(files, original, "mine"); fail("confirmation required") } catch (_: AtomicReplaceUnavailable) { }
        assertEquals("original", files.read("/test").toString(Charsets.UTF_8))
        RemoteTextEditor.save(files, original, "mine", allowNonAtomic = true)
        assertEquals("mine", files.read("/test").toString(Charsets.UTF_8))
    }

    @Test fun refusesBinaryAndMalformedUtf8() = runTest {
        for (bytes in listOf(byteArrayOf(65, 0), byteArrayOf(0xC3.toByte(), 0x28))) {
            val files = Files().apply { this.files["/test"] = bytes }
            assertTrue(runCatching { RemoteTextEditor.load(files, "/test") }.isFailure)
        }
    }
}
