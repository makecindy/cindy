/**
 * PtyManager 单测 —— 用 fake PtySpawnFn + fake WebContents 完全替代 node-pty / Electron。
 *
 * 覆盖：
 *   1. create 生命周期：spawn 调用 + emitData 转发 + emitExit 转发 + 保留 exitState
 *   2. write 微任务批处理：连续多次 write → 一次 pty.write
 *   3. resize：合法值转发 + 非法值忽略 + cols/rows 同值短路
 *   4. dispose：未 exit 时 kill + 解订阅 + 移出 Map；已 exit 时只清理状态
 *   5. restart：必须先 exit；新 PTY 接管同 id
 *   6. owner destroyed：自动 dispose 该 owner 全部 session
 *   7. exit 后再 write 静默忽略
 *
 * 也覆盖 shellResolver 的真集成（不 mock）：要求 process.env.SHELL 兜底链能跑通。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { WebContents } from 'electron';

import { PtyManager, type DataPayload, type ExitPayload } from '../ptyManager';

// ---------- Fake IPty ----------

interface FakePty extends IPty {
  __triggerData: (chunk: string) => void;
  __triggerExit: (info: { exitCode: number; signal?: number }) => void;
  __writes: string[];
  __resizes: Array<{ cols: number; rows: number }>;
  __killed: boolean;
  __dataListenersDisposed: boolean;
  __exitListenersDisposed: boolean;
  __spawnEnv: Record<string, string | undefined>;
}

function makeFakePty(spawnArgs: { command: string; args: string[]; cols?: number; rows?: number; env?: Record<string, string | undefined> }): FakePty {
  const dataListeners: Array<(s: string) => void> = [];
  const exitListeners: Array<(info: { exitCode: number; signal?: number }) => void> = [];
  const fake: FakePty = {
    pid: 12345,
    cols: spawnArgs.cols ?? 80,
    rows: spawnArgs.rows ?? 24,
    process: spawnArgs.command,
    handleFlowControl: false,
    onData: ((listener: (s: string) => void) => {
      dataListeners.push(listener);
      return {
        dispose: () => {
          const idx = dataListeners.indexOf(listener);
          if (idx >= 0) dataListeners.splice(idx, 1);
          fake.__dataListenersDisposed = dataListeners.length === 0;
        },
      };
    }) as unknown as IPty['onData'],
    onExit: ((listener: (info: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener);
      return {
        dispose: () => {
          const idx = exitListeners.indexOf(listener);
          if (idx >= 0) exitListeners.splice(idx, 1);
          fake.__exitListenersDisposed = exitListeners.length === 0;
        },
      };
    }) as unknown as IPty['onExit'],
    write: vi.fn((data: string | Buffer) => {
      fake.__writes.push(typeof data === 'string' ? data : data.toString('utf8'));
    }) as unknown as IPty['write'],
    resize: vi.fn((cols: number, rows: number) => {
      fake.__resizes.push({ cols, rows });
    }) as unknown as IPty['resize'],
    kill: vi.fn(() => {
      fake.__killed = true;
    }) as unknown as IPty['kill'],
    clear: () => {},
    pause: () => {},
    resume: () => {},
    __triggerData: (chunk: string) => {
      for (const l of [...dataListeners]) l(chunk);
    },
    __triggerExit: (info: { exitCode: number; signal?: number }) => {
      for (const l of [...exitListeners]) l(info);
    },
    __writes: [],
    __resizes: [],
    __killed: false,
    __dataListenersDisposed: false,
    __exitListenersDisposed: false,
    __spawnEnv: spawnArgs.env ?? {},
  };
  return fake;
}

// ---------- Fake WebContents ----------

interface FakeWC {
  isDestroyed: () => boolean;
  once: (event: string, cb: () => void) => void;
  __triggerDestroyed: () => void;
  __destroyed: boolean;
}

function makeFakeWebContents(): FakeWC {
  const handlers: Array<() => void> = [];
  const wc: FakeWC = {
    isDestroyed: () => wc.__destroyed,
    once: (event: string, cb: () => void) => {
      if (event === 'destroyed') handlers.push(cb);
    },
    __triggerDestroyed: () => {
      wc.__destroyed = true;
      for (const h of [...handlers]) h();
    },
    __destroyed: false,
  };
  return wc;
}

// ---------- Test setup ----------

let lastSpawn: FakePty | null = null;
let allSpawns: FakePty[] = [];
let dataPayloads: Array<{ target: WebContents; payload: DataPayload }> = [];
let exitPayloads: Array<{ target: WebContents; payload: ExitPayload }> = [];

function makeManager(opts?: {
  resolveFallbackOwner?: (dead: WebContents) => WebContents | null;
  platform?: NodeJS.Platform;
}) {
  return new PtyManager({
    spawn: (command, args, options) => {
      const fake = makeFakePty({
        command,
        args,
        cols: options.cols,
        rows: options.rows,
        env: options.env as Record<string, string | undefined> | undefined,
      });
      lastSpawn = fake;
      allSpawns.push(fake);
      return fake;
    },
    sink: {
      emitData: (target, payload) => {
        dataPayloads.push({ target, payload });
      },
      emitExit: (target, payload) => {
        exitPayloads.push({ target, payload });
      },
    },
    resolveFallbackOwner: opts?.resolveFallbackOwner,
    platform: opts?.platform,
  });
}

beforeEach(() => {
  lastSpawn = null;
  allSpawns = [];
  dataPayloads = [];
  exitPayloads = [];
  // 确保 shell auto-detect 在 *nix 上能拿到 zsh / bash / sh 之一（CI 环境）
  if (!process.env.SHELL) process.env.SHELL = '/bin/sh';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PtyManager.create', () => {
  it('spawn 一个 PTY 并发回 metadata', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    const result = mgr.create({ id: 't1', cwd: '/tmp', cols: 100, rows: 30, owner });

    expect(lastSpawn).not.toBeNull();
    expect(lastSpawn!.cols).toBe(100);
    expect(lastSpawn!.rows).toBe(30);
    expect(result.pid).toBe(12345);
    expect(typeof result.shellId).toBe('string');
    expect(mgr.has('t1')).toBe(true);
  });

  it('PTY 输出经 sink.emitData 转发到 owner', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });

    lastSpawn!.__triggerData('hello');
    lastSpawn!.__triggerData('中文');

    expect(dataPayloads.map((p) => p.payload.chunk)).toEqual(['hello', '中文']);
    expect(dataPayloads.every((p) => p.target === owner)).toBe(true);
    expect(dataPayloads.every((p) => p.payload.id === 't1')).toBe(true);
  });

  it('PTY exit 转发并保留 exit state（session 不立刻移除）', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });

    lastSpawn!.__triggerExit({ exitCode: 42, signal: undefined });

    expect(exitPayloads).toHaveLength(1);
    expect(exitPayloads[0].payload).toEqual({ id: 't1', exit: { code: 42, signal: null } });
    expect(mgr.has('t1')).toBe(true); // 仍在 Map 里，等 dispose
  });

  it('同 id 第二次 create(运行中)是幂等的,返回现有 metadata 不重 spawn', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    const first = mgr.create({ id: 't1', cwd: '/tmp', cols: 80, rows: 24, owner });
    expect(allSpawns).toHaveLength(1);

    // 模拟 session 切换后重新 mount:同 id 再 create,**不应** spawn 第二次
    const second = mgr.create({ id: 't1', cwd: '/elsewhere', cols: 120, rows: 40, owner });
    expect(allSpawns).toHaveLength(1); // 没有新 spawn
    expect(second.pid).toBe(first.pid);
    expect(second.shellId).toBe(first.shellId);
  });

  it('同 id create 切换 owner 时把 owner 更新到新 webContents', () => {
    const mgr = makeManager();
    const ownerOld = makeFakeWebContents() as unknown as WebContents;
    const ownerNew = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner: ownerOld });
    mgr.create({ id: 't1', cwd: '/tmp', owner: ownerNew });

    // 触发 onData → emit 应推到 ownerNew 而不是 ownerOld
    lastSpawn!.__triggerData('hello');
    expect(dataPayloads).toHaveLength(1);
    expect(dataPayloads[0].target).toBe(ownerNew);
  });

  it('同 id 已 exit 时再 create 抛错(需走显式 restart)', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    lastSpawn!.__triggerExit({ exitCode: 0 });
    expect(() => mgr.create({ id: 't1', cwd: '/tmp', owner })).toThrow(/already exists/);
  });
});

describe('PtyManager.write batching', () => {
  it('连续多次 write → 一次 pty.write（同 microtask 合并）', async () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });

    mgr.write('t1', 'a');
    mgr.write('t1', 'b');
    mgr.write('t1', 'c');
    // microtask 还没 flush
    expect(lastSpawn!.__writes).toEqual([]);
    // 让 microtask 跑
    await Promise.resolve();
    expect(lastSpawn!.__writes).toEqual(['abc']);
  });

  it('两轮 microtask 之间的 write 各自 flush', async () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });

    mgr.write('t1', 'x');
    await Promise.resolve();
    mgr.write('t1', 'y');
    await Promise.resolve();
    expect(lastSpawn!.__writes).toEqual(['x', 'y']);
  });

  it('未知 id write 静默忽略', async () => {
    const mgr = makeManager();
    mgr.write('nope', 'data');
    await Promise.resolve();
    // 没有任何 spawn 被调用
    expect(allSpawns).toHaveLength(0);
  });

  it('exit 之后 write 静默忽略', async () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    lastSpawn!.__triggerExit({ exitCode: 0 });
    mgr.write('t1', 'late');
    await Promise.resolve();
    expect(lastSpawn!.__writes).toEqual([]);
  });
});

describe('PtyManager.resize', () => {
  it('合法值转发到 pty.resize', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', cols: 80, rows: 24, owner });
    mgr.resize('t1', 120, 40);
    expect(lastSpawn!.__resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('同尺寸短路', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', cols: 80, rows: 24, owner });
    mgr.resize('t1', 80, 24);
    expect(lastSpawn!.__resizes).toEqual([]);
  });

  it('非法值忽略', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    mgr.resize('t1', 0, 24);
    mgr.resize('t1', NaN, 40);
    mgr.resize('t1', 100, -1);
    expect(lastSpawn!.__resizes).toEqual([]);
  });

  it('exit 后 resize 忽略', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    lastSpawn!.__triggerExit({ exitCode: 0 });
    mgr.resize('t1', 100, 30);
    expect(lastSpawn!.__resizes).toEqual([]);
  });
});

describe('PtyManager.dispose', () => {
  it('未 exit 时 kill + 解订阅 + 移出 Map', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    mgr.dispose('t1');
    expect(lastSpawn!.__killed).toBe(true);
    expect(lastSpawn!.__dataListenersDisposed).toBe(true);
    expect(lastSpawn!.__exitListenersDisposed).toBe(true);
    expect(mgr.has('t1')).toBe(false);
  });

  it('已 exit 时不再 kill', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    lastSpawn!.__triggerExit({ exitCode: 0 });
    mgr.dispose('t1');
    expect(lastSpawn!.__killed).toBe(false);
    expect(mgr.has('t1')).toBe(false);
  });

  it('未知 id dispose 是 no-op', () => {
    const mgr = makeManager();
    expect(() => mgr.dispose('nope')).not.toThrow();
  });
});

describe('PtyManager.restart', () => {
  it('exit 后 restart → 新 PTY 接管同 id', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', cols: 100, rows: 30, shellPref: 'bash', owner });
    const oldPty = lastSpawn!;
    lastSpawn!.__triggerExit({ exitCode: 1 });

    const result = mgr.restart('t1', owner);

    expect(allSpawns).toHaveLength(2);
    expect(lastSpawn).not.toBe(oldPty);
    expect(lastSpawn!.cols).toBe(100); // 沿用旧 cols/rows
    expect(lastSpawn!.rows).toBe(30);
    expect(result.pid).toBe(12345);
    expect(mgr.has('t1')).toBe(true);
    expect(mgr.__debugListSessions()[0]?.shellPref).toBe('bash');
  });

  it('仍在运行的 session restart 抛错', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    expect(() => mgr.restart('t1', owner)).toThrow(/still running/);
  });

  it('不存在的 id restart 抛错', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    expect(() => mgr.restart('nope', owner)).toThrow(/not found/);
  });
});

describe('PtyManager.spawn env scrubbing', () => {
  // 跟 ENV_KEYS_TO_STRIP 名单同步,任何一项被遗漏都意味着 shell startup script 可能
  // 误以为是 iTerm / VSCode terminal 走错代码路径,导致 OSC 序列乱码渲染。
  const STRIPPED_KEYS = [
    'TERMINFO',
    'TERMINFO_DIRS',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TERM_SESSION_ID',
    'LC_TERMINAL',
    'LC_TERMINAL_VERSION',
    'ITERM_PROFILE',
    'ITERM_SESSION_ID',
    'ITERM_SHELL_INTEGRATION_INSTALLED',
    'VSCODE_INJECTION',
    'VSCODE_PID',
    'VSCODE_GIT_IPC_HANDLE',
    'VSCODE_GIT_ASKPASS_NODE',
    'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
    'VSCODE_GIT_ASKPASS_MAIN',
    'VSCODE_IPC_HOOK_CLI',
    'VSCODE_NLS_CONFIG',
    'VSCODE_CWD',
    'GIT_ASKPASS',
  ];

  it('父进程的 terminal app / shell integration 标记必须被剥掉', () => {
    // 模拟从 iTerm/Code dev 启动 Electron 时继承的脏 env
    for (const k of STRIPPED_KEYS) process.env[k] = `mock-${k}`;
    process.env.PATH = '/usr/bin:/bin';

    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });

    for (const k of STRIPPED_KEYS) {
      expect(lastSpawn!.__spawnEnv[k], `${k} should be stripped`).toBeUndefined();
    }
  });

  it('TERM 一定被设为 xterm-256color(覆盖父进程旧值)', () => {
    process.env.TERM = 'screen-256color'; // 模拟父 terminal 是 screen
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    expect(lastSpawn!.__spawnEnv.TERM).toBe('xterm-256color');
  });

  it('其它无关 env(PATH / HOME / 用户自定义)透传', () => {
    process.env.PATH = '/usr/bin:/bin:/custom';
    process.env.HOME = '/Users/test';
    process.env.MY_CUSTOM_VAR = 'value';
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({ id: 't1', cwd: '/tmp', owner });
    expect(lastSpawn!.__spawnEnv.PATH).toBe('/usr/bin:/bin:/custom');
    expect(lastSpawn!.__spawnEnv.HOME).toBe('/Users/test');
    expect(lastSpawn!.__spawnEnv.MY_CUSTOM_VAR).toBe('value');
  });

  it('opts.env 可以塞回某个被剥的变量(显式覆盖)', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal'; // 父进程注入
    const mgr = makeManager();
    const owner = makeFakeWebContents() as unknown as WebContents;
    mgr.create({
      id: 't1',
      cwd: '/tmp',
      owner,
      env: { TERM_PROGRAM: 'xdt-maker' }, // 调用方显式塞回
    });
    // ENV_KEYS_TO_STRIP 在 opts.env 之后执行 —— 所以即使 opts.env 显式塞回,
    // 仍会被剥。这是有意设计:不让调用方意外引入 host 标记。
    // 这条 case 验证"剥永远生效",不是"opts.env 能塞回"。
    expect(lastSpawn!.__spawnEnv.TERM_PROGRAM).toBeUndefined();
  });

  it('macOS 继承到空/C locale 时为 PTY 补 UTF-8 字符 locale', () => {
    const original = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
    };
    try {
      process.env.LANG = '';
      process.env.LC_ALL = '';
      process.env.LC_CTYPE = 'C';

      const mgr = makeManager({ platform: 'darwin' });
      const owner = makeFakeWebContents() as unknown as WebContents;
      mgr.create({ id: 't1', cwd: '/tmp', owner });

      expect(lastSpawn!.__spawnEnv.LC_CTYPE).toBe('UTF-8');
      expect(lastSpawn!.__spawnEnv.LC_ALL).toBe('');

      delete process.env.LC_CTYPE;
      process.env.LANG = 'C';
      mgr.create({ id: 't2', cwd: '/tmp', owner });
      expect(lastSpawn!.__spawnEnv.LC_CTYPE).toBe('UTF-8');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('调用方显式传入的 locale 在平台兜底之后生效', () => {
    const original = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
    };
    try {
      process.env.LANG = '';
      process.env.LC_ALL = '';
      process.env.LC_CTYPE = 'C';

      const mgr = makeManager({ platform: 'darwin' });
      const owner = makeFakeWebContents() as unknown as WebContents;
      mgr.create({
        id: 't1',
        cwd: '/tmp',
        owner,
        env: { LC_CTYPE: 'ja_JP.UTF-8' },
      });

      expect(lastSpawn!.__spawnEnv.LC_CTYPE).toBe('ja_JP.UTF-8');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('不覆盖用户显式设置的 LC_ALL 或非 C/POSIX 字符 locale', () => {
    const original = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
    };
    try {
      process.env.LANG = '';
      process.env.LC_ALL = 'C';
      process.env.LC_CTYPE = 'C';

      const mgr = makeManager({ platform: 'darwin' });
      const owner = makeFakeWebContents() as unknown as WebContents;
      mgr.create({ id: 't1', cwd: '/tmp', owner });
      expect(lastSpawn!.__spawnEnv.LC_ALL).toBe('C');
      expect(lastSpawn!.__spawnEnv.LC_CTYPE).toBe('C');

      process.env.LC_ALL = '';
      process.env.LC_CTYPE = 'en_US.UTF-8';
      mgr.create({ id: 't2', cwd: '/tmp', owner });
      expect(lastSpawn!.__spawnEnv.LC_CTYPE).toBe('en_US.UTF-8');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('Windows 不改变 C locale', () => {
    const original = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
    };
    try {
      process.env.LANG = '';
      process.env.LC_ALL = '';
      process.env.LC_CTYPE = 'C';

      const mgr = makeManager({ platform: 'win32' });
      const owner = makeFakeWebContents() as unknown as WebContents;
      mgr.create({ id: 't1', cwd: '/tmp', owner });

      expect(lastSpawn!.__spawnEnv.LC_CTYPE).toBe('C');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('PtyManager.disposeOwner (webContents destroyed)', () => {
  it('owner destroyed 时自动 dispose 该 owner 的全部 session', () => {
    const mgr = makeManager();
    const ownerA = makeFakeWebContents();
    const ownerB = makeFakeWebContents();
    mgr.create({ id: 'a1', cwd: '/tmp', owner: ownerA as unknown as WebContents });
    const ptyA1 = lastSpawn!;
    mgr.create({ id: 'a2', cwd: '/tmp', owner: ownerA as unknown as WebContents });
    const ptyA2 = lastSpawn!;
    mgr.create({ id: 'b1', cwd: '/tmp', owner: ownerB as unknown as WebContents });
    const ptyB1 = lastSpawn!;

    ownerA.__triggerDestroyed();

    expect(ptyA1.__killed).toBe(true);
    expect(ptyA2.__killed).toBe(true);
    expect(ptyB1.__killed).toBe(false);
    expect(mgr.has('a1')).toBe(false);
    expect(mgr.has('a2')).toBe(false);
    expect(mgr.has('b1')).toBe(true);
  });

  it('owner destroyed 后 emitData 不会再触发（isDestroyed 检查）', () => {
    const mgr = makeManager();
    const owner = makeFakeWebContents();
    mgr.create({ id: 't1', cwd: '/tmp', owner: owner as unknown as WebContents });
    const captured = lastSpawn!;
    owner.__destroyed = true; // 模拟已经销毁但还没触发 'destroyed'
    captured.__triggerData('late data');
    expect(dataPayloads).toHaveLength(0);
  });
});

describe('PtyManager fallback owner transfer (RSB 子窗口销毁不杀 PTY)', () => {
  it('owner destroyed 且 fallback 活着 → session 转移不杀,输出改推 fallback', () => {
    const sidebar = makeFakeWebContents();
    const mainWin = makeFakeWebContents();
    const mgr = makeManager({
      resolveFallbackOwner: () => mainWin as unknown as WebContents,
    });
    mgr.create({ id: 't1', cwd: '/tmp', owner: sidebar as unknown as WebContents });
    const pty = lastSpawn!;

    sidebar.__triggerDestroyed();

    expect(pty.__killed).toBe(false);
    expect(mgr.has('t1')).toBe(true);
    pty.__triggerData('after transfer');
    expect(dataPayloads).toHaveLength(1);
    expect(dataPayloads[0].target).toBe(mainWin);
  });

  it('只转移 dead owner 名下的 session,其它 owner 不受影响', () => {
    const sidebar = makeFakeWebContents();
    const mainWin = makeFakeWebContents();
    const mgr = makeManager({
      resolveFallbackOwner: () => mainWin as unknown as WebContents,
    });
    mgr.create({ id: 'side1', cwd: '/tmp', owner: sidebar as unknown as WebContents });
    mgr.create({ id: 'main1', cwd: '/tmp', owner: mainWin as unknown as WebContents });
    const mainPty = lastSpawn!;

    sidebar.__triggerDestroyed();

    expect(mgr.has('side1')).toBe(true);
    expect(mgr.has('main1')).toBe(true);
    mainPty.__triggerData('still main');
    expect(dataPayloads[0].target).toBe(mainWin);
  });

  it('fallback 解析为 null(app 退出)→ 回落 dispose', () => {
    const sidebar = makeFakeWebContents();
    const mgr = makeManager({ resolveFallbackOwner: () => null });
    mgr.create({ id: 't1', cwd: '/tmp', owner: sidebar as unknown as WebContents });
    const pty = lastSpawn!;

    sidebar.__triggerDestroyed();

    expect(pty.__killed).toBe(true);
    expect(mgr.has('t1')).toBe(false);
  });

  it('fallback 已销毁 → 回落 dispose', () => {
    const sidebar = makeFakeWebContents();
    const mainWin = makeFakeWebContents();
    mainWin.__destroyed = true;
    const mgr = makeManager({
      resolveFallbackOwner: () => mainWin as unknown as WebContents,
    });
    mgr.create({ id: 't1', cwd: '/tmp', owner: sidebar as unknown as WebContents });
    const pty = lastSpawn!;

    sidebar.__triggerDestroyed();

    expect(pty.__killed).toBe(true);
    expect(mgr.has('t1')).toBe(false);
  });

  it('fallback 就是 dead owner 自己(主窗销毁)→ 回落 dispose', () => {
    const mainWin = makeFakeWebContents();
    const mgr = makeManager({
      resolveFallbackOwner: () => mainWin as unknown as WebContents,
    });
    mgr.create({ id: 't1', cwd: '/tmp', owner: mainWin as unknown as WebContents });
    const pty = lastSpawn!;

    mainWin.__triggerDestroyed();

    expect(pty.__killed).toBe(true);
    expect(mgr.has('t1')).toBe(false);
  });

  it('转移后 fallback 自己 destroyed(且再无接管者)→ dispose 收尾,不泄漏', () => {
    const sidebar = makeFakeWebContents();
    const mainWin = makeFakeWebContents();
    let fallback: WebContents | null = mainWin as unknown as WebContents;
    const mgr = makeManager({ resolveFallbackOwner: () => fallback });
    mgr.create({ id: 't1', cwd: '/tmp', owner: sidebar as unknown as WebContents });
    const pty = lastSpawn!;

    sidebar.__triggerDestroyed();
    expect(pty.__killed).toBe(false);

    fallback = null; // app 退出:主窗销毁时已无接管者
    mainWin.__triggerDestroyed();
    expect(pty.__killed).toBe(true);
    expect(mgr.has('t1')).toBe(false);
  });
});
