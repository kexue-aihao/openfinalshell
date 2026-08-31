package io.github.openfinalshell.android.core.lansync

import io.github.openfinalshell.android.core.protocol.FrameCodec
import io.github.openfinalshell.android.core.protocol.SyncFrame
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import javax.crypto.KeyAgreement
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.bouncycastle.jce.provider.BouncyCastleProvider

data class LanSyncApplyResult(
    val profiles: Int = 0,
    val snippets: Int = 0,
    val forwards: Int = 0,
    val knownHosts: Int = 0,
    val secrets: Int = 0,
    val skipped: Int = 0
)

/** X25519 JCA adapter. The BC provider keeps this available on API 26 devices. */
private object X25519 {
    // Resolve the provider by instance. Android devices can expose an incompatible provider
    // under the same "BC" name, so a name-based lookup is not safe for LAN Sync.
    private val provider = BouncyCastleProvider()

    fun generate(): KeyPair = KeyPairGenerator.getInstance("X25519", provider).generateKeyPair()

    fun shared(privateKey: PrivateKey, peerPublicDer: ByteArray): ByteArray {
        val peer = KeyFactory.getInstance("X25519", provider).generatePublic(X509EncodedKeySpec(peerPublicDer))
        return KeyAgreement.getInstance("X25519", provider).run {
            init(privateKey)
            doPhase(peer, true)
            generateSecret()
        }
    }
}

/** Length-prefixed LAN Sync handshake, compatible with the desktop protocol.ts implementation. */
class LanSyncSession(private val socket: Socket) {
    private val bufferedFrames = ArrayDeque<SyncFrame>()
    suspend fun send(
        deviceId: String,
        deviceName: String,
        appVersion: String,
        pairingCode: CharArray,
        envelope: String? = null,
        envelopeFactory: (suspend (channelPassphrase: CharArray) -> String)? = null
    ): LanSyncApplyResult = withContext(Dispatchers.IO) {
        val keys = X25519.generate()
        val senderPub = keys.public.encoded
        val codec = FrameCodec()
        val input = socket.getInputStream()
        val output = socket.getOutputStream()
        write(output, codec, SyncFrame("hello", magic = LanSyncConstants.MAGIC, proto = LanSyncConstants.PROTOCOL, deviceId = deviceId, deviceName = deviceName, appVersion = appVersion, senderPub = b64(senderPub)))
        val ack = read(input, codec).also { require(it.kind == "hello-ack") { "expected hello-ack" } }
        val receiverPub = fromB64(requireNotNull(ack.receiverPub))
        val salt = fromB64(requireNotNull(ack.salt))
        val sessionId = requireNotNull(ack.sessionId)
        val transcript = transcript(senderPub, receiverPub, salt, sessionId)
        val pairKey = LanSyncCrypto.derivePairKey(pairingCode, X25519.shared(keys.private, receiverPub), salt, transcript)
        write(output, codec, SyncFrame("confirm-s", mac = b64(LanSyncCrypto.confirmationMac(pairKey, "sender", transcript))))
        val confirm = read(input, codec).also { require(it.kind == "confirm-r") { "pairing rejected" } }
        require(LanSyncCrypto.constantTimeEquals(fromB64(requireNotNull(confirm.mac)), LanSyncCrypto.confirmationMac(pairKey, "receiver", transcript))) { "pairing code rejected" }
        codec.setMaxBytes(LanSyncConstants.MAX_FRAME_BYTES)
        val channelPassphrase = Base64.getUrlEncoder().withoutPadding().encodeToString(pairKey).toCharArray()
        val payload = try {
            envelopeFactory?.invoke(channelPassphrase) ?: envelope ?: error("LAN Sync payload is missing")
        } finally {
            channelPassphrase.fill('\u0000')
        }
        write(output, codec, SyncFrame("payload", envelope = payload))
        require(read(input, codec).kind == "received") { "payload was not received" }
        val applied = read(input, codec)
        if (applied.kind == "rejected") return@withContext LanSyncApplyResult()
        require(applied.kind == "applied") { "invalid apply response" }
        LanSyncApplyResult(applied.profiles ?: 0, applied.snippets ?: 0, applied.forwards ?: 0, applied.knownHosts ?: 0, applied.secrets ?: 0, applied.skipped ?: 0)
    }

