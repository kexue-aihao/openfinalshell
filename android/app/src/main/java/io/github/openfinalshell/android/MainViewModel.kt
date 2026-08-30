package io.github.openfinalshell.android

import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ConnectionAuth
import io.github.openfinalshell.android.core.ssh.Credentials
import io.github.openfinalshell.android.core.ssh.MinaSshTransport
import io.github.openfinalshell.android.core.ssh.SshSessionManager
import io.github.openfinalshell.android.service.ConnectionForegroundService
import androidx.core.content.ContextCompat
import io.github.openfinalshell.android.storage.AppDatabase
import io.github.openfinalshell.android.storage.ProfileRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AndroidUiState(
    val profiles: List<ConnectionProfile> = emptyList(),
    val selectedProfileId: String? = null,
    val status: String = "Ready"
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(AndroidUiState())
    val state: StateFlow<AndroidUiState> = mutableState.asStateFlow()
    private val profiles = ProfileRepository(AppDatabase.create(application).profiles())
    private val sessions = SshSessionManager({ MinaSshTransport() }, viewModelScope)

    init {
        viewModelScope.launch {
            mutableState.value = mutableState.value.copy(profiles = profiles.list())
        }
    }

    fun addProfile(name: String, host: String, port: Int, username: String) {
        val profile = ConnectionProfile(
            id = java.util.UUID.randomUUID().toString(),
            name = name,
            host = host,
            port = port,
            username = username,
            auth = ConnectionAuth(method = "password")
        )
        viewModelScope.launch {
            profiles.upsert(profile)
            mutableState.value = mutableState.value.copy(
                profiles = mutableState.value.profiles + profile,
                selectedProfileId = profile.id,
                status = "Profile saved"
            )
        }
    }

    fun setStatus(status: String) {
        mutableState.value = mutableState.value.copy(status = status)
    }

    fun connect(profile: ConnectionProfile, password: String) {
        viewModelScope.launch {
            try {
                sessions.connect(profile, Credentials(password = password.takeIf { it.isNotEmpty() }?.toCharArray()))
                ContextCompat.startForegroundService(
                    getApplication<Application>(),
                    Intent(getApplication(), ConnectionForegroundService::class.java)
                )
                setStatus("Connection requested")
            } catch (error: Throwable) {
                setStatus(error.message ?: "Connection failed")
            }
        }
    }
}
