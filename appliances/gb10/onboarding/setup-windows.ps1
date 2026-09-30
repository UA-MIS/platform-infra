<#
.SYNOPSIS
  UA MIS Local LLM -- Continue (VS Code) setup for Windows.

.DESCRIPTION
  1. Finds your Continue config (%USERPROFILE%\.continue\config.yaml).
  2. Backs it up (never overwrites it).
  3. Adds the "UA MIS Local" model entry, without touching any other
     model you already have configured.
  4. Checks your key against the local LLM endpoint and tells you
     plainly what to do next.

  This script is intentionally conservative: if anything about your
  existing setup looks unusual, it stops and tells you what to do by
  hand rather than guessing. Losing your existing Continue config would
  be worse than this script doing nothing.

.PARAMETER ApiKey
  Your local-llm key. If omitted, you will be prompted (hidden input).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 -ApiKey "YOUR_KEY_HERE"
#>

param(
    [string]$ApiKey
)

$ModelEndpoint = "https://local-llm.uamishub.com/v1"
$ModelId       = "qwen3.8-27b"
$Admin         = "<ADMIN>"

$ContinueDir  = Join-Path $env:USERPROFILE ".continue"
$ConfigYaml   = Join-Path $ContinueDir "config.yaml"
$ConfigJson   = Join-Path $ContinueDir "config.json"

function Write-Line($msg) { Write-Host $msg }
function Write-Hr { Write-Host "----------------------------------------------------------------" }

Write-Hr
Write-Line "UA MIS Local LLM -- Continue setup"
Write-Hr

# ---------------------------------------------------------------------------
# 0. Get the API key first (before touching any files).
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    $secure = Read-Host -Prompt "Paste your local-llm key (input is hidden), then press Enter" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Error "No key entered. Nothing was changed. Re-run and paste your key when prompted."
    exit 1
}

if ($ApiKey -notmatch '^sk-') {
    Write-Line "NOTE: that doesn't look like the usual key format (expected it to"
    Write-Line "start with the two characters 's' 'k' followed by a dash)."
    Write-Line "Continuing anyway -- if the verification step below fails, double-check what you pasted."
}

# ---------------------------------------------------------------------------
# 1. Legacy config.json detection -- do not attempt to convert it.
# ---------------------------------------------------------------------------

