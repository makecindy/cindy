import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function downloadPinnedAssets(pins, root, cache, download = (url, file) => {
  execFileSync('curl', ['--fail', '--location', '--http1.1', '--retry', '5',
    '--retry-all-errors', '--connect-timeout', '20', '--max-time', '900',
    '--speed-limit', '1024', '--speed-time', '45', '--proto', '=https',
    '--proto-redir', '=https', '--output', file, url], { stdio: 'inherit' });
}) {
  fs.mkdirSync(cache, { recursive: true });
  for (const [name, url, sha] of pins) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !url.startsWith('https://') || !/^[0-9a-f]{64}$/.test(sha))
      throw Error('INVALID_ASSET_PIN');
    const cached = path.join(cache, sha), temporary = cached + '.partial';
    if (!fs.existsSync(cached) || hash(cached) !== sha) {
      // Never promote partial downloads or trust an existing cache entry by name.
      fs.rmSync(cached, { force: true });
      fs.rmSync(temporary, { force: true });
      try {
        download(url, temporary);
        if (hash(temporary) !== sha) throw Error(`ASSET_CHECKSUM:${name}`);
        fs.renameSync(temporary, cached);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    fs.copyFileSync(cached, path.join(root, name));
    if (hash(path.join(root, name)) !== sha) throw Error(`ASSET_CHECKSUM:${name}`);
  }
}

function main() {
// Electron and ripgrep must match the application's own versions; the agents use its pins.
const pins = [
  ['electron-v42.11.12-linux-x64.zip', 'https://github.com/electron/electron/releases/download/v42.11.12/electron-v42.11.12-linux-x64.zip', '1f17c115389c6395ce4b19b29ee2ec4be2208257514d61e269f1c0a7323bd45d'],
  ['electron-v42.11.12-headers.tar.gz', 'https://artifacts.electronjs.org/headers/dist/v42.11.12/node-v42.11.12-headers.tar.gz', '8794961c57530942cbad83da5264f3e6076d7ef9920bddfa9c584353bb90ab2a'],
  ['ripgrep-linux-x64.tar.gz', 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz', '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599'],
];
for (const [kind, name] of [['codex-package', 'codex-package'], ['pi', 'pi']]) {
  const asset = JSON.parse(fs.readFileSync(`/workspace/source/tools/${kind}/latest.json`)).runtimeAssets['linux-x64'];
  pins.push([`${name}-linux-x64.tar.gz`, asset.url, asset.sha256]);
}
downloadPinnedAssets(pins, '/workspace', '/var/cache/cindy-build-assets');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
