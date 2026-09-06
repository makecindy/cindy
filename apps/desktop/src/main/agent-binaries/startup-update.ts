import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';

const log = createLogger('agent-binaries/startup-update');
const MARKER_FILE = 'agent-binary-update-once.json';

export function writeStartupBinaryUpdateMarker(
  userDataDir: string,
  version: string,
): (() => void) | undefined {
  const markerPath = path.join(userDataDir, MARKER_FILE);
  const contents = JSON.stringify({ version, token: randomUUID() });
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

export function consumeStartupBinaryUpdateMarker(userDataDir: string, version: string): boolean {
  const markerPath = path.join(userDataDir, MARKER_FILE);
  try {
    const contents = fs.readFileSync(markerPath, 'utf8');
    fs.unlinkSync(markerPath);
    const marker: unknown = JSON.parse(contents);
    return !!marker && typeof marker === 'object' && 'version' in marker && marker.version === version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not consume the startup binary update check');
    }
    return false;
  }
}
