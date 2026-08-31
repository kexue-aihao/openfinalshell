package io.github.openfinalshell.android.storage

import android.content.ContentResolver
import android.net.Uri
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

/** Owns private-key metadata and keeps key material behind AndroidCredentialStore. */
class PrivateKeyRepository(
    private val dao: PrivateKeyDao,
    private val credentials: AndroidCredentialStore
) {
    suspend fun list(): List<PrivateKeyEntity> = dao.list()
    suspend fun find(id: String): PrivateKeyEntity? = dao.find(id)
    suspend fun upsert(key: PrivateKeyEntity) = dao.upsert(key)

    suspend fun save(
        name: String,
        material: ByteArray,
        path: String? = null,
        passphrase: CharArray? = null,
        id: String? = null
    ): PrivateKeyEntity {
        require(material.isNotEmpty()) { "private key is empty" }
        val now = System.currentTimeMillis()
        val previous = id?.let { dao.find(it) }
        val materialRef = credentials.putBytes(material, previous?.materialRef ?: UUID.randomUUID().toString())
        val passphraseRef = when {
            passphrase == null -> previous?.passphraseRef
            passphrase.isEmpty() -> null
            else -> credentials.putText(passphrase, previous?.passphraseRef ?: UUID.randomUUID().toString())
        }
        if (passphrase?.isEmpty() == true) previous?.passphraseRef?.let { credentials.delete(it) }
        if (previous?.materialRef != null && previous.materialRef != materialRef) credentials.delete(previous.materialRef)
        return PrivateKeyEntity(
            id = previous?.id ?: id ?: UUID.randomUUID().toString(),
            name = name.trim(),
            originalPath = path?.trim()?.ifEmpty { null },
            sha256 = sha256(material),
            passphraseRef = passphraseRef,
            materialRef = materialRef,
            createdAt = previous?.createdAt?.takeIf { it > 0 } ?: now,
            updatedAt = now
        ).also { dao.upsert(it) }
    }

    /** Imports key material through the Storage Access Framework instead of relying on file paths. */
    suspend fun saveFromUri(
        resolver: ContentResolver,
        uri: Uri,
        name: String,
        passphrase: CharArray? = null,
        id: String? = null
    ): PrivateKeyEntity {
        val material = resolver.openInputStream(uri)?.use { input ->
            val bytes = input.readBytes()
            if (bytes.size > MAX_KEY_BYTES) throw IOException("private key is too large")
            bytes
        } ?: throw IOException("unable to open private key")
        return save(name, material, uri.toString(), passphrase, id)
    }

    suspend fun material(id: String): ByteArray? = dao.find(id)?.materialRef?.let { credentials.getBytes(it) }

    suspend fun delete(id: String): Boolean {
        val key = dao.find(id) ?: return false
        dao.delete(id)
        key.materialRef?.let { credentials.delete(it) }
        key.passphraseRef?.let { credentials.delete(it) }
        return true
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private companion object { const val MAX_KEY_BYTES = 4 * 1024 * 1024 }
}
