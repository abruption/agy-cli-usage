# Required-check migration

Completed on 2026-09-11 after #72 and #73 were merged. All four new gates passed on main `1fc26f58c42c8b0d253af7330f1ad24dd2ce7d23` ([CI run](https://github.com/abruption/agy-cli-usage/actions/runs/34553154089)) before branch protection changed.

Required checks are now:

- `supported-tests` (Node 22.13.0 minimum and Node 22/24 on Linux, macOS and Windows)
- `lint`
- `security-audit`
- `package-smoke` (packed installation on Linux and Windows)

Only required status checks were changed. Strict mode remains false; linear history, review policy and the other protection settings were preserved. The legacy Node 18/20/22 test job is removed; the supported compatibility matrix remains.

## Rollback

1. Restore the legacy `test` job from the parent of the removal PR through a new PR, while retaining the current required gates.
2. Verify its checks on main before restoring these former required contexts:
   - `test (node 18 on ubuntu-latest)`
   - `test (node 20 on ubuntu-latest)`
   - `test (node 22 on ubuntu-latest)`
   - `test (node 22 on macos-latest)`
   - `test (node 22 on windows-latest)`
3. Preserve other protection settings and strict mode false. Never require check names that no longer run or bypass protection to complete a rollback.

The supported engine remains Node >=22.13.0 even if legacy verification jobs are temporarily restored. Let release-please generate version and changelog updates.
