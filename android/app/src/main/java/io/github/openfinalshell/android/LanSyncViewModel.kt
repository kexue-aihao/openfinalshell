package io.github.openfinalshell.android

import android.app.Application
import android.net.wifi.WifiManager
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.openfinalshell.android.core.lansync.LanSyncApplyResult
import io.github.openfinalshell.android.core.lansync.LanSyncCoordinator
import io.github.openfinalshell.android.core.lansync.LanSyncPeer
import io.github.openfinalshell.android.core.lansync.LanSyncReceiverInfo
import io.github.openfinalshell.android.storage.AndroidCredentialStore
import io.github.openfinalshell.android.storage.AppDatabase
import io.github.openfinalshell.android.storage.ConnectionGroupRepository
import io.github.openfinalshell.android.storage.ForwardRepository
import io.github.openfinalshell.android.storage.KnownHostRepository
import io.github.openfinalshell.android.storage.PortableExport
import io.github.openfinalshell.android.storage.PrivateKeyRepository
import io.github.openfinalshell.android.storage.ProfileRepository
import io.github.openfinalshell.android.storage.SavedProxyRepository
import io.github.openfinalshell.android.storage.ImportConflict
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class LanSyncUiState(
    val phase: String = "idle",
    val peers: List<LanSyncPeer> = emptyList(),
    val receiver: LanSyncReceiverInfo? = null,
    val selectedPeer: LanSyncPeer? = null,
    val lastResult: LanSyncApplyResult? = null,
    val message: UiStatus? = null
)

