package io.github.openfinalshell.android.core.ssh

import kotlin.test.assertTrue
import org.apache.sshd.common.util.security.SecurityUtils
import org.junit.Test

class AndroidSshdInitializerTest {
    @Test
    fun `key exchange factory selection never returns an empty list`() {
        val factories = AndroidSshdInitializer.keyExchangeFactories()

        assertTrue(factories.isNotEmpty())
        assertTrue(factories.all { it.name.isNotBlank() })
    }

    @Test
    fun `MINA uses a provider that exposes SHA-256`() {
        AndroidSshdInitializer.keyExchangeFactories()

        assertTrue(SecurityUtils.getAPrioriDisabledProviders().contains(SecurityUtils.BOUNCY_CASTLE))
        val digest = SecurityUtils.getMessageDigest("SHA-256")
        assertTrue(digest.digest(ByteArray(0)).isNotEmpty())
    }
}
