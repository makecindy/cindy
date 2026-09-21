# Local macOS rebuild and install

Use the repository's [environment setup](docs/dev-rules/environment-setup.md)
first: supported Node, pinned pnpm, Xcode and Git LFS assets. Do not upgrade
agent-runtime pins to work around a local packaging failure.

## Apple Silicon helper

From the repository root, deliberately run:

```sh
node scripts/rebuild-installed-cindy.mjs
```

This requests that a running Cindy quit, waits up to 15 seconds, builds a
versionless global ARM64 app, and verifies its ad-hoc signature before replacing
`/Applications/Cindy.app`. It never edits the user's profile, credentials or
Creator Micro settings. Do not run it while an active Cindy task must remain open.

The SDK comes from `xcrun --sdk macosx --show-sdk-path`. If Xcode and the Command
Line Tools disagree, choose the intended Xcode with `DEVELOPER_DIR` in your build
environment; do not hard-code an SDK version from someone else's machine.

Installation stages and verifies a copy on the Applications filesystem, then
uses renames. The previous app is retained in the printed
`/Applications/.cindy-install-.../Cindy-previous.app` location. An installation
rename failure attempts to restore the previous app. Backups are not deleted
automatically. Inspect the printed paths before manually restoring or cleaning up.

The command needs write access to `/Applications`; it does not run sudo or
request elevated access automatically. An inability to stage/verify leaves the
installed app in place. A reopen detected after building stops installation.
This is not a filesystem transaction against other installers; do not run two
installers simultaneously or reopen Cindy during replacement.

The app stays closed after installation. Opt in to launching it with
`CINDY_LAUNCH_AFTER_INSTALL=1`. A closed app can still require a fresh macOS
Input Monitoring approval when its signing identity changes; the script cannot
grant that permission or guarantee hardware acceptance.

## Local package versus release

The helper explicitly uses `--no-sign`, `--skip-smoke`, and the local-only
simulator-gate exception. It therefore does **not** establish packaged runtime,
simulator, visual or hardware acceptance. Ad-hoc signing is not Developer ID
signing/notarization for distribution to another Mac.

`CINDY_SKIP_IOS_SIMULATOR_RELEASE_GATE=1` is honored only for versionless,
explicitly `--no-sign` builds without a required native simulator gate. Versioned
or signed release packaging retains its normal gate, and an explicitly required
native gate cannot be bypassed. Mach-O architecture and code-signature checks
remain in place for the local exception.

For release validation, use the normal packaging workflow without these local
shortcuts. This helper neither publishes a release nor enables auto-updates for
its versionless output. It currently rejects Intel Macs; use the regular packager
with the correct architecture there.

## LFS troubleshooting

Ensure native assets are actual binaries, not Git LFS pointer files. Use
`git lfs pull` for the selected repository. If your fork has no upstream assets,
use a **per-command** upstream `lfs.url` override for fetching; do not persist an
upstream upload endpoint into your fork's Git configuration, as that breaks
branch pushes and lock verification.
