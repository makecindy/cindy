#!/bin/sh
set -eu
cd /workspace/source
export TAR_OPTIONS=--no-same-owner
# The production bundle exceeds a 6 GiB heap. Only this step uses the larger limit.
export CI=1 NODE_OPTIONS=--max-old-space-size=12288
export CINDY_AUTH_REGION=cn VITE_CINDY_AUTH_REGION=cn
test -n "${APP_VERSION:-}"
export PATH=/workspace/sysroot/usr/bin:$PATH
export PKG_CONFIG_SYSROOT_DIR=/workspace/sysroot
export PKG_CONFIG_LIBDIR=/workspace/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig
export LD_LIBRARY_PATH=/workspace/sysroot/usr/lib/x86_64-linux-gnu
# Overlays resolve typescript from the exported client workspace.
test -e /workspace/recipe/node_modules || ln -s /workspace/source/node_modules /workspace/recipe/node_modules
node /workspace/recipe/stage-cloud-overlays.mjs
pnpm --filter desktop package --platform=linux --arch=x64
# A failed child process can still leave a successful wrapper exit, so require
# the package before staging runtime assets.
test -x apps/desktop/out/Cindy-linux-x64/Cindy
test -s apps/desktop/out/Cindy-linux-x64/resources/app.asar
mkdir -p /workspace/artifact
test ! -e /workspace/artifact/cindy
cp -a apps/desktop/out/Cindy-linux-x64 /workspace/artifact/cindy
python3 /workspace/recipe/stage-runtime-agents.py /workspace/source /workspace/artifact
chmod -R a+rX /workspace/artifact
printf 'CLOUD_PACKAGE_COMPLETE\n'
