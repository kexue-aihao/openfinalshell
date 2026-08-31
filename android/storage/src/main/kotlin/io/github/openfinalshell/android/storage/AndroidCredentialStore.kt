package io.github.openfinalshell.android.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.ssh.Credentials
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Keystore-backed secret storage. DPAPI/safeStorage ciphertext is intentionally not accepted. */
class AndroidCredentialStore(context: Context, database: AppDatabase? = null) {
    private val database = database ?: AppDatabase.create(context.applicationContext)
    private val keyAlias = "openfinalshell.credentials.v1"

    suspend fun put(value: CharSequence, id: String = UUID.randomUUID().toString()): String = withContext(Dispatchers.IO) {
        val (iv, ciphertext) = seal(value.toString().toByteArray(Charsets.UTF_8))
        database.secrets().upsert(
            SecretEntity(id, iv, ciphertext, System.currentTimeMillis())
        )
        id
    }

    suspend fun putText(value: CharArray, id: String = UUID.randomUUID().toString()): String =
        put(String(value), id)

    suspend fun putBytes(value: ByteArray, id: String = UUID.randomUUID().toString()): String = withContext(Dispatchers.IO) {
        val (iv, ciphertext) = seal(value)
        database.secrets().upsert(SecretEntity(id, iv, ciphertext, System.currentTimeMillis()))
        id
    }

    suspend fun get(id: String): String? = withContext(Dispatchers.IO) {
        val row = database.secrets().find(id) ?: return@withContext null
        open(row).toString(Charsets.UTF_8)
    }

    suspend fun getText(id: String): CharArray? = get(id)?.toCharArray()

    suspend fun getBytes(id: String): ByteArray? = withContext(Dispatchers.IO) {
        database.secrets().find(id)?.let(::open)
    }

    suspend fun delete(id: String) = withContext(Dispatchers.IO) { database.secrets().delete(id) }

    /** Resolve only references; callers never need to copy secret fields into a profile. */
    suspend fun resolve(auth: ConnectionAuth): Credentials = withContext(Dispatchers.IO) {
        val password = auth.passwordRef?.let { getText(it) }
        val privateKeyRecord = auth.privateKeyId?.let { keyId ->
            database.privateKeys().find(keyId)
                ?: throw CredentialResolutionException("private key reference not found: $keyId")
        }
        val passphrase = (privateKeyRecord?.passphraseRef ?: auth.passphraseRef)?.let { getText(it) }
        val privateKey = privateKeyRecord?.let { key ->
            key.materialRef?.let { getBytes(it) }
                ?: throw CredentialResolutionException("private key material is not managed: ${auth.privateKeyId}")
        }
        Credentials(password = password, privateKey = privateKey, passphrase = passphrase)
    }

    private fun seal(value: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv to cipher.doFinal(value)
    }

    private fun open(row: SecretEntity): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), javax.crypto.spec.GCMParameterSpec(128, row.iv))
        return cipher.doFinal(row.ciphertext)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(false)
                    .build()
            )
        }.generateKey()
    }
}

class CredentialResolutionException(message: String) : IllegalStateException(message)
