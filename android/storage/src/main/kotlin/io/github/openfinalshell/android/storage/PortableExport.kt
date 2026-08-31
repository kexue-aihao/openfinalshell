package io.github.openfinalshell.android.storage

import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.ForwardRule
import io.github.openfinalshell.android.core.protocol.ProtocolJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

@Serializable
data class ExportEnvelope(
    val app: String,
    val formatVersion: Int,
    val appVersion: String,
    val exportedAt: Long,
    val includesSecrets: Boolean,
    val note: String = "",
    val data: JsonObject? = null,
    val secrets: SealedBlock? = null,
    val enc: SealedBlock? = null
)

data class PortableImportResult(
    val profiles: Int,
    val groups: Int,
    val proxies: Int,
    val privateKeys: Int,
    val forwards: Int,
    val knownHosts: Int,
    val secrets: Int,
    val skipped: Int,
    val invalid: Int,
    val notes: List<String> = emptyList()
)

/**
 * Portable v1/v2 envelope support. The storage mapping is deliberately conservative: unknown
 * records are counted as invalid and managed private-key material is never emitted.
 */
object PortableExport {
    fun parse(text: String): ExportEnvelope = ProtocolJson.instance.decodeFromString(text)

    fun decrypt(envelope: ExportEnvelope, passphrase: CharArray): JsonElement {
        require(envelope.app == "openfinalshell") { "unsupported export application" }
        return when (envelope.formatVersion) {
            1 -> envelope.data ?: error("v1 export has no data")
            2 -> {
                val block = envelope.enc ?: error("v2 export has no encrypted payload")
                ProtocolJson.instance.parseToJsonElement(
                    ImportExportCrypto.open(block, passphrase).toString(Charsets.UTF_8)
                )
            }
            else -> error("unsupported export format version: ${envelope.formatVersion}")
        }
    }

    fun buildV1(
        profiles: List<ConnectionProfile>,
        forwards: List<ForwardRule> = emptyList(),
        settings: JsonObject? = null,
        includeSecrets: Boolean = false,
        secretValues: Map<String, String> = emptyMap(),
        passphrase: CharArray? = null,
        appVersion: String = "android"
    ): String {
        val data = buildData(profiles, forwards, settings)
        val secrets = if (includeSecrets) {
            ImportExportCrypto.seal(
                ProtocolJson.instance.encodeToString(
                    JsonObject.serializer(),
                    buildJsonObject { secretValues.forEach { (key, value) -> put(key, value) } }
                ).toByteArray(Charsets.UTF_8),
                requireSecretPassphrase(passphrase, secretValues)
            )
        } else null
        return ProtocolJson.instance.encodeToString(
            ExportEnvelope.serializer(),
            ExportEnvelope("openfinalshell", 1, appVersion, System.currentTimeMillis(), includeSecrets, data = data, secrets = secrets)
        )
    }

    fun buildV2(
        profiles: List<ConnectionProfile>,
        forwards: List<ForwardRule> = emptyList(),
        settings: JsonObject? = null,
        passphrase: CharArray,
        secretValues: Map<String, String> = emptyMap(),
        appVersion: String = "android"
    ): String {
        val blob = buildJsonObject {
            put("data", buildData(profiles, forwards, settings))
            put("secrets", buildJsonObject { secretValues.forEach { (key, value) -> put(key, value) } })
        }
        val block = ImportExportCrypto.seal(
            ProtocolJson.instance.encodeToString(JsonObject.serializer(), blob).toByteArray(Charsets.UTF_8),
            passphrase
        )
        return ProtocolJson.instance.encodeToString(
            ExportEnvelope.serializer(),
            ExportEnvelope("openfinalshell", 2, appVersion, System.currentTimeMillis(), secretValues.isNotEmpty(), enc = block)
        )
    }

