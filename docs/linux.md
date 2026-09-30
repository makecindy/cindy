# Linux installation and updates

## Supported installation routes

| Environment | Installation | How updates are applied |
| --- | --- | --- |
| Ubuntu 22.04 / 24.04 | Official system `.deb` via apt | In-app download, explicit restart, polkit authorization |
| Arch Linux / Omarchy (Hyprland), x86_64 | One-command managed user installation below | In-app download, explicit restart, atomic user-owned version switch |
| Other glibc Linux desktops | Same user installer, with compatible runtime dependencies | Same transaction; not a claim that every distribution is tested |
| pacman/AUR or another third-party package | That package manager | Use that package manager, not the in-app installer |

The user installer supports x64 and arm64 payload identities, but requires a
matching published artifact. Arm64 does not currently support the Beta channel;
this change's host checks use x64 Omarchy; release acceptance is listed below.
Alpine/musl, root desktop sessions,
and unpacking old releases by hand are not supported user-install routes.
This does not add Linux equivalents of features that require macOS or Windows.

The downloaded artifact remains the official `.deb`. On Arch it is a verified
container for the application, **not a Debian package installed into the
system**. No apt/dpkg, maintainer scripts, root privileges, ASAR patches, or
system Electron are used. Old releases without `resources/linux-build-info`
cannot bootstrap this layout: start with a release containing this support.

## Arch / Omarchy prerequisites

Keep the distribution fully updated (Arch does not support partial upgrades).
Install the runtime libraries and integration tools if absent:

```sh
sudo pacman -Syu --needed curl jq libarchive coreutils util-linux findutils procps-ng \
  gtk3 nss alsa-lib libxss libxtst libnotify libdrm mesa \
  gnome-keyring libsecret desktop-file-utils xdg-utils
```

Cindy bundles its own Electron; installing Arch's `electron` package is not
required. Run from a normal logged-in desktop session with a working session
D-Bus and an unlocked Secret Service keyring. Installing `gnome-keyring` does
not itself unlock it: use your desktop's supported login/PAM integration.
Do not start a second keyring daemon or replace its existing keys.
The distribution must allow Electron's user-namespace sandbox; the installer
does not create a root-owned setuid helper or disable sandboxing.

For Wayland screen sharing and file dialogs, keep your compositor's portal
backend and PipeWire installed and working. Omarchy normally configures these;
this installer deliberately does not rewrite Hyprland, PAM or portal settings.
See the [Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage)
for the backend model. KDE and GNOME retain Electron's existing selection;
Hyprland selects `gnome-libsecret` before app readiness; other desktops retain
Electron's selection. Desktop identity uses the first non-empty value from
`XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP`, and `DESKTOP_SESSION`.
An explicit `--password-store` always wins and survives an in-app update restart.

## Install on Arch / Omarchy

After the website operator publishes the bootstrap at the addresses below, quit
Cindy fully and run the command shown on your download page as your desktop user,
**without sudo**. The command downloads the latest stable `.deb` automatically;
you do not need to download a package or a second script yourself.

