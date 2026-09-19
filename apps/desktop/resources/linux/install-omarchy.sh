#!/usr/bin/env bash
# Website/OSS bootstrap for Arch and Omarchy. Fetch one stable manifest snapshot,
# then use the installer shipped INSIDE its verified DEB (never Git HEAD).
# Keep the entry point last: a truncated curl | bash input must not start an install.
cindy_bootstrap() (
  set -euo pipefail
  umask 077
  export LC_ALL=C
  fail() { printf 'Cindy: %s\n' "$*" >&2; exit 1; }
  usage() {
    printf '%s\n' 'Usage: bash install-omarchy.sh [--region global|cn] [--prefix /absolute/path]' \
      'Installs the latest stable Cindy on Arch Linux / Omarchy, without sudo.'
  }
  region=global
  prefix=''
  while (( $# )); do
    case "$1" in
      --region) [[ $# -ge 2 ]] || fail 'Missing region.'; region=$2; shift 2 ;;
      --prefix) [[ $# -ge 2 && -n $2 ]] || fail 'Missing prefix.'; prefix=$2; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; fail "Unknown argument: $1" ;;
    esac
  done
  # Match config/endpoint.global.json and config/endpoint.json. A website chooses
  # its build via the command, not by guessing the user's IP or locale.
  case "$region" in
    global) base_url=https://hotfix.cindy.app/cindy ;;
    cn) base_url=https://hotfix.cindy.com.cn/cindy ;;
    *) fail 'Region must be global or cn.' ;;
  esac
  [[ $(uname -s) == Linux ]] || fail 'This installer requires Arch Linux / Omarchy.'
  [[ $EUID -ne 0 ]] || fail 'Run as your desktop user, not root or sudo.'
  [[ -r /etc/os-release ]] || fail 'Cannot identify this Linux distribution.'
  ID='' ID_LIKE=''
  # shellcheck source=/dev/null
  source /etc/os-release
  case " $ID $ID_LIKE " in
    *' debian '*|*' ubuntu '*) fail 'On Ubuntu / Debian, download the official .deb and install it with apt.' ;;
    *' arch '*|*' omarchy '*) ;;
    *) fail 'This one-command installer supports Arch Linux / Omarchy only.' ;;
  esac
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) fail 'No official Linux package is available for this architecture.' ;;
  esac
  packages='curl jq libarchive coreutils util-linux findutils procps-ng desktop-file-utils xdg-utils gtk3 nss alsa-lib libxss libxtst libnotify libdrm mesa libsecret'
  missing=()
  for tool in curl jq bsdtar sha256sum stat dd mktemp realpath flock find readlink mv ln sort date id pgrep pacman desktop-file-validate update-desktop-database xdg-mime; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  if (( ${#missing[@]} )); then
    printf 'Missing tools: %s\nRun: sudo pacman -Syu --needed %s\n' "${missing[*]}" "$packages" >&2
    exit 1
  fi
  runtime_missing=$(pacman -T gtk3 nss alsa-lib libxss libxtst libnotify libdrm mesa libsecret) || {
    printf 'Missing runtime libraries:\n%s\nRun: sudo pacman -Syu --needed %s\n' "$runtime_missing" "$packages" >&2
    exit 1
  }
  # Do not shadow a package-manager-owned install with a new user installation.
  for executable in /usr/lib/cindy/Cindy /usr/bin/cindy /usr/bin/Cindy; do
    if pacman -Qo -- "$executable" >/dev/null 2>&1; then
      fail 'Cindy is managed by pacman/AUR. Update it through that package manager.'
    fi
    if command -v dpkg-query >/dev/null && dpkg-query -S "$executable" >/dev/null 2>&1; then
      fail 'Cindy is a system package. Update it through its package manager.'
    fi
  done
  if pgrep -u "$(id -u)" -x Cindy >/dev/null; then
    fail 'Quit Cindy fully, then run this command again.'
  fi
  user_home=$(realpath -e -- "$HOME")
  data_dir=$(realpath -m -- "${XDG_DATA_HOME:-$HOME/.local/share}")
  [[ $data_dir == "$user_home/"* && $data_dir != *[[:cntrl:]]* ]] || fail 'XDG_DATA_HOME must be inside HOME without control characters.'

  # v1 defaulted BOTH regions to cindy. Reuse that legacy prefix when its
  # marker matches; new cn installs get a distinct, explicitly named prefix.
  if [[ -z $prefix ]]; then
    default_prefix="$user_home/.local/opt/cindy"
    if [[ $region == cn ]]; then
      legacy_marker="$default_prefix/.cindy-user-install"
      if [[ ! -L $default_prefix && -f $legacy_marker && ! -L $legacy_marker && $(< "$legacy_marker") == cindy-user-install-v1:cn ]]; then
        prefix=$default_prefix
      else
        default_prefix+=-cn
      fi
    fi
    if [[ -z $prefix ]]; then
      prefix=$default_prefix
      suffix=0
      while [[ -e $prefix || -L $prefix ]]; do
        marker="$prefix/.cindy-user-install"
        if [[ ! -L $prefix && -f $marker && ! -L $marker ]]; then
          identity=$(< "$marker")
          [[ $identity == "cindy-user-install-v1:$region" || $identity == cindy-user-install-v1:pending ]] && break
          [[ $identity == cindy-user-install-v1:cn || $identity == cindy-user-install-v1:global ]] || fail "Invalid install marker: $marker"
        elif [[ ! -L $prefix && ( -e $marker || -L $marker ) ]]; then
          fail "Invalid install marker: $marker"
        fi
        (( suffix += 1 ))
        [[ $suffix -le 100 ]] || fail 'Choose an unused installation directory with --prefix.'
        prefix="$default_prefix-managed"
        (( suffix == 1 )) || prefix+="-$suffix"
      done
    fi
  fi
  [[ $prefix == /* && ! -L $prefix && $prefix != *[[:cntrl:]=%]* ]] || fail 'PREFIX must be absolute, not a symlink, and contain no control characters, = or %.'
  prefix=$(realpath -m -- "$prefix")
  [[ $prefix == "$user_home/"* && $prefix != *[[:cntrl:]=%]* ]] || fail 'PREFIX must be inside HOME with no control characters, = or %.'
  validate_prefix() {
    [[ ! -L $prefix && $(realpath -m -- "$prefix") == "$prefix" ]] || fail 'PREFIX changed during installation; retry.'
    if [[ -e $prefix ]]; then
      marker="$prefix/.cindy-user-install"
      [[ -d $prefix && -O $prefix && -f $marker && ! -L $marker && -O $marker ]] || fail 'Existing PREFIX is not a managed, user-owned Cindy installation.'
      identity=$(< "$marker")
      [[ $identity == "cindy-user-install-v1:$region" || $identity == cindy-user-install-v1:pending ]] || fail 'Do not mix release regions in one installation.'
    fi
  }
  validate_prefix
  # Serialize bootstrap invocations before reading the manifest/current version.
  # A sibling lock works before PREFIX exists and is separate from the packaged
  # helper's fd 9 / .install.lock. Keep its inode even after releasing the lock.
  mkdir -p -- "${prefix%/*}"
  bootstrap_lock="$prefix.bootstrap.lock"
  [[ ! -L $bootstrap_lock ]] || fail 'Invalid bootstrap lock.'
  if [[ -e $bootstrap_lock ]]; then
    [[ -f $bootstrap_lock && -O $bootstrap_lock ]] || fail 'Invalid bootstrap lock.'
  fi
  exec 8>> "$bootstrap_lock"
  flock -n 8 || fail 'Another Cindy bootstrap is in progress for this installation. Wait for it to finish, then retry.'
  validate_prefix

  temp=$(mktemp -d -t cindy-bootstrap.XXXXXXXX)
  trap 'rm -rf -- "$temp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  fetch() {
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time "$4" --retry 2 --max-filesize "$3" \
      --output "$2" "$1"
  }
  printf 'Checking the latest Cindy release...\n'
  fetch "$base_url/manifest-linux-$arch.json?t=$(date +%s)" "$temp/manifest.json" 1048576 60 || fail 'Could not fetch the latest release. Retry when the release service is reachable.'
  # Parse JSON as data, never shell code. Only relative, versioned asset paths
  # under the selected CDN are accepted, matching PlatformAsset.file.
  jq -er '
    .app | select(type == "object") |
    select(.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) |
    select(.installer.file | type == "string" and test("^[A-Za-z0-9_-][A-Za-z0-9._/+%-]*\\.deb$")) |
    select(.installer.file | split("/") | all(. != ".." and . != "." and . != "")) |
    select(.installer.file | contains("%") | not) |
    select(.installer.sha256 | type == "string" and test("^[a-fA-F0-9]{64}$")) |
    select(.installer.size | type == "number" and . > 0 and . <= 99999999999 and . == floor) |
    [.version, .installer.file, (.installer.sha256 | ascii_downcase), (.installer.size | tostring)] | .[]
  ' "$temp/manifest.json" > "$temp/asset" || fail 'The latest release has no valid stable Linux installer metadata.'
  mapfile -t asset < "$temp/asset"
  [[ ${#asset[@]} -eq 4 ]] || fail 'Invalid release metadata.'
  version=${asset[0]} file=${asset[1]} digest=${asset[2]} size=${asset[3]}
  # A stale CDN must not roll an existing profile back to an older binary.
  installed_info="$prefix/current/resources/linux-build-info"
  if [[ -f $installed_info ]]; then
    mapfile -t installed < "$installed_info"
    [[ ${#installed[@]} -eq 5 && ${installed[0]} == cindy-linux-v1 && ${installed[3]} == "$region" ]] || fail 'Invalid installed build identity.'
    installed_version=${installed[1]}
    [[ $installed_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Use in-app updates for a non-stable installation.'
    oldest=$(printf '%s\n%s\n' "$installed_version" "$version" | sort -V | head -n 1)
    [[ $oldest == "$installed_version" ]] || fail 'The published release is older than this installation; refusing to downgrade.'
  fi
  printf 'Downloading Cindy %s (%s)...\n' "$version" "$arch"
  fetch "$base_url/$file" "$temp/package.deb" "$size" 1800 || fail 'Package download failed. Run this command again to retry.'
  [[ $(stat -c %s -- "$temp/package.deb") == "$size" ]] || fail 'Package size mismatch; nothing was installed.'
  actual=$(sha256sum -- "$temp/package.deb")
  [[ ${actual:0:64} == "$digest" ]] || fail 'Package SHA-256 mismatch; nothing was installed.'

  bsdtar -tf "$temp/package.deb" > "$temp/members"
  data_member=''
  while IFS= read -r member; do
    case "$member" in
      data.tar|data.tar.gz|data.tar.xz|data.tar.zst)
        [[ -z $data_member ]] || fail 'Duplicate package payload.'
        data_member=$member ;;
    esac
  done < "$temp/members"
  [[ -n $data_member ]] || fail 'Missing package payload.'
  bsdtar -xOf "$temp/package.deb" "$data_member" > "$temp/data.tar"
  # Read only the identity and helpers, into regular private files. Their bytes
  # are covered by the trusted DEB digest; no extracted paths are executed.
  resources=./usr/lib/cindy/resources
  for entry in linux-build-info linux/install-user.sh linux/register-desktop.sh; do
    bsdtar -xOf "$temp/data.tar" "$resources/$entry" > "$temp/${entry##*/}" || fail 'This package predates one-command installation support. Publish a newer Linux release.'
    [[ -s $temp/${entry##*/} ]] || fail 'Missing installation helper or build identity.'
  done
  mapfile -t fields < "$temp/linux-build-info"
  [[ ${#fields[@]} -eq 5 && ${fields[0]} == cindy-linux-v1 && ${fields[1]} == "$version" && ${fields[2]} == "$arch" && ${fields[3]} == "$region" && ${fields[4]} == Cindy ]] || fail 'Package version, architecture or region does not match the selected release.'
  printf 'Installing to %s...\n' "$prefix"
  bash "$temp/install-user.sh" --install "$temp/package.deb" "$digest" "$prefix"
  if ! bash "$temp/register-desktop.sh" "$prefix"; then
    printf 'Cindy was installed, but desktop registration failed. Retry with:\nbash %q %q\n' "$prefix/current/resources/linux/register-desktop.sh" "$prefix" >&2
    exit 1
  fi
  printf 'Cindy %s is ready. Open Cindy from your application menu, or run:\n%q\n' "$version" "$prefix/launch"
)

cindy_bootstrap "$@"
