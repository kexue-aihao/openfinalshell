package io.github.openfinalshell.android.local

import android.content.Context
import io.github.openfinalshell.android.core.local.HostLauncher
import io.github.openfinalshell.android.core.model.LocalShellTier

/** How a local session reaches its shell, ordered from least to most capable. */
enum class LocalTier(val profileValue: String) {
    /** The app's own uid, in-process. Always available, needs no setup. */
    APP(LocalShellTier.APP),

    /** The ADB shell uid, through Shizuku. */
    ADB(LocalShellTier.ADB),

    /** uid 0, through Shizuku running as root or through a direct `su`. */
    ROOT(LocalShellTier.ROOT);

    companion object {
        fun fromProfileValue(value: String): LocalTier? = entries.firstOrNull { it.profileValue == value }
    }
}

/** Why a requested tier is not usable right now, in terms the UI can turn into advice. */
enum class LocalTierBlocker {
    SHIZUKU_NOT_INSTALLED,
    SHIZUKU_NOT_RUNNING,
    SHIZUKU_NO_PERMISSION,
    SHIZUKU_TOO_OLD,

    /** No `su` on the device, so the root tier needs Shizuku running as root instead. */
    NO_ROOT_BINARY,

    /** The user has not switched the root tier on in settings. */
    ROOT_DISABLED_BY_SETTINGS,

    /** The privileged host is not on disk, which means the APK was not packaged for it. */
    HELPER_MISSING
}

/** What the device currently offers. Probed once per connect, never cached across them. */
data class LocalTierAvailability(
    val shizuku: ShizukuUnavailable? = ShizukuUnavailable.NOT_INSTALLED,
    val shizukuRunsAsRoot: Boolean = false,
    val hasRootBinary: Boolean = false,
    val rootAllowedBySettings: Boolean = false,
    val helperPresent: Boolean = true
) {
    val adbAvailable: Boolean get() = helperPresent && shizuku == null

    /**
     * The root tier is reachable either through Shizuku running as root or through `su` — but only
     * when the user has switched it on, which is the second gate after the build flag.
     */
    val rootAvailable: Boolean
        get() = helperPresent && rootAllowedBySettings && (shizukuRunsAsRoot || hasRootBinary)

    fun isAvailable(tier: LocalTier): Boolean = when (tier) {
        LocalTier.APP -> true
        LocalTier.ADB -> adbAvailable
        LocalTier.ROOT -> rootAvailable
    }

    /** The most capable tier this device offers, for a profile that asked for `auto`. */
    fun best(): LocalTier = when {
        rootAvailable -> LocalTier.ROOT
        adbAvailable -> LocalTier.ADB
        else -> LocalTier.APP
    }

    fun blockerFor(tier: LocalTier): LocalTierBlocker? = when {
        isAvailable(tier) -> null
        !helperPresent -> LocalTierBlocker.HELPER_MISSING
        tier == LocalTier.ADB -> when (shizuku) {
            ShizukuUnavailable.NOT_INSTALLED -> LocalTierBlocker.SHIZUKU_NOT_INSTALLED
            ShizukuUnavailable.NOT_RUNNING -> LocalTierBlocker.SHIZUKU_NOT_RUNNING
            ShizukuUnavailable.NO_PERMISSION -> LocalTierBlocker.SHIZUKU_NO_PERMISSION
            ShizukuUnavailable.TOO_OLD -> LocalTierBlocker.SHIZUKU_TOO_OLD
            ShizukuUnavailable.HELPER_MISSING -> LocalTierBlocker.HELPER_MISSING
            null -> LocalTierBlocker.HELPER_MISSING
        }
        tier == LocalTier.ROOT -> if (!rootAllowedBySettings) LocalTierBlocker.ROOT_DISABLED_BY_SETTINGS else LocalTierBlocker.NO_ROOT_BINARY
        else -> null
    }
}

/** The tier a session will actually run at, and whether that is what was asked for. */
data class LocalTierResolution(
    val tier: LocalTier,
    val requested: String,
    val blocker: LocalTierBlocker? = null
) {
    /** True when the request could not be honoured and a lower tier was chosen instead. */
    val downgraded: Boolean get() = requested != LocalShellTier.AUTO && requested != tier.profileValue
}

/**
 * A pending "this will run as root" confirmation.
 *
 * Raised before any host process is launched, because at the root tier the app's own credential
 * store is inside the shell's reach: a uid-0 shell can read the database file and can attach to this
 * process to lift the plaintext secrets after unlock. The app cannot defend against that, so the
 * only honest response is to say so and require an explicit answer.
 */
data class RootConfirmation(val profileId: String, val profileName: String)

/**
 * Decides which tier a local session runs at.
 *
 * Resolution is per connect rather than cached for the process: root can disappear across a reboot,
 * Shizuku stops when the device restarts, and a permission can be revoked. A cached answer would
 * mean the tier badge lying about what the shell actually is.
 */
class LocalPrivilege(private val context: Context) {
    private val shizukuLauncher = ShizukuHostLauncher(context)
    private val rootLauncher = RootHostLauncher(context)

    suspend fun probe(rootAllowedBySettings: Boolean): LocalTierAvailability = LocalTierAvailability(
        shizuku = shizukuLauncher.probe(),
        shizukuRunsAsRoot = shizukuLauncher.runsAsRoot(),
        hasRootBinary = rootLauncher.isAvailable(),
        rootAllowedBySettings = rootAllowedBySettings,
        helperPresent = LocalHostBinary.exists(context)
    )

    /**
     * Picks the tier for a profile's request.
     *
     * A request that cannot be honoured resolves to the best available tier and reports the blocker,
     * so the caller can connect anyway and tell the user what changed — rather than refusing, which
     * after a reboot with root disabled would leave the session unusable.
     */
    fun resolve(requested: String, availability: LocalTierAvailability): LocalTierResolution {
        if (requested == LocalShellTier.AUTO) {
            return LocalTierResolution(availability.best(), requested)
        }
        val wanted = LocalTier.fromProfileValue(requested)
            ?: return LocalTierResolution(LocalTier.APP, requested, LocalTierBlocker.HELPER_MISSING)
        if (availability.isAvailable(wanted)) return LocalTierResolution(wanted, requested)
        return LocalTierResolution(availability.best(), requested, availability.blockerFor(wanted))
    }

    /** The launcher for a privileged tier. The app tier runs in-process and has none. */
    fun launcherFor(tier: LocalTier, availability: LocalTierAvailability): HostLauncher = when (tier) {
        LocalTier.APP -> error("the app tier runs in-process and has no host launcher")
        LocalTier.ADB -> shizukuLauncher
        LocalTier.ROOT -> if (availability.shizukuRunsAsRoot) shizukuLauncher else rootLauncher
    }

    /** Asks Shizuku to grant its API permission; the answer arrives on Shizuku's result listener. */
    fun requestShizukuPermission(onResult: (Boolean) -> Unit) = shizukuLauncher.requestPermission(onResult)

    suspend fun shutdown() {
        runCatching { shizukuLauncher.shutdown() }
        runCatching { rootLauncher.shutdown() }
    }
}
