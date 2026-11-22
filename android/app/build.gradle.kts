import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
}

/* Release signing.
 *
 * CI exports NODEPULSE_KEYSTORE / NODEPULSE_KEYSTORE_PASSWORD / NODEPULSE_KEY_ALIAS /
 * NODEPULSE_KEY_PASSWORD (a long-lived key decoded from repository secrets when the owner
 * has stored one, otherwise an ephemeral key generated for that run). A local build may put
 * the same four values in android/keystore.properties instead, which is git-ignored.
 * With neither, a release build falls back to the debug signing config so the task still
 * produces an installable APK. */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

fun signingValue(name: String): String? =
    (System.getenv(name) ?: keystoreProperties.getProperty(name))?.trim()?.takeIf { it.isNotEmpty() }

val releaseStoreFile = signingValue("NODEPULSE_KEYSTORE")
val releaseStorePassword = signingValue("NODEPULSE_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("NODEPULSE_KEY_ALIAS")
val releaseKeyPassword = signingValue("NODEPULSE_KEY_PASSWORD")
val hasReleaseSigning = releaseStoreFile != null &&
    releaseStorePassword != null &&
    releaseKeyAlias != null &&
    releaseKeyPassword != null &&
    file(releaseStoreFile).exists()

android {
    namespace = "com.jbitmstr.nodepulse"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.jbitmstr.nodepulse"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "1.1.2"
        resourceConfigurations += listOf("en")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // No dependencies: the shell is a plain android.webkit.WebView over the
    // single-file app staged into src/main/assets/index.html by CI.
}

tasks.register<Copy>("stageWebApp") {
    description = "Copy the built single-file app into the APK assets."
    val dist = rootProject.file("../dist/nodepulse.html")
    from(dist)
    into(layout.projectDirectory.dir("src/main/assets"))
    rename { "index.html" }
}
