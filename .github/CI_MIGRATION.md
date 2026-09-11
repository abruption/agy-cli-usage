# Required-check migration

The Node 22 support PR adds `supported-tests` while retaining the existing
`test` jobs. Do not remove required check names before branch protection is
updated: GitHub would wait forever for checks that no longer run.

1. Merge the Node 22 support PR (linked to #61) and CI hardening PR (linked to #62), after their
   existing required checks pass. Keep the legacy test jobs during this stage.
2. Confirm `supported-tests`, `lint`, `security-audit`, and `package-smoke`
   all succeed on the resulting **main** commit, not just on a PR merge ref.
3. Save the existing setting:

   ```sh
   gh api repos/abruption/agy-cli-usage/branches/main/protection/required_status_checks > /tmp/agy-required-checks-before.json
   ```

4. Update only `required_status_checks` to `strict: false` with contexts
   `supported-tests`, `lint`, `security-audit`, and `package-smoke`. Preserve
   the other branch-protection settings (linear history, PR requirement,
   force-push/deletion restrictions). Prefer the repository Settings UI.
5. In a follow-up PR linked to #61, remove the legacy `test` job. Keep the
   `compatibility` matrix and `supported-tests` aggregate. Verify that new PRs
   have all four required checks and no permanently pending legacy contexts.

The baseline required contexts are:

- `test (node 18 on ubuntu-latest)`
- `test (node 20 on ubuntu-latest)`
- `test (node 22 on ubuntu-latest)`
- `test (node 22 on macos-latest)`
- `test (node 22 on windows-latest)`

Rollback before removing legacy jobs: restore these contexts and `strict:
false`, or use the saved values if settings changed after this document was
written. After legacy jobs are removed, first restore their workflow through
a PR, then restore the old required contexts. Never bypass protection to
complete this migration.

Changing the minimum engine version is a breaking change. Let release-please
generate the release PR; do not edit version numbers or CHANGELOG manually.
