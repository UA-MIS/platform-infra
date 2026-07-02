import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'

// SPA entrypoint. BrowserRouter gives clean client-side URLs (e.g. /about);
// nginx is configured (nginx.conf) to fall back to index.html for unknown paths
// so a hard refresh / deep link on a client route still serves the app.
const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found in index.html')
}

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
