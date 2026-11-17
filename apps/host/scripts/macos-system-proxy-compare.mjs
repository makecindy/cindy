#!/usr/bin/env node
// macOS system proxy comparison (release table row 28, 28b; .github/workflows/macos-system-proxy-compare.yml).
//
// THIS SCRIPT CHANGES THE MACHINE'S SYSTEM PROXY SETTINGS (networksetup, with sudo). It runs only on a
// GitHub-hosted macOS runner, which is thrown away afterwards; it refuses to start anywhere else. Never
// run it on a development machine or on your own computer.
//
// For each group of settings it sets them on every network service, then compares, URL by URL, the
// Host's result (src/macos-system-proxy.ts, reading the live settings through /usr/sbin/scutil --proxy)
// with Electron's session.defaultSession.resolveProxy (the repository's Electron, as the desktop asks it).
// It saves each group's scutil output as a sample (the runner holds no real settings or credentials; the
// authenticated group uses a fixture user and password), writes a report, and restores the settings.
//
// With PAC or auto-discovery the Host asks its Chromium proxy helper (28c, src/chromium-proxy.ts), started here
// exactly as in production (no test switch), so those groups must agree too. Expected difference: with an
// authenticated proxy the Host reports unresolved every URL Electron sends through that proxy.
// Afterwards (28c, reviewer 2026-11-18): the keychain must hold no "Cindy Proxy Safe Storage" item, i.e. the helper,
// started the production way and asked under a PAC URL, did not set up Chromium's Safe Storage.
//
// usage (on the runner, from apps/host):
//   node --import tsx --import ./src/loaders/register-raw.mjs scripts/macos-system-proxy-compare.mjs <out-dir>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createChromiumProxyHelper } from '../src/chromium-proxy.ts';
import { createMacSystemProxySession, readScutilProxyOutput } from '../src/macos-system-proxy.ts';

if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.CINDY_SYSTEM_PROXY_COMPARE !== '1') {
  console.error('Refusing to run: this script changes the system proxy settings and runs only in the macOS '
    + 'system proxy comparison workflow on a GitHub-hosted runner.');
  process.exit(2);
}

const outDir = path.resolve(process.argv[2] ?? 'system-proxy-compare');
fs.mkdirSync(outDir, { recursive: true });
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRequire = createRequire(path.join(scriptsDir, '../../desktop/package.json'));
const electronDir = path.dirname(desktopRequire.resolve('electron/package.json'));
const electronBinary = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());

const URLS = [
  'http://api.example.test/', 'https://api.example.test/', 'wss://api.example.test/',
  'https://example.com/', 'http://example.com/', 'https://www.example.com/', 'https://example.com:8443/',
  'https://exmple.com/', 'https://exaample.com/', 'https://a.example.com/',
  'https://intranet/', 'https://intranet.corp/', 'https://printer.local/',
  'https://localhost/', 'https://foo.localhost/', 'https://127.0.0.5/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
  'https://169.254.1.1/', 'https://169.0.3.4/', 'https://169.1.0.1/', 'https://[fe80::1]/', 'https://0.0.0.0/',
  'https://10.1.2.3/', 'https://10.9.9.9/', 'https://[fd12::1]/',
];

