package io.github.openfinalshell.android.storage

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsRepositoryTest {
    @Test
    fun `missing document returns and persists defaults`() = runBlocking {
        val dao = FakeDocumentDao()
        val settings = SettingsRepository(dao, Dispatchers.Unconfined).load()

        assertEquals(AndroidSettings(), settings)
        assertTrue(dao.documents.containsKey(AndroidSettings.DOCUMENT_NAME))
    }

    @Test
    fun `settings round trip preserves supported values`() = runBlocking {
        val dao = FakeDocumentDao()
        val repository = SettingsRepository(dao, Dispatchers.Unconfined)
        val expected = AndroidSettings(theme = "dark", sftpConcurrency = 8, monitorIntervalSeconds = 30)

        repository.save(expected)

        assertEquals(expected, repository.load())
    }

    @Test
    fun `legacy values are migrated and constrained`() = runBlocking {
        val dao = FakeDocumentDao()
        dao.upsert(DocumentEntity(AndroidSettings.DOCUMENT_NAME, """{"schemaVersion":0,"theme":"solarized","terminalFontSize":99,"sftpConcurrency":0,"sftpShowHiddenFiles":true}"""))

        val migrated = SettingsRepository(dao, Dispatchers.Unconfined).load()

        assertEquals(AndroidSettings.CURRENT_SCHEMA_VERSION, migrated.schemaVersion)
        assertEquals("system", migrated.theme)
        assertEquals(32, migrated.terminalFontSize)
        assertEquals(1, migrated.sftpConcurrency)
        assertTrue(migrated.sftpShowHiddenFiles)
        assertFalse(dao.documents[AndroidSettings.DOCUMENT_NAME]!!.json.contains("\"schemaVersion\":0"))
    }

    private class FakeDocumentDao : DocumentDao {
        val documents = linkedMapOf<String, DocumentEntity>()
        override suspend fun find(name: String): DocumentEntity? = documents[name]
        override suspend fun upsert(document: DocumentEntity) { documents[document.name] = document }
        override suspend fun delete(name: String) { documents.remove(name) }
    }
}
