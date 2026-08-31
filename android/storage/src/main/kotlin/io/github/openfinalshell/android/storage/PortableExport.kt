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

data class StorageExportSnapshot(
    val profiles: List<ConnectionProfile>,
    val forwards: List<ForwardRule> = emptyList(),
    val groups: List<ConnectionGroupEntity> = emptyList(),
    val proxies: List<SavedProxyEntity> = emptyList(),
    val privateKeys: List<PrivateKeyEntity> = emptyList(),
    val knownHosts: List<KnownHostEntity> = emptyList(),
    val secretValues: Map<String, String> = emptyMap(),
    val settings: JsonObject? = null
)

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
        appVersion: String = "android",
        groups: List<ConnectionGroupEntity> = emptyList(),
        proxies: List<SavedProxyEntity> = emptyList(),
        privateKeys: List<PrivateKeyEntity> = emptyList(),
        knownHosts: List<KnownHostEntity> = emptyList()
    ): String {
        val data = buildData(profiles, forwards, settings, groups, proxies, privateKeys, knownHosts)
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

    /** Builds a portable export from all Android repositories, including reusable references. */
    suspend fun buildV1FromStorage(
        profiles: ProfileRepository,
        forwards: ForwardRepository,
        groups: ConnectionGroupRepository,
        proxies: SavedProxyRepository,
        privateKeys: PrivateKeyRepository,
        knownHosts: KnownHostRepository,
        credentials: AndroidCredentialStore,
        includeSecrets: Boolean = false,
        passphrase: CharArray? = null,
        settings: JsonObject? = null,
        appVersion: String = "android"
    ): String {
        val snapshot = collectStorage(profiles, forwards, groups, proxies, privateKeys, knownHosts, credentials, settings)
        return buildV1(
            snapshot.profiles,
            snapshot.forwards,
            snapshot.settings,
            includeSecrets,
            snapshot.secretValues,
            passphrase,
            appVersion,
            snapshot.groups,
            snapshot.proxies,
            snapshot.privateKeys,
            snapshot.knownHosts
        )
    }

    fun buildV2(
        profiles: List<ConnectionProfile>,
        forwards: List<ForwardRule> = emptyList(),
        settings: JsonObject? = null,
        passphrase: CharArray,
        secretValues: Map<String, String> = emptyMap(),
        appVersion: String = "android",
        groups: List<ConnectionGroupEntity> = emptyList(),
        proxies: List<SavedProxyEntity> = emptyList(),
        privateKeys: List<PrivateKeyEntity> = emptyList(),
        knownHosts: List<KnownHostEntity> = emptyList()
    ): String {
        val blob = buildJsonObject {
            put("data", buildData(profiles, forwards, settings, groups, proxies, privateKeys, knownHosts))
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

    /** Builds a fully encrypted export from all Android repositories. */
    suspend fun buildV2FromStorage(
        profiles: ProfileRepository,
        forwards: ForwardRepository,
        groups: ConnectionGroupRepository,
        proxies: SavedProxyRepository,
        privateKeys: PrivateKeyRepository,
        knownHosts: KnownHostRepository,
        credentials: AndroidCredentialStore,
        passphrase: CharArray,
        includeSecrets: Boolean = true,
        settings: JsonObject? = null,
        appVersion: String = "android"
    ): String {
        val snapshot = collectStorage(profiles, forwards, groups, proxies, privateKeys, knownHosts, credentials, settings)
        return buildV2(
            snapshot.profiles,
            snapshot.forwards,
            snapshot.settings,
            passphrase,
            if (includeSecrets) snapshot.secretValues else emptyMap(),
            appVersion,
            snapshot.groups,
            snapshot.proxies,
            snapshot.privateKeys,
            snapshot.knownHosts
        )
    }

    private suspend fun collectStorage(
        profiles: ProfileRepository,
        forwards: ForwardRepository,
        groups: ConnectionGroupRepository,
        proxies: SavedProxyRepository,
        privateKeys: PrivateKeyRepository,
        knownHosts: KnownHostRepository,
        credentials: AndroidCredentialStore,
        settings: JsonObject?
    ): StorageExportSnapshot {
        val profileRows = profiles.list()
        val forwardRows = forwards.list().map { ForwardRule(it.id, it.profileId, it.type, it.label, it.bindAddr, it.bindPort, it.dstHost, it.dstPort, it.autoStart) }
        val groupRows = groups.list()
        val proxyRows = proxies.list()
        val keyRows = privateKeys.list()
        val hostRows = knownHosts.list()
        val refs = buildSet {
            profileRows.forEach { profile ->
                profile.auth.passwordRef?.let(::add)
                profile.auth.passphraseRef?.let(::add)
                profile.proxy?.passwordRef?.let(::add)
            }
            proxyRows.mapNotNullTo(this) { it.passwordRef }
            keyRows.mapNotNullTo(this) { it.passphraseRef }
        }
        val secrets = refs.mapNotNull { ref -> credentials.get(ref)?.let { ref to it } }.toMap()
        return StorageExportSnapshot(profileRows, forwardRows, groupRows, proxyRows, keyRows, hostRows, secrets, settings)
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
        val notes = mutableListOf<String>()
        val groupElements = root["groups"]?.jsonArray ?: JsonArray(emptyList())
        for (element in groupElements) {
            if (element !is JsonObject) { invalid++; continue }
            val value = element
            val id = value["id"]?.jsonPrimitive?.contentOrNull
            val name = value["name"]?.jsonPrimitive?.contentOrNull
            if (id == null || name == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && groups.find(id) != null) { skipped++; continue }
            val targetId = if (conflict == ImportConflict.DUPLICATE) java.util.UUID.randomUUID().toString() else id
            groups.upsert(ConnectionGroupEntity(targetId, name, value["parentId"]?.jsonPrimitive?.contentOrNull, value["order"]?.jsonPrimitive?.doubleOrNull ?: 0.0))
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
            val targetId = if (conflict == ImportConflict.DUPLICATE) java.util.UUID.randomUUID().toString() else id
            val passwordRef = value["passwordRef"]?.jsonPrimitive?.contentOrNull?.takeIf { secretMap.containsKey(it) }
            if (value["passwordRef"] != null && passwordRef == null) {
                notes += "代理 $name 的密码未包含在导出文件中，需要重新录入"
            }
            proxies.upsert(SavedProxyEntity(targetId, name, type, host, port, value["username"]?.jsonPrimitive?.contentOrNull, passwordRef, value["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L, value["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L))
            proxyCount++
        }
        val keyElements = root["privateKeys"]?.jsonArray ?: JsonArray(emptyList())
        for (element in keyElements) {
            if (element !is JsonObject) { invalid++; continue }
            val value = element
            val id = value["id"]?.jsonPrimitive?.contentOrNull
            val name = value["name"]?.jsonPrimitive?.contentOrNull
            val path = (value["path"] ?: value["originalPath"])?.jsonPrimitive?.contentOrNull
            if (id == null || name == null || path == null) {
                if (value.containsKey("materialRef")) notes += "私钥 $name 的 Windows DPAPI/materialRef 无法在 Android 导入"
                invalid++
                continue
            }
            if (conflict == ImportConflict.SKIP && privateKeys.find(id) != null) { skipped++; continue }
            if (value.containsKey("materialRef")) {
                notes += "私钥 $name 的 materialRef 是桌面端本机密文，Android 未导入私钥材料；请重新选择私钥文件"
            }
            val existing = privateKeys.find(id)
            val passphraseRef = value["passphraseRef"]?.jsonPrimitive?.contentOrNull?.takeIf { secretMap.containsKey(it) }
            if (value["passphraseRef"] != null && passphraseRef == null) {
                notes += "私钥 $name 的口令未包含在导出文件中，需要重新录入"
            }
            // A portable export intentionally omits key bytes. Never re-use an existing local
            // Keystore reference for overwrite/duplicate imports, or a profile could silently
            // authenticate with a different private key than the imported metadata describes.
            if (conflict == ImportConflict.OVERWRITE) {
                existing?.materialRef?.let { credentials.delete(it) }
            }
            privateKeys.upsert(
                PrivateKeyEntity(
                    id = if (conflict == ImportConflict.DUPLICATE) java.util.UUID.randomUUID().toString() else id,
                    name = name,
                    originalPath = path,
                    sha256 = value["sourceFingerprint"]?.jsonPrimitive?.contentOrNull ?: "",
                    passphraseRef = passphraseRef,
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
            val targetKey = if (conflict == ImportConflict.DUPLICATE) "$key:${java.util.UUID.randomUUID()}" else key
            knownHosts.trust(KnownHostEntity(targetKey, keyType, fingerprint, value["addedAt"]?.jsonPrimitive?.longOrNull ?: 0L))
            hostCount++
        }
        val profileElements = root["profiles"]?.jsonArray ?: JsonArray(emptyList())
        for (element in profileElements) {
            if (element !is JsonObject) { invalid++; continue }
            val raw = element
            val parsed = runCatching { ProtocolJson.instance.decodeFromJsonElement(ConnectionProfile.serializer(), raw) }.getOrNull()
            if (parsed == null) { invalid++; continue }
            if (conflict == ImportConflict.SKIP && profiles.find(parsed.id) != null) { skipped++; continue }
            val sanitized = clearUnavailableSecretRefs(raw, secretMap, notes)
            profiles.upsertImported(sanitized, if (conflict == ImportConflict.DUPLICATE) java.util.UUID.randomUUID().toString() else parsed.id)
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
        return PortableImportResult(profileCount, groupCount, proxyCount, keyCount, forwardCount, hostCount, secretCount, skipped, invalid, notes)
    }

    private fun clearUnavailableSecretRefs(
        raw: JsonObject,
        secretMap: Map<String, String>,
        notes: MutableList<String>
    ): JsonObject {
        val root = raw.toMutableMap()
        val auth = raw["auth"]?.jsonObject?.toMutableMap()
        val authRefs = listOf("passwordRef", "passphraseRef")
        if (auth != null) {
            authRefs.forEach { name ->
                val ref = auth[name]?.jsonPrimitive?.contentOrNull
                if (ref != null && !secretMap.containsKey(ref)) {
                    auth.remove(name)
                    notes += "连接的 $name 未包含在导出文件中，需要重新录入"
                }
            }
            root["auth"] = JsonObject(auth)
        }
        val proxy = raw["proxy"]?.jsonObject?.toMutableMap()
        val proxyRef = proxy?.get("passwordRef")?.jsonPrimitive?.contentOrNull
        if (proxy != null && proxyRef != null && !secretMap.containsKey(proxyRef)) {
            proxy.remove("passwordRef")
            notes += "连接代理密码未包含在导出文件中，需要重新录入"
            root["proxy"] = JsonObject(proxy)
        }
        return JsonObject(root)
    }

    private fun buildData(
        profiles: List<ConnectionProfile>,
        forwards: List<ForwardRule>,
        settings: JsonObject?,
        groups: List<ConnectionGroupEntity> = emptyList(),
        proxies: List<SavedProxyEntity> = emptyList(),
        privateKeys: List<PrivateKeyEntity> = emptyList(),
        knownHosts: List<KnownHostEntity> = emptyList()
    ): JsonObject = buildJsonObject {
        put("profiles", JsonArray(profiles.map { ProtocolJson.instance.encodeToJsonElement(ConnectionProfile.serializer(), it) }))
        put("forwards", JsonArray(forwards.map { ProtocolJson.instance.encodeToJsonElement(ForwardRule.serializer(), it) }))
        put("groups", JsonArray(groups.map { group -> buildJsonObject {
            put("id", group.id)
            put("name", group.name)
            group.parentId?.let { put("parentId", it) }
            put("order", group.sortOrder)
        } }))
        put("proxies", JsonArray(proxies.map { proxy -> buildJsonObject {
            put("id", proxy.id)
            put("name", proxy.name)
            put("type", proxy.type)
            put("host", proxy.host)
            put("port", proxy.port)
            proxy.username?.let { put("username", it) }
            proxy.passwordRef?.let { put("passwordRef", it) }
            put("createdAt", proxy.createdAt)
            put("updatedAt", proxy.updatedAt)
        } }))
        // The managed materialRef is local to Android Keystore and is deliberately omitted.
        put("privateKeys", JsonArray(privateKeys.map { key -> buildJsonObject {
            put("id", key.id)
            put("name", key.name)
            key.originalPath?.let { put("path", it) }
            put("sourceFingerprint", key.sha256)
            key.passphraseRef?.let { put("passphraseRef", it) }
            put("createdAt", key.createdAt)
            put("updatedAt", key.updatedAt)
        } }))
        put("knownHosts", JsonArray(knownHosts.map { host -> buildJsonObject {
            put("key", host.key)
            put("keyType", host.keyType)
            put("fingerprintSha256", host.fingerprintSha256)
            put("addedAt", host.addedAt)
        } }))
        settings?.let { put("settings", it) }
    }

    private fun decodeSecrets(bytes: ByteArray): Map<String, String> =
        ProtocolJson.instance.decodeFromString<Map<String, String>>(bytes.toString(Charsets.UTF_8))

    private fun requireSecretPassphrase(passphrase: CharArray?, values: Map<String, String>): CharArray =
        passphrase ?: error("a passphrase is required when exporting secrets (${values.size} values)")
}

enum class ImportConflict { SKIP, OVERWRITE, DUPLICATE }
