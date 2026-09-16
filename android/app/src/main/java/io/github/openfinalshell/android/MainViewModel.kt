package io.github.openfinalshell.android

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ConnectionOptions
import io.github.openfinalshell.android.core.model.ConnectionProxy
import io.github.openfinalshell.android.core.model.ConnectionTerminal
import io.github.openfinalshell.android.core.model.ForwardRule
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.forward.ForwardRuntimeState
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
import io.github.openfinalshell.android.core.terminal.TerminalSnapshot
import io.github.openfinalshell.android.core.sftp.TransferQueue
import io.github.openfinalshell.android.core.sftp.TransferSink
import io.github.openfinalshell.android.core.sftp.TransferSource
import io.github.openfinalshell.android.core.sftp.TransferTask
import java.io.File
import java.io.RandomAccessFile
import io.github.openfinalshell.android.service.ConnectionForegroundService
import io.github.openfinalshell.android.terminal.SshTerminalController
import io.github.openfinalshell.android.storage.AndroidCredentialStore
import io.github.openfinalshell.android.storage.AppDatabase
import io.github.openfinalshell.android.storage.ProfileRepository
import io.github.openfinalshell.android.storage.ConnectionGroupEntity
import io.github.openfinalshell.android.storage.ConnectionGroupRepository
import io.github.openfinalshell.android.storage.PrivateKeyEntity
import io.github.openfinalshell.android.storage.PrivateKeyRepository
import io.github.openfinalshell.android.storage.SavedProxyEntity
import io.github.openfinalshell.android.storage.SavedProxyRepository
import io.github.openfinalshell.android.storage.PortableExport
import io.github.openfinalshell.android.storage.PortableImportResult
import io.github.openfinalshell.android.storage.ImportConflict
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
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import io.github.openfinalshell.android.storage.AndroidSettings
import io.github.openfinalshell.android.transfer.SafDocuments
import io.github.openfinalshell.android.transfer.SafEntry
import io.github.openfinalshell.android.transfer.PortTransferState
import io.github.openfinalshell.android.core.sftp.RemoteTextEditor
import io.github.openfinalshell.android.core.sftp.RemoteTextConflict
import io.github.openfinalshell.android.core.sftp.RemoteTextEncoding
import io.github.openfinalshell.android.core.sftp.RemoteTextEncodingFailure
import io.github.openfinalshell.android.core.sftp.RemoteTextEncodingUnavailable
import io.github.openfinalshell.android.core.sftp.SafeTar
import io.github.openfinalshell.android.core.ssh.AtomicReplaceUnavailable

data class HostKeyPrompt(
    val host: String,
    val port: Int,
    val keyType: String,
    val fingerprint: String
)

