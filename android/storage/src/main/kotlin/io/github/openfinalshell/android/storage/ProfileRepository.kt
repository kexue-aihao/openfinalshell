package io.github.openfinalshell.android.storage

import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ConnectionProxy
import io.github.openfinalshell.android.core.protocol.ProtocolJson

class ProfileRepository(private val dao: ProfileDao) {
    suspend fun list(): List<ConnectionProfile> = dao.list().map { entity ->
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
    }

    suspend fun upsert(profile: ConnectionProfile) {
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
                }
            )
        )
    }
}