/** Owns Android LAN Sync lifecycle while keeping the wire protocol in the core module. */
class LanSyncViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(LanSyncUiState())
    val state: StateFlow<LanSyncUiState> = mutableState.asStateFlow()
    private val database = AppDatabase.create(application)
    private val credentials = AndroidCredentialStore(application, database)
    private val profiles = ProfileRepository(database.profiles())
    private val forwards = ForwardRepository(database.forwards())
    private val groups = ConnectionGroupRepository(database.groups())
    private val proxies = SavedProxyRepository(database.proxies())
    private val privateKeys = PrivateKeyRepository(database.privateKeys(), credentials)
    private val knownHosts = KnownHostRepository(database.knownHosts())
    private val coordinator = LanSyncCoordinator(viewModelScope)
    private var receiverMulticastLock: WifiManager.MulticastLock? = null
    private var pendingDecision: CompletableDeferred<Boolean>? = null
    private val deviceId: String by lazy {
        application.getSharedPreferences(PREFS, Application.MODE_PRIVATE)
            .getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() }
            ?: UUID.randomUUID().toString().also {
                application.getSharedPreferences(PREFS, Application.MODE_PRIVATE)
                    .edit().putString(KEY_DEVICE_ID, it).apply()
            }
    }
    private val deviceName: String by lazy { android.os.Build.MODEL?.ifBlank { "Android" } ?: "Android" }

    fun selectPeer(peer: LanSyncPeer?) {
        mutableState.value = mutableState.value.copy(selectedPeer = peer)
    }

    fun scan() {
        viewModelScope.launch {
            mutableState.value = mutableState.value.copy(phase = "scanning", message = null)
            try {
                val result = withMulticastLock { coordinator.scan(deviceId, deviceName) }
                mutableState.value = mutableState.value.copy(
                    phase = "idle",
                    peers = result,
                    message = UiStatus(StatusKey.SYNC_DEVICES_FOUND, listOf(result.size))
                )
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(phase = "error", message = syncError(error, StatusKey.SYNC_DEVICE_SCAN_FAILED))
            }
        }
    }

    fun startReceiver() {
        if (state.value.receiver != null) return
        viewModelScope.launch {
            try {
                mutableState.value = mutableState.value.copy(phase = "starting", message = null)
                val lock = acquireReceiverMulticastLock()
                receiverMulticastLock = lock
                val info = try {
                    coordinator.startReceiver(deviceId, deviceName, BuildConfig.VERSION_NAME) { envelope, passphrase ->
                        awaitImportConfirmation(envelope, passphrase)
                    }
                } catch (error: Throwable) {
                    releaseReceiverMulticastLock()
                    throw error
                }
                mutableState.value = mutableState.value.copy(phase = "waiting", receiver = info, message = UiStatus(StatusKey.SYNC_RECEIVER_READY))
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(phase = "idle", message = syncError(error, StatusKey.SYNC_RECEIVER_START_FAILED))
            }
        }
    }

    fun stopReceiver() {
        pendingDecision?.complete(false)
        pendingDecision = null
        coordinator.stopReceiver()
        releaseReceiverMulticastLock()
        mutableState.value = mutableState.value.copy(phase = "idle", receiver = null, message = UiStatus(StatusKey.SYNC_RECEIVER_STOPPED))
    }

    fun send(peer: LanSyncPeer, pairingCode: String) {
        val code = pairingCode.trim()
        if (!code.matches(Regex("\\d{6}"))) {
            mutableState.value = mutableState.value.copy(message = UiStatus(StatusKey.SYNC_PAIRING_CODE_INVALID))
            return
        }
        viewModelScope.launch {
            try {
                mutableState.value = mutableState.value.copy(phase = "sending", selectedPeer = peer, lastResult = null, message = null)
                val result = withMulticastLock {
                    coordinator.send(peer, deviceId, deviceName, BuildConfig.VERSION_NAME, code.toCharArray()) { channelPassphrase ->
                        PortableExport.buildV2FromStorage(
                            profiles, forwards, groups, proxies, privateKeys, knownHosts, credentials,
                            passphrase = channelPassphrase, includeSecrets = true, appVersion = BuildConfig.VERSION_NAME
                        )
                    }
                }
                mutableState.value = mutableState.value.copy(phase = "applied", lastResult = result, message = UiStatus(StatusKey.SYNC_DELIVERED))
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(phase = "error", message = syncError(error, StatusKey.SYNC_FAILED))
            }
        }
    }

    fun acceptIncoming() {
        pendingDecision?.complete(true)
    }

    fun rejectIncoming() {
        pendingDecision?.complete(false)
    }

    private suspend fun awaitImportConfirmation(envelope: String, channelPassphrase: CharArray): LanSyncApplyResult {
        val decision = CompletableDeferred<Boolean>()
        pendingDecision?.complete(false)
        pendingDecision = decision
        mutableState.value = mutableState.value.copy(phase = "incoming", message = UiStatus(StatusKey.SYNC_INCOMING_CONFIRMATION_PENDING))
        val accepted = try { decision.await() } finally {
            if (pendingDecision === decision) pendingDecision = null
        }
        if (!accepted) {
            mutableState.value = mutableState.value.copy(phase = "waiting", message = UiStatus(StatusKey.SYNC_REJECTED))
            throw IllegalStateException("Sync rejected")
        }
        val result = try {
            PortableExport.importInto(
                PortableExport.parse(envelope), channelPassphrase,
                profiles, forwards, groups, proxies, privateKeys, knownHosts, credentials,
                conflict = ImportConflict.SKIP
            )
        } catch (error: Throwable) {
            mutableState.value = mutableState.value.copy(phase = "waiting", message = syncError(error, StatusKey.SYNC_IMPORT_FAILED))
            throw error
        }
        val applied = LanSyncApplyResult(
            profiles = result.profiles,
            snippets = 0,
            forwards = result.forwards,
            knownHosts = result.knownHosts,
            secrets = result.secrets,
            skipped = result.skipped
        )
        mutableState.value = mutableState.value.copy(
            phase = "applied",
            lastResult = applied,
            message = UiStatus(StatusKey.SYNC_IMPORTED, listOf(result.profiles))
        )
        return applied
    }

    private suspend fun <T> withMulticastLock(block: suspend () -> T): T {
        val wifi = getApplication<Application>().getSystemService(WifiManager::class.java)
        val lock = wifi?.createMulticastLock("openfinalshell-lansync")?.apply { setReferenceCounted(false); acquire() }
        return try { block() } finally { runCatching { lock?.release() } }
    }

    private fun acquireReceiverMulticastLock(): WifiManager.MulticastLock? {
        receiverMulticastLock?.let { return it }
        val wifi = getApplication<Application>().getSystemService(WifiManager::class.java) ?: return null
        return wifi.createMulticastLock("openfinalshell-lansync-receiver").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseReceiverMulticastLock() {
        runCatching { receiverMulticastLock?.release() }
        receiverMulticastLock = null
    }

    override fun onCleared() {
        pendingDecision?.complete(false)
        coordinator.close()
        releaseReceiverMulticastLock()
        database.close()
        super.onCleared()
    }

    /** The detailed cause is useful to developers, but is not a translated UI string. */
    private fun syncError(error: Throwable, fallback: StatusKey): UiStatus {
        Log.e(TAG, fallback.name, error)
        return UiStatus(fallback)
    }

    private companion object {
        const val TAG = "LanSync"
        const val PREFS = "lan_sync"
        const val KEY_DEVICE_ID = "device_id"
    }
}