if ((Test-Path $ConfigJson) -and -not (Test-Path $ConfigYaml)) {
    Write-Hr
    Write-Line "Your Continue extension is using the OLD config format (config.json)."
    Write-Line "This script only edits the newer config.yaml format, and converting"
    Write-Line "config.json automatically risks breaking your existing setup, so"
    Write-Line "it will not attempt that."
    Write-Line ""
    Write-Line "What to do:"
    Write-Line "  1. In VS Code, go to Extensions, find 'Continue', and update it."
    Write-Line "  2. Restart VS Code. Continue will migrate you to config.yaml."
    Write-Line "  3. Re-run this script."
    Write-Hr
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Build the model block, matching the indentation already used by the
#    file's existing sequence items (YAML sequence items must all share
#    the same indentation).
# ---------------------------------------------------------------------------

function Build-Block {
    # Three separate model entries, not one, because Continue's
    # defaultCompletionOptions/requestOptions apply per MODEL block, not
    # per role within a shared block -- there is no way to give chat,
    # edit, apply, and agent different maxTokens values on a single
    # entry (see https://docs.continue.dev/reference, 2026-09-30). All
    # three point at the exact same backend model; only the role
    # assignment and completion options differ. Continue only offers
    # each role a choice among the models that declare it, so a student
    # sees one candidate per role, not three confusing "chat" options.
    #
    # Per-role token caps, measured against the real endpoint on this
    # box (DFlash2 config), 2026-09-30. This model is a REASONING model:
    # it emits a hidden "thinking" block BEFORE its real answer, and
    # that thinking consumes the SAME token budget as the answer
    # (measured: a short code-completion prompt used 99 of 120 total
    # tokens on thinking alone, with reasoning left on). A small
    # maxTokens cap on a role that still has thinking enabled truncates
    # the model mid-thought, before it ever writes the real answer --
    # worse than slow, actively broken. So every role below turns
    # thinking OFF (chat_template_kwargs.enable_thinking: false).
    #
    # 2026-09-30 correction: thinking used to stay ON for chat/agent,
    # reasoning that a good explanation or a good multi-file plan is
    # worse to truncate than to wait for. That was inheriting the
    # model's default and calling it a decision. The single-turn
    # benchmark shows no quality difference worth the wait: off scored
    # 41/54 versus xhigh's 39/54 (within noise), and low tracked off.
    # Off is now the evidence-based default for every role; turning it
    # back ON for a specific role is what would need new evidence, not
    # the other way around.
    param(
        [string]$DashIndent,
        [string]$KeyToPrint = $ApiKey
    )
    $contIndent = "$DashIndent  "
    $lines = @()

    $lines += "$DashIndent- name: UA MIS Local (Chat)"
    $lines += "$contIndent" + 'provider: openai  # "openai" here means the OpenAI-compatible API protocol,'
    $lines += "$contIndent" + '                  # NOT the OpenAI company. This talks only to our own'
    $lines += "$contIndent" + '                  # local box, never to openai.com.'
    $lines += "$contIndent" + "model: $ModelId"
    $lines += "$contIndent" + "apiBase: $ModelEndpoint"
    $lines += "$contIndent" + "apiKey: $KeyToPrint"
    $lines += "$contIndent" + "roles: [chat]"
    $lines += "$contIndent" + '# Generous on purpose: measured a real MIS 321-level question'
    $lines += "$contIndent" + '# (write a C# method with a parameterized query) at ~1900'
    $lines += "$contIndent" + '# tokens end to end, a good and correct answer, finishing on'
    $lines += "$contIndent" + '# its own well under this cap. A beginner question runs much'
    $lines += "$contIndent" + '# shorter but deserves the same room. Do not lower this to'
    $lines += "$contIndent" + '# "speed things up" -- it truncates good answers, not slow ones.'
    $lines += "$contIndent" + "defaultCompletionOptions:"
    $lines += "$contIndent" + "  maxTokens: 4000"
    $lines += "$contIndent" + "requestOptions:"
    $lines += "$contIndent" + "  extraBodyProperties:"
    $lines += "$contIndent" + "    chat_template_kwargs:"
    $lines += "$contIndent" + "      enable_thinking: false"
    $lines += ""

    $lines += "$DashIndent- name: UA MIS Local (Edit)"
    $lines += "$contIndent" + "provider: openai"
    $lines += "$contIndent" + "model: $ModelId"
    $lines += "$contIndent" + "apiBase: $ModelEndpoint"
    $lines += "$contIndent" + "apiKey: $KeyToPrint"
    $lines += "$contIndent" + "roles: [edit, apply]"
    $lines += "$contIndent" + '# Small and fast on purpose: a changed line or block, not a'
    $lines += "$contIndent" + '# tutorial. Thinking is turned OFF for this role too (see'
    $lines += "$contIndent" + "# requestOptions below) specifically so a small maxTokens cap"
    $lines += "$contIndent" + "# lands on the actual rewritten code, not on the model's"
    $lines += "$contIndent" + "# hidden reasoning about the code. Measured real edit/apply"
    $lines += "$contIndent" + "# tasks (rename variables, add error handling) at 37-90"
    $lines += "$contIndent" + "# tokens with thinking off; 400 leaves real headroom for a"
    $lines += "$contIndent" + "# larger function."
    $lines += "$contIndent" + "defaultCompletionOptions:"
    $lines += "$contIndent" + "  maxTokens: 400"
    $lines += "$contIndent" + "requestOptions:"
    $lines += "$contIndent" + "  extraBodyProperties:"
    $lines += "$contIndent" + "    chat_template_kwargs:"
    $lines += "$contIndent" + "      enable_thinking: false"
    $lines += ""

    $lines += "$DashIndent- name: UA MIS Local (Agent)"
    $lines += "$contIndent" + "provider: openai"
    $lines += "$contIndent" + "model: $ModelId"
    $lines += "$contIndent" + "apiBase: $ModelEndpoint"
    $lines += "$contIndent" + "apiKey: $KeyToPrint"
    $lines += "$contIndent" + "roles: [agent]"
    $lines += "$contIndent" + '# Largest cap of the four: multi-step, tool-calling agent work'
    $lines += "$contIndent" + '# (MIS 421/521) legitimately needs the most room. Measured a'
    $lines += "$contIndent" + '# real multi-file scaffold task at ~3700 tokens, finishing on'
    $lines += "$contIndent" + "# its own well under this cap. 8000 sits just under this"
    $lines += "$contIndent" + "# deployment's own hard backend ceiling (8192)."
    $lines += "$contIndent" + "defaultCompletionOptions:"
    $lines += "$contIndent" + "  maxTokens: 8000"
    $lines += "$contIndent" + "requestOptions:"
    $lines += "$contIndent" + "  extraBodyProperties:"
    $lines += "$contIndent" + "    chat_template_kwargs:"
    $lines += "$contIndent" + "      enable_thinking: false"
    $lines += "$contIndent" + '# Deliberately no "autocomplete" role on any of the three'
    $lines += "$contIndent" + '# entries above: GitHub Copilot Free already handles inline'
    $lines += "$contIndent" + '# completions well, and this shared GPU box should not spend'
    $lines += "$contIndent" + '# capacity on every keystroke. Please do not add it back in.'

    return $lines
}

function Write-Utf8NoBom {
    param([string]$Path, [string[]]$Lines)
    $content = ($Lines -join "`n") + "`n"
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $content, $enc)
}

