package io.github.openfinalshell.android.storage

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.generators.SCrypt

@Serializable
data class SealedBlock(
    val kdf: String = "scrypt",
    val n: Int = 32768,
    val salt: String,
    val iv: String,
    val tag: String,
    val cipher: String
)

/** Compatible with exportData.ts v1/v2: scrypt(N=2^15,r=8,p=1)+AES-256-GCM. */
object ImportExportCrypto {
    private const val KEY_LENGTH = 32
    private const val SALT_LENGTH = 16
    private const val IV_LENGTH = 12
    private const val SCRYPT_R = 8
    private const val SCRYPT_P = 1

    fun seal(plaintext: ByteArray, passphrase: CharArray): SealedBlock {
        val salt = ByteArray(SALT_LENGTH).also(SecureRandom()::nextBytes)
        val key = derive(passphrase, salt, 32768)
        val iv = ByteArray(IV_LENGTH).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext)
        val tagLength = 16
        val body = encrypted.copyOfRange(0, encrypted.size - tagLength)
        val tag = encrypted.copyOfRange(encrypted.size - tagLength, encrypted.size)
        return SealedBlock(
            salt = Base64.getEncoder().encodeToString(salt),
            iv = Base64.getEncoder().encodeToString(iv),
            tag = Base64.getEncoder().encodeToString(tag),
            cipher = Base64.getEncoder().encodeToString(body)
        )
    }

    fun open(block: SealedBlock, passphrase: CharArray): ByteArray {
        require(block.kdf == "scrypt") { "unsupported export KDF" }
        val salt = Base64.getDecoder().decode(block.salt)
        val iv = Base64.getDecoder().decode(block.iv)
        val body = Base64.getDecoder().decode(block.cipher)
        val tag = Base64.getDecoder().decode(block.tag)
        require(iv.size == IV_LENGTH && tag.size == 16) { "invalid sealed block" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(derive(passphrase, salt, block.n), "AES"),
            GCMParameterSpec(128, iv)
        )
        return cipher.doFinal(body + tag)
    }

    private fun derive(passphrase: CharArray, salt: ByteArray, n: Int): ByteArray {
        require(n == 32768) { "unsupported scrypt cost" }
        return SCrypt.generate(String(passphrase).toByteArray(Charsets.UTF_8), salt, n, SCRYPT_R, SCRYPT_P, KEY_LENGTH)
    }
}
