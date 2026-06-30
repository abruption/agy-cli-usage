<div align="center">

# agy-cli-usage

[![npm version](https://img.shields.io/npm/v/agy-cli-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/agy-cli-usage)
[![npm downloads](https://img.shields.io/npm/dm/agy-cli-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/agy-cli-usage)
[![CI](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![node](https://img.shields.io/node/v/agy-cli-usage?color=339933&logo=node.js)](https://www.npmjs.com/package/agy-cli-usage)
[![license](https://img.shields.io/npm/l/agy-cli-usage?color=blue)](LICENSE)

**Headless usage & quota monitor for the Antigravity CLI (`agy`).**

Reads `agy`'s `/usage` panel — per–model-group weekly & 5-hour limits, remaining percentage, and refresh times — **headlessly**. No IDE required; works on macOS · Linux · Windows · headless servers.

<sub>Inspired by <a href="https://github.com/skainguyen1412/antigravity-usage">skainguyen1412/antigravity-usage</a> — which targets the Antigravity <b>IDE</b>; this targets the <b>CLI</b> (<code>agy</code>).</sub>

</div>

---

```text
  Models & Quota
  Account: you@gmail.com

  GEMINI MODELS
    Weekly Limit
    [██████████████████████████████████████████████░░░░] 91.72%
    92% remaining · Refreshes in 73h 23m
    Five Hour Limit
    [███████████████████████████████████████████████░░░] 94.63%
    95% remaining · Refreshes in 2h 2m

  CLAUDE AND GPT MODELS
    Weekly Limit
    [█████████████████████████████████████████████████░] 97.78%
    98% remaining · Refreshes in 26h 17m
    Five Hour Limit
    [██████████████████████████████████████████████████] Quota available
```

---

# For Human

## What it is

`agy-cli-usage` shows the same usage/quota information as `agy`'s interactive `/usage` slash command, but from a plain shell — one-shot, watch mode, or machine-readable JSON. Use it to keep an eye on your remaining quota, drive a status bar, or feed a dashboard.

## Why

`agy -p "<prompt>"` (headless mode) is a prompt-only path: it does not render TUI slash commands like `/usage`, so usage can't be polled or automated. This tool fills that gap by reading the quota directly (and falling back to driving `agy` in a pseudo-terminal when needed).

## Quick start

```bash
# Run once, no install
npx agy-cli-usage

# Install globally → `agy-cli-usage` (alias `agy-usage`) anywhere
npm install -g agy-cli-usage
agy-cli-usage
```

> Prerequisites: `agy` is logged in on the same machine, and Node.js >= 18.

## Usage

```bash
agy-cli-usage                  # the /usage panel (one-shot)
agy-cli-usage --json           # machine-readable JSON
agy-cli-usage --watch 60       # auto-refresh every 60s (via the 5-min cache)
agy-cli-usage update [--check] # self-update (--check: report only)
agy-cli-usage --version        # print version
```

| Flag | Description |
|------|-------------|
| `--json` | Normalized JSON output (for scripts/dashboards) |
| `--watch [secs]` | Refresh every N seconds (default 60) |
| `--source <auto\|api\|pty>` | Data source (default `auto`: API → PTY on failure) |
| `--channel <auto\|daily\|prod>` | Cloud Code host |
| `--no-cache` / `--refresh` | Bypass the 5-minute cache |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## How it works

1. **Direct API (default · fast).** Reads `agy`'s OAuth token from the OS and calls the same internal Cloud Code API that `agy` calls on startup:
   - `POST /v1internal:loadCodeAssist` → obtains `cloudaicompanionProject`
   - `POST /v1internal:retrieveUserQuotaSummary {project}` → the quota
   - Refreshes the OAuth token automatically when expired.
2. **PTY fallback (safety net).** If the token can't be read or the internal API changes, it launches `agy` in a pseudo-terminal, sends `/usage`, reconstructs the screen with `@xterm/headless`, and parses it.

## Cross-platform credentials

The token is **read only** from wherever `agy` stored it. Handled per platform automatically:

| OS / environment | Storage | How it's read |
|------------------|---------|---------------|
| macOS | Keychain | `@napi-rs/keyring` (fallback `security`) |
| Linux desktop | Secret Service | `@napi-rs/keyring` (fallback `secret-tool`) |
| **Windows** | Credential Manager | Win32 `CredRead` via built-in `powershell.exe` |
| **Headless Linux** | token file | `~/.gemini/antigravity-cli/antigravity-oauth-token` |

Read order: `keyring → OS CLI → Windows credman → token file → PTY`. Override the file path with `AGY_OAUTH_TOKEN_FILE`.

## HTTP endpoint (optional)

```bash
PORT=3007 npm run serve      # GET /quota → normalized JSON (5-min cache), GET /healthz
```

Consume `GET /quota` from an external dashboard/script, or call `agy-cli-usage --json` as a subprocess.

## Development & Release

Written in TypeScript (strict, ESM) and compiled to `dist/` with `tsc`.

```bash
npm run build     # tsc → dist/ (compiled JS + .d.ts)
npm run check     # tsc --noEmit (type-check)
npm test          # build, then node --test (no credentials/network; pure logic)
```

- **CI**: every push/PR runs the test suite on Ubuntu (Node 18/20/22) + macOS/Windows (Node 22).
- **Release**: [release-please](https://github.com/googleapis/release-please) — fully automated from Conventional Commits. Merged commits keep a **Release PR** (version bump + CHANGELOG) up to date; merging that PR creates the tag + GitHub Release and runs `npm publish --provenance`.

## Caveats

- `v1internal:retrieveUserQuotaSummary` is a **private, undocumented endpoint**. Its schema/host may change without notice; the PTY fallback is the safety net. Use it only to check your own account's usage.
- Credentials are **read-only** from the OS store; the refresh token is never written back, so it never conflicts with `agy`'s own session.
- The OAuth client_id/secret embedded in the code are `agy`'s **installed-app (public)** values — per [Google's docs](https://developers.google.com/identity/protocols/oauth2) these are not treated as secret. Per-user identity comes from your keyring token, not the client_id.

## License

[MIT](LICENSE) © abruption

---

# For Agent (AI)

> Machine-oriented spec for programmatic use. Stable contract: the `--json` snapshot and the `GET /quota` payload share the same shape (`Snapshot`).

## TL;DR

- Binary: `agy-cli-usage` (alias `agy-usage`). Node >= 18. Requires `agy` logged in on the same host.
- Get structured data: `agy-cli-usage --json` (stdout) or `GET http://127.0.0.1:3007/quota`.
- Source order in `auto`: direct API first, PTY fallback second. Results cached 5 minutes.

## Commands

| Invocation | Behavior |
|------------|----------|
| `agy-cli-usage` | Render the panel to stdout (human format). |
| `agy-cli-usage --json` | Print the `Snapshot` JSON to stdout, then exit. |
| `agy-cli-usage --watch [secs]` | Clear screen and re-render every `secs` (min 5, default 60). Runs forever. |
| `agy-cli-usage --source <auto\|api\|pty>` | `api`: API only (throws on failure). `pty`: PTY only (ignores cache). `auto`: API→PTY. |
| `agy-cli-usage --channel <auto\|daily\|prod>` | Cloud Code host selection. `auto` tries `daily` then `prod`. |
| `agy-cli-usage --no-cache` / `--refresh` | Force a fresh fetch (skip the 5-min cache). |
| `agy-cli-usage update [--check]` | Self-update via `npm i -g`. `--check` reports only. |
| `agy-cli-usage --version` / `-v` | Print version string to stdout. |

## JSON output (`--json`) — schema

```jsonc
{
  "account": "you@gmail.com | null",
  "tier": "string | null",
  "fetchedAt": "ISO-8601 timestamp",
  "source": "api | pty",
  "host": "cloud code host | null",
  "note": "string | null",
  "groups": [
    {
      "name": "GEMINI MODELS",
      "models": "comma-separated model list (may be empty)",
      "buckets": [
        {
          "kind": "weekly | 5h | <other>",
          "label": "Weekly Limit",
          "remainingFraction": 0.9172,        // 0..1, or null if unknown
          "usedFraction": 0.0828,             // 1 - remainingFraction, or null
          "resetAt": "ISO-8601 | null",
          "resetsInSeconds": 264180,          // integer seconds, or null
          "available": false,                 // true iff remainingFraction === 1
          "description": "string | null"
        }
      ]
    }
  ]
}
```

Notes for parsing:
- Prefer `remainingFraction` (fraction remaining, 0–1). When `available` is `true`, treat as full quota (the panel shows "Quota available").
- `resetsInSeconds` is relative to `fetchedAt`; `resetAt` is absolute. Either may be `null`.
- `kind` is normalized to `weekly` / `5h` where recognized, otherwise the raw window/label string.

## HTTP API (`npm run serve` / `dist/src/server.js`)

| Route | Response |
|-------|----------|
| `GET /quota` | `200` `Snapshot` JSON (same shape as `--json`). `?refresh=1` bypasses cache. `502 {"error":...}` on failure. Headers: `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`. |
| `GET /healthz` | `200 {"ok":true}` |
| (other) | `404 {"error":"not found"}` |

Binds `HOST` (default `127.0.0.1`) : `PORT` (default `3007`).

## Environment variables

| Variable | Effect |
|----------|--------|
| `AGY_OAUTH_TOKEN_FILE` | Override the token file path (headless fallback). |
| `AGY_BIN` | Path to the `agy` binary (PTY source). Else resolved from `PATH`, then `~/.local/bin`. |
| `XDG_CACHE_HOME` | Cache base dir (cache lives at `<base>/agy-usage/quota.json`; default `~/.cache`). |
| `NO_COLOR` | Disable ANSI color in the rendered panel. |
| `PORT` / `HOST` | HTTP server bind (server mode only). |

## Exit codes & errors

- `0` — success.
- `1` — any error (e.g. `CredentialError` when no token is readable and PTY is unavailable). Error text goes to **stderr**; structured output goes to **stdout**, so `--json` stdout is safe to parse even when stderr carries warnings (e.g. the `[api failed: …] falling back to PTY` notice in `auto` mode).
- `update` returns the underlying `npm` exit status.

## Data sources & cache

- **Cache**: `<XDG_CACHE_HOME|~/.cache>/agy-usage/quota.json`, TTL **5 minutes**. Avoids hammering the upstream API on `--watch`/polling. Bypassed when `source === 'pty'` or the cache is disabled (`--no-cache`/`--refresh`, or `?refresh=1` on the HTTP route).
- **API path** reads the token (keyring/file), then calls `loadCodeAssist` → `retrieveUserQuotaSummary`. **PTY path** drives `agy` (`python3 pty` on POSIX, `node-pty` on Windows) and needs `agy` runnable in the environment.

## Integration notes

- For automation, call `--json` (subprocess) or `GET /quota` (long-running service). Both go through the same cache, so high-frequency polling is safe.
- Do not parse the human panel; it contains ANSI escapes and is layout-oriented. The `Snapshot` JSON is the stable contract.
- The tool only **reads** credentials; it never mutates `agy`'s session or writes tokens back.
