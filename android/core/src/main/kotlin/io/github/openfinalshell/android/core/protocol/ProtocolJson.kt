package io.github.openfinalshell.android.core.protocol

import kotlinx.serialization.json.Json

object ProtocolJson {
    val instance: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }
}
