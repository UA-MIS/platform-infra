# UA MIS Local LLM — set up Continue

This adds the university-hosted AI model to the **Continue** extension in
VS Code. It is a copy and paste of one block into Continue's config, and takes
about ten seconds once you are at the right file.

You need: VS Code, the **Continue** extension (Extensions panel → search
"Continue" → Install), and a UA sign-in at the keys portal,
<https://local-llm-keys.uamishub.com>. The portal issues your key the first
time you visit it — there is nobody to ask and nothing to request.

> **Already pasted a block, or used the old setup script?**
> Delete **every** existing entry named `UA MIS Local (Chat)`,
> `UA MIS Local (Agent)` or `UA MIS Local (Edit)` (anything starting
> `UA MIS Local`) from your config first, then paste the current block. The
> current block is just two entries, `UA MIS Local` and `UA MIS Local (Edit)`;
> leftovers would give you a duplicate chat model in the picker. An earlier
> version also used a role called `agent`, which Continue rejects — your config
> then fails to load (you may see a config error in the Continue panel).
> The setup scripts have been retired.

## Steps

1. Sign in at <https://local-llm-keys.uamishub.com> **in your browser**. Once
   your key is activated the page shows a config block with **your own key
   already in it** and a **Copy config block** button. (Not activated yet? The
   page shows a `<your key>` placeholder instead — see
   [Not activated yet](#your-key-is-issued-but-not-yet-activated--http-403).)
2. In VS Code, open the Continue panel in the sidebar, click the
   agent/assistant selector above the chat box (it may read *Local Assistant*
   or *Local Config*), hover the entry that is selected and click the
   **gear** icon next to it. That opens the config file Continue is actually
   using. (Or: Continue's settings → **Configs** → the gear labelled "Open
   configuration".) Labels vary a little between Continue versions.
3. Find the line `models:` and paste the block **directly underneath it**,
   keeping any models already listed. **Do not select-all and paste over the
   file.**
   - **Indentation is the one thing that can go wrong.** Every `- name:` item
     under `models:` must start at the same column. If your existing entries
     start flush at the left edge, shift the pasted block left two spaces:

     ```yaml
     # WRONG (mixed columns -- the file will not load)
     models:
     - name: My Old Model
       provider: anthropic
       - name: UA MIS Local
         provider: openai

     # RIGHT (same column)
     models:
     - name: My Old Model
       provider: anthropic
     - name: UA MIS Local
       provider: openai
     ```

     If your list is already indented two spaces, paste exactly as shown.
   - No `models:` line at all? Add `models:` on its own line first.
   - `models: []`? Change it to just `models:`.
4. Save, then **fully quit and reopen VS Code** (not just reload the window).
5. Open the Continue panel. **"UA MIS Local"** is the model to pick, in both
   Chat mode and Agent mode. "UA MIS Local (Edit)" is used automatically for
   inline edits.

Because the gear opens the file Continue itself loads, there is no question of
"which config file" to edit — Continue can keep several configs (the main
`config.yaml` plus any files under `agents/`, `assistants/` or `configs/`), and
the gear always opens the one you have selected.

If you only find a `config.json` (no `config.yaml`), your Continue extension is
out of date: update it in the Extensions panel, restart VS Code, and start
again — it migrates you to the YAML format.

## What the block is

```yaml
- name: UA MIS Local (Edit)
  provider: openai            # the OpenAI-compatible API protocol, not OpenAI
  model: qwen3.8-27b
  apiBase: https://local-llm.uamishub.com/v1
  apiKey: '<your key>'
  roles: [edit, apply]
  defaultCompletionOptions:
    maxTokens: 400
  requestOptions:
    extraBodyProperties:
      chat_template_kwargs:
        enable_thinking: false

- name: UA MIS Local
  ...
  roles: [chat]
  capabilities:
    - tool_use
  defaultCompletionOptions:
    maxTokens: 8000
```

(`...` stands for the same provider/model/apiBase/apiKey/requestOptions lines;
copy the real block from the portal rather than from here.)

- **Two entries for one model, on purpose.** Continue sets response-length
  limits per whole model entry, not per role, so edit/apply (small and fast:
  400 tokens) needs its own entry apart from chat (8000).
- **One chat entry serves Chat and Agent mode.** Continue attaches tools per
  *mode*, not per model: Chat mode sends no tools, Agent mode all of them. So
  `capabilities: [tool_use]` costs nothing in Chat mode and just makes the model
  usable in Agent mode. There used to be a separate "UA MIS Local (Chat)" entry;
  it was strictly a subset of this one and only added a pointless extra choice
  to the picker, so it was removed. Please do not add it back.
- **Agent mode is not a role.** `agent` is not a valid value for `roles:` — a
  config that says `roles: [agent]` is rejected. Agent mode comes from a *chat*
  model declaring `capabilities: [tool_use]` (this server supports tool calling).
- **Thinking is off** (`enable_thinking: false`) on both: a measured
  single-turn comparison found no quality difference worth the wait.
- **No `autocomplete` role** on purpose: GitHub Copilot Free already does inline
  completion, and this shared GPU should not answer every keystroke.
- The key is a quoted string (`'...'`) so characters like `#` or `:` in it cannot
  truncate it.

## Troubleshooting

### "Your key is issued but not yet activated" / HTTP 403

**This is the normal state for a brand-new key — not an error.** Every new key
starts with zero model access; your instructor adds you to a course team. Check
your status any time at <https://local-llm-keys.uamishub.com>. Once the page
stops saying "not yet activated", **reload it**: the block then has your key in
it. You do **not** need a new key. (If you already pasted a block containing
your key, it starts working on its own — nothing to redo.)

### The Continue panel shows nothing / no "UA MIS Local"

Almost always VS Code needs a **full restart** (quit every window and reopen);
Continue reads its config on startup. If it still does not show up, open the
config via the gear (step 2) and check that the file is valid YAML (consistent
indentation, no tabs), that both `UA MIS Local` entries are inside
the `models:` list, and that you edited the file the **gear** opened.

### Continue shows a config error

Most often an old `UA MIS Local (Agent)` entry with `roles: [agent]`. Delete
every entry starting `UA MIS Local` (`UA MIS Local (Chat)`, `UA MIS Local (Agent)`,
`UA MIS Local (Edit)`) and paste the current block.

### Sanity-check your key

```bash
curl -H "Authorization: Bearer <your key>" https://local-llm.uamishub.com/v1/models
```

A response with model data → the key works. `401` → rejected; check you copied
the whole key. `403` or a message mentioning "team" or "model access" → issued
but not yet activated (see above).

### Responses are slow

This is a **shared** box serving the whole class. A full chat answer typically
takes **30–60 seconds** and streams in as it is generated. Agent mode can take a
couple of minutes for a multi-step task. That is expected.

### Something else is wrong

Sign in at <https://local-llm-keys.uamishub.com>; that page shows your key and
whether it is activated. If it does not explain what you see, ask your course
instructor.
