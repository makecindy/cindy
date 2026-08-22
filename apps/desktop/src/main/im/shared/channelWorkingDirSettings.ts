/**
 * Owner-scoped, non-secret channel working-directory override store.
 *
 * 直连 IM 渠道(个人微信/企业微信)共用的工作目录配置:只持久化用户在 Main
 * 原生目录选择器里选中的 override,不保存静态默认值快照(「恢复默认」= 删文件);
 * 配置缺失、损坏或目录暂不可访问时安全回退渠道托管目录,不阻断入站消息。
 * 渠道差异(配置文件名、错误码前缀、托管目录命名)经工厂参数注入。
 *
 * Main 线程纪律: 用户所选目录可能在网络盘/可移动盘上, stat/realpath/写探针/
 * 删除全部走 node:fs/promises —— 挂起只阻塞当前 IPC/解析, 不冻结事件循环;
 * 且整条用户目录链路套 deadline(userDirTimeoutMs, 默认 5s): 失联网络盘下
 * 设置读取限时返回 workingDirAvailable:false, 新对话解析回退托管目录,
 * 选择新目录不提交配置并抛结构化超时错误。超时不取消底层操作(Node fs
 * 无法取消) — 迟到的写探针若最终创建成功, 仍由本次调用的 finally 按
 * 所有权纪律清理; 清理迟到/失败按既有纪律接受 0 字节残留。
 * 只有 userData(rootPath 测试桩)下的托管目录与配置文件属于本机盘, 同步
 * mkdirSync / 异步落盘均可接受。目录解析拆成两层:
 *   - ensureManagedWorkingDir(): 稳定托管目录, 同步, 供 sessionRepo 等热路径;
 *   - resolveWorkingDirForNewConversation(): 异步读配置 + 探测用户目录, 只在
 *     设置刷新、首次对话与 /new 边界调用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';

import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import { createLogger, maskPath } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

const SETTINGS_VERSION = 1;

/**
 * 用户目录 IO 的统一 deadline。取值权衡: 太短会把高延迟但活着的网络盘误判
 * 不可用(/new 会回退托管目录); 太长则设置读取/选目录让用户久等。5s 覆盖
 * 常规网盘抖动, 超过它按「当前不可用」处理 —— 目录恢复后的下一次设置刷新
 * 或新对话会重新探测回来。测试经工厂参数 userDirTimeoutMs 缩小。
 */
const USER_DIR_IO_TIMEOUT_MS = 5_000;

export interface ChannelWorkingDirSettings {
  version: typeof SETTINGS_VERSION;
  workingDir: string | null;
}

export interface ChannelWorkingDirSettingsState extends ChannelWorkingDirSettings {
  workingDirAvailable: boolean;
}

/**
 * 用户目录探测的执行边界。默认实现跑在本进程(单测用它 + fs mock);生产环境
 * 由 im/index.ts 注入 workdir-probe-host 的 utility-process 执行器 —— Node 的
 * fs 调用不可取消, 失联网络盘会把挂死 IO 留在 libuv 线程池里, 子进程化后
 * 超时即终止回收(review P1: 槽位被永久挂起的探针占满会饿死健康目录)。
 * 同目录 single-flight / 超时冷却 / 并发上限在 store 层保留, 作为减少探测
 * 次数的优化。
 */
export type UserDirValidateOutcome =
  | { ok: true; realPath: string }
  /** code: NOT_DIRECTORY / NOT_WRITABLE / PROBE_TIMEOUT / PROBE_UNAVAILABLE / 原生 fs 码 */
  | { ok: false; code: string };
export type UserDirAvailabilityOutcome =
  | { ok: true; usable: boolean }
  | { ok: false; code: string };

export interface ChannelUserDirProbeExecutor {
  /** 严格校验新选择目录: realpath → stat → 'wx' 写探针 → 清理。 */
  validate(selectedPath: string, timeoutMs: number): Promise<UserDirValidateOutcome>;
  /** 已保存目录可用性: stat → 'wx' 写探针 → 清理(失败宽大降级)。 */
  availability(candidate: string, timeoutMs: number): Promise<UserDirAvailabilityOutcome>;
}

