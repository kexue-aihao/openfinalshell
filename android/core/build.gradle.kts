plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "io.github.openfinalshell.android.core"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures { buildConfig = false }
}

dependencies {
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:2.1.20"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.apache.sshd:sshd-core:2.14.0")
    implementation("org.apache.sshd:sshd-sftp:2.14.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")

    testImplementation("org.jetbrains.kotlin:kotlin-test:2.1.20")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("junit:junit:4.13.2")
}
