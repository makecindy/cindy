/**
 * codex-remote-mcp 远端 config.toml 管理段的纯函数测试:
 * renderManagedMcpBlock 的输出形态,mergeManagedMcpBlock 的幂等 / 替换 /
 * 追加语义(漂移检测是"内容一致则不重写、不重启 daemon"的前提)。
 */

import { describe, expect, it, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import type { RemoteHost } from '@cindy/maker-remote-ssh';

import {
  renderManagedMcpBlock,
  mergeManagedMcpBlock,
  ensureRemoteCodexMcpBridge,
  stripRemoteCodexMcpConfig,
  hasPendingRemoteMcpDrift,
} from '../codex-remote-mcp.js';

// safeStorage 在测试 stub 里 isEncryptionAvailable=false → token 真源恒 null;
// 走完整 ensure 流程的用例需要固定 token。
vi.mock('../../mcp-integrations/remoteMcpBridgeToken.js', () => ({
  getRemoteMcpBridgeToken: vi.fn(() => 'test-persistent-token'),
}));

import { getRemoteMcpBridgeToken } from '../../mcp-integrations/remoteMcpBridgeToken.js';

const SERVERS = ['cindy_orca', 'orca_worker_bridge'];

// remote-mcp-forwards.json 在真实 userData stub 目录跨 vitest 运行残留
// (appliedFingerprint 持久化后会影响 driftUnapplied 判定) — 每次运行起始
// 清掉;模块级 portPrefsCache 是懒加载, 此刻必然未读, 首读即空文件。
beforeAll(() => {
  fs.rmSync(path.join(app.getPath('userData'), 'remote-mcp-forwards.json'), { force: true });
});

/** 走完整 ensure 流程的 fake host:读 config 返回给定内容, 其余命令一律成功。 */
function fakeHost(hostId: string, configContent: string) {
  const execCmds: string[] = [];
  const inputs: string[] = [];
  const host = {
    id: hostId,
    exec: async (cmd: string, opts?: { input?: string }) => {
      execCmds.push(cmd);
      if (opts?.input) inputs.push(opts.input);
      if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
        return { exitCode: 0, stdout: configContent, stderr: '' };
      }
      // daemon version 探活 / write / bootstrap 一律成功。
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
      remotePort: spec.preferredRemotePort ?? 47921,
      close: async () => {},
    }),
  } as unknown as RemoteHost;
  return { host, execCmds, inputs };
}

/**
 * 从 write 命令的 stdin input 解出写入的 config 内容。config base64 经
 * stdin 传入 (不进 argv, 见 codex-remote-mcp.ts writeConfigCmd 注释):纯
 * base64 形态的那条 input 即写入内容;bootstrap 的 KEY=value 块含下划线/
 * 换行, 形态不符自然跳过。下限 16 与旧版 (argv 提取) 同理由。
 */
function decodeWrittenConfig(inputs: string[]): string | null {
  for (const input of inputs) {
    const t = input.trim();
    if (t.length < 16 || !/^[A-Za-z0-9+/=]+$/.test(t)) continue;
    return Buffer.from(t, 'base64').toString('utf-8');
  }
  return null;
}

