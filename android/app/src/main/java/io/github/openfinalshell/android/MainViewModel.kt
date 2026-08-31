package io.github.openfinalshell.android

import android.app.Application
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.monitor.LatencyProbe
import io.github.openfinalshell.android.core.monitor.MonitorSession
import io.github.openfinalshell.android.core.monitor.MonitorState
import io.github.openfinalshell.android.core.ssh.Credentials
import io.github.openfinalshell.android.core.ssh.CredentialsResolver
import io.github.openfinalshell.android.core.ssh.MinaSshTransport
import io.github.openfinalshell.android.core.ssh.HostKeyFingerprint
import io.github.openfinalshell.android.core.ssh.SessionEvent
import io.github.openfinalshell.android.core.ssh.SessionSnapshot
import io.github.openfinalshell.android.core.ssh.ShellChannel
import io.github.openfinalshell.android.core.ssh.SftpEntry
import io.github.openfinalshell.android.core.ssh.SshSessionManager
import io.github.openfinalshell.android.core.sftp.TransferQueue
import io.github.openfinalshell.android.core.sftp.TransferSink
import io.github.openfinalshell.android.core.sftp.TransferSource
import io.github.openfinalshell.android.core.sftp.TransferTask
import java.io.File
import java.io.RandomAccessFile
import io.github.openfinalshell.android.service.ConnectionForegroundService
import io.github.openfinalshell.android.storage.AndroidCredentialStore
import io.github.openfinalshell.android.storage.AppDatabase
import io.github.openfinalshell.android.storage.ProfileRepository
import io.github.openfinalshell.android.storage.KnownHostEntity
import io.github.openfinalshell.android.storage.KnownHostRepository
import java.security.PublicKey
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class HostKeyPrompt(
    val host: String,
    val port: Int,
    val keyType: String,
    val fingerprint: String
)

