#!/usr/bin/env sh
set -eu

prefix=${CINDY_HEADLESS_PREFIX:-"$HOME/.local/lib/cindy-headless"}
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
systemctl --user disable --now cindy-headless.service 2>/dev/null || true
rm -f "$unit_dir/cindy-headless.service"
systemctl --user daemon-reload
echo "Service removed. $prefix was retained along with user state; remove it manually when no longer needed."
