/**
 * host-daemons 平台来源的解析层。
 *
 * 这层是唯一的「平台文本 → 条目」入口。macOS 本机没有环境，只用真实样例文本锁住
 * 解析；Linux 侧在 WSL2 Ubuntu 上做过真实的 systemd / crontab 建、跑、停、删验证。
 */

import { describe, expect, it } from 'vitest';

import {
  createCrontabAdapter,
  cronEntryId,
  parseCronLine,
  parseCrontab,
  removeCronLine,
} from '../crontab.js';
import {
  parseLaunchAgentPlist,
  parseLaunchctlList,
  toHostDaemonTrigger,
} from '../launchAgents.js';
import { parseSystemdListUnits, parseSystemdUnitFile, stateOf } from '../systemdUser.js';

describe('launchd', () => {
  it('按 plutil 真实输出取 Label、命令与触发', () => {
    const plist = parseLaunchAgentPlist(
      JSON.stringify({
        Label: 'com.cindy.backup',
        ProgramArguments: ['/usr/bin/env', 'node', '/tmp/backup.mjs'],
        StartInterval: 3600,
      }),
      'fallback.plist',
    );
    expect(plist).toEqual({
      label: 'com.cindy.backup',
      command: '/usr/bin/env node /tmp/backup.mjs',
      runAtLoad: false,
      timeTriggered: true,
    });
    expect(toHostDaemonTrigger(plist!)).toBe('schedule');
  });

  it('Program 优先于 ProgramArguments；RunAtLoad 记为登录启动', () => {
    const plist = parseLaunchAgentPlist(
      JSON.stringify({ Program: '/usr/local/bin/tool', ProgramArguments: ['ignored', 'x'], RunAtLoad: true }),
      'fallback.plist',
    );
    expect(plist?.command).toBe('/usr/local/bin/tool');
    expect(toHostDaemonTrigger(plist!)).toBe('logon');
  });

  it('没有 Label 时退回文件名，坏 JSON 直接丢弃', () => {
    expect(parseLaunchAgentPlist('{"RunAtLoad":true}', 'com.a.plist')?.label).toBe('com.a.plist');
    expect(parseLaunchAgentPlist('not json', 'com.a.plist')).toBeNull();
  });

  it('launchctl list 用 `-` 表示未运行，并跳过表头', () => {
    const jobs = parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.cindy.a\n-\t0\tcom.cindy.b\n');
    expect(jobs.get('com.cindy.a')).toEqual({ running: true });
    expect(jobs.get('com.cindy.b')).toEqual({ running: false });
    expect(jobs.has('Label')).toBe(false);
  });
});

describe('systemd 用户单元', () => {
  it('剥掉 systemd 的 ExecStart 前缀并取时间表达式', () => {
    const file = parseSystemdUnitFile(
      [
        '[Unit]',
        'Description=Daily backup',
        '# comment',
        '',
        '[Service]',
        'ExecStart=-/usr/bin/node /tmp/backup.mjs',
        '[Timer]',
        'OnCalendar=*-*-* 04:00:00',
      ].join('\n'),
    );
    expect(file.execStart).toBe('/usr/bin/node /tmp/backup.mjs');
    expect(file.description).toBe('Daily backup');
    expect(file.schedule).toBe('OnCalendar=*-*-* 04:00:00');
  });

  it('list-units 跳过表头与无效行（真实 Ubuntu WSL 输出，带引号描述）', () => {
    // 取自 WSL2 Ubuntu 里 `systemctl --user list-units --type=service --type=timer
    // --all --plain --no-legend` 的原始输出：列是 NAME/LOAD/ACTIVE/SUB/DESCRIPTION，
    // 描述里的引号与空格会把「按空白切分」的实现带偏。
    const units = parseSystemdListUnits(
      [
        'cindy-probe.service              loaded active   running Cindy host-daemon probe',
        'gpg-agent.service                loaded inactive dead    GnuPG cryptographic agent and passphrase cache',
        'ubuntu-insights-collect.service  loaded inactive dead    "Collect platform report using Ubuntu Insights while respecting consent"',
        'cindy-probe.timer                loaded active   waiting Cindy host-daemon probe timer',
        'UNIT FILE STATE ACTIVE SUB DESCRIPTION',
        'junk-line',
      ].join('\n'),
    );
    expect(units.get('cindy-probe.service')).toEqual({ active: 'active', sub: 'running' });
    expect(units.get('cindy-probe.timer')).toEqual({ active: 'active', sub: 'waiting' });
    expect(units.get('gpg-agent.service')).toEqual({ active: 'inactive', sub: 'dead' });
    expect(units.size).toBe(4);
  });

  it('timer 条目跟随它 service 的运行状态，等待触发不算正在运行', () => {
    // WSL 实测：`systemctl --user start foo.service` 后 timer 仍是 waiting，
    // 只看 timer 自己的 active 会让「立即运行」后状态永远停在待执行。
    const runtime = new Map([
      ['cindy-probe.timer', { active: 'active', sub: 'waiting' }],
      ['cindy-probe.service', { active: 'active', sub: 'running' }],
    ]);
    expect(stateOf('cindy-probe.timer', runtime)).toBe('running');
    runtime.set('cindy-probe.service', { active: 'inactive', sub: 'dead' });
    expect(stateOf('cindy-probe.timer', runtime)).toBe('ready');
    expect(stateOf('cindy-probe.timer', new Map())).toBe('ready');
  });
});

