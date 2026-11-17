import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
// Ordinary app builds use the exact source-matched artifact, without requiring a Rust toolchain.
// Core changes explicitly refresh it; a stale/missing artifact never silently ships older code.
const sources = [];
function visit(relative) {
  const absolute = join(root, relative);
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = relative + '/' + entry.name;
    if (entry.isDirectory()) visit(file);
    else sources.push([file, readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n')]);
  }
}
visit('src'); visit('wasm/src');
for (const file of ['Cargo.toml', 'Cargo.lock', 'wasm/Cargo.toml']) sources.push([file, readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n')]);
const sourceDigest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const prebuilt = join(root, 'prebuilt', 'core.wasm');
const manifest = join(root, 'prebuilt', 'manifest.json');
const refresh = process.argv.includes('--refresh-prebuilt');
if (!refresh) {
  const receipt = JSON.parse(readFileSync(manifest, 'utf8'));
  if (receipt.version !== 1 || receipt.sourceDigest !== sourceDigest || receipt.binaryDigest !== digest(prebuilt)) {
    throw new Error('AGENT_NET_PREBUILT_STALE: run node packages/agent-net-core/build.mjs --refresh-prebuilt');
  }
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(prebuilt, join(root, 'dist/core.wasm'));
} else {
const built = spawnSync('cargo', ['build', '-p', 'agent-net-wasm', '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', 'target'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (built.error) throw new Error('AGENT_NET_RUST_BUILD_UNAVAILABLE', { cause: built.error });
if (built.status !== 0) process.exit(built.status ?? 1);
mkdirSync(join(root, 'prebuilt'), { recursive: true });
copyFileSync(join(root, 'target/wasm32-unknown-unknown/release/agent_net_wasm.wasm'), prebuilt);
writeFileSync(manifest, JSON.stringify({ version: 1, sourceDigest, binaryDigest: digest(prebuilt) }, null, 2) + '\n');
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(prebuilt, join(root, 'dist/core.wasm'));
}
