plugins {
    id("com.android.application")
}

android {
    namespace = "com.jbitmstr.nodepulse"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.jbitmstr.nodepulse"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.1.1"
        resourceConfigurations += listOf("en")
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
