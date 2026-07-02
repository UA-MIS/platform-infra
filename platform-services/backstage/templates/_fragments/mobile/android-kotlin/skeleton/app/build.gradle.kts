plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.uamishub.capstone.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.uamishub.capstone.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // Backend API base URL. Mobile apps are distributed to devices and call the
        // backend over its PUBLIC ingress host (no same-origin /api like a web frontend).
        // Override at build time:  gradle assembleDebug -PapiBaseUrl=https://your-backend...
        val apiBaseUrl = (project.findProperty("apiBaseUrl") as String?)
            ?: "https://CHANGEME-backend.capstone.uamishub.com"
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // NOTE: a real release .apk/.aab needs a signing keystore (add as repo secrets).
            // The debug build (assembleDebug) is auto-signed with the debug keystore.
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
