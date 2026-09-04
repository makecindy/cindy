#!/usr/bin/env bash
# User-owned Cindy installation. Also embedded in the in-app updater: no Debian
# maintainer scripts, privilege escalation, or ASAR rewriting.
set -euo pipefail
umask 077

fail() { printf 'Cindy: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'This installer requires Linux.'
[[ $EUID -ne 0 ]] || fail 'Run as your desktop user, not root or sudo.'
for tool in bsdtar sha256sum stat dd mktemp realpath flock find readlink mv ln; do
  command -v "$tool" >/dev/null || fail "Missing dependency: $tool (see docs/linux.md)."
done
mode=${1:-}
case "$mode" in
  --install)
    [[ $# -ge 3 && $# -le 4 ]] || fail 'Usage: install-user.sh --install PACKAGE.deb SHA256 [PREFIX]'
    archive=$2 digest=${3,,} prefix=${4:-"$HOME/.local/opt/cindy"}
    size=$(stat -c %s -- "$archive")
    expected_version='' expected_region=''
    ;;
  --apply)
    [[ $# -eq 8 ]] || fail 'Invalid update transaction arguments.'
    archive=$2 digest=${3,,} size=$4 prefix=$5 expected_version=$6 expected_region=$7 expected_current=$8
    ;;
  *) fail 'Usage: install-user.sh --install PACKAGE.deb SHA256 [PREFIX]' ;;
esac
[[ $digest =~ ^[a-f0-9]{64}$ ]] || fail 'A SHA-256 from the trusted release is required.'
[[ $size =~ ^[1-9][0-9]{0,10}$ ]] || fail 'Invalid package size.'
[[ -f $archive && ! -L $archive ]] || fail 'Package must be a regular file, not a symlink.'
archive=$(realpath -e -- "$archive")
[[ $prefix == /* && $prefix != *$'\n'* && $prefix != *$'\r'* ]] || fail 'PREFIX must be an absolute path without line breaks.'
prefix=$(realpath -m -- "$prefix")
user_home=$(realpath -e -- "$HOME")
[[ $prefix == "$user_home/"* && $prefix != "$user_home" ]] || fail 'PREFIX must be inside your home directory.'
marker="$prefix/.cindy-user-install"
if [[ -e $prefix ]]; then
  [[ -d $prefix && -f $marker && ! -L $marker ]] || fail 'Existing PREFIX is not a managed Cindy install; choose an empty new path.'
else
  [[ $mode == --install ]] || fail 'Managed installation disappeared.'
  mkdir -p -- "$prefix"
  printf 'cindy-user-install-v1:pending\n' > "$marker"
fi
[[ -O $prefix && -O $marker ]] || fail 'Installation is not owned by this user.'
exec 9> "$prefix/.install.lock"
flock -n 9 || fail 'Another installation is in progress.'
mkdir -p -- "$prefix/releases"
[[ ! -L $prefix/releases && -O $prefix/releases ]] || fail 'Invalid releases directory.'
stage=$(mktemp -d "$prefix/releases/.stage.XXXXXXXX")
new_release=''
cleanup() {
  # Only remove this transaction's unactivated directory. In particular a
  # signal just after activation must never delete the now-current release.
  if [[ -n $new_release && $(readlink -- "$prefix/current" 2>/dev/null || true) != "$new_release" ]]; then
    rm -rf -- "$prefix/$new_release"
  fi
  if [[ -n ${stage:-} && -d $stage ]]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT

# Copy once, bounded and O_NOFOLLOW. Hash and extract the same private snapshot.
cap=$((size / 1048576 + 2))
dd if="$archive" of="$stage/package.deb" iflag=nofollow,nonblock bs=1048576 count="$cap" status=none
[[ $(stat -c %s -- "$stage/package.deb") == "$size" ]] || fail 'Package size mismatch.'
actual=$(sha256sum -- "$stage/package.deb")
[[ ${actual:0:64} == "$digest" ]] || fail 'Package SHA-256 mismatch.'
bsdtar -tf "$stage/package.deb" > "$stage/members"
data_member=''
while IFS= read -r member; do
  case "$member" in
    data.tar|data.tar.gz|data.tar.xz|data.tar.zst)
      [[ -z $data_member ]] || fail 'Duplicate package payload.'
      data_member=$member ;;
  esac
done < "$stage/members"
[[ -n $data_member ]] || fail 'Missing package payload.'
bsdtar -xOf "$stage/package.deb" "$data_member" > "$stage/data.tar"
mkdir "$stage/payload"
# libarchive's secure defaults reject traversal and symlink escapes. Never use
# -P / --absolute-paths or preserve archive ownership / setuid permissions.
bsdtar -xf "$stage/data.tar" -C "$stage/payload" --no-same-owner --no-same-permissions ./usr/lib/cindy
payload="$stage/payload/usr/lib/cindy"
[[ -d $payload && ! -L $payload ]] || fail 'Missing Cindy payload.'
info="$payload/resources/linux-build-info"
[[ -f $info && ! -L $info ]] || fail 'This package predates user-install support; use a newer release.'
mapfile -t fields < "$info"
[[ ${#fields[@]} -eq 5 && ${fields[0]} == cindy-linux-v1 ]] || fail 'Invalid build identity.'
version=${fields[1]} arch=${fields[2]} region=${fields[3]} executable=${fields[4]}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] || fail 'Invalid build version.'
[[ $region == global || $region == cn ]] || fail 'Only release builds can be installed.'
[[ $executable == Cindy ]] || fail 'Unexpected executable identity.'
case "$(uname -m):$arch" in x86_64:x64|aarch64:arm64) ;; *) fail 'Package architecture does not match this machine.' ;; esac
[[ -z $expected_version || $version == "$expected_version" ]] || fail 'Downloaded version does not match the update manifest.'
[[ -z $expected_region || $region == "$expected_region" ]] || fail 'Downloaded build belongs to a different region.'
identity=$(< "$marker")
[[ $identity == cindy-user-install-v1:pending || $identity == "cindy-user-install-v1:$region" ]] || fail 'Do not mix release regions in one installation.'
[[ -x $payload/$executable && ! -L $payload/$executable && -f $payload/resources/app.asar ]] || fail 'Incomplete application.'
while IFS= read -r -d '' entry; do
  if [[ -L $entry ]]; then
    target=$(realpath -m -- "$entry")
    [[ $target == "$payload/"* ]] || fail 'Package symlink escapes the application.'
  elif [[ ! -f $entry && ! -d $entry ]]; then
    fail 'Package contains a special file.'
  fi
done < <(find "$payload" -print0)

current=''
if [[ -e $prefix/current || -L $prefix/current ]]; then
  [[ -L $prefix/current ]] || fail 'current is not a managed symlink.'
  current=$(readlink -- "$prefix/current")
  [[ $current =~ ^releases/[A-Za-z0-9.+-]+$ && -d $prefix/$current ]] || fail 'Invalid current release.'
fi
if [[ $mode == --apply ]]; then
  [[ $identity == "cindy-user-install-v1:$region" && -n $current ]] || fail 'Update requires an installed release.'
  [[ $current == "$expected_current" ]] || fail 'Installation changed while the update was pending.'
fi
release="releases/$version-$digest"
if [[ -e $prefix/$release ]]; then
  [[ $current == "$release" ]] && exit 0
  fail 'Release directory already exists; inspect it before retrying.'
fi
# Never install setuid/setgid helpers from a system package into user storage.
find "$payload" -type f -exec chmod u-s,g-s -- {} +
new_release=$release
mv -- "$payload" "$prefix/$release"
printf 'cindy-user-install-v1:%s\n' "$region" > "$stage/marker"
mv -T -- "$stage/marker" "$marker"
if [[ -n $current ]]; then
  ln -s -- "$current" "$stage/previous"
  mv -Tf -- "$stage/previous" "$prefix/previous"
fi
ln -s -- "$release" "$stage/current"
# Single rename is the activation point. Old versions are never overwritten.
mv -Tf -- "$stage/current" "$prefix/current"
if [[ $mode == --install ]]; then
  # Keep launchers inside the prefix; do not overwrite other installations.
  quoted=${prefix//\'/\'\\\'\'}
  printf '#!/bin/sh\nexec '\''%s/current/Cindy'\'' "$@"\n' "$quoted" > "$prefix/launch"
  chmod 755 "$prefix/launch"
  printf 'Installed Cindy %s. Start with: %s/launch\n' "$version" "$prefix"
  printf 'To add a menu entry and login links, run: bash %q %q\n' "$prefix/current/resources/linux/register-desktop.sh" "$prefix"
fi
