/**
 * Regression tests for the macOS update-apply script (PR #777 review ask).
 *
 * Two layers:
 *  1. Pure/structural tests (all platforms): ERE escaping, generated-script
 *     structure (SIGKILL-then-abort ordering, gated open retry), and a
 *     `bash -n` syntax check of the real rendered artifact.
 *  2. Behavioral tests (darwin only): render the REAL script with compressed
 *     timings and run it under /bin/bash against real processes — a hung
 *     "app" PID that must be SIGKILL'd, a Frameworks helper that must be
 *     cleared before the bundle swap, and both process-verification outcomes
 *     (`open` is PATH-stubbed so no real GUI launch).
 *
 * Deliberately NOT automated: the exitAbortAfterSeconds branch (PID that
 * survives SIGKILL). Simulating an unkillable process requires root or an
 * uninterruptible-state zombie, neither of which a unit test can create.
 * The branch is covered structurally below (ordering + exit 1), and manually:
 * `kill -STOP` the app mid-update, watch cindy-update.log escalate at
 * exitKillAfterSeconds, then verify a `kill -9`-immune PID (e.g. pid owned
 * by another user) logs FATAL and leaves the old bundle intact.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMacOSUpdateScript,
  escapeEre,
  DEFAULT_MAC_UPDATE_SCRIPT_TIMINGS,
  type MacUpdateScriptParams,
} from '../updateScriptMacOS';
import { MACOS_UPDATE_RELAUNCH_ARG } from '../updateRelaunchSafety';

const isDarwin = process.platform === 'darwin';

function canInspectProcessesWithPgrep(): boolean {
  if (!isDarwin) return false;
  try {
    execFileSync('/usr/bin/pgrep', ['-f', `cindy-pgrep-capability-${process.pid}`], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // status 1 = pgrep 正常工作、只是没有匹配；status 3 = 当前沙箱/系统无法读取进程表。
    return (err as { status?: number }).status === 1;
  }
}

const canRunMacProcessBehavior = canInspectProcessesWithPgrep();

function makeParams(overrides: Partial<MacUpdateScriptParams> = {}): MacUpdateScriptParams {
  return {
    pid: 12345,
    appPath: '/Applications/xdt-maker.app',
    appName: 'xdt-maker',
    extractDir: '/tmp/xdt-maker-update-1',
    zipPath: '/tmp/xdt-maker-0.0.0-arm64.zip',
    lockFilePath: '/tmp/xdt-update.lock',
    scriptPath: '/tmp/xdt-maker-update-1.sh',
    logPath: '/tmp/cindy-update.log',
    ...overrides,
  };
}

describe('escapeEre', () => {
  it('escapes ERE metacharacters so bundle paths match literally', () => {
    expect(escapeEre('/Applications/xdt-maker.app/')).toBe('/Applications/xdt-maker\\.app/');
    expect(escapeEre('/tmp/fake (2).app/')).toBe('/tmp/fake \\(2\\)\\.app/');
    expect(escapeEre('a[b]c+d^e$f|g*h?i{j}k\\l')).toBe(
      'a\\[b\\]c\\+d\\^e\\$f\\|g\\*h\\?i\\{j\\}k\\\\l',
    );
  });

  it('leaves plain paths untouched', () => {
    expect(escapeEre('/Applications/plain/')).toBe('/Applications/plain/');
  });
});

describe('buildMacOSUpdateScript structure', () => {
  const script = buildMacOSUpdateScript(makeParams());

  it('uses ERE-escaped patterns for every pgrep call site', () => {
    const pgrepLines = script.split('\n').filter((l) => l.includes('pgrep -f'));
    expect(pgrepLines.length).toBeGreaterThanOrEqual(4);
    for (const line of pgrepLines) {
      expect(line).toContain('xdt-maker\\.app');
      expect(line).not.toMatch(/pgrep -f "[^"]*[^\\]\.app/);
    }
  });

  it('clear-out matches the whole bundle, verification only the main binary', () => {
    const clearOut = script.slice(0, script.indexOf('Removing old app'));
    const verify = script.slice(script.indexOf('VERIFIED=0'));
    expect(clearOut).toContain('pgrep -f "/Applications/xdt-maker\\.app/"');
    expect(clearOut).not.toContain('pgrep -f "/Applications/xdt-maker\\.app/Contents/MacOS/"');
    expect(verify).toContain('pgrep -f "/Applications/xdt-maker\\.app/Contents/MacOS/"');
  });

  it('escalates SIGKILL at exitKillAfterSeconds and aborts (exit 1) at exitAbortAfterSeconds', () => {
    const t = DEFAULT_MAC_UPDATE_SCRIPT_TIMINGS;
    const killIdx = script.indexOf(`-eq ${t.exitKillAfterSeconds} `);
    const abortIdx = script.indexOf(`-ge ${t.exitAbortAfterSeconds} `);
    expect(killIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(killIdx);
    const abortBlock = script.slice(abortIdx, script.indexOf('done', abortIdx));
    expect(abortBlock).toContain('exit 1');
    expect(script.slice(killIdx, abortIdx)).toContain('kill -9 12345');
  });

  it('final SIGKILL sweep sits directly before the swap with no sleep between', () => {
    const sweepIdx = script.indexOf('SIGKILL stragglers just before swap');
    const rmIdx = script.indexOf('rm -rf "/Applications/xdt-maker.app"');
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(sweepIdx);
    expect(script.slice(sweepIdx, rmIdx)).not.toContain('sleep');
  });

  it('gates the open retry on the first open having failed', () => {
    expect(script).toContain('] && [ "$OPEN_EXIT" -ne 0 ]; then');
  });

  it('marks update-launched candidates so the app can recover presentation after unlock', () => {
    const openLines = script.split('\n').filter((line) => /^\s*open /.test(line));
    expect(openLines).toHaveLength(2);
    for (const line of openLines) {
      expect(line).toContain(`--args "${MACOS_UPDATE_RELAUNCH_ARG}"`);
    }
  });

  it.runIf(process.platform !== 'win32')('renders to valid bash (bash -n)', () => {
    const tmp = path.join(os.tmpdir(), `xdt-script-syntax-${process.pid}.sh`);
    fs.writeFileSync(tmp, script, { mode: 0o755 });
    try {
      execFileSync('/bin/bash', ['-n', tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

// ── Behavioral: run the real artifact against real processes ──────────────

interface Sandbox {
  root: string;
  appPath: string;
  logPath: string;
  binDir: string;
  params: MacUpdateScriptParams;
}

function shellScript(body: string): string {
  return `#!/bin/bash\n${body}\n`;
}

/**
 * Builds: an installed fake .app (with Frameworks helper), a zip containing
 * the new fake .app (whose main binary writes a marker + sleeps), and a PATH
 * stub for `open` so nothing GUI-launches. `openBehavior`:
 *   'launch'  — stub open execs the new app main binary detached (success path)
 *   'noop'    — stub open does nothing (verification-failure path)
 */
