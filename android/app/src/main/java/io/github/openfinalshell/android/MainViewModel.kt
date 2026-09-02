package io.github.openfinalshell.android

import android.app.Application
import android.content.Intent
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
    private val forwarding = io.github.openfinalshell.android.storage.ForwardRepository(database.forwards())
    private val forwardingHandles = mutableMapOf<String, AutoCloseable>()
    private val forwardingSessions = mutableMapOf<String, String>()
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
        },
        shouldReconnect = { profile -> profile.options.autoReconnect }
    )
    private val monitor = MonitorSession(sessions)

    init {
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
                            SessionState.CLOSED -> markForwardingsError(event.sessionId, event.error ?: "SSH session disconnected")
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
                    PortableExport.buildV2FromStorage(profiles, io.github.openfinalshell.android.storage.ForwardRepository(database.forwards()), groups, savedProxies, privateKeys, knownHosts, credentialStore, passphrase.toCharArray(), includeSecrets)
                } else {
                    PortableExport.buildV1FromStorage(profiles, io.github.openfinalshell.android.storage.ForwardRepository(database.forwards()), groups, savedProxies, privateKeys, knownHosts, credentialStore, includeSecrets, passphrase.takeIf { it.isNotEmpty() }?.toCharArray())
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
                    privateKeys, knownHosts, credentialStore, conflict
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
                if (profile.proxy != null || profile.proxyId != null || profile.proxyMode == "custom") {
                    setStatus(StatusKey.PROXY_UNAVAILABLE)
                    return@launch
                }
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
                    profile,
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
                val entries = channel.list(path).filterNot { it.name == "." || it.name == ".." }
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
    fun retryTransfer(id: String) = transferQueue.retry(id)

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
