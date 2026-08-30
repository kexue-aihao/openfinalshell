package io.github.openfinalshell.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun showsConnectionTabs() {
        composeRule.onNodeWithText("OpenFinalShell").assertIsDisplayed()
        composeRule.onNodeWithText("Connections").assertIsDisplayed()
        composeRule.onNodeWithText("Terminal").assertIsDisplayed()
        composeRule.onNodeWithText("Monitor").assertIsDisplayed()
    }
}
