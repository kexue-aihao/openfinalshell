package io.github.openfinalshell.android.storage

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "profiles")
data class ProfileEntity(
    @PrimaryKey val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val username: String,
    val authMethod: String,
    val passwordRef: String?,
    val privateKeyId: String?,
    val passphraseRef: String?,
    val proxyJson: String?
)

@Entity(tableName = "secrets")
data class SecretEntity(
    @PrimaryKey val id: String,
    val iv: ByteArray,
    val ciphertext: ByteArray,
    val createdAt: Long
)

@Entity(tableName = "private_keys")
data class PrivateKeyEntity(
    @PrimaryKey val id: String,
    val name: String,
    val originalPath: String?,
    val sha256: String,
    val passphraseRef: String?,
    val materialRef: String?,
    val createdAt: Long
)

@Entity(tableName = "forwards")
data class ForwardEntity(
    @PrimaryKey val id: String,
    val profileId: String,
    val type: String,
    val label: String,
    val bindAddr: String,
    val bindPort: Int,
    val dstHost: String?,
    val dstPort: Int?,
    val autoStart: Boolean
)
