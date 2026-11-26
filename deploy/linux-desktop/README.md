# Linux cloud runtime image

This directory builds the image in which Cindy runs as a managed cloud instance: the
Linux application with cloud-only build overlays, an Xfce/Plank desktop, the agent CLIs
and the programs that start, check and stop it. An external control service (`CIS` in
code identifiers) creates instances, supplies their identity and secrets, and runs
backups and upgrades. That service is not part of this repository. Ordinary desktop
builds use nothing in this directory, and no CI here builds or publishes the image.

The recipe builds the CN region (`VITE_CINDY_AUTH_REGION=cn`) for `linux/amd64` only.

## Build

Host tools: Git with Git LFS and the history of this directory, Python >= 3.12, Docker
with Buildx. Packaging uses a 12 GiB Node heap. Build images for use on native amd64;
an emulated build only checks the recipe.

```sh
python3 deploy/linux-desktop/build-image.py --version X.Y.Z [--cloud-revision N] \
  --tag cindy-runtime:<unique-tag> --output /absolute/private/<new-dir>
```

- `--version`, `--cloud-revision` (default 1): the application version becomes
  `X.Y.Z-cloud.N`.
- `--revision` (default `HEAD`): the Git revision of both recipe and application.
  Uncommitted changes in this directory are rejected; worktree files are never used.
- `--tag` must not exist locally and must not be a bare `X.Y.Z`; the output directory
  must not exist.
- `--prepare-only`: export the build context without starting Docker.
- `--builder NAME`: use an existing native amd64 Buildx builder. With
  `--cache-repository REGISTRY/REPO` it also imports and exports build cache; use a
  private repository with mutable tags. `--no-cache` ignores existing cache.
- `--source-arg NAME=URL`: fetch a pinned download from an https mirror.
  `DEBIAN_SNAPSHOT_URL`, `CHROME_DEB_URL` and `GH_TARBALL_URL` apply to the base,
  `DEBIAN_BUILD_MIRROR`, `PLANK_SOURCE_URL` and `PLANK_DEBIAN_SOURCE_URL` to the
  application build. Checksums, signatures and versions still apply.

The script exports the revision with `git archive`, verifies every Git LFS object,
builds the [dependency base](runtime-base/README.md), installs pnpm dependencies and
pinned assets, rebuilds `libplank`, primes the native-module cache, applies the
overlays, packages with Forge, runs the packaged native modules with networking off,
assembles and audits the application layer, and checks the image config with
`release_guard.py`. It never pushes the image. The output directory holds the inputs,
Docker logs, image configs, `records/` and `result.json`.

## Image layout

Two layers: the dependency base and one application layer (`/opt/cindy`, Cindy-owned
programs and desktop files). Never build on an earlier application image: replaced files
would still occupy its layers. `io.cindy.*` labels record commit, versions and region.

## Files

| Path | Purpose |
| --- | --- |
| `build-image.py`, `release_guard.py` | Build driver; checks on the built image config |
| `Dockerfile`, [`runtime-base/`](runtime-base/README.md), [`runtime-fonts/`](runtime-fonts/README.md) | Application and runtime stages; pinned dependency base; emoji font |
| `download-build-assets.mjs`, `prepare-*.mjs`, `prepare-linux.sh` | Verified build assets; Linux builder preparation |
| `prime-native-cache.cjs`, `verify-native-modules.cjs` | Prebuild native modules; run the packaged ones |
| `stage-cloud-overlays.mjs`, `build-version.mjs`, `build-runtime.sh` | Apply overlays and version to the exported source, then package |
| `stage-runtime-agents.py` | Bundle the pinned Claude and Codex CLIs |
| `assemble-runtime.py`, `normalize-timestamps.py`, `audit-runtime-layer.py` | Assemble the application layer, clamp timestamps, audit permissions and links |
| `github-device-login.py` | GitHub device login, used by the application |
| [`runtime-activity/`](runtime-activity/README.md), [`runtime-maintenance/`](runtime-maintenance/README.md), [`runtime-guidance/`](runtime-guidance/README.md) | Overlays: live task activity; maintenance gate; settings guidance for agents |
| [`runtime-updates/`](runtime-updates/README.md), [`runtime-window-controls/`](runtime-window-controls/README.md), [`runtime-identity/`](runtime-identity/README.md) | Overlays: no desktop updater; main window stays open; no sign-out |
| [`runtime-support/`](runtime-support/README.md) | Seccomp launcher, health check, keyring check |
| [`runtime-desktop-xfce/`](runtime-desktop-xfce/README.md) | PID 1 wrapper, Xfce/Plank desktop, seccomp profile |