/** 进程内默认执行器(单测与兜底); 生产经 setProbeExecutor 换成子进程执行器。 */
function createInProcessUserDirProbeExecutor(): ChannelUserDirProbeExecutor {
  return {
    async validate(selectedPath, timeoutMs) {
      const checked = await withUserDirDeadline(async () => {
        const realPath = await realpath(selectedPath);
        if (!(await stat(realPath)).isDirectory()) {
          return { ok: false as const, code: 'NOT_DIRECTORY' };
        }
        if (!(await probeUsability(realPath))) {
          return { ok: false as const, code: 'NOT_WRITABLE' };
        }
        return { ok: true as const, realPath };
      }, timeoutMs);
      return checked ?? { ok: false, code: 'PROBE_TIMEOUT' };
    },
    async availability(candidate, timeoutMs) {
      const verdict = await withUserDirDeadline(() => probeUsability(candidate), timeoutMs);
      if (verdict === null) return { ok: false, code: 'PROBE_TIMEOUT' };
      return { ok: true, usable: verdict };
    },
  };
}

export interface ChannelWorkingDirStore {
  /**
   * 替换用户目录探测执行边界(im/index.ts 启动时注入 utility-process 执行器)。
   * 在途请求沿用旧执行器跑完; 只影响后续探测。
   */
  setProbeExecutor(executor: ChannelUserDirProbeExecutor): void;
  /** 设置刷新(设置页展开/聚焦 IPC)用: 异步读配置 + 异步探测用户目录可用性。 */
  read(rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /** 校验并写入用户所选目录(一步到位版): 异步 normalize + 异步落盘。 */
  writeWorkingDir(selectedPath: string, rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /**
   * 严格校验并规整用户**新选择**的目录(不落盘): realpath → stat → 'wx' 写
   * 探针 → 清理在同一 deadline 内完成, 任一步失败/超时抛带 .code 的错误,
   * 调用方不得进入 commit。返回存储形态路径。
   */
  normalizeSelectedDirectory(selectedPath: string): Promise<string>;
  /**
   * 落盘已通过严格校验的目录: 只原子写 owner-scoped 本地配置(userData),
   * 直接返回 workingDirAvailable:true — 边界内不访问用户目录。供 IPC 在
   * 「用户盘校验完成」与「提交」之间二次校验 IM account generation 后调用,
   * 校验到写入之间只剩本机盘 IO。
   */
  commitWorkingDir(normalizedDir: string, rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /** 「恢复默认」= 删配置文件(本地 userData)。 */
  resetWorkingDir(rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /**
   * 稳定托管目录(userData 本机盘, 同步 mkdir 不会挂起 Main)。会话行的兜底
   * 目录与归属比较都用它 —— 不读配置、不探测用户盘。
   */
  ensureManagedWorkingDir(botId: string, rootPath?: string): string;
  /** 解析新对话实际目录: 异步读配置 + 探测用户目录, 不可用回退托管目录。 */
  resolveWorkingDirForNewConversation(
    botId: string,
    rootPath?: string,
  ): Promise<string>;
}

export function createChannelWorkingDirStore(options: {
  /** 日志 tag,如 'im/wecom/channel-settings'。 */
  logTag: string;
  /** owner-scoped 配置文件名,如 'wecom-channel.json'。 */
  fileName: string;
  /** 校验错误码前缀,如 'WECOM' → 'WECOM_WORKING_DIR_INVALID'。 */
  errorCodePrefix: string;
  /** botId → 托管目录名。渠道各自的既定命名,存量目录依赖它保持稳定。 */
  managedDirNameFor(botId: string): string;
  /**
   * 用户目录 IO(realpath/stat/写探针/清理)的 deadline, 默认 5s — 主要供
   * 测试缩小。本机盘(userData 配置与托管目录)不受它约束。
   */
  userDirTimeoutMs?: number;
  /** 用户目录探测执行边界;缺省为进程内执行器(单测), 生产由 im/index.ts 注入。 */
  probeExecutor?: ChannelUserDirProbeExecutor;
}): ChannelWorkingDirStore {
  const log = createLogger(options.logTag);
  const invalidErrorCode = `${options.errorCodePrefix}_WORKING_DIR_INVALID`;
  const notDirectoryErrorCode = `${options.errorCodePrefix}_WORKING_DIR_NOT_DIRECTORY`;
  const probeTimeoutErrorCode = `${options.errorCodePrefix}_WORKING_DIR_PROBE_TIMEOUT`;
  const notWritableErrorCode = `${options.errorCodePrefix}_WORKING_DIR_NOT_WRITABLE`;
  const userDirTimeoutMs = options.userDirTimeoutMs ?? USER_DIR_IO_TIMEOUT_MS;
  let probeExecutor: ChannelUserDirProbeExecutor =
    options.probeExecutor ?? createInProcessUserDirProbeExecutor();
  const probeScheduler = createProbeScheduler(() => probeExecutor);
  const defaults: ChannelWorkingDirSettings = { version: SETTINGS_VERSION, workingDir: null };

  function setProbeExecutor(executor: ChannelUserDirProbeExecutor): void {
    probeExecutor = executor;
  }

  /** 执行器稳定错误码 → 渠道错误码(原生 fs 码原样保留, 只进日志不落文案)。 */
  function mapValidateCode(code: string): string {
    if (code === 'NOT_DIRECTORY') return notDirectoryErrorCode;
    if (code === 'NOT_WRITABLE') return notWritableErrorCode;
    if (code === 'PROBE_TIMEOUT' || code === 'PROBE_UNAVAILABLE') return probeTimeoutErrorCode;
    return code;
  }

  function settingsFilePath(rootPath?: string): string {
    return rootPath
      ? path.join(rootPath, options.fileName)
      : ownerScopedImUserDataPath(options.fileName);
  }

  async function read(rootPath?: string): Promise<ChannelWorkingDirSettingsState> {
    const file = settingsFilePath(rootPath);
    try {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ...defaults, workingDirAvailable: true };
        }
        throw error;
      }
      const normalized = normalizeSettings(JSON.parse(raw));
      return {
        ...normalized,
        workingDirAvailable:
          normalized.workingDir === null ||
          (await probeScheduler.availability(normalized.workingDir, userDirTimeoutMs)) ===
            'usable',
      };
    } catch (error) {
      log.warn(`failed to read ${options.logTag} settings; using defaults`, {
        path: maskPath(file),
        errorCode: nodeErrorCode(error),
      });
      return { ...defaults, workingDirAvailable: true };
    }
  }

  async function writeWorkingDir(
    selectedPath: string,
    rootPath?: string,
  ): Promise<ChannelWorkingDirSettingsState> {
    return commitWorkingDir(await normalizeSelectedDirectory(selectedPath), rootPath);
  }

  async function normalizeSelectedDirectory(selectedPath: string): Promise<string> {
    // 校验错误自带 .code(= 渠道错误码): IPC 层日志只记错误码即可区分
    // WECOM_WORKING_DIR_INVALID / NOT_DIRECTORY / NOT_WRITABLE / EACCES...,
    // 不需要 error.message —— 原生 fs 错误的 message 含完整用户目录, 不能进日志。
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
      throw Object.assign(new Error(invalidErrorCode), { code: invalidErrorCode });
    }
    // 冷却中的路径直接超时收口, 不再向执行边界排队(重复选择同一失联目录)。
    if (probeScheduler.inCooldown(selectedPath)) {
      throw Object.assign(new Error(probeTimeoutErrorCode), { code: probeTimeoutErrorCode });
    }
    // 新选择目录采用「严格校验」: realpath → stat → 'wx' 写探针 → 清理整个
    // 链条跑在探测执行边界内(生产为 utility process, 超时即终止回收), 任一步
    // 失败/超时都不进入 commit, 原配置保持不变(与「已保存目录宽大保留」相对 —
    // 后者由 read() 降级为不可用)。
    const outcome = await probeExecutor.validate(selectedPath, userDirTimeoutMs);
    if (!outcome.ok) {
      const code = mapValidateCode(outcome.code);
      if (code === probeTimeoutErrorCode) {
        // 探测超时/执行边界不可用: 对该路径进入冷却, 重复选择不再排队。
        probeScheduler.cooldown(selectedPath);
      }
      throw Object.assign(new Error(code), { code });
    }
    const normalized = normalizeWorkingDirForStorage(outcome.realPath);
    if (!normalized) {
      throw Object.assign(new Error(invalidErrorCode), { code: invalidErrorCode });
    }
    return normalized;
  }

