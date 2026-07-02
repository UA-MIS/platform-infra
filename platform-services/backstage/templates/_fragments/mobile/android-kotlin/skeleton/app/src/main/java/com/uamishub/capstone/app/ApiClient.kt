package com.uamishub.capstone.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

object ApiClient {
    /**
     * Calls GET {API_BASE_URL}/healthz on the backend fragment (a normal backend fragment:
     * express/fastapi/dotnet). The backend MUST expose a DB-independent GET /healthz that
     * returns 200 (see ADR-034). Returns "HTTP <code>\n<body>" or a failure message.
     */
    suspend fun health(): String = withContext(Dispatchers.IO) {
        val base = BuildConfig.API_BASE_URL.trimEnd('/')
        val conn = (URL("$base/healthz").openConnection() as HttpURLConnection)
        try {
            conn.requestMethod = "GET"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            "HTTP $code\n$body"
        } catch (e: Exception) {
            "Request failed: ${e.message}"
        } finally {
            conn.disconnect()
        }
    }
}
