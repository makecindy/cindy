# Runtime programs

Installed into the application layer by `../assemble-runtime.py`.

| Source | Installed as | Purpose |
| --- | --- | --- |
| `seccomp-launch.py` | `/usr/local/bin/cindy-seccomp` | Image entrypoint: requires UID 10001 without effective capabilities, loads `/usr/local/lib/cindy/seccomp.json`, then execs its argument |
| `healthcheck.mjs` | `/usr/local/bin/cindy-cloud-healthcheck.mjs` | Health probe |
| `keyring-check.mjs` | `/usr/local/lib/cindy/` | Validates the mounted keyring secret before the PID 1 wrapper unlocks gnome-keyring |
| `chromium-compat` | `/usr/bin/chromium` | Passes its arguments unchanged to Google Chrome, the only browser in the image; the application starts its authorization browser at this path |

## Health check

Reads `CINDY_CLOUD_STATUS_FILE` and requires a status for `CINDY_POD_DEVICE_ID` with a
heartbeat at most 30 s old. Anything else fails.

- No argument (readiness): phase `ready` and `auth`, `database`, `binaries`, `maker` and
  `deviceLink` ready.
- `--startup`: also accepts phase `starting` with `binaries` and `maker` ready, auth
  recovery `login-required` or `pending`, and a live owner-only recovery socket. An
  instance waiting for its owner's login therefore keeps running without being ready.

```sh
node --test deploy/linux-desktop/runtime-support/*.test.mjs
```
