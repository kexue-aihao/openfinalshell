package io.github.openfinalshell.android.core.protocol

import io.github.openfinalshell.android.core.model.ConnectionProfile
import org.junit.Assert.assertEquals
import org.junit.Test

class RdpProfileCompatibilityTest {
    @Test
    fun `desktop rdp profile remains parseable without Android rdp implementation`() {
        val profile = ProtocolJson.instance.decodeFromString(
            ConnectionProfile.serializer(),
            """
            {
              "id": "rdp-1",
              "name": "Remote desktop",
              "protocol": "rdp",
              "host": "rdp.example",
              "port": 3389,
              "username": "alice",
              "auth": { "method": "password" },
              "rdp": {
                "domain": "CORP",
                "clipboard": true,
                "certificatePolicy": "prompt"
              }
            }
            """.trimIndent()
        )

        assertEquals("rdp", profile.protocol)
        assertEquals("rdp.example", profile.host)
        assertEquals(3389, profile.port)
    }
}
