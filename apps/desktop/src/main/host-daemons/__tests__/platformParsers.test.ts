/**
 * host-daemons 平台来源的解析层。
 *
 * 这层是唯一的「平台文本 → 条目」入口。macOS 本机没有环境，只用真实样例文本锁住
 * 解析；Linux 侧在 WSL2 Ubuntu 上做过真实的 systemd / crontab 建、跑、停、删验证。
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCrontabAdapter,
  cronEntryId,
  parseCronLine,
  parseCrontab,
  removeCronLine,
} from '../crontab.js';
import {
  createLaunchAgentsAdapter,
  parseLaunchAgentPlist,
  parseLaunchctlList,
  toHostDaemonTrigger,
} from '../launchAgents.js';
import {
  createSystemdUserAdapter,
  parseSystemdListUnits,
  parseSystemdUnitFile,
  stateOf,
  unitTextDependsOn,
} from '../systemdUser.js';
import type { ExecResult } from '../target.js';

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
    // systemctl 读不到运行时状态时不能说它在跑，也不能说它没跑。
    expect(stateOf('cindy-probe.timer', null)).toBe('unknown');
  });

  it('单元文本是否依赖某个执行面：认 Unit= 与依赖列表，不认命令正文和描述', () => {
    const cases: Array<[string, boolean]> = [
      ['[Timer]\nUnit=backup.service\n', true],
      ['[Timer]\nUnit=backup\n', true],
      // 续行先接回同一行；值可以省略 .service 后缀。
      ['[Unit]\nWants=a.service b.service \\n    backup.service\n', true],
      ['[Unit]\nRequires=backup.timer\n', false],
      ['[Unit]\nUpholds=backup2.service\n', false],
      ['[Service]\nExecStart=/bin/backup.service\n', false],
      ['[Unit]\nDescription=runs backup.service daily\n', false],
    ];
    for (const [text, expected] of cases) {
      expect(unitTextDependsOn(text, 'backup.service')).toBe(expected);
    }
  });

  it('timer 显式指名别的 service 时，不把那个 service 当成自己的另一半', () => {
    // 删 timer 时跟着删 `Unit=` 指向的文件，会删掉别的 timer 也在用的 service。
    const runtime = new Map([['other.service', { active: 'active', sub: 'running' }]]);
    expect(stateOf('cron-a.timer', runtime, 'other.service')).toBe('running');
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

  it('两个删除并发时按表排队，不会把刚删掉的行写回来', async () => {
    // 整表读改写的固有风险：两个请求同时拿到同一份旧快照，后写的就会覆盖先写的。
    const table = { text: '0 4 * * * /bin/a\n0 5 * * * /bin/b\n' };
    const adapter = createCrontabAdapter({
      exec: async (file, args, options) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (args[0] === '-l') return { stdout: table.text, failed: false };
        table.text = options?.input ?? '';
        return { stdout: '', failed: false };
      },
    });
    await Promise.all([
      adapter.remove(cronEntryId('0 4 * * * /bin/a')),
      adapter.remove(cronEntryId('0 5 * * * /bin/b')),
    ]);
    expect(parseCrontab(table.text)).toHaveLength(0);
  });

  it('「立即运行」起不来时如实报错，不谎报已运行', async () => {
    // 旧实现 fire-and-forget：spawn 失败（命令不存在）时界面照样说已运行。
    const adapter = createCrontabAdapter({
      exec: async () => ({ stdout: '0 4 * * * /bin/absent\n', failed: false }),
      launch: async () => {
        throw new Error('spawn /bin/absent ENOENT');
      },
    });
    await expect(adapter.run(cronEntryId('0 4 * * * /bin/absent'))).rejects.toThrow('ENOENT');
  });
});

describe('systemd 动作契约（真目录 + 假 systemctl）', () => {
  /**
   * 这两个用例锁的是「删除」的两条根因类别：
   * - 删定义前必须先停执行面，否则 disable 之后进程还活着（页面说删了，进程还在）。
   * - 只删能确认属于这个 timer 的文件；显式指名别的 service 时不得连带删它。
   */
  async function withUnits(
    units: Record<string, string>,
    overrides: { reload?: () => Promise<void>; stopCode?: number } = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'host-daemons-'));
    for (const [name, body] of Object.entries(units)) {
      const path = join(dir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, 'utf8');
    }
    const commands: string[][] = [];
    const adapter = createSystemdUserAdapter({
      dir,
      exec: async (command, args) => {
        commands.push([command, ...args]);
        return args.includes('stop') && overrides.stopCode !== undefined
          ? { stdout: '', failed: true, code: overrides.stopCode }
          : { stdout: '', failed: false };
      },
      reload: overrides.reload ?? (async () => {}),
    });
    const cleanup = () => rm(dir, { recursive: true, force: true });
    return { adapter, commands, dir, cleanup };
  }

  it('删 timer 先停执行面；执行面被别的 timer 指名时留在盘上', async () => {
    const { adapter, commands, dir, cleanup } = await withUnits({
      'cron-a.timer': '[Timer]\nUnit=shared.service\nOnCalendar=hourly\n',
      'cron-b.timer': '[Timer]\nUnit=shared.service\nOnCalendar=daily\n',
      'shared.service': '[Service]\nExecStart=/bin/true\n',
    });
    try {
      await adapter.scan();
      await adapter.remove('systemd-user:cron-a.timer');
      // 停执行面必须在 disable 之前，否则 disable 只停 timer、进程仍在。
      const acts = commands.filter((c) => c.includes('stop') || c.includes('disable'));
      expect(acts).toEqual([
        ['systemctl', '--user', 'stop', 'shared.service'],
        ['systemctl', '--user', 'disable', '--now', 'cron-a.timer'],
      ]);
      // 共享的执行面不是这一个 timer 的东西，删它等于删另一个 timer 的定义。
      await expect(stat(join(dir, 'shared.service'))).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('timer 指名的 service 与自己不同名：没别的单元在用也不连带删', async () => {
    // 不同名的 service 是另一份定义，这个 timer 只是借用它；删 timer 不等于替它的主人做主。
    const { adapter, dir, cleanup } = await withUnits({
      'cron-a.timer': '[Timer]\nUnit=shared.service\nOnCalendar=hourly\n',
      'shared.service': '[Service]\nExecStart=/bin/true\n',
    });
    try {
      await adapter.scan();
      await adapter.remove('systemd-user:cron-a.timer');
      await expect(stat(join(dir, 'cron-a.timer'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(dir, 'shared.service'))).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('执行面未加载（stop 返回 5）时停与删都不算失败；真停不下来则不删', async () => {
    const units = { 'orphan.timer': '[Timer]\nOnCalendar=hourly\n' };
    const orphan = await withUnits(units, { stopCode: 5 });
    const stuck = await withUnits(units, { stopCode: 1 });
    try {
      // WSL2 实测：timer 指向的 service 没加载时 `systemctl stop` 返回 5，没有任何实例在跑。
      // 把它当失败，指向已删 service 的孤儿 timer 就永远删不掉。
      await orphan.adapter.scan();
      await orphan.adapter.stop('systemd-user:orphan.timer');
      await orphan.adapter.remove('systemd-user:orphan.timer');
      await expect(stat(join(orphan.dir, 'orphan.timer'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await stuck.adapter.scan();
      await expect(
        stuck.adapter.remove('systemd-user:orphan.timer'),
      ).rejects.toThrow('could not be stopped');
      await expect(stat(join(stuck.dir, 'orphan.timer'))).resolves.toBeTruthy();
    } finally {
      await orphan.cleanup();
      await stuck.cleanup();
    }
  });

  it('默认同名配对的执行面，被别的单元使用时不连带删除；没人用才跟着删', async () => {
    const own = {
      'backup.timer': '[Timer]\nOnCalendar=hourly\n',
      'backup.service': '[Service]\nExecStart=/bin/true\n',
    };
    // 「在用」不只有 Unit=：硬依赖、开机启用建的依赖目录，删掉执行面都会让它们启动失败。
    const users: Record<string, string> = {
      'daily.timer': '[Timer]\nUnit=backup.service\nOnCalendar=daily\n',
      'report.service': '[Unit]\nRequires=backup.service\n[Service]\nExecStart=/bin/true\n',
      'default.target.wants/backup.service': 'symlink\n',
    };
    for (const [name, body] of Object.entries(users)) {
      const { adapter, dir, cleanup } = await withUnits({ ...own, [name]: body });
      try {
        await adapter.scan();
        await adapter.remove('systemd-user:backup.timer');
        // 删的是这一项自己；执行面留着，下次扫描还能把它列出来、还能删。
        await expect(stat(join(dir, 'backup.timer'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(dir, 'backup.service'))).resolves.toBeTruthy();
      } finally {
        await cleanup();
      }
    }

    // 对照：执行面确实只属于这一项时，不留下没人认领、页面上再也删不掉的文件。
    const { adapter, dir, cleanup } = await withUnits(own);
    try {
      await adapter.scan();
      await adapter.remove('systemd-user:backup.timer');
      await expect(stat(join(dir, 'backup.service'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('daemon-reload 失败时在 unlink 之前报错，不留半删状态', async () => {
    const { adapter, dir, cleanup } = await withUnits(
      { 'cron-a.timer': '[Timer]\nOnCalendar=hourly\n' },
      {
        reload: async () => {
          throw new Error('systemd could not reload units');
        },
      },
    );
    try {
      await adapter.scan();
      await expect(adapter.remove('systemd-user:cron-a.timer')).rejects.toThrow(
        'could not reload',
      );
      // 文件还在，下次扫描能把它找回来。
      await expect(stat(join(dir, 'cron-a.timer'))).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});

describe('launchd 动作契约（真目录 + 假 launchctl）', () => {
  // macOS 本机没有环境：动作只锁「失败不报成功」这类结果，不冒充 launchctl 的行为。
  const LABEL = 'com.example.probe';
  const plist: Record<string, string> = {
    [`${LABEL}.plist`]: JSON.stringify({ Label: LABEL, Program: '/bin/true' }),
  };

  async function withAgents(ctl: (args: string[]) => ExecResult | undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'host-daemons-'));
    for (const name of Object.keys(plist)) await writeFile(join(dir, name), '<plist/>', 'utf8');
    const commands: string[][] = [];
    const adapter = createLaunchAgentsAdapter({
      dir,
      exec: async (command, args) => {
        commands.push([command, ...args]);
        // plutil 读的是盘上真实存在的那个文件。
        if (command === 'plutil') {
          return { stdout: plist[basename(args.at(-1) ?? '')] ?? '', failed: false };
        }
        return ctl(args) ?? { stdout: '', failed: false };
      },
    });
    return { adapter, commands, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it('已加载的 agent 卸载失败时不删文件；本来就没加载的 agent 直接删', async () => {
    const stuck = await withAgents((args) =>
      args[0] === 'bootout' ? { stdout: '', failed: true } : undefined,
    );
    // `launchctl list <Label>` 非 0 = 没加载。
    const notLoaded = await withAgents((args) =>
      args[0] === 'list' && args.length === 2 ? { stdout: '', failed: true } : undefined,
    );
    try {
      await expect(stuck.adapter.remove(`launch-agent:${LABEL}`)).rejects.toThrow(
        'could not be unloaded',
      );
      await expect(stat(join(stuck.dir, `${LABEL}.plist`))).resolves.toBeTruthy();

      await notLoaded.adapter.remove(`launch-agent:${LABEL}`);
      expect(notLoaded.commands.some((c) => c[1] === 'bootout')).toBe(false);
      await expect(stat(join(notLoaded.dir, `${LABEL}.plist`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await stuck.cleanup();
      await notLoaded.cleanup();
    }
  });

  it('bootstrap 之后 kickstart 仍失败时不报成功', async () => {
    let kickstarts = 0;
    const started = await withAgents(
      (args) =>
        args[0] === 'kickstart' && ++kickstarts === 1 ? { stdout: '', failed: true } : undefined,
    );
    const failed = await withAgents(
      (args) => (args[0] === 'kickstart' ? { stdout: '', failed: true } : undefined),
    );
    try {
      await started.adapter.run(`launch-agent:${LABEL}`);
      expect(kickstarts).toBe(2);
      await expect(failed.adapter.run(`launch-agent:${LABEL}`)).rejects.toThrow(
        'could not be started',
      );
    } finally {
      await started.cleanup();
      await failed.cleanup();
    }
  });
});
