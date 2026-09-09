# 01: Establish trusted local Harness runtime profiles

**What to build:** Cindy can save, resolve, and validate a per-owner local
Harness runtime profile before launching a Tencent runtime distribution. The
profile supports native executables and Node-wrapper launch plans, preserves
the current Cindy-managed default when no override exists, and lets the user
restore that default without retaining an obsolete override. Renderer code
cannot choose an arbitrary executable for a task send.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] A runtime profile records a trusted executable identity, launch plan,
      ownership boundary, and non-secret probe facts without persisting
      credentials.
- [x] Saving or launching a profile validates absolute paths, canonical target,
      executability, wrapper identity, and version output.
- [x] A Node shebang wrapper can be launched through an explicit Node
      executable without relying on the GUI process PATH.
- [x] A changed executable identity invalidates its cached capability profile
      and requires a fresh probe before high-risk capabilities are enabled.
- [x] Per-owner defaults and restore-default behavior are externally verified.
- [x] Renderer-originated payloads cannot select a runtime executable outside
      the saved, Main-validated profile.

## Answer

Implemented the Main-owned runtime-profile foundation in
`apps/desktop/src/main/harness-runtime/`.

- Owner-scoped settings persist only explicit Tencent overrides; reset removes
  the override and returns to the Cindy-managed default.
- Profiles record canonical launcher/wrapper identities, non-secret versions,
  ownership (`cindy` vs `harness`) and config-home policy.
- `tclaude` is validated as a native executable; `tcodex` requires an
  explicit absolute Node launcher and one absolute wrapper entry script.
- Approval and launch resolution use canonical paths, `execFile` with fixed
  argv, executable/file checks and wrapper/upstream version checks.
- A Main-only resolver takes only agent kind at send time, so no
  Renderer-originated executable or argv is accepted.
- Identity drift clears cached capabilities before the Tencent launch plan is
  returned.

Verification:

- `pnpm --filter desktop exec vitest run src/main/harness-runtime/__tests__/runtimeProfile.test.ts --project standard --no-file-parallelism --maxWorkers 1`
  — passed (12 tests).
- `pnpm --filter desktop run --if-present typecheck` — passed.
- Prettier, ESLint and `git diff --check` — passed.
- `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pnpm test:unit:related`
  — passed (`test:runner` + related `apps/desktop` unit suite).
  The temporary Git environment is test-only: it prevents the host-global
  `core.hooksPath` from changing DCO fixture behavior. The apparent lock-port
  conflict was the sandbox denying loopback `listen()` with `EPERM`, not a
  listener occupying Cindy's candidate ports; the gate passed once run outside
  that sandbox.
