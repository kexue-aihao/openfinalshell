package io.github.openfinalshell.android.local

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * Locates the PTY host inside this APK and fingerprints it once.
 *
 * The digest travels with every launch so a privileged service can refuse a helper that changed
 * between the app reading it and the service copying it. The file lives in the native library
 * directory, which exists only because the APK is packaged with `useLegacyPackaging` — with the
 * default packaging there is no file on disk here at all, only a library the linker reads from
 * inside the APK.
 */
object LocalHostBinary {
    const val NAME = "libofspty.so"

    fun file(context: Context): File = File(context.applicationInfo.nativeLibraryDir, NAME)

    fun exists(context: Context): Boolean = file(context).isFile

    private val digestCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun sha256(context: Context): String {
        val binary = file(context)
        // Keyed by path and length: an app update moves the native library directory, and a
        // reinstall can change the contents.
        val key = "${binary.path}:${binary.length()}"
        return digestCache.getOrPut(key) {
            val digest = MessageDigest.getInstance("SHA-256")
            binary.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