data class AndroidUiState(
    val profiles: List<ConnectionProfile> = emptyList(),
    val selectedProfileId: String? = null,
    val selectedSessionId: String? = null,
    val sessions: Map<String, SessionSnapshot> = emptyMap(),
    val terminalOutput: Map<String, String> = emptyMap(),
    val monitor: MonitorState = MonitorState(),
    val sftpPath: String = "/",
    val sftpEntries: List<SftpEntry> = emptyList(),
    val transfers: List<TransferTask> = emptyList(),
    val hostKeyPrompt: HostKeyPrompt? = null,
    val status: String = "Ready"
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(AndroidUiState())
    val state: StateFlow<AndroidUiState> = mutableState.asStateFlow()
    private val database = AppDatabase.create(application)
    private val profiles = ProfileRepository(database.profiles())
    private val knownHosts = KnownHostRepository(database.knownHosts())
    private val credentialStore = AndroidCredentialStore(application, database)
    private val shells = mutableMapOf<String, ShellChannel>()
    private val shellOutputJobs = mutableMapOf<String, Job>()
    private var monitorJob: Job? = null
    private val transferQueue = TransferQueue(viewModelScope)
    @Volatile private var pendingHostKey: CompletableDeferred<Boolean>? = null

    private val sessions = SshSessionManager(
        transportFactory = { MinaSshTransport(hostKeyVerifier = io.github.openfinalshell.android.core.ssh.HostKeyVerifier { host, port, key -> verifyHostKey(host, port, key) }) },
        scope = viewModelScope,
        credentialsResolver = CredentialsResolver { profile, supplied ->
            if (supplied.password != null && profile.auth.privateKeyId == null && profile.auth.passphraseRef == null) {
                supplied
            } else {
                val stored = credentialStore.resolve(profile.auth)
                Credentials(
                    password = supplied.password ?: stored.password,
                    privateKey = supplied.privateKey ?: stored.privateKey,
                    passphrase = supplied.passphrase ?: stored.passphrase
                )
            }
        }
    )
    private val monitor = MonitorSession(sessions)

    init {
        viewModelScope.launch {
            runCatching { refreshProfiles() }
                .onFailure { setStatus(readableError(it, "Local storage unavailable")) }
        }
        viewModelScope.launch {
            sessions.sessions.collect { snapshot ->
                updateState { it.copy(sessions = snapshot) }
                val activeSessions = snapshot.values.count { it.state != SessionState.CLOSED }
                if (activeSessions > 0) {
                    ConnectionForegroundService.update(
                        getApplication(),
                        activeSessions,
                        state.value.transfers.count { task ->
                            task.state == io.github.openfinalshell.android.core.sftp.TransferState.RUNNING ||
                                task.state == io.github.openfinalshell.android.core.sftp.TransferState.QUEUED ||
                                task.state == io.github.openfinalshell.android.core.sftp.TransferState.PAUSED
                        }
                    )
                }
            }
        }
        viewModelScope.launch {
            sessions.events.collect { event ->
                when (event) {
                    is SessionEvent.StateChanged -> {
                        val label = when (event.state) {
                            SessionState.CONNECTING -> "Connecting"
                            SessionState.AUTHENTICATING -> "Authenticating"
                            SessionState.READY -> "Connected"
                            SessionState.RECONNECTING -> "Reconnecting"
                            SessionState.CLOSED -> sanitizeMessage(event.error, "Disconnected")
                        }
                        updateState { it.copy(status = label) }
                    }
                    is SessionEvent.Reconnected -> updateState { it.copy(status = "Reconnected") }
                    is SessionEvent.ShellOpened -> updateState { it.copy(status = "Terminal ready") }
                    is SessionEvent.ShellClosed -> {
                        shells.remove(event.sessionId)
                        shellOutputJobs.remove(event.sessionId)?.cancel()
                        updateState { it.copy(status = "Terminal closed") }
                    }
                }
            }
        }
        viewModelScope.launch {
            monitor.state.collect { value -> updateState { it.copy(monitor = value) } }
        }
        viewModelScope.launch {
            transferQueue.tasks.collect { tasks ->
                updateState { it.copy(transfers = tasks) }
                val activeSessions = state.value.sessions.values.count { it.state != SessionState.CLOSED }
                if (activeSessions > 0) {
                    ConnectionForegroundService.update(
                        getApplication(),
                        activeSessions,
                        tasks.count { task ->
                            task.state == io.github.openfinalshell.android.core.sftp.TransferState.RUNNING ||
                                task.state == io.github.openfinalshell.android.core.sftp.TransferState.QUEUED ||
                                task.state == io.github.openfinalshell.android.core.sftp.TransferState.PAUSED
                        }
                    )
                }
            }
        }
    }

    private suspend fun refreshProfiles() {
        val loaded = profiles.list()
        updateState { it.copy(profiles = loaded) }
    }

    fun addProfile(name: String, host: String, port: Int, username: String, password: String = "") {
        viewModelScope.launch {
            try {
                val passwordRef = password.takeIf { it.isNotEmpty() }?.let { credentialStore.put(it) }
                val profile = ConnectionProfile(
                    id = UUID.randomUUID().toString(),
                    name = name.trim(),
                    host = host.trim(),
                    port = port,
                    username = username.trim(),
                    auth = ConnectionAuth(method = "password", passwordRef = passwordRef)
                )
                profiles.upsert(profile)
                refreshProfiles()
                updateState { it.copy(selectedProfileId = profile.id, status = "Profile saved") }
            } catch (error: Throwable) {
                setStatus(readableError(error, "Profile save failed"))
            }
        }
    }

    fun selectProfile(profile: ConnectionProfile) {
        val existing = state.value.sessions.values
            .filter { it.profile.id == profile.id && it.state != SessionState.CLOSED }
            .maxByOrNull { it.sessionId }
        sessions.select(existing?.sessionId)
        updateState {
            it.copy(
                selectedProfileId = profile.id,
                selectedSessionId = existing?.sessionId,
                status = existing?.let { item ->
                    item.state.name.lowercase().replaceFirstChar { character -> character.uppercaseChar() }
                }
                    ?: it.status
            )
        }
    }

    fun connect(profile: ConnectionProfile, password: String = "") {
        viewModelScope.launch {
            try {
                monitor.stop()
                monitor.reset()
                val existing = state.value.sessions.values
                    .filter { it.profile.id == profile.id && it.state != SessionState.CLOSED }
                    .maxByOrNull { it.sessionId }
                if (existing != null) {
                    sessions.select(existing.sessionId)
                    updateState {
                        it.copy(
                            selectedProfileId = profile.id,
                            selectedSessionId = existing.sessionId,
                            status = "Connected"
                        )
                    }
                    openShell(existing.sessionId, 80, 24)
                    probeDirectLatency(profile)
                    collectStaticInfo(existing.sessionId)
                    return@launch
                }
                val sessionId = sessions.connect(
                    profile,
                    Credentials(password = password.takeIf { it.isNotEmpty() }?.toCharArray())
                )
                sessions.select(sessionId)
                updateState {
                    it.copy(
                        selectedProfileId = profile.id,
                        selectedSessionId = sessionId,
                        status = "Connected"
                    )
                }
                openShell(sessionId, 80, 24)
                probeDirectLatency(profile)
                collectStaticInfo(sessionId)
                ContextCompat.startForegroundService(
                    getApplication<Application>(),
                    Intent(getApplication(), ConnectionForegroundService::class.java).setAction(ConnectionForegroundService.ACTION_START)
                )
            } catch (error: Throwable) {
                setStatus(readableError(error, "Connection failed"))
            }
        }
    }

    fun startMonitoring(intervalSeconds: Int = 2) {
        val sessionId = state.value.selectedSessionId ?: return setStatus("Select a connected session first")
        monitorJob?.cancel()
        monitorJob = viewModelScope.launch { monitor.start(sessionId, intervalSeconds) }
    }

    private fun collectStaticInfo(sessionId: String) {
        viewModelScope.launch {
            runCatching { monitor.collectStaticInfo(sessionId) }
                .onFailure { setStatus(readableError(it, "Server information unavailable")) }
        }
    }

    fun stopMonitoring() {
        monitor.stop()
        monitorJob?.cancel()
        monitorJob = null
    }

    fun refreshPortTraffic() {
        val sessionId = state.value.selectedSessionId ?: return setStatus("Select a connected session first")
        viewModelScope.launch {
            runCatching { monitor.collectPortTraffic(sessionId) }
                .onFailure { setStatus(readableError(it, "Port traffic collection failed")) }
        }
    }

    fun browseSftp(path: String = state.value.sftpPath) {
        val sessionId = state.value.selectedSessionId ?: return setStatus("Select a connected session first")
        viewModelScope.launch {
            var channel: io.github.openfinalshell.android.core.ssh.SftpChannel? = null
            try {
                channel = sessions.openSftp(sessionId)
                val entries = channel.list(path).filterNot { it.name == "." || it.name == ".." }
                updateState { it.copy(sftpPath = path, sftpEntries = entries, status = "SFTP ready") }
            } catch (error: Throwable) {
                setStatus(readableError(error, "SFTP browse failed"))
            } finally {
                try { channel?.close() } catch (_: Throwable) { }
            }
        }
    }

    fun deleteSftp(path: String, recursive: Boolean = false) {
        val sessionId = state.value.selectedSessionId ?: return
        viewModelScope.launch {
            var channel: io.github.openfinalshell.android.core.ssh.SftpChannel? = null
            try {
                channel = sessions.openSftp(sessionId)
                channel.delete(path, recursive)
                browseSftp(state.value.sftpPath)
            } catch (error: Throwable) {
                setStatus(readableError(error, "SFTP delete failed"))
            } finally {
                try { channel?.close() } catch (_: Throwable) { }
            }
        }
    }

    /** Opens a fresh SFTP channel for the queue; the queue closes it after the operation. */
    fun uploadSftp(localPath: String, remotePath: String) {
        val sessionId = state.value.selectedSessionId ?: return setStatus("Select a connected session first")
        viewModelScope.launch {
            try {
                val file = File(localPath)
                require(file.isFile) { "local upload file does not exist" }
                transferQueue.enqueueUpload(
                    remotePath,
                    FileTransferSource(file),
                    channelProvider = { sessions.openSftp(sessionId) },
                    localPath = localPath
                )
                setStatus("Upload queued")
            } catch (error: Throwable) {
                setStatus(readableError(error, "SFTP upload failed"))
            }
        }
    }

    fun downloadSftp(remotePath: String, localPath: String, bytesTotal: Long = -1L) {
        val sessionId = state.value.selectedSessionId ?: return setStatus("Select a connected session first")
        viewModelScope.launch {
            try {
                val file = File(localPath)
                file.parentFile?.mkdirs()
                transferQueue.enqueueDownload(
                    remotePath,
                    FileTransferSink(file),
                    channelProvider = { sessions.openSftp(sessionId) },
                    bytesTotal = bytesTotal,
                    localPath = localPath
                )
                setStatus("Download queued")
            } catch (error: Throwable) {
                setStatus(readableError(error, "SFTP download failed"))
            }
        }
    }

    fun createSftpDirectory(name: String) {
        val path = resolveChild(state.value.sftpPath, name)
        mutateSftp("SFTP directory created") { channel -> channel.mkdir(path) }
    }

    fun renameSftp(from: String, name: String) {
        val target = resolveChild(parentPath(from), name)
        mutateSftp("SFTP item renamed") { channel -> channel.rename(from, target) }
    }

    fun goToSftpParent() {
        val current = state.value.sftpPath.trim().ifEmpty { "/" }
        browseSftp(parentPath(current))
    }

    fun cancelTransfer(id: String) = transferQueue.cancel(id)
    fun pauseTransfer(id: String) = transferQueue.pause(id)
    fun resumeTransfer(id: String) = transferQueue.resume(id)
    fun retryTransfer(id: String) = transferQueue.retry(id)

    fun acceptHostKey() {
        pendingHostKey?.complete(true)
    }

    fun rejectHostKey() {
        pendingHostKey?.complete(false)
    }

    private fun mutateSftp(success: String, operation: suspend (io.github.openfinalshell.android.core.ssh.SftpChannel) -> Unit) {
        val sessionId = state.value.selectedSessionId ?: return setStatus("Select a connected session first")
        viewModelScope.launch {
            var channel: io.github.openfinalshell.android.core.ssh.SftpChannel? = null
            try {
                channel = sessions.openSftp(sessionId)
                operation(channel)
                browseSftp(state.value.sftpPath)
                setStatus(success)
            } catch (error: Throwable) {
                setStatus(readableError(error, "SFTP operation failed"))
            } finally {
                runCatching { channel?.close() }
            }
        }
    }

    private fun resolveChild(directory: String, child: String): String {
        val name = child.trim()
        require(name.isNotEmpty() && name != "." && name != ".." && !name.contains('/')) { "invalid SFTP name" }
        return directory.trimEnd('/').ifEmpty { "/" }.let { if (it == "/") "/$name" else "$it/$name" }
    }

    private fun parentPath(path: String): String {
        val normalized = path.trimEnd('/').ifEmpty { "/" }
        if (normalized == "/") return "/"
        return normalized.substringBeforeLast('/').ifEmpty { "/" }
    }

    fun openShell(sessionId: String, cols: Int, rows: Int) {
        if (shells.containsKey(sessionId)) {
            resizeTerminal(sessionId, cols, rows)
            return
        }
        viewModelScope.launch {
            try {
                val shell = sessions.openShell(sessionId, cols, rows)
                shells[sessionId] = shell
                shellOutputJobs[sessionId] = launch {
                    shell.output.collect { bytes ->
                        val text = bytes.toString(Charsets.UTF_8)
                        if (text.isNotEmpty()) {
                            updateState { current ->
                                val old = current.terminalOutput[sessionId].orEmpty()
                                val next = (old + text).takeLast(MAX_TERMINAL_OUTPUT_CHARS)
                                current.copy(terminalOutput = current.terminalOutput + (sessionId to next))
                            }
                        }
                    }
                }
            } catch (error: Throwable) {
                setStatus(readableError(error, "Terminal open failed"))
            }
        }
    }

    fun sendTerminalInput(sessionId: String, data: String) {
        val shell = shells[sessionId] ?: return
        viewModelScope.launch {
            runCatching { shell.write(data.toByteArray(Charsets.UTF_8)) }
                .onFailure { setStatus(readableError(it, "Terminal write failed")) }
        }
    }

    fun resizeTerminal(sessionId: String, cols: Int, rows: Int) {
        val shell = shells[sessionId] ?: return
        viewModelScope.launch { runCatching { shell.resize(cols, rows) } }
    }

    fun clearTerminal(sessionId: String) {
        updateState { it.copy(terminalOutput = it.terminalOutput - sessionId) }
    }

    fun disconnect(sessionId: String) {
        shellOutputJobs.remove(sessionId)?.cancel()
        shells.remove(sessionId)
        viewModelScope.launch {
            sessions.disconnect(sessionId)
            if (sessions.sessions.value.values.none { it.state != SessionState.CLOSED }) {
                ConnectionForegroundService.stop(getApplication())
            }
        }
        if (state.value.selectedSessionId == sessionId) {
            updateState { it.copy(selectedSessionId = null, status = "Disconnected") }
        }
    }

    fun setStatus(status: String) {
        updateState { it.copy(status = status) }
    }

    /** Keep implementation details out of the status bar while retaining them in Logcat. */
    private fun readableError(error: Throwable, fallback: String): String {
        Log.e(TAG, fallback, error)
        val chain = generateSequence(error) { it.cause }.toList()
        if (chain.any { it is LinkageError || it is ExceptionInInitializerError }) {
            return "SSH client components could not be loaded. Reinstall the latest Android APK."
        }
        val message = chain.asSequence()
            .mapNotNull { it.message?.trim() }
            .firstOrNull { it.isNotEmpty() }
        return sanitizeMessage(message, fallback)
    }

    private fun sanitizeMessage(message: String?, fallback: String): String {
        val value = message?.trim().orEmpty()
        if (value.isEmpty()) return fallback
        // Class names and binary names are diagnostic identifiers, not user-facing errors.
        val looksLikeClassName = value.matches(Regex("[A-Za-z_][\\w]*(\\.[A-Za-z_][\\w]*)+"))
        val looksLikeBinaryName = value.contains('/') && !value.contains(' ')
        return if (looksLikeClassName || looksLikeBinaryName) fallback else value
    }

    private fun updateState(transform: (AndroidUiState) -> AndroidUiState) {
        mutableState.value = transform(mutableState.value)
    }

    override fun onCleared() {
        shellOutputJobs.values.forEach(Job::cancel)
        shells.values.forEach { shell -> viewModelScope.launch { runCatching { shell.close() } } }
        monitor.stop()
        monitorJob?.cancel()
        viewModelScope.launch { sessions.disconnect() }
        database.close()
        super.onCleared()
    }

    private fun probeDirectLatency(profile: ConnectionProfile) {
        viewModelScope.launch {
            monitor.applyDirectLatency(LatencyProbe.measure(profile.host, profile.port))
        }
    }

    /** TOFU host-key policy: first key is recorded, later changes are rejected. */
    private suspend fun verifyHostKey(host: String, port: Int, key: PublicKey): Boolean {
        val keyType = HostKeyFingerprint.keyType(key)
        val id = "$host:$port:$keyType"
        val fingerprint = HostKeyFingerprint.sha256(key)
        val previous = knownHosts.find(id)
        if (previous == null) {
            val decision = CompletableDeferred<Boolean>()
            pendingHostKey?.complete(false)
            pendingHostKey = decision
            updateState {
                it.copy(
                    hostKeyPrompt = HostKeyPrompt(host, port, keyType, fingerprint),
                    status = "Host key confirmation required"
                )
            }
            val accepted = try {
                decision.await()
            } finally {
                if (pendingHostKey === decision) pendingHostKey = null
                updateState { it.copy(hostKeyPrompt = null) }
            }
            if (!accepted) return false
            knownHosts.trust(KnownHostEntity(id, keyType, fingerprint, System.currentTimeMillis()))
        }
        return previous?.fingerprintSha256 == fingerprint || previous == null
    }

    companion object {
        private const val TAG = "OpenFinalShell"
        private const val MAX_TERMINAL_OUTPUT_CHARS = 200_000
    }
}

