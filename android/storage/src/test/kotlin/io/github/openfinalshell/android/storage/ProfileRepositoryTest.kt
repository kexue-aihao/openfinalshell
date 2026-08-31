package io.github.openfinalshell.android.storage

import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionProfile
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class ProfileRepositoryTest {
    @Test
    fun `duplicate import keeps generated id in serialized profile`() = runBlocking {
        val dao = InMemoryProfileDao()
        val repository = ProfileRepository(dao)
        val source = ConnectionProfile(
            id = "source",
            name = "server",
            host = "example.test",
            username = "root",
            auth = ConnectionAuth(method = "password")
        )

        repository.upsertImported(
            kotlinx.serialization.json.JsonObject(
                kotlinx.serialization.json.buildJsonObject {
                    put("id", source.id)
                    put("name", source.name)
                    put("host", source.host)
                    put("port", source.port)
                    put("username", source.username)
                    put("auth", kotlinx.serialization.json.buildJsonObject { put("method", "password") })
                }
            ),
            idOverride = "duplicate"
        )

        assertEquals("duplicate", dao.find("duplicate")?.id)
        assertEquals("duplicate", repository.list().single().id)
    }

    private class InMemoryProfileDao : ProfileDao {
        private val rows = linkedMapOf<String, ProfileEntity>()
        override suspend fun list(): List<ProfileEntity> = rows.values.toList()
        override suspend fun find(id: String): ProfileEntity? = rows[id]
        override suspend fun upsert(profile: ProfileEntity) { rows[profile.id] = profile }
        override suspend fun delete(id: String) { rows.remove(id) }
    }
}
