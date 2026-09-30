<#
.SYNOPSIS
  Execution test for setup-windows.ps1 -- runs the real script and
  asserts on the config.yaml it produces.

.DESCRIPTION
  setup-windows.ps1 is the copy-paste onboarding step for MIS 221/321
  students, who are overwhelmingly on Windows laptops. Before this
  harness it had never been EXECUTED anywhere -- there is no PowerShell
  on the dev VM or on the appliance, so it had only ever been reviewed
  by eye, and it was hand-edited twice on 2026-09-30 without any
  execution evidence. A quoting or indentation bug in it is not an edge
  case; it is most of a class failing at step one of the first lab.

  This harness follows the house style of appliances/gb10/test-render-config.sh:
  one process per scenario, assert on the OUTCOME rather than the exit
  code, print PASS/FAIL per assertion, tally, exit non-zero if anything
  failed.

  The one property this test exists to pin down: setup-windows.ps1 must
  never leave a student's config.yaml unparseable, and must never drop a
  model entry the student already had. Both of those failure modes are
  SILENT -- the script prints a success message and exits 0 either way --
  so nothing but parsing the result can catch them.

  Assertions are emitted with a stable machine-readable id
  ("FAILID: <scenario>/<assertion>") so -MutationCheck can verify that
  breaking the script actually trips a SPECIFIC assertion, not just
  "something went red".

.PARAMETER ScriptUnderTest
  Path to the setup-windows.ps1 to exercise. Defaults to the copy
  sitting next to this file. -MutationCheck uses this to point the suite
  at a deliberately-broken copy.

.PARAMETER Launcher
  Which PowerShell runs the script under test. The student-facing
  instructions say `powershell -ExecutionPolicy Bypass -File ...`, i.e.
  Windows PowerShell 5.1 -- NOT pwsh 7. Those two differ in ways this
  script actually depends on (5.1's Invoke-WebRequest throws
  WebException for non-2xx, 7's throws HttpResponseException; the script
  has a catch for each). So CI runs the suite once per launcher and both
  must pass. Defaults to whichever of pwsh/powershell is on PATH.

.PARAMETER AssertEndpointUnreachable
  Assert the "could not reach the endpoint" branch specifically. Only
  pass this when the caller has guaranteed the endpoint is unreachable
  (CI points local-llm.uamishub.com at 127.0.0.1 via the hosts file).
  Off by default so the suite is not flaky when run from a machine that
  can actually reach the real endpoint.

.PARAMETER MutationCheck
  Do not run the suite directly. Instead, generate deliberately-broken
  copies of the script under test and verify the suite CATCHES each one
  by tripping an expected assertion. A test that passes against a broken
  script is worse than no test, so this is checked in rather than done
  once by hand.

.EXAMPLE
  pwsh -File ./test-setup-windows.ps1
.EXAMPLE
  pwsh -File ./test-setup-windows.ps1 -Launcher powershell
.EXAMPLE
  pwsh -File ./test-setup-windows.ps1 -MutationCheck
#>
param(
    [string]$ScriptUnderTest,
    [string]$Launcher,
    [switch]$AssertEndpointUnreachable,
    [switch]$MutationCheck
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptUnderTest) { $ScriptUnderTest = Join-Path $here 'setup-windows.ps1' }
$ScriptUnderTest = (Resolve-Path $ScriptUnderTest).Path
$yamlToJson = Join-Path $here 'yaml-to-json.py'

# The expected values. These are the properties the config must have --
# duplicated here ON PURPOSE rather than read from the script, because a
# test that derives its expectations from the code under test asserts
# nothing.
$ENDPOINT   = 'https://local-llm.uamishub.com/v1'
$MODEL_ID   = 'qwen3.8-27b'
# Shaped like a real LiteLLM virtual key (sk- + url-safe base64, so it
# exercises both '-' and '_' surviving the write) but obviously fake.
$DUMMY_KEY  = 'sk-uamis_TEST-do_not_use-0123456789abcdef'
$EXPECTED = @(
    @{ Name = 'UA MIS Local (Chat)';  Roles = @('chat');          MaxTokens = 4000 }
    @{ Name = 'UA MIS Local (Edit)';  Roles = @('edit','apply');  MaxTokens = 400  }
    @{ Name = 'UA MIS Local (Agent)'; Roles = @('agent');         MaxTokens = 8000 }
)

# ---------------------------------------------------------------------------
# Harness plumbing
# ---------------------------------------------------------------------------

$script:failures  = 0
$script:passes    = 0
$script:failIds   = New-Object System.Collections.Generic.List[string]
$script:scenario  = '<none>'

