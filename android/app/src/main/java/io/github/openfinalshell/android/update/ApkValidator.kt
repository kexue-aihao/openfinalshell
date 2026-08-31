package io.github.openfinalshell.android.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.security.MessageDigest
import java.util.Locale

data class ApkValidationResult(
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val signingCertificateSha256: Set<String>
)

class ApkValidationException(message: String) : UpdateException(message)

object ApkValidator {
    fun validate(
        context: Context,
        apk: File,
        expectedVersionName: String,
        minimumVersionCode: Long
    ): ApkValidationResult {
        if (!apk.isFile || apk.length() == 0L) throw ApkValidationException("Downloaded APK is missing or empty")
        val packageManager = context.packageManager
        val archive = archiveInfo(packageManager, apk)
            ?: throw ApkValidationException("Downloaded file is not a readable APK")
        val packageName = context.packageName
        if (archive.packageName != packageName) {
            throw ApkValidationException("APK package does not match this application")
        }
        val versionName = archive.versionName.orEmpty()
        if (versionName != expectedVersionName) {
            throw ApkValidationException("APK version does not match the release")
        }
        val versionCode = PackageInfoCompat.getLongVersionCode(archive)
        if (versionCode <= minimumVersionCode) {
            throw ApkValidationException("APK version code is not newer than the installed version")
        }
        val candidateSigners = signingCertificateDigests(archive)
        if (candidateSigners.isEmpty()) throw ApkValidationException("APK has no signing certificate")
        val installed = packageManager.getPackageInfoCompat(packageName)
        val installedSigners = signingCertificateDigests(installed)
        if (installedSigners.isEmpty() || installedSigners.intersect(candidateSigners).isEmpty()) {
            throw ApkValidationException("APK signing certificate does not match the installed application")
        }
        return ApkValidationResult(packageName, versionName, versionCode, candidateSigners)
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().toHex()
    }

    private fun archiveInfo(packageManager: PackageManager, apk: File): PackageInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageManager.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNATURES)
        }

    private fun PackageManager.getPackageInfoCompat(packageName: String): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(signingFlags()))
        } else {
            @Suppress("DEPRECATION")
            getPackageInfo(packageName, signingFlags().toInt())
        }

    private fun signingFlags(): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES.toLong()
    } else {
        @Suppress("DEPRECATION")
        PackageManager.GET_SIGNATURES.toLong()
    }

    private fun signingCertificateDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners?.toList().orEmpty()
        } else {
            @Suppress("DEPRECATION")
            info.signatures?.toList().orEmpty()
        }
        return signatures.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }.toSet()
    }

    private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(Locale.ROOT, byte) }
}