data class AndroidUiState(
    val profiles: List<ConnectionProfile> = emptyList(),
    val groups: List<ConnectionGroupEntity> = emptyList(),
    val savedProxies: List<SavedProxyEntity> = emptyList(),
    val privateKeys: List<PrivateKeyEntity> = emptyList(),
    val knownHosts: List<KnownHostEntity> = emptyList(),
    val selectedProfileId: String? = null,
    val selectedSessionId: String? = null,
    val sessions: Map<String, SessionSnapshot> = emptyMap(),
    val terminalSessionIds: Set<String> = emptySet(),
    val monitor: MonitorState = MonitorState(),
    val sftpPath: String = "/",
    val sftpEntries: List<SftpEntry> = emptyList(),
    val transfers: List<TransferTask> = emptyList(),
    val forwards: List<ForwardRule> = emptyList(),
    val forwardStates: Map<String, ForwardRuntimeState> = emptyMap(),
    val hostKeyPrompt: HostKeyPrompt? = null,
    val status: UiStatus = UiStatus()
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(AndroidUiState())
    val state: StateFlow<AndroidUiState> = mutableState.asStateFlow()
    private val database = AppDatabase.create(application)
    private val profiles = ProfileRepository(database.profiles())
    private val knownHosts = KnownHostRepository(database.knownHosts())
    private val groups = ConnectionGroupRepository(database.groups())
    private val savedProxies = SavedProxyRepository(database.proxies())
    private val credentialStore = AndroidCredentialStore(application, database)
    private val privateKeys = PrivateKeyRepository(database.privateKeys(), credentialStore)
    private val shells = mutableMapOf<String, ShellChannel>()
    private val shellOutputJobs = mutableMapOf<String, Job>()
    /** Prevent a recomposition or reconnect event from opening a second PTY for one session. */
    private val openingShells = mutableSetOf<String>()
    /** Terminal controllers keep VT parsing and rendering state out of Compose text nodes. */
    private val terminalControllers = mutableMapOf<String, SshTerminalController>()
    private var monitorJob: Job? = null
    private val transferQueue = TransferQueue(viewModelScope)
    private var transferSettings = AndroidSettings()
    private val documents = SafDocuments(application.contentResolver)
    private val mutablePortTransfer = MutableStateFlow(PortTransferState())
    val portTransfer: StateFlow<PortTransferState> = mutablePortTransfer.asStateFlow()
    private val transferSessions = mutableMapOf<String, String>()
    private val preparationJobs = mutableMapOf<String, MutableList<Job>>()
    private val archiveRetries = mutableMapOf<String, () -> Unit>()
    private val conflictMutex = Mutex()
    private var conflictDecision: CompletableDeferred<Boolean>? = null
    private var editorSessionId: String? = null
    private val forwarding = io.github.openfinalshell.android.storage.ForwardRepository(database.forwards())
    private val forwardingHandles = mutableMapOf<String, AutoCloseable>()
    private val forwardingSessions = mutableMapOf<String, String>()
    @Volatile private var pendingHostKey: CompletableDeferred<Boolean>? = null

    private val sessions = SshSessionManager(
        transportFactory = { MinaSshTransport(hostKeyVerifier = io.github.openfinalshell.android.core.ssh.HostKeyVerifier { host, port, key -> verifyHostKey(host, port, key) },
            proxyPasswordResolver = { credentialStore.getText(it) }) },
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
        },
        shouldReconnect = { profile -> profile.options.autoReconnect }
    )
    private val monitor = MonitorSession(sessions)

    init {
        viewModelScope.launch(Dispatchers.IO) {
            val staleBefore = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
            getApplication<Application>().cacheDir.listFiles()?.filter {
                it.isFile && it.name.startsWith("ofs-pack-") && it.name.endsWith(".tar") && it.lastModified() < staleBefore
            }?.forEach { it.delete() }
        }
        viewModelScope.launch {
            runCatching { refreshStorage() }
                .onFailure { setStatus(readableError(it, StatusKey.LOCAL_STORAGE_UNAVAILABLE)) }
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
                        val status = when (event.state) {
                            SessionState.CONNECTING -> UiStatus(StatusKey.CONNECTING)
                            SessionState.AUTHENTICATING -> UiStatus(StatusKey.AUTHENTICATING)
                            SessionState.READY -> UiStatus(StatusKey.CONNECTED)
                            SessionState.RECONNECTING -> UiStatus(StatusKey.RECONNECTING)
                            SessionState.CLOSED -> UiStatus(StatusKey.DISCONNECTED)
                        }
                        updateState { it.copy(status = status) }
                        when (event.state) {
                            SessionState.CLOSED -> {
                                cancelSessionTransfers(event.sessionId)
                                markForwardingsError(event.sessionId, event.error ?: "SSH session disconnected")
                            }
                            SessionState.READY -> restoreAutoForwardings(event.sessionId)
                            else -> Unit
                        }
                    }
                    is SessionEvent.Reconnected -> {
                        updateState { it.copy(status = UiStatus(StatusKey.RECONNECTED)) }
                        restoreAutoForwardings(event.sessionId)
                    }
                    is SessionEvent.ShellOpened -> updateState { it.copy(status = UiStatus(StatusKey.TERMINAL_READY)) }
                    is SessionEvent.ShellClosed -> {
                        shells.remove(event.sessionId)
                        shellOutputJobs.remove(event.sessionId)?.cancel()
                        terminalControllers.remove(event.sessionId)?.let { controller ->
                            viewModelScope.launch { controller.closeSession() }
                        }
                        updateState {
                            it.copy(
                                terminalSessionIds = it.terminalSessionIds - event.sessionId,
                                status = UiStatus(StatusKey.TERMINAL_CLOSED)
                            )
                        }
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

    private suspend fun refreshStorage() {
        val loadedProfiles = profiles.list()
        val loadedGroups = groups.list()
        val loadedProxies = savedProxies.list()
        val loadedPrivateKeys = privateKeys.list()
        val loadedKnownHosts = knownHosts.list()
        val loadedForwards = forwarding.list()
        updateState {
            it.copy(
                profiles = loadedProfiles,
                groups = loadedGroups,
                savedProxies = loadedProxies,
                privateKeys = loadedPrivateKeys,
                knownHosts = loadedKnownHosts,
                forwards = loadedForwards
            )
        }
    }

    fun saveForward(
        profileId: String,
        type: String,
        label: String,
        bindAddr: String,
        bindPort: Int,
        dstHost: String?,
        dstPort: Int?,
        autoStart: Boolean,
        id: String? = null
    ) {
        viewModelScope.launch {
            try {
                require(profileId.isNotBlank()) { "forwarding connection is required" }
                require(type.lowercase() in setOf("local", "remote", "dynamic")) { "unsupported forwarding type" }
                require(bindAddr.isNotBlank() && bindPort in 1..65535) { "invalid forwarding bind address or port" }
                if (type.lowercase() != "dynamic") {
                    require(!dstHost.isNullOrBlank() && dstPort != null && dstPort in 1..65535) {
                        "forwarding destination is required"
                    }
                }
                forwarding.upsert(
                    ForwardRule(
                        id = id ?: UUID.randomUUID().toString(),
                        profileId = profileId,
                        type = type.lowercase(),
                        label = label.trim().ifEmpty { "${type.lowercase()} $bindPort" },
                        bindAddr = bindAddr.trim(),
                        bindPort = bindPort,
                        dstHost = dstHost?.trim()?.ifEmpty { null },
                        dstPort = dstPort,
                        autoStart = autoStart
                    )
                )
                refreshStorage()
                setStatus(StatusKey.FORWARDING_RULE_SAVED)
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.FORWARDING_RULE_SAVE_FAILED))
            }
        }
    }

    fun deleteForward(rule: ForwardRule) {
        viewModelScope.launch {
            stopForward(rule.id)
            runCatching { forwarding.delete(rule.id); refreshStorage() }
                .onFailure { setStatus(readableError(it, StatusKey.FORWARDING_RULE_DELETE_FAILED)) }
        }
    }

    fun startForward(rule: ForwardRule) {
        viewModelScope.launch {
            try {
                stopForward(rule.id)
                val session = state.value.sessions.values.firstOrNull {
                    it.profile.id == rule.profileId && it.state == SessionState.READY
                } ?: error("Connect the forwarding rule's SSH profile first")
                val handle = sessions.startForwarding(session.sessionId, rule)
                forwardingHandles[rule.id] = handle
                forwardingSessions[rule.id] = session.sessionId
                updateForwardState(rule.id, ForwardRuntimeState(rule.id, "active"))
                setStatus(StatusKey.FORWARDING_STARTED)
                updateBackgroundService()
            } catch (error: Throwable) {
                updateForwardState(rule.id, ForwardRuntimeState(rule.id, "error", error = readableErrorText(error, StatusKey.FORWARDING_START_FAILED)))
                setStatus(readableError(error, StatusKey.FORWARDING_START_FAILED))
            }
        }
    }

    fun stopForward(id: String) {
        forwardingHandles.remove(id)?.let { runCatching { it.close() } }
        forwardingSessions.remove(id)
        if (state.value.forwardStates.containsKey(id)) {
            updateForwardState(id, ForwardRuntimeState(id, "stopped"))
        }
        updateBackgroundService()
    }

    fun stopAllForwards() {
        forwardingHandles.keys.toList().forEach(::stopForward)
    }

    private fun updateForwardState(id: String, value: ForwardRuntimeState) {
        updateState { it.copy(forwardStates = it.forwardStates + (id to value)) }
    }

    private fun markForwardingsError(sessionId: String, message: String) {
        forwardingSessions.filterValues { it == sessionId }.keys.toList().forEach { id ->
            forwardingHandles.remove(id)?.let { runCatching { it.close() } }
            forwardingSessions.remove(id)
            updateForwardState(id, ForwardRuntimeState(id, "error", error = message))
        }
        updateBackgroundService()
    }

    private fun restoreAutoForwardings(sessionId: String) {
        viewModelScope.launch {
            val session = state.value.sessions[sessionId] ?: return@launch
            if (session.state != SessionState.READY) return@launch
            forwarding.list().filter { it.profileId == session.profile.id && it.autoStart }.forEach { rule ->
                if (!forwardingHandles.containsKey(rule.id)) startForward(rule)
            }
        }
    }

    private fun updateBackgroundService() {
        val activeSessions = state.value.sessions.values.count { it.state != SessionState.CLOSED }
        val activeTransfers = state.value.transfers.count { task ->
            task.state == io.github.openfinalshell.android.core.sftp.TransferState.RUNNING ||
                task.state == io.github.openfinalshell.android.core.sftp.TransferState.QUEUED ||
                task.state == io.github.openfinalshell.android.core.sftp.TransferState.PAUSED
        }
        if (activeSessions > 0 || forwardingHandles.isNotEmpty() || activeTransfers > 0) {
            ConnectionForegroundService.update(getApplication(), activeSessions, activeTransfers, forwardingHandles.size)
        } else {
            ConnectionForegroundService.stop(getApplication())
        }
    }

    fun addProfile(name: String, host: String, port: Int, username: String, password: String = "") {
        saveProfile(name, host, port, username, password)
    }

    fun saveProfile(
        name: String,
        host: String,
        port: Int,
        username: String,
        password: String = "",
        profileId: String? = null,
        privateKeyId: String? = null,
        proxyId: String? = null,
        groupId: String? = null,
        note: String? = null,
        autoReconnect: Boolean = true,
        keepaliveInterval: Int = 30,
        readyTimeout: Int = 20,
        startupCommand: String? = null,
        clearPassword: Boolean = false
    ) {
        viewModelScope.launch {
            try {
                require(name.isNotBlank() && host.isNotBlank() && username.isNotBlank()) { "name, host and username are required" }
                require(port in 1..65535) { "invalid SSH port" }
                val previous = profileId?.let { profiles.find(it) }
                val oldPasswordRef = previous?.auth?.passwordRef
                val passwordRef = when {
                    password.isNotEmpty() -> credentialStore.put(password, oldPasswordRef ?: UUID.randomUUID().toString())
                    clearPassword -> null
                    else -> oldPasswordRef
                }
                if (clearPassword && oldPasswordRef != null && passwordRef == null) credentialStore.delete(oldPasswordRef)
                val profile = ConnectionProfile(
                    id = profileId ?: UUID.randomUUID().toString(),
                    name = name.trim(),
                    host = host.trim(),
                    port = port,
                    username = username.trim(),
                    auth = ConnectionAuth(
                        method = if (privateKeyId != null) "privateKey" else "password",
                        passwordRef = passwordRef,
                        privateKeyId = privateKeyId
                    ),
                    proxy = proxyId?.let { id ->
                        savedProxies.find(id)?.let { proxy ->
                            ConnectionProxy(proxy.type, proxy.host, proxy.port, proxy.username, proxy.passwordRef)
                        }
                    },
                    protocol = "ssh",
                    groupId = groupId,
                    note = note?.trim()?.ifEmpty { null },
                    terminal = ConnectionTerminal(startupCommand = startupCommand?.trim()?.ifEmpty { null }),
                    options = ConnectionOptions(
                        keepaliveInterval = keepaliveInterval.coerceIn(0, 3600),
                        readyTimeout = readyTimeout.coerceIn(1, 300),
                        autoReconnect = autoReconnect
                    ),
                    proxyMode = proxyId?.let { "custom" },
                    proxyId = proxyId
                )
                profiles.upsert(profile)
                refreshStorage()
                updateState { it.copy(selectedProfileId = profile.id, status = UiStatus(StatusKey.PROFILE_SAVED)) }
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.PROFILE_SAVE_FAILED))
            }
        }
    }

    fun deleteProfile(profile: ConnectionProfile) {
        viewModelScope.launch {
            try {
                state.value.sessions.values.filter { it.profile.id == profile.id }.forEach { sessions.disconnect(it.sessionId) }
                profiles.delete(profile.id)
                refreshStorage()
                updateState { it.copy(selectedProfileId = null, status = UiStatus(StatusKey.PROFILE_DELETED)) }
            } catch (error: Throwable) { setStatus(readableError(error, StatusKey.PROFILE_DELETE_FAILED)) }
        }
    }

    fun duplicateProfile(profile: ConnectionProfile) {
        saveProfile(
            name = "${profile.name} copy",
            host = profile.host,
            port = profile.port,
            username = profile.username,
            profileId = null,
            privateKeyId = profile.auth.privateKeyId,
            proxyId = profile.proxyId,
            groupId = profile.groupId,
            note = profile.note,
            autoReconnect = profile.options.autoReconnect,
            keepaliveInterval = profile.options.keepaliveInterval,
            readyTimeout = profile.options.readyTimeout,
            startupCommand = profile.terminal.startupCommand
        )
    }

    fun saveGroup(name: String, parentId: String? = null, order: Double = 0.0, id: String? = null) {
        viewModelScope.launch {
            runCatching { groups.save(name, parentId, order, id); refreshStorage() }
                .onFailure { setStatus(readableError(it, StatusKey.GROUP_SAVE_FAILED)) }
        }
    }

    fun deleteGroup(group: ConnectionGroupEntity) {
        viewModelScope.launch {
            runCatching {
                state.value.profiles.filter { it.groupId == group.id }.forEach { profile ->
                    profiles.upsert(profile.copy(groupId = null))
                }
                groups.delete(group.id)
                refreshStorage()
            }.onFailure { setStatus(readableError(it, StatusKey.GROUP_DELETE_FAILED)) }
        }
    }

    fun saveProxy(name: String, type: String, host: String, port: Int, username: String?, password: String, id: String? = null) {
        viewModelScope.launch {
            try {
                val old = id?.let { savedProxies.find(it) }
                val passwordRef = when {
                    password.isNotEmpty() -> credentialStore.put(password, old?.passwordRef ?: UUID.randomUUID().toString())
                    else -> old?.passwordRef
                }
                savedProxies.save(name, type, host, port, username, passwordRef, id)
                refreshStorage()
                setStatus(StatusKey.PROXY_SAVED_UNAVAILABLE)
            } catch (error: Throwable) { setStatus(readableError(error, StatusKey.PROXY_SAVE_FAILED)) }
        }
    }

    fun deleteProxy(proxy: SavedProxyEntity) {
        viewModelScope.launch {
            runCatching { savedProxies.delete(proxy.id); refreshStorage() }
                .onFailure { setStatus(readableError(it, StatusKey.PROXY_DELETE_FAILED)) }
        }
    }

    fun importPrivateKey(uri: android.net.Uri, name: String, passphrase: String = "") {
        viewModelScope.launch {
            try {
                privateKeys.saveFromUri(getApplication<Application>().contentResolver, uri, name, passphrase.takeIf { it.isNotEmpty() }?.toCharArray())
                refreshStorage()
                setStatus(StatusKey.PRIVATE_KEY_IMPORTED)
            } catch (error: Throwable) { setStatus(readableError(error, StatusKey.PRIVATE_KEY_IMPORT_FAILED)) }
        }
    }

    fun deletePrivateKey(key: PrivateKeyEntity) {
        viewModelScope.launch {
            runCatching { privateKeys.delete(key.id); refreshStorage() }
                .onFailure { setStatus(readableError(it, StatusKey.PRIVATE_KEY_DELETE_FAILED)) }
        }
    }

    fun revokeKnownHost(key: String) {
        viewModelScope.launch {
            runCatching { knownHosts.remove(key); refreshStorage(); setStatus(StatusKey.HOST_TRUST_REVOKED) }
                .onFailure { setStatus(readableError(it, StatusKey.HOST_TRUST_REVOKE_FAILED)) }
        }
    }

    fun exportPortable(uri: android.net.Uri, passphrase: String, includeSecrets: Boolean = true, encryptAll: Boolean = true) {
        viewModelScope.launch {
            try {
                require(!encryptAll || passphrase.length >= 8) { "export passphrase must be at least 8 characters" }
                val text = if (encryptAll) {
                    PortableExport.buildV2FromStorage(profiles, io.github.openfinalshell.android.storage.ForwardRepository(database.forwards()), groups, savedProxies, privateKeys, knownHosts, credentialStore, passphrase.toCharArray(), includeSecrets, tools = database.tools())
                } else {
                    PortableExport.buildV1FromStorage(profiles, io.github.openfinalshell.android.storage.ForwardRepository(database.forwards()), groups, savedProxies, privateKeys, knownHosts, credentialStore, includeSecrets, passphrase.takeIf { it.isNotEmpty() }?.toCharArray(), tools = database.tools())
                }
                getApplication<Application>().contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    ?: error("unable to create export file")
                setStatus(StatusKey.EXPORT_COMPLETED)
            } catch (error: Throwable) { setStatus(readableError(error, StatusKey.EXPORT_FAILED)) }
        }
    }

    fun importPortable(uri: android.net.Uri, passphrase: String, conflict: ImportConflict = ImportConflict.SKIP) {
        viewModelScope.launch {
            try {
                val resolver = getApplication<Application>().contentResolver
                val text = resolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: error("unable to read import file")
                val result = PortableExport.importInto(
                    PortableExport.parse(text), passphrase.takeIf { it.isNotEmpty() }?.toCharArray(), profiles,
                    io.github.openfinalshell.android.storage.ForwardRepository(database.forwards()), groups, savedProxies,
                    privateKeys, knownHosts, credentialStore, conflict, tools = database.tools()
                )
                refreshStorage()
                setStatus(StatusKey.IMPORT_COMPLETED, result.profiles, result.groups, result.proxies, result.notes.size)
            } catch (error: Throwable) { setStatus(readableError(error, StatusKey.IMPORT_FAILED)) }
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
                    status = existing?.let { item -> sessionStatus(item.state) }
                    ?: it.status
            )
        }
    }

    fun connect(profile: ConnectionProfile, password: String = "") {
        viewModelScope.launch {
            try {
                val effectiveProfile = when {
                    profile.proxyMode == "direct" || profile.proxyMode == "none" -> profile.copy(proxy = null, proxyId = null)
                    profile.proxyId != null -> {
                        val saved = requireNotNull(savedProxies.find(requireNotNull(profile.proxyId)))
                        profile.copy(proxy = ConnectionProxy(saved.type, saved.host, saved.port, saved.username, saved.passwordRef))
                    }
                    else -> profile
                }
                if (profile.proxyMode == "custom") require(effectiveProfile.proxy?.type in setOf("http", "socks5"))
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
                            status = UiStatus(StatusKey.CONNECTED)
                        )
                    }
                    openShell(existing.sessionId, 80, 24)
                    probeDirectLatency(profile)
                    collectStaticInfo(existing.sessionId)
                    return@launch
                }
                val sessionId = sessions.connect(
                    effectiveProfile,
                    Credentials(password = password.takeIf { it.isNotEmpty() }?.toCharArray())
                )
                sessions.select(sessionId)
                updateState {
                    it.copy(
                        selectedProfileId = profile.id,
                        selectedSessionId = sessionId,
                        status = UiStatus(StatusKey.CONNECTED)
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
                setStatus(readableError(error, StatusKey.CONNECTION_FAILED))
            }
        }
    }

    fun startMonitoring(intervalSeconds: Int = 2) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
        monitorJob?.cancel()
        monitorJob = viewModelScope.launch { monitor.start(sessionId, intervalSeconds) }
    }

    private fun collectStaticInfo(sessionId: String) {
        viewModelScope.launch {
            runCatching { monitor.collectStaticInfo(sessionId) }
                .onFailure { setStatus(readableError(it, StatusKey.SERVER_INFO_UNAVAILABLE)) }
        }
    }

    fun stopMonitoring() {
        monitor.stop()
        monitorJob?.cancel()
        monitorJob = null
    }

    fun refreshPortTraffic() {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
        viewModelScope.launch {
            runCatching { monitor.collectPortTraffic(sessionId) }
                .onFailure { setStatus(readableError(it, StatusKey.PORT_TRAFFIC_FAILED)) }
        }
    }

    fun browseSftp(path: String = state.value.sftpPath) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
        viewModelScope.launch {
            var channel: io.github.openfinalshell.android.core.ssh.SftpChannel? = null
            try {
                channel = sessions.openSftp(sessionId)
                val entries = channel.list(path).filterNot { it.name == "." || it.name == ".." || (!transferSettings.sftpShowHiddenFiles && it.name.startsWith('.')) }
                updateState { it.copy(sftpPath = path, sftpEntries = entries, status = UiStatus(StatusKey.SFTP_READY)) }
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.SFTP_BROWSE_FAILED))
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
                setStatus(readableError(error, StatusKey.SFTP_DELETE_FAILED))
            } finally {
                try { channel?.close() } catch (_: Throwable) { }
            }
        }
    }

    fun applyTransferSettings(settings: AndroidSettings) {
        val refresh = transferSettings.sftpShowHiddenFiles != settings.sftpShowHiddenFiles
        transferSettings = settings
        transferQueue.setConcurrency(settings.sftpConcurrency)
        if (refresh && state.value.selectedSessionId != null) browseSftp()
    }

    fun clearTransferMessage() { mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = null) }
    fun dismissEditorConflict() { mutablePortTransfer.value = mutablePortTransfer.value.copy(editorConflict = false) }

    fun configuredDownloadTree(): Uri? = transferSettings.downloadDirectoryUri?.let(Uri::parse)

    fun setTransferDownloadTree(uri: Uri): Boolean = try {
        getApplication<Application>().contentResolver.takePersistableUriPermission(uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        transferSettings = transferSettings.copy(downloadDirectoryUri = uri.toString())
        true
    } catch (_: Exception) {
        mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_permission_lost)
        false
    }

    fun resolveTransferConflict(overwrite: Boolean) { conflictDecision?.complete(overwrite) }

    private suspend fun shouldOverwrite(path: String): Boolean = when (transferSettings.sftpConflictPolicy) {
        "overwrite" -> true
        "skip" -> false
        else -> conflictMutex.withLock {
            val decision = CompletableDeferred<Boolean>()
            conflictDecision = decision
            mutablePortTransfer.value = mutablePortTransfer.value.copy(conflictPath = path)
            try { decision.await() } finally {
                conflictDecision = null
                mutablePortTransfer.value = mutablePortTransfer.value.copy(conflictPath = null)
            }
        }
    }

    private fun transferPreparation(sessionId: String, block: suspend () -> Unit) {
        val job = viewModelScope.launch {
            try { block() }
            catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
            catch (_: SecurityException) { mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = false, messageRes = R.string.port_permission_lost) }
            catch (_: Exception) { mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = false, messageRes = R.string.port_operation_failed) }
        }
        preparationJobs.getOrPut(sessionId) { mutableListOf() }.apply { removeAll { it.isCompleted }; add(job) }
    }

    private fun cancelSessionTransfers(sessionId: String) {
        preparationJobs.remove(sessionId)?.forEach(Job::cancel)
        transferSessions.filterValues { it == sessionId }.keys.toList().forEach { transferQueue.cancel(it); transferSessions.remove(it); archiveRetries.remove(it) }
        if (editorSessionId == sessionId) {
            editorSessionId = null
            mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = false, messageRes = R.string.port_session_closed)
        }
    }

    fun uploadDocuments(uris: List<Uri>, directory: Boolean = false) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
        val remoteDirectory = state.value.sftpPath
        transferPreparation(sessionId) {
            val channel = sessions.openSftp(sessionId)
            var count = 0
            suspend fun upload(entry: SafEntry, parent: String, depth: Int) {
                check(++count <= 10_000 && depth <= 64)
                val target = resolveChild(parent, SafDocuments.safeName(entry.name))
                val existing = channel.list(parent).firstOrNull { it.name == entry.name }
                if (entry.directory) {
                    check(existing == null || existing.type == SftpEntry.Type.DIRECTORY)
                    if (existing == null) channel.mkdir(target)
                    for (child in withContext(Dispatchers.IO) { documents.children(entry.uri) }) upload(child, target, depth + 1)
                } else {
                    check(existing == null || existing.type == SftpEntry.Type.FILE)
                    if (existing != null && !shouldOverwrite(target)) return
                    val source = withContext(Dispatchers.IO) { documents.source(entry) }
                    val id = transferQueue.enqueueUpload(target, source, channelProvider = { sessions.openSftp(sessionId) }, localPath = entry.uri.toString())
                    transferSessions[id] = sessionId
                }
            }
            try {
                for (uri in uris) {
                    val actual = if (directory) documents.root(uri) else uri
                    val entry = withContext(Dispatchers.IO) { documents.info(actual) }
                    upload(entry, remoteDirectory, 0)
                }
                setStatus(StatusKey.UPLOAD_QUEUED)
            } finally { channel.close() }
        }
    }

    fun downloadDocument(remotePath: String, treeUri: Uri? = null) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
        val tree = treeUri ?: transferSettings.downloadDirectoryUri?.let(Uri::parse)
        if (tree == null) { mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_choose_download); return }
        transferPreparation(sessionId) {
            val channel = sessions.openSftp(sessionId)
            var count = 0
            suspend fun download(entry: SftpEntry, parent: Uri, depth: Int) {
                check(++count <= 10_000 && depth <= 64)
                if (entry.type != SftpEntry.Type.FILE && entry.type != SftpEntry.Type.DIRECTORY) return
                SafDocuments.safeName(entry.name)
                val existing = withContext(Dispatchers.IO) { documents.children(parent).firstOrNull { it.name == entry.name } }
                val isDirectory = entry.type == SftpEntry.Type.DIRECTORY
                check(existing == null || existing.directory == isDirectory)
                if (!isDirectory && existing != null && !shouldOverwrite(entry.name)) return
                val destination = existing?.uri ?: withContext(Dispatchers.IO) { documents.create(parent, entry.name, isDirectory) }
                if (isDirectory) {
                    for (child in channel.list(entry.path).filterNot { it.name == "." || it.name == ".." }) download(child, destination, depth + 1)
                } else {
                    val sink = withContext(Dispatchers.IO) { documents.sink(destination) }
                    val id = transferQueue.enqueueDownload(entry.path, sink, channelProvider = { sessions.openSftp(sessionId) },
                        bytesTotal = entry.size ?: -1, localPath = destination.toString())
                    transferSessions[id] = sessionId
                }
            }
            try {
                val entry = channel.list(parentPath(remotePath)).first { it.path == remotePath }
                download(entry, documents.root(tree), 0)
                setStatus(StatusKey.DOWNLOAD_QUEUED)
            } finally { channel.close() }
        }
    }

    private suspend fun execTransfer(sessionId: String, command: String): String = kotlinx.coroutines.withTimeout(120_000L) {
        val channel = sessions.openExec(sessionId, command)
        try {
            val output = StringBuilder()
            channel.output.collect { bytes -> check(output.length + bytes.size <= 16 * 1024); output.append(bytes.toString(Charsets.UTF_8)) }
            check(channel.exitCode.value == 0)
            output.toString().trim()
        } finally { channel.close() }
    }

    /** Pack a SAF directory without following links; existing remote roots use normal conflict-aware SFTP. */
    fun uploadPackedDirectory(tree: Uri) {
        val sessionId = state.value.selectedSessionId ?: return
        val remoteDirectory = state.value.sftpPath
        transferPreparation(sessionId) {
            var remoteTemp: String? = null
            val cache = withContext(Dispatchers.IO) { File.createTempFile("ofs-pack-", ".tar", getApplication<Application>().cacheDir) }
            var queued = false
            suspend fun cleanup() = withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                cache.delete()
                remoteTemp?.let { path -> runCatching {
                    val channel = sessions.openSftp(sessionId)
                    try { channel.delete(path, recursive = true) } finally { channel.close() }
                } }
            }
            try {
                val root = withContext(Dispatchers.IO) { documents.info(documents.root(tree)) }
                require(root.directory)
                val entries = mutableListOf<Pair<String, SafEntry>>()
                var bytesTotal = 1024L
                suspend fun enumerate(path: String, entry: SafEntry, depth: Int) {
                    require(depth < 64 && entries.size < 10_000)
                    SafeTar.header(path, entry.size.coerceAtLeast(0), entry.directory)
                    if (!entry.directory) require(entry.size >= 0)
                    entries += path to entry
                    bytesTotal += 512 + (if (entry.directory) 0 else ((entry.size + 511) / 512) * 512)
                    require(bytesTotal <= 32L * 1024 * 1024 * 1024)
                    if (entry.directory) for (child in withContext(Dispatchers.IO) { documents.children(entry.uri) }) enumerate("$path/${child.name}", child, depth + 1)
                }
                enumerate(root.name, root, 0)
                require(cache.parentFile!!.usableSpace > bytesTotal + 64L * 1024 * 1024)
                val checkChannel = sessions.openSftp(sessionId)
                try { require(checkChannel.list(remoteDirectory).none { it.name == root.name }) }
                finally { checkChannel.close() }
                check(execTransfer(sessionId, "command -v tar >/dev/null && command -v mktemp >/dev/null && printf OFS_OK") == "OFS_OK")
                val freeKb = execTransfer(sessionId, "df -Pk ${SafeTar.quote(remoteDirectory)} | awk 'NR==2 {print \$4}'").toLong()
                require(freeKb * 1024 > bytesTotal * 2 + 64L * 1024 * 1024)
                val temp = execTransfer(sessionId, "mktemp -d ${SafeTar.quote(resolveChild(remoteDirectory, ".ofs-pack-XXXXXXXX"))}")
                require(parentPath(temp) == remoteDirectory.trimEnd('/').ifEmpty { "/" } && temp.substringAfterLast('/').startsWith(".ofs-pack-"))
                remoteTemp = temp
                withContext(Dispatchers.IO) {
                    cache.outputStream().buffered().use { output ->
                        for ((path, entry) in entries) {
                            kotlinx.coroutines.currentCoroutineContext().ensureActive()
                            output.write(SafeTar.header(path, entry.size.coerceAtLeast(0), entry.directory))
                            if (!entry.directory) {
                                val source = documents.source(entry)
                                try {
                                    var offset = 0L
                                    while (offset < entry.size) {
                                        val data = source.read(offset, minOf(32 * 1024L, entry.size - offset).toInt())
                                        require(data.isNotEmpty())
                                        output.write(data); offset += data.size
                                    }
                                    output.write(ByteArray(((512 - entry.size % 512) % 512).toInt()))
                                } finally { source.close() }
                            }
                        }
                        output.write(ByteArray(1024))
                    }
                    SafeTar.entries(cache)
                }
                val source = object : TransferSource {
                    private val file = FileTransferSource(cache)
                    override val size = cache.length()
                    override suspend fun read(offset: Long, maxBytes: Int) = file.read(offset, maxBytes)
                    override suspend fun abort() { cleanup() }
                    override suspend fun complete() {
                        try {
                            execTransfer(sessionId, "mkdir ${SafeTar.quote("$temp/payload")} && tar -xf ${SafeTar.quote("$temp/files.tar")} -C ${SafeTar.quote("$temp/payload")}")
                            val channel = sessions.openSftp(sessionId)
                            try {
                                require(channel.list(remoteDirectory).none { it.name == root.name })
                                channel.rename("$temp/payload/${root.name}", resolveChild(remoteDirectory, root.name))
                            } finally { channel.close() }
                        } finally { cleanup() }
                    }
                }
                val id = transferQueue.enqueueUpload("$temp/files.tar", source, channelProvider = { sessions.openSftp(sessionId) }, localPath = tree.toString())
                transferSessions[id] = sessionId
                archiveRetries[id] = { if (state.value.selectedSessionId == sessionId) uploadPackedDirectory(tree) }
                queued = true
            } catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
            catch (_: Exception) { mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_pack_fallback) }
            finally { if (!queued) cleanup() }
        }
    }

    /** Transfer the archive through the same retryable queue, validate it fully, then materialize SAF files. */
    fun downloadPackedDirectory(remotePath: String) {
        val sessionId = state.value.selectedSessionId ?: return
        val tree = configuredDownloadTree() ?: run {
            mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_choose_download); return
        }
        transferPreparation(sessionId) {
            var remoteTemp: String? = null
            val cache = withContext(Dispatchers.IO) { File.createTempFile("ofs-pack-", ".tar", getApplication<Application>().cacheDir) }
            var queued = false
            suspend fun cleanup() = withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                cache.delete()
                remoteTemp?.let { path -> runCatching {
                    val channel = sessions.openSftp(sessionId)
                    try { channel.delete(path, recursive = true) } finally { channel.close() }
                } }
            }
            suspend fun exec(command: String): String = kotlinx.coroutines.withTimeout(120_000L) {
                val channel = sessions.openExec(sessionId, command)
                try {
                    val output = StringBuilder()
                    channel.output.collect { bytes -> check(output.length + bytes.size <= 16 * 1024); output.append(bytes.toString(Charsets.UTF_8)) }
                    check(channel.exitCode.value == 0)
                    output.toString().trim()
                } finally { channel.close() }
            }
            try {
                require(remotePath.startsWith('/') && remotePath != "/")
                val channel = sessions.openSftp(sessionId)
                var size = 1024L
                var count = 0
                suspend fun inspect(path: String, depth: Int) {
                    require(depth <= 64)
                    for (entry in channel.list(path).filterNot { it.name == "." || it.name == ".." }) {
                        require(++count <= 10_000 && entry.type in setOf(SftpEntry.Type.FILE, SftpEntry.Type.DIRECTORY))
                        SafeTar.safePath(entry.name)
                        size += (((entry.size ?: 0) + 511) / 512) * 512 + 512
                        require(size in 0..(32L * 1024 * 1024 * 1024))
                        if (entry.type == SftpEntry.Type.DIRECTORY) inspect(entry.path, depth + 1)
                    }
                }
                try { inspect(remotePath, 0) } finally { channel.close() }
                check(cache.parentFile!!.usableSpace > size + 64L * 1024 * 1024)
                check(exec("command -v tar >/dev/null && command -v mktemp >/dev/null && printf OFS_OK") == "OFS_OK")
                val freeKb = exec("df -Pk /tmp | awk 'NR==2 {print \$4}'").toLong()
                check(freeKb * 1024 > size + 64L * 1024 * 1024)
                val directory = exec("mktemp -d /tmp/ofs-pack.XXXXXXXX")
                check(Regex("^/tmp/ofs-pack\\.[A-Za-z0-9]+$").matches(directory))
                remoteTemp = directory
                val archive = "$directory/files.tar"
                exec("tar --format=ustar -cf ${SafeTar.quote(archive)} -C ${SafeTar.quote(parentPath(remotePath))} -- ${SafeTar.quote(remotePath.substringAfterLast('/'))}")
                val metadata = sessions.openSftp(sessionId)
                val archiveSize = try { metadata.list(directory).first { it.name == "files.tar" }.size!! } finally { metadata.close() }
                require(archiveSize <= cache.parentFile!!.usableSpace - 64L * 1024 * 1024)
                val fileSink = FileTransferSink(cache)
                val sink = object : TransferSink {
                    override suspend fun reset() = fileSink.reset()
                    override suspend fun write(offset: Long, data: ByteArray) = fileSink.write(offset, data)
                    override suspend fun abort() { fileSink.abort(); cleanup() }
                    override suspend fun complete(totalBytes: Long) {
                        fileSink.complete(totalBytes)
                        val entries = withContext(Dispatchers.IO) { SafeTar.entries(cache) }
                        val directories = mutableMapOf("" to documents.root(tree))
                        try {
                            for (entry in entries.sortedWith(compareBy({ it.path.count { c -> c == '/' } }, { !it.directory }))) {
                                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                                val parent = directories[entry.path.substringBeforeLast('/', "")] ?: error("archive parent is absent")
                                val name = entry.path.substringAfterLast('/')
                                val previous = withContext(Dispatchers.IO) { documents.children(parent).firstOrNull { it.name == name } }
                                require(previous == null || previous.directory == entry.directory)
                                if (!entry.directory && previous != null && !shouldOverwrite(entry.path)) continue
                                val uri = previous?.uri ?: withContext(Dispatchers.IO) { documents.create(parent, name, entry.directory) }
                                if (entry.directory) directories[entry.path] = uri else {
                                    val destination = withContext(Dispatchers.IO) { documents.sink(uri) }
                                    try {
                                        destination.reset()
                                        var offset = 0L
                                        while (offset < entry.size) {
                                            val data = withContext(Dispatchers.IO) {
                                                RandomAccessFile(cache, "r").use { input -> input.seek(entry.offset + offset)
                                                    ByteArray(minOf(32 * 1024L, entry.size - offset).toInt()).also(input::readFully) }
                                            }
                                            destination.write(offset, data)
                                            offset += data.size
                                        }
                                        destination.complete(entry.size)
                                    } catch (error: Throwable) { destination.abort(); throw error }
                                }
                            }
                        } finally { cleanup() }
                    }
                }
                val id = transferQueue.enqueueDownload(archive, sink, channelProvider = { sessions.openSftp(sessionId) }, bytesTotal = archiveSize, localPath = tree.toString())
                transferSessions[id] = sessionId
                archiveRetries[id] = { if (state.value.selectedSessionId == sessionId) downloadPackedDirectory(remotePath) }
                queued = true
            } catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
            catch (_: Exception) { mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_pack_fallback) }
            finally { if (!queued) cleanup() }
        }
    }

    fun chooseRemoteEditorEncoding(id: String) {
        val encoding = RemoteTextEncoding.entries.firstOrNull { it.id == id }
        if (encoding == null || !RemoteTextEditor.isEncodingAvailable(encoding)) {
            mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_encoding_unavailable)
            return
        }
        mutablePortTransfer.value = mutablePortTransfer.value.copy(editorEncoding = id)
    }

    fun openRemoteEditor(path: String, encoding: String = mutablePortTransfer.value.editorEncoding) {
        if (mutablePortTransfer.value.editorBusy) return
        val sessionId = state.value.selectedSessionId ?: return
        editorSessionId = sessionId
        mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = true, editorConflict = false, messageRes = null)
        transferPreparation(sessionId) {
            val channel = sessions.openSftp(sessionId)
            try {
                val document = RemoteTextEditor.load(channel, path, encoding)
                if (editorSessionId == sessionId) mutablePortTransfer.value = mutablePortTransfer.value.copy(editor = document, editorText = document.text)
            } catch (_: RemoteTextEncodingUnavailable) {
                mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_encoding_unavailable)
            } catch (_: RemoteTextEncodingFailure) {
                mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_encoding_lossless)
            } finally { channel.close(); mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = false) }
        }
    }

    fun editRemoteText(text: String) { mutablePortTransfer.value = mutablePortTransfer.value.copy(editorText = text) }

    fun closeRemoteEditor() {
        if (mutablePortTransfer.value.editorBusy) return
        editorSessionId = null
        mutablePortTransfer.value = mutablePortTransfer.value.copy(editor = null, nonAtomicConfirmation = false, editorConflict = false)
    }

    fun cancelNonAtomicSave() { mutablePortTransfer.value = mutablePortTransfer.value.copy(nonAtomicConfirmation = false) }

    fun saveRemoteEditor(nonAtomic: Boolean = false) {
        val sessionId = editorSessionId ?: return
        val original = mutablePortTransfer.value.editor ?: return
        if (mutablePortTransfer.value.editorBusy) return
        val text = mutablePortTransfer.value.editorText
        mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = true, nonAtomicConfirmation = false)
        transferPreparation(sessionId) {
            val channel = sessions.openSftp(sessionId)
            try {
                val saved = RemoteTextEditor.save(channel, original, text, nonAtomic)
                if (editorSessionId == sessionId) mutablePortTransfer.value = mutablePortTransfer.value.copy(editor = saved, editorText = saved.text, editorConflict = false, messageRes = R.string.port_saved)
            } catch (_: RemoteTextEncodingUnavailable) {
                mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_encoding_unavailable)
            } catch (_: RemoteTextEncodingFailure) {
                mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_encoding_lossless)
            } catch (_: AtomicReplaceUnavailable) {
                mutablePortTransfer.value = mutablePortTransfer.value.copy(nonAtomicConfirmation = true)
            } catch (_: RemoteTextConflict) {
                mutablePortTransfer.value = mutablePortTransfer.value.copy(editorConflict = true)
            } finally { channel.close(); mutablePortTransfer.value = mutablePortTransfer.value.copy(editorBusy = false) }
        }
    }

    /** Opens a fresh SFTP channel for the queue; the queue closes it after the operation. */
    fun uploadSftp(localPath: String, remotePath: String) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
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
                setStatus(StatusKey.UPLOAD_QUEUED)
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.SFTP_UPLOAD_FAILED))
            }
        }
    }

    fun downloadSftp(remotePath: String, localPath: String, bytesTotal: Long = -1L) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
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
                setStatus(StatusKey.DOWNLOAD_QUEUED)
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.SFTP_DOWNLOAD_FAILED))
            }
        }
    }

    fun createSftpDirectory(name: String) {
        val path = resolveChild(state.value.sftpPath, name)
        mutateSftp(StatusKey.SFTP_DIRECTORY_CREATED) { channel -> channel.mkdir(path) }
    }

    fun renameSftp(from: String, name: String) {
        val target = resolveChild(parentPath(from), name)
        mutateSftp(StatusKey.SFTP_ITEM_RENAMED) { channel -> channel.rename(from, target) }
    }

    fun goToSftpParent() {
        val current = state.value.sftpPath.trim().ifEmpty { "/" }
        browseSftp(parentPath(current))
    }

    fun cancelTransfer(id: String) = transferQueue.cancel(id)
    fun pauseTransfer(id: String) = transferQueue.pause(id)
    fun resumeTransfer(id: String) = transferQueue.resume(id)
    fun retryTransfer(id: String) { archiveRetries[id]?.invoke() ?: transferQueue.retry(id) }

    fun acceptHostKey() {
        pendingHostKey?.complete(true)
    }

    fun rejectHostKey() {
        pendingHostKey?.complete(false)
    }

    private fun mutateSftp(success: StatusKey, operation: suspend (io.github.openfinalshell.android.core.ssh.SftpChannel) -> Unit) {
        val sessionId = state.value.selectedSessionId ?: return setStatus(StatusKey.SESSION_REQUIRED)
        viewModelScope.launch {
            var channel: io.github.openfinalshell.android.core.ssh.SftpChannel? = null
            try {
                channel = sessions.openSftp(sessionId)
                operation(channel)
                browseSftp(state.value.sftpPath)
                setStatus(success)
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.SFTP_OPERATION_FAILED))
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
        if (!openingShells.add(sessionId)) return
        viewModelScope.launch {
            try {
                val shell = sessions.openShell(sessionId, cols, rows)
                shells[sessionId] = shell
                val controller = SshTerminalController(
                    inputScope = viewModelScope,
                    inputSink = { bytes -> shell.write(bytes) },
                    initialCols = cols.coerceAtLeast(1),
                    initialRows = rows.coerceAtLeast(1)
                )
                terminalControllers[sessionId] = controller
                updateState { current ->
                    current.copy(terminalSessionIds = current.terminalSessionIds + sessionId)
                }
                shellOutputJobs[sessionId] = launch {
                    shell.output.collect { bytes ->
                        controller.write(bytes)
                    }
                }
            } catch (error: Throwable) {
                setStatus(readableError(error, StatusKey.TERMINAL_OPEN_FAILED))
            } finally {
                openingShells.remove(sessionId)
            }
        }
    }

    /** Writes user input and terminal protocol replies to the SSH shell without text round-tripping. */
    fun sendTerminalInput(sessionId: String, data: ByteArray) {
        val controller = terminalControllers[sessionId]
        viewModelScope.launch {
            runCatching {
                if (controller != null) controller.sendInput(data)
                else shells[sessionId]?.write(data)
            }
                .onFailure { setStatus(readableError(it, StatusKey.TERMINAL_WRITE_FAILED)) }
        }
    }

    fun sendTerminalInput(sessionId: String, data: String) =
        sendTerminalInput(sessionId, data.toByteArray(Charsets.UTF_8))

    fun insertAssistantCommand(sessionId: String, text: String) {
        if (state.value.sessions[sessionId]?.state != SessionState.READY) return setStatus(StatusKey.SESSION_REQUIRED)
        // Filling a command must never inject Enter, ESC, DEL or other terminal controls.
        val command = text.trimEnd('\r', '\n')
        if (command.length > 32_768 || command.any { it.code < 32 || it.code in 127..159 }) {
            mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_command_single_line)
            return
        }
        sendTerminalInput(sessionId, command)
    }

    /** Only the separate, explicit Execute action can submit Enter. */
    fun executeAssistantCommand(sessionId: String, text: String, onSubmitted: () -> Unit) {
        if (state.value.sessions[sessionId]?.state != SessionState.READY) return setStatus(StatusKey.SESSION_REQUIRED)
        val command = text.trimEnd('\r', '\n')
        if (command.isBlank() || command.length > 32_768 || command.any { it.code < 32 || it.code in 127..159 }) {
            mutablePortTransfer.value = mutablePortTransfer.value.copy(messageRes = R.string.port_command_single_line)
            return
        }
        val controller = terminalControllers[sessionId] ?: return setStatus(StatusKey.SESSION_REQUIRED)
        viewModelScope.launch {
            try {
                if (terminalControllers[sessionId] !== controller || state.value.sessions[sessionId]?.state != SessionState.READY) return@launch
                controller.sendInput((command + "\r").toByteArray(Charsets.UTF_8))
                onSubmitted()
            } catch (error: Exception) { setStatus(readableError(error, StatusKey.TERMINAL_WRITE_FAILED)) }
        }
    }

    /** Snapshot stream for a native terminal view; the SSH channel remains private to the VM. */
    fun terminalSnapshot(sessionId: String): StateFlow<TerminalSnapshot>? =
        terminalControllers[sessionId]?.snapshot

    fun terminalController(sessionId: String): SshTerminalController? = terminalControllers[sessionId]

    fun resizeTerminal(sessionId: String, cols: Int, rows: Int) {
        val shell = shells[sessionId] ?: return
        val controller = terminalControllers[sessionId]
        viewModelScope.launch {
            runCatching {
                controller?.resize(cols.coerceAtLeast(1), rows.coerceAtLeast(1))
                shell.resize(cols.coerceAtLeast(1), rows.coerceAtLeast(1))
            }
        }
    }

    fun clearTerminal(sessionId: String) {
        terminalControllers[sessionId]?.clearScreen()
    }

    fun disconnect(sessionId: String) {
        cancelSessionTransfers(sessionId)
        openingShells.remove(sessionId)
        forwardingSessions.filterValues { it == sessionId }.keys.toList().forEach(::stopForward)
        shellOutputJobs.remove(sessionId)?.cancel()
        terminalControllers.remove(sessionId)?.let { controller ->
            viewModelScope.launch { controller.closeSession() }
        }
        shells.remove(sessionId)
        viewModelScope.launch {
            sessions.disconnect(sessionId)
            if (sessions.sessions.value.values.none { it.state != SessionState.CLOSED }) {
                ConnectionForegroundService.stop(getApplication())
            }
        }
        if (state.value.selectedSessionId == sessionId) {
            updateState {
                it.copy(
                    selectedSessionId = null,
                    terminalSessionIds = it.terminalSessionIds - sessionId,
                    status = UiStatus(StatusKey.DISCONNECTED)
                )
            }
        } else {
            updateState { it.copy(terminalSessionIds = it.terminalSessionIds - sessionId) }
        }
    }

    fun setStatus(status: UiStatus) {
        updateState { it.copy(status = status) }
    }

    private fun setStatus(key: StatusKey, vararg args: Any) {
        setStatus(UiStatus(key, args.toList()))
    }

    /** Keep implementation details out of the status bar while retaining them in Logcat. */
    private fun readableError(error: Throwable, fallback: StatusKey): UiStatus {
        Log.e(TAG, fallback.name, error)
        val chain = generateSequence(error) { it.cause }.toList()
        if (chain.any { it is LinkageError || it is ExceptionInInitializerError }) {
            return UiStatus(StatusKey.SSH_COMPONENTS_UNAVAILABLE)
        }
        return UiStatus(fallback)
    }

    private fun readableErrorText(error: Throwable, fallback: StatusKey): String {
        val status = readableError(error, fallback)
        val context = getApplication<Application>()
        return context.getString(status.key.resourceId, *status.args.toTypedArray())
    }

    private fun sessionStatus(state: SessionState): UiStatus = UiStatus(
        when (state) {
            SessionState.CONNECTING -> StatusKey.CONNECTING
            SessionState.AUTHENTICATING -> StatusKey.AUTHENTICATING
            SessionState.READY -> StatusKey.CONNECTED
            SessionState.RECONNECTING -> StatusKey.RECONNECTING
            SessionState.CLOSED -> StatusKey.DISCONNECTED
        }
    )

    private fun updateState(transform: (AndroidUiState) -> AndroidUiState) {
        mutableState.value = transform(mutableState.value)
    }

    override fun onCleared() {
        transferQueue.cancelAll()
        conflictDecision?.complete(false)
        forwardingHandles.values.forEach { runCatching { it.close() } }
        forwardingHandles.clear()
        forwardingSessions.clear()
        shellOutputJobs.values.forEach(Job::cancel)
        terminalControllers.values.forEach { it.disposeView() }
        terminalControllers.clear()
        shells.values.forEach { shell -> viewModelScope.launch { runCatching { shell.close() } } }
        monitor.stop()
        monitorJob?.cancel()
        viewModelScope.launch { sessions.disconnect() }
        database.close()
        super.onCleared()
    }

    private fun probeDirectLatency(profile: ConnectionProfile) {
        if (profile.proxy?.type?.let { it != "none" } == true || profile.proxyId != null) return
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
                    status = UiStatus(StatusKey.HOST_KEY_CONFIRMATION_REQUIRED)
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
