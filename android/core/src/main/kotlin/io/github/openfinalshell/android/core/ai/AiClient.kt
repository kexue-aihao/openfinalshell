package io.github.openfinalshell.android.core.ai

import java.io.IOException
import java.io.InterruptedIOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import kotlin.coroutines.resumeWithException

@Serializable
data class AiProfile(val id: String, val name: String, val baseUrl: String, val model: String,
    val enabled: Boolean = true, val hasToken: Boolean = false, val updatedAt: Long = 0)
data class AiModel(val id: String, val image: String = "unknown")
sealed interface AiEvent {
    data class Delta(val text: String): AiEvent
    data object Completed: AiEvent
}
/** Codes and status only: upstream bodies and exception messages may contain credentials. */
class AiFailure(val code: String, val status: Int? = null): IOException(code)

/** Credentials are resolved once per request in service code, never returned to the UI. */
class AiClient private constructor(
    private val resolve: suspend (String) -> Pair<AiProfile, String>,
    client: OkHttpClient
) {
    constructor(resolve: suspend (String) -> Pair<AiProfile, String>): this(resolve,
        OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS).build())
    private val http = client.newBuilder().followRedirects(false).followSslRedirects(false).build()
    private val active = ConcurrentHashMap<String, Call>()
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val CONTEXT_LIMIT = 32768
        const val RESPONSE_LIMIT = 1_000_000
        internal fun withHttpClient(resolve: suspend (String) -> Pair<AiProfile, String>, client: OkHttpClient) = AiClient(resolve, client)
        fun normalizeUrl(value: String): String {
            val url = value.trim().toHttpUrlOrNull() ?: throw AiFailure("invalid_url")
            val local = url.host in setOf("localhost", "127.0.0.1", "::1")
            if ((!url.isHttps && !local) || url.username.isNotEmpty() || url.password.isNotEmpty()) throw AiFailure("invalid_url")
            val path = url.encodedPath.trimEnd('/').ifEmpty { "/v1" }
            return url.newBuilder().encodedPath(path).query(null).fragment(null).build().toString().trimEnd('/')
        }
        fun httpFailure(status: Int) = AiFailure(when (status) {
            401 -> "unauthorized"; 403 -> "forbidden"; 404 -> "not_found"; 429 -> "rate_limit"
            in 500..599 -> "server_error"; else -> "http_error"
        }, status)
    }

    fun cancel(id: String) { active[id]?.cancel() }
    fun close() { active.values.forEach { it.cancel() }; http.connectionPool.evictAll() }

    private suspend fun <T> withResponse(
        id: String, profileId: String, endpoint: String,
        payload: ((AiProfile) -> JsonObject)? = null,
        consume: suspend (Call, Response) -> T
    ): T = withContext(Dispatchers.IO) {
        coroutineScope {
            val (profile, token) = resolve(profileId)
            if (!profile.enabled) throw AiFailure("disabled")
            if (token.isBlank()) throw AiFailure("missing_token")
            if (token.length > 16384 || token.any { it !in '!'..'~' }) throw AiFailure("invalid_token")
            val builder = Request.Builder().url(normalizeUrl(profile.baseUrl) + endpoint)
                .header("Authorization", "Bearer $token")
            payload?.let { builder.post(it(profile).toString().toRequestBody("application/json".toMediaType())) }
            val call = http.newCall(builder.build())
            synchronized(active) {
                if (active.size >= 4 || active.putIfAbsent(id, call) != null) throw AiFailure("busy")
            }
            // Remains attached after response headers arrive: cancellation must also interrupt a
            // blocked SSE/body read. A continuation-only hook would leave that read alive.
            val guard = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { call.cancel() }
            }
            var status: Int? = null
            try {
                awaitResponse(call).use { response ->
                    status = response.code
                    if (!response.isSuccessful) throw httpFailure(response.code)
                    currentCoroutineContext().ensureActive()
                    if (call.isCanceled()) throw AiFailure("cancelled")
                    consume(call, response)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: AiFailure) {
                throw error
            } catch (error: InterruptedIOException) {
                currentCoroutineContext().ensureActive()
                throw AiFailure("timeout", status)
            } catch (error: IOException) {
                currentCoroutineContext().ensureActive()
                throw AiFailure(if (call.isCanceled()) "cancelled" else "network", status)
            } catch (_: Exception) {
                throw AiFailure("invalid_response", status)
            } finally {
                guard.cancel(); call.cancel(); active.remove(id, call)
            }
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun awaitResponse(call: Call): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object: Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }
            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response) { _, resource, _ -> resource.close() }
            }
        })
    }

    private fun parse(text: String, status: Int): JsonObject = try {
        json.parseToJsonElement(text) as? JsonObject ?: throw AiFailure("invalid_response", status)
    } catch (_: Exception) { throw AiFailure("invalid_response", status) }

    private suspend fun boundedBody(response: Response): String {
        val source = response.body?.source() ?: throw AiFailure("invalid_response", response.code)
        val result = okio.Buffer()
        while (true) {
            currentCoroutineContext().ensureActive()
            if (source.read(result, 8192) < 0) break
            if (result.size > 4 * 1024 * 1024) throw AiFailure("response_limit", response.code)
        }
        return result.readUtf8()
    }
    private fun content(root: JsonObject, field: String, status: Int): String? {
        if (root["error"] != null) throw AiFailure("invalid_response", status)
        val choice = (root["choices"] as? JsonArray)?.firstOrNull() as? JsonObject
        val message = choice?.get(field) as? JsonObject
        val value = message?.get("content")
        return when (value) {
            is JsonPrimitive -> if (value.isString) value.content else null
            is JsonArray -> value.mapNotNull { part -> ((part as? JsonObject)?.get("text") as? JsonPrimitive)?.contentOrNull }.joinToString("")
            else -> null
        }
    }
    private fun completion(model: String, prompt: String, stream: Boolean, tokens: Int = 4096) = buildJsonObject {
        put("model", model); put("stream", stream); put("temperature", 0.7); put("max_tokens", tokens)
        putJsonArray("messages") {
            addJsonObject { put("role", "user"); put("content", prompt) }
        }
    }
    suspend fun models(profileId: String): List<AiModel> = withResponse(UUID.randomUUID().toString(), profileId, "/models") { _, response ->
        parseModels(parse(boundedBody(response), response.code), response.code)
    }
    suspend fun test(profileId: String): Long {
        val start = System.nanoTime()
        return withResponse(UUID.randomUUID().toString(), profileId, "/chat/completions",
            { completion(it.model, "ping", false, 64) }) { _, response ->
            if (content(parse(boundedBody(response), response.code), "message", response.code) == null) throw AiFailure("invalid_response", response.code)
            (System.nanoTime() - start) / 1_000_000
        }
    }
    suspend fun probeImage(profileId: String): String = withResponse(UUID.randomUUID().toString(), profileId, "/chat/completions", { profile ->
        buildJsonObject {
            put("model", profile.model); put("stream", false); put("max_tokens", 64)
            putJsonArray("messages") { addJsonObject { put("role", "user"); putJsonArray("content") {
                addJsonObject { put("type", "text"); put("text", "Describe this test image briefly.") }
                addJsonObject { put("type", "image_url"); putJsonObject("image_url") {
                    put("url", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=")
                } }
            } } }
        }
    }) { _, response ->
        if (content(parse(boundedBody(response), response.code), "message", response.code) == null) throw AiFailure("invalid_response", response.code)
        "accepted" // An accepted image request does not prove visual understanding.
    }
    fun chat(id: String, profileId: String, prompt: String, stream: Boolean): Flow<AiEvent> = channelFlow {
        if (prompt.isBlank() || prompt.length > CONTEXT_LIMIT) throw AiFailure("context_limit")
        withResponse(id, profileId, "/chat/completions", { completion(it.model, prompt, stream) }) { call, reply ->
            var count = 0
            suspend fun publish(text: String) {
                currentCoroutineContext().ensureActive()
                if (call.isCanceled()) throw AiFailure("cancelled")
                count += text.length
                if (count > RESPONSE_LIMIT) throw AiFailure("response_limit", reply.code)
                if (text.isNotEmpty()) send(AiEvent.Delta(text))
            }
            if (reply.header("Content-Type")?.contains("text/event-stream", true) != true) {
                val text = content(parse(boundedBody(reply), reply.code), "message", reply.code)
                    ?: throw AiFailure("invalid_response", reply.code)
                publish(text)
            } else {
                val source = reply.body?.source() ?: throw AiFailure("invalid_response", reply.code)
                val event = StringBuilder()
                var done = false
                suspend fun dispatch() {
                    if (event.isEmpty()) return
                    val data = event.toString(); event.clear()
                    if (data == "[DONE]") { done = true; return }
                    val root = parse(data, reply.code)
                    publish(content(root, "delta", reply.code) ?: "")
                }
                while (!done) {
                    currentCoroutineContext().ensureActive()
                    if (call.isCanceled()) throw AiFailure("cancelled")
                    if (source.exhausted()) { dispatch(); break }
                    // Bound even a hostile server that never terminates a line.
                    val newline = source.indexOf('\n'.code.toByte(), 0, 262145)
                    if (newline < 0 && source.buffer.size > 262144) throw AiFailure("response_limit", reply.code)
                    val line = if (newline < 0) source.readUtf8() else source.readUtf8LineStrict(262144)
                    if (line.startsWith("data:")) {
                        if (event.isNotEmpty()) event.append('\n')
                        event.append(line.substring(5).removePrefix(" "))
                        if (event.length > 262144) throw AiFailure("response_limit", reply.code)
                    }
                    if (line.isEmpty() || newline < 0) dispatch()
                }
                if (!done) throw AiFailure("incomplete_response", reply.code)
            }
            currentCoroutineContext().ensureActive()
            if (call.isCanceled()) throw AiFailure("cancelled")
            send(AiEvent.Completed)
        }
    }
}

