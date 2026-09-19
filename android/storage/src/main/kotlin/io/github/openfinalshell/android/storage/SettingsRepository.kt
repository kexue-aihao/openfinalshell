package io.github.openfinalshell.android.storage

import io.github.openfinalshell.android.core.protocol.ProtocolJson
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** Android-only settings persisted as a versioned document to avoid a Room schema migration. */
@Serializable
data class AndroidSettings(
    val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
    val language: String = "system",
    val theme: String = "system",
    val accentColor: String = "#1677FF",
    val maskHosts: Boolean = true,
    val autoCheckUpdates: Boolean = true,
    val terminalFontSize: Int = 14,
    val terminalCursorStyle: String = "block",
    val terminalScrollbackLines: Int = 2_000,
    val sftpConcurrency: Int = 3,
    val sftpConflictPolicy: String = "ask",
    val sftpShowHiddenFiles: Boolean = false,
    val monitorIntervalSeconds: Int = 5,
    val downloadDirectoryUri: String? = null,
    /** Tier a new local session defaults to. See [io.github.openfinalshell.android.core.model.LocalShellTier]. */
    val localShellTierDefault: String = "auto",
    /**
     * A second, product-level gate on the root tier, independent of the build flag. Even on a
     * rooted device the root tier is not offered until the user turns this on, because a root shell
     * on the same phone can read the app's own credential store.
     */
    val localAllowRoot: Boolean = false,
    /** Remembers that the user was already sent to the all-files-access settings page. */
    val localAllFilesAccessRequested: Boolean = false
) {
    /** Clamp values read from old or hand-edited documents before they reach the UI/core. */
    fun normalized(): AndroidSettings = copy(
        schemaVersion = CURRENT_SCHEMA_VERSION,
        language = normalizeLanguage(language),
        theme = theme.takeIf { it in THEMES } ?: "system",
        accentColor = accentColor.takeIf { HEX_COLOR.matches(it) } ?: "#1677FF",
        terminalFontSize = terminalFontSize.coerceIn(10, 32),
        terminalCursorStyle = terminalCursorStyle.takeIf { it in CURSOR_STYLES } ?: "block",
        terminalScrollbackLines = terminalScrollbackLines.coerceIn(200, 20_000),
        sftpConcurrency = sftpConcurrency.coerceIn(1, 8),
        sftpConflictPolicy = sftpConflictPolicy.takeIf { it in CONFLICT_POLICIES } ?: "ask",
        monitorIntervalSeconds = monitorIntervalSeconds.coerceIn(2, 60),
        downloadDirectoryUri = downloadDirectoryUri?.takeIf { it.isNotBlank() },
        localShellTierDefault = localShellTierDefault.takeIf { it in LOCAL_TIERS } ?: "auto"
    )

    companion object {
        const val CURRENT_SCHEMA_VERSION = 2
        const val DOCUMENT_NAME = "android.settings"
        /** Matches the desktop locale registry, plus Android's explicit follow-system option. */
        val LANGUAGES = setOf(
            "system", "zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR",
            "ru-RU", "es-ES", "fr-FR", "de-DE", "pt-BR"
        )
        val THEMES = setOf("system", "light", "dark")
        val CURSOR_STYLES = setOf("block", "line", "underline")
        val CONFLICT_POLICIES = setOf("ask", "overwrite", "skip")
        val LOCAL_TIERS = io.github.openfinalshell.android.core.model.LocalShellTier.all.toSet()
        private val HEX_COLOR = Regex("^#[0-9A-Fa-f]{6}$")

        fun normalizeLanguage(value: String): String = when (value) {
            // Version 1 used these shorthand values. Keep existing installations valid.
            "en" -> "en-US"
            "zh" -> "zh-CN"
            else -> value.takeIf { it in LANGUAGES } ?: "system"
        }
    }
}

class SettingsRepository(
    private val documents: DocumentDao,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO
) {
    suspend fun load(): AndroidSettings = withContext(dispatcher) {
        val stored = documents.find(AndroidSettings.DOCUMENT_NAME)?.json
            ?.let { raw -> runCatching { ProtocolJson.instance.decodeFromString(AndroidSettings.serializer(), raw) }.getOrNull() }
        val settings = (stored ?: AndroidSettings()).normalized()
        // Persist defaults and migrations immediately, so a later launch does not repeat them.
        if (stored != settings || documents.find(AndroidSettings.DOCUMENT_NAME) == null) saveInternal(settings)
        settings
    }

    suspend fun save(settings: AndroidSettings) = withContext(dispatcher) {
        saveInternal(settings.normalized())
    }

    private suspend fun saveInternal(settings: AndroidSettings) {
        documents.upsert(
            DocumentEntity(
                name = AndroidSettings.DOCUMENT_NAME,
                json = ProtocolJson.instance.encodeToString(AndroidSettings.serializer(), settings)
            )
        )
    }
}