  async function commitWorkingDir(
    normalizedDir: string,
    rootPath?: string,
  ): Promise<ChannelWorkingDirSettingsState> {
    // 只原子写入 owner-scoped 本地配置, 直接返回 available:true — 严格校验
    // ('wx' 写探针)已在 normalizeSelectedDirectory 完成, commit 边界内不再
    // 访问用户目录(超时/不可写时配置早已不被触碰)。
    await writeSettings({ ...defaults, workingDir: normalizedDir }, rootPath);
    return { ...defaults, workingDir: normalizedDir, workingDirAvailable: true };
  }

  async function resetWorkingDir(rootPath?: string): Promise<ChannelWorkingDirSettingsState> {
    const file = settingsFilePath(rootPath);
    try {
      await rm(file, { force: true });
    } catch (error) {
      log.warn(`failed to reset ${options.logTag} settings`, {
        path: maskPath(file),
        errorCode: nodeErrorCode(error),
      });
      throw error;
    }
    return { ...defaults, workingDirAvailable: true };
  }

  function ensureManagedWorkingDir(botId: string, rootPath?: string): string {
    const dir = rootPath
      ? path.join(rootPath, 'im-working-dir', options.managedDirNameFor(botId))
      : ownerScopedImUserDataPath('im-working-dir', options.managedDirNameFor(botId));
    // 本地 userData 托管目录 — 本机盘, 同步创建不会挂起 Main 事件循环。
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function resolveWorkingDirForNewConversation(
    botId: string,
    rootPath?: string,
  ): Promise<string> {
    const configured = await read(rootPath);
    if (configured.workingDir && configured.workingDirAvailable) return configured.workingDir;
    return ensureManagedWorkingDir(botId, rootPath);
  }

  function normalizeSettings(raw: unknown): ChannelWorkingDirSettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };
    const input = raw as Record<string, unknown>;
    const workingDir =
      typeof input.workingDir === 'string' && path.isAbsolute(input.workingDir)
        ? normalizeWorkingDirForStorage(input.workingDir)
        : null;
    return {
      version: SETTINGS_VERSION,
      workingDir,
    };
  }

  /**
   * tmp + rename 原子落盘:崩溃不会留下半份 JSON。
   * tmp 只有在本调用确认独占创建成功后才清理 — 'wx' 碰撞(EEXIST)说明那个
   * 路径属于别人, 无条件 rm 会删掉竞争文件(P0)。
   */
  async function writeSettings(settings: ChannelWorkingDirSettings, rootPath?: string): Promise<void> {
    const file = settingsFilePath(rootPath);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    let tmpCreated = false;
    try {
      await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      tmpCreated = true;
      await rename(tmp, file);
    } finally {
      if (tmpCreated) {
        try {
          // rename 成功后是 ENOENT 幂等 no-op;rename 失败则清掉自己的半成品。
          await rm(tmp, { force: true });
        } catch {
          // 清理被锁挡住: 接受 tmp 残留, 不掩盖真正的写入错误。
        }
      }
    }
  }

  return {
    setProbeExecutor,
    read,
    writeWorkingDir,
    normalizeSelectedDirectory,
    commitWorkingDir,
    resetWorkingDir,
    ensureManagedWorkingDir,
    resolveWorkingDirForNewConversation,
  };
}

