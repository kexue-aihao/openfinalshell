package io.github.openfinalshell.android.storage

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

@Dao
interface ProfileDao {
    @Query("SELECT * FROM profiles ORDER BY COALESCE(groupId, ''), name COLLATE NOCASE")
    suspend fun list(): List<ProfileEntity>

    @Query("SELECT * FROM profiles WHERE id = :id LIMIT 1")
    suspend fun find(id: String): ProfileEntity?

    @Upsert
    suspend fun upsert(profile: ProfileEntity)

    @Query("DELETE FROM profiles WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface SecretDao {
    @Query("SELECT * FROM secrets WHERE id = :id LIMIT 1")
    suspend fun find(id: String): SecretEntity?

    @Upsert
    suspend fun upsert(secret: SecretEntity)

    @Query("DELETE FROM secrets WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface PrivateKeyDao {
    @Query("SELECT * FROM private_keys ORDER BY name COLLATE NOCASE")
    suspend fun list(): List<PrivateKeyEntity>

    @Query("SELECT * FROM private_keys WHERE id = :id LIMIT 1")
    suspend fun find(id: String): PrivateKeyEntity?

    @Query("SELECT * FROM private_keys WHERE sha256 = :sha256 LIMIT 1")
    suspend fun findBySha256(sha256: String): PrivateKeyEntity?

    @Upsert
    suspend fun upsert(key: PrivateKeyEntity)

    @Query("DELETE FROM private_keys WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface ForwardDao {
    @Query("SELECT * FROM forwards ORDER BY label COLLATE NOCASE")
    suspend fun list(): List<ForwardEntity>

    @Query("SELECT * FROM forwards WHERE id = :id LIMIT 1")
    suspend fun find(id: String): ForwardEntity?

    @Upsert
    suspend fun upsert(forward: ForwardEntity)

    @Query("DELETE FROM forwards WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface ConnectionGroupDao {
    @Query("SELECT * FROM connection_groups ORDER BY sortOrder, name COLLATE NOCASE")
    suspend fun list(): List<ConnectionGroupEntity>

    @Query("SELECT * FROM connection_groups WHERE id = :id LIMIT 1")
    suspend fun find(id: String): ConnectionGroupEntity?

    @Upsert
    suspend fun upsert(group: ConnectionGroupEntity)

    @Query("DELETE FROM connection_groups WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface SavedProxyDao {
    @Query("SELECT * FROM saved_proxies ORDER BY name COLLATE NOCASE")
    suspend fun list(): List<SavedProxyEntity>

    @Query("SELECT * FROM saved_proxies WHERE id = :id LIMIT 1")
    suspend fun find(id: String): SavedProxyEntity?

    @Upsert
    suspend fun upsert(proxy: SavedProxyEntity)

    @Query("DELETE FROM saved_proxies WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface KnownHostDao {
    @Query("SELECT * FROM known_hosts ORDER BY key COLLATE NOCASE")
    suspend fun list(): List<KnownHostEntity>

    @Query("SELECT * FROM known_hosts WHERE key = :key LIMIT 1")
    suspend fun find(key: String): KnownHostEntity?

    @Upsert
    suspend fun upsert(host: KnownHostEntity)

    @Query("DELETE FROM known_hosts WHERE key = :key")
    suspend fun delete(key: String)
}

@Dao
interface DocumentDao {
    @Query("SELECT * FROM documents WHERE name = :name LIMIT 1")
    suspend fun find(name: String): DocumentEntity?

    @Upsert
    suspend fun upsert(document: DocumentEntity)

    @Query("DELETE FROM documents WHERE name = :name")
    suspend fun delete(name: String)
}