function Pass([string]$id, [string]$desc) {
    Write-Host "PASS: $($script:scenario)/$id -- $desc"
    $script:passes++
}
function Fail([string]$id, [string]$desc, [string]$detail) {
    Write-Host "FAIL: $($script:scenario)/$id -- $desc"
    if ($detail) { $detail -split "`n" | ForEach-Object { Write-Host "    $_" } }
    Write-Host "FAILID: $($script:scenario)/$id"
    $script:failIds.Add("$($script:scenario)/$id")
    $script:failures++
}
function Assert-Equal([string]$id, [string]$desc, $expected, $actual) {
    if ($expected -eq $actual) { Pass $id $desc }
    else { Fail $id $desc "expected: $expected`nactual:   $actual" }
}
function Assert-True([string]$id, [string]$desc, [bool]$cond, [string]$detail) {
    if ($cond) { Pass $id $desc } else { Fail $id $desc $detail }
}

function Resolve-Python {
    foreach ($c in @('python3','python')) {
        $p = Get-Command $c -ErrorAction SilentlyContinue
        if ($p) {
            # Confirm PyYAML is actually importable before trusting it.
            & $p.Source -c 'import yaml' 2>$null
            if ($LASTEXITCODE -eq 0) { return $p.Source }
        }
    }
    throw "No python with PyYAML on PATH. Install it: pip install pyyaml"
}
$PYTHON = Resolve-Python

function Resolve-Launcher {
    if ($Launcher) {
        $p = Get-Command $Launcher -ErrorAction SilentlyContinue
        if (-not $p) { throw "Launcher '$Launcher' not found on PATH." }
        return $p.Source
    }
    foreach ($c in @('pwsh','powershell')) {
        $p = Get-Command $c -ErrorAction SilentlyContinue
        if ($p) { return $p.Source }
    }
    throw "Neither pwsh nor powershell found on PATH."
}
$LAUNCHER = Resolve-Launcher

# Runs the script under test in a CHILD process with a throwaway
# USERPROFILE, so the script's own Join-Path $env:USERPROFILE ".continue"
# lands in a temp dir and the real profile is never touched.
# Returns @{ Exit; Output; Home; Config }.
function Invoke-Setup {
    param(
        [string]$HomeDir,                  # fake USERPROFILE
        [string]$ApiKey = $DUMMY_KEY,
        [switch]$NoKeyArg,
        # Which file to execute. Defaults to the script under test; the
        # portal-embedded-key scenarios pass a substituted COPY of it.
        [string]$ScriptPath = $ScriptUnderTest
    )
    $prevProfile  = $env:USERPROFILE
    $prevHttps    = $env:HTTPS_PROXY
    $prevHttp     = $env:HTTP_PROXY
    try {
        $env:USERPROFILE = $HomeDir
        # Belt and braces for the endpoint check. CI additionally points
        # the hostname at 127.0.0.1 in the hosts file, which is what
        # actually stops Windows PowerShell 5.1 (whose Invoke-WebRequest
        # uses the system proxy settings, not these env vars). On Linux
        # under pwsh these are what keep the suite off the network.
        $env:HTTPS_PROXY = 'http://127.0.0.1:9'
        $env:HTTP_PROXY  = 'http://127.0.0.1:9'

        $argList = @('-NoProfile')
        if ($IsWindows -ne $false) { $argList += @('-ExecutionPolicy','Bypass') }
        $argList += @('-File', $ScriptPath)
        if (-not $NoKeyArg) { $argList += @('-ApiKey', $ApiKey) }

        $out = & $LAUNCHER @argList 2>&1 | Out-String
        $code = $LASTEXITCODE
        return @{
            Exit   = $code
            Output = $out
            Home   = $HomeDir
            Config = (Join-Path (Join-Path $HomeDir '.continue') 'config.yaml')
        }
    }
    finally {
        $env:USERPROFILE = $prevProfile
        $env:HTTPS_PROXY = $prevHttps
        $env:HTTP_PROXY  = $prevHttp
    }
}

