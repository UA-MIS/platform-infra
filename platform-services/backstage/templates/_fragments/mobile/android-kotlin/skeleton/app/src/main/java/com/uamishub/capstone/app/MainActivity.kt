package com.uamishub.capstone.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                AppScreen()
            }
        }
    }
}

@Composable
fun AppScreen() {
    val scope = rememberCoroutineScope()
    var result by remember { mutableStateOf("Tap to call the backend.") }
    var loading by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("${{ values.appName }}", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text("${{ values.description }}", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(8.dp))
        Text("Backend: ${BuildConfig.API_BASE_URL}", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(24.dp))
        Button(
            enabled = !loading,
            onClick = {
                loading = true
                result = "Calling ${BuildConfig.API_BASE_URL}/healthz …"
                scope.launch {
                    result = ApiClient.health()
                    loading = false
                }
            },
        ) {
            Text(if (loading) "Calling…" else "Ping backend /healthz")
        }
        Spacer(Modifier.height(24.dp))
        Text(result, style = MaterialTheme.typography.bodyMedium)
    }
}
