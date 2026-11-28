import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
}

/* Release signing — fail closed.
 *
 * The owner's long-lived key comes from NODEPULSE_KEYSTORE / NODEPULSE_KEYSTORE_PASSWORD /
 * NODEPULSE_KEY_ALIAS / NODEPULSE_KEY_PASSWORD (CI repository secrets) or from
 * android/keystore.properties (git-ignored, local). When any of the four is missing, a
 * release packaging task stops with an error that names what is missing instead of
 * producing an APK signed with the debug key: that APK installs, but it can never update
 * the previous release, and nothing in its filename or manifest says which key signed it.
 * Debug builds, lint and the unit tests never touch this.
 */
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

val missingSigning = buildList {
    if (releaseStoreFile == null) add("NODEPULSE_KEYSTORE (path to the release .jks/.keystore)")
    if (releaseStorePassword == null) add("NODEPULSE_KEYSTORE_PASSWORD")
    if (releaseKeyAlias == null) add("NODEPULSE_KEY_ALIAS")
    if (releaseKeyPassword == null) add("NODEPULSE_KEY_PASSWORD")
}
val releaseStore = releaseStoreFile?.let { file(it) }
val releaseStoreMissing = releaseStore != null && !releaseStore.exists()
val hasReleaseSigning = missingSigning.isEmpty() && !releaseStoreMissing

/* A builder that signs the artifact with its own key asks for an unsigned release
 * APK explicitly: -Pnodepulse.unsignedRelease=true. F-Droid builds assembleRelease
 * in a checkout that has no keystore and signs the APK it gets with the F-Droid
 * key, so for that builder the missing key is not an error. Nothing infers it from
 * the absence of a key, the default stays strict, and the debug key is still never
 * used: an unsigned build produces app-release-unsigned.apk and nothing else. */
val unsignedReleaseRequested =
    providers.gradleProperty("nodepulse.unsignedRelease").orNull?.equals("true", ignoreCase = true) == true

android {
    namespace = "com.corejbh.nodepulse"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.corejbh.nodepulse"
        minSdk = 24
        targetSdk = 34
        versionCode = 16
        versionName = "1.2.0"
        resourceConfigurations += listOf("en")
    }

    signingConfigs {
        create("release") {
            if (hasReleaseSigning) {
                storeFile = releaseStore
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                // v2 (and the v3 signature the platform adds) only: v1 is the JAR
                // signature, which exists for Android 6 and older, is weaker, and costs
                // a second signing pass. minSdk is 24, so no device this app installs on
                // needs it.
                enableV1Signing = false
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
            // No fallback: an unsigned release is caught by the task-graph check below.
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// One dependency in the app itself: androidx.activity, for ComponentActivity and its
// OnBackPressedCallback. The shell is otherwise a plain android.webkit.WebView over the
// single-file app staged into src/main/assets/index.html by CI. The deprecated
// onBackPressed() override could not close the page's own layers before leaving the app;
// the dispatcher can. JUnit is for the host-side unit tests, which run on the JVM through
// :app:testDebugUnitTest.
dependencies {
    implementation("androidx.activity:activity:1.9.3")
    testImplementation("junit:junit:4.13.2")
}

/* Since Kotlin 1.8 the jdk7/jdk8 extensions live inside kotlin-stdlib itself, but an older
 * androidx artifact still asks for kotlin-stdlib-jdk8 1.6.21 alongside it, and the two jars
 * carry the same classes (a duplicate-class failure at dex time). Excluding the two split
 * artifacts leaves the single kotlin-stdlib that androidx.activity brings. */
configurations.configureEach {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk8")
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk7")
}

tasks.register<Copy>("stageWebApp") {
    description = "Copy the built single-file app into the APK assets."
    val dist = rootProject.file("../dist/nodepulse.html")
    from(dist)
    into(layout.projectDirectory.dir("src/main/assets"))
    rename { "index.html" }
}

/* Running Gradle directly stages the web app too: preBuild runs before every packaging
 * task, so a plain `gradle assembleDebug` can no longer produce an APK whose
 * assets/index.html is missing (the shell would boot to a blank screen) when the
 * checkout has not run build.py first. CI still stages the file explicitly and the
 * headless tests run against dist/, so nothing changes there. */
tasks.named("preBuild") { dependsOn("stageWebApp") }

/* The gate. Only a task that packages a release needs the key, so assembleDebug,
 * lintDebug and testDebugUnitTest run exactly as before; assembleRelease, bundleRelease
 * and installRelease stop here, before any APK exists, when the key is not configured. */
val releasePackagingTasks = setOf(
    "packageRelease",
    "assembleRelease",
    "bundleRelease",
    "installRelease",
    "packageReleaseBundle",
)

gradle.taskGraph.whenReady {
    val asked = allTasks.map { it.name }.filter { it in releasePackagingTasks }
    if (asked.isEmpty() || hasReleaseSigning || unsignedReleaseRequested) return@whenReady
    val missing = buildList {
        addAll(missingSigning)
        if (releaseStoreMissing) add("a readable keystore file at $releaseStoreFile")
    }
    throw GradleException(
        "release signing is not configured, so the release tasks were stopped:\n" +
            "  asked for: ${asked.joinToString(", ")}\n" +
            "  missing: ${missing.joinToString(", ")}\n" +
            "An APK signed with the debug key installs but can never update a released one, and\n" +
            "nothing in it says which key signed it, so this build will not produce one.\n" +
            "Set the four values as environment variables (CI: repository secrets) or put them in\n" +
            "android/keystore.properties (git-ignored):\n" +
            "  NODEPULSE_KEYSTORE=/path/to/release.jks\n" +
            "  NODEPULSE_KEYSTORE_PASSWORD=…\n" +
            "  NODEPULSE_KEY_ALIAS=…\n" +
            "  NODEPULSE_KEY_PASSWORD=…\n" +
            "For a local or debug build use :app:assembleDebug, which needs no key.\n" +
            "A builder that signs the artifact with its own key (F-Droid) passes\n" +
            "-Pnodepulse.unsignedRelease=true and gets an unsigned release APK."
    )
}