    suspend fun receive(
        deviceId: String,
        deviceName: String,
        appVersion: String,
        pairingCode: CharArray,
        apply: suspend (envelope: String, channelPassphrase: CharArray) -> LanSyncApplyResult
    ): LanSyncApplyResult = withContext(Dispatchers.IO) {
        val codec = FrameCodec()
        val input = socket.getInputStream()
        val output = socket.getOutputStream()
        val hello = read(input, codec).also { require(it.kind == "hello" && it.magic == LanSyncConstants.MAGIC && it.proto == LanSyncConstants.PROTOCOL) { "expected hello" } }
        val senderPub = fromB64(requireNotNull(hello.senderPub))
        val keys = X25519.generate()
        val receiverPub = keys.public.encoded
        val salt = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
        val sessionId = UUID.randomUUID().toString()
        val transcript = transcript(senderPub, receiverPub, salt, sessionId)
        write(output, codec, SyncFrame("hello-ack", deviceId = deviceId, deviceName = deviceName, appVersion = appVersion, receiverPub = b64(receiverPub), salt = b64(salt), sessionId = sessionId))
        val pairKey = LanSyncCrypto.derivePairKey(pairingCode, X25519.shared(keys.private, senderPub), salt, transcript)
        val confirm = read(input, codec).also { require(it.kind == "confirm-s") { "expected confirm-s" } }
        require(LanSyncCrypto.constantTimeEquals(fromB64(requireNotNull(confirm.mac)), LanSyncCrypto.confirmationMac(pairKey, "sender", transcript))) { "pairing code rejected" }
        write(output, codec, SyncFrame("confirm-r", mac = b64(LanSyncCrypto.confirmationMac(pairKey, "receiver", transcript))))
        codec.setMaxBytes(LanSyncConstants.MAX_FRAME_BYTES)
        val payload = read(input, codec).also { require(it.kind == "payload" && !it.envelope.isNullOrBlank()) { "expected payload" } }
        write(output, codec, SyncFrame("received"))
        val channelPassphrase = Base64.getUrlEncoder().withoutPadding().encodeToString(pairKey).toCharArray()
        val result = try {
            apply(requireNotNull(payload.envelope), channelPassphrase)
        } finally {
            channelPassphrase.fill('\u0000')
        }
        write(output, codec, SyncFrame("applied", profiles = result.profiles, snippets = result.snippets, forwards = result.forwards, knownHosts = result.knownHosts, secrets = result.secrets, skipped = result.skipped))
        result
    }

    private fun read(input: InputStream, codec: FrameCodec): SyncFrame {
        bufferedFrames.removeFirstOrNull()?.let { return it }
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) error("LAN Sync connection closed")
            val frames = codec.feed(buffer.copyOf(count))
            if (frames.isNotEmpty()) {
                bufferedFrames.addAll(frames.drop(1))
                return frames.first()
            }
        }
    }

    private fun write(output: OutputStream, codec: FrameCodec, frame: SyncFrame) {
        output.write(codec.encode(frame))
        output.flush()
    }

    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun fromB64(value: String): ByteArray = Base64.getDecoder().decode(value)

    private fun transcript(sender: ByteArray, receiver: ByteArray, salt: ByteArray, sessionId: String): ByteArray {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        listOf(sender, receiver, salt, sessionId.toByteArray(Charsets.UTF_8)).forEach { part ->
            digest.update(ByteBuffer.allocate(4).putInt(part.size).array())
            digest.update(part)
        }
        return digest.digest()
    }
}
