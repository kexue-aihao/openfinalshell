package io.github.openfinalshell.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateModelsTest {
    @Test
    fun semverOrdersStableAndPrereleaseVersions() {
        assertTrue(SemVersion.parse("v0.20.8")!! > SemVersion.parse("0.20.7")!!)
        assertTrue(SemVersion.parse("1.0.0")!! > SemVersion.parse("1.0.0-rc.1")!!)
        assertTrue(SemVersion.parse("1.0.0-rc.2")!! > SemVersion.parse("1.0.0-rc.1")!!)
        assertNull(SemVersion.parse("release-latest"))
    }

    @Test
    fun selectorPrefersDeviceAbiAndFallsBackToUniversal() {
        val release = release(
            "OpenFinalShell-0.20.8-android-universal.apk",
            "OpenFinalShell-0.20.8-android-arm64-v8a.apk"
        )
        assertEquals("arm64-v8a", UpdateAssetSelector.select(release, arrayOf("arm64-v8a"))!!.abi)
        assertEquals("universal", UpdateAssetSelector.select(release, arrayOf("x86"))!!.abi)
    }

    @Test
    fun checksumParserAcceptsCommonSha256sumFormats() {
        val digest = "a".repeat(64)
        val checksums = "$digest  OpenFinalShell-0.20.8-android-universal.apk\n"
        assertEquals(digest, ChecksumParser.findSha256(checksums, "OpenFinalShell-0.20.8-android-universal.apk"))
        assertEquals(digest, ChecksumParser.findSha256("$digest *file.apk", "file.apk"))
    }

    private fun release(vararg assets: String) = AndroidRelease(
        tagName = "v0.20.8",
        versionName = "0.20.8",
        name = "",
        body = "",
        publishedAt = null,
        assets = assets.map { ReleaseAsset(it, "https://example.invalid/$it", 1) }
    )
}
