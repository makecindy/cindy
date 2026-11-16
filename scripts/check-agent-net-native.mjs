// Real C ABI gate: a missing host library/Python must fail, never silently skip
// the native interoperability suite. App builds remain separate native gates.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'packages/agent-net-native');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`AGENT_NET_NATIVE_GATE_FAILED: ${command} ${args[0]}`);
}
const version = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const host = /^host: (.+)$/m.exec(version.stdout ?? '')?.[1];
if (!host || version.status !== 0) throw new Error('AGENT_NET_NATIVE_REQUIRES_RUST');
const env = { ...process.env, CARGO_TARGET_DIR: path.join(native, 'target') };
for (const action of ['test', 'build']) run('cargo', [action, '--locked', '--target', host, '--manifest-path', path.join(native, 'Cargo.toml')], { env });
const filename = process.platform === 'win32' ? 'cindy_agent_net_native.dll'
  : process.platform === 'darwin' ? 'libcindy_agent_net_native.dylib' : 'libcindy_agent_net_native.so';
const library = path.join(native, 'target', host, 'debug', filename);
if (!existsSync(library)) throw new Error('AGENT_NET_NATIVE_LIBRARY_MISSING');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
run(python, ['--version']);
const pnpm = (args, extraEnv = env) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], { env: extraEnv })
  : run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { env: extraEnv, shell: process.platform === 'win32' });
pnpm(['--filter', '@cindy/agent-net', 'prepare-core']);
// Match the integration tier: real native processes and transport timers run
// in one worker, rather than competing with another socket suite in this gate.
pnpm(['--filter', '@cindy/agent-net', 'exec', 'vitest', 'run', '--pool=forks', '--maxWorkers=1'], {
  ...env, CINDY_AGENT_NET_NATIVE_LIBRARY: library, PYTHON: python,
});
