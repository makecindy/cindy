#!/usr/bin/env sh
# Install the newest architecture-matched Cindy Headless release from GitHub.
# Public repositories need no credentials. For a private repository, export a
# fine-grained GitHub token with read access to this repository first.
set -eu

repository=${CINDY_HEADLESS_REPOSITORY:-makecindy/cindy}
release=${CINDY_HEADLESS_RELEASE:-latest}
token=${CINDY_GITHUB_TOKEN:-}

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="cindy-headless-linux-${arch}.tar.gz"
if [ "$release" = latest ]; then
  base="https://github.com/${repository}/releases/latest/download"
else
  base="https://github.com/${repository}/releases/download/${release}"
fi

workdir=$(mktemp -d "${TMPDIR:-/tmp}/cindy-headless-install.XXXXXX")
cleanup() { rm -rf -- "$workdir"; }
trap cleanup EXIT HUP INT TERM

download() {
  url=$1
  output=$2
  if [ -n "$token" ]; then
    curl -fsSL --retry 2 -H "Authorization: Bearer $token" "$url" -o "$output"
  else
    curl -fsSL --retry 2 "$url" -o "$output"
  fi
}

command -v curl >/dev/null 2>&1 || { echo 'curl is required for bootstrap installation.' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required to verify the Cindy release.' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'tar is required to unpack the Cindy release.' >&2; exit 1; }

echo "Downloading Cindy Headless (${arch}) from ${repository}…"
if ! download "$base/$asset" "$workdir/$asset"; then
  if [ -z "$token" ]; then
    echo 'Download failed. If this is a private GitHub repository, export CINDY_GITHUB_TOKEN with read-only repository access and retry.' >&2
  fi
  exit 1
fi
download "$base/$asset.sha256" "$workdir/$asset.sha256"
(cd "$workdir" && sha256sum -c "$asset.sha256")
tar -xzf "$workdir/$asset" -C "$workdir"

release_dir=$(find "$workdir" -mindepth 1 -maxdepth 1 -type d -name 'cindy-headless-*' -print -quit)
test -n "$release_dir" && test -x "$release_dir/install-user-service.sh" || {
  echo 'The downloaded Cindy release has an invalid layout.' >&2
  exit 1
}
exec "$release_dir/install-user-service.sh"
