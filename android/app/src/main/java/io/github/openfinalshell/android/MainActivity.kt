package io.github.openfinalshell.android

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate

class MainActivity : AppCompatActivity() {
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
        // Also captures a language chosen from Android 13's system app-language page.
        settingsViewModel.setLanguageFromPlatform(
            AndroidLocales.settingFor(AppCompatDelegate.getApplicationLocales())
        )
    }
}