/** 读 prefs 文件里某 host 的记录 (appliedFingerprint / 端口断言用)。 */
function prefsOf(hostId: string): { remotePort?: number; appliedFingerprint?: string; bridgeLocalPort?: number } | null {
  const file = path.join(app.getPath('userData'), 'remote-mcp-forwards.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
    string,
    { remotePort?: number; appliedFingerprint?: string; bridgeLocalPort?: number }
  >;
  return raw[hostId] ?? null;
}

describe('renderManagedMcpBlock', () => {
  it('renders one mcp_servers table per server with bridge url and bearer env var', () => {
    const block = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-test' });
    expect(block).toContain('[mcp_servers.cindy_orca]');
    expect(block).toContain('url = "http://127.0.0.1:47921/mcp/cindy_orca"');
    expect(block).toContain('[mcp_servers.orca_worker_bridge]');
    expect(block).toContain('url = "http://127.0.0.1:47921/mcp/orca_worker_bridge"');
    expect(block.match(/bearer_token_env_var = "LIZI_MCP_TOKEN"/g)).toHaveLength(2);
    expect(block).toContain('startup_timeout_sec = 600');
  });

  it('is wrapped in managed begin/end markers', () => {
    const block = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-test' });
    expect(block.startsWith('# >>> cindy-remote-mcp')).toBe(true);
    expect(block.trimEnd().endsWith('# <<< cindy-remote-mcp <<<')).toBe(true);
  });

  it('embeds the token fingerprint so token rotation counts as config drift', () => {
    // review P1 回归:账号切换后 token 重生成, daemon env 还是旧 token;
    // fingerprint 进受管段 → changed=true → bootstrap 重启 daemon。
    const oldBlock = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    const rotated = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-new' });
    expect(oldBlock).toContain('# cindy-token-fingerprint: fp-old');
    const existing = mergeManagedMcpBlock('', oldBlock).next;
    const { changed, next } = mergeManagedMcpBlock(existing, rotated);
    expect(changed).toBe(true);
    expect(next).toContain('# cindy-token-fingerprint: fp-new');
    // fingerprint 不变时保持幂等 (不触发 daemon 重启)。
    const quiet = mergeManagedMcpBlock(existing, oldBlock);
    expect(quiet.changed).toBe(false);
  });
});

describe('mergeManagedMcpBlock', () => {
  const block = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-test' });

  it('appends to an empty config', () => {
    const { next, changed } = mergeManagedMcpBlock('', block);
    expect(changed).toBe(true);
    expect(next).toBe(`${block}\n`);
  });

  it('appends below existing user content and preserves it', () => {
    const existing = 'model = "gpt-5.5"\n\n[history]\npersistence = "save-all"\n';
    const { next, changed } = mergeManagedMcpBlock(existing, block);
    expect(changed).toBe(true);
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[history]');
    expect(next).toContain(block);
    expect(next.indexOf('model = "gpt-5.5"')).toBeLessThan(next.indexOf(block));
  });

  it('is idempotent when content already matches (drift check stays quiet)', () => {
    const first = mergeManagedMcpBlock('', block);
    const second = mergeManagedMcpBlock(first.next, block);
    expect(second.changed).toBe(false);
    expect(second.next).toBe(first.next);
  });

  it('replaces a stale managed block in place (port change) and keeps surrounding content', () => {
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-test' });
    const existing = `model = "gpt-5.5"\n\n${stale}\n\n[history]\npersistence = "save-all"\n`;
    const fresh = renderManagedMcpBlock({ remotePort: 47930, serverNames: SERVERS, tokenFingerprint: 'fp-test' });
    const { next, changed } = mergeManagedMcpBlock(existing, fresh);
    expect(changed).toBe(true);
    expect(next).toContain('url = "http://127.0.0.1:47930/mcp/cindy_orca"');
    expect(next).not.toContain('47921');
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[history]');
    // 管理段仍恰好出现一次。
    expect(next.match(/# >>> cindy-remote-mcp/g)).toHaveLength(1);
  });

  it('drops a server removed from the bridge list on next merge', () => {
    const twoServers = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-test' });
    const existing = mergeManagedMcpBlock('', twoServers).next;
    const oneServer = renderManagedMcpBlock({ remotePort: 47921, serverNames: ['cindy_orca'], tokenFingerprint: 'fp-test' });
    const { next, changed } = mergeManagedMcpBlock(existing, oneServer);
    expect(changed).toBe(true);
    expect(next).toContain('[mcp_servers.cindy_orca]');
    expect(next).not.toContain('orca_worker_bridge');
  });

  it('matches markers by whole line only (a comment mentioning the marker text survives)', () => {
    // P1 回归:子串匹配会把用户注释里提到 marker 文本的内容误判成管理段起点,
    // 把该用户的其余配置当管理段剥掉。行级精确匹配后注释行原样保留。
    const note = '# my note referencing # >>> cindy-remote-mcp (managed, do not edit) >>> inline';
    const existing = `${note}\nmodel = "gpt-5.5"\n`;
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block);
    expect(changed).toBe(true);
    expect(next).toContain(note);
    expect(next).toContain('model = "gpt-5.5"');
    expect(strippedUserServers).toEqual([]);
  });

  it('strips user-defined mcp_servers blocks for managed servers (invalid duplicate TOML)', () => {
    // P1 回归:用户在 managed 段之外手写同名 server table 时,直接追加 managed
    // 段会产生重复 table (非法 TOML, codex 起不来)。merge 必须剥离用户段并
    // 报告名字。
    const existing = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.cindy_orca]',
      'url = "http://127.0.0.1:11111/mcp/cindy_orca"',
      'startup_timeout_sec = 30',
      '',
      '[mcp_servers.cindy_orca.advanced]',
      'flag = true',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
    ].join('\n');
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(changed).toBe(true);
    expect(strippedUserServers).toEqual(['cindy_orca']);
    expect(next).not.toContain('11111');
    // 用户段与其子表都被剥掉, 其他 table 保留。
    expect(next).not.toContain('[mcp_servers.cindy_orca.advanced]');
    expect(next).not.toContain('flag = true');
    expect(next).toContain('[history]');
    expect(next).toContain('model = "gpt-5.5"');
    // managed 段恰好一次。
    expect(next.match(/\[mcp_servers\.cindy_orca\]/g)).toHaveLength(1);
  });

  it('keeps user-defined blocks for unmanaged servers untouched', () => {
    const existing = [
      '[mcp_servers.my_custom]',
      'url = "http://127.0.0.1:22222/mcp/my_custom"',
      '',
    ].join('\n');
    const { next, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(strippedUserServers).toEqual([]);
    expect(next).toContain('[mcp_servers.my_custom]');
    expect(next).toContain('22222');
  });

  it('strips TOML-variant user headers (trailing comment / quoted key / array-of-tables)', () => {
    // P1 回归:`[mcp_servers.cindy_orca] # note`、`[mcp_servers."cindy_orca"]`、
    // `[[mcp_servers.cindy_orca]]` 都是 TOML 合法形态, 漏剥会跟 managed 段
    // 形成重复定义, codex config 解析失败。
    const variants = [
      '[mcp_servers.cindy_orca] # trailing note',
      '[mcp_servers."cindy_orca"]',
      "[[mcp_servers.cindy_orca]]",
    ];
    for (const header of variants) {
      const existing = `${header}\nurl = "http://127.0.0.1:11111/mcp/x"\n`;
      const { next, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
        serverNames: SERVERS,
      });
      expect(strippedUserServers).toEqual(['cindy_orca']);
      expect(next).not.toContain('11111');
      // managed 段的 table 恰好出现一次。
      expect(next.match(/\[mcp_servers\.cindy_orca\]/g)).toHaveLength(1);
    }
  });

  it('does not end a stripped user table on a multiline-string line that merely starts with [', () => {
    // P1 回归:边界判定必须按 header 形态, 用户 table 的多行字符串内容里
    // 以 `[` 开头但形态不符的行不得提前结束剥离。
    const existing = [
      '[mcp_servers.cindy_orca]',
      'instructions = """',
      '[not a header, no closing bracket',
      'still inside the string"',
      'url = "http://127.0.0.1:11111/mcp/x"',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
    ].join('\n');
    const { next, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(strippedUserServers).toEqual(['cindy_orca']);
    // 字符串内容行与用户 key 都随 table 剥掉; [history] 保留。
    expect(next).not.toContain('not a header');
    expect(next).not.toContain('11111');
    expect(next).toContain('[history]');
  });

  it('an orphan managed begin strips only managed residue, never user config after it', () => {
    // P1 回归:有 begin 无 end (写文件中断) 时, 旧实现会一路剥到 EOF, 把
    // begin 之后的 [history] 等用户配置全删掉。自愈必须只剥连续的 managed
    // 残留形态行, 遇到用户内容即停。
    const existing = [
      '# >>> cindy-remote-mcp (managed, do not edit) >>>',
      '[mcp_servers.cindy_orca]',
      'url = "http://127.0.0.1:47921/mcp/cindy_orca"',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
      'model = "gpt-5.5"',
      '',
    ].join('\n');
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames: SERVERS,
    });
    expect(changed).toBe(true);
    // managed 残留 (begin + 半截 table) 被剥, 用户配置完整保留。
    expect(next).toContain('[history]');
    expect(next).toContain('persistence = "save-all"');
    expect(next).toContain('model = "gpt-5.5"');
    expect(next.match(/# >>> cindy-remote-mcp/g)).toHaveLength(1);
    // 残留 table 经 managed residue 路径剥除, 不按"用户段"上报。
    expect(strippedUserServers).toEqual([]);
    // 自愈后幂等: 再 merge 不再变化。
    const second = mergeManagedMcpBlock(next, block, { serverNames: SERVERS });
    expect(second.changed).toBe(false);
  });
});

describe('ensureRemoteCodexMcpBridge per-host serialization', () => {
  it('serializes concurrent ensures for the same host (second runs after first settles)', async () => {
    // P1 回归:并发 ensure 同一 host 会互相交错 forward arm 与 config 写入;
    // per-host 串行锁保证后到的 ensure 在前一个完成后才执行。
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    let callIdx = 0;
    const deps = {
      ensureBridgeStarted: async () => {
        callIdx += 1;
        const mine = callIdx;
        order.push(`start-${mine}`);
        if (mine === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        order.push(`end-${mine}`);
        return null; // 早退 bridge-unavailable,无需走完整 ensure 流程
      },
    };
    const host = { id: 'host-serial-1' } as unknown as RemoteHost;

    const p1 = ensureRemoteCodexMcpBridge(host, deps);
    const p2 = ensureRemoteCodexMcpBridge(host, deps);
    // 第二个调用在锁上排队,不会与第一个并发执行。
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start-1']);
    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('different hosts run independently', async () => {
    let bridgeCalls = 0;
    const deps = {
      ensureBridgeStarted: async () => {
        bridgeCalls += 1;
        return null;
      },
    };
    const hostA = { id: 'host-serial-a' } as unknown as RemoteHost;
    const hostB = { id: 'host-serial-b' } as unknown as RemoteHost;
    const [ra, rb] = await Promise.all([
      ensureRemoteCodexMcpBridge(hostA, deps),
      ensureRemoteCodexMcpBridge(hostB, deps),
    ]);
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    expect(bridgeCalls).toBe(2);
  });

  it('a failed ensure does not poison the lock for the next one', async () => {
    let bridgeCalls = 0;
    const deps = {
      ensureBridgeStarted: async () => {
        bridgeCalls += 1;
        if (bridgeCalls === 1) throw new Error('bridge exploded');
        return null;
      },
    };
    const host = { id: 'host-serial-fail' } as unknown as RemoteHost;
    const first = await ensureRemoteCodexMcpBridge(host, deps);
    expect(first.ok).toBe(false);
    const second = await ensureRemoteCodexMcpBridge(host, deps);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('bridge-unavailable');
    expect(bridgeCalls).toBe(2);
  });
});

describe('ensureRemoteCodexMcpBridge live-turn defer', () => {
  const bridgeDeps = {
    ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
  };

  it('writes config but defers daemon restart while a live turn exists on the host', async () => {
    // P1 回归:config 漂移生效必须重启 daemon, 重启会断同 host 的 live turn —
    // 有 turn 时 config 照写 (daemon 运行中不读 config, 落盘无害) 但 bootstrap
    // 推迟;driftUnapplied 是持久指纹事实, turn 结束后的 ensure 必然补刀。
    const { host, execCmds } = fakeHost('host-defer-live', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => true,
    });
    expect(result.ok).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('config.toml'); // 仍读了 config (漂移检测)
    expect(joined).toContain('base64 -d'); // config 照写 (落盘等新指纹)
    expect(joined).not.toContain('bootstrap'); // 但不重启 daemon
  });

  it('writes config and rebootstraps once the host has no live turn', async () => {
    const { host, execCmds } = fakeHost('host-defer-idle', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('base64 -d');
    expect(joined).toContain('bootstrap');
    // 原子写 (review P1 回归):decode 到 tmp 后 mv 就位, 不直接截断 config.toml。
    expect(joined).toContain('config.toml.tmp');
    expect(joined).toContain('mv ');
  });

  it('passes the bridge token to daemon bootstrap via stdin, never argv', async () => {
    // sec 回归:token 内联在 bash -c argv 时远端 `ps` 可见;bootstrap 必须经
    // stdin 的 KEY=value 块注入 (secrets only live in stdin)。
    const execCmds: string[] = [];
    const inputs: string[] = [];
    const host = {
      id: 'host-stdin-token',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (opts?.input) inputs.push(opts.input);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
    } as unknown as RemoteHost;

    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    // argv (任何一条 cmd) 都不含 token。
    expect(execCmds.join('\n')).not.toContain('test-persistent-token');
    // bootstrap 的 stdin 是 KEY=value + 空行终止。
    expect(inputs).toContain('LIZI_MCP_TOKEN=test-persistent-token\n\n');
  });

  it('streams the config payload via stdin, never argv (secrets in user config stay out of ps)', async () => {
    // sec 回归 (codex-connector R17 P1):用户 config.toml 可能已含 secret
    // (其他 MCP server 的 bearer / provider token);合并后的整份 config 嵌进
    // bash -c argv 时远端 `ps` / audit log 可回收 — 必须经 stdin 通道写入,
    // 与 bootstrap token 同约束。
    const { host, execCmds, inputs } = fakeHost('host-write-stdin', 'model = "gpt-5.5"\n');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ...bridgeDeps,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const writeCmd = execCmds.find((c) => c.includes('base64 -d'));
    expect(writeCmd).toBeTruthy();
    // argv 里不得出现 config 内容或其 base64 payload。
    expect(writeCmd).not.toContain('cindy-remote-mcp');
    expect(writeCmd!.match(/[A-Za-z0-9+/=]{40,}/g)).toBeNull();
    // payload 确实经 stdin 送达且内容正确。
    const written = decodeWrittenConfig(inputs);
    expect(written).toContain('[mcp_servers.cindy_orca]');
  });
});

describe('ensureRemoteCodexMcpBridge bootstrap retry', () => {
  it('retries bootstrap on next ensure after a failed bootstrap (config already written)', async () => {
    // review P2 回归:首轮 config 写入成功但 bootstrap 超时/中断 → 下轮
    // changed=false + daemonRunning=true, 若无 pending 标记会永远跳过
    // bootstrap, daemon 持旧 env (无 token) 401 且不自愈。
    let bootstrapAttempts = 0;
    let configContent = '';
    const host = {
      id: 'host-bootstrap-retry',
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes(`'version'`)) {
          return { exitCode: 0, stdout: 'ok', stderr: '' }; // 旧 daemon 一直在跑
        }
        if (cmd.includes('bootstrap')) {
          bootstrapAttempts += 1;
          if (bootstrapAttempts === 1) {
            return { exitCode: 1, stdout: '', stderr: 'timed out' }; // 首轮失败
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          // 模拟真实远端:stdin 写入的内容反映到后续读取。
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
    } as unknown as RemoteHost;

    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    };
    const first = await ensureRemoteCodexMcpBridge(host, deps);
    expect(first.ok).toBe(false); // bootstrap 失败折叠为 ok:false
    expect(bootstrapAttempts).toBe(1);

    const second = await ensureRemoteCodexMcpBridge(host, deps);
    expect(second.ok).toBe(true);
    // config 已无漂移 + daemon 在跑, 仍强制重试了 bootstrap (pending 标记)。
    expect(bootstrapAttempts).toBe(2);

    // 成功后标记清除:第三轮不再多 bootstrap。
    const third = await ensureRemoteCodexMcpBridge(host, deps);
    expect(third.ok).toBe(true);
    expect(bootstrapAttempts).toBe(2);
  });
});

describe('ensureRemoteCodexMcpBridge server whitelist', () => {
  it('writes only collab whitelist servers into the remote managed block', async () => {
    // review P1 回归:bridge 上还挂着 cindy_memory / cindy_ssh 等 in-process
    // provider — 全量写进远端 daemon config 会让远端 session 获得本机 MCP
    // 能力, 越出协同边界。远端只注入 cindy_orca / orca_worker_bridge。
    const { host, execCmds, inputs } = fakeHost('host-whitelist', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({
        port: 38080,
        serverNames: ['cindy_orca', 'cindy_memory', 'orca_worker_bridge', 'cindy_ssh'],
        bridgeInstanceId: 'bridge-1',
      }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const written = decodeWrittenConfig(inputs);
    expect(written).not.toBeNull();
    expect(written).toContain('[mcp_servers.cindy_orca]');
    expect(written).toContain('[mcp_servers.orca_worker_bridge]');
    expect(written).not.toContain('cindy_memory');
    expect(written).not.toContain('cindy_ssh');
  });

  it('is a no-op success when the bridge exposes no whitelist server and nothing was ever injected', async () => {
    // collab plugin 禁用 → bridge 上没有 cindy_orca;远端 config 本来就没
    // 注入过 → merge('') 无漂移:不写 config, 不重启 daemon。
    const { host, execCmds } = fakeHost('host-no-whitelist', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).not.toContain('base64 -d');
    expect(joined).not.toContain('bootstrap');
  });

  it('clears a stale managed block and rebootstraps when collab gets disabled after a prior injection', async () => {
    // review P2 回归:之前注入过的 host 上 collab 被禁用 (白名单为空) 时,
    // 不能早退 — 旧受管段必须剥除并重启 daemon (清掉 token env 与死配置),
    // 否则远端 session 继续调用已失效的 MCP endpoint。
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    const existing = `model = "gpt-5.5"\n\n${stale}\n`;
    const { host, execCmds, inputs } = fakeHost('host-cleanup', existing);
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('base64 -d'); // 写了清理后的 config
    expect(joined).toContain('bootstrap'); // 重启 daemon 清 env
    const written = decodeWrittenConfig(inputs);
    expect(written).not.toBeNull();
    expect(written).not.toContain('cindy-remote-mcp'); // 受管段已剥除
    expect(written).toContain('model = "gpt-5.5"'); // 用户配置保留
  });

  it('rebootstraps when the bridge instance is recreated with the same token and port', async () => {
    // review P2 回归:bridge 重建后旧 mcp-session-id 全失效, 但 token
    // (persistent) 与端口 (per-host 固定) 不变 — 代际 id 必须进漂移指纹,
    // 否则常驻 daemon 持旧 id 打新 bridge 全部 404。
    const { host: host1, inputs: inputs1 } = fakeHost('host-regen', '');
    const deps = (instanceId: string) => ({
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: instanceId }),
      hasLiveTurnOnHost: () => false,
    });
    const first = await ensureRemoteCodexMcpBridge(host1, deps('bridge-1'));
    expect(first.ok).toBe(true);
    const writtenFirst = decodeWrittenConfig(inputs1);
    expect(writtenFirst).toContain('# cindy-token-fingerprint:');

    // 远端 config 已是 bridge-1 指纹;bridge 重建 (bridge-2) → 指纹漂移 →
    // 重写 config 并再 bootstrap (daemon 仍存活, changed 是唯一触发)。
    const { host: host2, execCmds: execCmds2, inputs: inputs2 } = fakeHost('host-regen', writtenFirst ?? '');
    const second = await ensureRemoteCodexMcpBridge(host2, deps('bridge-2'));
    expect(second.ok).toBe(true);
    const joined2 = execCmds2.join('\n');
    expect(joined2).toContain('base64 -d');
    expect(joined2).toContain('bootstrap');
    // 幂等对照:同代际重复 ensure 不触发重写/重启。
    const { host: host3, execCmds: execCmds3 } = fakeHost('host-regen', decodeWrittenConfig(inputs2) ?? '');
    const third = await ensureRemoteCodexMcpBridge(host3, deps('bridge-2'));
    expect(third.ok).toBe(true);
    const joined3 = execCmds3.join('\n');
    expect(joined3).not.toContain('base64 -d');
    expect(joined3).not.toContain('bootstrap');
  });
});

describe('ensureRemoteCodexMcpBridge drift self-heal (appliedFingerprint)', () => {

  it('bootstraps on the next ensure once the live turn settles (deferred drift stays persistent)', async () => {
    // defer 语义回归:live turn 期间 config 照写但 bootstrap 推迟;漂移未生效
    // 是持久指纹事实 — turn 结束 (hasLiveTurn=false) 后的 ensure 即使
    // changed=false 也必然补刀 (turn-done 挂钩 / 下次 session start)。
    let configContent = '';
    const execCmds: string[] = [];
    const host = {
      id: 'host-defer-heal',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47923,
        close: async () => {},
      }),
    } as unknown as RemoteHost;
    const deps = (live: boolean) => ({
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => live,
    });

    const first = await ensureRemoteCodexMcpBridge(host, deps(true));
    expect(first.ok).toBe(true);
    expect(execCmds.join('\n')).not.toContain('bootstrap'); // live: 推迟重启
    expect(prefsOf('host-defer-heal')?.appliedFingerprint).toBeUndefined(); // 未生效不落盘

    const second = await ensureRemoteCodexMcpBridge(host, deps(false));
    expect(second.ok).toBe(true);
    expect(execCmds.join('\n')).toContain('bootstrap'); // idle: 持久漂移驱动补刀
    expect(prefsOf('host-defer-heal')?.appliedFingerprint).toBeTruthy(); // 生效后落盘
  });

  it('retries bootstrap after an app restart even when config is unchanged (Greptile P1)', async () => {
    // Greptile P1 回归:config 已写入 + bootstrap 失败 + app 重启 → 进程内
    // pending 全丢, 但 appliedFingerprint 持久缺失 ⇒ driftUnapplied 仍成立,
    // 下次 ensure (changed=false + 旧 daemon 在跑) 强制重试 bootstrap,
    // daemon 不会永远持旧 token 401。
    let bootstrapAttempts = 0;
    let configContent = '';
    const makeHost = () =>
      ({
        id: 'host-restart-heal',
        exec: async (cmd: string, opts?: { input?: string }) => {
          if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
            return { exitCode: 0, stdout: configContent, stderr: '' };
          }
          if (cmd.includes('bootstrap')) {
            bootstrapAttempts += 1;
            if (bootstrapAttempts === 1) {
              return { exitCode: 1, stdout: '', stderr: 'timed out' }; // 首轮失败
            }
            return { exitCode: 0, stdout: 'ok', stderr: '' };
          }
          if (cmd.includes('base64 -d')) {
            const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
            if (written !== null) configContent = written;
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
        ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
          remotePort: spec.preferredRemotePort ?? 47924,
          close: async () => {},
        }),
      }) as unknown as RemoteHost;
    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    };

    const first = await ensureRemoteCodexMcpBridge(makeHost(), deps);
    expect(first.ok).toBe(false); // bootstrap 失败折叠
    expect(bootstrapAttempts).toBe(1);

    // 模拟 app 重启:模块状态 (串行锁 / prefs cache) 全清, prefs 文件保留。
    vi.resetModules();
    const fresh = await import('../codex-remote-mcp.js');
    const second = await fresh.ensureRemoteCodexMcpBridge(makeHost(), deps);
    expect(second.ok).toBe(true);
    expect(bootstrapAttempts).toBe(2); // appliedFingerprint 缺失 ⇒ 强制重试
  });

  it('clears appliedFingerprint after the cleanup-path bootstrap so later ensures stay quiet', async () => {
    // 清理路径:受管段剥除 + bootstrap (清 daemon env) 后 applied 记录摘除 —
    // 否则 desiredFingerprint=null 与残留 applied 恒不等, 之后每次 ensure
    // 都会无谓重启 daemon。
    const stale = renderManagedMcpBlock({ remotePort: 47925, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    const { host, execCmds } = fakeHost('host-cleanup-quiet', `model = "gpt-5.5"\n\n${stale}\n`);
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    expect(execCmds.join('\n')).toContain('bootstrap');
    expect(prefsOf('host-cleanup-quiet')?.appliedFingerprint).toBeUndefined();

    // 下轮 ensure:无受管段、无 applied、desired=null → 静默, 不再 bootstrap。
    const execCmds2: string[] = [];
    const host2 = {
      id: 'host-cleanup-quiet',
      exec: async (cmd: string) => {
        execCmds2.push(cmd);
        return { exitCode: 0, stdout: 'model = "gpt-5.5"\n', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47925,
        close: async () => {},
      }),
    } as unknown as RemoteHost;
    const second = await ensureRemoteCodexMcpBridge(host2, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(second.ok).toBe(true);
    expect(execCmds2.join('\n')).not.toContain('bootstrap');
  });
});

describe('daemon bootstrap env parity (codex-connector R18 P1)', () => {
  it('sources the agent-proxy env marker in the MCP bootstrap wrapper', async () => {
    // daemon 的两条启动路径 (transport bootstrap / 本模块 MCP bootstrap)
    // 必须产出一致 env:bootstrap cmd 必须 source proxy marker — 否则本路径
    // 重启的 daemon 丢 proxy env, 且 marker 内容未变时 proxy reconcile 走
    // fast path 不再纠正, 远端流量永久旁路用户 proxy。
    const { host, execCmds } = fakeHost('host-proxy-env-parity', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const bootstrapCmd = execCmds.find((c) => c.includes('bootstrap'));
    expect(bootstrapCmd).toBeTruthy();
    expect(bootstrapCmd).toContain('agent-proxy.env');
  });
});

describe('codex-connector R19 regressions', () => {
  it('retries bootstrap after a port rebind + failed bootstrap (applied fingerprint tracks remotePort)', async () => {
    // R19 P1 回归:applied 指纹必须含 remotePort — 端口重绑 + bootstrap
    // 失败后 config 已是新 URL (changed=false), 若指纹不含端口则
    // driftUnapplied 漏判, daemon 永远拿旧 URL。
    let port = 47921;
    let bootstrapAttempts = 0;
    let configContent = '';
    const host = {
      id: 'host-port-drift',
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('bootstrap')) {
          bootstrapAttempts += 1;
          if (bootstrapAttempts === 2) {
            return { exitCode: 1, stdout: '', stderr: 'timed out' }; // 重绑后那次失败
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async () => ({ remotePort: port, close: async () => {} }),
    } as unknown as RemoteHost;
    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    };

    expect((await ensureRemoteCodexMcpBridge(host, deps)).ok).toBe(true);
    expect(bootstrapAttempts).toBe(1); // 首轮 47921 注入成功

    port = 47930; // 模拟重连重绑新端口
    expect((await ensureRemoteCodexMcpBridge(host, deps)).ok).toBe(false);
    expect(bootstrapAttempts).toBe(2); // 重绑后 bootstrap 失败

    // changed=false (config 已是 47930) 但 desired(含 47930) ≠ applied(含 47921)
    expect((await ensureRemoteCodexMcpBridge(host, deps)).ok).toBe(true);
    expect(bootstrapAttempts).toBe(3); // 指纹端口成分驱动强制重试
  });

  it('closes the stale forward when the bridge local port changes (R19 P2)', async () => {
    const closeCalls: Array<{ addr: string; port: number }> = [];
    let configContent = '';
    const host = {
      id: 'host-stale-forward',
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
      closeRemoteForward: async (addr: string, port: number) => {
        closeCalls.push({ addr, port });
      },
    } as unknown as RemoteHost;
    const deps = (bridgePort: number, instanceId: string) => ({
      ensureBridgeStarted: async () => ({ port: bridgePort, serverNames: SERVERS, bridgeInstanceId: instanceId }),
      hasLiveTurnOnHost: () => false,
    });

    await ensureRemoteCodexMcpBridge(host, deps(38080, 'bridge-1'));
    expect(closeCalls).toHaveLength(0); // 首次无旧目标可拆

    await ensureRemoteCodexMcpBridge(host, deps(38081, 'bridge-2')); // bridge 重建换端口
    expect(closeCalls).toEqual([{ addr: '127.0.0.1', port: 38080 }]); // 旧 forward 被拆

    await ensureRemoteCodexMcpBridge(host, deps(38081, 'bridge-2'));
    expect(closeCalls).toHaveLength(1); // 同端口不再误拆
  });

  it('cleans the stale managed block when the token is lost after a prior injection (R19 P2)', async () => {
    // token 不可用但注入过:旧 config/env 会让远端持续 401 — 按清理路径
    // 剥段 + 清 env + 摘除 applied;token 恢复后可重新注入。
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    let configContent = `model = "gpt-5.5"\n\n${stale}\n`;
    const execCmds: string[] = [];
    const host = {
      id: 'host-token-lost',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
    } as unknown as RemoteHost;
    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    };

    // 先成功注入 (appliedFingerprint 落盘)。
    expect((await ensureRemoteCodexMcpBridge(host, deps)).ok).toBe(true);
    expect(prefsOf('host-token-lost')?.appliedFingerprint).toBeTruthy();

    // token 失效 (safeStorage 不可用 / 轮换重写失败)。
    const tokenMock = vi.mocked(getRemoteMcpBridgeToken);
    tokenMock.mockReturnValueOnce(null);
    const result = await ensureRemoteCodexMcpBridge(host, deps);
    expect(result.ok).toBe(true); // 清理路径按成功收尾
    const joined = execCmds.join('\n');
    expect(joined).toContain('bootstrap'); // 清 env
    expect(configContent).not.toContain('cindy-remote-mcp'); // 受管段已剥除
    expect(prefsOf('host-token-lost')?.appliedFingerprint).toBeUndefined(); // applied 摘除
  });

  it('returns token-unavailable without cleanup when the host was never injected', async () => {
    const tokenMock = vi.mocked(getRemoteMcpBridgeToken);
    tokenMock.mockReturnValueOnce(null);
    const { host, execCmds } = fakeHost('host-token-never', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('token-unavailable');
    expect(execCmds.join('\n')).not.toContain('bootstrap'); // 无清理对象不动作
  });
});

describe('codex-connector R20 regressions', () => {
  it('cleanup path does not arm a forward, releases the stale one, and survives forward rejection (R20 P2)', async () => {
    // 清理路径 (collab 禁用/token 失效) 剥 config + 清 env 都不经隧道:
    // 不 arm 新 forward (forward 被拒不该阻断清理), 有旧 forward 则拆。
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    let configContent = `model = "gpt-5.5"\n\n${stale}\n`;
    const execCmds: string[] = [];
    const closeCalls: Array<{ addr: string; port: number }> = [];
    const host = {
      id: 'host-cleanup-noforward',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async () => {
        throw new Error('forwardIn rejected: administratively prohibited'); // arm 被拒
      },
      closeRemoteForward: async (addr: string, port: number) => {
        closeCalls.push({ addr, port });
      },
    } as unknown as RemoteHost;
    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    };

    // 先注入成功 (留下 bridgeLocalPort 记录) — 需要一个能 arm 的 fake。
    const hostForInject = {
      id: 'host-cleanup-noforward',
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
    } as unknown as RemoteHost;
    expect((await ensureRemoteCodexMcpBridge(hostForInject, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    })).ok).toBe(true);
    expect(prefsOf('host-cleanup-noforward')?.bridgeLocalPort).toBe(38080);

    // collab 禁用 (serverNames 空):forward 被拒也不阻断清理, 旧 forward 被拆。
    const result = await ensureRemoteCodexMcpBridge(host, deps);
    expect(result.ok).toBe(true);
    expect(execCmds.join('\n')).toContain('bootstrap'); // 清 env 完成
    expect(configContent).not.toContain('cindy-remote-mcp'); // 受管段剥除
    expect(closeCalls).toEqual([{ addr: '127.0.0.1', port: 38080 }]); // 旧 forward 拆除
    expect(prefsOf('host-cleanup-noforward')?.bridgeLocalPort).toBeUndefined();
  });

  it('writes the remote config with umask 077 (R20 P2: secrets stay unreadable to other local users)', async () => {
    const { host, execCmds } = fakeHost('host-config-umask', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    const writeCmd = execCmds.find((c) => c.includes('base64 -d'));
    expect(writeCmd).toBeTruthy();
    expect(writeCmd).toContain('umask 077');
  });

  it('strips the managed block and rebootstraps when collab is globally disabled (R20 P2)', async () => {
    // provider 层为工具面稳定在 collab 禁用时仍注册 cindy_orca — bridge
    // 名单不反映开关, 远端注入必须以全局闸门为准: 禁用即清理。
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    let configContent = `model = "gpt-5.5"\n\n${stale}\n`;
    const execCmds: string[] = [];
    const host = {
      id: 'host-collab-gate',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
      closeRemoteForward: async () => {},
    } as unknown as RemoteHost;

    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
      isCollabEnabled: () => false, // 全局禁用
    });
    expect(result.ok).toBe(true);
    expect(execCmds.join('\n')).toContain('bootstrap');
    expect(configContent).not.toContain('cindy-remote-mcp'); // 剥段
    expect(configContent).toContain('model = "gpt-5.5"'); // 用户配置保留
  });
});

describe('codex-connector R21 regressions', () => {
  it('does not release the forward while a live turn defers cleanup; releases after the turn settles (R21 P2)', async () => {
    // R20-1 把拆 forward 放进清理路径, 但拆在 live-turn defer 判定之前 —
    // turn 中 daemon 内存 config 仍指该端口, 早拆 = connection refused。
    // 修正:bootstrap (清理真正生效) 时才拆。
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    let configContent = `model = "gpt-5.5"\n\n${stale}\n`;
    const closeCalls: Array<{ addr: string; port: number }> = [];
    const host = {
      id: 'host-defer-norelease',
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
      closeRemoteForward: async (addr: string, port: number) => {
        closeCalls.push({ addr, port });
      },
    } as unknown as RemoteHost;
    const deps = (live: boolean) => ({
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => live,
    });

    // 先注入 (留下 bridgeLocalPort)。
    const hostForInject = {
      ...host,
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    } as unknown as RemoteHost;
    expect((await ensureRemoteCodexMcpBridge(hostForInject, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    })).ok).toBe(true);

    // live turn 中的清理:config 剥除但不 bootstrap、不拆 forward。
    const first = await ensureRemoteCodexMcpBridge(host, deps(true));
    expect(first.ok).toBe(true);
    expect(closeCalls).toHaveLength(0);

    // turn 结束后:bootstrap 生效 + forward 拆除。
    const second = await ensureRemoteCodexMcpBridge(host, deps(false));
    expect(second.ok).toBe(true);
    expect(closeCalls).toEqual([{ addr: '127.0.0.1', port: 38080 }]);
  });

  it('stripRemoteCodexMcpConfig strips the block, clears env, and skips entirely during a live turn (R21 P1)', async () => {
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    let configContent = `model = "gpt-5.5"\n\n${stale}\n`;
    const execCmds: string[] = [];
    const host = {
      id: 'host-strip-shutdown',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
      closeRemoteForward: async () => {},
    } as unknown as RemoteHost;

    // 先注入成功。
    expect((await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    })).ok).toBe(true);
    expect(prefsOf('host-strip-shutdown')?.appliedFingerprint).toBeTruthy();
    execCmds.length = 0;

    // live turn 中 strip:整体跳过 (不写不重启)。
    const liveStrip = await stripRemoteCodexMcpConfig(host, { hasLiveTurnOnHost: () => true });
    expect(liveStrip.daemonRebootstrapped).toBe(false);
    expect(execCmds.join('\n')).not.toContain('base64 -d');
    expect(execCmds.join('\n')).not.toContain('bootstrap');

    // idle 后 strip:剥段 + bootstrap 清 env + applied 摘除。
    const idleStrip = await stripRemoteCodexMcpConfig(host, { hasLiveTurnOnHost: () => false });
    expect(idleStrip.daemonRebootstrapped).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('base64 -d');
    expect(joined).toContain('bootstrap');
    expect(configContent).not.toContain('cindy-remote-mcp');
    expect(configContent).toContain('model = "gpt-5.5"');
    expect(prefsOf('host-strip-shutdown')?.appliedFingerprint).toBeUndefined();
  });
});

