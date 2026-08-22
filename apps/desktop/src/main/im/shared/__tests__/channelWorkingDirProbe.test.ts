/**
 * channelWorkingDirProbe.test.ts
 * ---------------------------------------------------------------------------
 * 写探针/临时文件的所有权纪律回归(六轮 review 裁决):
 *   - 只删除**本次调用确认独占创建**的文件 — 'wx' 碰撞(EEXIST)的路径属于
 *     别人, 竞争文件必须原样保留;
 *   - 删除失败接受 0 字节 UUID 残留 — 不记住路径跨时间重试(路径可能已被
 *     其它进程替换, 重试会误删替换文件), 不做前缀扫描;
 *   - 探测不经 open 手工描述符生命周期, 无句柄泄漏面。
 *
 * 另有异步化回归: 用户目录(可能在网络盘上)上的 stat/写探针/删除全走
 * node:fs/promises — 探针挂起时 Main 事件循环必须仍能运转。
 *
 * node:fs/promises 被包装注入(writeFile / rm / open 可控), 目录准备与残留
 * 断言在包装关闭时直接穿过到真实实现。
 */

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failState = vi.hoisted(() => ({
  rmFailuresRemaining: 0,
  probeWriteEexistNext: false,
  tmpWriteEexistNext: false,
  /** 探针写挂起(模拟网络盘失联): 挂起的 promise 由 releaseProbeHang 放行。 */
  probeWriteHang: false,
  /** realpath 挂起(模拟选目录时网络盘失联): 同上放行。 */
  realpathHang: false,
  hangResolvers: [] as Array<() => void>,
  rmCalls: [] as string[],
  openCalls: [] as string[],
  writeFileCalls: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isProbe = (target: string) => target.includes('.cindy-workdir-probe-');
  const wrapped = {
    async realpath(target: string, options?: Parameters<typeof actual.realpath>[1]) {
      if (failState.realpathHang) {
        await new Promise<void>((resolve) => {
          failState.hangResolvers.push(resolve);
        });
      }
      return actual.realpath(target, options);
    },
    open(...args: Parameters<typeof actual.open>) {
      failState.openCalls.push(String(args[0]));
      return actual.open(...args);
    },
    async writeFile(
      target: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) {
      failState.writeFileCalls.push(String(target));
      if (failState.probeWriteHang && isProbe(String(target))) {
        await new Promise<void>((resolve) => {
          failState.hangResolvers.push(resolve);
        });
      }
      // 模拟「其它进程抢先占住同一路径」: 真实写一份竞争内容, 再按 'wx'
      // 语义抛 EEXIST。
      const eexist =
        (failState.probeWriteEexistNext && isProbe(String(target))) ||
        (failState.tmpWriteEexistNext && String(target).endsWith('.tmp'));
      if (eexist) {
        failState.probeWriteEexistNext = false;
        failState.tmpWriteEexistNext = false;
        await actual.writeFile(target, 'foreign data', 'utf8');
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }) as NodeJS.ErrnoException;
      }
      return actual.writeFile(target, data, options);
    },
    async rm(target: string, options?: import('node:fs').RmOptions) {
      failState.rmCalls.push(target);
      if (failState.rmFailuresRemaining > 0) {
        failState.rmFailuresRemaining -= 1;
        throw Object.assign(new Error('EBUSY rm'), { code: 'EBUSY' }) as NodeJS.ErrnoException;
      }
      return actual.rm(target, options);
    },
  };
  return { ...actual, ...wrapped };
});

import { readFile, mkdtemp, readdir, rm as fspRm, mkdir, writeFile as fspWriteFile } from 'node:fs/promises';

import { __testing, createChannelWorkingDirStore } from '../channelWorkingDirSettings';
import { readWecomChannelSettings, writeWecomWorkingDir } from '../../wecom/channelSettings';

let root = '';

const probeNames = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n.startsWith('.cindy-workdir-probe-'));

const probeFiles = async (): Promise<string[]> => probeNames(root);

/** 放行挂起的探针写并恢复直通。 */
function releaseProbeHang(): void {
  failState.probeWriteHang = false;
  const resolvers = failState.hangResolvers.splice(0);
  for (const resolve of resolvers) resolve();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-workdir-probe-'));
  __testing.resetProbeScheduler();
  failState.rmFailuresRemaining = 0;
  failState.probeWriteEexistNext = false;
  failState.tmpWriteEexistNext = false;
  failState.probeWriteHang = false;
  failState.realpathHang = false;
  failState.hangResolvers.length = 0;
  failState.rmCalls.length = 0;
  failState.openCalls.length = 0;
  failState.writeFileCalls.length = 0;
});