/**
 * 目录「可用」按工作目录的实际用途判定: agent 要往里写文件。stat/access 都
 * 只能证明「存在」— 遍历/写权限被收回时它们仍成功(Windows 上 access 对目录
 * 基本恒过), 随后 /new 会拿到一个无法使用的目录而不是回退托管目录。所以用
 * 真写入探测: `writeFile(flag 'wx')` 独占创建并删除一个一次性 0 字节探针 —
 * 全异步, 不经 open/close 手工描述符生命周期; 整条链路套 deadline, 失联
 * 网络盘在限时内返回「不可用」, 探测本体超时后继续跑完, 迟到创建成功的
 * 探针仍由本次调用按所有权纪律清理。
 *
 * 删除的所有权纪律(六轮 review 裁决, 两条都不可退让):
 *   - **绝不按文件名前缀扫描删除** — 用户自建的同前缀文件不属于 Cindy。
 *   - **只删除本次调用确认独占创建的探针** — 'wx' 碰撞(EEXIST)说明那个
 *     路径属于别人; 「记住路径跨时间重试」也不行, 路径被其它进程替换后
 *     重试会删掉替换文件。删除失败(锁)与「超时后才创建成功但清理迟到」
 *     都接受 0 字节 UUID 残留, 不设任何延迟重试队列。
 */
