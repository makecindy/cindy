// Windows system proxy comparison (release table row 28, 28c; .github/workflows/macos-system-proxy-compare.yml).
//
// THIS SCRIPT CHANGES THE MACHINE'S PROXY SETTINGS (the current user's Internet Settings in the registry). It runs
// only on a GitHub-hosted Windows runner, which is thrown away afterwards; it refuses to start anywhere else. Never
// run it on a development machine or on your own computer.
//
// For each group of settings it writes them, then compares, URL by URL, the Host's answer (its Chromium proxy
// helper, src/chromium-proxy.ts, started exactly as in production: no test switch) with Electron's
// session.defaultSession.resolveProxy (the repository's Electron, as the desktop asks it). Both are Chromium, so
// every group must agree; the manual group must also show a proxy, or the settings did not apply and the comparison
// would prove nothing. Auto-discovery (WPAD) is not set here: Windows keeps it in a binary connection blob.
// It restores the settings it found and writes a report.
//
// usage (on the runner, from apps/host):
//   node --import tsx --import ./src/loaders/register-raw.mjs scripts/windows-system-proxy-compare.mjs <out-dir>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createChromiumProxyHelper } from '../src/chromium-proxy.ts';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.CINDY_SYSTEM_PROXY_COMPARE !== '1') {
  console.error('Refusing to run: this script changes the proxy settings and runs only in the system proxy comparison '
    + 'workflow on a GitHub-hosted Windows runner.');
  process.exit(2);
}

const outDir = path.resolve(process.argv[2] ?? 'system-proxy-compare');
fs.mkdirSync(outDir, { recursive: true });
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const electronBinary = createRequire(path.join(scriptsDir, '../../desktop/package.json'))('electron');
const REG = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const VALUES = { ProxyEnable: 'REG_DWORD', ProxyServer: 'REG_SZ', ProxyOverride: 'REG_SZ', AutoConfigURL: 'REG_SZ' };

const URLS = [
  'http://api.example.test/', 'https://api.example.test/', 'wss://api.example.test/',
  'https://example.com/', 'http://example.com/', 'https://www.example.com/', 'https://a.example.com/',
  'https://intranet/', 'https://localhost/', 'https://127.0.0.5/', 'https://10.1.2.3/', 'https://[::1]/',
];

function readValue(name) {
  const result = spawnSync(REG, ['query', KEY, '/v', name], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const line = result.stdout.split(/\r?\n/).find(row => row.trim().startsWith(name));
  return line ? line.trim().split(/\s{2,}/).slice(2).join('  ') : null;
}
function writeValue(name, value) {
  if (value === null) spawnSync(REG, ['delete', KEY, '/v', name, '/f'], { stdio: 'ignore' });
  else execFileSync(REG, ['add', KEY, '/v', name, '/t', VALUES[name], '/d', String(value), '/f'], { stdio: 'ignore' });
}
const original = Object.fromEntries(Object.keys(VALUES).map(name => [name, readValue(name)]));
const restore = () => { for (const [name, value] of Object.entries(original)) writeValue(name, value); };

const pacServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
  res.end('function FindProxyForURL(url, host) { if (dnsDomainIs(host, ".example.com")) return "DIRECT"; return "PROXY 10.9.9.9:8080"; }\n');
});
await new Promise(resolve => pacServer.listen(0, '127.0.0.1', resolve));
const pacUrl = `http://127.0.0.1:${pacServer.address().port}/proxy.pac`;

const GROUPS = [
  { name: 'none', values: { ProxyEnable: 0, ProxyServer: null, ProxyOverride: null, AutoConfigURL: null } },
  { name: 'manual', mustProxy: 'https://example.com/', values: { ProxyEnable: 1, ProxyServer: '10.0.0.1:3128', ProxyOverride: null, AutoConfigURL: null } },
  { name: 'per-scheme', values: { ProxyEnable: 1, ProxyServer: 'http=10.0.0.1:3128;https=10.0.0.2:3129;socks=10.0.0.3:1081', ProxyOverride: null, AutoConfigURL: null } },
  { name: 'exceptions', values: { ProxyEnable: 1, ProxyServer: '10.0.0.1:3128', ProxyOverride: '*.example.com;10.*;<local>', AutoConfigURL: null } },
  { name: 'pac', values: { ProxyEnable: 0, ProxyServer: null, ProxyOverride: null, AutoConfigURL: pacUrl } },
  { name: 'pac-and-manual', values: { ProxyEnable: 1, ProxyServer: '10.0.0.1:3128', ProxyOverride: null, AutoConfigURL: pacUrl } },
];

function electronResults() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-proxy-compare-electron-'));
  const env = { ...process.env, CINDY_COMPARE_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronBinary, [path.join(scriptsDir, 'macos-system-proxy-electron.cjs'), JSON.stringify(URLS)], {
    encoding: 'utf8', timeout: 60_000, env,
  });
  fs.rmSync(userData, { recursive: true, force: true });
  const line = (result.stdout ?? '').trim().split('\n').at(-1);
  if (result.status !== 0 || !line) throw new Error(`Electron exited ${result.status ?? result.signal}: ${result.stderr}`);
  return JSON.parse(line);
}

const report = [];
let mismatches = 0;
try {
  for (const group of GROUPS) {
    for (const [name, value] of Object.entries(group.values)) writeValue(name, value);
    const electron = electronResults();
    const helper = createChromiumProxyHelper({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-proxy-compare-helper-')) });
    for (const url of URLS) {
      let host;
      for (let attempt = 0; ; attempt++) {
        try { host = await helper.resolveProxy(url); break; } catch (error) {
          host = `ERROR: ${error.message}`;
          if (helper.state() !== 'starting' || attempt >= 20) break;
        }
      }
      const chromium = electron[url];
      const applied = !(group.mustProxy === url && !/PROXY/.test(String(chromium)));
      const ok = host === chromium && applied;
      if (!ok) mismatches += 1;
      report.push({ group: group.name, url, chromium: applied ? chromium : `${chromium} (settings not applied)`, host, ok });
    }
    await helper.close();
  }
} finally {
  restore();
  pacServer.close();
}

fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const table = ['| group | url | Chromium | Host | |', '|---|---|---|---|---|',
  ...report.map(row => `| ${row.group} | ${row.url} | ${row.chromium} | ${row.host} | ${row.ok ? 'ok' : 'MISMATCH'} |`)].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), `${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Windows system proxy comparison\n\n${table}\n`);
console.log(table);
console.log(mismatches === 0 ? 'All results agree.' : `${mismatches} result(s) differ.`);
process.exitCode = mismatches === 0 ? 0 : 1;
