<main>
  <h1>SvelteKit fullstack starter</h1>
  <p>
    A SvelteKit fullstack app: Svelte routes plus server endpoints in one deployable. The
    data layer is Drizzle ORM over MySQL, read from the <code>DATABASE_URL</code> env.
  </p>
  <ul>
    <li><a href="/items">Items</a> — a DB-backed sample page</li>
    <li><code>GET /api/items</code> — the JSON API behind it</li>
    <li><code>GET /healthz</code> — DB-independent health probe</li>
  </ul>
</main>

<style>
  main {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem;
    font-family: system-ui, sans-serif;
  }
</style>
