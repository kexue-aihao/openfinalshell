package io.github.openfinalshell.android.core.ssh

import kotlin.test.assertTrue
import org.junit.Test

class AndroidSshdInitializerTest {
    @Test
    fun `key exchange factory selection never returns an empty list`() {
        val factories = AndroidSshdInitializer.keyExchangeFactories()

        assertTrue(factories.isNotEmpty())
        assertTrue(factories.all { it.name.isNotBlank() })
    }
}
