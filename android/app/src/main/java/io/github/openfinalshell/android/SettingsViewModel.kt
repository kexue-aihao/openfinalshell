package io.github.openfinalshell.android

import android.app.Application
import android.content.Intent
import androidx.appcompat.app.AppCompatDelegate
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.openfinalshell.android.storage.AndroidSettings
import io.github.openfinalshell.android.storage.AppDatabase
import io.github.openfinalshell.android.storage.SettingsRepository
import io.github.openfinalshell.android.update.AndroidUpdateManager
import io.github.openfinalshell.android.update.UpdateState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class SettingsUiState(
    val settings: AndroidSettings = AndroidSettings(),
    val loaded: Boolean = false,
    val saving: Boolean = false,
    val update: UpdateState = UpdateState.Idle,
    val message: String? = null
)

/** Owns Android settings and the in-app updater independently of the SSH session state. */
class SettingsViewModel(application: Application) : AndroidViewModel(application) {
    private val database = AppDatabase.create(application)
    private val repository = SettingsRepository(database.documents())
    private val updateManager = AndroidUpdateManager(application)
    private val saveMutex = Mutex()
    private var loadJob: Job

    private val mutableState = MutableStateFlow(
        SettingsUiState(update = updateManager.state.value)
    )
    val state: StateFlow<SettingsUiState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            updateManager.state.collect { update -> mutableState.update { it.copy(update = update) } }
        }
        // Room and the network check run in background coroutines; first frame remains responsive.
        loadJob = viewModelScope.launch {
            val storedSettings = runCatching { withContext(Dispatchers.IO) { repository.load() } }
                .onFailure { error ->
                    mutableState.update { it.copy(message = error.message ?: application.getString(R.string.settings_unavailable)) }
                }
                .getOrElse { AndroidSettings() }
            // Android 13 may receive a per-app language change while the app is not running.
            // A concrete platform locale takes precedence over our older local document.
            val platformLanguage = AndroidLocales.settingFor(AppCompatDelegate.getApplicationLocales())
            val settings = if (platformLanguage != AndroidLocales.SYSTEM && platformLanguage != storedSettings.language) {
                storedSettings.copy(language = platformLanguage)
            } else {
                storedSettings
            }
            if (settings != storedSettings) withContext(Dispatchers.IO) { repository.save(settings) }
            mutableState.update { it.copy(settings = settings, loaded = true) }
            AndroidLocales.apply(settings.language)
            if (settings.autoCheckUpdates) checkForUpdates()
        }
    }

    fun update(transform: (AndroidSettings) -> AndroidSettings) {
        updateAndPersist(transform)
    }

    private fun updateAndPersist(
        transform: (AndroidSettings) -> AndroidSettings,
        afterPersist: ((AndroidSettings) -> Unit)? = null
    ) {
        mutableState.update { it.copy(settings = transform(it.settings), message = null) }
        persist(afterPersist)
    }

    fun setLanguage(language: String) = updateAndPersist(
        transform = { it.copy(language = AndroidLocales.normalize(language)) },
        afterPersist = { AndroidLocales.apply(it.language) }
    )

    /** Mirrors a language selected in Android 13's system app-language settings. */
    fun setLanguageFromPlatform(language: String) {
        if (!state.value.loaded || state.value.settings.language == language) return
        update { it.copy(language = AndroidLocales.normalize(language)) }
    }
    fun setTheme(theme: String) = update { it.copy(theme = theme) }
    fun setAccentColor(color: String) = update { it.copy(accentColor = color) }
    fun setMaskHosts(enabled: Boolean) = update { it.copy(maskHosts = enabled) }
    fun setAutoCheckUpdates(enabled: Boolean) {
        update { it.copy(autoCheckUpdates = enabled) }
        if (enabled) checkForUpdates()
    }
    fun setTerminalFontSize(value: Int) = update { it.copy(terminalFontSize = value) }
    fun setTerminalCursorStyle(value: String) = update { it.copy(terminalCursorStyle = value) }
    fun setTerminalScrollbackLines(value: Int) = update { it.copy(terminalScrollbackLines = value) }
    fun setSftpConcurrency(value: Int) = update { it.copy(sftpConcurrency = value) }
    fun setSftpConflictPolicy(value: String) = update { it.copy(sftpConflictPolicy = value) }
    fun setSftpShowHiddenFiles(enabled: Boolean) = update { it.copy(sftpShowHiddenFiles = enabled) }
    fun setMonitorIntervalSeconds(value: Int) = update { it.copy(monitorIntervalSeconds = value) }
    fun setDownloadDirectoryUri(uri: String?) = update { it.copy(downloadDirectoryUri = uri) }

    fun checkForUpdates() {
        viewModelScope.launch {
            updateManager.checkForUpdates()
        }
    }

    fun downloadUpdate() {
        val available = state.value.update as? UpdateState.Available ?: return
        viewModelScope.launch { updateManager.download(available.release, available.apk) }
    }

    fun cancelDownload() = updateManager.cancelDownload()

    fun installUpdate() {
        viewModelScope.launch { updateManager.installReady() }
    }

    fun refreshInstallStatus() {
        mutableState.update { it.copy(update = updateManager.refreshInstallStatus()) }
    }

    fun installPermissionIntent(): Intent = updateManager.installPermissionIntent()
    fun canInstallPackages(): Boolean = updateManager.canInstallPackages()

    private fun persist(afterPersist: ((AndroidSettings) -> Unit)? = null) {
        viewModelScope.launch {
            mutableState.update { it.copy(saving = true) }
            runCatching {
                // The mutex makes fast successive control changes persist in order using latest state.
                saveMutex.withLock {
                    withContext(Dispatchers.IO) { repository.save(state.value.settings) }
                }
            }.onSuccess {
                afterPersist?.invoke(state.value.settings)
            }.onFailure { error ->
                mutableState.update { it.copy(message = error.message ?: getApplication<Application>().getString(R.string.settings_save_failed)) }
            }
            mutableState.update { it.copy(saving = false) }
        }
    }

    override fun onCleared() {
        database.close()
        super.onCleared()
    }
}
