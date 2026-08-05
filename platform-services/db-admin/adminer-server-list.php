<?php

/**
 * Server list with optional stored credentials and Auto Sign-In button.
 * Credentials are handled server-side — never exposed to the browser.
 *
 * Activated by: ADMINER_SERVERS_* env vars
 * DSN format:   driver://username:password@host:port/database
 * Examples:
 *   ADMINER_SERVERS_MariaDB=server://root:secret@mysql:3306/mydb
 *   ADMINER_SERVERS_PostgreSQL=pgsql://postgres:pwd@pg:5432/app
 *   ADMINER_SERVERS_SQLite=sqlite:///data/db.sqlite  (no credentials)
 *
 * The suffix after ADMINER_SERVERS_ becomes the display name in the dropdown.
 *
 * UA-MIS FIX (Adminer 5.4.4 "Invalid server." incident): this is a vendored +
 * patched copy of dockette/adminer's bundled .plugins/adminer-server-list.php
 * (upstream: github.com/dockette/adminer, baked into dockette/adminer:full at
 * /srv/plugins-available/adminer-server-list.php). Mounted here via ConfigMap
 * subPath directly at /srv/adminer-plugins/adminer-server-list.php (see
 * deployment.yaml) instead of relying on the image's own entrypoint.sh
 * ADMINER_PLUGIN_SERVER_LIST=1 copy step -- deployment.yaml intentionally does
 * NOT set that env var, so entrypoint.sh's `cp` for this plugin never runs and
 * never collides (Permission Denied -> container crash, entrypoint.sh has
 * `set -Eeo pipefail`) with this file already being present as a read-only
 * bind mount at the same path. Adminer's own plugin loader glob()s every
 * *.php file under /srv/adminer-plugins/ regardless of that env var, so no
 * other wiring is needed.
 *
 * Root cause this patches: Adminer >=5.4.3 (GHSA-r4x9-5m63-3vxw, "Validate
 * server") added a validation in adminer/include/auth.inc.php --
 * `host_port(SERVER)`'s host component must match `^[-a-z0-9.:]*$` or every
 * login attempt 403s with the literal error "Invalid server." (auth_error()).
 * Unpatched, this plugin submits the raw ADMINER_SERVERS_* env var SUFFIX
 * (e.g. "MariaDB_Root", "CNPG_Crossplane_Provisioner") as `auth[server]`,
 * which becomes SERVER verbatim -- and those suffixes routinely contain
 * underscores (the conventional k8s env var word-separator), which the new
 * regex rejects. Confirmed via vrana/adminer's auth.inc.php diff between
 * v5.4.2 (last working tag) and v5.4.4 (currently deployed, GHSA-r4x9 landed
 * in 5.4.3), and reproduced live against this exact console (Auto Sign-In on
 * "MariaDB_Root" -> HTTP 403 "Invalid server.").
 *
 * Fix: keep the original ADMINER_SERVERS_* suffix as the human-readable
 * dropdown LABEL (unchanged, still shown to the operator), but derive a
 * separate, regex-safe SLUG (non `[a-z0-9.:-]` chars -> `-`, lowercased) and
 * use that everywhere Adminer round-trips the value as `auth[server]` /
 * SERVER -- as the option's submitted value, and as the internal array key
 * for $servers/$credentials lookups. Nothing about the DSNs, credentials, or
 * driver selection changes; only the identifier Adminer validates does.
 *
 * @link https://www.adminer.org/en/plugins/#use
 */
class AdminerServerList extends Adminer\Plugin {
    private $servers = [];
    private $credentials = [];
    private $labels = [];

