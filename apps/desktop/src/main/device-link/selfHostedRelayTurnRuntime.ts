// The previous directory preserved archive owners. Its .verified marker and
// everything beneath it are untrusted. Publish into a new root-owned generation
// so an upgrade never executes or copies files from that tree.
export const ETURNAL_RELEASE_DIR = '/opt/cindy-relay/eturnal-1.12.3-r2';

export const ETURNAL_SHA256 = {
  x64: '4a16e00592802777163efbfaf3c05efc1ab9e61d85b6f16cac8921e234425c8c',
  arm64: '2760d8fe578f60a068fe1ddf161046c580e9d3b2fa7f3675ac64e0d2305cb644',
};

// Package hashes from Ubuntu's signed jammy InRelease -> main/binary-*/Packages.
// The fixed release pocket remains available independently of the guest's distro
// and package indexes. Nothing is installed into the system loader's search path.
export const stageTurnRuntime = `
set -eu
if [ ! -x /usr/lib/systemd/systemd-socket-proxyd ] && [ ! -x /lib/systemd/systemd-socket-proxyd ]; then exit 0; fi
release=${ETURNAL_RELEASE_DIR}
trusted_release() {
  [ -d "$release" ] && [ ! -L "$release" ] && [ -f "$release/.verified" ] &&
    [ ! -L "$release/.verified" ] && [ -x "$release/bin/eturnalctl" ] || return 1
  unsafe=$(find "$release" \\( ! -user root -o \\( ! -type l -perm /022 \\) \\) -print -quit) || return 1
  [ -z "$unsafe" ]
}
if [ -e "$release" ] || [ -L "$release" ]; then trusted_release && echo TURN_STAGED; exit; fi
umask 077
tmp=$(mktemp -d /opt/cindy-relay/turn-stage.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 5 --max-time "$3" -o "$2" "$1"
  else
    wget -q -t 1 -T "$3" -O "$2" "$1"
  fi
}
case "$1" in
  arm64)
    mirror=https://ports.ubuntu.com/ubuntu-ports; arch=arm64; triplet=aarch64-linux-gnu
    atomic_sha=cad7d920e727ca5db7bb1d396c205a4f27435971c8121590726c8b80cfdc55d9 ;;
  x64)
    mirror=https://archive.ubuntu.com/ubuntu; arch=amd64; triplet=x86_64-linux-gnu
    atomic_sha=38ca3edf9a5f7e0a8ee143b65b2671903427de607afd8de9d9fc8aff63844dc6 ;;
  *) exit 1 ;;
esac
download "https://eturnal.net/download/linux/eturnal-1.12.3-linux-glibc-$1.tar.gz" "$tmp/runtime" 45
echo "$2  $tmp/runtime" | sha256sum -c - >/dev/null
tar --no-same-owner --no-same-permissions -xzf "$tmp/runtime" -C "$tmp"
runtime="$tmp/eturnal"
if LC_ALL=C ldd "$runtime"/erts-*/bin/beam.smp | grep -Fq 'libatomic.so.1 => not found'; then
  download "$mirror/pool/main/g/gcc-12/libatomic1_12-20220319-1ubuntu1_$arch.deb" "$tmp/atomic.deb" 8
  echo "$atomic_sha  $tmp/atomic.deb" | sha256sum -c - >/dev/null
  # Unpack the authenticated data member with the distribution's tools.
  # Neither maintainer scripts nor the relay's cached Node run as root.
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb --fsys-tarfile "$tmp/atomic.deb" > "$tmp/atomic.tar"
  else
    ar p "$tmp/atomic.deb" data.tar.zst > "$tmp/atomic.tar"
  fi
  mkdir "$runtime/cindy-lib"
  tar -xOf "$tmp/atomic.tar" "./usr/lib/$triplet/libatomic.so.1.2.0" > "$runtime/cindy-lib/libatomic.so.1"
fi
chmod -R a-s,u=rwX,go=rX "$runtime"
LD_LIBRARY_PATH="$runtime/cindy-lib" "$runtime"/erts-*/bin/beam.smp -V >/dev/null 2>&1
touch "$runtime/.verified"
# Two deploys may finish staging concurrently. Only a completed generation wins.
mv -T "$runtime" "$release" || trusted_release
echo TURN_STAGED
`;