# ---------------------------------------------------------------------------
# 3. Create fresh, or merge into existing, config.yaml.
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $ContinueDir | Out-Null

if (-not (Test-Path $ConfigYaml)) {
    Write-Hr
    Write-Line "No existing Continue config found. Creating a new one at:"
    Write-Line "  $ConfigYaml"
    Write-Hr
    $newLines = @("models:") + (Build-Block -DashIndent "  ")
    Write-Utf8NoBom -Path $ConfigYaml -Lines $newLines
    Write-Line "Done writing $ConfigYaml."
}
else {
    $existing = Get-Content -Path $ConfigYaml -Raw
    if ($existing -match '(?i)local-llm\.uamishub\.com') {
        Write-Hr
        Write-Line "This model already appears to be configured in:"
        Write-Line "  $ConfigYaml"
        Write-Line "(found a reference to local-llm.uamishub.com already)."
        Write-Line "Skipping the file edit so we don't create a duplicate entry."
        Write-Line "If you want to update the key, edit that file's apiKey line by hand,"
        Write-Line "or delete the existing 'UA MIS Local' block and re-run this script."
        Write-Hr
    }
    else {
        $lines = @(Get-Content -Path $ConfigYaml)

        $modelsLineIdx = -1
        $modelsLineCount = 0
        $flowStyle = $false

        for ($i = 0; $i -lt $lines.Count; $i++) {
            $l = $lines[$i]
            if ($l -match '^models:\s*(#.*)?$') {
                $modelsLineIdx = $i
                $modelsLineCount++
            }
            elseif ($l -match '^models:\s*\[') {
                $flowStyle = $true
                $modelsLineCount++
            }
        }

        if ($modelsLineCount -gt 1) {
            Write-Hr
            Write-Line "Found more than one top-level 'models:' key in $ConfigYaml --"
            Write-Line "this file looks unusual and I don't want to guess. Please add this"
            Write-Line "block by hand under your existing 'models:' list instead:"
            Write-Line ""
            (Build-Block -DashIndent "  " -KeyToPrint "<YOUR_KEY>") | ForEach-Object { Write-Line $_ }
            Write-Line ""
            Write-Line "Replace <YOUR_KEY> above with the key you just entered."
            Write-Line ""
            Write-Line "(Nothing was changed.)"
            Write-Hr
            exit 1
        }

        if ($flowStyle) {
            Write-Hr
            Write-Line "Your $ConfigYaml defines 'models:' in inline/flow style"
            Write-Line "(e.g. 'models: [ ... ]') rather than the usual multi-line list. This"
            Write-Line "script only edits the multi-line style safely. Please add this entry"
            Write-Line "to your models list by hand:"
            Write-Line ""
            (Build-Block -DashIndent "  " -KeyToPrint "<YOUR_KEY>") | ForEach-Object { Write-Line $_ }
            Write-Line ""
            Write-Line "Replace <YOUR_KEY> above with the key you just entered."
            Write-Line ""
            Write-Line "(Nothing was changed.)"
            Write-Hr
            exit 1
        }

        # Back up now, right before we actually write anything.
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupPath = "$ConfigYaml.bak-$timestamp"
        Copy-Item -Path $ConfigYaml -Destination $backupPath -Force
        Write-Line "Backed up your existing config to:"
        Write-Line "  $backupPath"

        if ($modelsLineIdx -eq -1) {
            # No top-level "models:" key at all -- append a new section.
            $newLines = $lines + @("") + @("models:") + (Build-Block -DashIndent "  ")
            Write-Utf8NoBom -Path $ConfigYaml -Lines $newLines
            Write-Line "No existing 'models:' section was found, so a new one was added"
            Write-Line "at the end of $ConfigYaml."
        }
        else {
            # Detect indentation of the first existing sequence item, if any.
            $itemIndent = "  "
            for ($j = $modelsLineIdx + 1; $j -lt $lines.Count; $j++) {
                $cl = $lines[$j]
                if ($cl -match '^\s*$' -or $cl -match '^\s*#') { continue }
                if ($cl -match '^(\s+)-\s') { $itemIndent = $Matches[1] }
                break
            }

            $before = $lines[0..$modelsLineIdx]
            $block = Build-Block -DashIndent $itemIndent
            if ($modelsLineIdx + 1 -lt $lines.Count) {
                $after = $lines[($modelsLineIdx + 1)..($lines.Count - 1)]
            } else {
                $after = @()
            }
            $newLines = $before + $block + $after
            Write-Utf8NoBom -Path $ConfigYaml -Lines $newLines
            Write-Line "Added the 'UA MIS Local' model to your existing 'models:' list in:"
            Write-Line "  $ConfigYaml"
        }
    }
}

