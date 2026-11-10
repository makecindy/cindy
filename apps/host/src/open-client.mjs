import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHostDataDir } from './profile-path.mjs';

// Pair through the owner-only profile token. Neither the token nor the temporary
// browser code goes to stdout, disk, query parameters or the referrer header.
const profile = resolveHostDataDir();
try {
  const endpoint = JSON.parse(fs.readFileSync(path.join(profile, 'host-endpoint.json'), 'utf8'));
  const url = new URL(endpoint.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('invalid local Host endpoint');
  const token = fs.readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim();
  const response = await fetch(`${url.origin}/web/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Host did not authorize the connection');
  const { code } = await response.json();
  const target = `${url.origin}/connect#pair=${encodeURIComponent(code)}`;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  console.log('Opened Cindy Host in your browser.');
} catch {
  console.error('Cannot open Cindy Host. Start it first and use the same CINDY_HOST_DATA_DIR.');
  process.exitCode = 1;
}
