package io.github.openfinalshell.android.storage

import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ConnectionProxy
import io.github.openfinalshell.android.core.protocol.ProtocolJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonPrimitive

class ProfileRepository(private val dao: ProfileDao) {
    suspend fun list(): List<ConnectionProfile> = dao.list().mapNotNull(::decode)

    suspend fun find(id: String): ConnectionProfile? = dao.find(id)?.let(::decode)

    suspend fun upsert(profile: ConnectionProfile) {
        val now = System.currentTimeMillis()
        val existing = dao.find(profile.id)
        dao.upsert(
            ProfileEntity(
                id = profile.id,
                name = profile.name,
                host = profile.host,
                port = profile.port,
                username = profile.username,
                authMethod = profile.auth.method,
                passwordRef = profile.auth.passwordRef,
                privateKeyId = profile.auth.privateKeyId,
                passphraseRef = profile.auth.passphraseRef,
                proxyJson = profile.proxy?.let {
                    ProtocolJson.instance.encodeToString(ConnectionProxy.serializer(), it)
                },
                profileJson = ProtocolJson.instance.encodeToString(ConnectionProfile.serializer(), profile),
                createdAt = existing?.createdAt?.takeIf { it > 0 } ?: now,
                updatedAt = now
            )
        )
    }

    /** Preserve unknown desktop fields while importing a profile into the reduced Android model. */
    suspend fun upsertImported(raw: JsonObject, idOverride: String? = null): ConnectionProfile {
        val profile = ProtocolJson.instance.decodeFromJsonElement(ConnectionProfile.serializer(), raw)
        val id = idOverride ?: profile.id
        val now = System.currentTimeMillis()
        val existing = dao.find(id)
        val profileJson = raw.toString()
        dao.upsert(
            ProfileEntity(
                id = id,
                name = profile.name,
                host = profile.host,
                port = profile.port,
                username = profile.username,
                authMethod = profile.auth.method,
                passwordRef = profile.auth.passwordRef,
                privateKeyId = profile.auth.privateKeyId,
                passphraseRef = profile.auth.passphraseRef,
                proxyJson = profile.proxy?.let { ProtocolJson.instance.encodeToString(ConnectionProxy.serializer(), it) },
                profileJson = profileJson,
                protocol = raw["protocol"]?.jsonPrimitive?.content ?: "ssh",
                groupId = raw["groupId"]?.jsonPrimitive?.content,
                color = raw["color"]?.jsonPrimitive?.content,
                flag = raw["flag"]?.jsonPrimitive?.content,
                terminalJson = raw["terminal"]?.toString(),
                optionsJson = raw["options"]?.toString(),
                proxyMode = raw["proxyMode"]?.jsonPrimitive?.content,
                proxyId = raw["proxyId"]?.jsonPrimitive?.content,
                jumpHostId = raw["jumpHostId"]?.jsonPrimitive?.content,
                note = raw["note"]?.jsonPrimitive?.content,
                createdAt = existing?.createdAt?.takeIf { it > 0 } ?: now,
                updatedAt = now,
                lastUsedAt = raw["lastUsedAt"]?.jsonPrimitive?.longOrNull
            )
        )
        return profile.copy(id = id)
    }

    suspend fun delete(id: String) = dao.delete(id)

    private fun decode(entity: ProfileEntity): ConnectionProfile? {
        val stored = entity.profileJson?.let { raw ->
            runCatching { ProtocolJson.instance.decodeFromString(ConnectionProfile.serializer(), raw) }.getOrNull()
        }
        if (stored != null) return stored
        return runCatching {
            ConnectionProfile(
                id = entity.id,
                name = entity.name,
                host = entity.host,
                port = entity.port,
                username = entity.username,
                auth = ConnectionAuth(entity.authMethod, entity.passwordRef, entity.privateKeyId, entity.passphraseRef),
                proxy = entity.proxyJson?.let {
                    ProtocolJson.instance.decodeFromString(ConnectionProxy.serializer(), it)
                }
            )
        }.getOrNull()
    }
}
