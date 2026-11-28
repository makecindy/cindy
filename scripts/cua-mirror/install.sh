#!/bin/bash
# Release source: @SOURCE@
set -euo pipefail
export CUA_DRIVER_RS_DOWNLOAD_BASE_URL='@BASE@/releases/download'
export CUA_DRIVER_RS_VERSION="${CUA_DRIVER_RS_VERSION:-${CUA_DRIVER_VERSION:-@VERSION@}}"
[[ "$CUA_DRIVER_RS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
dir="$(mktemp -d)"
trap 'rm -rf -- "$dir"' EXIT
base="$CUA_DRIVER_RS_DOWNLOAD_BASE_URL/cua-driver-rs-v$CUA_DRIVER_RS_VERSION"
for file in install.sh _install-rust.sh _install-common.sh; do
  curl --fail --silent --show-error --location "$base/$file" --output "$dir/$file"
done
/bin/bash "$dir/install.sh" "$@"
