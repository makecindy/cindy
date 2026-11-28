# Xfce / Plank desktop

Files that `../assemble-runtime.py` installs into the application layer.

- `cindy-linux-desktop`: PID 1 wrapper, started by `cindy-seccomp`. It requires
  unprivileged user namespaces, starts the session bus, the keyring (managed instances),
  Xvfb and `xfce-session`, then Cindy. On stop Cindy gets up to 45 s before its
  dependencies are stopped. The label `io.cindy.entrypoint-sha256` records its SHA-256.
- `xfce-session`: starts xfsettingsd, xfwm4, xfdesktop and Plank, and signals readiness
  once the window manager and Dock reserve their space. Plank is restarted at most three
  times a minute; any other exit ends the session.
- `apply-appearance.py`, `apply-dock.py`, `apply-dock-apps.py`: theme, wallpaper, Dock
  settings and pinned Terminal and Chrome. Each runs once per home (markers in
  `~/.config/cindy-desktop/`) and keeps unrelated settings. `~/.local/share` is not used.
- `cindy-dock-terminal` starts bash explicitly, because the account has no login shell.
  `cindy-dock-chrome` uses a personal Chrome profile with its sandbox and the keyring.
- `helpers.rc`, `cindy-cloud-chrome.helper.desktop`: links opened by Cindy use the same
  Chrome unless the user's own `helpers.rc` says otherwise.
- `seccomp.json`: the syscall allowlist. `cindy-seccomp` answers `clone3` and
  `faccessat2` with ENOSYS, so libc uses the allowed older calls. Do not replace the
  profile with Unconfined.
- [`plank/`](plank/README.md): `libplank` without the Preferences panel.

The desktop packages come from [the dependency base](../runtime-base/README.md).
