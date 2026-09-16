package io.github.openfinalshell.android.core.ai

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Test
import kotlin.test.*

class AiClientTest {
    private fun server() = MockWebServer().apply { start(java.net.InetAddress.getByName("127.0.0.1"), 0) }
    private fun profile(server: MockWebServer, id: String) = AiProfile(id,"test","http://127.0.0.1:${server.port}/v1","custom-model")
    private fun client(server: MockWebServer) = AiClient { id -> profile(server,id) to "token-never-log" }
    private fun reply(body: String, code: Int = 200, type: String = "application/json") =
        MockResponse().setResponseCode(code).setHeader("Content-Type",type).setBody(body)
    // Leave a body open after sending real headers/data, so cancellation must interrupt its read.
    private fun pendingStream(prefix: String = ": waiting\n\n") =
        reply(prefix,type="text/event-stream").setHeader("Content-Length",prefix.toByteArray().size + 1000)

    @Test fun sharesModelFixtureWithDesktop() {
        val file = listOf(java.io.File("../../shared-schema/fixtures/ai-model-inputs.json"), java.io.File("shared-schema/fixtures/ai-model-inputs.json"))
            .first { it.exists() }
        val fixture = Json.parseToJsonElement(file.readText()).jsonObject
        val expected = fixture["expected"]!!.jsonArray.map { AiModel(it.jsonObject["id"]!!.jsonPrimitive.content,it.jsonObject["image"]!!.jsonPrimitive.content) }
        assertEquals(expected,parseModels(fixture["payload"]!!.jsonObject))
    }
    @Test fun urlMatchesDesktop() {
        assertEquals("https://api.openai.com/v1", AiClient.normalizeUrl("https://api.openai.com/"))
        assertEquals("https://api.deepseek.com/v1", AiClient.normalizeUrl("https://api.deepseek.com/v1/?query=remove#fragment"))
        assertEquals("https://gateway.example/custom", AiClient.normalizeUrl("https://gateway.example/custom///"))
        assertEquals("http://[::1]:5000/v1", AiClient.normalizeUrl("http://[::1]:5000"))
        for (value in listOf("", "http://example.com", "https://user:secret@example.com", "file:///secret", "javascript:alert(1)")) {
            assertFailsWith<AiFailure> { AiClient.normalizeUrl(value) }
        }
    }
    @Test fun jsonAndStreamingUseOneCredentialSnapshot() = runBlocking {
        var resolutions = 0
        server().use { server ->
            server.enqueue(reply("""{"choices":[{"message":{"content":"answer"}}]}"""))
            server.enqueue(reply("data: {\"choices\":[\r\ndata: {\"delta\":{\"content\":\"你好\"}}]}\r\n\r\ndata: [DONE]",type="text/event-stream"))
            val service = AiClient { id -> resolutions++; profile(server,id) to "token-never-log" }
            try {
                assertEquals(listOf(AiEvent.Delta("answer"), AiEvent.Completed), service.chat("a","p","question",false).toList())
                assertEquals(listOf(AiEvent.Delta("你好"), AiEvent.Completed), service.chat("b","p","question",true).toList())
                assertEquals(2, resolutions)
                for (stream in listOf(false,true)) {
                    val request=assertNotNull(server.takeRequest(3,TimeUnit.SECONDS))
                    assertEquals("/v1/chat/completions",request.path)
                    assertEquals("Bearer token-never-log",request.getHeader("Authorization"))
                    val payload=Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                    assertEquals("custom-model",payload["model"]?.jsonPrimitive?.content)
                    assertEquals(stream,payload["stream"]?.jsonPrimitive?.boolean)
                }
            } finally { service.close() }
        }
    }
    @Test fun modelMetadataDoesNotGuessAndPreservesRouteAliases() {
        val root = Json.parseToJsonElement("""{"models":{"alias":{"id":"canonical","input_modalities":["text","image"]},"gpt-vision":{"id":"x"},"no":{"capabilities":{"vision":false}},"conflict":{"vision":true,"input":["text"]}}}""").jsonObject
        assertEquals(listOf(AiModel("alias","yes"),AiModel("gpt-vision"),AiModel("no","no"),AiModel("conflict")), parseModels(root))
    }
    @Test fun errorsNeverReflectUpstreamSecrets() = runBlocking {
        server().use { server ->
            val service=client(server)
            try {
                for (status in listOf(401,403,404,429,503)) {
                    server.enqueue(reply("token-never-log prompt-never-log",status))
                    val error=assertFailsWith<AiFailure> { service.chat("a","p","secret question",false).toList() }
                    assertEquals(status,error.status)
                    assertFalse(error.toString().contains("token-never-log"))
                    assertFalse(error.toString().contains("secret question"))
                }
            } finally { service.close() }
        }
    }
    @Test fun malformedSuccessDoesNotPassConnectionTest() = runBlocking {
        server().use { server ->
            server.enqueue(reply("""{"error":{"message":"token-never-log"}}"""))
            val service=client(server)
            try {
                val error=assertFailsWith<AiFailure> { service.test("p") }
                assertEquals("invalid_response",error.code); assertEquals(200,error.status)
            } finally { service.close() }
        }
    }
    @Test fun validatesContextAndTokenBeforeNetworkAndDoesNotLeakHeaderErrors() = runBlocking {
        val service=AiClient { id -> AiProfile(id,"test","https://example.invalid/v1","model") to "private-token-\u00e9" }
        try {
            assertEquals("context_limit",assertFailsWith<AiFailure> { service.chat("a","p","x".repeat(32769),true).toList() }.code)
            val error=assertFailsWith<AiFailure> { service.test("p") }
            assertEquals("invalid_token",error.code)
            assertFalse(error.toString().contains("private-token"))
        } finally { service.close() }
    }
    @Test fun concurrentIdsAndLimitAreIsolated() = runBlocking {
        server().use { server ->
            repeat(4) { server.enqueue(pendingStream()) }
            val service=client(server)
            try { supervisorScope {
                val jobs=(0..3).map { n -> async { runCatching { service.chat("id$n","p","q",true).toList() } } }
                withContext(Dispatchers.IO) { repeat(4) { assertNotNull(server.takeRequest(5,TimeUnit.SECONDS)) } }
                assertEquals("busy",assertFailsWith<AiFailure> { service.chat("id0","p","q",true).toList() }.code)
                assertEquals("busy",assertFailsWith<AiFailure> { service.chat("fifth","p","q",true).toList() }.code)
                (0..3).forEach { service.cancel("id$it") }
                withTimeout(5000) { jobs.forEach { assertTrue(it.await().isFailure) } }
            } } finally { service.close() }
        }
    }
    @Test fun cancelAfterHeadersInterruptsBodyAndReleasesRequestId() = runBlocking {
        server().use { server ->
            server.enqueue(pendingStream("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"))
            server.enqueue(reply("""{"data":[{"id":"still-usable"}]}"""))
            val reading=CompletableDeferred<Unit>()
            val service=client(server)
            try {
                val task=launch { service.chat("a","p","question",true).collect { if(it is AiEvent.Delta) reading.complete(Unit) } }
                withTimeout(3000) { reading.await() }
                withTimeout(3000) { task.cancelAndJoin() }
                assertEquals(listOf(AiModel("still-usable")),service.models("p"))
            } finally { service.close() }
        }
    }
    @Test fun timeoutAndTruncatedStreamFailClearly() = runBlocking {
        server().use { server ->
            server.enqueue(pendingStream())
            server.enqueue(reply("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",type="text/event-stream"))
            val service=AiClient.withHttpClient({ id -> profile(server,id) to "token" },
                OkHttpClient.Builder().readTimeout(150,TimeUnit.MILLISECONDS).build())
            try {
                assertEquals("timeout",assertFailsWith<AiFailure> { service.chat("a","p","q",true).toList() }.code)
                assertEquals("incomplete_response",assertFailsWith<AiFailure> { service.chat("a","p","q",true).toList() }.code)
            } finally { service.close() }
        }
    }
}
