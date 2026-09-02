package io.github.openfinalshell.android.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers

class InstallPermissionRequiredException : UpdateException("Android install permission is not enabled")

class AndroidUpdateManager(
    context: Context,
    private val client: UpdateReleaseClient = GithubReleaseClient(),
    private val supportedAbis: Array<String> = Build.SUPPORTED_ABIS
) {
    private val appContext = context.applicationContext
    private val updateDirectory = File(appContext.filesDir, UPDATES_DIRECTORY)
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val mutableState = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = mutableState.asStateFlow()
    private var downloadJob: Job? = null

    init {
        restorePendingState()
    }

    suspend fun checkForUpdates(): UpdateState {
        mutableState.value = UpdateState.Checking
        return runCatching {
            val release = client.latestRelease()
            val selected = UpdateAssetSelector.select(release, supportedAbis)
                ?: throw UpdateException("No APK for this device ABI is available")
            val current = currentVersion()
            val remote = SemVersion.parse(release.versionName)
                ?: throw UpdateException("Unsupported release version")
            val installed = SemVersion.parse(current.name)
            if (installed != null && remote <= installed) {
                UpdateState.UpToDate(current.name, release.versionName)
            } else {
                UpdateState.Available(release, selected)
            }
        }.getOrElse { error ->
            if (error is CancellationException) throw error
            UpdateState.Failed(error.userMessage(), retryable = true)
        }.also { mutableState.value = it }
    }

    suspend fun download(release: AndroidRelease, selected: SelectedApk): UpdateState {
        downloadJob?.cancel()
        downloadJob = coroutineContext[Job]
        val part = File(updateDirectory, "${safeFileName(selected.asset.name)}.part")
        val apk = File(updateDirectory, safeFileName(selected.asset.name))
        mutableState.value = UpdateState.Downloading(release, selected, 0L, selected.asset.size)
        return try {
            withContext(Dispatchers.IO) {
                updateDirectory.mkdirs()
                if (apk.exists()) apk.delete()
                if (part.exists()) part.delete()
            }
            client.download(selected.asset, part) { downloaded, total ->
                mutableState.value = UpdateState.Downloading(release, selected, downloaded, total)
            }
            val expectedSha = expectedSha256(release, selected.asset)
            val actualSha = withContext(Dispatchers.IO) { ApkValidator.sha256(part) }
            if (!actualSha.equals(expectedSha, ignoreCase = true)) {
                part.delete()
                throw ApkValidationException("APK SHA-256 checksum does not match the release")
            }
            withContext(Dispatchers.IO) {
                moveAtomically(part, apk)
                ApkValidator.validate(appContext, apk, release.versionName, PackageInfoCompat.getLongVersionCode(currentPackageInfo()))
            }
            preferences.edit()
                .putString(KEY_PATH, apk.absolutePath)
                .putString(KEY_TAG, release.tagName)
                .putString(KEY_VERSION, release.versionName)
                .putString(KEY_ASSET, selected.asset.name)
                .putString(KEY_SHA256, actualSha)
                .remove(KEY_INSTALL_STATUS)
                .apply()
            UpdateState.Ready(release, selected, apk.absolutePath)
                .also { mutableState.value = it }
        } catch (error: CancellationException) {
            withContext(Dispatchers.IO) { part.delete() }
            mutableState.value = UpdateState.Canceled
            throw error
        } catch (error: Throwable) {
            withContext(Dispatchers.IO) { part.delete() }
            UpdateState.Failed(error.userMessage(), retryable = true).also { mutableState.value = it }
        } finally {
            if (downloadJob === coroutineContext[Job]) downloadJob = null
        }
    }

    fun cancelDownload() {
        downloadJob?.cancel()
    }

    suspend fun installReady(): UpdateState {
        val ready = state.value as? UpdateState.Ready ?: run {
            val restored = restorePendingState()
            restored as? UpdateState.Ready ?: return restored
        }
        val apk = File(ready.filePath)
        if (!canInstallPackages()) {
            return UpdateState.Failed(InstallPermissionRequiredException().message.orEmpty(), retryable = false)
                .also { mutableState.value = it }
        }
        return try {
            withContext(Dispatchers.IO) {
                val expectedHash = preferences.getString(KEY_SHA256, null)
                    ?: throw ApkValidationException("Downloaded update metadata is incomplete")
                if (!ApkValidator.sha256(apk).equals(expectedHash, ignoreCase = true)) {
                    throw ApkValidationException("Downloaded APK has changed")
                }
                val expectedVersion = preferences.getString(KEY_VERSION, ready.release.versionName)
                    ?: ready.release.versionName
                ApkValidator.validate(appContext, apk, expectedVersion, PackageInfoCompat.getLongVersionCode(currentPackageInfo()))
                AndroidPackageInstaller.commit(appContext, apk)
            }
            preferences.edit().putBoolean(KEY_INSTALLING, true).remove(KEY_INSTALL_STATUS).apply()
            UpdateState.Installing(ready.release.versionName).also { mutableState.value = it }
        } catch (error: Throwable) {
            UpdateState.Failed(error.userMessage(), retryable = false).also { mutableState.value = it }
        }
    }

    fun canInstallPackages(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
        appContext.packageManager.canRequestPackageInstalls()

    fun installPermissionIntent(): Intent = Intent(
        "android.settings.MANAGE_UNKNOWN_APP_SOURCES",
        Uri.parse("package:${appContext.packageName}")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Used only as a fallback on devices where PackageInstaller cannot create a session. */
    fun installIntent(filePath: String): Intent {
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.update-file-provider", File(filePath))
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    fun refreshInstallStatus(): UpdateState {
        val status = preferences.getInt(KEY_INSTALL_STATUS, Int.MIN_VALUE)
        val version = preferences.getString(KEY_VERSION, null)
        if (status == PackageInstaller.STATUS_SUCCESS && version != null) {
            val installedPath = preferences.getString(KEY_PATH, null)
            preferences.edit().remove(KEY_PATH).remove(KEY_TAG).remove(KEY_VERSION).remove(KEY_ASSET)
                .remove(KEY_SHA256).remove(KEY_INSTALLING).remove(KEY_INSTALL_STATUS).apply()
            installedPath?.let { File(it).delete() }
            return UpdateState.Installed(version).also { mutableState.value = it }
        }
        if (status != Int.MIN_VALUE) {
            val message = preferences.getString(KEY_INSTALL_MESSAGE, "Android installation failed").orEmpty()
            return UpdateState.Failed(message, retryable = true).also { mutableState.value = it }
        }
        return state.value
    }

    private fun restorePendingState(): UpdateState {
        val status = preferences.getInt(KEY_INSTALL_STATUS, Int.MIN_VALUE)
        val installedVersion = preferences.getString(KEY_VERSION, null)
        if (status == PackageInstaller.STATUS_SUCCESS && installedVersion != null) {
            return UpdateState.Installed(installedVersion).also { mutableState.value = it }
        }
        val path = preferences.getString(KEY_PATH, null)
        val tag = preferences.getString(KEY_TAG, null)
        val version = preferences.getString(KEY_VERSION, null)
        val assetName = preferences.getString(KEY_ASSET, null)
        if (path.isNullOrBlank() || tag.isNullOrBlank() || version.isNullOrBlank() || assetName.isNullOrBlank()) return state.value
        val apk = File(path)
        if (!apk.isFile) {
            preferences.edit().clear().apply()
            return UpdateState.Idle.also { mutableState.value = it }
        }
        val asset = ReleaseAsset(assetName, "", apk.length(), preferences.getString(KEY_SHA256, null))
        val release = AndroidRelease(tag, version, version, "", null, listOf(asset))
        return UpdateState.Ready(release, SelectedApk(asset, UpdateAssetSelector.currentAbi(supportedAbis)), path)
            .also { mutableState.value = it }
    }

    private suspend fun expectedSha256(release: AndroidRelease, asset: ReleaseAsset): String {
        asset.digest?.removePrefix("sha256:")?.takeIf { it.matches(Regex("[0-9a-fA-F]{64}")) }?.let { return it }
        val checksumAsset = release.assets.firstOrNull { it.name == "SHA256SUMS-android.txt" }
            ?: throw ApkValidationException("Release does not provide Android SHA-256 checksums")
        return ChecksumParser.findSha256(client.downloadText(checksumAsset), asset.name)
            ?: throw ApkValidationException("Release checksum does not include ${asset.name}")
    }

    private fun currentVersion(): AppVersion {
        val info = currentPackageInfo()
        return AppVersion(info.versionName.orEmpty(), PackageInfoCompat.getLongVersionCode(info))
    }

    private fun currentPackageInfo() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        appContext.packageManager.getPackageInfo(
            appContext.packageName,
            android.content.pm.PackageManager.PackageInfoFlags.of(0)
        )
    } else {
        @Suppress("DEPRECATION")
        appContext.packageManager.getPackageInfo(appContext.packageName, 0)
    }

    private fun safeFileName(name: String): String = name.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun moveAtomically(from: File, to: File) {
        try {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: IOException) {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun Throwable.userMessage(): String = when (this) {
        is UpdateException -> message.orEmpty()
        else -> message?.takeIf(String::isNotBlank) ?: "Update failed"
    }

    companion object {
        const val UPDATES_DIRECTORY = "updates"
        private const val PREFERENCES = "android_updates"
        private const val KEY_PATH = "pending_path"
        private const val KEY_TAG = "pending_tag"
        private const val KEY_VERSION = "pending_version"
        private const val KEY_ASSET = "pending_asset"
        private const val KEY_SHA256 = "pending_sha256"
        private const val KEY_INSTALLING = "installing"
        const val KEY_INSTALL_STATUS = "install_status"
        const val KEY_INSTALL_MESSAGE = "install_message"
    }
}

internal object AndroidPackageInstaller {
    fun commit(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().buffered().use { input ->
                    session.openWrite("base.apk", 0, apk.length()).use { output ->
                        input.copyTo(output)
                        output.flush()
                        session.fsync(output)
                    }
                }
                val callback = Intent(context, UpdateInstallReceiver::class.java)
                val pendingIntent = android.app.PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    callback,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )
                session.commit(pendingIntent.intentSender)
            }
        } catch (error: Throwable) {
            runCatching { installer.abandonSession(sessionId) }
            throw error
        }
    }
}
