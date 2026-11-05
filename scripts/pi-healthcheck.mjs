#!/usr/bin/env node
// Exercise Cindy's production PiAgent with an official binary and local fixture
// servers. No account, extension installation, or Desktop restart is needed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/pi-healthcheck.mjs [--binary /absolute/path/to/pi]\n'
    + 'Defaults to the repository Pi binary. JSON report on stdout; local test progress on stderr.\n'
    + 'Runs isolated PiAgent protocol checks, not an online model quality or speed benchmark.');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--binary' || !path.isAbsolute(args[1]))) {
  console.error('Expected --binary /absolute/path/to/pi, or --help.');
  process.exit(2);
}
const binary = args[1] ?? path.join(root, 'apps/pi-bin', `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'pi.exe' : 'pi');
const groups = [
  { name: 'fast-preferences', pattern: 'reads native Fast from host RPC' },
  { name: 'window-and-resume', pattern: 'applies configured windows on creation' },
  { name: 'wire-effort-and-timing', pattern: 'sends catalog effort' },
  { name: 'images-and-history', pattern: 'runs Grok 4.7 with all efforts, image input' },
  { name: 'image-attachment', pattern: 'forwards an image attachment through pi to the gateway' },
  { name: 'mcp-allow', pattern: 'ask \\+ allow:' },
  { name: 'mcp-deny', pattern: 'ask \\+ deny:' },
  { name: 'mcp-multiple-servers', pattern: 'executes five real tools across two MCP servers' },
  { name: 'mcp-structured-success', pattern: 'preserves MCP structured success data' },
  { name: 'mcp-structured-error', pattern: 'preserves MCP structured failure data' },
  { name: 'mcp-sse', pattern: 'persistent SSE: registers' },
  { name: 'mcp-pagination', pattern: 'paginated tools/list: follows' },
];
const started = performance.now();
let temporary;
let report = { ok: false, binary, mode: 'isolated-local-protocol', groups: [] };
try {
  if (!existsSync(binary)) throw new Error('Pi binary is missing; pass --binary pointing to the installed official runtime.');
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.error || version.status !== 0) throw new Error('Pi --version failed; verify the binary can run on this computer.');
  report.version = version.stdout.trim().slice(0, 120);
  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) throw new Error('Repository test dependencies are missing; install them before running the health check.');
  temporary = mkdtempSync(path.join(tmpdir(), 'cindy-pi-health-'));
  const home = path.join(temporary, 'home');
  mkdirSync(home);
  const output = path.join(temporary, 'results.json');
  const run = spawnSync(process.execPath, [vitest, 'run',
    'src/agents/pi/__tests__/pi-agent.integration.test.ts',
    'src/agents/pi/__tests__/pi-mcp-bridge.integration.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '-t', groups.map(group => group.pattern).join('|'),
    '--reporter=json', '--outputFile', output,
  ], {
    cwd: path.join(root, 'packages/maker-core'), encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
      CINDY_TEST_PI_BINARY: binary, CINDY_PI_MCP_TEST_BINARY: binary },
  });
  if (run.stdout) process.stderr.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) throw new Error('Health check process failed or exceeded 180 seconds; inspect the test output.');
  if (!existsSync(output)) throw new Error('Test report is missing; health could not be verified.');
  const results = JSON.parse(readFileSync(output, 'utf8'));
  const assertions = results.testResults.flatMap(file => file.assertionResults);
  for (const test of assertions.filter(test => test.status === 'failed')) {
    console.error(test.fullName + '\n' + (test.failureMessages ?? []).join('\n').slice(0, 2000));
  }
  report.groups = groups.map(group => {
    const selected = assertions.filter(test => new RegExp(group.pattern).test(test.fullName));
    return { name: group.name, passed: selected.filter(test => test.status === 'passed').length,
      total: selected.length, ok: selected.length > 0 && selected.every(test => test.status === 'passed') };
  });
  report.ok = run.status === 0 && results.success === true && report.groups.every(group => group.ok);
  if (!report.ok) report.error = 'At least one required check failed, was skipped, or was not discovered. See group results and stderr.';
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Health check failed.';
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
report.elapsedMs = Math.round(performance.now() - started);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
