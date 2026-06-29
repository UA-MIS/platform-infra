import { render } from 'solid-js/web'
import { Router, Route } from '@solidjs/router'
import App from './App'
import Home from './pages/Home'
import About from './pages/About'
import './index.css'

const root = document.getElementById('root')

// App is the shared layout (root); pages render into props.children. nginx falls back to
// index.html so deep links resolve on a hard refresh.
render(
  () => (
    <Router root={App}>
      <Route path="/" component={Home} />
      <Route path="/about" component={About} />
    </Router>
  ),
  root!,
)
