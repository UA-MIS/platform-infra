import { createRouter, createWebHistory } from 'vue-router'
import Home from './views/Home.vue'
import About from './views/About.vue'

// History-mode router. nginx (nginx/nginx.conf) falls back to index.html for unknown
// paths so a deep-linked client route resolves on a hard refresh.
export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/about', name: 'about', component: About },
  ],
})
