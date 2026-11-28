# Main-window controls overlay

Keeps the Cindy main window open on cloud instances: the close button is hidden, and
close IPC and window-manager close events are blocked. Minimize, maximize, restore from
the Dock and orderly shutdown still work; other windows are unaffected.

The main process decides by instance configuration. The main window also receives
`--cindy-cloud-main-window`, from which the preload derives a presentation-only flag;
`runtime-updates` and `runtime-identity` reuse it.

```sh
CLOUD_WINDOW_TEST_SOURCE="$PWD" node --test deploy/linux-desktop/runtime-window-controls/*.test.mjs
```

Without the variable only the policy tests run.
