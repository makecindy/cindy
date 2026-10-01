import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import codexPackage from '../../../../tools/codex-package/latest.json';

import { BOOTSTRAP_SH, VERIFY_CODEX_LAYOUT_SH } from '../bootstrap/bootstrap-script.js';
import {
  installRemoteAgent,
  PINNED_CLAUDE_CODE_VERSION,
  PINNED_CODEX_RELEASE_VERSION,
  PINNED_PI_VERSION,
  probeRemoteAgent,
  uninstallRemoteAgent,
} from '../bootstrap/installer.js';
import type { RemoteHost } from '../RemoteHost.js';

describe('remote agent installer', () => {
  it('passes the pinned Codex release to the remote bootstrap script', async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const host = {
      exec: async (command: string, opts: { input?: string }) => {
        calls.push({ command, input: opts.input ?? '' });
        return {
          exitCode: 0,
          stdout: [
            'PROBE_START',
            'INSTALL_DIR /home/u/.xdt-server/v1',
            `READY ${PINNED_CODEX_RELEASE_VERSION}`,
          ].join('\n'),
          stderr: '',
        };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    const result = await installRemoteAgent(host, 'codex');

    expect(result.ready).toBe(true);
    expect(result.installedVersion).toBe(PINNED_CODEX_RELEASE_VERSION);
    expect(PINNED_CODEX_RELEASE_VERSION).toBe(codexPackage.version);
    // Full-package install.sh preserves this alias for legacy daemon callers.
    expect(result.binaryPath).toBe('/home/u/.xdt-server/v1/codex-home/packages/standalone/current/codex');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toContain(`'${PINNED_CODEX_RELEASE_VERSION}'`);
    expect(calls[0].input).toBe(BOOTSTRAP_SH);
  });

  it('runs install.sh with --release when a Codex release arg is present', () => {
    expect(BOOTSTRAP_SH).toContain('INSTALLER_URL="https://github.com/openai/codex/releases/download/rust-v$CODEX_RELEASE/install.sh"');
    expect(BOOTSTRAP_SH).toContain('sh "$INSTALLER_TMP" --release "$CODEX_RELEASE"');
  });

  it('keeps the generated bootstrap valid bash', () => {
    const result = spawnSync('bash', ['-n'], { input: BOOTSTRAP_SH, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    { name: 'legacy standalone requires upgrade', os: 'Darwin', legacy: true, missing: '', ok: false },
    { name: 'complete macOS package', os: 'Darwin', legacy: false, missing: 'codex-resources/bwrap', ok: true },
    { name: 'complete Linux package', os: 'Linux', legacy: false, missing: '', ok: true },
    { name: 'missing code-mode host', os: 'Darwin', legacy: false, missing: 'bin/codex-code-mode-host', ok: false },
    { name: 'missing ripgrep', os: 'Darwin', legacy: false, missing: 'codex-path/rg', ok: false },
    { name: 'missing package manifest', os: 'Darwin', legacy: false, missing: 'codex-package.json', ok: false },
    { name: 'missing Linux sandbox', os: 'Linux', legacy: false, missing: 'codex-resources/bwrap', ok: false },
  ])('checks $name using the remote layout guard', ({ os: remoteOs, legacy, missing, ok }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-ssh-codex-layout-'));
    try {
      const files = legacy ? ['codex'] : [
        'codex', 'codex-package.json', 'bin/codex', 'bin/codex-code-mode-host',
        'codex-path/rg', 'codex-resources/bwrap',
      ];
      if (!legacy) mkdirSync(path.join(root, 'codex-resources'), { recursive: true });
      for (const file of files.filter((file) => file !== missing)) {
        const destination = path.join(root, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, '#!/bin/sh\nexit 0\n');
        chmodSync(destination, 0o755);
      }
      const result = spawnSync('bash', ['-c', `
        BIN_PATH="$PWD/codex"
        uname() { printf '%s\n' '${remoteOs}'; }
        ${VERIFY_CODEX_LAYOUT_SH}
        verify_codex_layout
      `], { cwd: root, encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(ok ? 0 : 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins Claude Code for probe and install, and rejects a stale sentinel version', async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const host = {
      exec: async (command: string, opts: { input?: string }) => {
        calls.push({ command, input: opts.input ?? '' });
        return {
          exitCode: 0,
          stdout: [
            'INSTALL_DIR /home/u/.xdt-server/v1',
            'NOT_INSTALLED',
          ].join('\n'),
          stderr: '',
        };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    const probe = await probeRemoteAgent(host, 'claude-code');
    expect(probe.installed).toBe(false);
    expect(calls[0].command).toContain(`'${PINNED_CLAUDE_CODE_VERSION}'`);
    expect(calls[0].input).toContain(
      '[ "${V%% *}" = "$CLAUDE_RELEASE" ]',
    );

    await installRemoteAgent(host, 'claude-code');
    expect(calls[1].command).toContain(`'${PINNED_CLAUDE_CODE_VERSION}'`);
    expect(calls[1].input).toContain(
      'NPM_PKG="@anthropic-ai/claude-code@$CLAUDE_RELEASE"',
    );
    expect(calls[1].input).toContain(
      '$AGENT_KIND version $V does not match managed pin',
    );
  });

  it.each([
    { name: 'legacy standalone', complete: false, version: PINNED_CODEX_RELEASE_VERSION, ready: false },
    { name: 'old full package', complete: true, version: '0.0.1', ready: false },
    { name: 'current full package', complete: true, version: PINNED_CODEX_RELEASE_VERSION, ready: true },
  ])('probe and bootstrap agree on $name readiness', async ({ complete, version, ready }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-readiness-'));
    try {
      // Simulate the POSIX remote home, never the developer home. All downloads
      // are stubbed so an upgrade request cannot reach the network in this test.
      const install = path.join(root, '.xdt-server', 'v1');
      const current = path.join(install, 'codex-home', 'packages', 'standalone', 'current');
      const files = complete
        ? ['codex', 'bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'codex-resources/bwrap', 'codex-package.json']
        : ['codex'];
      for (const file of files) {
        const target = path.join(current, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, '#!/bin/sh\nprintf "codex-cli ' + version + '\\n"\n');
        chmodSync(target, 0o755);
      }
      writeFileSync(path.join(install, '.installed-codex'), '');
      const outputs: string[] = [];
      const host = {
        exec: async (command: string, opts: { input?: string }) => {
          const args = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
          expect(args).toContain(PINNED_CODEX_RELEASE_VERSION);
          const result = spawnSync('bash', ['-s', '--', ...args], {
            cwd: root, encoding: 'utf8',
            input: 'export HOME="$PWD"\ncurl() { return 1; }\nwget() { return 1; }\n' + opts.input,
          });
          expect(result.error).toBeUndefined();
          outputs.push(result.stdout);
          return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
        },
      } as Pick<RemoteHost, 'exec'> as RemoteHost;
      expect((await probeRemoteAgent(host, 'codex')).installed).toBe(ready);
      expect((await installRemoteAgent(host, 'codex')).ready).toBe(ready);
      if (!ready) expect(outputs[1]).toContain('INSTALL_START codex-package');
      else expect(outputs[1]).not.toContain('INSTALL_START');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('probes pi binary presence + version match', async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const host = {
      exec: async (command: string, opts: { input?: string }) => {
        calls.push({ command, input: opts.input ?? '' });
        return {
          exitCode: 0,
          stdout: [
            'INSTALL_DIR /home/u/.xdt-server/v1',
            `READY ${PINNED_PI_VERSION}`,
          ].join('\n'),
          stderr: '',
        };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    const probe = await probeRemoteAgent(host, 'pi');
    expect(probe.installed).toBe(true);
    expect(probe.installedVersion).toBe(PINNED_PI_VERSION);
    expect(probe.binaryPath).toBe('/home/u/.xdt-server/v1/pi/pi');
    expect(calls[0].command).toContain(`'${PINNED_PI_VERSION}'`);
  });

  it('pi install passes the 4 POSIX SHA256 args and binary layout', async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const host = {
      exec: async (command: string, opts: { input?: string }) => {
        calls.push({ command, input: opts.input ?? '' });
        return {
          exitCode: 0,
          stdout: [
            'INSTALL_DIR /home/u/.xdt-server/v1',
            'INSTALL_START pi',
            'INSTALL_LOG sha256 ok',
            'INSTALL_DONE',
            `READY ${PINNED_PI_VERSION}`,
          ].join('\n'),
          stderr: '',
        };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    const result = await installRemoteAgent(host, 'pi');
    expect(result.ready).toBe(true);
    expect(result.installedVersion).toBe(PINNED_PI_VERSION);
    expect(result.binaryPath).toBe('/home/u/.xdt-server/v1/pi/pi');
    // 4 个 POSIX 平台 SHA256(darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64)。
    expect(calls[0].command).toContain(`'${PINNED_PI_VERSION}'`);
    // 精确数量断言:4 个平台 SHA256 缺一个/多一个都该失败(R7 测试覆盖审计)。
    expect(calls[0].command.match(/'[0-9a-f]{64}'/g)?.length).toBe(4);
    // 安装脚本:tar.gz 下载 + sha256 校验 + 先解到临时目录再原子替换(解压失败不毁旧)。
    expect(calls[0].input).toContain('pi-${OS_TAG}-${ARCH_TAG}.tar.gz');
    expect(calls[0].input).toContain('shasum -a 256 -c -');
    expect(calls[0].input).toContain('tar xzf "$TMP/pi.tgz" -C "$TMP/extract"');
    expect(calls[0].input).toContain('mv "$TMP/extract/pi" "$INSTALL_DIR/pi"');
  });

  it('pi uninstall kills pi-manager daemon (pidfile) then removes dirs', async () => {
    const calls: Array<{ command: string; label?: string }> = [];
    const host = {
      exec: async (command: string, opts?: { label?: string }) => {
        calls.push({ command, label: opts?.label });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    await uninstallRemoteAgent(host, 'pi');

    // Exactly 2 calls: killDaemons first, then rm -rf (轮 10 M-2 —— 多余 exec
    // 调用会破坏精确的 2 步契约)。
    expect(calls.length).toBe(2);

    // Call 1: killDaemons — pi-manager pidfile kill with identity verification
    const killCmd = calls[0].command;
    expect(killCmd).toContain('pi-manager/pi-manager.pid');
    expect(killCmd).toContain('kill -0 "$PID"');
    // 轮 42 P2:身份验证升级为进程名 + 本 install 的 --socket 双匹配(防 stale
    // pidfile 复用成别的 install root 的 daemon 时误杀)。
    expect(killCmd).toContain('grep -F -- "pi-manager.mjs"');
    expect(killCmd).toContain('grep -F -- "--socket');
    expect(killCmd).toContain('kill "$PID"');
    // error isolation: killDaemons failures must not block rm
    expect(killCmd).toContain('|| true');
    // 等待循环:kill 后最多 3s 等 daemon 退出, 防 rm 与 shutdown 竞态(轮 10 M-1)
    expect(killCmd).toContain('seq 1 15');
    // 轮 18-T4:循环用 break 而非 exit —— 原 `exit 0` 在 daemon 正常退出时
    // 直接退出整个 bash 脚本, rm -rf 被跳过, 卸载残留目录/凭证文件。
    expect(killCmd).toContain('kill -0 "$PID" 2>/dev/null || break');
    // 等待循环内不再有把整个脚本截断的 exit(轮 18-T4 —— 保持 2 步 exec 契约)。
    expect(killCmd).not.toContain('|| { echo KILLED; exit 0; }');
    // 轮 18-T4:SIGTERM 3s 未退出 → 补 SIGKILL 升级序列
    expect(killCmd).toContain('kill -9 "$PID"');
    expect(killCmd).toContain('WARN: pi-manager daemon (PID $PID) still alive after SIGKILL');
    // socket-only sweep 不得匹配 grep / 本 bash -c(否则误杀卸载脚本自己)。
    expect(killCmd).toContain('grep -v -F "grep"');
    expect(killCmd).toContain('[ "$ORPHAN" = "$$" ] && continue');
    // python daemon 已退役:不再有 pi-daemon.py kill 路径
    expect(killCmd).not.toContain('pi-daemon.py kill');

    // Call 2: rm — must remove pi/, pi-manager/, pi-daemon/ (旧 host 残留,
    // 退役审轮 8 LOW-2), pi-oneshot/, .installed-pi
    const rmCmd = calls[1].command;
    expect(rmCmd).toContain('rm -rf');
    expect(rmCmd).toContain('/pi ');
    expect(rmCmd).toContain('/pi-manager ');
    expect(rmCmd).toContain('/pi-daemon');
    expect(rmCmd).toContain('/pi-oneshot');
    expect(rmCmd).toContain('.installed-pi');
  });

  it('pi uninstall killDaemons runs BEFORE rm (kill depends on daemon process)', async () => {
    // Verify call ordering: killDaemons (label='uninstall-pi-kill-daemons')
    // comes before rm (label='uninstall-pi'). If rm ran first, the pidfile
    // would be deleted and the kill command would fail silently.
    const labels: string[] = [];
    const host = {
      exec: async (_command: string, opts?: { label?: string }) => {
        labels.push(opts?.label ?? '');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    await uninstallRemoteAgent(host, 'pi');

    const killIdx = labels.findIndex((l) => l === 'uninstall-pi-kill-daemons');
    const rmIdx = labels.findIndex((l) => l === 'uninstall-pi');
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeLessThan(rmIdx); // kill before rm
  });
});
