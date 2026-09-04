# Linux installation and updates

## Supported installation routes

| Environment | Installation | How updates are applied |
| --- | --- | --- |
| Ubuntu 22.04 / 24.04 | Official system `.deb` via apt | In-app download, explicit restart, polkit authorization |
| Arch Linux / Omarchy (Hyprland), x86_64 | Managed user installation below | In-app download, explicit restart, atomic user-owned version switch |
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
sudo pacman -Syu --needed libarchive coreutils util-linux findutils procps-ng \
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
standalone Hyprland, Sway and Niri select `gnome-libsecret` before app readiness.
An explicit `--password-store` always wins and survives an in-app update restart.

## Install

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
release directories are retained. Failure before activation leaves the current
executable intact, removes that transaction's new directory, and allows retry.
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

- Forge writes build identity outside ASAR and bundles both Linux scripts.
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
- Before broad rollout, test two **real release** upgrades on both a fresh and
  migrated Omarchy profile, cold-start login retention, locked-keyring recovery,
  deep links, notifications, file dialogs and Wayland screen sharing. Repeat
  Debian system updates and native GNOME/KDE login checks. Synthetic packages
  are not a substitute for these release acceptance checks.
