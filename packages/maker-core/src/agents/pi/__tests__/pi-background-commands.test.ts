import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PI_BACKGROUND_COMMAND_MAX_CHARS,
  PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX,
  PiBackgroundCommands,
  buildPiBackgroundCommandEnv,
  parsePiBackgroundCommandShellSpec,
  piBackgroundCommandRoot,
  removePiBackgroundCommandRoot,
  stopAllPiBackgroundCommandsForExit,
  sweepStalePiBackgroundCommandAnonRoots,
  type PiBackgroundCommandUpdate,
} from '../pi-background-commands.js';

/**
 * node 本身作为「shell」跑测试命令:不依赖 bash/cmd(Windows CI 也在跑),
 * 也不引入额外 shell 解析面。commandTransport=standard 时 manager 把 command
 * 追加到 args 后面 —— `node -e <script>` / `node -` 都成立。
 */
const NODE_EVAL_SHELL = {
  shell: process.execPath,
  args: ['-e'],
  commandTransport: 'standard' as const,
};

/** 归属标记:`owner-<pid>.json`(每实例一个文件,见 pi-background-commands.ts)。 */
function ownerFileName(pid: number): string {
  return `${PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX}${pid}.json`;
}

function isOwnerMarker(name: string): boolean {
  return name.startsWith(PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX) && name.endsWith('.json');
}
const NODE_STDIN_SHELL = {
  shell: process.execPath,
  args: ['-'],
  commandTransport: 'stdin' as const,
};

const tempRoots: string[] = [];
const managers: PiBackgroundCommands[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-bg-commands-'));
  tempRoots.push(root);
  return root;
}