function networksetup(...args) {
  execFileSync('/usr/bin/sudo', ['-n', '/usr/sbin/networksetup', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const services = execFileSync('/usr/sbin/networksetup', ['-listallnetworkservices'], { encoding: 'utf8' })
  .split('\n').slice(1).map(line => line.replace(/^\*/, '').trim()).filter(Boolean);
if (services.length === 0) throw new Error('no network services');

function resetSettings() {
  for (const service of services) {
    for (const flag of ['-setwebproxystate', '-setsecurewebproxystate', '-setsocksfirewallproxystate', '-setautoproxystate', '-setproxyautodiscovery']) {
      networksetup(flag, service, 'off');
    }
    networksetup('-setproxybypassdomains', service, 'Empty');
  }
}

const pacServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
  res.end('function FindProxyForURL(url, host) { return "PROXY 10.9.9.9:8080"; }\n');
});
await new Promise(resolve => pacServer.listen(0, '127.0.0.1', resolve));
const pacUrl = `http://127.0.0.1:${pacServer.address().port}/proxy.pac`;

const HTTP = ['-setwebproxy', '10.0.0.1', '3128'];
const HTTPS = ['-setsecurewebproxy', '10.0.0.2', '3129'];
const SOCKS = ['-setsocksfirewallproxy', '10.0.0.3', '1081'];
const GROUPS = [
  { name: 'none', settings: [] },
  { name: 'http', settings: [HTTP] },
  { name: 'https', settings: [HTTPS] },
  { name: 'socks', settings: [SOCKS] },
  { name: 'http-socks', settings: [HTTP, SOCKS] },
  { name: 'https-socks', settings: [HTTPS, SOCKS] },
  { name: 'all', settings: [HTTP, HTTPS, SOCKS] },
  { name: 'exceptions', settings: [HTTP, HTTPS, ['-setproxybypassdomains', '*.local', '169.254/16', 'example.com:8443',
    '10.0.0.0/8', 'ex?mple.com', 'https://www.example.com', 'a.example.com, b.example.com', 'fd00::/8']] },
  { name: 'subtract-implicit', settings: [HTTP, HTTPS, ['-setproxybypassdomains', '<-loopback>']] },
  { name: 'auto-discovery', settings: [HTTPS, ['-setproxyautodiscovery', 'on']] },
  { name: 'pac', settings: [HTTPS, ['-setautoproxyurl', pacUrl]] },
  // Only the HTTPS proxy names a user: what Electron sends through it the Host leaves unresolved, the rest agrees.
  { name: 'authenticated', expect: 'auth', authenticatedProxy: 'PROXY 10.0.0.2:3129',
    settings: [['-setsecurewebproxy', '10.0.0.2', '3129', 'on', 'ci-proxy-user', 'ci-proxy-pass'], HTTP] },
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
    resetSettings();
    for (const service of services) for (const [flag, ...args] of group.settings) networksetup(flag, service, ...args);
    // configd publishes the new dictionary asynchronously.
    await new Promise(resolve => setTimeout(resolve, 2000));
    const sample = await readScutilProxyOutput();
    fs.writeFileSync(path.join(outDir, `scutil-${group.name}.txt`), sample);
    // A new helper per group, started the production way (default launcher and assets, no test switch).
    const helper = createChromiumProxyHelper({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-proxy-compare-helper-')) });
    const session = createMacSystemProxySession(async () => sample, helper);
    const electron = electronResults();
    for (const url of URLS) {
      let host;
      for (let attempt = 0; ; attempt++) {
        try {
          host = await session.resolveProxy(url);
          break;
        } catch (error) {
          host = `ERROR: ${error.message}`;
          // The helper may still be starting (each answer waits at most 1.8 s): ask again for up to 20 s.
          if (helper.state() !== 'starting' || attempt >= 20) break;
        }
      }
      const chromium = electron[url];
      const hostFailed = host.startsWith('ERROR: ');
      const ok = group.expect === 'auth' ? (chromium === group.authenticatedProxy ? hostFailed : host === chromium)
        : host === chromium;
      if (!ok) mismatches += 1;
      report.push({ group: group.name, url, chromium, host, ok });
    }
    await helper.close();
  }
} finally {
  resetSettings();
  pacServer.close();
}

// The helper ran the production way under a PAC URL above: Chromium must not have created its Safe Storage item.
const keychain = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Cindy Proxy Safe Storage'], { encoding: 'utf8' });
const safeStorageCreated = keychain.status === 0;
report.push({ group: 'keychain', url: 'Cindy Proxy Safe Storage', chromium: '-', host: safeStorageCreated ? 'present' : 'absent', ok: !safeStorageCreated });
if (safeStorageCreated) mismatches += 1;

fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const table = ['| group | url | Chromium | Host | |', '|---|---|---|---|---|',
  ...report.map(row => `| ${row.group} | ${row.url} | ${row.chromium} | ${row.host} | ${row.ok ? 'ok' : 'MISMATCH'} |`)].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), `${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## macOS system proxy comparison\n\n${table}\n`);
console.log(table);
console.log(mismatches === 0 ? 'All results agree.' : `${mismatches} result(s) differ.`);
process.exitCode = mismatches === 0 ? 0 : 1;
