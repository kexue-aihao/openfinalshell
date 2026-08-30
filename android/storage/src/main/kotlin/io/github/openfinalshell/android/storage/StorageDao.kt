package io.github.openfinalshell.android.storage

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

@Dao
interface ProfileDao {
    @Query("SELECT * FROM profiles ORDER BY name COLLATE NOCASE")
    suspend fun list(): List<ProfileEntity>

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

    @Upsert
    suspend fun upsert(key: PrivateKeyEntity)

    @Query("DELETE FROM private_keys WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface ForwardDao {
    @Query("SELECT * FROM forwards ORDER BY label COLLATE NOCASE")
    suspend fun list(): List<ForwardEntity>

    @Upsert
    suspend fun upsert(forward: ForwardEntity)

    @Query("DELETE FROM forwards WHERE id = :id")
    suspend fun delete(id: String)
}
