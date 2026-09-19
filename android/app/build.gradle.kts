plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Local release checks may produce unsigned artifacts; publishing always opts into signing.
val releaseSigningKeys = listOf("ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")
val releaseSigningValues = releaseSigningKeys.map { providers.environmentVariable(it).orNull }
val hasReleaseSigning = releaseSigningValues.all { !it.isNullOrBlank() }
check(hasReleaseSigning || releaseSigningValues.all { it.isNullOrBlank() }) {
    "Incomplete Android release signing configuration; provide all four ANDROID_KEYSTORE/KEY variables or none."
}
check(providers.gradleProperty("requireReleaseSigning").orNull != "true" || hasReleaseSigning) {
    "Release publishing requires the Android release keystore and all signing credentials."
}

android {
    namespace = "io.github.openfinalshell.android"
    compileSdk = 35
    // Builds the privileged PTY host. The local-shell tiers above the app's own uid need a PTY in a
    // process that is already uid 2000 or 0, and Termux's shipped library cannot be loaded there.
    ndkVersion = "27.0.12077973"

    externalNativeBuild {
        cmake {
            path = file("src/main/jni/CMakeLists.txt")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "io.github.openfinalshell.android"
        minSdk = 26
        targetSdk = 35
        versionCode = (providers.gradleProperty("versionCode").orNull ?: "19").toInt()
        versionName = providers.gradleProperty("versionName").orNull ?: "0.20.20"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
        // Distribution switch for the local on-device shell. A terminal emulator that runs a shell on
        // the phone is not Google Play eligible, so a Play-targeted build sets -PlocalShell=false to
        // hide the entry point and refuse to construct a local transport.
        buildConfigField("boolean", "LOCAL_SHELL_ENABLED", providers.gradleProperty("localShell").orNull ?: "true")
    }

    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
            isUniversalApk = true
        }
    }

    signingConfigs {
        create("release") {
            val path = providers.environmentVariable("ANDROID_KEYSTORE_PATH").orNull
            if (!path.isNullOrBlank()) {
                storeFile = file(path)
                storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasReleaseSigning) signingConfigs.getByName("release") else null
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
        // The privileged host is reached through a Shizuku user service, whose interface is AIDL.
        aidl = true
    }

    packaging {
        // A privileged local-shell host has to execute a PTY helper from the native library
        // directory, and a future proot userland has to execute a shipped binary from a writable
        // path. Both need a real file on disk: with the default (extractNativeLibs="false") the
        // libraries are reachable only through the linker inside the app process. This must land
        // before any on-device verification of the privileged tiers, because it changes the
        // installed layout and invalidates verification done under the old packaging.
        jniLibs { useLegacyPackaging = true }
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        resources.excludes += "/META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        resources.excludes += "/META-INF/DEPENDENCIES"
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":storage"))
    implementation(platform("androidx.compose:compose-bom:2025.02.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.9")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    // Termux's maintained terminal emulator provides the VT/ANSI renderer used by the SSH shell.
    implementation("com.github.termux.termux-app:terminal-emulator:v0.118.0")
    implementation("com.github.termux.termux-app:terminal-view:v0.118.0")
    // Reaches the ADB-shell tier (uid 2000) without root, and the root tier when Shizuku itself runs
    // as root through Sui. Version pinned deliberately: the API surface and the user-service
    // lifecycle contract have changed between releases, so a bump needs the tier tests re-run.
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.02.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

/**
 * Keep all Android UI translations at the same completeness bar as the desktop
 * `check:i18n` task. Include older screens as well as the new ported features.
 */
val settingsI18nKeys = setOf(
    "settings_title", "settings_general", "settings_language", "settings_language_system",
    "settings_theme", "settings_theme_system", "settings_theme_light", "settings_theme_dark",
    "settings_mask_hosts", "settings_auto_updates", "settings_terminal", "settings_terminal_font_size",
    "settings_cursor", "settings_cursor_block", "settings_cursor_line", "settings_cursor_underline",
    "settings_scrollback", "settings_sftp", "settings_sftp_concurrency", "settings_sftp_conflict",
    "settings_conflict_ask", "settings_conflict_overwrite", "settings_conflict_skip", "settings_sftp_hidden",
    "settings_monitor", "settings_monitor_interval", "settings_storage", "settings_download_directory",
    "settings_download_directory_default", "action_choose_directory", "action_clear", "action_delete", "settings_security", "settings_private_keys",
    "settings_private_keys_empty", "action_import_private_key", "settings_backup", "settings_backup_passphrase",
    "action_export", "action_import", "settings_updates", "update_not_checked", "update_checking",
    "update_up_to_date", "action_check_updates", "update_available", "action_download_update",
    "update_downloading", "update_ready", "action_install_update", "action_allow_install", "update_canceled",
    "update_installing", "update_installed", "settings_saving", "settings_about", "settings_version",
    "settings_about_body", "update_ready_dialog_title", "update_ready_dialog_message",
    "action_install_and_restart", "action_later", "settings_unavailable", "settings_save_failed"
)
val uiI18nKeys = setOf(
    "nav_more",
    "status_ready", "status_connecting", "status_authenticating", "status_connected", "status_reconnecting",
    "status_disconnected", "status_reconnected", "status_terminal_ready", "status_terminal_closed",
    "status_profile_saved", "status_profile_deleted", "status_forwarding_rule_saved", "status_forwarding_rule_deleted",
    "status_forwarding_started", "status_proxy_saved_unavailable", "status_proxy_unavailable", "status_private_key_imported",
    "status_host_trust_revoked", "status_export_completed", "status_local_sessions_excluded", "status_local_packed_transfer_unavailable", "status_local_root_confirm", "status_import_completed", "status_session_required",
    "status_server_info_unavailable", "status_port_traffic_failed", "status_sftp_ready", "status_sftp_directory_created",
    "status_sftp_item_renamed", "status_upload_queued", "status_download_queued", "status_host_key_confirmation_required",
    "status_ssh_components_unavailable", "status_error_detail", "status_local_storage_unavailable",
    "status_forwarding_rule_save_failed", "status_forwarding_rule_delete_failed", "status_forwarding_start_failed",
    "status_profile_save_failed", "status_profile_delete_failed", "status_group_save_failed", "status_group_delete_failed",
    "status_proxy_save_failed", "status_proxy_delete_failed", "status_private_key_import_failed", "status_private_key_delete_failed",
    "status_host_trust_revoke_failed", "status_export_failed", "status_import_failed", "status_connection_failed",
    "status_sftp_browse_failed", "status_sftp_delete_failed", "status_sftp_upload_failed", "status_sftp_download_failed",
    "status_sftp_operation_failed", "status_terminal_open_failed", "status_terminal_write_failed", "terminal_disconnect_confirm",
    "status_sync_devices_found", "status_sync_device_scan_failed", "status_sync_receiver_ready", "status_sync_receiver_start_failed",
    "status_sync_receiver_stopped", "status_sync_pairing_code_invalid", "status_sync_delivered", "status_sync_failed",
    "status_sync_incoming_confirmation_pending", "status_sync_rejected", "status_sync_import_failed", "status_sync_imported"
)
val checkedI18nKeys = settingsI18nKeys + uiI18nKeys
val settingsI18nLocales = listOf("zh-rCN", "zh-rTW", "ja-rJP", "ko-rKR", "ru-rRU", "es-rES", "fr-rFR", "de-rDE", "pt-rBR")

tasks.register("checkI18n") {
    group = "verification"
    description = "Checks that every selectable Android locale translates all UI strings."
    val baseFile = layout.projectDirectory.file("src/main/res/values/strings.xml")
    inputs.file(baseFile)
    inputs.dir(layout.projectDirectory.dir("src/main/res/values"))
    inputs.files(settingsI18nLocales.map { layout.projectDirectory.dir("src/main/res/values-$it") })

    doLast {
        fun stringNames(file: File, translatableOnly: Boolean = false): Set<String> {
            val document = javax.xml.parsers.DocumentBuilderFactory.newInstance()
                .newDocumentBuilder()
                .parse(file)
            return (0 until document.getElementsByTagName("string").length)
                .map { document.getElementsByTagName("string").item(it) }
                .filter { !translatableOnly || it.attributes.getNamedItem("translatable")?.nodeValue != "false" }
                .map { it.attributes.getNamedItem("name").nodeValue }
                .toSet()
        }

        val baseFiles = baseFile.asFile.parentFile.listFiles { file -> file.extension == "xml" }!!
        val baseNames = baseFiles.flatMap { stringNames(it) }.toSet()
        val requiredKeys = checkedI18nKeys + baseFiles.flatMap { stringNames(it, translatableOnly = true) }
        check(requiredKeys.all { it in baseNames }) {
            "Default strings.xml is missing localized UI keys: ${checkedI18nKeys.filterNot { it in baseNames }.sorted()}"
        }
        settingsI18nLocales.forEach { qualifier ->
            val directory = layout.projectDirectory.dir("src/main/res/values-$qualifier").asFile
            val files = directory.listFiles { file -> file.extension == "xml" }?.toList().orEmpty()
            val names = files.flatMap { stringNames(it) }.toSet()
            check(requiredKeys.all { it in names }) {
                "values-$qualifier is missing localized UI keys: ${requiredKeys.filterNot { it in names }.sorted()}"
            }
        }
    }
}