function makeSandbox(openBehavior: 'launch' | 'noop'): Sandbox {
  // macOS 把 /var 规范化成 /private/var 后写进进程命令行；生成脚本的 pgrep
  // 使用字面路径匹配，因此 fixture 也必须先取真实路径，避免测试误判 helper 不存在。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-upd-test-')));
  const appPath = path.join(root, 'Installed', 'fake (2).app');
  const helperDir = path.join(appPath, 'Contents', 'Frameworks', 'fake Helper (Renderer).app', 'Contents', 'MacOS');
  const mainDir = path.join(appPath, 'Contents', 'MacOS');
  fs.mkdirSync(helperDir, { recursive: true });
  fs.mkdirSync(mainDir, { recursive: true });
  // 保持解释器进程的 argv 中带 bundle 路径；单条 `sleep 300` 会被 bash 尾调用
  // 优化成 sleep，pgrep -f 无法再识别它来自哪个 .app。
  const persistentProcess = 'while true; do sleep 1; done';
  fs.writeFileSync(path.join(mainDir, 'fakemain'), shellScript(persistentProcess), { mode: 0o755 });
  fs.writeFileSync(
    path.join(helperDir, 'fakehelper'),
    shellScript(`trap '' TERM\n${persistentProcess}`),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(appPath, 'Contents', 'version.txt'), 'old');

  // New bundle → zip (ditto -c -k, same tool the real flow unpacks with).
  const stage = path.join(root, 'stage');
  const newApp = path.join(stage, 'fake (2).app');
  fs.mkdirSync(path.join(newApp, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(
    path.join(newApp, 'Contents', 'MacOS', 'fakemain'),
    shellScript(persistentProcess),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(newApp, 'Contents', 'version.txt'), 'new');
  const zipPath = path.join(root, 'update.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', stage, zipPath]);

  // PATH stub for `open`.
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  const openBody = openBehavior === 'launch'
    ? `nohup "$1/Contents/MacOS/fakemain" >/dev/null 2>&1 &\nexit 0`
    : 'exit 0';
  fs.writeFileSync(path.join(binDir, 'open'), shellScript(openBody), { mode: 0o755 });

  const logPath = path.join(root, 'cindy-update.log');
  const params = makeParams({
    appPath,
    appName: 'fake (2)',
    extractDir: path.join(root, 'extract'),
    zipPath,
    lockFilePath: path.join(root, 'update.lock'),
    scriptPath: path.join(root, 'update.sh'),
    logPath,
    timings: {
      exitKillAfterSeconds: 2,
      exitAbortAfterSeconds: 6,
      verifyTimeoutSeconds: 3,
      verifyRetryAtSeconds: 2,
    },
  });
  return { root, appPath, logPath, binDir, params };
}

function runScript(sb: Sandbox): Promise<void> {
  const script = buildMacOSUpdateScript(sb.params);
  fs.writeFileSync(sb.params.scriptPath, script, { mode: 0o755 });
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', [sb.params.scriptPath], {
      env: { ...process.env, PATH: `${sb.binDir}:${process.env.PATH}` },
      timeout: 60_000,
    }, (err) => (err && err.killed ? reject(err) : resolve()));
  });
}

