package io.github.openfinalshell.android.core.ssh

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface SshTransport {
    val state: StateFlow<SessionState>
    suspend fun connect(profile: ConnectionProfile, credentials: Credentials)
    suspend fun openShell(cols: Int, rows: Int): ShellChannel
    suspend fun openSftp(): SftpChannel
    suspend fun disconnect()
}

data class Credentials(
    val password: CharArray? = null,
    val privateKey: ByteArray? = null,
    val passphrase: CharArray? = null
)

interface ShellChannel {
    val output: Flow<ByteArray>
    suspend fun write(data: ByteArray)
    suspend fun resize(cols: Int, rows: Int)
    suspend fun close()
}

interface SftpChannel {
    suspend fun list(path: String): List<SftpEntry>
    suspend fun read(path: String): ByteArray
    suspend fun write(path: String, data: ByteArray)
    suspend fun writeChunk(path: String, data: ByteArray, offset: Long, truncate: Boolean = false) {
        require(offset == 0L) { "the transport does not support ranged writes" }
        write(path, data)
    }
    suspend fun delete(path: String, recursive: Boolean = false)
    suspend fun close()
}

data class SftpEntry(val name: String, val path: String, val type: Type, val size: Long? = null) {
    enum class Type { FILE, DIRECTORY, SYMLINK, OTHER }
}