    function __construct() {
        foreach (getenv() as $key => $value) {
            if (!str_starts_with($key, 'ADMINER_SERVERS_')) {
                continue;
            }
            $name = substr($key, strlen('ADMINER_SERVERS_'));
            if (!preg_match('#^(\w+)://(?:([^:@]*)(?::([^@]*))?@)?([^/:]+)(?::(\d+))?(?:/(.*))?$#', $value, $m)) {
                continue;
            }
            // See class doc comment: Adminer 5.4.3+ validates auth[server]
            // (=> SERVER) against ^[-a-z0-9.:]*$i, so the identifier we hand
            // back to Adminer must be pre-sanitized. $name (the raw env var
            // suffix) stays the display label only.
            $slug = strtolower(preg_replace('/[^a-z0-9.:-]/i', '-', $name));
            $host = $m[4] . (!empty($m[5]) ? ':' . $m[5] : '');
            $this->servers[$slug] = ['server' => $host, 'driver' => $m[1]];
            $this->labels[$slug] = $name;
            if (!empty($m[2])) {
                $this->credentials[$slug] = [
                    'username' => urldecode($m[2]),
                    'password' => urldecode($m[3] ?? ''),
                    'db' => urldecode($m[6] ?? ''),
                ];
            }
        }

        // Set driver from selected server on POST (same as AdminerLoginServers)
        if ($_POST["auth"] && isset($this->servers[$_POST["auth"]["server"]])) {
            $_POST["auth"]["driver"] = $this->servers[$_POST["auth"]["server"]]["driver"];
        }

        // Handle Auto Sign-In: inject stored credentials into POST
        if (isset($_POST["_autologin"]) && isset($this->credentials[$_POST["auth"]["server"]])) {
            $cred = $this->credentials[$_POST["auth"]["server"]];
            $_POST["auth"]["username"] = $cred["username"];
            $_POST["auth"]["password"] = $cred["password"];
            $_POST["auth"]["db"] = $cred["db"];
        }
    }

    function credentials() {
        $server = Adminer\SERVER;
        if (isset($this->servers[$server])) {
            $host = $this->servers[$server]["server"];
            if (isset($this->credentials[$server])) {
                $cred = $this->credentials[$server];
                $username = $_GET["username"] ?: $cred["username"];
                $password = Adminer\get_password() ?: $cred["password"];
                return [$host, $username, $password];
            }
            return [$host, $_GET["username"], Adminer\get_password()];
        }
    }

    function login($login, $password) {
        if (!isset($this->servers[Adminer\SERVER])) {
            return false;
        }
        if (isset($this->credentials[Adminer\SERVER])) {
            return true;
        }
    }

    function loginFormField($name, $heading, $value) {
        if ($name == 'driver') {
            return '';
        }
        if ($name == 'server') {
            // $this->labels is [slug => display name]; html_select() emits
            // value="$slug" (the regex-safe identifier) with the original
            // underscored name as the visible option text.
            return $heading . Adminer\html_select("auth[server]", $this->labels, Adminer\SERVER) . "\n";
        }
    }

    function head() {
        if (isset($_GET["username"]) || empty($this->credentials)) {
            return;
        }
        $servers = json_encode(array_keys($this->credentials), JSON_HEX_TAG | JSON_HEX_AMP);
        $nonce = \Adminer\get_nonce();
        echo <<<SCRIPT
<script nonce="$nonce">
(function() {
    var serversWithCreds = $servers;
    document.addEventListener("DOMContentLoaded", function() {
        var form = document.querySelector("form");
        if (!form) return;
        var serverSelect = form.querySelector('[name="auth[server]"]');
        if (!serverSelect) return;

        var hidden = document.createElement("input");
        hidden.type = "hidden";
        hidden.name = "_autologin";
        hidden.disabled = true;
        form.appendChild(hidden);

        var btn = document.createElement("input");
        btn.type = "submit";
        btn.value = "Auto Sign-In";
        btn.style.display = "none";
        btn.style.marginLeft = "5px";
        btn.addEventListener("click", function() {
            hidden.disabled = false;
            hidden.value = "1";
        });
        var loginBtn = form.querySelector('[type="submit"][value="Login"]');
        if (loginBtn) loginBtn.parentNode.insertBefore(btn, loginBtn.nextSibling);

        function updateButton(serverName) {
            btn.style.display = serversWithCreds.indexOf(serverName) >= 0 ? "inline" : "none";
        }
        serverSelect.addEventListener("change", function() { updateButton(this.value); });
        updateButton(serverSelect.value);
    });
})();
</script>
SCRIPT;
    }
}
