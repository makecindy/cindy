/**
 * pre-run-hook 执行器测试:exit code 协议(0 放行 / 2 跳过 / 其它 fail-closed)、
 * stdin JSON 上下文、超时拦截、输出捕获。
 * 完整真实进程矩阵只在显式 integration tier 收集；默认层保留纯函数与一条 smoke。
 * 内嵌 JS 命令使用 cmd.exe 可识别的双引号，代码内用单引号字符串；文件脚本
 * 也通过真实 Node 加载，不能用假退出码代替执行证据。
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setMainLocale } from '../../i18n';
import { prunePackagedPreRunNode, stagePreRunNode } from '../../../../forge-pre-run-node';
import { nodeRuntimeArtifact } from '../../managed-tools/nodeArtifact';
import { signPreRunNode } from '../../../../scripts/ci/pre-run-node-signing.mjs';

vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en'] } }));

// Observe only directories allocated in this test process; keep the real IO.
const ownedReceiptDirectories = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: ((...args: Parameters<typeof actual.mkdtempSync>) => {
      const directory = actual.mkdtempSync(...args);
      if (['cindy-pre-run-node-', 'cindy-pre-run-socket-'].includes(path.basename(String(args[0])))) {
        ownedReceiptDirectories.push(String(directory));
      }
      return directory;
    }) as typeof actual.mkdtempSync,
  };
});

// 透传真实 spawn,只计数:用来断言某些路径根本没有启动真实命令。
const spawnCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      spawnCalls.count += 1;
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

import {
  assertPreRunHookCommandSyntax,
  executePreRunHook as executeNativePreRunHook,
  type PreRunHookInput,
  findShellSyntaxError,
  formatPreRunHookFailure,
  type PreRunHookStdinPayload,
} from '../pre-run-hook';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pre-run-native-test-'));
const nativeSource = path.resolve(__dirname, '../../../../native/pre-run-node');
const nativeRuntime = {
  node: process.execPath,
  supervisor: path.join(fixtureRoot, process.platform === 'win32' ? 'supervisor.exe' : 'supervisor'),
  client: path.join(nativeSource, 'gate-client.cjs'),
};
const falseRuntimes = [0, 2].map(code => path.join(fixtureRoot, 'false-' + code + (process.platform === 'win32' ? '.exe' : '')));
function compile(source: string, output: string): void {
  if (process.platform === 'win32') execFileSync('cl.exe', ['/nologo', '/std:c11', '/O2', '/MT', '/Fo' + output + '.obj', '/Fe' + output, source, '/link', 'advapi32.lib']);
  else execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-pthread', source, '-o', output]);
}
beforeAll(() => {
  compile(path.join(nativeSource, 'supervisor.c'), nativeRuntime.supervisor);
  for (const code of [0, 2]) {
    const source = path.join(fixtureRoot, 'false-' + code + '.c');
    writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("CINDY_PRECHECK_OK"); return ' + code + '; }\n');
    compile(source, falseRuntimes[code === 2 ? 1 : 0]);
  }
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
function executePreRunHook(input: PreRunHookInput) {
  return executeNativePreRunHook(input, { ...nativeRuntime, node: process.execPath });
}

/** Fixtures explicitly opt into the new body protocol, never a preload.
 * The test author replaces terminal exits with the client's acknowledged exit.
 * Source without a terminal exit completes after its synchronous/awaited body. */
function writeManagedGate(file: string, source: string, options?: Parameters<typeof writeFileSync>[2]): void {
  const hasExit = source.includes('process.exit(');
  const body = source.replaceAll('process.exit(', 'void gate.exit(');
  const preamble = "const gate = (await import(process.env.CINDY_PRE_RUN_GATE_CLIENT)).default; await gate.enter();\n";
  const code = preamble + body + (hasExit ? '' : '\nawait gate.complete(0);');
  writeFileSync(file, file.endsWith('.cjs') ? '(async () => {\n' + code + '\n})();' : code, options);
}

const payload: PreRunHookStdinPayload = {
  event: 'schedule-pre-run',
  scheduleId: 's1',
  scheduleName: 'test schedule',
  runId: 'r1',
  firedAt: 1_700_000_000_000,
  workingDir: undefined,
};

// Probe the actual executable, not its major version. Supported releases
// differ in whether the stable spelling and experimental alias are exposed.
const permissionFlags = ['--permission', '--experimental-permission'] as const;
const supportedPermissionFlags = new Set<string>();
for (const flag of permissionFlags) {
  const probe = spawnSync(process.execPath, [flag, '--no-warnings', '--eval', ''], {
    encoding: 'utf8', timeout: 5_000,
  });
  if (probe.status === 0) supportedPermissionFlags.add(flag);
  else if (probe.error || probe.signal || probe.status !== 9
    || !probe.stderr.includes('bad option: ' + flag)) {
    throw new Error('Could not probe Node permission flag ' + flag + ': ' + (probe.error?.message ?? probe.stderr));
  }
}
if (supportedPermissionFlags.size === 0) throw new Error('Node supports neither permission flag; permission coverage is required');