private class FileTransferSource(private val file: File) : TransferSource {
    override val size: Long get() = file.length()

    override suspend fun read(offset: Long, maxBytes: Int): ByteArray {
        return withContext(Dispatchers.IO) {
            require(offset >= 0 && maxBytes > 0)
            RandomAccessFile(file, "r").use { input ->
                if (offset >= input.length()) return@use ByteArray(0)
                input.seek(offset)
                val buffer = ByteArray(minOf(maxBytes.toLong(), input.length() - offset).toInt())
                var read = 0
                while (read < buffer.size) {
                    val count = input.read(buffer, read, buffer.size - read)
                    if (count < 0) break
                    read += count
                }
                if (read == buffer.size) buffer else buffer.copyOf(read)
            }
        }
    }
}

private class FileTransferSink(private val file: File) : TransferSink {
    override suspend fun reset() {
        withContext(Dispatchers.IO) {
            file.parentFile?.mkdirs()
            RandomAccessFile(file, "rw").use { it.setLength(0) }
        }
    }

    override suspend fun write(offset: Long, data: ByteArray) {
        withContext(Dispatchers.IO) {
            require(offset >= 0)
            RandomAccessFile(file, "rw").use { output ->
                output.seek(offset)
                output.write(data)
            }
        }
    }
}
