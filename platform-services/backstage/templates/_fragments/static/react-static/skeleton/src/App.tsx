import { Routes, Route } from 'react-router-dom'
import NavBar from './components/NavBar'
import Home from './pages/Home'
import About from './pages/About'
import NotFound from './pages/NotFound'

// App shell: a persistent nav bar + a routed content area. Add pages by dropping a
// component under src/pages and wiring a <Route> here. All routing is client-side;
// nginx serves index.html for any unknown path (SPA fallback) so deep links work.
export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <NavBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  )
}
