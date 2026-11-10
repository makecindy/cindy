import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Same encrypted owner key and exclusive creation, shared by both launchers. */
export function createMcpAppRevisionKeyStore(ports: {
  filePath(): string;
  available(): boolean;
  read(): string | null;
  encrypt(value: string): string;
}) {
let mcpAppRevisionKeyCache: { path: string; key: string } | undefined;
function get(): string {
  try {
    const filepath = ports.filePath();
    if (mcpAppRevisionKeyCache?.path === filepath) return mcpAppRevisionKeyCache.key;
    if (!ports.available()) throw new Error('vault unavailable');
    let key = ports.read();
    if (key === null) {
      const created = randomBytes(32).toString('hex');
      const encrypted = ports.encrypt(created);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      try {
        // Concurrent instances must adopt the winner, never overwrite its key.
        fs.writeFileSync(filepath, encrypted, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        key = created;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        key = ports.read();
      }
    }
    if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid revision key');
    mcpAppRevisionKeyCache = { path: filepath, key };
    return key;
  } catch {
    // Never fall back to a public hash, replace unreadable vault data or expose it.
    throw new Error('MCP_APP_REVISION_KEY_UNAVAILABLE');
  }
}

return { get, clear() { mcpAppRevisionKeyCache = undefined; } };
}
