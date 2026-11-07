import { app } from 'electron';
import path from 'node:path';

/** Existing Cindy-managed Codex history and credentials; never relocate during pool adoption. */
export function getCodexHome(): string {
  return path.join(app.getPath('userData'), 'codex-home');
}
