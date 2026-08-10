/**
 * Executable shims placed first in the local Codex child PATH.
 *
 * Codex Full access can run trusted commands without sending an approval
 * request. A command-approval callback therefore cannot be the only boundary:
 * these shims stop the common bare `open` / `xcrun` skill recipes before the
 * real macOS binaries are reached. Absolute paths are covered by the item-start
 * fallback and the Claude PreToolUse hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const OPEN_SHIM = `#!/bin/sh
joined="$*"
if printf '%s' "$joined" | /usr/bin/grep -Eiq '(^|[[:space:]])-a[[:space:]]+Simulator(\\.app)?($|[[:space:]])|(^|[[:space:]])-b[[:space:]]+com\\.apple\\.iphonesimulator($|[[:space:]])|Simulator\\.app(/Contents/MacOS/Simulator)?($|[[:space:]])'; then
  echo 'Cindy: use cindy_ios_simulator instead of launching the external Simulator.app.' >&2
  exit 86
fi
exec /usr/bin/open "$@"
`;

const XCRUN_SHIM = `#!/bin/sh
if [ "$1" = "simctl" ]; then
  case "$2" in
    help|list|listapps|getenv|get_app_container|diagnose) ;;
    *)
      echo 'Cindy: use cindy_ios_simulator instead of mutating an iOS Simulator with simctl.' >&2
      exit 86
      ;;
  esac
fi
exec /usr/bin/xcrun "$@"
`;

/** Returns a stable per-user guard directory, or null outside macOS. */
export function ensureAgentShellGuards(): string | null {
  if (process.platform !== 'darwin') return null;
  const dir = path.join(app.getPath('userData'), 'agent-shell-guards');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: Array<[string, string]> = [
    ['open', OPEN_SHIM],
    ['xcrun', XCRUN_SHIM],
  ];
  for (const [name, contents] of files) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== contents) {
      fs.writeFileSync(filePath, contents, { mode: 0o700 });
    } else {
      fs.chmodSync(filePath, 0o700);
    }
  }
  return dir;
}
