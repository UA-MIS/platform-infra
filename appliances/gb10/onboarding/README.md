# UA MIS Local LLM — Continue setup

This adds a local, university-hosted AI model to the Continue extension in
VS Code, so you get chat and inline edit/apply without going through a
third-party AI service. It takes about a minute if the script works, or a
few minutes if you do it by hand.

You need: VS Code installed, the **Continue** extension installed
(Extensions panel → search "Continue" → Install), and a UA sign-in at the
keys portal, <https://local-llm-keys.uamishub.com>. The portal issues
your key the first time you visit it — there is nobody to ask and nothing
to request.

---

## The main path: copy and paste the config block

Sign in **in a web browser** at <https://local-llm-keys.uamishub.com>.
Once your key is activated the page shows a config block with **your own
key already in it** and a **Copy config block** button. Then:

1. In VS Code, open the Continue panel, click the agent/assistant
   selector above the chat box (it may read *Local Assistant* or *Local
   Config*), hover the one that is selected and click the **gear**. That
   opens the config Continue is actually using. (Alternatively:
   Continue settings → *Configs* → the gear "Open configuration".)
   Labels vary a little between Continue versions.
2. Paste the block **underneath the existing `models:` line**, as more
   items in the list — keep the models already there. Never select-all
   and paste over the file.
3. Save, then fully quit and reopen VS Code.

