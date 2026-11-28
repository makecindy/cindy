import { ETURNAL_RELEASE_DIR as release } from './selfHostedRelayTurnRuntime.js';
export { ETURNAL_SHA256, stageTurnRuntime } from './selfHostedRelayTurnRuntime.js';

const root = '/opt/cindy-relay';
const data = '/var/lib/cindy-relay';
const unit = '/etc/systemd/system/cindy-relay-turn';
const socket = '/run/cindy-relay-turn.sock';
const credential = `${root}/paired-turn.yml`;
const sandbox = `DynamicUser=yes
PrivateNetwork=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
InaccessiblePaths=-${data} -/etc/letsencrypt -/etc/ssl/private -${credential}`;
const managed = '# Managed by the Cindy relay installer';
// Recognize the earlier installer layout only by its exact unit role and
// private executable/socket. Never edit a similarly named administrator unit.
const ownership = `
owned_turn_unit() {
  f="$1"
  [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %u "$f")" = 0 ] || return 1
  if grep -Fqx '${managed}' "$f"; then return 0; fi
  case "$f" in
    ${unit}.service) grep -Fqx 'Description=Cindy paired TURN allocations' "$f" && grep -Fqx 'ExecStart=${root}/eturnal-1.12.3/bin/eturnalctl foreground' "$f";;
    ${unit}-proxy.service) grep -Fqx 'Description=Cindy paired TURN local ingress' "$f" && grep -Eq '^ExecStart=/(usr/)?lib/systemd/systemd-socket-proxyd --connections-max=96 --exit-idle-time=60s 127\\.0\\.0\\.1:3478$' "$f";;
    ${unit}-proxy.socket) grep -Fqx 'Description=Cindy paired TURN socket' "$f" && grep -Fqx 'ListenStream=${socket}' "$f";;
    *) return 1;;
  esac
}
`;

export const stopTurn = `
${ownership}
rm -f ${root}/paired-turn.ready ${root}/paired-turn.ready.new ${credential} ${credential}.new
for name in cindy-relay-turn-proxy.socket cindy-relay-turn-proxy.service cindy-relay-turn.service; do
  file="/etc/systemd/system/$name"
  if owned_turn_unit "$file"; then
    if [ "$name" = cindy-relay-turn-proxy.socket ]; then systemctl disable "$name" >/dev/null 2>&1; fi
    systemctl stop "$name" || exit 1
    rm -f "$file"
  fi
  if [ -f "$file.new" ] && grep -Fqx '${managed}' "$file.new"; then rm -f "$file.new"; fi
done
systemctl daemon-reload >/dev/null 2>&1 || true
`;

// Called with the release, the dedicated uid and the device identity already in
// place. Every failure here disables only the optional media endpoint.
export const configureTurn = `
set -eu
cleanup_failed_turn() {
  ${stopTurn}
}
trap 'code=$?; if [ "$code" != 0 ]; then cleanup_failed_turn; fi' EXIT
trap 'exit 1' HUP INT TERM
${ownership}
for f in ${unit}.service ${unit}-proxy.service ${unit}-proxy.socket; do
  if { [ -e "$f" ] || [ -L "$f" ]; } && ! owned_turn_unit "$f"; then exit 1; fi
done
proxy=/usr/lib/systemd/systemd-socket-proxyd
[ -x "$proxy" ] || proxy=/lib/systemd/systemd-socket-proxyd
[ -x "$proxy" ] && [ -x ${release}/bin/eturnalctl ] || exit 1
"$proxy" --help | grep -q -- '--exit-idle-time' || exit 1
# The child reads the original identity with only its existing permissions.
# systemd delivers just the derived TURN configuration to the media service.
umask 077
runuser -u cindy-relay -- ${root}/node/bin/node ${root}/relay.mjs turn-config --data ${data} 3> ${credential}.new
changed=no
if ! cmp -s ${credential} ${credential}.new; then
  mv -f ${credential}.new ${credential}
  changed=yes
else
  rm ${credential}.new
fi
umask 022
cat > ${unit}.service.new <<'UNIT'
${managed}
[Unit]
Description=Cindy paired TURN allocations
StopWhenUnneeded=yes
[Service]
Type=notify
NotifyAccess=all
User=cindy-turn-media
${sandbox}
LoadCredential=eturnal.yml:${credential}
RuntimeDirectory=cindy-relay-turn
RuntimeDirectoryMode=0700
WorkingDirectory=/run/cindy-relay-turn
Environment=HOME=/run/cindy-relay-turn ETURNAL_ETC_DIR=%d ETURNAL_PREFIX=${release} RELX_OUT_FILE_PATH=/run/cindy-relay-turn
Environment=LD_LIBRARY_PATH=${release}/cindy-lib
Environment="ERL_FLAGS=+S 2:2 +SDcpu 1 +SDio 1"
ExecStartPre=${root}/node/bin/node ${root}/relay.mjs turn-check-network
ExecStart=${release}/bin/eturnalctl foreground
PrivateTmp=yes
UMask=0077
TimeoutStartSec=10
MemoryMax=256M
LimitNOFILE=256
UNIT
cat > ${unit}-proxy.service.new <<UNIT
${managed}
[Unit]
Description=Cindy paired TURN local ingress
Requires=cindy-relay-turn.service
After=cindy-relay-turn.service
JoinsNamespaceOf=cindy-relay-turn.service
[Service]
User=cindy-turn-proxy
${sandbox}
ExecStart=$proxy --connections-max=96 --exit-idle-time=60s 127.0.0.1:3478
UNIT
cat > ${unit}-proxy.socket.new <<'UNIT'
${managed}
[Unit]
Description=Cindy paired TURN socket
[Socket]
RuntimeDirectory=cindy-relay-turn-ingress
RuntimeDirectoryMode=0755
ExecStartPre=/bin/sh -ec 'readlink /proc/self/ns/net > /run/cindy-relay-turn-ingress/host.netns'
ListenStream=${socket}
SocketUser=cindy-relay
SocketMode=0600
RemoveOnStop=yes
UNIT
printf '\\n[Install]\\nWantedBy=sockets.target\\n' >> ${unit}-proxy.socket.new
for f in ${unit}.service ${unit}-proxy.service ${unit}-proxy.socket; do
  if ! cmp -s "$f" "$f.new"; then mv "$f.new" "$f"; changed=yes; else rm "$f.new"; fi
done
if [ "$changed" = yes ] || [ "$1" = 1 ]; then
  systemctl daemon-reload
  systemctl stop cindy-relay-turn-proxy.socket cindy-relay-turn-proxy.service cindy-relay-turn.service
fi
systemctl enable --now cindy-relay-turn-proxy.socket >/dev/null 2>&1
# Probe the real service through the namespace bridge before advertising it.
runuser -u cindy-relay -- ${root}/node/bin/node ${root}/relay.mjs turn-check
printf '%s\\n' "$2" > ${root}/paired-turn.ready.new
mv -f ${root}/paired-turn.ready.new ${root}/paired-turn.ready
`;
