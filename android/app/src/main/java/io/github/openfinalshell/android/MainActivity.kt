package io.github.openfinalshell.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<MainViewModel>()
    private val settingsViewModel by viewModels<SettingsViewModel>()
    private val lanSyncViewModel by viewModels<LanSyncViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OpenFinalShellApp(viewModel, settingsViewModel, lanSyncViewModel) }
    }

    override fun onResume() {
        super.onResume()
        // PackageInstaller reports completion while the activity is not visible.
        settingsViewModel.refreshInstallStatus()
    }
}
