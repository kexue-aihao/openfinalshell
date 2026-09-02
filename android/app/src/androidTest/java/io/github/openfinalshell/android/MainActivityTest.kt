package io.github.openfinalshell.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun showsPrimaryNavigation() {
        val activity = composeRule.activity
        listOf(
            R.string.tab_connections,
            R.string.tab_terminal,
            R.string.tab_sftp,
            R.string.tab_monitor,
            R.string.nav_more
        ).forEach { label ->
            composeRule.onNodeWithContentDescription(activity.getString(label)).assertIsDisplayed()
        }
    }
}