Because the gear opens the file Continue itself loads, there is no
question of which file to edit. Details, the manual version with
placeholders, and what each part means are in [the fully manual
path](#the-fully-manual-path-works-even-if-the-script-fails) below.

## Optional: the setup script (macOS / Linux)

The script makes the same edit for you. **On Windows, prefer the copy-paste
path above**: PowerShell blocks downloaded scripts by default (see
[PowerShell won't run the
script](#powershell-wont-run-the-script-execution-policy)), and nothing
below is needed if you paste the block. The script only edits
`~/.continue/config.yaml`; if your Continue is using a different config
(Local Assistant / agents folder), paste the block into the file the gear
opens instead.

Sign in **in a web browser** and click the download link for your platform:

| Your machine | Link on the portal | Saves as |
| --- | --- | --- |
| macOS / Linux | `https://local-llm-keys.uamishub.com/setup/macos-linux` | `setup-macos-linux.sh` |
| Windows | `https://local-llm-keys.uamishub.com/setup/windows` | `setup-windows.ps1` |

**The portal fills your own key into the file it hands you**, so there is
nothing to copy, nothing to paste, and no prompt to answer. Then run the
file you just downloaded.

### macOS / Linux

```bash
bash ~/Downloads/setup-macos-linux.sh
```

### Windows

Open PowerShell and run:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\setup-windows.ps1"
```

The `-ExecutionPolicy Bypass` part is important — see [PowerShell won't
run the script](#powershell-wont-run-the-script-execution-policy) below
for why, and don't skip it.

> **Use a browser, not `curl` or `Invoke-WebRequest`.** The portal is
> behind Cloudflare Access, so a command-line download gets the sign-in
> *page* rather than the script — and saves that HTML under the script's
> name, which then fails in a confusing way when you run it. If you would
> rather not download anything at all, the fully manual steps below get
> you to the exact same end result.

---

## The fully manual path (works even if the script fails)

Use this if the setup script isn't available to you, or if it stops and
tells you to do something by hand (it does this on purpose rather than
guessing when your setup looks unusual — see
[Why the script might refuse to touch your file](#why-the-script-might-refuse-to-touch-your-file)).

1. **Find or create the Continue config folder.**
   - macOS/Linux: `~/.continue`
   - Windows: `%USERPROFILE%\.continue` (usually
     `C:\Users\<you>\.continue`)

   If it doesn't exist, create it.

2. **Find or create `config.yaml` inside that folder.**

   If a `config.yaml` already exists, **open it and keep everything
   that's already in it** — you're adding to it, not replacing it. Make
   a copy first if you want extra safety (e.g. copy `config.yaml` to
   `config.yaml.bak`).

   If instead you only find a `config.json` (no `config.yaml`), stop:
   your Continue extension is out of date. Update the Continue extension
   in VS Code's Extensions panel, restart VS Code, and come back to this
   step — it will have migrated you to `config.yaml`.

3. **Add this to the `models:` list.** If your file already has a
   `models:` section with other entries, add these as more items in
   that same list (don't delete what's already there). If there's no
   `models:` section at all, add one:

   ```yaml
   models:
     - name: UA MIS Local (Chat)
       provider: openai  # "openai" here means the OpenAI-compatible API
                         # protocol, NOT the OpenAI company. This talks
                         # only to our own local box, never to openai.com.
       model: qwen3.8-27b
       apiBase: https://local-llm.uamishub.com/v1
       apiKey: <your key>
       roles: [chat]
       defaultCompletionOptions:
         maxTokens: 4000
       requestOptions:
         extraBodyProperties:
           chat_template_kwargs:
             enable_thinking: false

     - name: UA MIS Local (Edit)
       provider: openai
       model: qwen3.8-27b
       apiBase: https://local-llm.uamishub.com/v1
       apiKey: <your key>
       roles: [edit, apply]
       defaultCompletionOptions:
         maxTokens: 400
       requestOptions:
         extraBodyProperties:
           chat_template_kwargs:
             enable_thinking: false

     - name: UA MIS Local (Agent)
       provider: openai
       model: qwen3.8-27b
       apiBase: https://local-llm.uamishub.com/v1
       apiKey: <your key>
       roles: [chat]
       capabilities:
         - tool_use
       defaultCompletionOptions:
         maxTokens: 8000
       requestOptions:
         extraBodyProperties:
           chat_template_kwargs:
             enable_thinking: false
   ```

   That's **three separate entries pointing at the same model** — not a
   typo. Continue lets each model declare different response-length
   limits, but only per whole model entry, not per role within one
   entry — so chat (which should give you a full explanation), edit/apply
   (which should just make the change, fast), and agent (which needs the
   most room for multi-step work) each get their own entry with a limit
   sized for that job.

   **Agent mode is not a role.** Continue turns it on for a *chat* model
   that declares `capabilities: [tool_use]`, which is what the third
   entry does (this server really does support tool calling). So both
   "UA MIS Local (Chat)" and "UA MIS Local (Agent)" appear in the chat
   model picker — choose **(Chat)** for questions and **(Agent)** when you
   switch the panel to Agent mode. `agent` is not a valid value for
   `roles:`; if a config of yours says `roles: [agent]` (an earlier
   version of this page and script wrote that), Continue rejects it —
   delete the old `UA MIS Local (...)` entries and paste the current block.

   All three also turn the model's internal "thinking" off
   (`chat_template_kwargs.enable_thinking: false`) — a measured
   single-turn comparison found no quality difference worth the wait
   (reasoning on scored about the same as reasoning off), so off is the
   default for every role now, not just edit/apply.

   Deliberately no `autocomplete` role on any of the three: GitHub
   Copilot Free already handles inline completions well, and this
   shared GPU box shouldn't spend capacity on every keystroke.

   Replace `<your key>` (all three places) with the key shown on the
   keys portal, <https://local-llm-keys.uamishub.com>. Watch your indentation — YAML cares about it. Every item in the
   `models:` list needs the same indentation as the others.

4. **Save the file and restart VS Code completely** (not just reload the
   window — fully quit and reopen it).

5. **Open the Continue sidebar** (the Continue icon in the left activity
   bar). You should see "UA MIS Local (Chat)" and "UA MIS Local (Agent)"
   in the chat model picker (pick (Agent) in Agent mode); "(Edit)" shows
   up for inline edits.

6. **Sanity-check your key works** by opening a terminal and running:

   ```bash
   curl -H "Authorization: Bearer <your key>" https://local-llm.uamishub.com/v1/models
   ```

   - A response with model data → your key works.
   - `401` → the key was rejected; double check you copied the whole
     thing.
   - `403`, or a message mentioning "team" or "model access" → your key
     is issued but not yet activated. See below — **this is normal**,
     not an error.

---

## Troubleshooting

### "Your key is issued but not yet activated" / HTTP 403

**This is the expected, normal state for a brand-new key — it is not an
error and does not mean anything is broken.** Every new key starts with
zero model access on purpose — your instructor adds you to a course team.
You can check your own status any time at <https://local-llm-keys.uamishub.com>:
once that page stops saying "not yet activated", restart VS Code and try
again. You do **not** need a new key or to re-run the setup script; the
same key starts working once you're added to a team.

### macOS: `code` command not found / script can't open VS Code for you

The setup script tries to open your config in VS Code as a courtesy at
the end — this step is optional and does not affect whether your setup
actually worked. If you see a message about it not finding `code`:

1. Open VS Code.
2. Press `Cmd+Shift+P` to open the Command Palette.
3. Type: `Shell Command: Install 'code' command in PATH`
4. Press Enter.

You don't need to do this at all if you're following the manual path
above — it's only used for that one convenience step.

### PowerShell won't run the script (execution policy)

Windows blocks running `.ps1` scripts by default. You don't need to
(and shouldn't) permanently change your system's execution policy just
to run this one script. Instead, run it with a one-time override:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

This only affects that single invocation — it does not weaken security
for anything else on your machine.

### The Continue sidebar shows nothing / doesn't show "UA MIS Local"

Almost always this means VS Code needs a **full restart**, not just a
reload. Quit VS Code completely (all windows) and reopen it. Continue
only reads `config.yaml` on startup.

If it still doesn't show up, open `config.yaml` (see paths above) and
check:
- The file is valid YAML (consistent indentation, no stray tabs).
- All three `UA MIS Local (...)` blocks are actually inside the
  `models:` list, not floating outside it.
- You're looking in the right place: "(Chat)" and "(Agent)" are both in the chat panel's
  model picker (use (Agent) in Agent mode); "(Edit)" only shows up when
  you trigger an inline edit. That's expected, not a bug.

### Responses are slow

This is a **shared** box serving the whole class, not a dedicated GPU
just for you. A full chat answer typically takes **roughly 30–60
seconds**. Text streams in as it's generated (you'll see it appear
progressively, not all at once), so it won't feel "hung" — but a
complete response genuinely does take that long, especially if other
students are using it at the same time. That is expected behavior, not
a sign something is broken.

**Agent mode runs longer than chat.** A real multi-step agent task
(e.g. scaffolding several files) can take **a couple of minutes**, not
30–60 seconds — it's doing more work, including its own internal
reasoning before it writes anything. That's expected for agent mode
specifically; if an ordinary chat question is taking that long, see
below.

### Something else is wrong

Sign in at <https://local-llm-keys.uamishub.com>. That page shows
your current key and whether it has been activated yet, which is the
answer to most of what goes wrong here. If it does not explain what you
are seeing, ask your course instructor.

---

## Why the script might refuse to touch your file

You may already use Continue with other models (a personal API key, a
different provider, etc.). The setup script is deliberately cautious:
it always backs up your existing `config.yaml` before changing anything
(as `config.yaml.bak-<timestamp>`, printed to your screen), and it will
**stop and tell you to add the entry by hand** instead of guessing if
your file's `models:` section is in a format it doesn't recognize (for
example, written all on one line instead of as a list). This is meant
to protect a setup you already have working — losing that would be
worse than the script doing nothing. If it stops, follow the message it
prints, or use the fully manual path above.
