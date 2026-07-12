{% raw %}
<script lang="ts">
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()
</script>

<main>
  <h1>Items</h1>
  <p>
    Read from MySQL through Drizzle ORM. Create one with
    <code>POST /api/items</code> (body: <code>{'{ "name": "..." }'}</code>).
  </p>

  {#if data.dbError}
    <div class="banner">
      The database is not reachable yet. Set <code>DATABASE_URL</code> in the Secrets tab and
      run <code>npm run db:migrate</code>.
    </div>
  {:else if data.items.length === 0}
    <p>No items yet.</p>
  {:else}
    <ul>
      {#each data.items as item (item.id)}
        <li>{item.name}</li>
      {/each}
    </ul>
  {/if}

  <p><a href="/">&larr; Home</a></p>
</main>

<style>
  main {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem;
    font-family: system-ui, sans-serif;
  }
  .banner {
    margin-top: 1.5rem;
    padding: 1rem;
    border: 1px solid #fcd34d;
    background: #fffbeb;
    border-radius: 6px;
  }
</style>
{% endraw %}