For [cindy.app](https://cindy.app/download/):

```sh
curl -fsSL https://hotfix.cindy.app/cindy/install-omarchy.sh | bash
```

For the Mainland China download page:

```sh
curl -fsSL https://hotfix.cindy.com.cn/cindy/install-omarchy.sh | bash -s -- --region cn
```

Both websites serve the **same** [bootstrap source](../apps/desktop/resources/linux/install-omarchy.sh).
The download page supplies its build's region; the script does not infer it from
IP address or locale. No region argument means `global`. Despite its name,
`install-omarchy.sh` also supports ordinary Arch. Ubuntu, Debian and Mint exit
before downloading or changing anything: keep using the website's `.deb` with
apt. pacman/AUR-owned Cindy installations must use their package manager.

The bootstrap reads `manifest-linux-x64.json` or `manifest-linux-arm64.json` from
the selected region's existing CDN on **every invocation**. It pins the version,
file, size and SHA-256 from that one response for the entire installation, checks
the downloaded bytes, then checks the packaged build identity. It executes
`install-user.sh` and `register-desktop.sh` taken from that verified `.deb`, never
from Git HEAD. A newer release appearing during a download is picked up on the
next run or by Cindy's normal in-app update. Beta/canary channels are not used.

The menu entry and `cindy://` login links are registered automatically. Cindy is
not launched automatically; open it from the menu or use the printed launcher.
Missing dependencies produce a `pacman` command for you to run; the bootstrap
does not install system packages or run sudo itself. A working, unlocked keyring
and desktop session remain prerequisites.

Repeating the command upgrades the managed installation or repairs its launcher
and desktop registration if that exact package is already active. It rejects
a release older than the installed stable version. Keep Cindy closed until the
command finishes. Only one bootstrap per prefix can run at a time; a concurrent
command exits with a busy message and can be retried after the first finishes.
The persistent sibling `PREFIX.bootstrap.lock` serializes the bootstrap from
manifest lookup through desktop registration; it does not replace the app
updater's separate installation lock. Do not delete it while a command is running.
The default prefix is
`$HOME/.local/opt/cindy` (`cindy-cn` for a new Mainland China install); existing
v1 Mainland China installs at `cindy` are reused when their marker matches. An
unmarked directory, symlink or another region's installation is preserved: the
bootstrap chooses a free `-managed` neighbor and reuses it on subsequent runs.
A malformed installation marker is reported for repair, not overwritten.

For a custom prefix, append `--prefix /absolute/path` using `bash -s --`, and
supply the same prefix on later runs. An explicitly supplied occupied, unmarked
prefix is rejected. Existing accounts and data stay in their original
region-specific userData directory; see the migration notes below.

### Manual / offline installation

For other compatible glibc distributions, or to review and run the installer
offline, the existing manual route remains available:

1. Download the matching official Linux package from
   [Cindy downloads](https://cindy.app/download/). Obtain its **trusted SHA-256**
   from the release's metadata/update manifest; computing a new digest from an
   untrusted download is not verification.
2. Get [install-user.sh](../apps/desktop/resources/linux/install-user.sh) from the
   source revision associated with that release. Review it, then run it as your
   desktop user, **not with sudo**:

```sh
bash ./install-user.sh --install ./cindy-VERSION-amd64.deb TRUSTED_SHA256
bash "$HOME/.local/opt/cindy/current/resources/linux/register-desktop.sh" "$HOME/.local/opt/cindy"
"$HOME/.local/opt/cindy/launch"
```

Replace the package name and digest. An optional fourth argument to
`--install` chooses another absolute prefix inside your home. The installer
refuses to overwrite an unmarked existing directory. Desktop integration needs
a prefix without control characters, `=` or `%` (Desktop Entry restrictions).
It creates a prefix-specific menu entry and **explicitly makes this installation
the handler for Cindy login/share links**; other application files are untouched.
Both release regions share these schemes, so the last registered handler wins.
Concurrent use of two release regions is not supported.
The packaged app sets the same stable reverse-DNS desktop identity before
startup, including when reopened by the updater. Portal permissions may need
to be granted again when migrating from an older manual desktop entry.

The command-line entry is `PREFIX/launch`. If desired, create a `cindy` symlink
to that entry in a directory already on PATH, but do not replace an existing
command belonging to a different installation.

## Updates, existing installations, and recovery

Choose Update in Cindy, then restart when convenient. Linux never installs
while idle. Managed user installs need no system password. System `.deb`
installs still request authorization. Unknown/package-manager-owned layouts
are rejected **before Cindy quits or stops active work** with a guide prompt.
The downloaded package remains available.

Each update verifies the manifest size and SHA-256 again using a private
snapshot, checks the package's version/architecture/region, then prepares a new
release directory. A single rename switches `current`; `previous` and all old
release directories are retained. A handled failure before activation leaves
the current executable intact and removes that transaction's new directory.
SIGKILL or power loss can leave an unactivated release behind; retry verifies
the package again and installs into a fresh directory without overwriting or
deleting the retained release. Repeating an already active package repairs the
stable launcher without switching releases. The two pointer renames are not a
power-loss-atomic pair: interruption after switching `current` can leave
`previous` pointing to an older retained release rather than its immediate predecessor.
Application data, credentials, plugins and keyring entries are never copied,
cleared, re-encrypted or moved by the installer.

For a previously hand-extracted or locally patched installation:

1. Quit Cindy fully and back up its existing data using your normal backup
   procedure. Do not delete the old installation, profile, keyring or launchers.
2. Install a compatible official release into a **new** prefix, for example
   `$HOME/.local/opt/cindy-managed`.
3. Explicitly register the new desktop entry before signing in, so the browser
   callback returns to the new installation instead of starting the old one.
   Run the new stable launcher with the same existing password-store selector
   if you previously specified one. The application's existing region-specific
   userData mapping is unchanged (`CindyGlobal` / `Cindy`).
4. Verify login and reopening. Only after verification remove obsolete
   launchers/manual patches yourself.
   Do not run both versions against the same profile simultaneously.

This cannot recover already revoked tokens or decrypt a profile with a missing
keyring. If an old install used a different backend (including `basic`), do not
delete its keys: restoring that backend or signing in once may be necessary.
There is no automatic insecure/plaintext fallback. A locked keyring must be
unlocked, not bypassed with sandbox-disabling flags or permissive chmod.

For failures, inspect the application's `logs/cindy-update.log`, the current
release's `resources/linux-build-info`, and `readlink PREFIX/current`.
`ldd PREFIX/current/Cindy` can identify missing runtime libraries in a trusted
official package. Do not post tokens or complete private profiles in issues.

Binary rollback is not a database rollback: old releases are retained for
recovery, but running an older app after migrations may be unsafe. Prefer a
fixed forward release, or restore a matching data backup with maintainer help.
Do not automatically launch `previous` after a successfully activated app has
already opened its database.

To uninstall, quit Cindy and remove only the chosen managed prefix and its
prefix-specific `com.xd.cindy.user.h*.desktop` entry (the registration command prints
the exact filename). Remove any CLI symlink you added and re-register another
installation if required. User data and the keyring live outside the prefix
and are retained. Old release directories are not automatically pruned; review
their disk usage and retain a suitable backup before cleaning them.

## Maintenance and validation

- Forge writes build identity outside ASAR and bundles the Linux resources
  directory. The bootstrap is served separately for first installation; its
  incidental packaged copy is not called by the app or updater.
  The in-app update helper embeds the same installer source at build time;
  it does not execute a mutable script from the installation directory.
- Keep `install-user.sh`, the marker schema, `linuxInstallation.ts`, and
  `forge-linux.ts` compatible across releases. Do not change server manifest
  fields or the existing system-package route to add a distribution.
- Native smoke tests create small synthetic DEBs in a temporary HOME. They
  cover two updates, bad digest/version/region, escaping symlinks, failure at
  activation, retry, stable desktop registration, and exact package ownership.
  They run on Linux with libarchive/binutils/desktop-file-utils/xdg-utils; all
  other platform-selection and UI tests also run on Windows.
- The bootstrap's standalone native smoke uses the real two helper scripts
  and small synthetic DEBs, with fake HTTP, distro identity and desktop MIME
  writes. It covers region routing, two upgrades, repeated installation, legacy
  paths, rejected distro/package ownership, bad metadata/digest/build identity,
  older releases, concurrent installation/retry and truncated piped input. Run as a non-root Linux user with
  the integration tools above, Node.js, `binutils` and ShellCheck installed:

  ```sh
  node --test apps/desktop/scripts/__tests__/install-omarchy.smoke.mjs
  bash -n apps/desktop/resources/linux/install-omarchy.sh
  shellcheck apps/desktop/resources/linux/install-omarchy.sh
  ```

  This standalone smoke is not part of `pnpm test:unit`; run it when changing
  the bootstrap. It does not launch Electron or validate a live keyring.
- Before broad rollout, test two **real release** upgrades on both a fresh and
  migrated Omarchy profile, cold-start login retention, locked-keyring recovery,
  deep links, notifications, file dialogs and Wayland screen sharing. Repeat
  Debian system updates and native GNOME/KDE login checks. Synthetic packages
  are not a substitute for these release acceptance checks.

## Website / OSS publication

1. Upload `apps/desktop/resources/linux/install-omarchy.sh`, with LF line endings
   and no HTML wrapper, to `install-omarchy.sh` under **each** CDN's `/cindy`
   directory. It must be publicly readable over HTTPS without authentication.
   A private bucket is fine when the CDN provides public access. Serve it as
   plain text with revalidation or a short cache lifetime. Uploading this entry
   point does not require rebuilding the app; its prerequisite is a published
   Linux package containing the v1 build identity and both helpers. If the
   current release predates that support, publish a new Linux release first.
2. Continue publishing each region's own official `.deb` and the existing
   `manifest-linux-<arch>.json`. Its `app.version` and `app.installer` fields
   (`file`, `sha256`, `size`) are the bootstrap's source of truth. `file` is a
   relative path under the same regional CDN, as it is for in-app updates. Do
   not put the other region's bytes under that path. No second latest-version
   JSON or independently uploaded helper scripts are needed.
3. Publish the immutable, versioned `.deb` first; check its public availability
   and digest, then replace the corresponding stable manifest last. Invalidate
   the manifest's CDN cache / require revalidation. A failed fetch or checksum
   mismatch stops the bootstrap without activating a new installation. Keep
   the preceding version's asset available for downloads already in flight.
4. Keep Ubuntu / Debian's existing `.deb` button. For Arch / Omarchy, show the
   matching one-line command above instead of two download buttons. Optionally
   expose a website `/install-omarchy` redirect to its region's CDN script; the
   Mainland China command must still pass `--region cn`.
5. Subsequent app releases only need the usual `.deb` + manifest publication.
   Re-upload the bootstrap when the bootstrap itself changes. The installed
   app continues using the existing in-app update service and manifest format.

The URLs above are publication targets, not a claim that the script is already
online. Validate both commands on Arch / Omarchy after upload, including an
existing installation. Publishing or changing website/OSS content is separate
from checking this source into the client repository.