# ---------------------------------------------------------------------------
# 4. Verify the key against the real endpoint.
# ---------------------------------------------------------------------------

Write-Hr
Write-Line "Checking your key against $ModelEndpoint/models ..."
Write-Hr

$statusCode = $null
$responseBody = $null
$networkError = $null

try {
    $resp = Invoke-WebRequest -Uri "$ModelEndpoint/models" `
        -Headers @{ Authorization = "Bearer $ApiKey" } `
        -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
    $statusCode = [int]$resp.StatusCode
    $responseBody = $resp.Content
}
catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp) {
        try { $statusCode = [int]$resp.StatusCode } catch { $statusCode = $null }
        try {
            $stream = $resp.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $responseBody = $reader.ReadToEnd()
        } catch { $responseBody = $null }
    }
    else {
        $networkError = $_.Exception.Message
    }
}
catch {
    # PowerShell 7's Invoke-WebRequest throws Microsoft.PowerShell.Commands.HttpResponseException
    # for non-2xx responses instead of System.Net.WebException. Handle it here.
    if ($_.Exception.Response) {
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
        try { $responseBody = $_.ErrorDetails.Message } catch { $responseBody = $null }
    }
    else {
        $networkError = $_.Exception.Message
    }
}

if ($null -eq $statusCode) {
    Write-Line "Could not reach $ModelEndpoint (network error)."
    if ($networkError) { Write-Line "Details: $networkError" }
    Write-Line ""
    Write-Line "The service may be down, or you may not have network access to it."
    Write-Line "Contact $Admin if this keeps happening."
    Write-Line ""
    Write-Line "Your Continue config was still updated -- once the service is reachable,"
    Write-Line "restart VS Code and try the Continue sidebar again."
}
elseif ($statusCode -eq 200) {
    Write-Line "Your key works."
    Write-Line "Restart VS Code and open the Continue sidebar -- you should see"
    Write-Line "'UA MIS Local' in the model list."
}
elseif ($statusCode -eq 401) {
    Write-Line "Your key was rejected (HTTP 401)."
    Write-Line "Double-check you pasted the whole key, with no extra spaces or"
    Write-Line "missing characters. It should start with 's' 'k' followed by a dash."
    Write-Line "Re-run this script with the correct key if needed."
}
elseif ($statusCode -eq 403) {
    Write-Line "Your key is issued but not yet activated (HTTP 403)."
    Write-Line "This is the normal state for a brand-new key -- nobody gets model"
    Write-Line "access automatically. Ask $Admin to add you to a course team,"
    Write-Line "then just restart VS Code and try again -- no need to re-run this"
    Write-Line "script or get a new key."
}
elseif ($responseBody -and ($responseBody -match '(?i)team|model access|not.*allowed|not.*permitted')) {
    Write-Line "Your key is issued but not yet activated (HTTP $statusCode)."
    Write-Line "This is the normal state for a brand-new key -- nobody gets model"
    Write-Line "access automatically. Ask $Admin to add you to a course team,"
    Write-Line "then just restart VS Code and try again -- no need to re-run this"
    Write-Line "script or get a new key."
}
else {
    Write-Line "Got an unexpected response (HTTP $statusCode)."
    if ($responseBody) { Write-Line "Response: $responseBody" }
    Write-Line ""
    Write-Line "The service may be down. Contact $Admin if this persists."
}

Write-Hr
Write-Line "Done. Restart VS Code, then open the Continue sidebar."
Write-Hr
