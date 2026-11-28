#!/bin/bash
# Build only libplank from pinned upstream + Debian sources; no runtime downloads.
set -euo pipefail
recipe=$(cd -- "$(dirname -- "$0")" && pwd)
archives=$1
out=$2
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
export LC_ALL=C SOURCE_DATE_EPOCH=1789344000
(cd "$archives" && sha256sum --check --strict <<'SUMS'
a662a46eaeffbd40661d1f36abd2589f7a98baef4b918876b872047b7ca59d9d  plank_0.11.89.orig.tar.xz
afb06a37ecabf0f83d9b338cf8848c11834f06a9ab611436f34d049734023b9a  plank_0.11.89-4.debian.tar.xz
SUMS
)
tar -xf "$archives/plank_0.11.89.orig.tar.xz" -C "$work"
cd "$work/plank-0.11.89"
tar -xf "$archives/plank_0.11.89-4.debian.tar.xz"
while IFS= read -r patch_name; do patch --batch --fuzz=0 -p1 < "debian/patches/$patch_name"; done < debian/patches/series
patch --batch --fuzz=0 -p1 < "$recipe/hide-preferences.patch"
./configure --prefix=/usr --libdir=/usr/lib/x86_64-linux-gnu --disable-static --disable-docs --enable-dbusmenu --enable-barriers
make -j2 -C lib
# The stock executable and docklets must keep every ABI symbol they used before.
nm -D --defined-only /usr/lib/x86_64-linux-gnu/libplank.so.1 | awk '{print $3}' | sort -u > old-symbols
nm -D --defined-only lib/.libs/libplank.so.1.0.0 | awk '{print $3}' | sort -u > new-symbols
comm -23 old-symbols new-symbols > missing-symbols
test ! -s missing-symbols || { cat missing-symbols >&2; exit 1; }
install -D -m 0644 lib/.libs/libplank.so.1.0.0 "$out/libplank.so.1.0.0"
strip --strip-unneeded "$out/libplank.so.1.0.0"
ln -s libplank.so.1.0.0 "$out/libplank.so.1"
# Ship corresponding source and build instructions with the modified GPL library.
mkdir -p "$out/source"
cp "$archives/plank_0.11.89.orig.tar.xz" "$archives/plank_0.11.89-4.debian.tar.xz" "$out/source/"
cp "$recipe/hide-preferences.patch" "$recipe/build.sh" "$recipe/build-deps.txt" "$recipe/README.md" "$out/source/"
sha256sum "$out/libplank.so.1.0.0"