function spawnDetached(cmd: string, args: string[] = []): number {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  if (child.pid === undefined) throw new Error('spawn failed');
  return child.pid;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.runIf(canRunMacProcessBehavior)('generated script behavior (darwin)', () => {
  it('SIGKILLs a hung app PID, clears a surviving Frameworks helper, swaps and verifies', async () => {
    const sb = makeSandbox('launch');
    try {
      // Hung "app": ignores nothing, just never exits on its own — the
      // script must escalate to SIGKILL at exitKillAfterSeconds.
      const hungPid = spawnDetached('/bin/sleep', ['300']);
      // Helper still running from the old bundle (outlives the main PID).
      const helperPid = spawnDetached(
        path.join(sb.appPath, 'Contents', 'Frameworks', 'fake Helper (Renderer).app', 'Contents', 'MacOS', 'fakehelper'),
      );
      sb.params.pid = hungPid;

      await runScript(sb);
      const log = fs.readFileSync(sb.logPath, 'utf8');

      expect(log).toContain('exit appears hung, sending SIGKILL');
      expect(pidAlive(hungPid)).toBe(false);
      // Helper was cleared before the swap...
      expect(log).toMatch(/terminating before swap|SIGKILL stragglers just before swap/);
      expect(pidAlive(helperPid)).toBe(false);
      // ...and the clear-out happened before "Removing old app" in the log.
      expect(log.indexOf('terminating before swap')).toBeLessThan(log.indexOf('Removing old app'));
      // Swap really happened: new bundle content in place.
      expect(fs.readFileSync(path.join(sb.appPath, 'Contents', 'version.txt'), 'utf8')).toBe('new');
      // Process verification saw the (stub-launched) new main binary.
      expect(log).toContain('PROCESS VERIFIED');
      // Lock + temp artifacts cleaned up.
      expect(fs.existsSync(sb.params.lockFilePath)).toBe(false);
      expect(fs.existsSync(sb.params.zipPath)).toBe(false);
    } finally {
      try { execFileSync('/usr/bin/pkill', ['-9', '-f', sb.root], { stdio: 'ignore' }); } catch { /* no strays left */ }
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('logs PROCESS START FAILED when the relaunched app never comes up', async () => {
    const sb = makeSandbox('noop');
    try {
      const oldPid = spawnDetached('/bin/sleep', ['1']); // exits on its own
      sb.params.pid = oldPid;

      await runScript(sb);
      const log = fs.readFileSync(sb.logPath, 'utf8');

      expect(log).toContain(`PROCESS START FAILED: fake (2) NOT running ${sb.params.timings!.verifyTimeoutSeconds}s after open`);
      expect(log).not.toContain('PROCESS VERIFIED');
      // Swap itself still succeeded — failure is about launch, not install.
      expect(fs.readFileSync(path.join(sb.appPath, 'Contents', 'version.txt'), 'utf8')).toBe('new');
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  }, 60_000);
});
