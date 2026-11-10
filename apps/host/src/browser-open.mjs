import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readHostEndpoint, readHostProcessStatus } from './control.mjs';

export function openSystemBrowser(target, { platform = process.platform, spawnProcess = spawn, timeoutMs = 15_000 } = {}) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.unref();
      if (error) reject(error); else resolve();
    };
    // Starting xdg-open is not evidence of opening a browser. In particular an
    // SSH/service session may have no browser. Never leak the pairing URL from
    // a child's command/error output into logs or the conversation.
    const timer = setTimeout(() => finish(new Error('System browser did not confirm opening. Open Cindy Host from a connected client.')), timeoutMs);
    child.once('error', () => finish(new Error('System browser is unavailable. Open Cindy Host from a connected client.')));
    child.once('close', code => finish(code === 0 ? undefined : new Error('System browser could not open the page. Open Cindy Host from a connected client.')));
  });
}

/** Pair only with this profile's live instance. The one-use browser code stays
 * out of stdout, disk, query parameters and the referrer header. */
export async function openHostBrowser(profile, open = openSystemBrowser) {
  const state = await readHostProcessStatus(profile);
  if (state.running !== true) throw new Error('Start Cindy Host first using the same data directory');
  const endpoint = readHostEndpoint(profile);
  if (!endpoint || endpoint.instanceId !== state.instanceId) throw new Error('Cindy Host restarted; retry opening the browser');
  const token = fs.readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim();
  const response = await fetch(`${endpoint.baseUrl}/web/pair`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Host did not authorize the browser connection');
  const { code } = await response.json();
  if (typeof code !== 'string' || !code) throw new Error('Host returned an invalid pairing response');
  await open(`${endpoint.baseUrl}/connect#pair=${encodeURIComponent(code)}`);
}
