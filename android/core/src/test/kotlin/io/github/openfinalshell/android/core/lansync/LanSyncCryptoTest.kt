package io.github.openfinalshell.android.core.lansync

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertTrue

class LanSyncCryptoTest {
    @Test
    fun `same pairing inputs derive same key and proof`() {
        val secret = ByteArray(32) { it.toByte() }
        val salt = ByteArray(16) { (it + 1).toByte() }
        val transcript = "openfinalshell".toByteArray()
        val first = LanSyncCrypto.derivePairKey("123456".toCharArray(), secret, salt, transcript)
        val second = LanSyncCrypto.derivePairKey("123456".toCharArray(), secret, salt, transcript)
        assertContentEquals(first, second)
        assertTrue(LanSyncCrypto.constantTimeEquals(first, second))
    }
}