describe('packaged pre-run assets fail closed', () => {
  it('keeps only the target across consecutive architectures, preserving source and other tools', () => {
    const source = path.join(fixtureRoot, 'tools-source');
    mkdirSync(source);
    writeFileSync(path.join(source, 'other-tool'), 'keep');
    for (const arch of ['arm64', 'x64']) {
      const artifact = nodeRuntimeArtifact('darwin', arch)!;
      const target = path.join(source, 'pre-run-node', artifact.host);
      mkdirSync(target, { recursive: true });
      for (const file of ['node', 'supervisor', 'gate-client.cjs', 'NODE-LICENSE.txt']) writeFileSync(path.join(target, file), 'asset');
      writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ host: artifact.host, version: artifact.version, archiveSha256: artifact.sha256 }));
      mkdirSync(path.join(source, 'pre-run-node', '.stale-generation'), { recursive: true });
      const resources = path.join(fixtureRoot, 'package-' + arch);
      cpSync(source, path.join(resources, 'tools'), { recursive: true });
      prunePackagedPreRunNode(resources, 'darwin', arch);
      expect(readdirSync(path.join(resources, 'tools', 'pre-run-node'))).toEqual([artifact.host]);
      expect(readFileSync(path.join(resources, 'tools', 'other-tool'), 'utf8')).toBe('keep');
      expect(readFileSync(path.join(resources, 'tools', 'pre-run-node', artifact.host, 'node'), 'utf8')).toBe('asset');
    }
    expect(readdirSync(path.join(source, 'pre-run-node')).sort()).toEqual(['.stale-generation', 'darwin-arm64', 'darwin-x64']);
  });

  it('validates the target before pruning any previous generation', () => {
    const resources = path.join(fixtureRoot, 'incomplete-package');
    const root = path.join(resources, 'tools', 'pre-run-node');
    mkdirSync(path.join(root, 'darwin-arm64'), { recursive: true });
    writeFileSync(path.join(root, 'darwin-arm64', 'previous'), 'keep');
    expect(() => prunePackagedPreRunNode(resources, 'darwin', 'x64')).toThrow(/pre-run Node/);
    expect(readFileSync(path.join(root, 'darwin-arm64', 'previous'), 'utf8')).toBe('keep');
  });

  it.skipIf(process.platform !== 'darwin')('runs a gate with the ad-hoc hardened signed Node asset', async () => {
    const tools = path.join(fixtureRoot, 'signed-tools');
    const host = path.join(tools, 'pre-run-node', 'darwin-' + process.arch);
    mkdirSync(host, { recursive: true });
    const node = path.join(host, 'node');
    copyFileSync(process.execPath, node);
    signPreRunNode(tools, process.arch);
    const entitlements = execFileSync('/usr/bin/codesign', ['--display', '--entitlements', ':-', node], { encoding: 'utf8' });
    expect(entitlements).toContain('com.apple.security.cs.allow-jit');
    for (const forbidden of ['apple-events', 'keychain-access-groups', 'audio-input', 'disable-library-validation']) expect(entitlements).not.toContain(forbidden);
    const gate = path.join(fixtureRoot, 'signed-gate.mjs');
    const marker = path.join(fixtureRoot, 'signed-gate-ran');
    writeManagedGate(gate, 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "yes"); console.log("CINDY_PRECHECK_OK");');
    const result = await executeNativePreRunHook({ command: 'xdt-node signed-gate.mjs', cwd: fixtureRoot, stdinPayload: payload }, { ...nativeRuntime, node });
    expect(result.status).toBe('passed');
    expect(result.decision).toBe('run');
    expect(result.checkSucceeded).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('yes');
  });

  it('rejects unsupported targets before preparing a runtime', async () => {
    await expect(stagePreRunNode('win32', 'arm64', { download: false })).rejects.toThrow('Unsupported packaged pre-run Node target');
  });

  it.each(['offline', 'tampered'] as const)('preserves the previous stage after %s failure', async (kind) => {
    const outputRoot = path.join(fixtureRoot, 'assets-' + kind);
    const target = path.join(outputRoot, process.platform + '-' + process.arch);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'previous'), 'verified previous generation');
    const archive = path.join(fixtureRoot, 'tampered.tar.gz');
    writeFileSync(archive, 'untrusted archive');
    await expect(stagePreRunNode(process.platform, process.arch, {
      outputRoot, download: false, ...(kind === 'tampered' ? { archive } : {}),
    })).rejects.toThrow(kind === 'tampered' ? 'SHA256 mismatch' : 'Verified Node archive required');
    expect(readFileSync(path.join(target, 'previous'), 'utf8')).toBe('verified previous generation');
  });
});