afterEach(async () => {
  releaseProbeHang();
  await fspRm(root, { recursive: true, force: true });
});

describe('isUsableWorkingDirectory 探针生命周期', () => {
  it('可写目录判定为可用且不留探针残留, 且不经手工 fd 生命周期', async () => {
    expect(await __testing.isUsableWorkingDirectory(root)).toBe(true);

    expect(failState.openCalls).toEqual([]); // 不持 fd
    expect(failState.writeFileCalls.length).toBe(1); // 单次独占创建
    expect(failState.rmCalls.length).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('目录变成文件后判定为不可用, 且不产生任何写入', async () => {
    const file = path.join(root, 'now-a-file');
    await fspWriteFile(file, 'x');
    // setup 写入也过 wrapper, 清掉记录只观察探测这一次调用。
    failState.writeFileCalls.length = 0;

    expect(await __testing.isUsableWorkingDirectory(file)).toBe(false);
    expect(failState.writeFileCalls).toEqual([]);
  });

  it('独占创建碰撞(EEXIST)时判定不可用, 竞争文件原样保留', async () => {
    failState.probeWriteEexistNext = true;

    expect(await __testing.isUsableWorkingDirectory(root)).toBe(false);

    // 碰撞路径属于别人: finally 绝不删除未由本次调用创建的文件。
    const collided = failState.writeFileCalls[0]!;
    expect(await readFile(collided, 'utf8')).toBe('foreign data');
    expect(failState.rmCalls).toEqual([]);
  });

  it('rm 失败接受 0 字节残留; 旧路径(即使被替换)与用户同前缀文件都不再触碰', async () => {
    const userNote = path.join(root, '.cindy-workdir-probe-user-note');
    await fspWriteFile(userNote, 'user data');

    // 探测1: 自己的探针删不掉(锁) → 残留, 但不记住路径。
    failState.rmFailuresRemaining = 1;
    expect(await __testing.isUsableWorkingDirectory(root)).toBe(true);
    const residue = (await probeFiles()).find((n) => n !== '.cindy-workdir-probe-user-note')!;
    expect(residue).toBeTruthy();

    // 旧路径已被「其它进程」替换成有意义内容。
    await fspWriteFile(path.join(root, residue), 'replaced by someone else');

    // 探测2(锁解除): 只清理本次自己的探针, 不触碰旧路径, 不触碰用户文件。
    expect(await __testing.isUsableWorkingDirectory(root)).toBe(true);
    expect(await readFile(path.join(root, residue), 'utf8')).toBe('replaced by someone else');
    expect(await readFile(userNote, 'utf8')).toBe('user data');
    const names = await probeFiles();
    expect(names.sort()).toEqual([residue, '.cindy-workdir-probe-user-note'].sort());
  });
});

describe('配置临时文件的所有权', () => {
  it('tmp 独占碰撞(EEXIST)时写入失败, 碰撞文件与既有配置保留', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    // 已有一份合法配置, 碰撞不应破坏它。
    await writeWecomWorkingDir(selected, root);
    const settingsFile = path.join(root, 'wecom-channel.json');
    const before = await readFile(settingsFile, 'utf8');

    // 清掉 setup 阶段的记录, 只观察碰撞这一次调用。
    failState.writeFileCalls.length = 0;
    failState.tmpWriteEexistNext = true;
    const other = path.join(root, 'other');
    await mkdir(other);
    await expect(writeWecomWorkingDir(other, root)).rejects.toThrow('EEXIST');

    const collided = failState.writeFileCalls.find((c) => c.endsWith('.tmp'))!;
    expect(await readFile(collided, 'utf8')).toBe('foreign data');
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
  });
});

describe('用户目录 IO 异步化(Main 事件循环不被冻结)', () => {
  it('配置目录的探针挂起时, 定时器仍能如期触发(同步 statSync/writeFileSync 会阻塞到它返回)', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    await writeWecomWorkingDir(selected, root);

    // 挂起「配置目录上的探针写」: 模拟网络盘失联 — stat 正常, 写入永不落定。
    failState.probeWriteHang = true;
    const pending = readWecomChannelSettings(root);

    let loopAlive = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        loopAlive = true;
        resolve();
      }, 20);
    });
    expect(loopAlive).toBe(true);
    expect(failState.hangResolvers.length).toBe(1);

    // 放行后探测照常完成, 不留残留。
    releaseProbeHang();
    const state = await pending;
    expect(state.workingDir).toBeTruthy();
    expect(state.workingDirAvailable).toBe(true);
    expect(await readdir(selected)).toEqual([]);
  });
});

