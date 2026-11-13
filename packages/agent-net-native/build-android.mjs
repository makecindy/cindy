import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const supported = new Set(['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']);
const targets = (process.env.CINDY_AGENT_NET_ANDROID_ABIS || 'armeabi-v7a,arm64-v8a,x86,x86_64').split(',');
if (!targets.length || targets.some(abi => !supported.has(abi))) throw new Error('AGENT_NET_INVALID_ANDROID_ABI');
const args = ['ndk', '--platform', '24', ...targets.flatMap(abi => ['-t', abi]),
  '-o', path.join(root, 'dist/android'), 'build', '--locked', '--release', '--lib'];
const result = spawnSync(process.env.CARGO || 'cargo', args, { cwd: root, stdio: 'inherit', env: process.env });
if (result.error || result.status !== 0) throw new Error('AGENT_NET_ANDROID_BUILD_FAILED: requires cargo-ndk, selected Rust targets and Android NDK');
