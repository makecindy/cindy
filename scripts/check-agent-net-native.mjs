// Real C ABI gate: a missing host library/Python must fail, never silently skip
// the native interoperability suite. App builds remain separate native gates.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'packages/agent-net-native');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`AGENT_NET_NATIVE_GATE_FAILED: ${command} ${args[0]}${result.error ? ` (${result.error.message})` : ''}`);
}
const version = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const host = /^host: (.+)$/m.exec(version.stdout ?? '')?.[1];
if (!host || version.status !== 0) throw new Error('AGENT_NET_NATIVE_REQUIRES_RUST');
const env = { ...process.env, CARGO_TARGET_DIR: path.join(native, 'target') };
for (const action of ['test', 'build']) await runBounded('cargo', [action, '--locked', '--target', host, '--manifest-path', path.join(native, 'Cargo.toml')], { env }, 8 * 60_000);
const filename = process.platform === 'win32' ? 'cindy_agent_net_native.dll'
  : process.platform === 'darwin' ? 'libcindy_agent_net_native.dylib' : 'libcindy_agent_net_native.so';
const library = path.join(native, 'target', host, 'debug', filename);
if (!existsSync(library)) throw new Error('AGENT_NET_NATIVE_LIBRARY_MISSING');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
run(python, ['--version']);
const pnpm = (args, extraEnv = env, options = {}) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], { env: extraEnv, ...options })
  : run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { env: extraEnv, shell: process.platform === 'win32', ...options });
pnpm(['--filter', '@cindy/agent-net', 'prepare-core']);

/**
 * The test run, bounded by this script rather than by CI: its output goes to a file (a process left behind cannot hold the job's
 * output open), it is killed with everything it started when it runs past `limitMs`, and the tail of its output, with what was
 * still running, is printed either way. A job cancelled at its own limit keeps no log of the running step.
 */
async function runBounded(command, args, options, limitMs) {
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'agent-net-native-')), 'output.txt');
  const out = openSync(log, 'w');
  const started = Date.now();
  const child = spawn(command, args, { cwd: root, ...options, stdio: ['ignore', out, out], detached: process.platform !== 'win32' });
  closeSync(out);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.log(`AGENT_NET_NATIVE_GATE: still running after ${limitMs / 60_000} minutes; processes now:`);
    console.log(processes());
    killTree(child.pid);
  }, limitMs);
  const status = await new Promise(resolve => { child.on('exit', code => resolve(code)); child.on('error', () => resolve(-1)); });
  clearTimeout(timer);
  if (process.platform !== 'win32') killTree(child.pid); // anything it left behind
  const lines = readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  console.log(lines.slice(-400).map(line => line.length > 400 ? line.slice(0, 400) + ` …(${line.length} chars)` : line).join('\n'));
  console.log(`AGENT_NET_NATIVE_GATE: ${command} finished in ${Math.round((Date.now() - started) / 1000)} s, status ${status}, ${lines.length} lines of output`);
  if (timedOut || status !== 0) throw new Error(`AGENT_NET_NATIVE_GATE_FAILED: ${command} ${args[0]} ${timedOut ? 'timed out' : 'failed'}`);
}
function processes() {
  const listed = process.platform === 'win32'
    ? spawnSync('tasklist', ['/v', '/fo', 'csv'], { encoding: 'utf8' })
    : spawnSync('ps', ['-eo', 'pid,ppid,pgid,stat,pcpu,rss,etime,args'], { encoding: 'utf8' });
  return (listed.stdout ?? '').split('\n').filter(line => !/^\s*$/.test(line)).map(line => line.slice(0, 300)).slice(0, 200).join('\n');
}
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

// Match the integration tier: real native processes and transport timers run
// in one worker, rather than competing with another socket suite in this gate.
const vitest = ['--filter', '@cindy/agent-net', 'exec', 'vitest', 'run', '--pool=forks', '--maxWorkers=1', '--reporter=verbose'];
const testEnv = { ...env, CINDY_AGENT_NET_NATIVE_LIBRARY: library, PYTHON: python };
await (process.env.npm_execpath
  ? runBounded(process.execPath, [process.env.npm_execpath, ...vitest], { env: testEnv }, 10 * 60_000)
  : runBounded(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', vitest, { env: testEnv, shell: process.platform === 'win32' }, 10 * 60_000));