describe('探针调度(同目录复用 / 超时冷却 / 全局并发上限)', () => {
  const probeWriteCount = (): number =>
    failState.writeFileCalls.filter((c) => c.includes('.cindy-workdir-probe-')).length;

  it('相同目录的并发探测复用同一份底层探针, 不叠加占线程', async () => {
    const dir = path.join(root, 'shared');
    await mkdir(dir);
    failState.probeWriteHang = true;

    const first = __testing.isUsableWorkingDirectory(dir, 5_000);
    const second = __testing.isUsableWorkingDirectory(dir, 5_000);
    // stat 是异步的, 等底层 'wx' 写真正发出后断言只有一份。
    await vi.waitFor(() => expect(probeWriteCount()).toBe(1));

    releaseProbeHang();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await probeNames(dir)).toEqual([]);
  });

  it('探测超时进入冷却: 冷却期内的再次探测直接按不可用返回, 不再发起底层写', async () => {
    const dir = path.join(root, 'cooldown');
    await mkdir(dir);
    failState.probeWriteHang = true;

    const startedFirst = Date.now();
    expect(await __testing.isUsableWorkingDirectory(dir, 120)).toBe(false);
    expect(Date.now() - startedFirst).toBeLessThan(2_000);
    await vi.waitFor(() => expect(probeWriteCount()).toBe(1));

    // 冷却期内再探: 立即 false, 且没有第二次底层写(冷却优先于复用 — 不再
    // 挂到仍在挂起的旧探针上等满自己的 deadline)。
    failState.probeWriteHang = false;
    const startedSecond = Date.now();
    expect(await __testing.isUsableWorkingDirectory(dir, 5_000)).toBe(false);
    expect(Date.now() - startedSecond).toBeLessThan(2_000);
    expect(probeWriteCount()).toBe(1);

    releaseProbeHang();
    await vi.waitFor(async () => {
      expect(await probeNames(dir)).toEqual([]);
    });
  });

  it('在途探针超过全局上限时, 新目录的探测直接拒绝, 不再占用线程', async () => {
    const max = __testing.probeLimits.maxConcurrent;
    const dirs: string[] = [];
    for (let i = 0; i <= max; i += 1) {
      const dir = path.join(root, `cap-${i}`);
      await mkdir(dir);
      dirs.push(dir);
    }
    failState.probeWriteHang = true;

    const pending = dirs.slice(0, max).map((dir) => __testing.isUsableWorkingDirectory(dir, 5_000));
    await vi.waitFor(() => expect(probeWriteCount()).toBe(max));

    // 第 max+1 个不同目录: 超上限 → 立即 false, 底层写数量不变。
    const started = Date.now();
    expect(await __testing.isUsableWorkingDirectory(dirs[max]!, 5_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probeWriteCount()).toBe(max);

    releaseProbeHang();
    await Promise.all(pending);
  });
});

