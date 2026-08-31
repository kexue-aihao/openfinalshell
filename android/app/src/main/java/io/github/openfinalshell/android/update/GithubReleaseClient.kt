package io.github.openfinalshell.android.update

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.Json

interface UpdateReleaseClient {
    suspend fun latestRelease(): AndroidRelease
    suspend fun download(asset: ReleaseAsset, target: File, onProgress: suspend (downloaded: Long, total: Long) -> Unit): Long
    suspend fun downloadText(asset: ReleaseAsset, maxBytes: Long = 1_048_576L): String
}

class GithubReleaseClient(
    private val latestUrl: String = DEFAULT_LATEST_URL,
    private val connectTimeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
    private val readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS
) : UpdateReleaseClient {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun latestRelease(): AndroidRelease = withContext(Dispatchers.IO) {
        val connection = request(latestUrl, "application/vnd.github+json")
        val response = try {
            connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
        val release = json.decodeFromString<GithubReleaseResponse>(response)
        val semver = SemVersion.parse(release.tagName)
            ?: throw UpdateException("GitHub release tag is not a supported version: ${release.tagName}")
        AndroidRelease(
            tagName = release.tagName,
            versionName = semver.withoutPrerelease(),
            name = release.name,
            body = release.body.orEmpty(),
            publishedAt = release.publishedAt,
            assets = release.assets.mapNotNull { asset ->
                asset.name?.takeIf(String::isNotBlank)?.let { name ->
                    ReleaseAsset(name, asset.browserDownloadUrl.orEmpty(), asset.size ?: 0L, asset.digest)
                }
            }.filter { it.downloadUrl.isNotBlank() }
        )
    }

    override suspend fun download(
        asset: ReleaseAsset,
        target: File,
        onProgress: suspend (downloaded: Long, total: Long) -> Unit
    ): Long = withContext(Dispatchers.IO) {
        require(asset.downloadUrl.isNotBlank()) { "Release asset has no download URL" }
        target.parentFile?.mkdirs()
        val connection = request(asset.downloadUrl, "application/octet-stream")
        try {
            val total = connection.contentLengthLong.takeIf { it >= 0 } ?: asset.size
            var downloaded = 0L
            connection.inputStream.buffered().use { input ->
                target.outputStream().buffered().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        downloaded += count
                        onProgress(downloaded, total)
                    }
                }
            }
            downloaded
        } finally {
            connection.disconnect()
        }
    }

    override suspend fun downloadText(asset: ReleaseAsset, maxBytes: Long): String = withContext(Dispatchers.IO) {
        val connection = request(asset.downloadUrl, "text/plain")
        try {
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0L
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > maxBytes) throw UpdateException("Checksum file is too large")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            bytes.toString(StandardCharsets.UTF_8)
        } finally {
            connection.disconnect()
        }
    }

    private fun request(url: String, accept: String): HttpURLConnection {
        val connection = (URL(url).openConnection() as? HttpURLConnection)
            ?: throw UpdateException("Unsupported update URL")
        connection.instanceFollowRedirects = true
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.requestMethod = "GET"
        connection.setRequestProperty("Accept", accept)
        connection.setRequestProperty("User-Agent", USER_AGENT)
        val status = connection.responseCode
        if (status !in 200..299) {
            connection.disconnect()
            throw UpdateException("Update server returned HTTP $status")
        }
        return connection
    }

    companion object {
        const val DEFAULT_LATEST_URL = "https://api.github.com/repos/kexue-aihao/openfinalshell/releases/latest"
        const val DEFAULT_CONNECT_TIMEOUT_MS = 15_000
        const val DEFAULT_READ_TIMEOUT_MS = 30_000
        private const val USER_AGENT = "OpenFinalShell-Android-Updater"
    }
}

open class UpdateException(message: String, cause: Throwable? = null) : IOException(message, cause)

@Serializable
private data class GithubReleaseResponse(
    @SerialName("tag_name")
    val tagName: String,
    val name: String = "",
    val body: String? = null,
    @SerialName("published_at")
    val publishedAt: String? = null,
    val assets: List<GithubAssetResponse> = emptyList()
)

@Serializable
private data class GithubAssetResponse(
    val name: String? = null,
    @SerialName("browser_download_url")
    val browserDownloadUrl: String? = null,
    val size: Long? = null,
    val digest: String? = null
)