    /** Apply a decrypted envelope to Room. The caller supplies repositories to keep this layer UI independent. */
    suspend fun importInto(
        envelope: ExportEnvelope,
        passphrase: CharArray?,
        profiles: ProfileRepository,
        forwards: ForwardRepository,
        groups: ConnectionGroupRepository,
        proxies: SavedProxyRepository,
        privateKeys: PrivateKeyRepository,
        knownHosts: KnownHostRepository,
        credentials: AndroidCredentialStore,
        conflict: ImportConflict = ImportConflict.SKIP
    ): PortableImportResult {
        require(envelope.app == "openfinalshell") { "unsupported export application" }
        val decryptedV2 = if (envelope.formatVersion == 2) {
            val key = passphrase ?: error("passphrase required")
            decrypt(envelope, key).jsonObject
        } else null
        val payload = when (envelope.formatVersion) {
            1 -> envelope.data ?: error("v1 export has no data")
            2 -> decryptedV2 ?: error("invalid v2 payload")
            else -> error("unsupported export format version: ${envelope.formatVersion}")
        }
        val secretMap = when {
            envelope.formatVersion == 1 && envelope.secrets != null ->
                if (passphrase == null) emptyMap()
                else decodeSecrets(ImportExportCrypto.open(envelope.secrets, passphrase))
            envelope.formatVersion == 2 -> decodeSecrets(
                ProtocolJson.instance.encodeToString(
                    JsonObject.serializer(),
                    decryptedV2?.get("secrets")?.jsonObject ?: JsonObject(emptyMap())
                ).toByteArray(Charsets.UTF_8)
            )
            else -> emptyMap()
        }
        val root = if (envelope.formatVersion == 2) {
            payload["data"]?.jsonObject ?: error("invalid v2 payload")
        } else payload.jsonObject
        var skipped = 0
        var invalid = 0
        var profileCount = 0
        var groupCount = 0
        var proxyCount = 0
        var keyCount = 0
        var hostCount = 0
        val groupElements = root["groups"]?.jsonArray ?: JsonArray(emptyList())
        for (element in groupElements) {
            if (element !is JsonObject) { invalid++; continue }
            val value = element
            val id = value["id"]?.jsonPrimitive?.contentOrNull
            val name = value["name"]?.jsonPrimitive?.contentOrNull
            if (id == null || name == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && groups.find(id) != null) { skipped++; continue }
            groups.upsert(ConnectionGroupEntity(id, name, value["parentId"]?.jsonPrimitive?.contentOrNull, value["order"]?.jsonPrimitive?.doubleOrNull ?: 0.0))
            groupCount++
        }
        val proxyElements = root["proxies"]?.jsonArray ?: JsonArray(emptyList())
        for (element in proxyElements) {
            if (element !is JsonObject) { invalid++; continue }
            val value = element
            val id = value["id"]?.jsonPrimitive?.contentOrNull
            val name = value["name"]?.jsonPrimitive?.contentOrNull
            val type = value["type"]?.jsonPrimitive?.contentOrNull
            val host = value["host"]?.jsonPrimitive?.contentOrNull
            val port = value["port"]?.jsonPrimitive?.intOrNull
            if (id == null || name == null || type == null || host == null || port == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && proxies.find(id) != null) { skipped++; continue }
            proxies.upsert(SavedProxyEntity(id, name, type, host, port, value["username"]?.jsonPrimitive?.contentOrNull, value["passwordRef"]?.jsonPrimitive?.contentOrNull, value["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L, value["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L))
            proxyCount++
        }
        val keyElements = root["privateKeys"]?.jsonArray ?: JsonArray(emptyList())
        for (element in keyElements) {
            if (element !is JsonObject) { invalid++; continue }
            val value = element
            val id = value["id"]?.jsonPrimitive?.contentOrNull
            val name = value["name"]?.jsonPrimitive?.contentOrNull
            val path = value["path"]?.jsonPrimitive?.contentOrNull
            if (id == null || name == null || path == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && privateKeys.find(id) != null) { skipped++; continue }
            // materialRef is intentionally discarded: it may contain Windows DPAPI data.
            privateKeys.upsert(
                PrivateKeyEntity(
                    id = id,
                    name = name,
                    originalPath = path,
                    sha256 = value["sourceFingerprint"]?.jsonPrimitive?.contentOrNull ?: "",
                    passphraseRef = value["passphraseRef"]?.jsonPrimitive?.contentOrNull,
                    materialRef = null,
                    createdAt = value["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                    updatedAt = value["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L
                )
            )
            keyCount++
        }
        val hostElements = root["knownHosts"]?.jsonArray ?: JsonArray(emptyList())
        for (element in hostElements) {
            if (element !is JsonObject) { invalid++; continue }
            val value = element
            val key = value["key"]?.jsonPrimitive?.contentOrNull
            val keyType = value["keyType"]?.jsonPrimitive?.contentOrNull
            val fingerprint = value["fingerprintSha256"]?.jsonPrimitive?.contentOrNull
            if (key == null || keyType == null || fingerprint == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && knownHosts.find(key) != null) { skipped++; continue }
            knownHosts.trust(KnownHostEntity(key, keyType, fingerprint, value["addedAt"]?.jsonPrimitive?.longOrNull ?: 0L))
            hostCount++
        }
        val profileElements = root["profiles"]?.jsonArray ?: JsonArray(emptyList())
        for (element in profileElements) {
            if (element !is JsonObject) { invalid++; continue }
            val raw = element
            val parsed = runCatching { ProtocolJson.instance.decodeFromJsonElement(ConnectionProfile.serializer(), raw) }.getOrNull()
            if (parsed == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && profiles.find(parsed.id) != null) { skipped++; continue }
            profiles.upsertImported(raw, if (conflict == ImportConflict.DUPLICATE) java.util.UUID.randomUUID().toString() else parsed.id)
            profileCount++
        }
        val forwardElements = root["forwards"]?.jsonArray ?: JsonArray(emptyList())
        var forwardCount = 0
        for (element in forwardElements) {
            val parsed = runCatching { ProtocolJson.instance.decodeFromJsonElement(ForwardRule.serializer(), element) }.getOrNull()
            if (parsed == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && forwards.find(parsed.id) != null) { skipped++; continue }
            forwards.upsert(parsed.copy(id = if (conflict == ImportConflict.DUPLICATE) java.util.UUID.randomUUID().toString() else parsed.id))
            forwardCount++
        }
        // Material refs from Windows are intentionally ignored; portable secret values are the only
        // values restored to Android Keystore, and no private-key bytes are imported implicitly.
        var secretCount = 0
        for ((ref, value) in secretMap) {
            credentials.put(value, ref)
            secretCount++
        }
        return PortableImportResult(profileCount, groupCount, proxyCount, keyCount, forwardCount, hostCount, secretCount, skipped, invalid)
    }

    private fun buildData(profiles: List<ConnectionProfile>, forwards: List<ForwardRule>, settings: JsonObject?): JsonObject = buildJsonObject {
        put("profiles", JsonArray(profiles.map { ProtocolJson.instance.encodeToJsonElement(ConnectionProfile.serializer(), it) }))
        put("forwards", JsonArray(forwards.map { ProtocolJson.instance.encodeToJsonElement(ForwardRule.serializer(), it) }))
        put("groups", JsonArray(emptyList()))
        put("proxies", JsonArray(emptyList()))
        put("privateKeys", JsonArray(emptyList()))
        put("knownHosts", JsonArray(emptyList()))
        settings?.let { put("settings", it) }
    }

    private fun decodeSecrets(bytes: ByteArray): Map<String, String> =
        ProtocolJson.instance.decodeFromString<Map<String, String>>(bytes.toString(Charsets.UTF_8))

    private fun requireSecretPassphrase(passphrase: CharArray?, values: Map<String, String>): CharArray =
        passphrase ?: error("a passphrase is required when exporting secrets (${values.size} values)")
}

enum class ImportConflict { SKIP, OVERWRITE, DUPLICATE }
