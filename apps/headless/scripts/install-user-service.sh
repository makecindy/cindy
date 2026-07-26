#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${CINDY_HEADLESS_PREFIX:-"$HOME/.local/lib/cindy-headless"}
user_bin=${CINDY_HEADLESS_BIN_DIR:-"$HOME/.local/bin"}
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
runtime_dropin_dir="$unit_dir/cindy-headless.service.d"
runtime_path_file="$runtime_dropin_dir/runtime-path.conf"

test -f "$root/release-target.env" || { echo 'This Cindy release is incomplete: release-target.env is missing.' >&2; exit 1; }
release_arch=$(sed -n 's/^arch=//p' "$root/release-target.env" | head -n 1)
case "$(uname -m)" in
  x86_64|amd64) host_arch=x64 ;;
  aarch64|arm64) host_arch=arm64 ;;
  *) host_arch=$(uname -m) ;;
esac
test -n "$release_arch" || { echo 'This Cindy release has no architecture metadata.' >&2; exit 1; }
test "$host_arch" = "$release_arch" || {
  echo "This Cindy release targets $release_arch, but this server is $host_arch. Download the matching Linux release." >&2
  exit 1
}
test -x "$root/runtime/node" || { echo 'This Cindy release is incomplete: bundled runtime/node is missing.' >&2; exit 1; }
test -f "$root/node_modules/better-sqlite3/build/Release/better_sqlite3.node" || {
  echo 'This Cindy release is incomplete: bundled native SQLite module is missing.' >&2
  exit 1
}
mkdir -p "$prefix" "$user_bin" "$unit_dir"
# `cp -R source/bin destination/` nests source as `destination/bin/bin` when
# an older release already has that directory.  Replace only the executable
# bundle on upgrade; configuration, session history and account state live in
# XDG config/state paths and are deliberately untouched.
rm -rf -- "$prefix/bin" "$prefix/lib" "$prefix/runtime" "$prefix/node_modules"
cp -R "$root/bin" "$root/lib" "$root/runtime" "$root/node_modules" "$root/package.json" "$root/README.txt" "$root/release-target.env" "$prefix/"
# Keep the release self-contained under $prefix while exposing the normal
# user-facing commands in ~/.local/bin, which is already on most Linux PATHs.
# Never replace a real user file with an installer-managed symlink.
for command in cindy cindyctl cindy-headless; do
  link="$user_bin/$command"
  target="$prefix/bin/$command"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "Not replacing existing $link; use $target instead." >&2
  else
    ln -sfn "$target" "$link"
  fi
done
sed "s|@PREFIX@|$prefix|g" "$root/systemd/cindy-headless.service" > "$unit_dir/cindy-headless.service"
# systemd --user does not inherit the interactive shell's PATH.  Preserve it
# in a private unit drop-in so runtimes installed with npm/nvm (codex/claude)
# remain discoverable after service startup and upgrades.
mkdir -p "$runtime_dropin_dir"
printf '[Service]\nEnvironment="PATH=%s"\n' "$PATH" > "$runtime_path_file"
chmod 600 "$runtime_path_file"
systemctl --user daemon-reload
systemctl --user enable cindy-headless.service
# `enable --now` does not replace an already active process.  An upgrade must
# restart it, otherwise a newly installed CLI can talk to yesterday's daemon.
systemctl --user restart cindy-headless.service
echo "Installed cindy-headless. Commands available in $user_bin."
