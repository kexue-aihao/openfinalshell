package io.github.openfinalshell.android.storage

import java.util.UUID

class ConnectionGroupRepository(private val dao: ConnectionGroupDao) {
    suspend fun list(): List<ConnectionGroupEntity> = dao.list()
    suspend fun find(id: String): ConnectionGroupEntity? = dao.find(id)
    suspend fun upsert(group: ConnectionGroupEntity) = dao.upsert(group)
    suspend fun delete(id: String) = dao.delete(id)
}

class SavedProxyRepository(private val dao: SavedProxyDao) {
    suspend fun list(): List<SavedProxyEntity> = dao.list()
    suspend fun find(id: String): SavedProxyEntity? = dao.find(id)
    suspend fun upsert(proxy: SavedProxyEntity) = dao.upsert(proxy)
    suspend fun delete(id: String) = dao.delete(id)

    suspend fun save(
        name: String,
        type: String,
        host: String,
        port: Int,
        username: String? = null,
        passwordRef: String? = null,
        id: String? = null
    ): SavedProxyEntity {
        val now = System.currentTimeMillis()
        val previous = id?.let { dao.find(it) }
        return SavedProxyEntity(
            id = previous?.id ?: id ?: UUID.randomUUID().toString(),
            name = name.trim(),
            type = type,
            host = host.trim(),
            port = port,
            username = username?.trim()?.ifEmpty { null },
            passwordRef = passwordRef,
            createdAt = previous?.createdAt?.takeIf { it > 0 } ?: now,
            updatedAt = now
        ).also { dao.upsert(it) }
    }
}

class KnownHostRepository(private val dao: KnownHostDao) {
    suspend fun list(): List<KnownHostEntity> = dao.list()
    suspend fun find(key: String): KnownHostEntity? = dao.find(key)
    suspend fun trust(host: KnownHostEntity) = dao.upsert(host)
    suspend fun remove(key: String) = dao.delete(key)
}

class DocumentRepository(private val dao: DocumentDao) {
    suspend fun get(name: String): String? = dao.find(name)?.json
    suspend fun put(name: String, json: String) = dao.upsert(DocumentEntity(name, json))
    suspend fun delete(name: String) = dao.delete(name)
}
