import { describe, expect, it } from 'vitest';
import {
  createSessionTerminator,
  parseAcceptedPublickeyLog,
  parseProcessTable,
  type SessionTerminatorPorts,
  type SshProcess,
} from '../sessionTerminator.js';

// 测试价值
// - 生产入口与可观察结果：createSessionTerminator 的 terminateFingerprints / terminateAll，经注入的进程表、环境与 sshd 日志
//   断言实际被发信号的 PID。结束错误的进程（root、别的用户、守护进程、Cindy 自己所在的会话）是不可撤销的。
//   endsKeySessions 是设置页撤销设备前读的同一能力，必须与 terminateFingerprints 的 supported 一致。
// - Bug／规则依据：决定 11（优先 SSH_USER_AUTH，其次 sshd 日志；只结束同用户、名为 `sshd: <user>@…` / `sshd-session: <user>@…`
//   的子进程；映射不到的只报告，不自动全部结束）。
// - 现有覆盖缺口：新模块。
// - 最小失败输入：OpenSSH 9.6（`sshd[pid]`）与 9.8+（`sshd-session[pid]`）日志；同指纹的另一用户会话；进程号在列表与发信号
//   之间换了进程；以 root 运行的 Linux 仍声称能按设备断开会话。
// - tier：unit（纯内存夹具，无真实进程，单文件 <1s）。
const FP_A = 'SHA256:djvBZ5K68oGMBtD5pFWRAPELgttcdadkztqINg63Joc';
const FP_B = 'SHA256:mPr78KSflLHkRNgS3SpYoVqLKVcOT11nnMVTK+2G96Q';
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7';

const PS_96 = `
    1     0    0 /sbin/init
  800     1    0 sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups
 1000   800    0 sshd: ubuntu [priv]
 1001  1000 1000 sshd: ubuntu@pts/0
 1002  1001 1000 -bash
 1100   800    0 sshd: ubuntu [priv]
 1101  1100 1000 sshd: ubuntu@notty
 1102  1101 1000 /usr/lib/openssh/sftp-server
 1200   800    0 sshd: alice [priv]
 1201  1200 1001 sshd: alice@pts/1
 1300   800    0 sshd: ubuntu [priv]
 1301  1300 1000 sshd: ubuntu@pts/2
 1302  1301 1000 -bash
 1303  1302 1000 node cindy-host serve
 1400   800    0 sshd: ubuntu [priv]
 1401  1400 1000 sshd: ubuntu@pts/3
 1500   800    0 sshd: root@pts/4
`;
const LOG_96 = [
  `Nov 26 10:00:02 cloud sshd[1100]: Accepted publickey for ubuntu from 10.0.0.3 port 51001 ssh2: ED25519 ${FP_B}`,
  `Nov 26 10:00:03 cloud sshd[1200]: Accepted publickey for alice from 10.0.0.4 port 51002 ssh2: ED25519 ${FP_A}`,
  `Nov 26 10:00:04 cloud sshd[1300]: Accepted publickey for ubuntu from 10.0.0.5 port 51003 ssh2: ED25519 ${FP_A}`,
].join('\n');

/**
 * `reads[i]` shapes the i-th process table read: 0 = mapping, 1 = just before SIGTERM, 2 = after the grace period.
 * By default the table is unchanged until a signal, after which signalled sessions are gone.
 */
function harness(options: { table: string; log?: string; environ?: Record<number, string>; authInfo?: Record<string, string>;
  platform?: string; uid?: number; reads?: Array<(table: SshProcess[]) => SshProcess[]> }) {
  const table = parseProcessTable(options.table);
  const signals: Array<[number, string]> = [];
  let reads = 0;
  const ports: SessionTerminatorPorts = {
    platform: options.platform ?? 'linux',
    user: 'ubuntu',
    uid: options.uid ?? 1000,
    selfPid: 1303,
    listProcesses: async () => {
      const shape = options.reads?.[reads];
      reads += 1;
      if (shape) return shape(table);
      return signals.length ? table.filter((row) => !signals.some(([pid]) => pid === row.pid)) : table;
    },
    readEnviron: async (pid) => options.environ?.[pid] ?? null,
    readAuthInfo: async (file) => options.authInfo?.[file] ?? null,
    readAuthLog: async () => options.log ?? '',
    kill: (pid, signal) => { signals.push([pid, signal]); },
    wait: async () => undefined,
  };
  return { terminator: createSessionTerminator(ports), signals };
}

