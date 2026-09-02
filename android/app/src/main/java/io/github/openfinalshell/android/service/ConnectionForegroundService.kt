package io.github.openfinalshell.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.github.openfinalshell.android.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
class ConnectionForegroundService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var stopRequested = false

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_connections),
                NotificationManager.IMPORTANCE_LOW
            )
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val restartedBySystem = intent == null
        if (intent?.action == ACTION_STOP) {
            stopRequested = true
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .remove(KEY_ACTIVE)
                .remove(KEY_SESSIONS)
                .remove(KEY_TRANSFERS)
                .remove(KEY_FORWARDS)
                .apply()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_UPDATE) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putInt(KEY_SESSIONS, intent.getIntExtra(EXTRA_SESSIONS, 0))
                .putInt(KEY_TRANSFERS, intent.getIntExtra(EXTRA_TRANSFERS, 0))
                .putInt(KEY_FORWARDS, intent.getIntExtra(EXTRA_FORWARDS, 0))
                .apply()
        }
        if (restartedBySystem) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ACTIVE, false).apply()
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ACTIVE, true).apply()
        startForeground(NOTIFICATION_ID, notification(restartedBySystem))
        // The service keeps the process in the foreground while the ViewModel owns the live
        // session objects. After process death START_STICKY recreates only the notification; the
        // recovery wording below avoids claiming that a dead SSH session is still connected.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        if (stopRequested) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_ACTIVE).apply()
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun notification(restartedBySystem: Boolean): Notification {
        val active = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_ACTIVE, false)
        val sessions = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(KEY_SESSIONS, 0)
        val transfers = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(KEY_TRANSFERS, 0)
        val forwards = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(KEY_FORWARDS, 0)
        val summary = if (sessions > 0 || transfers > 0 || forwards > 0) {
            getString(R.string.notification_summary, sessions, transfers, forwards)
        } else {
            getString(R.string.notification_reopen_to_restore)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_upload)
        .setContentTitle(getString(R.string.app_name))
        .setContentText(if (!restartedBySystem && active) summary else getString(R.string.notification_reopen_to_restore))
        .setOngoing(true)
        .build()
    }

    companion object {
        const val ACTION_STOP = "io.github.openfinalshell.android.action.STOP"
        const val ACTION_START = "io.github.openfinalshell.android.action.START"
        const val ACTION_UPDATE = "io.github.openfinalshell.android.action.UPDATE"
        const val EXTRA_SESSIONS = "sessions"
        const val EXTRA_TRANSFERS = "transfers"
        const val EXTRA_FORWARDS = "forwards"
        private const val CHANNEL_ID = "connections"
        private const val NOTIFICATION_ID = 1001
        private const val PREFS = "background_service"
        private const val KEY_ACTIVE = "active"
        private const val KEY_SESSIONS = "sessions"
        private const val KEY_TRANSFERS = "transfers"
        private const val KEY_FORWARDS = "forwards"

        fun update(context: android.content.Context, sessions: Int, transfers: Int, forwards: Int = 0) {
            val intent = Intent(context, ConnectionForegroundService::class.java)
                .setAction(ACTION_UPDATE)
                .putExtra(EXTRA_SESSIONS, sessions)
                .putExtra(EXTRA_TRANSFERS, transfers)
                .putExtra(EXTRA_FORWARDS, forwards)
            runCatching { context.startService(intent) }
                .onFailure { runCatching { ContextCompat.startForegroundService(context, intent) } }
        }

        fun stop(context: android.content.Context) {
            val intent = Intent(context, ConnectionForegroundService::class.java).setAction(ACTION_STOP)
            runCatching { context.startService(intent) }
        }
    }
}
