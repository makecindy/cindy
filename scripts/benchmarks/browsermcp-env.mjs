/**
 * Isolated BrowserMCP (https://github.com/jackwener/browsermcp) environment for the B variant of
 * scripts/eval-browser-tasks.mjs. Writes nothing outside `dir`: a temporary HOME for its host,
 * a fresh Chrome for Testing profile with the unpacked extension, and a Native Messaging manifest
 * inside that profile (Chrome reads user-level hosts relative to --user-data-dir). It never runs
 * `browsermcp setup`, which also registers itself with every running Chromium profile it finds.
 *
 *   BROWSERMCP_DIR     a built checkout (npm install builds dist/ and extension/dist/)
 *   BROWSERMCP_CHROME  a Chrome for Testing / Chromium binary that still accepts --load-extension
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXTENSION_ID = 'lnaoghmfcdnbhgcihkakfobckmfhllkg';

export async function startBrowserMcpEnv(dir) {
  const checkout = process.env.BROWSERMCP_DIR;
  const chromePath = process.env.BROWSERMCP_CHROME;
  if (!checkout || !chromePath) throw new Error('Variant B needs BROWSERMCP_DIR and BROWSERMCP_CHROME');
  const home = path.join(dir, 'home');
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
  const entry = path.join(checkout, 'dist/src/main.js');
  const launcher = path.join(dir, 'launcher.sh');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(launcher, `#!/bin/sh
export HOME=${quote(home)}
if [ "\${1-}" = stdio ]; then exec ${quote(process.execPath)} ${quote(entry)} "$@"; fi
exec ${quote(process.execPath)} ${quote(entry)} host "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', 'com.browsermcp.host.json'), JSON.stringify({
    name: 'com.browsermcp.host', description: 'BrowserMCP (benchmark, isolated)', path: launcher, type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }));
  const extension = path.join(checkout, 'extension/dist');
  // --use-mock-keychain: with a temporary HOME, Chrome cannot find the login keychain and asks the
  // person at the screen to reset it.
  const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--use-mock-keychain',
    '--password-store=basic', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: home } });
  process.once('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } });
  let chromeErr = '';
  chrome.stderr.on('data', (chunk) => { chromeErr = (chromeErr + chunk).slice(-4000); });
  // The host writes a discovery record once the extension has connected.
  const run = path.join(home, '.browsermcp', 'run');
  const connected = () => fs.existsSync(run) && fs.readdirSync(run).some((file) => file.endsWith('.json'));
  const deadline = Date.now() + 30_000;
  while (!connected() && Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chromeErr.slice(-1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!connected()) {
    chrome.kill('SIGKILL');
    throw new Error(`BrowserMCP host never connected: ${chromeErr.slice(-1500)}`);
  }
  return {
    mcpServer: { command: launcher, args: ['stdio'] },
    stop: async () => {
      chrome.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
  };
}