describe('session terminator', () => {
  it('ends only same-user sessions of the removed key, preferring SSH_USER_AUTH, and reports sessions it cannot map', async () => {
    const { terminator, signals } = harness({
      table: PS_96,
      log: LOG_96,
      environ: { 1002: 'HOME=/home/ubuntu\0SSH_USER_AUTH=/tmp/sshauth.Ab12Cd\0' },
      authInfo: { '/tmp/sshauth.Ab12Cd': `publickey ${KEY_A}\n` },
    });
    const report = await terminator.terminateFingerprints(new Set([FP_A]));
    // 1001 via SSH_USER_AUTH; alice's 1201 has the same key in the log but another uid; 1301 is Cindy's own session;
    // 1101 used another key; 1401 has no auth info and no log line; root's session and the daemon are never candidates.
    expect(signals).toEqual([[1001, 'SIGTERM']]);
    expect(report).toEqual({ supported: true, terminated: 1, unmapped: 1 });
  });

  it('maps OpenSSH 9.8+ sshd-session processes through the log of their monitor', async () => {
    const table = `
 2000   800    0 sshd-session: ubuntu [priv]
 2001  2000 1000 sshd-session: ubuntu@pts/0
 2100   800    0 sshd-session: ubuntu [priv]
 2101  2100 1000 sshd-session: ubuntu@notty
`;
    const log = [
      `2026-11-26T10:00:01.000000+08:00 cloud sshd-session[2000]: Accepted publickey for ubuntu from 10.0.0.2 port 50000 ssh2: ED25519 ${FP_B}`,
      `2026-11-26T10:00:02.000000+08:00 cloud sshd-session[2100]: Accepted publickey for ubuntu from 10.0.0.2 port 50001 ssh2: ED25519 ${FP_A}`,
    ].join('\n');
    const { terminator, signals } = harness({ table, log });
    expect(await terminator.terminateFingerprints(new Set([FP_B]))).toEqual({ supported: true, terminated: 1, unmapped: 0 });
    expect(signals).toEqual([[2001, 'SIGTERM']]);
  });

  it('does not signal a PID that became another process before the signal, and follows up with SIGKILL only on survivors', async () => {
    const same = (table: SshProcess[]) => table;
    // Between the mapping read and the signal, 1101 exited and its PID was reused by another session.
    const reused = harness({ table: PS_96, log: LOG_96,
      reads: [same, (table) => table.map((row) => (row.pid === 1101 ? { ...row, command: 'sshd: ubuntu@pts/9' } : row))] });
    expect(await reused.terminator.terminateFingerprints(new Set([FP_B]))).toMatchObject({ terminated: 0 });
    expect(reused.signals).toEqual([]);
    // Still there after SIGTERM → SIGKILL.
    const stubborn = harness({ table: PS_96, log: LOG_96, reads: [same, same, same] });
    await stubborn.terminator.terminateFingerprints(new Set([FP_B]));
    expect(stubborn.signals).toEqual([[1101, 'SIGTERM'], [1101, 'SIGKILL']]);
  });

  it('ends every same-user session on request, except the one Cindy runs in, and never as root', async () => {
    const all = harness({ table: PS_96 });
    expect(await all.terminator.terminateAll()).toEqual({ supported: true, terminated: 3, unmapped: 0 });
    expect(all.signals.map(([pid]) => pid)).toEqual([1001, 1101, 1401]);
    expect(await harness({ table: PS_96, uid: 0 }).terminator.terminateAll()).toMatchObject({ supported: false, terminated: 0 });
    expect(await harness({ table: PS_96, platform: 'darwin' }).terminator.terminateFingerprints(new Set([FP_A])))
      .toEqual({ supported: false, terminated: 0, unmapped: 0 });
    expect(await harness({ table: PS_96, platform: 'win32' }).terminator.terminateAll()).toMatchObject({ supported: false });
    // The capability the settings UI reads before a revocation is the one that decides terminateFingerprints.
    expect(all.terminator.endsKeySessions).toBe(true);
    for (const options of [{ uid: 0 }, { platform: 'darwin' }, { platform: 'win32' }]) {
      const other = harness({ table: PS_96, ...options });
      expect(other.terminator.endsKeySessions).toBe(false);
      expect(await other.terminator.terminateFingerprints(new Set([FP_A]))).toMatchObject({ supported: false });
    }
  });

  it('keeps only the last accepted line per monitor and only for Cindy\'s user', () => {
    const log = [
      `sshd[10]: Accepted publickey for ubuntu from 1.1.1.1 port 1 ssh2: ED25519 ${FP_A}`,
      `sshd[10]: Accepted publickey for ubuntu from 1.1.1.1 port 2 ssh2: ED25519-CERT ${FP_B} ID cert (serial 1) CA ED25519 SHA256:x`,
      `sshd[11]: Accepted publickey for ubuntu2 from 1.1.1.1 port 3 ssh2: ED25519 ${FP_A}`,
      `sshd[12]: Accepted password for ubuntu from 1.1.1.1 port 4 ssh2`,
    ].join('\n');
    expect([...parseAcceptedPublickeyLog(log, 'ubuntu')]).toEqual([[10, FP_B]]);
  });
});
