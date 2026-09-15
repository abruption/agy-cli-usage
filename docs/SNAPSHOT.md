# Snapshot contract

`agy-cli-usage --json` and `GET /quota` return the same `Snapshot` defined in
[`src/types.ts`](../src/types.ts). Existing quota fields retain their meaning;
consumers must tolerate additive optional fields. A successful quota response
stays successful when update checking fails. `/healthz` has no update metadata.

## Optional `clientUpdate` (schema version 1)

```json
{
  "schemaVersion": 1,
  "status": "available",
  "current": "1.0.0",
  "latest": "1.0.1",
  "checkedAt": "2026-09-15T10:00:00.000Z",
  "source": "npm_registry_cache",
  "command": "agy-cli-usage update"
}
```

This object is attached as `Snapshot.clientUpdate` only when a fresh, validated
stable npm version is numerically greater than the installed CLI version.
`current` is read from the invoking installation on each response, not cached.
`checkedAt` is the UTC ISO timestamp when that lookup started, independent of
quota `fetchedAt`. `source` describes the update cache, not the quota source.
`command` is fixed guidance; updates are never installed automatically.

| Update state | `clientUpdate` | Behavior |
| --- | --- | --- |
| Fresh stable `latest > current` | `status: available` object | Panel adds one update line. |
| Fresh stable `latest <= current` | Omitted | No notice. |
| Pending, offline, missing npm, or failed lookup | Omitted | Negative attempt is cached for 24 hours. |
| Missing, invalid, future-dated, or expired cache | Omitted | Schedule a bounded background refresh. |
| Cache or worker permission error | Omitted | Quota output, HTTP status and CLI exit code are preserved. |
| Opt-out | Omitted | No automatic cache access or worker launch. |

Absence means **no usable update notice**, not proof that the CLI is current;
unknown, offline and current are deliberately not distinct response statuses.
This matches the basic decision model of
[session-peer #67](https://github.com/abruption/session-peer/issues/67).
It refers only to the invoking installation, not `agy`, Node.js, or another host.
Only three safe integer numeric semver components are accepted, without leading
zeros, `v`, prerelease or build suffixes.

## Refresh and failure isolation

The update cache is `<XDG_CACHE_HOME|~/.cache>/agy-usage/update.json`, separate from
`quota.json`. Its maximum size is 4 KiB and its TTL is 24 hours, including failed
attempts. It stores only `schemaVersion`, `checkedAt` and `latest` (or `null`).
The quota cache strips `clientUpdate` on both read and write, so a quota cache
hit cannot pin an old notice. Quota refresh flags (`--no-cache`, `--refresh`,
`?refresh=1`) do not bypass the update TTL.

On a cold/expired cache, the response uses quota data immediately and a silent,
detached Node worker checks npm. The first response may omit the notice; later
calls/watch ticks/HTTP requests read the completed cache. The quota process
does not wait for npm or the registry, nor does worker shutdown delay CLI exit.
Watch/HTTP share a process-wide retry ceiling; a 30-second exclusive filesystem
lease and a persisted pending attempt suppress competing automatic workers.
The worker has a 20-second watchdog and reuses the updater's bounded 8-second
`npm view` check and 8-second public registry fallback. A crashed worker's lease
expires; the persisted attempt still prevents repeated checks until its TTL.

`agy-cli-usage update --check` performs an explicit fresh check, reports the
result and populates this same cache without installing. `update` also refreshes
before offering/installing a newer version. Explicit commands bypass the TTL
and automatic opt-out; they retain the existing offline failure exit code.
Cache-write failures do not change an explicit lookup/install result.

Use `--no-update-check` for one CLI invocation or `AGY_NO_UPDATE_CHECK=1` for CLI,
watch and HTTP deployments. Neither can cancel a worker launched previously.
Help/version and `/healthz` do not start checks. Do not combine
`--no-update-check` with the explicit `update` command.

Cache writes use an exclusive private temporary file followed by atomic rename.
POSIX directories/files use 0700/0600; Windows uses the user directory's inherited
ACL. Symlink/nonregular/foreign-owned caches are ignored. Npm credentials,
headers, tokens, account identifiers and quota data are never stored in the
update cache or its lease.