describe('crontab', () => {
  it('跳过注释与环境变量，解析五字段与 @macro', () => {
    expect(parseCronLine('PATH=/usr/local/bin:/usr/bin')).toBeNull();
    expect(parseCronLine('# 0 4 * * * /bin/x')).toBeNull();
    expect(parseCronLine('0 4 * * * /usr/bin/node /tmp/backup.mjs')).toEqual({
      line: '0 4 * * * /usr/bin/node /tmp/backup.mjs',
      command: '/usr/bin/node /tmp/backup.mjs',
      name: 'node',
    });
    expect(parseCronLine('@reboot /home/u/run.sh --now')?.command).toBe('/home/u/run.sh --now');
    expect(parseCronLine('@reboot /home/u/run.sh --now')?.name).toBe('run.sh');
  });

  it('命令首个 token 在日程里也出现过时，命令起点仍取日程之后', () => {
    // 旧实现用 indexOf(首个命令 token, 若干字段位置) 定位起点，重名 token 会把起点退回日程段。
    const entry = parseCronLine('*/5 * * * * */5 /bin/a');
    expect(entry?.command).toBe('*/5 /bin/a');
  });

  it('id 由整行决定：同一行稳定，改一个字段就换 id', () => {
    const line = '0 4 * * * /usr/bin/node /tmp/backup.mjs';
    expect(cronEntryId(line)).toBe(cronEntryId(line));
    expect(cronEntryId(line)).not.toBe(cronEntryId('0 5 * * * /usr/bin/node /tmp/backup.mjs'));
  });

  it('删除只动目标行，保留其余行与末尾换行', () => {
    const text = 'MAILTO=""\n0 4 * * * /usr/bin/a\n  0 5 * * * /usr/bin/b\n';
    const result = removeCronLine(text, '0 5 * * * /usr/bin/b');
    expect(result.removed).toBe(true);
    expect(result.text).toBe('MAILTO=""\n0 4 * * * /usr/bin/a\n');
    expect(removeCronLine('0 4 * * * /bin/a\n', '0 5 * * * /bin/b')).toEqual({
      text: '0 4 * * * /bin/a\n',
      removed: false,
    });
  });

  it('parseCrontab 汇总有效行', () => {
    expect(parseCrontab('MAILTO=""\n\n0 4 * * * /bin/a\n@reboot /bin/b\n')).toHaveLength(2);
  });

  it('同一行写两遍也能分别列出，id 不撞车', async () => {
    // 面板按 id 索引条目，撞车的第二条会在列表里被前一条顶掉。
    const adapter = createCrontabAdapter({
      exec: async () => ({ stdout: '@reboot /bin/sync\n@reboot /bin/sync\n', failed: false }),
    });
    const items = await adapter.scan();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.map((item) => item.name)).toEqual(['sync', 'sync']);
    // `@reboot` 是开机跑一次，不是定时：同一条 cron 行要按开机归类。
    expect(items.map((item) => item.trigger)).toEqual(['startup', 'startup']);
  });
});