describe('hasPendingRemoteMcpDrift (R23 P1 lightweight live-send gate)', () => {
  const base = { collabEnabled: true, token: 'tok', bridgeInstanceId: 'bridge-1' };

  it('is true when the host was never injected (no applied fingerprint)', () => {
    expect(hasPendingRemoteMcpDrift('host-drift-new', base)).toBe(true);
  });

  it('is false once the applied fingerprint matches the full desired state', async () => {
    const { host } = fakeHost('host-drift-match', '');
    await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(hasPendingRemoteMcpDrift('host-drift-match', {
      collabEnabled: true,
      token: 'test-persistent-token',
      bridgeInstanceId: 'bridge-1',
    })).toBe(false);
    expect(hasPendingRemoteMcpDrift('host-drift-match', {
      collabEnabled: true,
      token: 'test-persistent-token',
      bridgeInstanceId: 'bridge-2',
    })).toBe(true);
  });

  it('is true after a bridge shutdown strip (applied cleared) when collab stays enabled', async () => {
    const { host } = fakeHost('host-drift-strip', '');
    await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    await stripRemoteCodexMcpConfig(host, { hasLiveTurnOnHost: () => false });
    expect(hasPendingRemoteMcpDrift('host-drift-strip', {
      collabEnabled: true,
      token: 'test-persistent-token',
      bridgeInstanceId: null,
    })).toBe(true);
  });

  it('follows cleanup semantics when collab is disabled or token is missing', async () => {
    const { host } = fakeHost('host-drift-collab-off', '');
    await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(hasPendingRemoteMcpDrift('host-drift-collab-off', { ...base, collabEnabled: false })).toBe(true);
    expect(hasPendingRemoteMcpDrift('host-drift-collab-off', { ...base, token: null })).toBe(true);
    await stripRemoteCodexMcpConfig(host, { hasLiveTurnOnHost: () => false });
    expect(hasPendingRemoteMcpDrift('host-drift-collab-off', { ...base, collabEnabled: false })).toBe(false);
  });
});

