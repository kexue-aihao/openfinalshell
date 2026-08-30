package io.github.openfinalshell.android.storage

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import io.github.openfinalshell.android.core.protocol.ProtocolJson

@Serializable
data class ExportEnvelope(
    val app: String,
    val formatVersion: Int,
    val appVersion: String,
    val exportedAt: Long,
    val includesSecrets: Boolean,
    val note: String,
    val data: JsonObject? = null,
    val secrets: SealedBlock? = null,
    val enc: SealedBlock? = null
)

/** Import/export facade. It preserves v1/v2 field names and never imports materialRef. */
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
}