const WORKDIR_PROBE_PREFIX = '.cindy-workdir-probe-';

/**
 * 探针调度(review P2: deadline 只让调用者提前返回, 底层 fs 调用仍占着
 * libuv 线程 — 反复聚焦设置页//new 会累积挂起探针, 拖住其它异步文件操作)。
 * 最低可接受修法, 模块级共享(跨渠道, 同一台机器):
 *   - **同目录复用**: 相同目录的在途探针只跑一份底层 IO, 并发调用共享结果;
 *   - **超时冷却**: 某目录探测超时后进入冷却期(PROBE_COOLDOWN_MS), 期间
 *     不再为它发起底层探针, 直接按不可用/超时返回;
 *   - **全局并发上限**: 在途用户目录探针超过 MAX_CONCURRENT_USER_DIR_PROBES
 *     时新请求直接拒绝(不占线程)。真·硬终止需要把探测挪进可杀死的子进程,
 *     不在本轮范围。
 */
const PROBE_COOLDOWN_MS = 30_000;
const MAX_CONCURRENT_USER_DIR_PROBES = 8;

type ProbeVerdict = 'usable' | 'unusable' | 'timeout' | 'skipped';

interface ProbeScheduler {
  /** 可用性探测(带 single-flight / 冷却 / 并发上限)。 */
  availability(candidate: string, timeoutMs: number): Promise<ProbeVerdict>;
  /** 手动记冷却(normalize 链条超时时用)。 */
  cooldown(candidate: string): void;
  /** 该目录是否处于冷却期。 */
  inCooldown(candidate: string): boolean;
  reset(): void;
}

