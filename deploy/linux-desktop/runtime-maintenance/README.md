# Maintenance gate overlay

Lets the control service stop admitting work on one instance (prepare), close it (seal),
and reopen it (cancel or release) around a backup or upgrade.

`overlay.mjs` routes every work ingress through the gate: agent input and dispatch,
scheduler, remote input including managed login recovery, and plugin work. At startup it
connects the gate to the desktop's explicit hooks: settings saves and management actions
the instance accepts from the cloud settings page (`instance-runtime/maintenance.ts`, as
remote input), the quit chain's outcome (`observeQuitSteps` in `lifecycle.ts`), and activity
sampling, which needs `runtime-activity`.
`expectedRegion` must match the main process `VITE_CINDY_AUTH_REGION`.

## Contract

The gate is active on Linux with `--cloud-instance` and these projected files. If the
ledger exists without them, startup fails.

| File | Content |
| --- | --- |
| `/run/cindy-maintenance/binding.json`, `command.json` | Instance binding and current command (or `null`) |
| `/run/cindy-maintenance-identity/pod-uid` | Pod UID |
| `/var/lib/cindy/status/maintenance.json` | Receipt, written every 2 s |
| `/var/lib/cindy/user-data/.cis-maintenance/ledger.json` | Durable state |
| `/var/lib/cindy/user-data/.cis-maintenance/shutdown.json` | Clean-shutdown evidence |

- Commands are bound to the instance, device, StatefulSet, PVC, Pod and boot, expire, and
  must follow the previous receipt. A corrupt ledger, or a missing one while a command is
  projected, keeps admission closed.
- Prepare rejects new requests with a retryable `CLOUD_MAINTENANCE_RETRY` and lets
  admitted work finish. Nothing is queued.
- Seal requires a fresh sample (15 s), nothing in flight, no active, queued or unknown
  work, and 10 s of quiet. A pending scheduled wake alone does not block it
  (`scheduleAdmission: "running-only"`); the scheduler keeps running during prepare.
- A sealed replacement boot keeps the due time of schedules that fell into the downtime.
  Each fires once after release; missed intervals are not replayed.
- Evidence is written only when a sealed instance quits through `before-quit` or SIGTERM
  and every quit step finished in time without error. Without it a stopped volume must
  not be backed up.

```sh
CINDY_ACTIVITY_TEST_SOURCE="$PWD" node --test deploy/linux-desktop/runtime-maintenance/*.test.mjs
```
