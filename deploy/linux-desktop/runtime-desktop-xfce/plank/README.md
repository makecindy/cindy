# Plank without Preferences

The image hides Plank's Preferences menu item and disables its shared `preferences`
action, so Ctrl+right-click, `plank --preferences` and D-Bus activation cannot open the
panel. The CLI option stays accepted as a no-op. Application menus, clock options and
minimize/restore are unchanged. This is a UI policy: users can still edit the
configuration files.

`build.sh` builds only `libplank.so.1.0.0` from Plank 0.11.89 and Debian revision 4, both
checksum-pinned: Debian's patch series first, then `hide-preferences.patch`. Every exported
ABI symbol of the stock library must remain, so the stock executable and docklets keep
working. Build dependencies are pinned in `build-deps.txt` and never enter the runtime.

Plank is GPL-3.0-or-later. The corresponding source archives, patch and build files are
installed in `/usr/share/doc/cindy-plank/source/`. To rebuild with the build dependencies
and the stock Debian libplank installed:

```sh
bash build.sh /path/to/source-archives /path/to/new-output
```