describe('executePreRunHook', () => {
  it.each([0, 1, 2])('only successful exits can attest healthy checks (exit %s)', async (exitCode) => {
    const result = await executePreRunHook({
      command: `node -e "console.log('CINDY_PRECHECK_OK'); process.exit(${exitCode})"`,
      stdinPayload: payload,
    });
    expect(result.checkSucceeded).toBe(exitCode === 1 ? undefined : true);
  });
  it('exit 0 → decision run', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(0)"',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('run');
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
  });

  it('exit 2 → decision skip', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(2)"',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('skip');
    expect(result.status).toBe('skipped');
    expect(result.checkSucceeded).toBeUndefined();
    expect(result.exitCode).toBe(2);
  });

  it('其它退出码 fail-closed → decision block', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(3)"',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('block');
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
  });

  it('stdin 能读到 JSON 上下文(按 scheduleId 决策)', async () => {
    const js =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('sid='+j.scheduleId);process.exit(j.scheduleId==='s1'?2:0)})";
    const result = await executePreRunHook({
      command: `node -e "${js}"`,
      stdinPayload: payload,
    });
    expect(result.decision).toBe('skip');
    expect(result.stdout).toContain('sid=s1');
  });

  it('超时 fail-closed → decision block + timedOut', async () => {
    const result = await executePreRunHook({
      command: 'node -e "setTimeout(function(){process.exit(2)},30000)"',
      timeoutMs: 400,
      stdinPayload: payload,
    });
    expect(result.timedOut).toBe(true);
    expect(result.decision).toBe('block');
    expect(result.status).toBe('timed_out');
  }, 15_000);

  it('命令不存在(shell 报错退出)fail-closed → decision block', async () => {
    const result = await executePreRunHook({
      command: 'definitely-not-a-real-command-xdmaker-test',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('block');
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(2);
  });

  it('stdout / stderr 分别捕获', async () => {
    const result = await executePreRunHook({
      command: 'node -e "console.log(\'to-out\');console.error(\'to-err\');process.exit(0)"',
      stdinPayload: payload,
    });
    expect(result.stdout).toContain('to-out');
    expect(result.stderr).toContain('to-err');
  });

  it('JavaScript 语法错误会阻止执行', async () => {
    const result = await executePreRunHook({
      command: 'node -e "const ="',
      stdinPayload: payload,
    });
    expect(result.status).toBe('failed');
    expect(result.decision).toBe('block');
    expect(result.exitCode).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'shell 语法错误(sh 退出码同为 2)按失败阻止,不当成跳过',
    async () => {
      const result = await executePreRunHook({
        // 2026-10 真实事故:单引号没配平,sh 以 2 退出,被误记为"本轮跳过"
        command: `node -e "process.exit(0)" '//`,
        stdinPayload: payload,
      });
      expect(result.status).toBe('failed');
      expect(result.decision).toBe('block');
      expect(result.error).toMatch(/^shell syntax error in command: /);
      expect(result.stderr).not.toBe('');
      expect(formatPreRunHookFailure(result)).toContain('shell syntax error');
    },
  );

  it('spawn 失败会保留启动错误并阻止执行', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(0)"',
      cwd: 'Z:/definitely/not/a/real/pre-run-hook-directory',
      stdinPayload: payload,
    });
    expect(result.status).toBe('failed');
    expect(result.decision).toBe('block');
    expect(result.spawnError || result.error).toBeTruthy();
  });

  it('stdout 超过 8KB 会截断并留下标记', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.stdout.write(\'x\'.repeat(9000))"',
      stdinPayload: payload,
    });
    expect(result.status).toBe('passed');
    expect(result.stdout).toHaveLength(8 * 1024);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('信号已 abort(任务已 pause/delete)→ 不 spawn 直接返回 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executePreRunHook({
      command: 'node -e "process.exit(2)"',
      signal: controller.signal,
      stdinPayload: payload,
    });
    expect(result.aborted).toBe(true);
    expect(result.status).toBe('aborted');
    expect(result.decision).toBe('block');
    expect(result.exitCode).toBeNull();
  });

  it('执行中 abort → 树杀进程并及时 settle(不等满超时)', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executePreRunHook({
      command: 'node -e "setTimeout(function(){process.exit(2)},30000)"',
      timeoutMs: 60_000,
      signal: controller.signal,
      stdinPayload: payload,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.status).toBe('aborted');
    expect(result.decision).toBe('block');
    // 树杀 + 1s 强制 settle 兜底:远小于 60s 超时即返回
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);
});

describe.skipIf(process.platform === 'win32')('前置检查命令语法预检', () => {
  it('语法正确的命令(含引号路径、管道、heredoc)不报错,且不会被执行', async () => {
    await expect(findShellSyntaxError(`node '/a b/x.mjs' --flag`)).resolves.toBeUndefined();
    await expect(findShellSyntaxError('git fetch -q && python3 - scan <<EOF\nx\nEOF')).resolves.toBeUndefined();
    // -n 只解析:即使命令会失败也不报语法错误
    await expect(findShellSyntaxError('exit 7')).resolves.toBeUndefined();
  });

  it('引号未配平 / 结构未闭合 → 返回 shell 报错', async () => {
    await expect(findShellSyntaxError(`node '/a b/x.mjs'//'`)).resolves.toBeTruthy();
    await expect(findShellSyntaxError('if true; then echo')).resolves.toBeTruthy();
  });

  it('命令含 NUL:预检不同步抛错,执行仍折叠成失败结果', async () => {
    await expect(findShellSyntaxError('node -e "1"\0')).resolves.toBeUndefined();
    const result = await executePreRunHook({ command: 'node -e "1"\0', stdinPayload: payload });
    expect(result.status).toBe('failed');
    expect(result.decision).toBe('block');
    expect(result.spawnError || result.error).toBeTruthy();
  });

  it('预检耗尽超时预算 → 直接 timed_out,不再启动真实命令', async () => {
    spawnCalls.count = 0;
    const result = await executePreRunHook({
      command: 'node -e "process.exit(0)"',
      timeoutMs: 1,
      stdinPayload: payload,
    });
    expect(result.status).toBe('timed_out');
    expect(result.decision).toBe('block');
    expect(result.timedOut).toBe(true);
    expect(spawnCalls.count).toBe(0);
  });

  it('预检响应取消信号:已取消时不再预检,执行返回 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(findShellSyntaxError(`node '/a b/x.mjs'//'`, { signal: controller.signal }))
      .resolves.toBeUndefined();
  });

  it('保存时校验:语法错误抛 invalid,正确命令放行', async () => {
    await expect(assertPreRunHookCommandSyntax(`node '/a b/x.mjs'//'`)).rejects.toThrow(
      /^invalid pre-run hook configuration: shell syntax error in command: /,
    );
    await expect(assertPreRunHookCommandSyntax(`xdt-node '/a b/x.mjs'`)).resolves.toBeUndefined();
  });
});

