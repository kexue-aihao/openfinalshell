package io.github.openfinalshell.android.core.ssh

import android.util.Log
import java.nio.file.Path
import java.security.Security
import org.apache.sshd.client.ClientBuilder
import org.apache.sshd.common.kex.BuiltinDHFactories
import org.apache.sshd.common.kex.KeyExchangeFactory
import org.apache.sshd.common.util.io.PathUtils
import org.apache.sshd.common.util.security.SecurityUtils
import org.bouncycastle.jce.provider.BouncyCastleProvider

/**
 * Supplies Apache MINA SSHD with an Android-compatible user home directory.
 *
 * SSHD resolves its default host configuration and key locations while
 * initializing ClientBuilder. Android does not expose a conventional
 * java.home/user.home directory, so this must be configured before the first
 * SshClient is created.
 */
object AndroidSshdInitializer {
    private const val TAG = "AndroidSshdInitializer"
    private val lock = Any()

    // These factories use the JCA DH/EC primitives available on Android API 26+.
    // Curve25519 is probed first because newer Android/BC providers support it.
    private val portableKexFactories = listOf(
        BuiltinDHFactories.curve25519,
        BuiltinDHFactories.ecdhp256,
        BuiltinDHFactories.ecdhp384,
        BuiltinDHFactories.ecdhp521,
        BuiltinDHFactories.dhg14_256,
        BuiltinDHFactories.dhg14
    )

    @Volatile
    private var configured = false

    /** Configure SSHD once for the current Android application process. */
    fun configure(userHome: Path) {
        require(userHome.toString().isNotBlank()) { "SSH user home path must not be blank" }
        if (configured) return

        synchronized(lock) {
            if (configured) return
            PathUtils.setUserHomeFolderResolver { userHome }
            registerSecurityProviderLocked()
            configured = true
        }
    }

    /**
     * Returns KEX factories that are usable by the Android runtime.
     *
     * MINA's default setup filters factories using JCA capability probes. On some Android
     * provider combinations those probes return an empty list even though the underlying
     * DH/EC implementation is usable. The explicit fallback keeps the client configurable
     * and verifies each factory can be constructed before exposing it to SSHD.
     */
    fun keyExchangeFactories(): List<KeyExchangeFactory> {
        synchronized(lock) { registerSecurityProviderLocked() }

        val detected = runCatching { ClientBuilder.setUpDefaultKeyExchanges(true) }
            .onFailure { Log.w(TAG, "MINA default KEX detection failed; using portable fallback", it) }
            .getOrNull()
            .orEmpty()
        if (detected.isNotEmpty()) return detected

        val fallback = portableKexFactories.mapNotNull { factory ->
            runCatching {
                // Constructing the DH implementation exercises the provider lookups used by
                // the actual handshake (KeyAgreement, KeyPairGenerator and digest selection).
                factory.create()
                ClientBuilder.DH2KEX.apply(factory)
            }.onFailure {
                Log.w(TAG, "Android KEX unavailable: ${factory.name}", it)
            }.getOrNull()
        }
        check(fallback.isNotEmpty()) {
            "No Android-compatible SSH key exchange factory is available"
        }
        return fallback
    }

    private fun registerSecurityProviderLocked() {
        // Android vendors may ship a provider named "BC" that is not compatible with
        // the algorithms MINA probes (for example SHA-256 on some Xiaomi builds). Keep
        // MINA on the platform JCA providers instead of selecting that provider by name.
        // This must happen before the first SecurityUtils registration call.
        SecurityUtils.setAPrioriDisabledProvider(SecurityUtils.BOUNCY_CASTLE, true)

        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
            runCatching { Security.addProvider(BouncyCastleProvider()) }
                .onFailure { Log.w(TAG, "Unable to register Bouncy Castle provider", it) }
        }

        // Trigger MINA's registrar after the provider is visible. It will keep an existing
        // Android provider and select BC only when it is actually usable.
        runCatching { SecurityUtils.isBouncyCastleRegistered() }
            .onFailure { Log.w(TAG, "MINA security provider registration failed", it) }
    }
}
