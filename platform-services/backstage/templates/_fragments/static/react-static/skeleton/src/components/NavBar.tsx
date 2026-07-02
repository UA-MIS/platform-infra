import { NavLink } from 'react-router-dom'

// Top navigation. NavLink applies an "active" style to the current route.
const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive
    ? 'font-semibold text-indigo-600'
    : 'text-slate-600 hover:text-slate-900'

export default function NavBar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
        <span className="text-lg font-bold tracking-tight">UA-MIS Capstone</span>
        <div className="flex gap-6">
          <NavLink to="/" className={linkClass} end>
            Home
          </NavLink>
          <NavLink to="/about" className={linkClass}>
            About
          </NavLink>
        </div>
      </nav>
    </header>
  )
}