/** Keep the same metadata semantics as desktop aiModels.ts; names are never evidence of vision. */
internal fun parseModels(root: JsonObject, status: Int = 200): List<AiModel> {
    fun image(row: JsonObject): String {
        val caps = row["capabilities"] as? JsonObject
        val declarations = mutableListOf<Boolean>()
        for (fields in listOfNotNull(row, caps)) {
            for (key in listOf("vision", "supports_vision", "supports_image_input", "image_input", "image")) {
                (fields[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull?.let(declarations::add)
            }
        }
        val inputs = listOf(row["input_modalities"], row["input"], (row["modalities"] as? JsonObject)?.get("input"),
            caps?.get("input_modalities"), caps?.get("input"), (caps?.get("modalities") as? JsonObject)?.get("input"),
            (row["architecture"] as? JsonObject)?.get("input_modalities"))
        for (value in inputs) {
            val array = value as? JsonArray ?: continue
            val words = array.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.lowercase() }
            if (words.isEmpty() || words.size != array.size || words.any { it !in setOf("text", "image", "images", "vision", "audio", "video", "file") }) continue
            declarations.add(words.any { it in setOf("image", "images", "vision") })
        }
        return if (declarations.isEmpty() || declarations.distinct().size != 1) "unknown" else if (declarations.first()) "yes" else "no"
    }
    val rows: List<Pair<String?, JsonElement>> = when (val data = root["data"] ?: root["models"]) {
        is JsonArray -> data.map { null to it }
        is JsonObject -> data.entries.map { it.key to it.value }
        else -> throw AiFailure("invalid_response", status)
    }
    return rows.mapNotNull { (alias, value) ->
        val row = value as? JsonObject ?: return@mapNotNull null
        val id = (alias ?: (row["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content)?.trim() ?: return@mapNotNull null
        if (id.isEmpty() || id.length > 200 || id.any { it < ' ' }) return@mapNotNull null
        AiModel(id, image(row))
    }.distinctBy { it.id }.take(2000)
}
