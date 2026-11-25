# Managed updates overlay

The control service upgrades cloud instances, so the desktop updater is inactive there:
no startup or background checks, staged patches, installer, relaunch, update-channel
change or beta enrolment. The release-notes dialog, the auto-update preference and its
settings-search entry are hidden. Release history and agent or plugin updates still work.

The main process decides by instance configuration on Linux. The renderer flag follows
the main-window argument from `runtime-window-controls`, so both overlays are required.

```sh
CLOUD_UPDATE_TEST_SOURCE="$PWD" node --test deploy/linux-desktop/runtime-updates/*.test.mjs
```
