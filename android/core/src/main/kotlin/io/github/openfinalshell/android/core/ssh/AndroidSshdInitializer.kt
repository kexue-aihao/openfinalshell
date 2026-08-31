package io.github.openfinalshell.android.core.ssh

import java.nio.file.Path
import org.apache.sshd.common.util.io.PathUtils

/**
 * Supplies Apache MINA SSHD with an Android-compatible user home directory.
 *
 * SSHD resolves its default host configuration and key locations while
 * initializing ClientBuilder. Android does not expose a conventional
 * java.home/user.home directory, so this must be configured before the first
 * SshClient is created.
 */
object AndroidSshdInitializer {
    private val lock = Any()

    @Volatile
    private var configured = false

    /** Configure SSHD once for the current Android application process. */
    fun configure(userHome: Path) {
        require(userHome.toString().isNotBlank()) { "SSH user home path must not be blank" }
        if (configured) return

        synchronized(lock) {
            if (configured) return
            PathUtils.setUserHomeFolderResolver { userHome }
            configured = true
        }
    }
}
