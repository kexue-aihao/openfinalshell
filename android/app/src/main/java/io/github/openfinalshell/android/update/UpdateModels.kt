package io.github.openfinalshell.android.update

import android.os.Build
import java.util.Locale

data class ReleaseAsset(
    val name: String,
    val downloadUrl: String,
    val size: Long,
    val digest: String? = null
)

data class AndroidRelease(
    val tagName: String,
    val versionName: String,
    val name: String,
    val body: String,
    val publishedAt: String?,
    val assets: List<ReleaseAsset>
)

data class SelectedApk(
    val asset: ReleaseAsset,
    val abi: String
)

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data class UpToDate(val currentVersion: String, val latestVersion: String) : UpdateState
    data class Available(val release: AndroidRelease, val apk: SelectedApk) : UpdateState
    data class Downloading(
        val release: AndroidRelease,
        val apk: SelectedApk,
        val downloadedBytes: Long,
        val totalBytes: Long
    ) : UpdateState
    data class Ready(val release: AndroidRelease, val apk: SelectedApk, val filePath: String) : UpdateState
    data object Canceled : UpdateState
    data class Installing(val versionName: String) : UpdateState
    data class Installed(val versionName: String) : UpdateState
    data class Failed(val message: String, val retryable: Boolean = true) : UpdateState
}

data class AppVersion(val name: String, val code: Long)

/** Small SemVer subset used for release ordering. GitHub tags are expected to be vX.Y.Z. */
data class SemVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val prerelease: String? = null
) : Comparable<SemVersion> {
    override fun compareTo(other: SemVersion): Int {
        compareValues(major, other.major).takeIf { it != 0 }?.let { return it }
        compareValues(minor, other.minor).takeIf { it != 0 }?.let { return it }
        compareValues(patch, other.patch).takeIf { it != 0 }?.let { return it }
        if (prerelease == null && other.prerelease != null) return 1
        if (prerelease != null && other.prerelease == null) return -1
        return comparePrerelease(prerelease, other.prerelease)
    }

    fun withoutPrerelease(): String = "$major.$minor.$patch"

    companion object {
        private val pattern = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$")

        fun parse(value: String): SemVersion? {
            val match = pattern.matchEntire(value.trim()) ?: return null
            return SemVersion(
                major = match.groupValues[1].toIntOrNull() ?: return null,
                minor = match.groupValues[2].toIntOrNull() ?: return null,
                patch = match.groupValues[3].toIntOrNull() ?: return null,
                prerelease = match.groupValues[4].takeIf(String::isNotEmpty)
            )
        }

        private fun comparePrerelease(left: String?, right: String?): Int {
            if (left == right) return 0
            val leftParts = left.orEmpty().split('.')
            val rightParts = right.orEmpty().split('.')
            for (index in 0 until maxOf(leftParts.size, rightParts.size)) {
                val l = leftParts.getOrNull(index) ?: return -1
                val r = rightParts.getOrNull(index) ?: return 1
                val numeric = l.toLongOrNull()
                val otherNumeric = r.toLongOrNull()
                val result = when {
                    numeric != null && otherNumeric != null -> numeric.compareTo(otherNumeric)
                    numeric != null -> -1
                    otherNumeric != null -> 1
                    else -> l.lowercase(Locale.ROOT).compareTo(r.lowercase(Locale.ROOT))
                }
                if (result != 0) return result
            }
            return 0
        }
    }
}

object UpdateAssetSelector {
    private val supportedAbis = setOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")

    fun currentAbi(supported: Array<String> = Build.SUPPORTED_ABIS): String =
        supported.firstOrNull { it in supportedAbis } ?: "universal"

    fun select(release: AndroidRelease, supported: Array<String> = Build.SUPPORTED_ABIS): SelectedApk? {
        val version = release.versionName
        val abi = currentAbi(supported)
        val exact = if (abi == "universal") null else
            release.assets.firstOrNull { it.name == apkName(version, abi) }
        val universal = release.assets.firstOrNull { it.name == apkName(version, "universal") }
        return (exact ?: universal)?.let { SelectedApk(it, exact?.let { abi } ?: "universal") }
    }

    fun apkName(versionName: String, abi: String): String =
        "OpenFinalShell-$versionName-android-$abi.apk"
}

object ChecksumParser {
    private val line = Regex("^\\s*([0-9a-fA-F]{64})\\s+[*]?(.+?)\\s*$")

    fun findSha256(checksums: String, fileName: String): String? = checksums.lineSequence()
        .mapNotNull { match -> line.matchEntire(match) }
        .firstOrNull { it.groupValues[2] == fileName }
        ?.groupValues?.get(1)?.lowercase(Locale.ROOT)
}
