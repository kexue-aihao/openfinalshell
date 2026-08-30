package io.github.openfinalshell.android.core.lansync

import java.util.Arrays
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.SCrypt

/** Crypto primitives matching the desktop pairing protocol; X25519 is supplied by the caller. */
object LanSyncCrypto {
    fun derivePairKey(code: CharArray, sharedSecret: ByteArray, salt: ByteArray, transcript: ByteArray): ByteArray {
        val prk = hmac(salt, sharedSecret)
        val info = "openfinalshell/lansync/v1".toByteArray() + transcript
        val channelSeed = hkdfExpand(prk, info, 32)
        return SCrypt.generate(String(code).toByteArray(Charsets.UTF_8), channelSeed, 32768, 8, 1, 32)
    }

    fun confirmationMac(pairKey: ByteArray, role: String, transcript: ByteArray): ByteArray =
        hmac(pairKey, role.toByteArray(Charsets.UTF_8) + byteArrayOf(0) + transcript)

    fun constantTimeEquals(left: ByteArray, right: ByteArray): Boolean = Arrays.equals(left, right)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    private fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            previous = hmac(prk, previous + info + byteArrayOf(counter.toByte()))
            val copied = minOf(previous.size, length - offset)
            previous.copyInto(output, offset, 0, copied)
            offset += copied
            counter++
        }
        return output
    }
}