Overlays match exact source anchors and fail the build when the source changes.

## Runtime contract

Run as UID 10001 without capabilities, with unprivileged user namespaces available (the
Chromium sandbox needs them) and a stop grace period of at least 60 s. Persist
`/home/cindy` and `/var/lib/cindy`. Setting any of the first three variables selects a
managed instance: the wrapper unlocks the keyring and starts Cindy with
`--cloud-instance`, which then requires the whole configuration.

| Variable | Value |
| --- | --- |
| `CINDY_POD_DEVICE_ID` | `cloud-device-<24 hex digits>` |
| `CINDY_POD_MEMBERSHIP_ID` | Owner membership |
| `CINDY_POD_KEYRING_PASSWORD_FILE` | `/run/secrets/credential-store-key`: 43 base64url characters, owned by root or 10001, not group-writable, no access for others |
| `CINDY_POD_DEVICE_NAME` | Display name |
| `CINDY_POD_AUTH_PROTOCOL` | `instance-v1` (default) or `resource-v1` |
| `CINDY_POD_CREDENTIAL_SOURCE` | `bootstrap` (default), or `canonical` to use only the stored session (`resource-v1`) |
| `CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE` | `/run/secrets/resource-refresh-token`; unset for `canonical` |
| `XDT_USER_DATA_DIR` | `/var/lib/cindy/user-data` |
| `XDT_ENDPOINT_MANIFEST_FILE` | `/run/config/endpoint.json` |
| `CINDY_CLOUD_STATUS_FILE` | `/var/lib/cindy/status/status.json` |

- **Status file**: rewritten atomically every 5 s with phase, heartbeat, readiness of
  `auth`, `database`, `binaries`, `maker` and `deviceLink`, and live task activity.
- **Health check**: `cindy-cloud-healthcheck.mjs` for readiness, with `--startup` for
  startup; see [`runtime-support/`](runtime-support/README.md#health-check).
- **Login recovery** (`resource-v1`): `POST /v1/recover` on the owner-only socket
  `/tmp/cindy-auth-recovery/control.sock`.
- **Maintenance gate**: enabled by the `/run/cindy-maintenance` projection; see
  [`runtime-maintenance/`](runtime-maintenance/README.md).
- **Stop**: SIGTERM lets Cindy finish its quit chain for up to 45 s while its display,
  session bus and keyring stay alive. The container exits when Cindy or a desktop
  dependency exits.

## Local checks

From the repository root with dependencies installed; nothing is built or published.

```sh
CINDY_TEST_CLIENT_SOURCE="$PWD" CINDY_ACTIVITY_TEST_SOURCE="$PWD" \
  CLOUD_UPDATE_TEST_SOURCE="$PWD" CLOUD_WINDOW_TEST_SOURCE="$PWD" \
  node --test deploy/linux-desktop/*.test.mjs deploy/linux-desktop/*/*.test.mjs
export PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s deploy/linux-desktop -p 'test_*.py'
python3 -m unittest discover -s deploy/linux-desktop/runtime-base -p 'test_*.py'
python3 deploy/linux-desktop/runtime-fonts/test_stage_emoji_font.py
```

When the application changes its Electron or ripgrep version, update the versions and
checksums in `Dockerfile`, `download-build-assets.mjs`, `prepare-linux.sh`,
`prepare-other-assets.mjs` and `verify-native-modules.cjs`. Agent CLI pins are read
from the application.
