#!/usr/bin/env python3
"""secret_scan.py — the SECRET-SCANNING gate for _fragments/** (GATE-1 item 3, DSN-001/D-071).

Everything under `_fragments/<cat>/<id>/skeleton/` is copied VERBATIM into every student's
scaffolded repository. Twice now a real, live credential has been committed into a fragment's
skeleton test file and shipped to students: commit 66d5660 (dotnet-aspnet), then a faithful
copy of the same pattern into the (since-reworked) fastapi DSN-normalization PR. Both were
caught by a human reviewer hash-comparing the committed value against the live cluster Secret
— nothing in CI would have caught either on its own. This module is that CI check.

WHAT IT LOOKS FOR (deliberately SCOPED, not "flag every high-entropy string in the repo" —
that would drown in lockfile hashes, cert fixtures, and base64 test blobs):

  1. WELL-KNOWN SECRET SHAPES, anywhere in a scanned file — a small set of unambiguous
     patterns (AWS access keys, GitHub/Slack tokens, PEM private key blocks, generic JWTs).
     These need no entropy judgment; the shape alone is the signal.
  2. CREDENTIAL-POSITIONED HIGH-ENTROPY VALUES — a value assigned to a credential-sounding
     identifier (password, secret, token, dsn, connectionstring, ...) OR sitting in a URI's
     userinfo position (`scheme://user:VALUE@host`), that looks GENERATED rather than
     human-typed: length >= MIN_SECRET_LENGTH AND at least MIN_CHAR_CLASSES of
     {uppercase, lowercase, digit, symbol} present (the same "complexity" signal password
     generators produce), OR per-character Shannon entropy above ENTROPY_FALLBACK_THRESHOLD
     for values that stay in one case (e.g. a lowercase hex hash).

     Calibrated directly against BOTH known real occurrences: the live DSN-001 credential
     (`OcBvFI0gmEkd2F89ufiDakgihu1` — upper+lower+digit, 27 chars) DOES trigger; its own
     reviewer-suggested replacement (`not-a-real-password` — lowercase + hyphens only, no
     digit, no uppercase) does NOT. This is an inherent, documented limitation shared by
     every pattern/entropy secret scanner (gitleaks, trufflehog, ...): it cannot distinguish
     a real secret from a REALISTIC-LOOKING fake one — only from an OBVIOUSLY fake one. Fake
     fixtures should look obviously fake (`not-a-real-password`, `changeme`, `test123`), not
     high-entropy-random — that is the house style this scanner is designed to reward.

NEVER PRINTS A MATCHED SECRET'S PLAINTEXT. Findings report file, line, rule name, and a
short SHA-256 fingerprint of the match — never the value itself (mirrors FIX-8-REVIEW's own
verification method and FIX-11's explicit "never print the old or new value, cite hashes"
policy). An inline `# gate1:allow-secret` (or `// gate1:allow-secret`, `# gate1:allow-secret`
depending on comment syntax) comment on the FINDING's line suppresses it — the escape hatch
for a legitimate, reviewed, high-entropy-but-fake fixture (e.g. a realistic JWT shape used to
test a parser), so a human can mark a false positive without weakening the scanner globally.
"""
import hashlib
import math
import re
from collections import Counter
from pathlib import Path

# Only text/source files are worth scanning — lockfiles, binaries, and vendored/generated
# trees are excluded both for noise (hashes, base64 blobs) and for speed.
SCAN_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".rb", ".php",
    ".java", ".kt", ".cs", ".swift", ".dart", ".yaml", ".yml", ".json", ".env", ".sh",
    ".md", ".txt", ".toml", ".cfg", ".ini", ".properties", ".gradle", ".xml",
}
EXCLUDE_DIR_NAMES = {
    "node_modules", ".git", "vendor", "target", "build", "dist", "bin", "obj",
    "__pycache__", ".venv", "venv",
    # _tools/ is the compose/gate HARNESS itself (this file included) — never copied into a
    # student's scaffolded repo (only skeleton/ + _contract/ are), so it is out of scope for
    # a scanner whose whole premise is "what ships to students". Test fixtures here (e.g.
    # boot_probe.py's disposable MariaDB root password) are gate-internal, not a leak.
    "_tools",
}
EXCLUDE_FILE_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum",
    "poetry.lock", "composer.lock", "Gemfile.lock",
}