function makeManager(overrides: {
  maxRunning?: number;
  defaultCwd?: string;
  logDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): { manager: PiBackgroundCommands; updates: PiBackgroundCommandUpdate[]; logDir: string } {
  const root = makeTempRoot();
  const logDir = overrides.logDir ?? path.join(root, 'logs');
  const updates: PiBackgroundCommandUpdate[] = [];
  const manager = new PiBackgroundCommands({
    env: overrides.env ?? process.env,
    defaultCwd: overrides.defaultCwd ?? process.cwd(),
    logDir,
    onUpdate: (update) => updates.push(update),
    ...(overrides.maxRunning !== undefined ? { maxRunning: overrides.maxRunning } : {}),
  });
  managers.push(manager);
  return { manager, updates, logDir };
}

async function waitForUpdate(
  updates: PiBackgroundCommandUpdate[],
  predicate: (update: PiBackgroundCommandUpdate) => boolean,
  timeoutMs = 8_000,
): Promise<PiBackgroundCommandUpdate> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = updates.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for update; saw ${JSON.stringify(updates)}`);
}

/** 等一个文件消失(标记撤销是异步的 best-effort)。 */
async function waitForGone(filePath: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && existsSync(filePath)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose().catch(() => undefined)));
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PiBackgroundCommands', () => {
  it('runs a command to completion: running → completed, with output in log and summary', async () => {
    const { manager, updates, logDir } = makeManager();
    const started = await manager.start({
      taskId: 'call-1',
      command: 'process.stdout.write("hello from background")',
      shell: NODE_EVAL_SHELL,
    });
    expect(started.taskId).toBe('call-1');
    expect(started.logPath).toBe(path.join(logDir, 'call-1.log'));

    const running = updates[0];
    expect(running).toMatchObject({ taskId: 'call-1', status: 'running' });
    const terminal = await waitForUpdate(updates, (u) => u.taskId === 'call-1' && u.status !== 'running');
    expect(terminal.status).toBe('completed');
    expect(terminal.exitCode).toBe(0);
    expect(terminal.summary).toContain('hello from background');
    expect(await readFile(started.logPath, 'utf8')).toContain('hello from background');
    expect(manager.list()).toEqual([]);
  });

  it('reads the command from stdin when the shell spec says so', async () => {
    const { manager, updates } = makeManager();
    await manager.start({
      taskId: 'stdin-1',
      command: 'process.stdout.write("via stdin")',
      shell: NODE_STDIN_SHELL,
    });
    const terminal = await waitForUpdate(updates, (u) => u.taskId === 'stdin-1' && u.status !== 'running');
    expect(terminal.status).toBe('completed');
    expect(terminal.summary).toContain('via stdin');
  });

  it('reports a non-zero exit as failed with the exit code', async () => {
    const { manager, updates } = makeManager();
    await manager.start({ taskId: 'fail-1', command: 'process.exit(3)', shell: NODE_EVAL_SHELL });
    const terminal = await waitForUpdate(updates, (u) => u.taskId === 'fail-1' && u.status !== 'running');
    expect(terminal).toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('stops a running command and reports stopped', async () => {
    const { manager, updates } = makeManager();
    await manager.start({
      taskId: 'stop-1',
      command: 'process.stdout.write("up"); setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'stop-1' && u.status === 'running');
    expect(manager.list().map((task) => task.taskId)).toEqual(['stop-1']);
    expect(await manager.stop('stop-1')).toBe('stopped');
    const terminal = await waitForUpdate(updates, (u) => u.taskId === 'stop-1' && u.status !== 'running');
    expect(terminal.status).toBe('stopped');
    expect(manager.list()).toEqual([]);
    // 未知 taskId / 已终态任务是幂等 no-op(由上层回落 subagent 控制面);三态里的
    // not-running 不能被压成 stopped —— 上层要靠它区分「已确认停掉」与「本来就不在」。
    expect(await manager.stop('stop-1')).toBe('not-running');
  });

  it('enforces the per-session running cap', async () => {
    const { manager, updates } = makeManager({ maxRunning: 1 });
    await manager.start({
      taskId: 'cap-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'cap-1' && u.status === 'running');
    await expect(manager.start({
      taskId: 'cap-2',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    })).rejects.toThrow(/limit 1/);
  });

  it('keeps ids that are only filename-unsafe and rejects duplicate running ids', async () => {
    const { manager, updates } = makeManager();
    const started = await manager.start({
      taskId: 'not a valid id!',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    // 只影响文件名,不影响 taskId:渲染层靠它配回聊天流的 tool_use。
    expect(started.taskId).toBe('not a valid id!');
    await waitForUpdate(updates, (u) => u.taskId === started.taskId && u.status === 'running');
    await expect(manager.start({
      taskId: started.taskId,
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    })).rejects.toThrow(/already running/);
    await manager.stop(started.taskId);
  });

  it('falls back to a generated id only for ids that cannot be keys at all', async () => {
    const { manager } = makeManager();
    const bogusIds = [
      '',
      '   ',
      'a'.repeat(201),
      `bad${String.fromCharCode(10)}id`,
      `bad${String.fromCharCode(0)}id`,
    ];
    for (const bogus of bogusIds) {
      const started = await manager.start({
        taskId: bogus,
        command: 'process.stdout.write("ok")',
        shell: NODE_EVAL_SHELL,
      });
      expect(started.taskId).toMatch(/^bash-[0-9a-f-]{36}$/);
      await manager.stop(started.taskId);
    }
  });

  it('holds its ownership marker only while a command is running in the directory', async () => {
    const { manager, updates, logDir } = makeManager();
    const marker = path.join(logDir, ownerFileName(process.pid));
    await manager.start({
      taskId: 'owner-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'owner-1' && u.status === 'running');
    const owner = JSON.parse(readFileSync(marker, 'utf8')) as { pid?: number };
    expect(owner.pid).toBe(process.pid);
    // 命令还在跑 => 标记在场(别的实例删会话时保留目录)。
    expect(existsSync(marker)).toBe(true);

    await manager.stop('owner-1');
    // 命令收口、没有残留进程 => 标记必须撤销:否则一个已经用完这个会话、进程却还活着的
    // 实例会把它一直挂在那里,目录再也没人回收。
    await waitForGone(marker);
    expect(existsSync(marker)).toBe(false);

    // 同一目录再起一条:标记必须回来(撤销不是"一次性"的)。
    await manager.start({
      taskId: 'owner-2',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'owner-2' && u.status === 'running');
    expect(existsSync(marker)).toBe(true);
    await manager.dispose();
    await waitForGone(marker);
  });

  it('kills a command that was asked to stop while it was still starting', async () => {
    const { manager, updates } = makeManager();
    // 记录在第一个 await 之前就进了运行表(同步占位),所以 start() 与 stopAll() 可以在
    // 同一 tick 里先后发生 —— 这正是「用户点全部停止时命令刚在启动」的窗口。
    const starting = manager.start({
      taskId: 'stop-during-spawn',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    void manager.stopAll({ timeoutMs: 200 });
    await expect(starting).rejects.toThrow(/stopped before it finished starting/i);
    // 没发过 running 帧(否则面板会留下一条点了停不掉的僵尸行),也没有进程活着。
    expect(updates.filter((u) => u.status === 'running')).toEqual([]);
    // SIGKILL 之后的 'exit' 是异步的:等这条记录从运行表里销账(不等就等于在赌时序)。
    // 记录必须立刻销账:留在 running 里会占住这个 taskId(同名启动全被拒)并污染快照。
    expect(manager.list()).toEqual([]);
  });

  it('rejects empty / over-long commands and a failed spawn', async () => {
    const { manager } = makeManager();
    await expect(manager.start({ command: '   ', shell: NODE_EVAL_SHELL }))
      .rejects.toThrow(/non-empty command/);
    await expect(manager.start({
      command: 'x'.repeat(PI_BACKGROUND_COMMAND_MAX_CHARS + 1),
      shell: NODE_EVAL_SHELL,
    })).rejects.toThrow(/too long/);
    await expect(manager.start({
      taskId: 'missing-shell',
      command: 'echo hi',
      shell: { shell: path.join(makeTempRoot(), 'definitely-missing-shell'), args: [], commandTransport: 'standard' },
    })).rejects.toThrow(/could not start the background command/i);
    // 启动失败的条目不得留在运行表里
    expect(manager.list()).toEqual([]);
  });

  it('dispose kills running commands and emits stopped', async () => {
    const { manager, updates } = makeManager();
    await manager.start({
      taskId: 'dispose-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'dispose-1' && u.status === 'running');
    await manager.dispose();
    expect(updates.some((u) => u.taskId === 'dispose-1' && u.status === 'stopped')).toBe(true);
    expect(manager.list()).toEqual([]);
    // dispose 后不再接受新命令
    await expect(manager.start({ command: 'echo hi', shell: NODE_EVAL_SHELL }))
      .rejects.toThrow(/unavailable/);
  });

  it('reports zero unconfirmed when the sweep reclaims everything', async () => {
    const { manager, updates } = makeManager();
    await manager.start({
      taskId: 'sweep-count-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'sweep-count-1' && u.status === 'running');
    // 更新重启用这个返回值决定放行还是取消重启:全部确认退出时必须是 0。
    await expect(manager.stopAll({ timeoutMs: 500 })).resolves.toBe(0);
    await expect(manager.stopAll({ timeoutMs: 500 })).resolves.toBe(0);
  });

  it('keeps unconfirmed processes visible to the exit sweep after dispose', async () => {
    const { manager, updates, logDir } = makeManager();
    // SIGTERM 处理器注册后才写 ready:POSIX 上 dispose 的 SIGTERM 必定被忽略,进程只能
    // 靠升级 SIGKILL 或退出清扫回收(Windows 是 taskkill /F,不依赖信号)。
    await manager.start({
      taskId: 'stubborn-1',
      command: 'process.on("SIGTERM", function () {}); process.stdout.write("ready"); setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'stubborn-1' && u.status === 'running');
    const logPath = path.join(logDir, 'stubborn-1.log');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if ((await readFile(logPath, 'utf8').catch(() => '')).includes('ready')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await manager.dispose();
    if (process.platform !== 'win32') {
      // dispose 必须先按 stopped 收口(UI 侧不等确认),但进程本身还活着 ——
      // 这批记录就是退出清扫必须还能看到的对象。
      expect(manager.pendingKillCount).toBe(1);
    }
    await stopAllPiBackgroundCommandsForExit(500);
    // 清扫后必须已确认退出并销账(否则本实例会永久留在 liveManagers 里,
    // 且那个 detached 进程组会变成孤儿)。
    expect(manager.pendingKillCount).toBe(0);
  });

  it('kills running and orphaned processes synchronously for forceQuit', async () => {
    const { manager, updates } = makeManager();
    await manager.start({
      taskId: 'sync-kill-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'sync-kill-1' && u.status === 'running');
    expect(manager.killAllSync()).toBe(1);
    // 关门:同步清扫之后 manager 不再接受新命令(在飞的那条由 post-spawn 复查处拒掉)。
    await expect(manager.start({ command: 'echo hi', shell: NODE_EVAL_SHELL }))
      .rejects.toThrow(/unavailable/);
    // 同步路径自己不发终态 update,但进程必须真的死:退出事件到达后记录被 finalize
    // (并按 stopRequested 报 stopped),第二次尝试无对象可杀。
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(manager.killAllSync()).toBe(0);
    expect(manager.list()).toEqual([]);
    const terminal = updates.find((u) => u.taskId === 'sync-kill-1' && u.status === 'stopped');
    expect(terminal).toBeTruthy();
    expect(updates.some((u) => u.taskId === 'sync-kill-1' && u.status === 'running')).toBe(true);
  });

  it('killAllSync also reclaims dispose leftovers (finalized but still alive)', async () => {
    const { manager, updates } = makeManager();
    // SIGTERM 处理器注册后才写 ready:dispose 的 SIGTERM 一定被忽略,进程留在
    // pendingKills 里(已 finalized、未 exit)。同步清扫必须按 exit 而不是 finalized 判活,
    // 否则更新重启的 forceQuit 会漏掉这批最可能变成孤儿的进程。
    await manager.start({
      taskId: 'sync-pending-1',
      command: 'process.on("SIGTERM", function () {}); process.stdout.write("ready"); setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'sync-pending-1' && u.status === 'running');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if ((await readFile(updates[0].logPath, 'utf8').catch(() => '')).includes('ready')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await manager.dispose();
    if (process.platform !== 'win32') {
      expect(manager.pendingKillCount).toBe(1);
    }
    const killed = manager.killAllSync();
    expect(killed).toBeGreaterThanOrEqual(0);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(manager.pendingKillCount).toBe(0);
  });

  it('keeps the raw PI tool call id and derives a safe log file name', async () => {
    const { manager, updates, logDir } = makeManager();
    // 渲染层用 taskId 配回聊天流的 tool_use,所以 host 不得因为字符集不匹配就换 id;
    // 路径安全改由派生文件名保证。
    const weirdId = 'call/../../evil id';
    const started = await manager.start({
      taskId: weirdId,
      command: 'process.stdout.write("ok")',
      shell: NODE_EVAL_SHELL,
    });
    expect(started.taskId).toBe(weirdId);
    expect(path.dirname(started.logPath)).toBe(logDir);
    expect(path.basename(started.logPath)).toMatch(/^task-[0-9a-f]{32}\.log$/);
    const terminal = await waitForUpdate(updates, (u) => u.status !== 'running');
    expect(terminal.taskId).toBe(weirdId);
    // 目录里只应有这一份日志(没有逃逸出去的 `evil id.log`);`owner-<pid>.json` 是删除侧的
    // 归属标记(见 removePiBackgroundCommandRoot),不算日志。
    const listed = (await readdir(logDir)).filter((name) => !isOwnerMarker(name));
    expect(listed).toEqual([path.basename(started.logPath)]);
  });

  it('rejects a duplicate task id instead of truncating the first log', async () => {
    const { manager, updates, logDir } = makeManager();
    await manager.start({
      taskId: 'dup-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForUpdate(updates, (u) => u.taskId === 'dup-1' && u.status === 'running');
    // 同一 taskId 并发/重试:必须在同步段就被拒,不能开第二条日志流(会截断第一条)、
    // 更不能让第一个进程失去句柄(谁都杀不到 = detached 泄漏)。
    await expect(manager.start({
      taskId: 'dup-1',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    })).rejects.toThrow(/already running/);
    expect(manager.list().map((t) => t.taskId)).toEqual(['dup-1']);
    expect((await readdir(logDir)).filter((n) => !isOwnerMarker(n)))
      .toEqual(['dup-1.log']);
    expect(await manager.stop('dup-1')).toBe('stopped');
  });

  it('bounds the on-disk log while keeping the tail available', async () => {
    const { manager, updates } = makeManager();
    // 输出超过上限:日志文件按上限截断,summary 仍取尾部(内存 tail 有界)。
    await manager.start({
      taskId: 'big-1',
      command: 'process.stdout.write("a".repeat(9 * 1024 * 1024) + "END-OF-BIG-OUTPUT");',
      shell: NODE_EVAL_SHELL,
    });
    const terminal = await waitForUpdate(
      updates,
      (u) => u.taskId === 'big-1' && u.status !== 'running',
      20_000,
    );
    expect(terminal.status).toBe('completed');
    expect(terminal.summary?.length ?? 0).toBeLessThanOrEqual(2_000);
    // 终态 summary 必须是**最新**那段(单块超预算时走裁剪分支),而不是被丢掉的头部。
    expect(terminal.summary?.endsWith('END-OF-BIG-OUTPUT')).toBe(true);
    // 日志文件不会无限增长(有界写盘;这里只断言远小于实际输出)。
    const logStat = await stat(terminal.logPath);
    expect(logStat.size).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe('buildPiBackgroundCommandEnv', () => {
  it('strips dynamic and static secrets and points PI_CODING_AGENT_DIR at the isolated home', () => {
    const env = buildPiBackgroundCommandEnv({
      spawnEnv: {
        PATH: '/usr/bin',
        CINDY_PI_API_KEY: 'secret',
        CINDY_PI_PERMISSION_FILE: '/tmp/perm.json',
        CINDY_PI_SUBAGENT_RUN_DIR: '/tmp/runs',
        PI_PACKAGE_DIR: '/tmp/packages',
        PI_CODING_AGENT_DIR: '/tmp/config-home',
      },
      dynamicSecretEnvNames: ['CINDY_PI_API_KEY'],
      bashPackageHome: '/tmp/config-home/bash-package-home',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CINDY_PI_API_KEY).toBeUndefined();
    expect(env.CINDY_PI_PERMISSION_FILE).toBeUndefined();
    expect(env.CINDY_PI_SUBAGENT_RUN_DIR).toBeUndefined();
    expect(env.PI_PACKAGE_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/config-home/bash-package-home');
  });

  it('fails closed when the isolated package home is missing or relative', () => {
    // 与 bridge 的 isolatedBashEnvironment 同口径:坏了必须抛,不能静默把坏路径写进
    // PI_CODING_AGENT_DIR 让后台命令在未隔离/错误隔离的目录下跑(前台 bash 会抛)。
    expect(() => buildPiBackgroundCommandEnv({
      spawnEnv: {},
      dynamicSecretEnvNames: [],
      bashPackageHome: '',
    })).toThrow(/package home/);
    expect(() => buildPiBackgroundCommandEnv({
      spawnEnv: {},
      dynamicSecretEnvNames: [],
      bashPackageHome: 'bash-package-home',
    })).toThrow(/package home/);
  });
});

describe('parsePiBackgroundCommandShellSpec', () => {
  it('accepts a well-formed spec and normalises the transport', () => {
    expect(parsePiBackgroundCommandShellSpec({
      shell: '/bin/bash',
      args: ['-lc'],
      commandTransport: 'stdin',
    })).toEqual({ shell: '/bin/bash', args: ['-lc'], commandTransport: 'stdin' });
    expect(parsePiBackgroundCommandShellSpec({ shell: 'bash', args: [] }))
      .toEqual({ shell: 'bash', args: [], commandTransport: 'standard' });
  });

  it('rejects malformed specs', () => {
    expect(parsePiBackgroundCommandShellSpec(null)).toBeNull();
    expect(parsePiBackgroundCommandShellSpec({ shell: '', args: [] })).toBeNull();
    expect(parsePiBackgroundCommandShellSpec({ shell: '/bin/bash', args: [1] })).toBeNull();
    expect(parsePiBackgroundCommandShellSpec({ shell: '/bin/bash', args: 'x' })).toBeNull();
    expect(parsePiBackgroundCommandShellSpec({ shell: 'a\nb', args: [] })).toBeNull();
  });
});

describe('sweepStalePiBackgroundCommandAnonRoots', () => {
  function seedRoot(entries: string[]): { agentHome: string; root: string } {
    const agentHome = makeTempRoot();
    const root = path.join(agentHome, 'runtime', 'pi-bash-tasks');
    mkdirSync(root, { recursive: true });
    for (const entry of entries) {
      mkdirSync(path.join(root, entry), { recursive: true });
      writeFileSync(path.join(root, entry, 'call-1.log'), 'x');
    }
    return { agentHome, root };
  }

  async function listRoot(root: string): Promise<string[]> {
    return (await readdir(root)).sort();
  }

  it('removes anon dirs whose owner pid is gone and keeps everything else', async () => {
    const { agentHome, root } = seedRoot([
      // owner 已死 → 删
      'anon-424242-1700000000000',
      // owner 还活着(另一个并发实例)→ 留
      'anon-515151-1700000000001',
      // 名字不合规(手工建的 / 将来换格式)→ 不动,别猜
      'anon-not-a-pid',
      'anon-424242',
      // 真正有会话的目录:不在本 sweep 范围内(TTL/配额是另一个议题)
      'sess-abc',
    ]);
    const alive = new Set([515151]);
    const removed = await sweepStalePiBackgroundCommandAnonRoots(agentHome, {
      isProcessAlive: (pid) => alive.has(pid),
    });
    expect(removed).toBe(1);
    expect(await listRoot(root)).toEqual([
      'anon-424242',
      'anon-515151-1700000000001',
      'anon-not-a-pid',
      'sess-abc',
    ]);
  });

  it('treats EPERM as alive in the default probe (never deletes another user instance logs)', async () => {
    const { agentHome, root } = seedRoot(['anon-777777-1700000000000']);
    // 默认判据:process.kill 抛 EPERM = 进程在,只是本进程无权发信号(另一个用户 /
    // 提权实例)。判死会删掉那个实例正在写的日志目录 —— 必须按活处理。
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('kill EPERM') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    try {
      await expect(sweepStalePiBackgroundCommandAnonRoots(agentHome)).resolves.toBe(0);
      expect(await listRoot(root)).toEqual(['anon-777777-1700000000000']);
    } finally {
      spy.mockRestore();
    }
    // ESRCH 才是「查无此进程」→ 删。
    const spy2 = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('kill ESRCH') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });
    try {
      await expect(sweepStalePiBackgroundCommandAnonRoots(agentHome)).resolves.toBe(1);
      expect(await listRoot(root)).toEqual([]);
    } finally {
      spy2.mockRestore();
    }
  });

  it('never removes this process own anon dir, and tolerates a missing root', async () => {
    const { agentHome, root } = seedRoot([`anon-${process.pid}-1700000000000`]);
    // 本进程 pid 在 isProcessAlive 里必然为 true,但也显式断言"等于 process.pid 直接跳过"
    const removed = await sweepStalePiBackgroundCommandAnonRoots(agentHome, {
      isProcessAlive: () => false,
    });
    expect(removed).toBe(0);
    expect(await listRoot(root)).toEqual([`anon-${process.pid}-1700000000000`]);
    await expect(sweepStalePiBackgroundCommandAnonRoots(makeTempRoot())).resolves.toBe(0);
  });
});

describe('removePiBackgroundCommandRoot owner 判定', () => {
  function seedDir(ownerPids: Array<number | string> = [], content?: string): string {
    const root = makeTempRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'call-1.log'), 'x');
    for (const entry of ownerPids) {
      const name = typeof entry === 'number' ? ownerFileName(entry) : entry;
      writeFileSync(path.join(root, name), content ?? JSON.stringify({ pid: entry, at: Date.now() }));
    }
    return root;
  }

  it('keeps a directory whose ownership marker points at another live process', async () => {
    const root = seedDir([4242]);
    await expect(
      removePiBackgroundCommandRoot(root, { isProcessAlive: () => true }),
    ).resolves.toBe('kept-foreign-owner');
    // 目录与日志都还在:那台实例的命令可能仍在往里写。
    expect(existsSync(path.join(root, 'call-1.log'))).toBe(true);
  });

  it('keeps it when another live instance declared ownership next to ours', async () => {
    // 单个 owner.json 会被后来者覆盖:实例 A、B 共用同一 sessionId 目录时,A 最后写入、
    // 然后 A 删会话 —— 标记指向自己就会连 B 仍在写的日志一起删掉。每实例一个文件后,
    // B 的标记不会被 A 覆盖,删除侧看到 B 还活着就保留。
    const root = seedDir([process.pid, 4242]);
    await expect(
      removePiBackgroundCommandRoot(root, { isProcessAlive: (pid) => pid === 4242 }),
    ).resolves.toBe('kept-foreign-owner');
    expect(existsSync(path.join(root, 'call-1.log'))).toBe(true);
  });

  it('still counts a marker whose content is truncated (pid comes from the file name)', async () => {
    // 归属判据必须能容忍写了一半的 JSON:判死会让另一个实例的日志被删掉。
    const root = seedDir([4242], '{"pid": 42');
    await expect(
      removePiBackgroundCommandRoot(root, { isProcessAlive: () => true }),
    ).resolves.toBe('kept-foreign-owner');
  });

  it('removes it once every declared owner is gone or is this process', async () => {
    for (const pids of [[4242], [4242, process.pid]]) {
      const root = seedDir(pids);
      await expect(
        removePiBackgroundCommandRoot(root, { isProcessAlive: () => false }),
      ).resolves.toBe('removed');
      expect(existsSync(root)).toBe(false);
    }
  });

  it('keeps an unowned directory by default and removes it only with positive evidence', async () => {
    // 没有任何标记(写入失败 / 目录来自更早的构建):无法证明没人在用 → 保守保留;
    // 有正面证据的调用方(启动期 sweep 手里是目录名里的死 pid)才关掉这一保守行为。
    const unowned = seedDir();
    await expect(removePiBackgroundCommandRoot(unowned)).resolves.toBe('kept-unowned');
    expect(existsSync(unowned)).toBe(true);
    await expect(
      removePiBackgroundCommandRoot(unowned, { keepWhenUnowned: false }),
    ).resolves.toBe('removed');
    expect(existsSync(unowned)).toBe(false);

    // 名字不成形的标记文件(旧 owner.json / owner-abc.json)不算归属声明。
    const shapeless = seedDir(['owner.json', 'owner-abc.json']);
    await expect(removePiBackgroundCommandRoot(shapeless)).resolves.toBe('kept-unowned');
  });
});
describe('piBackgroundCommandRoot', () => {
  it('keeps the session id inside the runtime tree', () => {
    expect(piBackgroundCommandRoot('/home/user', 'sess-1'))
      .toBe(path.join('/home/user', 'runtime', 'pi-bash-tasks', 'sess-1'));
  });

  it('rejects unsafe session ids', () => {
    for (const sessionId of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => piBackgroundCommandRoot('/home/user', sessionId)).toThrow();
    }
  });
});
