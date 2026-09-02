package io.github.openfinalshell.android

import androidx.appcompat.app.AppCompatDelegate
import androidx.annotation.StringRes
import androidx.core.os.LocaleListCompat

/**
 * Android mirror of src/shared/locales/registry.ts. Keep tags in BCP 47 form so Android,
 * Electron exports, and platform language settings all describe the same language choice.
 */
object AndroidLocales {
    const val SYSTEM = "system"

    data class Option(val tag: String, @StringRes val labelRes: Int)

    val tags = setOf(
        "zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR",
        "ru-RU", "es-ES", "fr-FR", "de-DE", "pt-BR"
    )

    /** Endonyms intentionally stay unchanged, matching the desktop language selector. */
    val options = listOf(
        Option(SYSTEM, R.string.settings_language_system),
        Option("zh-CN", R.string.settings_language_zh_cn),
        Option("zh-TW", R.string.settings_language_zh_tw),
        Option("en-US", R.string.settings_language_en_us),
        Option("ja-JP", R.string.settings_language_ja_jp),
        Option("ko-KR", R.string.settings_language_ko_kr),
        Option("ru-RU", R.string.settings_language_ru_ru),
        Option("es-ES", R.string.settings_language_es_es),
        Option("fr-FR", R.string.settings_language_fr_fr),
        Option("de-DE", R.string.settings_language_de_de),
        Option("pt-BR", R.string.settings_language_pt_br)
    )

    fun normalize(value: String): String = when (value) {
        "en" -> "en-US"
        "zh" -> "zh-CN"
        SYSTEM -> SYSTEM
        else -> value.takeIf { it in tags } ?: SYSTEM
    }

    fun settingFor(locales: LocaleListCompat): String {
        if (locales.isEmpty) return SYSTEM
        return normalize(locales[0]?.toLanguageTag().orEmpty())
    }

    fun apply(setting: String) {
        val tags = normalize(setting).takeUnless { it == SYSTEM }.orEmpty()
        val desired = LocaleListCompat.forLanguageTags(tags)
        if (AppCompatDelegate.getApplicationLocales() != desired) {
            AppCompatDelegate.setApplicationLocales(desired)
        }
    }
}