describe('用户目录探测 deadline(失联网络盘)', () => {
  /** 小超时 + TEST 前缀的独立 store — deadline 行为与渠道无关。 */
  function makeStore(userDirTimeoutMs: number) {
    return createChannelWorkingDirStore({
      logTag: 'im/test/channel-settings',
      fileName: 'test-channel.json',
      errorCodePrefix: 'TEST',
      managedDirNameFor: (botId) => `test-${botId}`,
      userDirTimeoutMs,
    });
  }

  it('设置读取在 deadline 内返回不可用, 新对话限时回退托管目录', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    const store = makeStore(120);
    await store.writeWorkingDir(selected, root);

    failState.probeWriteHang = true;
    const startedRead = Date.now();
    const state = await store.read(root);
    expect(Date.now() - startedRead).toBeLessThan(2_000);
    expect(state.workingDir).toBeTruthy();
    expect(state.workingDirAvailable).toBe(false);

    // 首次对话 / /new 边界同样限时 — 不可用即回退托管目录, 不无限等待。
    const startedResolve = Date.now();
    const resolved = await store.resolveWorkingDirForNewConversation('bot-1', root);
    expect(Date.now() - startedResolve).toBeLessThan(2_000);
    expect(resolved).toBe(path.join(root, 'im-working-dir', 'test-bot-1'));

    // 迟到的探针写(两次探测各一枚)放行后由各自调用清理, 不留残留。
    releaseProbeHang();
    await vi.waitFor(async () => {
      expect(await probeNames(selected)).toEqual([]);
    });
  });

  it('选择新目录探测超时: 不提交配置, 抛结构化超时错误', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    const store = makeStore(120);
    await store.writeWorkingDir(selected, root);
    const configPath = path.join(root, 'test-channel.json');
    const before = await readFile(configPath, 'utf8');

    // 新目录的 realpath 挂起(失联网络盘), 限时内必须以超时错误收场。
    const fresh = path.join(root, 'fresh');
    await mkdir(fresh);
    failState.realpathHang = true;
    const started = Date.now();
    await expect(store.writeWorkingDir(fresh, root)).rejects.toMatchObject({
      code: 'TEST_WORKING_DIR_PROBE_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    // 未提交: 既有配置原样保留。
    expect(await readFile(configPath, 'utf8')).toBe(before);

    releaseProbeHang();
  });

  it('新选择目录的写探针超时: 不提交, 旧配置原样保留, 迟到探针自清理', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    const store = makeStore(120);
    await store.writeWorkingDir(selected, root);
    const configPath = path.join(root, 'test-channel.json');
    const before = await readFile(configPath, 'utf8');

    // realpath/stat 正常, 但 'wx' 写探针挂起(慢速网络盘) — 严格校验在 commit
    // 之前完成, 超时绝不提交。
    const fresh = path.join(root, 'fresh');
    await mkdir(fresh);
    failState.probeWriteHang = true;
    const started = Date.now();
    await expect(store.writeWorkingDir(fresh, root)).rejects.toMatchObject({
      code: 'TEST_WORKING_DIR_PROBE_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readFile(configPath, 'utf8')).toBe(before);

    // 迟到的探针写最终成功 — 由本次调用按所有权纪律清理自己那枚。
    releaseProbeHang();
    await vi.waitFor(async () => {
      expect(await probeNames(fresh)).toEqual([]);
    });
  });

  it('新选择目录不可写(wx 独占碰撞): 不提交, 碰撞文件原样保留', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    const store = makeStore(120);
    await store.writeWorkingDir(selected, root);
    const configPath = path.join(root, 'test-channel.json');
    const before = await readFile(configPath, 'utf8');

    const fresh = path.join(root, 'fresh');
    await mkdir(fresh);
    failState.probeWriteEexistNext = true;
    await expect(store.writeWorkingDir(fresh, root)).rejects.toMatchObject({
      code: 'TEST_WORKING_DIR_NOT_WRITABLE',
    });
    expect(await readFile(configPath, 'utf8')).toBe(before);

    // 碰撞路径属于「别人」: 原样保留, 绝不删除。
    const collided = await probeNames(fresh);
    expect(collided).toHaveLength(1);
    expect(await readFile(path.join(fresh, collided[0]!), 'utf8')).toBe('foreign data');
  });

  it('超时后迟到完成的探针只清理自己创建的文件, 不误删用户同前缀文件', async () => {
    const selected = path.join(root, 'project');
    await mkdir(selected);
    const userNote = path.join(selected, '.cindy-workdir-probe-user-note');
    await fspWriteFile(userNote, 'user data');
    const store = makeStore(120);
    await store.writeWorkingDir(selected, root);

    failState.probeWriteHang = true;
    expect((await store.read(root)).workingDirAvailable).toBe(false);

    // 放行: 迟到的 'wx' 创建最终成功 — 由本次调用的 finally 清理自己那枚;
    // 未确认创建过任何东西的超时路径绝不触碰用户文件。
    releaseProbeHang();
    await vi.waitFor(async () => {
      expect(await probeNames(selected)).toEqual(['.cindy-workdir-probe-user-note']);
    });
    expect(await readFile(userNote, 'utf8')).toBe('user data');
  });
});
