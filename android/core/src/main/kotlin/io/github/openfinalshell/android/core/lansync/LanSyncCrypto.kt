package io.github.openfinalshell.android.core.lansync

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.SCrypt

/** Crypto primitives matching the desktop pairing protocol; X25519 is supplied by the caller. */
object LanSyncCrypto {
    fun derivePairKey(code: CharArray, sharedSecret: ByteArray, salt: ByteArray, transcript: ByteArray): ByteArray {
        val prk = hmac(salt, sharedSecret)
        // Must match src/main/lansync/pairing.ts exactly.  The prefix is part of
        // the wire contract, so a spelling change makes the two clients derive
        // different pair keys even when every other input is identical.
        val info = "ofs-lansync-v1".toByteArray() + transcript
        val channelSeed = hkdfExpand(prk, info, 32)
        return SCrypt.generate(String(code).toByteArray(Charsets.UTF_8), channelSeed, 32768, 8, 1, 32)
    }

    fun confirmationMac(pairKey: ByteArray, role: String, transcript: ByteArray): ByteArray =
        hmac(pairKey, role.toByteArray(Charsets.UTF_8) + transcript)

    fun constantTimeEquals(left: ByteArray, right: ByteArray): Boolean {
        if (left.size != right.size) return false
        var diff = 0
        for (index in left.indices) diff = diff or (left[index].toInt() xor right[index].toInt())
        return diff == 0
    }

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
