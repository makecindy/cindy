#!/usr/bin/env bash
# Hosted Linux CI gets a dedicated OS account and real systemd user manager.
# No credentials or user services from the runner account are borrowed.
set -euo pipefail
test_user=cindy-terminal-acceptance
test_home=/home/cindy-terminal-acceptance
if id "$test_user" >/dev/null 2>&1; then
  echo 'Acceptance account already exists; refusing to reuse it' >&2
  exit 1
fi
sudo useradd --create-home --shell /bin/bash "$test_user"
test_uid=$(id -u "$test_user")
cleanup() {
  mkdir -p "$CINDY_ACCEPTANCE_REPORT"
  sudo cp -a "$test_home/report/." "$CINDY_ACCEPTANCE_REPORT/" 2>/dev/null || true
  sudo chown -R "$(id -u):$(id -g)" "$CINDY_ACCEPTANCE_REPORT"
  sudo systemctl stop "user@$test_uid.service" || true
  sudo loginctl disable-linger "$test_user" || true
  sudo userdel --remove "$test_user" || true
}
trap cleanup EXIT
sudo cp -a "$CINDY_ACCEPTANCE_OUTPUT" "$test_home/runtime"
sudo cp apps/cindy-terminal/scripts/platform-acceptance.mjs "$test_home/platform-acceptance.mjs"
sudo mkdir "$test_home/report"
sudo chown -R "$test_user:$test_user" "$test_home"
sudo loginctl enable-linger "$test_user"
sudo systemctl start "user@$test_uid.service"
sudo --preserve-env=CINDY_GITHUB_API_TOKEN -u "$test_user" env XDG_RUNTIME_DIR="/run/user/$test_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$test_uid/bus" CINDY_ACCEPTANCE_SYSTEMD=1 \
  "$test_home/runtime/runtime/node" "$test_home/platform-acceptance.mjs" "$test_home/runtime" "$test_home/report"
