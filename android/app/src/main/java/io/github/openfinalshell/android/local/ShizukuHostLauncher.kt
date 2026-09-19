package io.github.openfinalshell.android.local

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import io.github.openfinalshell.android.core.local.HostLauncher
import io.github.openfinalshell.android.core.local.HostRequest
import io.github.openfinalshell.android.core.local.LocalHostArgs
import io.github.openfinalshell.android.core.local.LocalHostStream
import io.github.openfinalshell.android.core.local.SocketLocalHostStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import rikka.shizuku.Shizuku

/**
 * Reaches the ADB-shell tier through Shizuku.
 *
 * Shizuku runs a service in a process that is already uid 2000 — or uid 0 when Shizuku itself runs
 * as root through Sui — and that process is what allocates the PTY. `Shizuku.getUid()` tells the two
 * apart, so this one launcher serves both privileged tiers; the root tier needs a separate path only
 * for a rooted device with no Shizuku installed.
 *
 * The user service is bound once per session and kept, because binding is the expensive part; each
 * launch is then a cheap `Runtime.exec` inside the service.
 *
 * `Shizuku.newProcess` is deliberately unused. It is deprecated, and it hands back pipes rather than
 * a PTY, so a shell started that way has no job control and no `isatty`.
 */
class ShizukuHostLauncher(private val context: Context) : HostLauncher {
    @Volatile private var service: ILocalHost? = null
    @Volatile private var binding: CompletableDeferred<ILocalHost>? = null
    @Volatile private var pendingPermissionListener: Shizuku.OnRequestPermissionResultListener? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val bound = runCatching { ILocalHost.Stub.asInterface(binder) }.getOrNull()
            if (bound == null) {
                binding?.completeExceptionally(IllegalStateException("Shizuku returned no local host service"))
                return
            }
            service = bound
            // Configuration travels with the bind so a freshly restarted service is never used
            // before it knows what to execute.
            runCatching { bound.configure(LocalHostBinary.file(context).path, LocalHostBinary.sha256(context)) }
            binding?.complete(bound)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            binding?.completeExceptionally(IllegalStateException("the Shizuku local host service disconnected"))
        }
    }

    /**
     * Whether the tier is usable right now.
     *
     * Distinguishing "Shizuku is not installed" from "installed but not running" from "running but
     * this app was not granted" matters for the UI: only one of those is something the user can fix
     * in the app, and on Android 8-10 starting Shizuku needs a computer.
     */
    override suspend fun isAvailable(): Boolean = probe() == null

    /** Null when available; otherwise why not. */
    suspend fun probe(): ShizukuUnavailable? = withContext(Dispatchers.IO) {
        runCatching {
            when {
                !Shizuku.pingBinder() -> ShizukuUnavailable.NOT_RUNNING
                Shizuku.isPreV11() -> ShizukuUnavailable.TOO_OLD
                Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED -> ShizukuUnavailable.NO_PERMISSION
                !LocalHostBinary.exists(context) -> ShizukuUnavailable.HELPER_MISSING
                else -> null
            }
        }.getOrElse { ShizukuUnavailable.NOT_INSTALLED }
    }

    /** True when Shizuku is running as root, which makes this launcher serve the root tier too. */
    suspend fun runsAsRoot(): Boolean = withContext(Dispatchers.IO) {
        runCatching { Shizuku.pingBinder() && Shizuku.getUid() == 0 }.getOrDefault(false)
    }

    /**
     * Asks Shizuku to grant this app its API permission.
     *
     * Checking for the permission is not enough to use it: Shizuku shows its own system dialog, and
     * without a request the grant can never arrive. The listener is removed as soon as the answer
     * comes back, so a user who dismisses the dialog does not leave one registered forever.
     */
    fun requestPermission(onResult: (Boolean) -> Unit) {
        val listener = Shizuku.OnRequestPermissionResultListener { code, grant ->
            if (code != PERMISSION_REQUEST_CODE) return@OnRequestPermissionResultListener
            pendingPermissionListener?.let { runCatching { Shizuku.removeRequestPermissionResultListener(it) } }
            pendingPermissionListener = null
            onResult(grant == PackageManager.PERMISSION_GRANTED)
        }
        // A previous attempt that was dismissed without an answer would otherwise accumulate.
        pendingPermissionListener?.let { runCatching { Shizuku.removeRequestPermissionResultListener(it) } }
        pendingPermissionListener = listener
        Shizuku.addRequestPermissionResultListener(listener)
        Shizuku.requestPermission(PERMISSION_REQUEST_CODE)
    }

    override suspend fun launch(request: HostRequest): LocalHostStream {
        val bound = ensureBound()
        val args = LocalHostArgs.build(request)
        val port = withContext(Dispatchers.IO) { bound.start(args) }
        check(port > 0) { "the privileged host did not report a port" }
        // The connect is blocking network I/O, so it must not run on the caller's dispatcher: the
        // session opens from the main dispatcher, where connecting inline raises
        // NetworkOnMainThreadException and the whole tier fails to open a shell.
        return withContext(Dispatchers.IO) { SocketLocalHostStream(port) }
    }

    override suspend fun shutdown() {
        val bound = service
        binding = null
        service = null
        runCatching { bound?.stopAll() }
        // remove = true asks Shizuku to kill the service process. That is what the service's
        // destroy() method exists for: the process is not killed for us otherwise, and a leftover
        // host would keep a shell alive after the session was closed.
        runCatching { Shizuku.unbindUserService(userServiceArgs(), connection, true) }
    }

    private suspend fun ensureBound(): ILocalHost {
        service?.let { return it }
        val pending = binding ?: CompletableDeferred<ILocalHost>().also { fresh ->
            binding = fresh
            Shizuku.bindUserService(userServiceArgs(), connection)
        }
        return try {
            withTimeout(BIND_TIMEOUT_MS) { pending.await() }
        } catch (error: Throwable) {
            binding = null
            throw error
        }
    }

    private fun userServiceArgs() = Shizuku.UserServiceArgs(
        ComponentName(context.packageName, LocalHostUserService::class.java.name)
    )
        // The tag and version identify the service across restarts. Shizuku silently restarts a
        // service whose version changed, so the version must move whenever the AIDL interface does.
        .tag(USER_SERVICE_TAG)
        .version(USER_SERVICE_VERSION)
        .processNameSuffix("ofs_local_host")
        .debuggable(false)
        .daemon(false)

    private companion object {
        const val USER_SERVICE_TAG = "openfinalshell.localhost"
        const val USER_SERVICE_VERSION = 1
        const val BIND_TIMEOUT_MS = 15_000L
        const val PERMISSION_REQUEST_CODE = 4001
    }
}

/** Why the Shizuku tier is not usable, so the UI can say something the user can act on. */
enum class ShizukuUnavailable {
    /** Shizuku is not installed at all. */
    NOT_INSTALLED,

    /** Installed but not running: the user has to start it, which on Android 8-10 needs a computer. */
    NOT_RUNNING,

    /** Running, but this app has not been granted the API permission. */
    NO_PERMISSION,

    /** Older than Shizuku 11, which the API dropped support for. */
    TOO_OLD,

    /** The helper is not on disk, which means the APK was not packaged for it. */
    HELPER_MISSING
}
