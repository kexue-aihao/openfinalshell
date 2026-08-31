package io.github.openfinalshell.android.storage

import androidx.room.Entity
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable

@Serializable
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
    val proxyJson: String?,
    /** Serialized profile payload for forward-compatible fields. */
    val profileJson: String? = null,
    val protocol: String = "ssh",
    val groupId: String? = null,
    val color: String? = null,
    val flag: String? = null,
    val terminalJson: String? = null,
    val optionsJson: String? = null,
    val proxyMode: String? = null,
    val proxyId: String? = null,
    val jumpHostId: String? = null,
    val note: String? = null,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
    val lastUsedAt: Long? = null
)

@Serializable
@Entity(tableName = "secrets")
data class SecretEntity(
    @PrimaryKey val id: String,
    val iv: ByteArray,
    val ciphertext: ByteArray,
    val createdAt: Long
)

@Serializable
@Entity(tableName = "private_keys")
data class PrivateKeyEntity(
    @PrimaryKey val id: String,
    val name: String,
    val originalPath: String?,
    val sha256: String,
    val passphraseRef: String?,
    val materialRef: String?,
    val createdAt: Long,
    val updatedAt: Long = 0L
)

@Serializable
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

@Serializable
@Entity(tableName = "connection_groups")
data class ConnectionGroupEntity(
    @PrimaryKey val id: String,
    val name: String,
    val parentId: String? = null,
    val sortOrder: Double = 0.0
)

@Serializable
@Entity(tableName = "saved_proxies")
data class SavedProxyEntity(
    @PrimaryKey val id: String,
    val name: String,
    val type: String,
    val host: String,
    val port: Int,
    val username: String? = null,
    val passwordRef: String? = null,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L
)

@Serializable
@Entity(tableName = "known_hosts")
data class KnownHostEntity(
    @PrimaryKey val key: String,
    val keyType: String,
    val fingerprintSha256: String,
    val addedAt: Long
)

@Serializable
@Entity(tableName = "documents")
data class DocumentEntity(
    @PrimaryKey val name: String,
    val json: String
)
