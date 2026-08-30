package io.github.openfinalshell.android.storage

import kotlin.test.Test
import kotlin.test.assertContentEquals
import org.junit.Assert.assertThrows

class ImportExportCryptoTest {
    @Test
    fun `round trips desktop compatible sealed block`() {
        val plain = "openfinalshell portable export".toByteArray()
        val block = ImportExportCrypto.seal(plain, "correct horse".toCharArray())
        assertContentEquals(plain, ImportExportCrypto.open(block, "correct horse".toCharArray()))
    }

    @Test
    fun `rejects wrong passphrase`() {
        val block = ImportExportCrypto.seal("secret".toByteArray(), "one".toCharArray())
        assertThrows(Exception::class.java) { ImportExportCrypto.open(block, "two".toCharArray()) }
    }
}
