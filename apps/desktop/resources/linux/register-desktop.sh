#!/usr/bin/env bash
# Explicit opt-in desktop integration, separate from the update transaction.
set -euo pipefail
umask 077
fail() { printf 'Cindy: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $EUID -ne 0 && $# -eq 1 ]] || fail 'Run as your desktop user: register-desktop.sh PREFIX'
for tool in realpath sha256sum desktop-file-validate update-desktop-database xdg-mime flock; do
  command -v "$tool" >/dev/null || fail "Missing dependency: $tool"
done
prefix=$(realpath -e -- "$1")
user_home=$(realpath -e -- "$HOME")
[[ $prefix == "$user_home/"* && $prefix != *[$'\n\r\t=%']* ]] || fail 'PREFIX must be inside HOME with no control characters, = or %.'
marker="$prefix/.cindy-user-install"
[[ -d $prefix && -O $prefix && -f $marker && ! -L $marker && -O $marker && -x $prefix/launch ]] || fail 'Not a managed installation.'
case "$(< "$marker")" in
  cindy-user-install-v1:global|cindy-user-install-v1:cn) ;;
  *) fail 'Not a release installation.' ;;
esac
exec 9> "$prefix/.install.lock"
flock -n 9 || fail 'Another installation is in progress.'
data_dir=$(realpath -m -- "${XDG_DATA_HOME:-$HOME/.local/share}")
[[ $data_dir == "$user_home/"* && $data_dir != *[$'\n\r\t']* ]] || fail 'XDG_DATA_HOME must be inside HOME.'
apps_dir="$data_dir/applications"
mkdir -p -- "$apps_dir"
id=$(printf '%s' "$prefix" | sha256sum)
app_id="com.xd.cindy.user.h${id:0:16}"
id="$app_id.desktop"
dest="$apps_dir/$id"
[[ ! -e $dest && ! -L $dest || -f $dest && ! -L $dest && -O $dest ]] || fail 'Desktop entry is not user-owned.'
temp=$(mktemp --suffix=.desktop "$apps_dir/.cindy-desktop.XXXXXXXX")
trap 'rm -f -- "$temp"' EXIT
# Desktop Entry escaping has two layers, unlike shell quoting. Keep %U
# outside the quoted executable. Reject literal % in PREFIX above.
exec_path=$prefix/launch
exec_path=${exec_path//\\/\\\\\\\\}
exec_path=${exec_path//\"/\\\\\"}
exec_path=${exec_path//\$/\\\\$}
exec_path=${exec_path//\`/\\\\\`}
icon=$prefix/current/resources/icon.png
icon=${icon//\\/\\\\}
printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Cindy (User)' \
  "Exec=\"$exec_path\" %U" "Icon=$icon" 'Terminal=false' \
  'Categories=Development;' "StartupWMClass=$app_id" \
  'MimeType=x-scheme-handler/cindy;x-scheme-handler/xdt-maker;' > "$temp"
desktop-file-validate "$temp"
mv -T -- "$temp" "$dest"
update-desktop-database "$apps_dir"
xdg-mime default "$id" x-scheme-handler/cindy x-scheme-handler/xdt-maker
printf 'Menu entry and login links registered: %s\n' "$dest"
printf 'CLI: use %s/launch (add a cindy symlink to your PATH if desired).\n' "$prefix"