describe('resolveHookCommand(xdt-node 前缀解析)', () => {
  it('blocks an ESM preload immediate exit unless the gate actually completes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-entry-'));
    try {
      writeFileSync(path.join(dir, 'preload.mjs'), "import 'node:fs'; setImmediate(() => process.exit(0));");
      writeManagedGate(path.join(dir, 'gate.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('gate.txt', 'entered');");
      const result = await executePreRunHook({
        command: 'xdt-node --import ./preload.mjs gate.mjs', cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
      });
      expect(existsSync(path.join(dir, 'gate.txt'))).toBe(false);
      expect(result.decision).toBe('block');
      expect(result.status).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['cjs-microtask', 'env-esm'] as const)('uses the native CLI preload parent despite %s changing cwd', async (kind) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-preload-parent-'));
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const changed = path.join(dir, 'changed');
    const marker = path.join(dir, 'preloads.txt');
    const gateMarker = path.join(dir, 'gate.txt');
    try {
      mkdirSync(changed);
      for (const [cwd, name] of [[dir, 'original'], [changed, 'changed']]) {
        writeFileSync(path.join(cwd, 'preload.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(" + JSON.stringify(marker) + ',' + JSON.stringify(name + ';') + ');');
      }
      writeManagedGate(path.join(dir, 'gate.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(gateMarker) + ", 'entered');");
      let flags = '--import ./preload.mjs';
      if (kind === 'cjs-microtask') {
        writeFileSync(path.join(dir, 'cwd.cjs'), 'queueMicrotask(() => process.chdir(' + JSON.stringify(changed) + '));');
        flags = '-r ./cwd.cjs ' + flags;
      } else {
        writeFileSync(path.join(dir, 'cwd.mjs'), 'process.chdir(' + JSON.stringify(changed) + ');');
        process.env.NODE_OPTIONS = '--import=' + JSON.stringify(pathToFileURL(path.join(realpathSync(dir), 'cwd.mjs')).href)
          + (originalNodeOptions ? ' ' + originalNodeOptions : '');
      }
      const result = await executePreRunHook({
        // Isolate preload resolution from resolving the main script after chdir.
        command: 'xdt-node ' + flags + ' "' + path.join(dir, 'gate.mjs') + '"',
        cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
      });
      expect(readFileSync(marker, 'utf8')).toBe('original;');
      expect(readFileSync(gateMarker, 'utf8')).toBe('entered');
      expect(result.decision).toBe('run');
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const foreignReceiptDirectories: string[] = [];
  beforeEach(() => {
    ownedReceiptDirectories.length = 0;
  });
  afterEach(() => {
    // Covers pass, skip, throw, GUI false-success, timeout and abort cleanup.
    try {
      for (const directory of ownedReceiptDirectories) expect(existsSync(directory)).toBe(false);
    } finally {
      for (const directory of foreignReceiptDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const [name, segment] of [['ASCII', 'x'.repeat(120)], ['UTF-8', '界'.repeat(40)]] as const) {
    it.skipIf(process.platform === 'win32').each([0, 2])('executes with a long ' + name + ' TMPDIR (exit %s)', async (exitCode) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-long-temp-'));
      const originalTmpdir = process.env.TMPDIR;
      try {
        const longTemp = path.join(realpathSync(dir), segment);
        mkdirSync(longTemp);
        expect(Buffer.byteLength(path.join(longTemp, 'cindy-pre-run-node-XXXXXX', 'receipt.sock'))).toBeGreaterThan(103);
        process.env.TMPDIR = longTemp;
        writeManagedGate(path.join(dir, 'gate.mjs'), [
          "import { writeFileSync } from 'node:fs';",
          "let input = ''; process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', chunk => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  writeFileSync('executed.json', JSON.stringify(JSON.parse(input)));",
          "  console.log('CINDY_PRECHECK_OK'); process.exit(" + exitCode + ');',
          '});',
        ].join('\n'));
        const result = await executePreRunHook({
          command: 'xdt-node gate.mjs', cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
        });
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(exitCode);
        expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
        expect(result.checkSucceeded).toBe(true);
        expect(result.stdout).toBe('CINDY_PRECHECK_OK\n');
        expect(JSON.parse(readFileSync(path.join(dir, 'executed.json'), 'utf8'))).toEqual(payload);
        expect(ownedReceiptDirectories.some(directory => path.dirname(directory) === longTemp)).toBe(true);
        expect(ownedReceiptDirectories.some(directory => path.basename(directory).startsWith('cindy-pre-run-socket-'))).toBe(true);
        for (const directory of ownedReceiptDirectories) expect(existsSync(directory)).toBe(false);
      } finally {
        if (originalTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  for (const flag of permissionFlags) {
    it.skipIf(!supportedPermissionFlags.has(flag)).each([0, 2])('keeps ' + flag + ' checks executable without granting business writes (exit %s)', async (exitCode) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-permission-'));
      try {
        writeManagedGate(path.join(dir, 'gate.mjs'), [
          "import { writeFileSync } from 'node:fs';",
          "try { writeFileSync('business-denied', 'must not be allowed'); process.exit(90); }",
          "catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }",
          "console.log('gate-executed:business-write-denied');",
          "console.log('CINDY_PRECHECK_OK'); process.exit(" + exitCode + ');',
        ].join('\n'));
        const result = await executePreRunHook({
          command: 'xdt-node --no-warnings ' + flag + ' --allow-fs-read="' + nativeRuntime.client + '" gate.mjs',
          cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
        });
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(exitCode);
        expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
        expect(result.stdout).toBe('gate-executed:business-write-denied\nCINDY_PRECHECK_OK\n');
        expect(result.checkSucceeded).toBe(true);
        expect(existsSync(path.join(dir, 'business-denied'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it.each([
    ['cli', 'exit0'], ['cli', 'exit2'], ['cli', 'throw'],
    ['cli', 'normal0'], ['cli', 'normal2'],
    ['cli-equals', 'exit0'], ['cli-equals', 'normal0'],
    ['env', 'exit0'], ['env', 'normal0'], ['cjs-reset', 'exit0'],
    ['cjs-reset', 'normal0'], ['package', 'normal0'], ['multiple', 'normal0'],
  ] as const)('attests after %s ESM preloads (%s)', async (kind, outcome) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-esm-preload-'));
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const normal = outcome.startsWith('normal');
    const exitCode = outcome.endsWith('2') ? 2 : 0;
    try {
      writeFileSync(path.join(dir, 'user preload.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync('preload.txt', 'user;'); console.log('CINDY_PRECHECK_OK');",
        kind === 'multiple' ? "if (await (await import('node:fs/promises')).readFile('first.txt', 'utf8') !== 'first;') throw new Error('preload order');" : '',
        normal ? '' : outcome === 'throw' ? "throw new Error('user-esm-preload-throw');" : 'process.exit(' + exitCode + ');',
      ].join('\n'));
      writeManagedGate(path.join(dir, 'gate.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('gate.json', JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv }));",
        "console.log('gate-executed'); process.exit(" + exitCode + ');',
      ].join('\n'));
      let flags = kind === 'cli-equals' ? '"--import=./user preload.mjs"' : '--import "./user preload.mjs"';
      if (kind === 'package') {
        const packageDir = path.join(dir, 'node_modules', 'receipt-preload-fixture');
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
          type: 'module', exports: { 'receipt-fixture': './chosen.mjs', import: './wrong.mjs' },
        }));
        writeFileSync(path.join(packageDir, 'chosen.mjs'), "import '../../user preload.mjs';");
        writeFileSync(path.join(packageDir, 'wrong.mjs'), "throw new Error('wrong package condition');");
        flags = '--conditions=receipt-fixture --import receipt-preload-fixture';
      } else if (kind === 'multiple') {
        writeFileSync(path.join(dir, 'first.mjs'), "import { writeFileSync } from 'node:fs'; await new Promise(resolve => setTimeout(resolve, 10)); writeFileSync('first.txt', 'first;');");
        flags = '--import=./first.mjs ' + flags;
      } else if (kind === 'env') {
        process.env.NODE_OPTIONS = '--import=' + JSON.stringify(pathToFileURL(path.join(realpathSync(dir), 'user preload.mjs')).href)
          + (originalNodeOptions ? ' ' + originalNodeOptions : '');
        flags = '';
      } else if (kind === 'cjs-reset') {
        writeFileSync(path.join(dir, 'reset.cjs'), 'process.execArgv.length = 0;');
        flags = '-r ./reset.cjs ' + flags;
      }
      const result = await executePreRunHook({
        command: 'xdt-node ' + flags + ' gate.mjs "--import=business-argument" "two words"',
        cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
      });
      expect(readFileSync(path.join(dir, 'preload.txt'), 'utf8')).toBe('user;');
      expect(result.exitCode).toBe(outcome === 'throw' ? 1 : exitCode);
      if (normal) {
        const expectedExecArgv = kind === 'env' || kind === 'cjs-reset' ? []
          : kind === 'cli-equals' ? ['--import=./user preload.mjs']
            : kind === 'package' ? ['--conditions=receipt-fixture', '--import', 'receipt-preload-fixture']
              : kind === 'multiple' ? ['--import=./first.mjs', '--import', './user preload.mjs']
                : ['--import', './user preload.mjs'];
        expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
        expect(result.status).toBe(exitCode === 0 ? 'passed' : 'skipped');
        expect(result.checkSucceeded).toBe(true);
        expect(result.stdout).toContain('gate-executed');
        expect(result.stderr).toBe('');
        expect(JSON.parse(readFileSync(path.join(dir, 'gate.json'), 'utf8'))).toEqual({
          argv: ['--import=business-argument', 'two words'],
          execArgv: expectedExecArgv,
        });
      } else {
        expect(result.status).toBe('failed');
        expect(result.decision).toBe('block');
        expect(result.checkSucceeded).toBeUndefined();
        expect(existsSync(path.join(dir, 'gate.json'))).toBe(false);
        expect(result.error).toBe('The pre-run check did not provide verified completion. This run was blocked. Update the script to report entry and completion, and check its preload configuration.');
        if (outcome === 'throw') expect(result.stderr).toContain('user-esm-preload-throw');
      }
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the native disabled preload resolver without injecting a resolver flag', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-no-preload-resolver-'));
    try {
      writeFileSync(path.join(dir, 'preload.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('preload.txt', 'ran');");
      writeManagedGate(path.join(dir, 'gate.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('gate.txt', 'ran');");
      const result = await executePreRunHook({
        command: 'xdt-node --no-experimental-import-meta-resolve --import ./preload.mjs gate.mjs',
        cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
      });
      expect(result.status).toBe('passed');
      expect(result.decision).toBe('run');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(readFileSync(path.join(dir, 'preload.txt'), 'utf8')).toBe('ran');
      expect(readFileSync(path.join(dir, 'gate.txt'), 'utf8')).toBe('ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 2, 'preload-exit'] as const)('isolates startup proof before a user CJS preload forks (outcome %s)', async (exitCode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-cjs-fork-'));
    const originalNodeOptions = process.env.NODE_OPTIONS;
    try {
      writeFileSync(path.join(dir, 'env-preload.cjs'),
        "require('node:fs').appendFileSync('env-preload.txt', 'user;');");
      process.env.NODE_OPTIONS = '--require=' + JSON.stringify(path.join(realpathSync(dir), 'env-preload.cjs'))
        + (originalNodeOptions ? ' ' + originalNodeOptions : '');
      writeFileSync(path.join(dir, 'preload.cjs'), [
        "const fs = require('node:fs');",
        "if (!process.env.HOOK_PRELOAD_CHILD) {",
        "  require('node:child_process').fork('./child.cjs', [], {",
        "    env: { ...process.env, HOOK_PRELOAD_CHILD: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],",
        '  });',
        '  const deadline = Date.now() + 3000;',
        "  while (!fs.existsSync('child-ran.json')) {",
        "    if (Date.now() > deadline) throw new Error('preload child did not execute');",
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
        '  }',
        exitCode === 'preload-exit' ? '  process.exit(0);' : '',
        '}',
      ].join('\n'));
      writeFileSync(path.join(dir, 'child.cjs'),
        "require('node:fs').writeFileSync('child-ran.json', JSON.stringify(process.execArgv));");
      writeManagedGate(path.join(dir, 'gate.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('gate-ran.json', JSON.stringify(process.execArgv));",
        "console.log('CINDY_PRECHECK_OK'); process.exit(" + (exitCode === 'preload-exit' ? 0 : exitCode) + ');',
      ].join('\n'));
      const result = await executePreRunHook({
        command: 'xdt-node -r ./preload.cjs gate.mjs',
        cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
      });
      expect(result.stderr).toBe('');
      if (exitCode === 'preload-exit') {
        // A descendant must not attest a parent that exits before its import.
        expect(result.exitCode).toBe(0);
        expect(result.decision).toBe('block');
        expect(result.checkSucceeded).toBeUndefined();
        expect(result.error).toBe('The pre-run check did not provide verified completion. This run was blocked. Update the script to report entry and completion, and check its preload configuration.');
        expect(existsSync(path.join(dir, 'gate-ran.json'))).toBe(false);
        expect(JSON.parse(readFileSync(path.join(dir, 'child-ran.json'), 'utf8'))).toEqual(['-r', './preload.cjs']);
        return;
      }
      expect(result.exitCode).toBe(exitCode);
      expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
      expect(result.checkSucceeded).toBe(true);
      for (const file of ['child-ran.json', 'gate-ran.json']) {
        expect(JSON.parse(readFileSync(path.join(dir, file), 'utf8'))).toEqual(['-r', './preload.cjs']);
      }
      expect(readFileSync(path.join(dir, 'env-preload.txt'), 'utf8')).toBe('user;user;');
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks only owned receipt cleanup while another process creates its own directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-foreign-receipt-'));
    try {
      writeManagedGate(path.join(dir, 'gate.mjs'), [
        "import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import path from 'node:path';",
        "console.log(mkdtempSync(path.join(tmpdir(), 'cindy-pre-run-node-')));",
      ].join('\n'));
      const result = await executePreRunHook({ command: 'xdt-node gate.mjs', cwd: dir, stdinPayload: payload });
      const foreign = result.stdout.trim();
      // Only remove the controlled fixture's own newly-created directory.
      const isFixtureDirectory = path.dirname(foreign) === path.resolve(tmpdir())
        && /^cindy-pre-run-node-[A-Za-z0-9]+$/.test(path.basename(foreign));
      if (isFixtureDirectory) foreignReceiptDirectories.push(foreign);
      expect(result.decision).toBe('run');
      expect(isFixtureDirectory).toBe(true);
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 2])('supports ESM Workers without repeating internal startup proof (exit %s)', async (exitCode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-worker-'));
    try {
      writeFileSync(path.join(dir, 'user-preload.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        "import { isMainThread } from 'node:worker_threads';",
        "appendFileSync('user-preload.txt', isMainThread ? 'main;' : 'worker;');",
      ].join('\n'));
      writeFileSync(path.join(dir, 'worker.mjs'), [
        "import { parentPort } from 'node:worker_threads';",
        'parentPort.postMessage(process.execArgv);',
      ].join('\n'));
      writeManagedGate(path.join(dir, 'gate.mjs'), [
        "import { Worker } from 'node:worker_threads';",
        "import { writeFileSync } from 'node:fs';",
        "const worker = new Worker(new URL('./worker.mjs', import.meta.url));",
        "worker.on('error', error => { throw error; });",
        "worker.on('message', args => { writeFileSync('executed.json', JSON.stringify({ main: process.execArgv, worker: args })); });",
        "worker.on('exit', code => { console.log('CINDY_PRECHECK_OK'); process.exit(code || " + exitCode + '); });',
      ].join('\n'));
      const result = await executePreRunHook({
        command: 'xdt-node --no-warnings --import=./user-preload.mjs gate.mjs',
        cwd: dir, stdinPayload: payload, timeoutMs: 5_000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(exitCode === 0 ? 'passed' : 'skipped');
      expect(result.exitCode).toBe(exitCode);
      expect(result.checkSucceeded).toBe(true);
      expect(JSON.parse(readFileSync(path.join(dir, 'executed.json'), 'utf8'))).toEqual({
        main: ['--no-warnings', '--import=./user-preload.mjs'],
        worker: ['--no-warnings', '--import=./user-preload.mjs'],
      });
      expect(readFileSync(path.join(dir, 'user-preload.txt'), 'utf8')).toBe('main;worker;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 2])('accepts a real hook outcome when the shell redirects fd3 without business writes (exit %s)', async (exitCode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-redirect-exit-'));
    try {
      writeManagedGate(path.join(dir, 'gate.mjs'),
        "import { writeFileSync } from 'node:fs'; writeFileSync('executed', 'yes'); console.log('CINDY_PRECHECK_OK'); process.exit(" + exitCode + ');');
      const result = await executePreRunHook({
        command: 'xdt-node gate.mjs 3>&1', cwd: dir, stdinPayload: payload,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
      expect(result.stdout).toBe('CINDY_PRECHECK_OK\n');
      expect(result.checkSucceeded).toBe(true);
      expect(readFileSync(path.join(dir, 'executed'), 'utf8')).toBe('yes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [0, '3>fd3.log'], [2, '3>fd3.log'], [0, '3>&1'], [2, '3>&1'],
  ] as const)('preserves business fd3 redirection and exit %s (%s)', async (exitCode, redirection) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-redirection-'));
    try {
      writeManagedGate(path.join(dir, 'gate.mjs'), [
        "import { writeFileSync, writeSync } from 'node:fs';",
        "writeFileSync('executed', 'yes'); writeSync(3, 'business-fd3');",
        "console.log('CINDY_PRECHECK_OK'); process.exit(" + exitCode + ');',
      ].join('\n'));
      const result = await executePreRunHook({
        command: 'xdt-node gate.mjs ' + redirection, cwd: dir, stdinPayload: payload,
      });
      expect(readFileSync(path.join(dir, 'executed'), 'utf8')).toBe('yes');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(exitCode === 0 ? 'passed' : 'skipped');
      expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
      expect(result.exitCode).toBe(exitCode);
      if (redirection === '3>fd3.log') {
        expect(readFileSync(path.join(dir, 'fd3.log'), 'utf8')).toBe('business-fd3');
        expect(result.stdout).toBe('CINDY_PRECHECK_OK\n');
        expect(result.checkSucceeded).toBe(true);
      } else {
        expect(result.stdout).toBe('business-fd3CINDY_PRECHECK_OK\n');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['zh-CN', '未收到前置检查的完成验证，已阻止本次执行。请更新检查脚本的开始和完成回报，并检查预加载配置', '前置检查失败：'],
    ['zh-TW', '未收到前置檢查的完成驗證，已阻止本次執行。請更新檢查指令碼的開始和完成回報，並檢查預載入設定', '前置檢查失敗：'],
    ['en', 'The pre-run check did not provide verified completion. This run was blocked. Update the script to report entry and completion, and check its preload configuration.', 'Pre-run check failed: '],
    ['ja', '事前チェックの完了を確認できなかったため、今回の実行をブロックしました。スクリプトが開始と完了を報告するように更新し、プリロード設定を確認してください。', '事前チェックが失敗しました: '],
    ['ko', '사전 검사 완료를 확인하지 못해 이번 실행을 차단했습니다. 스크립트가 시작과 완료를 보고하도록 수정하고 사전 로드 설정을 확인하세요.', '사전 검사 실패: '],
  ] as const)('formats the missing verification and persisted failure summary in %s', async (locale, message, prefix) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-locale-'));
    const originalExecPath = process.execPath;
    try {
      const runtime = falseRuntimes[0];
      process.execPath = runtime;
      setMainLocale(locale);
      const result = await executePreRunHook({ command: 'xdt-node gate.mjs', cwd: dir, stdinPayload: payload });
      expect(result.status).toBe('failed');
      expect(result.decision).toBe('block');
      expect(result.error).toBe(message);
      expect(formatPreRunHookFailure(result)).toBe(prefix + message);
    } finally {
      process.execPath = originalExecPath;
      setMainLocale('en');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 2])('blocks an apparent runtime exit %s that never executes JavaScript', async (exitCode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-not-node-'));
    const originalExecPath = process.execPath;
    try {
      // Real subprocess, modelling a fuse-disabled GUI's single-instance exit.
      // Healthy-check stdout is deliberately not evidence of Node startup.
      const runtime = falseRuntimes[exitCode === 2 ? 1 : 0];
      writeManagedGate(path.join(dir, 'gate.mjs'),
        "import { writeFileSync } from 'node:fs'; writeFileSync('executed', 'yes');");
      process.execPath = runtime;
      const result = await executePreRunHook({
        command: 'xdt-node gate.mjs',
        cwd: dir,
        stdinPayload: payload,
      });
      expect(existsSync(path.join(dir, 'executed'))).toBe(false);
      expect(result.stdout).toContain('CINDY_PRECHECK_OK');
      expect(result.status).toBe('failed');
      expect(result.decision).toBe('block');
      expect(result.exitCode).toBe(exitCode);
      expect(result.checkSucceeded).toBeUndefined();
      expect(result.error).toBe('The pre-run check did not provide verified completion. This run was blocked. Update the script to report entry and completion, and check its preload configuration.');
    } finally {
      process.execPath = originalExecPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Node CLI arguments and script stdout separate from startup proof', async () => {
    const result = await executePreRunHook({
      command: 'xdt-node -e "(async()=>{const g=(await import(process.env.CINDY_PRE_RUN_GATE_CLIENT)).default;await g.enter();console.log(process.argv[1]);await g.complete(0)})()" "two words"',
      stdinPayload: payload,
    });
    expect(result.status).toBe('passed');
    expect(result.stdout).toBe('two words\n');
    expect(result.stderr).toBe('');
  });

  it.each([0, 2, 'throw'] as const)('waits for the real hook outcome after Node startup (%s)', async (outcome) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-await-exit-'));
    const controller = new AbortController();
    let pending: ReturnType<typeof executePreRunHook> | undefined;
    let settled = false;
    try {
      writeManagedGate(path.join(dir, 'gate.cjs'), [
        "const fs = require('node:fs'); fs.writeFileSync('started', String(process.pid));",
        "const timer = setInterval(() => { if (!fs.existsSync('release')) return;",
        "clearInterval(timer); console.log('hook-finished');",
        outcome === 'throw' ? "throw new Error('hook-exception-after-startup');" : 'process.exit(' + outcome + ');',
        '}, 10);',
      ].join('\n'));
      pending = executePreRunHook({
        command: 'xdt-node gate.cjs', cwd: dir, stdinPayload: payload,
        signal: controller.signal, timeoutMs: 5_000,
      });
      void pending.then(() => { settled = true; });
      // The script-side file proves its bootstrap has already run, while the
      // hook is still waiting for our release. Startup alone must not decide.
      await vi.waitFor(() => expect(existsSync(path.join(dir, 'started'))).toBe(true));
      expect(settled).toBe(false);
      writeFileSync(path.join(dir, 'release'), 'finish');
      const result = await pending;
      expect(result.exitCode).toBe(outcome === 'throw' ? 1 : outcome);
      expect(result.status).toBe(outcome === 0 ? 'passed' : outcome === 2 ? 'skipped' : 'failed');
      expect(result.decision).toBe(outcome === 0 ? 'run' : outcome === 2 ? 'skip' : 'block');
      expect(result.stdout).toBe('hook-finished\n');
      expect(result.error).toBe(outcome === 'throw' ? 'The pre-run check did not provide verified completion. This run was blocked. Update the script to report entry and completion, and check its preload configuration.' : undefined);
      if (outcome === 'throw') expect(result.stderr).toContain('hook-exception-after-startup');
      const pid = Number(readFileSync(path.join(dir, 'started'), 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      controller.abort();
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['timeout', 'abort'] as const)('preserves %s and kills xdt-node descendants', async (mode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-runtime-cancel-'));
    const controller = new AbortController();
    let pending: ReturnType<typeof executePreRunHook> | undefined;
    try {
      writeManagedGate(path.join(dir, 'gate.cjs'), [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "require('node:fs').writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));",
        "setInterval(() => {}, 1000);",
      ].join('\n'));
      pending = executePreRunHook({
        command: 'xdt-node gate.cjs', cwd: dir, stdinPayload: payload,
        signal: controller.signal, timeoutMs: mode === 'timeout' ? 1_000 : undefined,
      });
      await vi.waitFor(() => expect(existsSync(path.join(dir, 'pids.json'))).toBe(true));
      if (mode === 'abort') controller.abort();
      const result = await pending;
      expect(result.status).toBe(mode === 'timeout' ? 'timed_out' : 'aborted');
      expect(result.decision).toBe('block');
      expect(result.error ?? '').not.toContain('startup verification');
      const pids = JSON.parse(readFileSync(path.join(dir, 'pids.json'), 'utf8')) as number[];
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      controller.abort();
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 2])('actually executes a script with no PATH Node (exit %s)', async (exitCode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-node-hook-'));
    const originalPath = process.env.PATH;
    try {
      writeManagedGate(path.join(dir, 'gate.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        "let input = ''; for await (const chunk of process.stdin) input += chunk;",
        "writeFileSync('executed.json', JSON.stringify({ payload: JSON.parse(input), cwd: process.cwd() }));",
        "console.log('CINDY_PRECHECK_OK');",
        'process.exit(' + exitCode + ');',
      ].join('\n'), 'utf8');
      process.env.PATH = '';
      const result = await executePreRunHook({
        command: 'xdt-node gate.mjs',
        cwd: dir,
        stdinPayload: payload,
      });
      expect(JSON.parse(readFileSync(path.join(dir, 'executed.json'), 'utf8'))).toEqual({
        payload: { event: 'schedule-pre-run', scheduleId: 's1', scheduleName: 'test schedule',
          runId: 'r1', firedAt: 1_700_000_000_000 },
        cwd: realpathSync(dir),
      });
      expect(result.status).toBe(exitCode === 0 ? 'passed' : 'skipped');
      expect(result.decision).toBe(exitCode === 0 ? 'run' : 'skip');
      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).toBe('CINDY_PRECHECK_OK\n');
      expect(result.checkSucceeded).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('native gate completion and supported command boundaries', () => {
  it.each(['fork', 'worker'] as const)('rejects %s proof without invalidating the real root gate', async (kind) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-native-foreign-proof-'));
    try {
      writeFileSync(path.join(dir, 'foreign.cjs'),
        'import(process.env.CINDY_PRE_RUN_GATE_CLIENT).then(async({default:gate})=>{try{await gate.enter();process.exit(99);}catch{process.exit(0);}});');
      const body = kind === 'fork'
        ? 'import {spawnSync} from "node:child_process"; const child = spawnSync(process.execPath,["foreign.cjs"]); if(child.status!==0)throw new Error("foreign proof accepted");'
        : 'import {Worker} from "node:worker_threads"; await new Promise((resolve,reject)=>{const worker=new Worker(new URL("./foreign.cjs",import.meta.url));worker.on("error",reject);worker.on("exit",code=>code?reject(new Error("foreign proof accepted")):resolve());});';
      writeManagedGate(path.join(dir, 'gate.mjs'), body + '\nimport {writeFileSync} from "node:fs";writeFileSync("gate.txt","completed");');
      const result = await executePreRunHook({ command: 'xdt-node gate.mjs', cwd: dir, stdinPayload: payload, timeoutMs: 5_000 });
      expect(result.decision).toBe('run'); expect(result.exitCode).toBe(0);
      expect(readFileSync(path.join(dir, 'gate.txt'), 'utf8')).toBe('completed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['legacy exit-only', 'process.exit(0);'],
    ['entered without completion', 'await gate.enter(); process.exit(0);'],
    ['completed zero but exit two', 'await gate.enter(); await gate.complete(0); process.exit(2);'],
    ['completed two but exit zero', 'await gate.enter(); await gate.complete(2); process.exit(0);'],
    ['throw after completion', "await gate.enter(); await gate.complete(0); throw new Error('late-gate-failure');"],
    ['wrong nonce', "await gate.enter(); process.env.CINDY_PRE_RUN_GATE_NONCE = 'wrong'; await gate.complete(0);"],
  ])('blocks %s', async (_name, source) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-native-protocol-'));
    try {
      writeFileSync(path.join(dir, 'check.mjs'),
        'const gate = (await import(process.env.CINDY_PRE_RUN_GATE_CLIENT)).default;\n' + source);
      const result = await executePreRunHook({ command: 'xdt-node check.mjs', cwd: dir, stdinPayload: payload, timeoutMs: 5_000 });
      expect(result.status).toBe('failed'); expect(result.decision).toBe('block');
      expect(result.checkSucceeded).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('does not let shell true mask a failing Node gate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-native-shell-result-'));
    try {
      writeManagedGate(path.join(dir, 'gate.mjs'), "throw new Error('gate-must-block');");
      const result = await executePreRunHook({ command: 'xdt-node gate.mjs; true', cwd: dir, stdinPayload: payload });
      expect(result.exitCode).toBe(0); expect(result.decision).toBe('block');
      expect(result.stderr).toContain('gate-must-block');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not automatically grant access to the protocol module in permission mode', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-native-permission-client-'));
    try {
      writeManagedGate(path.join(dir, 'gate.mjs'), "console.log('must-not-run');");
      const result = await executePreRunHook({ command: 'xdt-node --no-warnings ' + [...supportedPermissionFlags][0] + ' gate.mjs', cwd: dir, stdinPayload: payload, timeoutMs: 5_000 });
      expect(result.decision).toBe('block'); expect(result.stdout).not.toContain('must-not-run');
      expect(result.stderr).toContain('ERR_ACCESS_DENIED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
