package io.github.openfinalshell.android.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tier the UI advertises has to match the tier the launcher can actually reach.
 *
 * These are the combinations a device can be in, checked without a device: `LocalTierAvailability`
 * is a plain data class, and every reachability rule the app acts on lives on it.
 */
class LocalTierAvailabilityTest {
    /** Shizuku is up at uid 0 — the configuration where the root tier is served by Shizuku. */
    private fun shizukuAsRoot(granted: Boolean = true, rootAllowed: Boolean = true) = LocalTierAvailability(
        shizuku = if (granted) null else ShizukuUnavailable.NO_PERMISSION,
        shizukuRunsAsRoot = true,
        hasRootBinary = false,
        rootAllowedBySettings = rootAllowed
    )

    @Test
    fun `shizuku root without the app's grant does not offer the root tier`() {
        // The tier binds a Shizuku user service, so an ungranted app would be told it is ready and
        // then fail inside the bind with a SecurityException. Worse, the only permission-request
        // button in the app is drawn from the blocker, so offering the tier here left the user with
        // no way to fix it from the card that failed.
        val availability = shizukuAsRoot(granted = false)

        assertFalse("a Shizuku-served root tier still needs Shizuku's permission", availability.rootAvailable)
        assertFalse(availability.adbAvailable)
        assertEquals(LocalTier.APP, availability.best())
        assertEquals(LocalTierBlocker.SHIZUKU_NO_PERMISSION, availability.blockerFor(LocalTier.ROOT))
    }

    @Test
    fun `shizuku root with the grant offers the root tier`() {
        val availability = shizukuAsRoot()

        assertTrue(availability.rootAvailable)
        assertEquals(LocalTier.ROOT, availability.best())
        assertTrue(availability.isAvailable(LocalTier.ROOT))
        assertNull(availability.blockerFor(LocalTier.ROOT))
    }

    @Test
    fun `a device with its own su does not depend on Shizuku`() {
        // The direct `su` path never touches Shizuku, so Shizuku's state must not gate it either.
        val availability = LocalTierAvailability(
            shizuku = ShizukuUnavailable.NOT_INSTALLED,
            shizukuRunsAsRoot = false,
            hasRootBinary = true,
            rootAllowedBySettings = true
        )

        assertTrue(availability.rootAvailable)
        assertEquals(LocalTier.ROOT, availability.best())
        assertNull(availability.blockerFor(LocalTier.ROOT))
    }

    @Test
    fun `the settings gate outranks everything else`() {
        val availability = shizukuAsRoot(rootAllowed = false)

        assertFalse(availability.rootAvailable)
        assertEquals(LocalTierBlocker.ROOT_DISABLED_BY_SETTINGS, availability.blockerFor(LocalTier.ROOT))
    }

    @Test
    fun `no su and no Shizuku root reports the missing binary`() {
        val availability = LocalTierAvailability(
            shizuku = null,
            shizukuRunsAsRoot = false,
            hasRootBinary = false,
            rootAllowedBySettings = true
        )

        assertFalse(availability.rootAvailable)
        assertEquals(LocalTierBlocker.NO_ROOT_BINARY, availability.blockerFor(LocalTier.ROOT))
        // The ADB tier is still reachable here, which is what `best` should fall back to.
        assertEquals(LocalTier.ADB, availability.best())
    }

    @Test
    fun `a missing helper is reported before any tier specific reason`() {
        val availability = shizukuAsRoot().copy(helperPresent = false)

        assertFalse(availability.rootAvailable)
        assertFalse(availability.adbAvailable)
        assertEquals(LocalTierBlocker.HELPER_MISSING, availability.blockerFor(LocalTier.ROOT))
        assertEquals(LocalTierBlocker.HELPER_MISSING, availability.blockerFor(LocalTier.ADB))
    }
}