MIN_SECRET_LENGTH = 12
MIN_CHAR_CLASSES = 3          # of {upper, lower, digit, symbol} — the "complexity" signal
ENTROPY_FALLBACK_THRESHOLD = 3.7   # bits/char, for same-case values (e.g. lowercase hex)
ENTROPY_FALLBACK_MIN_LENGTH = 16

ALLOWLIST_MARKER = "gate1:allow-secret"

# ---- (1) well-known shapes — unambiguous regardless of context -----------------------
SHAPE_RULES = [
    ("aws-access-key-id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("private-key-block", re.compile(
        r"-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----")),
    ("generic-jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
]

# ---- (2) credential-positioned high-entropy values ------------------------------------
CREDENTIAL_IDENTIFIER = r"(?:password|passwd|pwd|secret|token|api[_-]?key|credential|dsn|connection[_-]?string|database[_-]?url)"

# Requires QUOTES around the value and excludes `=`/`;` from the value's character class —
# without both, this over-matches unquoted code expressions ("token = process.env.X") and
# grabs the WRONG field out of a `Key=Value;Key=Value` connection string (e.g. captures
# "Server=localhost" off of `DATABASE_URL='Server=localhost;...;Password=X;'` instead of the
# actual password). ADO_CONNECTION_STRING_RULE below handles that shape precisely instead.
ASSIGNMENT_RULE = re.compile(
    rf"{CREDENTIAL_IDENTIFIER}\s*[:=]{{1,2}}>?\s*[\"']([A-Za-z0-9+/_.\-!@#$%^&*]{{{MIN_SECRET_LENGTH},}})[\"']",
    re.IGNORECASE,
)

# ADO.NET / ODBC-style connection strings (`Server=...;Password=X;` or `Pwd=X;`) — this is
# EXACTLY DSN-001's original shape (dotnet-aspnet's ConnectionStringHelperTests.cs). Matches
# the Password=/Pwd= field specifically, quoting-agnostic, so it isn't fooled by an earlier
# `Key=Value` pair in the same string the way a naive first-match scan would be.
ADO_CONNECTION_STRING_RULE = re.compile(r"(?:Password|Pwd)\s*=\s*([^;'\"]+)", re.IGNORECASE)

URI_USERINFO_RULE = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]*://[^:/@\s\"']+:([^@/\s\"']+)@")

