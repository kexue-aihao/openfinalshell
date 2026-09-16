package io.github.openfinalshell.android

import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import io.github.openfinalshell.android.storage.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** Exercises real SQLite schema validation and Android Keystore; JVM mocks cannot validate either. */
class ToolStorageTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun migrationPreservesExistingDocumentsAndValidatesRoomSchema() = runBlocking {
        val name = "migration-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppDatabase::class.java, name)
            .addMigrations(AppDatabase.MIGRATION_3_4).build()
        try {
            open().let { database ->
                database.documents().upsert(DocumentEntity("sentinel", "unchanged")); database.close()
            }
            // Start from the actual v3 table layout by removing only the four new v4 tables.
            context.openOrCreateDatabase(name, 0, null).use { sqlite ->
                for (table in listOf("ai_profiles","command_groups","command_snippets","command_history")) sqlite.execSQL("DROP TABLE $table")
                sqlite.execSQL("DELETE FROM room_master_table")
                sqlite.version = 3
            }
            open().let { database ->
                try {
                    assertEquals("unchanged", database.documents().find("sentinel")?.json)
                    database.tools().save(CommandGroupEntity("g","group"))
                    assertEquals("group",database.tools().groups().single().name)
                    assertEquals(4,database.openHelper.writableDatabase.version)
                } finally { database.close() }
            }
        } finally { context.deleteDatabase(name) }
    }

    @Test fun tokensStayPrivateAndCommandLibraryAloneIsPortable() = runBlocking {
        val database=Room.inMemoryDatabaseBuilder(context,AppDatabase::class.java).build()
        try {
            val repository=ToolRepository(database,AndroidCredentialStore(context,database))
            val saved=repository.saveProfile(null,"test","https://api.example/v1","model","test-token")
            assertTrue(saved.hasToken)
            assertFalse(saved.toString().contains("test-token"))
            assertEquals("test-token",repository.resolve(saved.id).second)
            repository.saveGroup("group","维护")
            repository.saveSnippet("snippet","Disk","df -h","group")
            repository.recordCommand("do-not-export-history")
            val exported=ToolPortable.export(database.tools())
            assertEquals(setOf("snippets","snippetGroups"),exported.keys)
            assertFalse(exported.toString().contains("test-token"))
            assertFalse(exported.toString().contains("do-not-export-history"))
            val replaced=repository.saveProfile(saved,saved.name,saved.baseUrl,saved.model,"replacement")
            try { repository.saveProfile(saved,saved.name,saved.baseUrl,saved.model,null); fail("stale edit") } catch (_: io.github.openfinalshell.android.core.ai.AiFailure) { }
            assertEquals("replacement",repository.resolve(saved.id).second)
            assertFalse(repository.saveProfile(replaced,replaced.name,replaced.baseUrl,replaced.model,null,true).hasToken)
            val result=ToolPortable.import(exported,database.tools(),ImportConflict.DUPLICATE)
            assertEquals(1,result.applied)
            val duplicate=database.tools().snippets().first { it.id!="snippet" }
            assertNotEquals("group",duplicate.groupId)
        } finally { database.close() }
    }
}