function createProbeScheduler(
  executor: () => ChannelUserDirProbeExecutor,
): ProbeScheduler {
  const inflightProbes = new Map<string, Promise<UserDirAvailabilityOutcome>>();
  const probeCooldownUntil = new Map<string, number>();
  let inflightProbeCount = 0;

  function acquire(
    candidate: string,
    timeoutMs: number,
  ): Promise<UserDirAvailabilityOutcome> | null {
    // 冷却判定优先于复用: 该目录已经让某次调用等超时了, 不该让后续调用再
    // 挂在(仍挂起的)旧探针上等满自己的 deadline — 直接拒绝, 立即按不可用
    // 返回; 旧探针在执行边界内自跑自清理。
    if ((probeCooldownUntil.get(candidate) ?? 0) > Date.now()) return null;
    const shared = inflightProbes.get(candidate);
    if (shared) return shared;
    if (inflightProbeCount >= MAX_CONCURRENT_USER_DIR_PROBES) return null;
    const attempt = executor()
      .availability(candidate, timeoutMs)
      .finally(() => {
        inflightProbes.delete(candidate);
        // reset 后迟到的释放不得把计数打成负数。
        inflightProbeCount = Math.max(0, inflightProbeCount - 1);
      });
    inflightProbes.set(candidate, attempt);
    inflightProbeCount += 1;
    return attempt;
  }

  return {
    async availability(candidate, timeoutMs): Promise<ProbeVerdict> {
      const attempt = acquire(candidate, timeoutMs);
      if (attempt === null) return 'skipped';
      // 执行边界保证在 timeoutMs 内 settle(子进程被 kill / 进程内 deadline),
      // 挂死的底层 IO 不会滞留在 Main 的 libuv 线程池, 槽位必然释放。
      const outcome = await attempt;
      if (outcome.ok) return outcome.usable ? 'usable' : 'unusable';
      if (outcome.code === 'PROBE_UNAVAILABLE') {
        // 执行边界自身不可用(队列满/宿主故障): 不给目录记冷却, 下次照常尝试。
        return 'skipped';
      }
      probeCooldownUntil.set(candidate, Date.now() + PROBE_COOLDOWN_MS);
      return 'timeout';
    },
    cooldown(candidate) {
      probeCooldownUntil.set(candidate, Date.now() + PROBE_COOLDOWN_MS);
    },
    inCooldown(candidate) {
      return (probeCooldownUntil.get(candidate) ?? 0) > Date.now();
    },
    reset() {
      inflightProbes.clear();
      probeCooldownUntil.clear();
      inflightProbeCount = 0;
    },
  };
}

/** __testing 直测调度行为的默认调度器(默认进程内执行器)。 */
const defaultProbeScheduler = createProbeScheduler(createInProcessUserDirProbeExecutor);

async function isUsableWorkingDirectory(
  candidate: string,
  timeoutMs: number = USER_DIR_IO_TIMEOUT_MS,
): Promise<boolean> {
  // 冷却/超限(skipped)与超时一样按「当前不可用」处理 — 拒绝占用更多线程。
  return (await defaultProbeScheduler.availability(candidate, timeoutMs)) === 'usable';
}

async function probeUsability(candidate: string): Promise<boolean> {
  const probe = path.join(candidate, `${WORKDIR_PROBE_PREFIX}${randomUUID()}`);
  let created = false;
  try {
    if (!(await stat(candidate)).isDirectory()) return false;
    await writeFile(probe, '', { flag: 'wx' });
    created = true;
    return true;
  } catch {
    return false;
  } finally {
    if (created) {
      try {
        await rm(probe, { force: true });
      } catch {
        // 删除被锁挡住: 接受 0 字节残留 — 不记住路径, 不重试, 不扫描。
      }
    }
  }
}

/**
 * 用户目录 IO 的 deadline 包装: 超时返回 null(与业务返回值可区分), 不取消
 * 底层操作(Node fs 无法取消)。run() 的快速失败/校验错误立即穿透, 不吃满
 * 时限; 超时后 run() 迟到的 settle 由 Promise.race 吸收, 不产生未处理拒绝。
 */
async function withUserDirDeadline<T>(run: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function nodeErrorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

export const __testing = {
  isUsableWorkingDirectory,
  /** 清空默认调度器的探针状态(在途表/冷却表/计数) — 测试隔离用。 */
  resetProbeScheduler(): void {
    defaultProbeScheduler.reset();
  },
  probeLimits: {
    maxConcurrent: MAX_CONCURRENT_USER_DIR_PROBES,
    cooldownMs: PROBE_COOLDOWN_MS,
  },
};