# Extracts the CONTENT of every "..." or '...' span on a line (handling \-escaped quotes) —
# used to scope ADO_CONNECTION_STRING_RULE / URI_USERINFO_RULE to actual string literals,
# never a bare source-code expression (see scan_file()).
QUOTED_SPAN_RULE = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"' r"|'([^'\\]*(?:\\.[^'\\]*)*)'")


def _shannon_entropy(s):
    if not s:
        return 0.0
    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _looks_generated(value):
    """True if `value` looks like a generated secret rather than a human-typed placeholder
    (see module docstring for the calibration). Deliberately conservative: both signals are
    designed to trigger on the real DSN-001 credential and NOT on its own reviewer-suggested
    fake replacement.
    """
    if len(value) < MIN_SECRET_LENGTH:
        return False
    classes = 0
    if any(c.isupper() for c in value):
        classes += 1
    if any(c.islower() for c in value):
        classes += 1
    if any(c.isdigit() for c in value):
        classes += 1
    if any(not c.isalnum() for c in value):
        classes += 1
    if classes >= MIN_CHAR_CLASSES:
        return True
    return (len(value) >= ENTROPY_FALLBACK_MIN_LENGTH
            and _shannon_entropy(value) >= ENTROPY_FALLBACK_THRESHOLD)


class Finding:
    __slots__ = ("path", "line_no", "rule", "fingerprint", "line_len")

    def __init__(self, path, line_no, rule, matched_value, line_len):
        self.path = path
        self.line_no = line_no
        self.rule = rule
        # Fingerprint only — see module docstring. Truncated like FIX-8-REVIEW's own
        # verification method (sha256[0:16]).
        self.fingerprint = hashlib.sha256(matched_value.encode("utf-8", "replace")).hexdigest()[:16]
        self.line_len = line_len

    def __repr__(self):
        return f"Finding({self.path}:{self.line_no} {self.rule} sha256[0:16]={self.fingerprint})"

    def to_dict(self):
        return {"path": str(self.path), "line": self.line_no, "rule": self.rule,
                "fingerprint": self.fingerprint}


def _iter_scan_files(root):
    root = Path(root)
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.name in EXCLUDE_FILE_NAMES:
            continue
        if any(part in EXCLUDE_DIR_NAMES for part in p.parts):
            continue
        if p.suffix not in SCAN_EXTENSIONS:
            continue
        yield p


def scan_file(path):
    """Scan one file. Returns a list of Finding. Never raises on unreadable/binary-ish
    content — a file that can't be decoded as UTF-8-ish text is skipped, not fatal (a
    fragment's skeleton is unlikely to ship binary secrets in a text-scanned extension)."""
    findings = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return findings

    lines = text.splitlines()
    for i, line in enumerate(lines, start=1):
        if ALLOWLIST_MARKER in line:
            continue  # explicit human suppression — see module docstring

        for rule_name, pattern in SHAPE_RULES:
            if pattern.search(line):
                findings.append(Finding(path, i, rule_name, pattern.search(line).group(0), len(line)))

        m = ASSIGNMENT_RULE.search(line)
        if m and _looks_generated(m.group(1)):
            findings.append(Finding(path, i, "credential-assignment-high-entropy", m.group(1), len(line)))

        # ADO connection-string and URI-userinfo credentials, in source code, ALWAYS live
        # inside a string literal — a bare `password = someExpression()` source statement
        # never is one. Restricting these two position-based rules to quoted-span CONTENT
        # (not the raw line) is what keeps them from mistaking a same-named C# local
        # variable's assignment expression for a connection-string field.
        for span in QUOTED_SPAN_RULE.finditer(line):
            content = span.group(1) if span.group(1) is not None else span.group(2)
            if not content:
                continue
            m = ADO_CONNECTION_STRING_RULE.search(content)
            if m and _looks_generated(m.group(1).strip()):
                findings.append(Finding(path, i, "ado-connection-string-high-entropy",
                                        m.group(1).strip(), len(line)))

            m = URI_USERINFO_RULE.search(content)
            if m and _looks_generated(m.group(1)):
                findings.append(Finding(path, i, "uri-userinfo-high-entropy", m.group(1), len(line)))

    return findings


def scan_tree(root):
    """Scan every eligible file under `root` (recursive). Returns a flat list of Finding,
    sorted by (path, line) for a stable, diffable report."""
    findings = []
    for f in _iter_scan_files(root):
        findings.extend(scan_file(f))
    findings.sort(key=lambda f: (str(f.path), f.line_no))
    return findings


def main():
    """CLI entry point for the GATE-1 secret-scan CI stage (see wizard-green-check.yaml).

    Usage:
      secret_scan.py [ROOT]     # default ROOT = _fragments/ (this file's grandparent dir)

    Exit 0 = zero findings. Exit 1 = at least one finding (the report lists file:line:rule +
    a fingerprint — see module docstring for why never the plaintext). This mirrors
    green-check.py's exit-code convention so both gates compose the same way in CI.
    """
    import argparse
    import sys

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", nargs="?", default=None,
                    help="directory to scan (default: the _fragments/ tree)")
    a = ap.parse_args()

    root = Path(a.root) if a.root else Path(__file__).resolve().parent.parent
    if not root.is_dir():
        print(f"secret-scan: FATAL — not a directory: {root}", file=sys.stderr)
        return 2

    findings = scan_tree(root)

    print(f"\n=== SECRET SCAN (DSN-001/D-071) — {root} ===\n")
    if not findings:
        print("0 findings. Every scanned file is clean.")
        print("=== SECRET-SCAN OK ===\n")
        return 0

    for f in findings:
        print(f"  [FOUND] {f.path}:{f.line_no}  rule={f.rule}  sha256[0:16]={f.fingerprint}")
    print(f"\n{len(findings)} finding(s) — a credential-shaped value ships in a fragment's "
          f"skeleton/ (copied VERBATIM into every student repo). Rotate any real credential "
          f"immediately, then either remove the value or replace it with an OBVIOUSLY fake "
          f"placeholder (e.g. 'not-a-real-password'). A reviewed, genuinely-fake high-entropy "
          f"fixture may be suppressed inline with a trailing '# gate1:allow-secret' comment.")
    print("=== SECRET-SCAN FAILED ===\n")
    return 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