describe('codex-connector R24 regressions', () => {
  it('readConfigCmd only suppresses the missing-file case and propagates other read failures (R24 P2)', async () => {
    // cat 失败 (权限 / 瞬时 IO) 不得被当「文件缺席」— 否则 merge/write 把
    // 用户已有 config (含 secret) 整个替换成只剩受管段 (数据丢失类)。
    const { host, execCmds } = fakeHost('host-read-perm-fail', '');
    // fake exec 对 read 返回权限错误 (exit!=0)。
    (host as { exec: (cmd: string, opts?: { input?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }> }).exec =
      async (cmd: string) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 1, stdout: '', stderr: 'cat: config.toml: Permission denied' };
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      };

    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(false); // 读失败折叠为失败, 不进入写路径
    expect(result.reason).toContain('read remote config.toml failed');
    expect(execCmds.join('\n')).not.toContain('base64 -d'); // 没写任何东西

    // cmd 形态:有 -f 存在性检查, 不再 2>/dev/null || true 吞错。
    const readCmd = execCmds.find((c) => c.includes('cat "$CODEX_HOME/config.toml"'));
    expect(readCmd).toContain('[ -f "$CODEX_HOME/config.toml" ]');
    expect(readCmd).not.toContain('|| true');
  });
});

describe('codex-connector R27 regressions', () => {
  it('runs cleanup-only strip when the bridge is unavailable but the host was previously injected (R27 P2)', async () => {
    const stale = renderManagedMcpBlock({ remotePort: 47921, serverNames: SERVERS, tokenFingerprint: 'fp-old' });
    let configContent = `model = "gpt-5.5"\n\n${stale}\n`;
    const execCmds: string[] = [];
    const host = {
      id: 'host-bridge-down-cleanup',
      exec: async (cmd: string, opts?: { input?: string }) => {
        execCmds.push(cmd);
        if (cmd.includes('cat "$CODEX_HOME/config.toml"')) {
          return { exitCode: 0, stdout: configContent, stderr: '' };
        }
        if (cmd.includes('base64 -d')) {
          const written = decodeWrittenConfig(opts?.input ? [opts.input] : []);
          if (written !== null) configContent = written;
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ensureRemoteForward: async (spec: { localHost: string; localPort: number; preferredRemotePort?: number }) => ({
        remotePort: spec.preferredRemotePort ?? 47921,
        close: async () => {},
      }),
      closeRemoteForward: async () => {},
    } as unknown as RemoteHost;

    expect((await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: SERVERS, bridgeInstanceId: 'bridge-1' }),
      hasLiveTurnOnHost: () => false,
    })).ok).toBe(true);
    expect(prefsOf('host-bridge-down-cleanup')?.appliedFingerprint).toBeTruthy();
    execCmds.length = 0;

    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => null,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(true);
    expect(result.daemonRebootstrapped).toBe(true);
    const joined = execCmds.join('\n');
    expect(joined).toContain('base64 -d');
    expect(joined).toContain('bootstrap');
    expect(configContent).not.toContain('cindy-remote-mcp');
    expect(prefsOf('host-bridge-down-cleanup')?.appliedFingerprint).toBeUndefined();
  });

  it('still returns bridge-unavailable when the bridge is down and there is nothing to clean', async () => {
    const { host, execCmds } = fakeHost('host-bridge-down-virgin', '');
    const result = await ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: async () => null,
      hasLiveTurnOnHost: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bridge-unavailable');
    expect(execCmds.join('\n')).not.toContain('bootstrap');
  });
});
