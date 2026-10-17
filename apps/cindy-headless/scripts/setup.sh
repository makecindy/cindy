#!/usr/bin/env sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v node >/dev/null 2>&1 || { echo 'MISSING_DEPENDENCY: Node.js 22'; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo 'MISSING_DEPENDENCY: pnpm'; exit 1; }
command -v docker >/dev/null 2>&1 || echo 'WARN Docker is required only for Harbor smoke tests.'
pnpm install --frozen-lockfile
npm --prefix "$APP_DIR" run ensure:binaries
npm --prefix "$APP_DIR" run typecheck
npm --prefix "$APP_DIR" test -- --run
npm --prefix "$APP_DIR" run bundle:linux
npm --prefix "$APP_DIR" run verify:bundle
echo 'READY Cindy Headless'
