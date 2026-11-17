import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('AGENT_NET_IOS_BUILD_REQUIRES_MAC');
const root = path.dirname(fileURLToPath(import.meta.url)), core = path.resolve(root, '../agent-net-core');
const dist = path.join(root, 'dist'), framework = path.join(dist, 'CindyAgentNetNative.xcframework');
const hash = createHash('sha256');
function include(base, entry) {
  const absolute = path.join(base, entry);
  if (readdirSync(path.dirname(absolute), { withFileTypes: true }).find(e => e.name === path.basename(absolute))?.isDirectory()) {
    for (const name of readdirSync(absolute).sort()) include(base, path.join(entry, name));
  } else { hash.update(entry); hash.update(readFileSync(absolute)); }
}
for (const entry of ['Cargo.toml', 'Cargo.lock', 'src', 'include', 'build-ios.mjs']) include(root, entry);
for (const entry of ['Cargo.toml', 'src']) include(core, entry);
const simulator = process.arch === 'arm64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';
hash.update(simulator);
const digest = hash.digest('hex'), receipt = path.join(dist, 'ios-source-sha256');
if (existsSync(receipt) && existsSync(framework) && readFileSync(receipt, 'utf8').trim() === digest) {
  console.log('Agent-Net iOS framework matches current Rust source.'); process.exit(0);
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: {
    ...process.env, CARGO_TARGET_DIR: path.join(root, 'target'), IPHONEOS_DEPLOYMENT_TARGET: '16.4',
  } });
  if (result.error || result.status !== 0) throw new Error('AGENT_NET_NATIVE_BUILD_FAILED: ' + command);
}
const cargo = process.env.CARGO || 'cargo';
for (const target of ['aarch64-apple-ios', simulator]) {
  run(cargo, ['build', '--release', '--locked', '--lib', '--target', target]);
}
mkdirSync(dist, { recursive: true });
const temporary = path.join(dist, 'CindyAgentNetNative-' + process.pid + '.xcframework');
if (existsSync(temporary)) throw new Error('AGENT_NET_BUILD_OUTPUT_ALREADY_EXISTS');
run('xcodebuild', ['-create-xcframework',
  '-library', path.join(root, 'target/aarch64-apple-ios/release/libcindy_agent_net_native.a'), '-headers', path.join(root, 'include'),
  '-library', path.join(root, 'target', simulator, 'release/libcindy_agent_net_native.a'), '-headers', path.join(root, 'include'),
  '-output', temporary]);
const previous = path.join(dist, 'CindyAgentNetNative-previous-' + process.pid + '.xcframework');
if (existsSync(framework)) renameSync(framework, previous);
renameSync(temporary, framework);
writeFileSync(receipt, digest + '\n');
// Only the generated predecessor in this package's dist directory is removed.
if (path.dirname(previous) !== dist || !path.basename(previous).startsWith('CindyAgentNetNative-previous-')) throw new Error('UNSAFE_NATIVE_OUTPUT');
rmSync(previous, { recursive: true, force: true });
console.log('Agent-Net device and simulator framework built from current source.');
