package io.github.openfinalshell.android.update

import android.app.PendingIntent
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidPackageInstallerTest {
    @Test
    fun `uses a mutable status callback on Android 12 and newer`() {
        val flags = AndroidPackageInstaller.statusReceiverFlags(Build.VERSION_CODES.S)

        assertTrue(flags and PendingIntent.FLAG_UPDATE_CURRENT != 0)
        assertTrue(flags and PendingIntent.FLAG_MUTABLE != 0)
        assertEquals(0, flags and PendingIntent.FLAG_IMMUTABLE)
    }

    @Test
    fun `does not require a mutability flag before Android 12`() {
        val flags = AndroidPackageInstaller.statusReceiverFlags(Build.VERSION_CODES.R)

        assertTrue(flags and PendingIntent.FLAG_UPDATE_CURRENT != 0)
        assertEquals(0, flags and PendingIntent.FLAG_MUTABLE)
        assertEquals(0, flags and PendingIntent.FLAG_IMMUTABLE)
    }
}
