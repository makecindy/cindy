import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';
import type { AgentBinaryKind } from './index.js';

const log = createLogger('agent-binaries/startup-update');
const MARKER_FILE = 'agent-binary-update-once.json';
const MARKER_KINDS: readonly AgentBinaryKind[] = ['claude-code', 'codex', 'pi'];

/**
 * Which managed binaries the next startup may refresh: `true` = all (app update),
 * a list = only the harnesses the user confirmed, `false` = ordinary startup.
 */
export type StartupBinaryUpdateScope = boolean | readonly AgentBinaryKind[];

export function writeStartupBinaryUpdateMarker(
  userDataDir: string,
  version: string,
  kinds?: readonly AgentBinaryKind[],
): (() => void) | undefined {
  const markerPath = path.join(userDataDir, MARKER_FILE);
  const contents = JSON.stringify(kinds ? { version, kinds, token: randomUUID() } : { version, token: randomUUID() });
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(markerPath, contents, { mode: 0o600 });
  } catch {
    log.warn('Could not record the binary update check for the next startup');
    return undefined;
  }
  return () => {
    try {
      if (fs.readFileSync(markerPath, 'utf8') === contents) fs.unlinkSync(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Could not clear the cancelled startup binary update check');
      }
    }
  };
}

export function consumeStartupBinaryUpdateMarker(userDataDir: string, version: string): StartupBinaryUpdateScope {
  const markerPath = path.join(userDataDir, MARKER_FILE);
  try {
    const contents = fs.readFileSync(markerPath, 'utf8');
    fs.unlinkSync(markerPath);
    const marker: unknown = JSON.parse(contents);
    if (!marker || typeof marker !== 'object' || !('version' in marker) || marker.version !== version) return false;
    if (!('kinds' in marker)) return true;
    // A scoped marker that cannot be read back must not widen into a full refresh.
    const { kinds } = marker;
    if (!Array.isArray(kinds) || kinds.length === 0) return false;
    return kinds.every((kind) => MARKER_KINDS.includes(kind)) ? (kinds as AgentBinaryKind[]) : false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not consume the startup binary update check');
    }
    return false;
  }
}
