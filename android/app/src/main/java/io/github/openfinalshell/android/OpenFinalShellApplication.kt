package io.github.openfinalshell.android

import android.app.Application
import io.github.openfinalshell.android.core.ssh.AndroidSshdInitializer

class OpenFinalShellApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Configure SSHD before any activity or session can initialize ClientBuilder.
        AndroidSshdInitializer.configure(filesDir.toPath())
    }
}