function New-Home {
    param([string]$ExistingConfigYaml, [string]$ExistingConfigJson, [switch]$Crlf)
    $h = Join-Path ([System.IO.Path]::GetTempPath()) ("uamis-setup-test-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Force -Path $h | Out-Null
    if ($PSBoundParameters.ContainsKey('ExistingConfigYaml') -or $PSBoundParameters.ContainsKey('ExistingConfigJson')) {
        $cd = Join-Path $h '.continue'
        New-Item -ItemType Directory -Force -Path $cd | Out-Null
        $enc = New-Object System.Text.UTF8Encoding($false)
        if ($ExistingConfigYaml) {
            $body = $ExistingConfigYaml
            if ($Crlf) { $body = ($body -replace "`r`n","`n") -replace "`n","`r`n" }
            [System.IO.File]::WriteAllText((Join-Path $cd 'config.yaml'), $body, $enc)
        }
        if ($ExistingConfigJson) {
            [System.IO.File]::WriteAllText((Join-Path $cd 'config.json'), $ExistingConfigJson, $enc)
        }
    }
    return $h
}

# Parse with a real YAML parser. Returns $null and reports the failure if
# the file is not valid YAML -- which IS the headline assertion, not a
# harness problem.
function Get-ParsedConfig {
    param([string]$Id, [string]$Path)
    if (-not (Test-Path $Path)) {
        Fail $Id "config.yaml exists" "no file at $Path"
        return $null
    }
    $json = & $PYTHON $yamlToJson $Path 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($code -eq 2) {
        $body = ''
        try { $body = (Get-Content -Raw -Path $Path) } catch { }
        Fail $Id "config.yaml is valid YAML" ("parser said:`n" + $json.Trim() + "`n--- file as written ---`n" + $body)
        return $null
    }
    if ($code -ne 0) { throw "yaml-to-json.py harness error (exit $code): $json" }
    Pass $Id "config.yaml is valid YAML"
    return ($json | ConvertFrom-Json)
}

# The core property set: our three entries, exactly right.
function Assert-OurThreeEntries {
    param($Doc, [string]$Key = $DUMMY_KEY)
    if (-not $Doc) { return }
    $models = @($Doc.models)
    foreach ($exp in $EXPECTED) {
        $short = ($exp.Name -replace '[^A-Za-z]','')
        $m = $models | Where-Object { $_.name -eq $exp.Name } | Select-Object -First 1
        if (-not $m) {
            Fail "entry-$short" "'$($exp.Name)' entry present" ("models found: " + (($models | ForEach-Object { $_.name }) -join ', '))
            continue
        }
        Pass "entry-$short" "'$($exp.Name)' entry present"
        Assert-Equal "provider-$short"  "$($exp.Name) provider is openai"       'openai'   $m.provider
        Assert-Equal "model-$short"     "$($exp.Name) model is $MODEL_ID"       $MODEL_ID  $m.model
        Assert-Equal "apibase-$short"   "$($exp.Name) apiBase is the endpoint"  $ENDPOINT  $m.apiBase
        # Key fidelity: the whole key, byte for byte. An unquoted YAML
        # scalar is where a key silently loses its tail.
        Assert-Equal "apikey-$short"    "$($exp.Name) apiKey round-trips exactly" $Key      $m.apiKey
        Assert-Equal "roles-$short"     "$($exp.Name) roles are [$($exp.Roles -join ', ')]" ($exp.Roles -join ',') ((@($m.roles)) -join ',')
        Assert-Equal "maxtok-$short"    "$($exp.Name) maxTokens is $($exp.MaxTokens)" $exp.MaxTokens $m.defaultCompletionOptions.maxTokens

        # enable_thinking must be boolean false. The string 'false' is
        # truthy to most clients and would silently leave reasoning ON,
        # which truncates every small-maxTokens role mid-thought -- so
        # assert the TYPE as well as the value.
        $et = $m.requestOptions.extraBodyProperties.chat_template_kwargs.enable_thinking
        if ($null -eq $et) {
            Fail "thinking-$short" "$($exp.Name) has enable_thinking: false" "requestOptions.extraBodyProperties.chat_template_kwargs.enable_thinking is absent"
        } elseif ($et -isnot [bool]) {
            Fail "thinking-$short" "$($exp.Name) has enable_thinking: false" "present but not a YAML boolean; got [$($et.GetType().Name)] '$et'"
        } elseif ($et -ne $false) {
            Fail "thinking-$short" "$($exp.Name) has enable_thinking: false" "boolean, but true"
        } else {
            Pass "thinking-$short" "$($exp.Name) has enable_thinking: false (boolean)"
        }
    }
    # No autocomplete role anywhere: this shared GPU box is deliberately
    # not answering every keystroke.
    $ac = @($models | Where-Object { $_.roles -contains 'autocomplete' })
    Assert-True "no-autocomplete" "no entry declares the autocomplete role" ($ac.Count -eq 0) ("entries with autocomplete: " + (($ac | ForEach-Object { $_.name }) -join ', '))
}

function Assert-NoKeyLeak {
    param($Res)
    Assert-True "no-key-in-stdout" "the API key is never echoed to the console" (-not $Res.Output.Contains($DUMMY_KEY)) "the key appeared in the script's own output"
}

# Writes a copy of the script under test with the keys portal's
# substitution already applied, exactly as keyportal/app.py serves it:
# the single line `$EmbeddedKey = ''` becomes `$EmbeddedKey = '<key>'`.
#
# Reproduced here in the SAME quoting rule the portal uses -- a
# single-quoted PowerShell literal, with a literal quote written by
# DOUBLING it -- so that if the portal's rule and this script's parsing
# ever disagree, this suite is what says so, in CI, rather than a
# student's opaque 401. Note that rule is the OPPOSITE of the POSIX shell
# rule the macOS/Linux script's own portal substitution uses ('\''), and
# using either in the other's place fails SILENTLY.
#
# Throws if the marker line is not present exactly once -- the same
# contract keyportal/app.py's _validate_setup_script() enforces at
# startup. A silently-unsubstituted copy would make the scenarios below
# pass for the wrong reason.
function New-EmbeddedKeyScript {
    param([string]$ApiKey)
    $marker = "`$EmbeddedKey = ''"
    $quoted = "'" + ($ApiKey -replace "'", "''") + "'"
    $hits   = 0
    $lines  = [System.IO.File]::ReadAllLines($ScriptUnderTest)
    $out    = foreach ($line in $lines) {
        if ($line -eq $marker) { $hits++; '$EmbeddedKey = ' + $quoted } else { $line }
    }
    if ($hits -ne 1) {
        throw "HARNESS ERROR: expected exactly one '$marker' line in $ScriptUnderTest, found $hits"
    }
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("uamis-served-" + [guid]::NewGuid().ToString('n') + ".ps1")
    [System.IO.File]::WriteAllLines($path, $out, (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

function Get-Sha([string]$Path) { (Get-FileHash -Algorithm SHA256 -Path $Path).Hash }
function Get-Backups([string]$HomeDir) {
    $cd = Join-Path $HomeDir '.continue'
    if (-not (Test-Path $cd)) { return @() }
    return @(Get-ChildItem -Path $cd -Filter 'config.yaml.bak-*' -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# Fixtures. Every one of these is a shape a real student's config.yaml
# can legitimately be in.
# ---------------------------------------------------------------------------

$EXISTING_2SPACE = @'
name: my-config
version: 0.0.1
schema: v1
models:
  - name: Claude Sonnet 4
    provider: anthropic
    model: claude-sonnet-4-20250514
    apiKey: sk-ant-ALREADY-HERE
    roles: [chat, edit]
context:
  - provider: code
'@

# Zero-indented sequence items under a mapping key. This is ordinary,
# valid YAML -- it is what `yq` emits by default and a perfectly normal
# way to hand-write the file.
$EXISTING_0SPACE = @'
name: my-config
version: 0.0.1
schema: v1
models:
- name: Claude Sonnet 4
  provider: anthropic
  model: claude-sonnet-4-20250514
  apiKey: sk-ant-ALREADY-HERE
  roles: [chat, edit]
'@

# A comment between `models:` and the first item, with the item at the
# ordinary 2-space indent. Isolates the comment-skipping logic from the
# indent-detection logic.
$EXISTING_COMMENT_FIRST = @'
schema: v1
models:
  # my own models live below
  - name: Claude Sonnet 4
    provider: anthropic
    apiKey: sk-ant-ALREADY-HERE
    roles: [chat, edit]
'@

$EXISTING_NO_MODELS = @'
name: my-config
version: 0.0.1
schema: v1
context:
  - provider: code
  - provider: docs
'@

$EXISTING_FLOW = @'
schema: v1
models: [{name: Claude, provider: anthropic, apiKey: sk-ant-ALREADY-HERE}]
'@

$EXISTING_DUPLICATE_MODELS = @'
schema: v1
models:
  - name: First
    provider: anthropic
other: thing
models:
  - name: Second
    provider: openai
'@

# Asserts the student's pre-existing entry survived intact.
function Assert-ExistingPreserved {
    param($Doc, [string]$Name = 'Claude Sonnet 4', [string]$Key = 'sk-ant-ALREADY-HERE')
    if (-not $Doc) { return }
    $models = @($Doc.models)
    $m = $models | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $m) {
        Fail "preserved-entry" "the student's existing '$Name' entry survives" ("models found: " + (($models | ForEach-Object { $_.name }) -join ', '))
        return
    }
    Pass "preserved-entry" "the student's existing '$Name' entry survives"
    Assert-Equal "preserved-key" "the existing entry's own apiKey is untouched" $Key $m.apiKey
    Assert-Equal "model-count" "the file has our 3 entries plus the existing 1" 4 $models.Count
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

function Run-Suite {

Write-Host "Script under test : $ScriptUnderTest"
Write-Host "Launcher          : $LAUNCHER"
Write-Host "YAML parser       : $PYTHON $yamlToJson"
Write-Host ""

# --- S1: no existing config at all (the common first-time case) --------
$script:scenario = 'S1-fresh'
$h = New-Home
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "exits 0 on a clean machine" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-True "count" "writes exactly our 3 model entries" ((@($doc.models)).Count -eq 3) ("count was " + (@($doc.models)).Count)
Assert-OurThreeEntries $doc
Assert-NoKeyLeak $r
if ($AssertEndpointUnreachable) {
    Assert-True "unreachable-msg" "an unreachable endpoint is reported, not swallowed" ($r.Output -match 'Could not reach') "expected a 'Could not reach' message"
    Assert-True "unreachable-nonfatal" "an unreachable endpoint still leaves the config in place" ($r.Output -match 'config was still updated') "expected the 'config was still updated' reassurance"
}

# --- S2: existing config, 2-space list (must MERGE, not clobber) -------
$script:scenario = 'S2-merge-2space'
$h = New-Home -ExistingConfigYaml $EXISTING_2SPACE
$before = Get-Content -Raw -Path (Join-Path $h '.continue/config.yaml')
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "exits 0 when merging into an existing config" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc
Assert-ExistingPreserved $doc
Assert-True "other-keys" "unrelated top-level keys survive" (($doc.schema -eq 'v1') -and ($doc.name -eq 'my-config')) "schema/name did not survive the merge"
$baks = Get-Backups $h
Assert-True "backup-made" "a timestamped backup of the original is written" ($baks.Count -eq 1) "found $($baks.Count) backup files"
if ($baks.Count -eq 1) {
    Assert-Equal "backup-content" "the backup is the original file, byte for byte" $before (Get-Content -Raw -Path $baks[0].FullName)
}
Assert-NoKeyLeak $r

# --- S3: existing config with a ZERO-INDENTED list ---------------------
# Same valid YAML, written in the other ordinary style. This is the
# scenario that catches the indent-detection defect.
$script:scenario = 'S3-merge-0space'
$h = New-Home -ExistingConfigYaml $EXISTING_0SPACE
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "exits 0 when merging into a zero-indented list" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc
Assert-ExistingPreserved $doc
Assert-NoKeyLeak $r

# --- S4: comment between `models:` and the first item ------------------
$script:scenario = 'S4-merge-comment-first'
$h = New-Home -ExistingConfigYaml $EXISTING_COMMENT_FIRST
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "exits 0 when a comment precedes the first item" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc
Assert-ExistingPreserved $doc

# --- S5: existing config with no `models:` key at all ------------------
$script:scenario = 'S5-no-models-key'
$h = New-Home -ExistingConfigYaml $EXISTING_NO_MODELS
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "exits 0 and appends a models section" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-True "count" "adds exactly our 3 entries" ((@($doc.models)).Count -eq 3) ("count was " + (@($doc.models)).Count)
Assert-OurThreeEntries $doc
Assert-True "other-keys" "the pre-existing keys survive" (($doc.schema -eq 'v1') -and ((@($doc.context)).Count -eq 2)) "schema/context did not survive"

# --- S6: flow-style models list: refuse, do not mangle -----------------
$script:scenario = 'S6-flow-style'
$h = New-Home -ExistingConfigYaml $EXISTING_FLOW
$cfg = Join-Path $h '.continue/config.yaml'
$sha = Get-Sha $cfg
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "refuses flow style with a non-zero exit" 1 $r.Exit
Assert-Equal "untouched" "leaves the file byte-identical" $sha (Get-Sha $cfg)
Assert-True "no-backup" "does not leave a stray backup behind" ((Get-Backups $h).Count -eq 0) "a backup was written for a run that changed nothing"
Assert-True "handoff" "prints a hand-editable block with a key placeholder" ($r.Output -match '<YOUR_KEY>') "expected the <YOUR_KEY> placeholder in the guidance"
Assert-NoKeyLeak $r

# --- S7: two top-level `models:` keys: refuse -------------------------
$script:scenario = 'S7-duplicate-models'
$h = New-Home -ExistingConfigYaml $EXISTING_DUPLICATE_MODELS
$cfg = Join-Path $h '.continue/config.yaml'
$sha = Get-Sha $cfg
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "refuses an ambiguous file with a non-zero exit" 1 $r.Exit
Assert-Equal "untouched" "leaves the file byte-identical" $sha (Get-Sha $cfg)
Assert-NoKeyLeak $r

# --- S8: legacy config.json only: refuse, do not convert --------------
$script:scenario = 'S8-legacy-json'
$h = New-Home -ExistingConfigJson '{"models":[{"title":"Old","provider":"anthropic"}]}'
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "refuses a legacy config.json with a non-zero exit" 1 $r.Exit
Assert-True "no-yaml-written" "does not create a config.yaml alongside it" (-not (Test-Path (Join-Path $h '.continue/config.yaml'))) "a config.yaml was created anyway"
Assert-True "json-untouched" "leaves the legacy config.json in place" (Test-Path (Join-Path $h '.continue/config.json')) "the legacy file disappeared"

# --- S9: re-run over our own output is a no-op ------------------------
# Students re-run this. A second run must not duplicate the entries.
$script:scenario = 'S9-rerun-idempotent'
$h = New-Home
$r1 = Invoke-Setup -HomeDir $h
$sha = Get-Sha $r1.Config
$r2 = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "a second run exits 0" 0 $r2.Exit
Assert-Equal "unchanged" "a second run leaves the file byte-identical" $sha (Get-Sha $r2.Config)
$doc = Get-ParsedConfig "yaml" $r2.Config
Assert-True "count" "a second run does not duplicate the entries" ((@($doc.models)).Count -eq 3) ("count was " + (@($doc.models)).Count)
Assert-True "no-backup" "a run that changes nothing writes no backup" ((Get-Backups $h).Count -eq 0) "a backup was written for a no-op run"

# --- S10: CRLF config (a Windows-edited file) ------------------------
$script:scenario = 'S10-crlf-existing'
$h = New-Home -ExistingConfigYaml $EXISTING_2SPACE -Crlf
$r = Invoke-Setup -HomeDir $h
Assert-Equal "exit" "exits 0 on a CRLF config" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc
Assert-ExistingPreserved $doc

# --- S11: a key with regex/YAML-significant characters ---------------
# Not a shape LiteLLM mints today, but apiKey is written as an UNQUOTED
# YAML scalar, so this pins down that the whole key survives.
$script:scenario = 'S11-awkward-key'
$awkward = 'sk-a1b2_c3-d4.e5'
$h = New-Home
$r = Invoke-Setup -HomeDir $h -ApiKey $awkward
Assert-Equal "exit" "exits 0 with a punctuation-heavy key" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc -Key $awkward

# --- S12: a key containing YAML-significant punctuation ----------------
# apiKey is written into the file as a YAML scalar, so the quoting of that
# scalar decides whether the key survives. The two hazards, both SILENT:
# " #" starts a comment and truncates the key at that point, and ": "
# turns the value into a nested mapping. Either produces a valid-looking
# config.yaml, a wrong key, and a 401 the student cannot diagnose.
#
# LiteLLM does not mint keys shaped like this today (sk- plus url-safe
# base64), so this is defence against a mis-paste or a future key format
# rather than a live bug -- but it costs two characters to be right.
$script:scenario = 'S12-yaml-hostile-key'
$hostileKey = "sk-abc #hash def: ghi 'jkl"
$h = New-Home
$r = Invoke-Setup -HomeDir $h -ApiKey $hostileKey
Assert-Equal "exit" "exits 0 with a YAML-significant key" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc -Key $hostileKey

# --- S13: the key the PORTAL embedded, with no -ApiKey at all -----------
# The keys portal (keyportal/app.py) serves this script with the student's
# own key substituted into the $EmbeddedKey line, so the student runs it
# with no parameter and answers no prompt. Every other scenario in this
# suite passes -ApiKey, which means none of them execute the path an
# actual portal-served run takes.
#
# That gap is exactly the kind this suite exists to close: the whole
# reason the portal serves these files instead of embedding its own copy
# is so that CI covers what students run. Serving a script through an
# untested code path would give that up for the one line that matters
# most -- and on Windows this runner is the ONLY PowerShell that ever
# executes this file, since there is none on the dev VM or the appliance.
$script:scenario = 'S13-portal-embedded-key'
$served = New-EmbeddedKeyScript -ApiKey $DUMMY_KEY
$h = New-Home
$r = Invoke-Setup -HomeDir $h -NoKeyArg -ScriptPath $served
Assert-Equal "exit" "exits 0 with the key embedded and no -ApiKey" 0 $r.Exit
Assert-True "no-prompt" "never prompts when the portal already embedded a key" `
    (-not $r.Output.Contains('Paste your local-llm key')) `
    "the script prompted anyway -- the embedded key did not reach `$ApiKey"
Assert-NoKeyLeak $r
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc -Key $DUMMY_KEY

# --- S14: a portal-embedded key hostile to BOTH quoting layers ----------
# The key now passes through TWO single-quoting layers on its way into
# config.yaml -- the portal's PowerShell literal and Build-Block's YAML
# scalar. Both happen to double a literal quote here, but they are
# independent implementations, and getting either wrong does not error:
# it silently drops or duplicates a character, producing a valid-looking
# config.yaml with a wrong key and an opaque 401. This is S12's hazard one
# layer deeper, and only an executed round trip catches it.
$script:scenario = 'S14-portal-embedded-hostile-key'
$served = New-EmbeddedKeyScript -ApiKey $hostileKey
$h = New-Home
$r = Invoke-Setup -HomeDir $h -NoKeyArg -ScriptPath $served
Assert-Equal "exit" "exits 0 with a doubly-hostile embedded key" 0 $r.Exit
$doc = Get-ParsedConfig "yaml" $r.Config
Assert-OurThreeEntries $doc -Key $hostileKey

Write-Host ""
Write-Host "$($script:passes) passed, $($script:failures) failed."
if ($script:failures -ne 0) { return 1 }
return 0
}

# ---------------------------------------------------------------------------
# -MutationCheck: prove the suite above actually catches a broken script.
# ---------------------------------------------------------------------------

$MUTATIONS = @(
    @{
        Id     = 'M1-collapse-continuation-indent'
        Why    = 'Structural/quoting break: continuation keys line up with the "- " dash instead of being indented under it, so the block is no longer valid YAML.'
        Find   = '$contIndent = "$DashIndent  "'
        Repl   = '$contIndent = "$DashIndent"'
        Expect = '/yaml$'
    },
    @{
        Id     = 'M2-drop-enable-thinking-from-edit'
        Why    = 'Subtle break: the Edit entry silently loses enable_thinking: false, so that role truncates mid-reasoning. The file is still perfectly valid YAML.'
        Find   = @'
    $lines += "$contIndent" + "  maxTokens: 400"
    $lines += "$contIndent" + "requestOptions:"
    $lines += "$contIndent" + "  extraBodyProperties:"
    $lines += "$contIndent" + "    chat_template_kwargs:"
    $lines += "$contIndent" + "      enable_thinking: false"
'@
        Repl   = '    $lines += "$contIndent" + "  maxTokens: 400"'
        Expect = '/thinking-UAMISLocalEdit$'
    },
    @{
        Id     = 'M3-wrong-maxtokens-on-chat'
        Why    = 'Value regression: the Chat cap drops from 4000 to 2000, which truncates good answers. Valid YAML, right shape, wrong number.'
        Find   = '$lines += "$contIndent" + "  maxTokens: 4000"'
        Repl   = '$lines += "$contIndent" + "  maxTokens: 2000"'
        Expect = '/maxtok-UAMISLocalChat$'
    },
    @{
        Id     = 'M4-clobber-existing-entries'
        Why    = "Data loss: the merge drops everything after the models: line, so a student's existing provider is silently deleted. Valid YAML, our entries all correct."
        Find   = '$newLines = $before + $block + $after'
        Repl   = '$newLines = $before + $block'
        Expect = '/preserved-entry$'
    },
    @{
        Id     = 'M5-drop-apply-role-from-edit'
        Why    = 'Role regression: the Edit entry stops declaring apply, so Continue offers no model for Apply. Valid YAML.'
        Find   = '$lines += "$contIndent" + "roles: [edit, apply]"'
        Repl   = '$lines += "$contIndent" + "roles: [edit]"'
        Expect = '/roles-UAMISLocalEdit$'
    },
    @{
        Id     = 'M6-unquote-the-apikey'
        Why    = 'Silent truncation: the apiKey scalar goes back to being unquoted, so a key containing " #" is cut off at the comment marker. Valid YAML, wrong key, opaque 401.'
        Find   = '$lines += "$contIndent" + "apiKey: $yamlKey"'
        Repl   = '$lines += "$contIndent" + "apiKey: $KeyToPrint"'
        Expect = '^S12-yaml-hostile-key/apikey-'
    },
    @{
        Id     = 'M7-ignore-the-embedded-key'
        Why    = "Portal regression: `$ApiKey stops picking up `$EmbeddedKey, so a portal-served script ignores the key the portal put in it. Deliberately mutated to a WRONG key rather than to empty: empty would fall through to Read-Host, which in a non-interactive runner is a HANG rather than a clean failure, and a mutation check that times out proves nothing."
        Find   = '    $ApiKey = $EmbeddedKey'
        Repl   = "    `$ApiKey = 'sk-mutant-ignored-the-embedded-key'"
        Expect = '^S1[34]-portal-embedded.*/apikey-'
    }
)

function Get-FailIds {
    param([string]$Path)
    # Re-invoke THIS file against the given script, capturing its FAILIDs.
    $selfArgs = @('-NoProfile','-File', (Join-Path $here 'test-setup-windows.ps1'), '-ScriptUnderTest', $Path)
    if ($Launcher) { $selfArgs += @('-Launcher', $Launcher) }
    $out = & $LAUNCHER_SELF @selfArgs 2>&1 | Out-String
    $ids = [regex]::Matches($out, '(?m)^FAILID: (.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() }
    return @{ Ids = @($ids); Output = $out }
}

function Run-MutationCheck {
    Write-Host "=== Mutation check: does the suite actually catch a broken script? ==="
    Write-Host ""

    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("uamis-mutants-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $pristine = Get-Content -Raw -Path $ScriptUnderTest

    Write-Host "--- baseline: the suite against the UNMODIFIED script ---"
    $base = Get-FailIds $ScriptUnderTest
    if ($base.Ids.Count -eq 0) {
        Write-Host "baseline: suite is GREEN (no FAILIDs)."
    } else {
        Write-Host "baseline: suite is RED with $($base.Ids.Count) pre-existing failure(s):"
        $base.Ids | Sort-Object -Unique | ForEach-Object { Write-Host "    $_" }
        Write-Host "(Mutations are judged by the failures they ADD on top of this baseline,"
        Write-Host " so a real open defect does not mask a mutation.)"
    }
    Write-Host ""

    $mutFail = 0
    foreach ($m in $MUTATIONS) {
        Write-Host "--- $($m.Id) ---"
        Write-Host "    $($m.Why)"
        if (-not $pristine.Contains($m.Find)) {
            Write-Host "MUTANT-ERROR: $($m.Id) -- anchor text not found in the script; the mutation could not be applied."
            Write-Host "    anchor: $($m.Find)"
            $mutFail++
            continue
        }
        $mutantPath = Join-Path $work ("setup-windows-" + $m.Id + ".ps1")
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($mutantPath, $pristine.Replace($m.Find, $m.Repl), $enc)

        $res = Get-FailIds $mutantPath
        $added = @($res.Ids | Where-Object { $base.Ids -notcontains $_ } | Sort-Object -Unique)
        $hit   = @($added | Where-Object { $_ -match $m.Expect })

        if ($res.Ids.Count -eq 0) {
            Write-Host "MUTANT-SURVIVED: $($m.Id) -- the suite PASSED against the broken script. The assertions have a gap."
            $mutFail++
        } elseif ($added.Count -eq 0) {
            Write-Host "MUTANT-SURVIVED: $($m.Id) -- the suite failed, but only with the same failures as the baseline, so this mutation was not detected."
            $mutFail++
        } elseif ($hit.Count -eq 0) {
            Write-Host "MUTANT-MISDETECTED: $($m.Id) -- the suite added failures, but none matching the expected assertion '$($m.Expect)'."
            Write-Host "    added: $($added -join ', ')"
            $mutFail++
        } else {
            Write-Host "MUTANT-CAUGHT: $($m.Id) -- newly tripped: $($hit -join ', ')"
            if (($added | Where-Object { $hit -notcontains $_ }).Count -gt 0) {
                Write-Host "    (also newly tripped: $((($added | Where-Object { $hit -notcontains $_ })) -join ', '))"
            }
        }
        Write-Host ""
    }

    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue

    Write-Host "=== Mutation check: $($MUTATIONS.Count - $mutFail)/$($MUTATIONS.Count) mutations caught ==="
    if ($mutFail -ne 0) { return 1 }
    return 0
}

$LAUNCHER_SELF = (Get-Process -Id $PID).Path
if (-not $LAUNCHER_SELF) { $LAUNCHER_SELF = $LAUNCHER }

if ($MutationCheck) { exit (Run-MutationCheck) }
exit (Run-Suite)
