package io.github.openfinalshell.android.transfer

import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Exercises actual ContentResolver IPC and kernel file/pipe descriptors on API 26 and 35. */
class SafDocumentsTest {
    private val resolver get() = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver
    private val control = Uri.parse("content://${SafFixtureProvider.AUTHORITY}")
    private lateinit var fixtureId: String
    private lateinit var documents: SafDocuments
    private lateinit var tree: Uri
    private fun uri(node: String) = DocumentsContract.buildDocumentUriUsingTree(tree, "$fixtureId:$node")

    @Before fun setUp() {
        fixtureId = requireNotNull(resolver.call(control, "fixture:create", null, null)?.getString("id"))
        tree = DocumentsContract.buildTreeDocumentUri(SafFixtureProvider.AUTHORITY, "$fixtureId:root")
        documents = SafDocuments(resolver)
    }

    @After fun tearDown() {
        if (::fixtureId.isInitialized) resolver.call(control, "fixture:delete", fixtureId, null)
    }

    private fun snapshot(node: String): Bundle = requireNotNull(resolver.call(control, "fixture:snapshot", fixtureId,
        Bundle().apply { putString("node", node) }))

    private suspend fun awaitPipe(completed: Int): ByteArray = withTimeout(5_000) {
        while (snapshot("pipe-sink").getInt("completed") < completed) delay(10)
        snapshot("pipe-sink").let {
            assertFalse("fixture pipe failed", it.getBoolean("writerFailed"))
            requireNotNull(it.getByteArray("bytes"))
        }
    }

    @Test fun seekableSourceReadsOffsetsAndReopensAfterPause() = runBlocking {
        val source = documents.source(documents.info(uri("file")))
        try {
            assertTrue(source.supportsResume)
            assertEquals(16L, source.size)
            assertArrayEquals("4567".toByteArray(), source.read(4, 4))
            source.close()
            assertArrayEquals("89ab".toByteArray(), source.read(8, 4))
            assertArrayEquals("01".toByteArray(), source.read(0, 2))
            assertTrue(source.read(16, 4).isEmpty())
        } finally { source.close() }
    }

    @Test fun seekableSinkResumesAtTheRequestedOffsetAfterPause() = runBlocking {
        val sink = documents.sink(uri("file"))
        try {
            assertTrue(sink.supportsResume)
            sink.reset()
            sink.write(0, "hello ".toByteArray())
            sink.pause()
            sink.write(6, "world".toByteArray())
            sink.write(0, "H".toByteArray())
            sink.complete(11)
            assertArrayEquals("Hello world".toByteArray(), snapshot("file").getByteArray("bytes"))
        } finally { sink.abort() }
    }

    @Test fun sinkResetTruncatesOldTailBeforeRetry() = runBlocking {
        val sink = documents.sink(uri("file"))
        try {
            sink.reset()
            sink.write(0, "long failed transfer".toByteArray())
            sink.pause()
            sink.reset()
            sink.write(0, "ok".toByteArray())
            sink.complete(2)
            assertArrayEquals("ok".toByteArray(), snapshot("file").getByteArray("bytes"))
        } finally { sink.abort() }
    }

    @Test fun pipeSourceAdvertisesNoResumeAndReopensFromZero() = runBlocking {
        val source = documents.source(documents.info(uri("pipe-source")))
        try {
            assertFalse(source.supportsResume)
            assertArrayEquals("0123".toByteArray(), source.read(0, 4))
            assertArrayEquals("4567".toByteArray(), source.read(4, 4))
            source.close()
            assertArrayEquals("0123".toByteArray(), source.read(0, 4))
            assertTrue(snapshot("pipe-source").getInt("opened") >= 3)
        } finally { source.close() }
    }

    @Test fun pipeSinkRestartsFromZeroAfterPauseAndRejectsWrongOffsets() = runBlocking {
        val sink = documents.sink(uri("pipe-sink"))
        try {
            assertFalse(sink.supportsResume)
            sink.reset()
            sink.write(0, "partial".toByteArray())
            sink.pause()
            assertArrayEquals("partial".toByteArray(), awaitPipe(1))
            sink.reset()
            val failure = runCatching { sink.write(7, "wrong".toByteArray()) }.exceptionOrNull()
            assertTrue(failure is IllegalStateException)
            sink.write(0, "new ".toByteArray())
            sink.write(4, "content".toByteArray())
            sink.complete(11)
            assertArrayEquals("new content".toByteArray(), awaitPipe(2))
        } finally { sink.abort() }
    }

    @Test fun invalidMetadataAndCreateNamesAreRejected() {
        val root = documents.root(tree)
        for (name in listOf("", " ", ".", "..", "../escape", "a/b", "a\\b", "a\u0000b")) {
            assertThrows(IllegalArgumentException::class.java) { documents.create(root, name, false) }
        }
        assertThrows(IllegalArgumentException::class.java) { documents.info(uri("bad-name")) }
    }

    @Test fun revokedProviderAccessFailsReadsAndWritesWithoutFallback() = runBlocking {
        val source = documents.source(documents.info(uri("file")))
        val sink = documents.sink(uri("file"))
        try {
            resolver.call(control, "fixture:deny", fixtureId, null)
            assertThrows(SecurityException::class.java) { documents.info(uri("file")) }
            assertTrue(runCatching { source.read(0, 4) }.exceptionOrNull() is SecurityException)
            assertTrue(runCatching { sink.reset() }.exceptionOrNull() is SecurityException)
            assertTrue(runCatching { sink.write(0, "denied".toByteArray()) }.exceptionOrNull() is SecurityException)
            assertArrayEquals(SafFixtureProvider.INITIAL, snapshot("file").getByteArray("bytes"))
        } finally { source.close(); sink.abort() }
    }

    @Test fun revokedAccessDuringResumeProbeRequiresANewSelection() {
        val entry = documents.info(uri("file"))
        resolver.call(control, "fixture:deny", fixtureId, null)
        assertThrows(SecurityException::class.java) { documents.source(entry) }
        assertThrows(SecurityException::class.java) { documents.sink(entry.uri) }
        assertArrayEquals(SafFixtureProvider.INITIAL, snapshot("file").getByteArray("bytes"))
    }

    @Test fun treeRootCreatesAndListsDirectoriesWithUnicodeNames() {
        val root = documents.root(tree)
        assertEquals(uri("root"), root)
        val directory = documents.create(root, "目录 日本語 한글", true)
        assertTrue(documents.info(directory).directory)
        assertTrue(documents.children(directory).isEmpty())
        val file = documents.create(directory, "hello world.txt", false)
        val child = documents.children(directory).single()
        assertEquals(file, child.uri)
        assertEquals("hello world.txt", child.name)
        assertEquals(0L, child.size)
        assertFalse(child.directory)
        assertEquals("目录 日本語 한글", documents.info(directory).name)
    }
}
