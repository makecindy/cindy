/**
 * PiSessionRegistry — in-memory registry of pi `--mode rpc` child processes.
 *
 * Each session owns:
 *   - a spawn of `bash -c <cmd>` (the pi RPC process; stdio via pipes)
 *   - a unix socket that bridges the pi's stdio to remote clients
 *     (`pi-manager bridge --socket <sockPath>` pipes stdio↔socket)
 *   - a per-session env-file (0600) holding credentials, read once at spawn
 *
 * Semantics ported from the retired python per-session daemon (pi-daemon.py),
 * adapted to a single-manager memory registry — no pidfile cross-process
 * ownership checks needed (this process is the sole owner).
 */

import { spawn, ChildProcessWithoutNullStreams, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { makeServerError } from './server.js';
import type { PiListEntry } from './protocol.js';

export interface PiSessionState {
  sessionId: string;
  child: ChildProcess;
  pid: number;
  sockPath: string;
  envHash: string;
  envFile: string;
  lastActivity: number; // epoch ms(对外诊断)
  /** 轮 23-H1 MEDIUM:单调时钟的 lastActivity(process.hrtime.bigint())——
   *  Date.now() 非单调, NTP/手动回拨会让 idle 判断失真(回拨 → 会话多活,
   * 前跳 → 刚 detach 被立即回收)。内部 idle 判断只用单调差。 */
  lastActivityMono: bigint;
  attachedSocket: net.Socket | null;
  server: net.Server;
  startedAt: number;
  /** true 表示正在被 kill(killChild 进行中)—— 并发 ensure 不得 reattach(自审轮 2)。 */
  dying: boolean;
  /** kill 完成后的 promise —— 并发调用方 await 它等死透(幂等 kill)。 */
  deathPromise: Promise<void>;
}

export interface PiSessionRegistryOptions {
  /** Directory for per-session unix sockets. Created if missing. */
  sockDir: string;
  /** Directory for per-session env-files. Created if missing. */
  envDir: string;
  /** Idle timeout (ms): recycle session when no client attached AND pi silent
   *  for this long. 0 = disabled. Default 30 min. */
  idleTimeoutMs?: number;
  /** Called when a session closes (pi exited / killed / recycled). */
  onSessionClosed?: (sessionId: string, reason: 'completed' | 'killed' | 'idle_timeout' | 'error', detail?: string) => void;
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

const SOCK_EXT = '.pi.sock';
// 白名单 + 长度上限(128):超长 sessionId 会拼出超长 env-file/socket 路径,
// Windows MAX_PATH(~260)下 fs 操作失败(深挖轮 4 观察 1)。
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** socket 文件名(轮 21-W4 HIGH):完整 sessionId(≤128) + 前缀会超过 macOS
 *  sockaddr_un.sun_path 上限(~104 字节)导致 listen 失败 —— 用 sha256 截断
 *  16 hex(64-bit 冲突面, 会话数 ≤36 足够)作为文件名, 原 sessionId 保留在
 *  entry/protocol 层。env-file 是普通文件路径(无 sun_path 限制), 不受影响。 */
function sockFileName(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return `pi-${digest}${SOCK_EXT}`;
}
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 会话数上限(轮 11 MEDIUM-3 + 轮 12 HIGH-1 双确认 DoS 面):每个 session 一个
// pi 子进程 + unix socket + env-file + pipe 三元组, 无上限会被 ensure 洪泛
// 耗尽 daemon 资源。32 远高于正常并发(单用户 ~个位数), 与 MAX_CLIENTS=16
// 对齐设计意图。
// 轮 16 MEDIUM-2:计数含 dying(未 teardown)会话, 批量 kill 期间可能短暂误拒
// 合法 ensure —— 上限给 4 个头寸(36 = 32 活跃 + 4 dying 过渡), 实际活跃
// 仍约 32, DoS 面不扩大, 误拒概率大降。
const MAX_SESSIONS = 36;
/** SIGTERM grace before SIGKILL (ms). */
const KILL_GRACE_MS = 3_000;
/** Post-SIGKILL survival confirmation window (ms). */
const KILL_CONFIRM_MS = 5_000;

export class PiSessionRegistry {
  private readonly sessions = new Map<string, PiSessionState>();
  /** in-flight spawn 去重:sessionId → spawn promise(自审轮 2 C-1)。 */
  private readonly pendingSpawns = new Map<string, Promise<{ sessionId: string; sockPath: string; isReattach: boolean }>>();
  private readonly sockDir: string;
  private readonly envDir: string;
  private readonly idleTimeoutMs: number;
  private readonly onSessionClosed?: PiSessionRegistryOptions['onSessionClosed'];
  private readonly logger: Required<PiSessionRegistryOptions>['logger'];
  private readonly idleTimer: NodeJS.Timeout | null = null;
  /** 关停中:拒绝新 ensure, 防孤儿子进程(自审轮 2 HIGH)。 */
  private shuttingDown = false;
  /** shutdownAll 收集 close-handler teardown 的异步 rm, 避免 process.exit 抢在凭证文件删除前。 */
  private shutdownCleanupBatch: ((p: Promise<void>) => void) | null = null;

  constructor(opts: PiSessionRegistryOptions) {
    this.sockDir = opts.sockDir;
    this.envDir = opts.envDir;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 1_800_000;
    this.onSessionClosed = opts.onSessionClosed;
    this.logger = opts.logger ?? console;
    // 目录显式 0700 —— 默认 0755(umask 022)会让同机其他用户看到 sessionId
    // 文件名(自审轮 5 HIGH-2)。
    fs.mkdirSync(this.sockDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.envDir, { recursive: true, mode: 0o700 });
    // 启动清理:本 daemon 独占这两个目录, 旧 daemon SIGKILL 崩溃残留的
    // env-file(含凭证)/socket 文件/pidfile 一律清掉(自审轮 6 M-2)。
    this.cleanupStaleState();
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => this.recycleIdle(), 30_000);
      this.idleTimer.unref?.();
    }
  }

  /** 关停开始标志置位(同步)—— 供 PI_SHUTDOWN handler 在响应前调用。 */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  private cleanupStaleState(): void {
    try {
      for (const f of fs.readdirSync(this.envDir)) {
        fs.rmSync(path.join(this.envDir, f), { force: true });
      }
      for (const f of fs.readdirSync(this.sockDir)) {
        fs.rmSync(path.join(this.sockDir, f), { force: true });
      }
      this.logger.debug?.('cleaned stale pi-manager session state', {
        envDir: this.envDir,
        sockDir: this.sockDir,
      });
    } catch (err) {
      this.logger.warn?.('stale state cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Ensure a session exists. Returns the session socket path + whether this
   * was a pure reattach (existing pi kept alive).
   *
   * 并发安全:in-flight spawn 用 pendingSpawns Map 跟踪 —— 同 sessionId 的
   * 并发 ensure 会 await 同一个 spawn promise, 不会双 spawn(自审轮 2 C-1)。
   */
  async ensure(
    sessionId: string,
    cmd: string,
    env: Record<string, string>,
    envHash: string,
    restart: boolean,
  ): Promise<{ sessionId: string; sockPath: string; isReattach: boolean }> {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw makeServerError('INVALID_PARAMS', `unsafe sessionId ${JSON.stringify(sessionId)} — only [A-Za-z0-9_-] allowed`);
    }
    if (this.shuttingDown) {
      throw makeServerError('INTERNAL', 'pi-manager is shutting down');
    }
    // 轮 40-w5 MEDIUM:cmd 边界校验 —— Node spawn 对 argv/env value 中的 NUL
    // 会同步抛 ERR_INVALID_ARG_VALUE(在 env-file 写入**之后**), 残留凭证文件。
    // 只拒 NUL + 类型:空 cmd 与超长 cmd 是既有合法契约(edge-cases 3a/3b,
    // bash -c "" 退出 0;E2BIG 走异步 error 事件不残留文件)。校验放在任何
    // 文件写入之前, fail-fast 无副作用。
    if (typeof cmd !== 'string' || cmd.includes('\0')) {
      throw makeServerError(
        'INVALID_PARAMS',
        'unsafe cmd — must be a string without NUL bytes',
      );
    }
    if (typeof envHash !== 'string' || envHash.includes('\0')) {
      throw makeServerError('INVALID_PARAMS', 'unsafe envHash — must be a string without NUL bytes');
    }
    // Env guard (defense-in-depth; host validates too): key whitelist + no
    // newlines / NUL in values — a malicious env entry could inject extra
    // env-file lines (R6 M-7 equivalent) or make spawn throw synchronously
    // (轮 40-w5 MEDIUM: NUL 让 Node spawn 同步抛 ERR_INVALID_ARG_VALUE)。
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(key) || /[\r\n\0]/.test(value)) {
        throw makeServerError('INVALID_PARAMS', `unsafe env entry ${JSON.stringify(key)}`);
      }
    }

    // 已注册会话:条件 restart 语义。
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.dying) {
        // 正在被 kill(空闲回收/显式 kill 的 killChild 阶段)—— 等它死透再重建。
        // deathPromise 可能 reject(SESSION_KILL_SURVIVED):等的是「kill 流程
        // 结束」而非「kill 成功」, catch 后继续(entry 保留 dying 状态)。
        await existing.deathPromise.catch(() => {});
      }
      const refreshed = this.sessions.get(sessionId);
      if (refreshed) {
        if (!restart || refreshed.envHash === envHash) {
          // 轮 1 发现 1 TOCTOU:上方 dying 检查与这里 return 之间, 并发
          // kill/recycleIdle 可能已把该 entry 标记 dying。重查:dying 则等死透
          // 再判定 —— 进程仍存活(SESSION_KILL_SURVIVED, entry 保留)可 reattach
          // (edge-cases 10d 原语义);entry 已被 teardown 删除则 fall through 重建。
          if (refreshed.dying) {
            // 轮 40-w1 HIGH:deathPromise reject(SESSION_KILL_SURVIVED)= 进程
            // 杀不死仍存活 —— 不得 reattach 到 poisoned entry(破坏 fail-closed)。
            // 等待 kill 流程结束, 若 entry 仍 dying 则继续拒绝。
            let survived = false;
            try {
              await refreshed.deathPromise;
            } catch {
              survived = true;
            }
            // 轮 42:deathPromise resolve(kill 成功)但 teardown 可能尚未删 entry
            // (kill() = await killChild → await teardown, 中间有窗口) ——
            // 此刻 entry 仍 dying 是「kill 成功等待 teardown」的正常状态, 不是
            // survived。轮询等 entry 被 teardown 删除(或进程 close 自然清理),
            // 再走重建。只有 deathPromise **reject**(真 SESSION_KILL_SURVIVED)
            // 且 entry 仍 dying 才拒绝。
            if (!survived) {
              // 等待 teardown 完成:kill() 的 teardown 在 deathPromise 之后。
              // 最多等 5s(与 kill 流程总时长相当); entry 被删即重建。
              const deadline = Date.now() + 5000;
              while (this.sessions.get(sessionId) === refreshed && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            }
            const after = this.sessions.get(sessionId);
            if (after && after.dying) {
              throw makeServerError(
                'SESSION_KILL_SURVIVED',
                `pi session ${sessionId} survived SIGKILL — refusing to reattach`,
              );
            }
            if (after) {
              return { sessionId, sockPath: after.sockPath, isReattach: true };
            }
          } else {
            return { sessionId, sockPath: refreshed.sockPath, isReattach: true };
          }
        } else {
          await this.kill(sessionId);
        }
      }
    }

    // in-flight spawn 去重:并发 ensure 同 sessionId → await 同一个 promise。
    const pending = this.pendingSpawns.get(sessionId);
    if (pending) return pending;
    // 会话数上限(轮 11/12 DoS + 轮 40-w5 MEDIUM):**只在真正要新建 spawn 时**
    // 才查容量 —— reattach/复用 pending 不新增资源, 容量满时重连既有会话
    // 不应被 SESSION_LIMIT_EXCEEDED 挡住。
    if (this.sessions.size + this.pendingSpawns.size >= MAX_SESSIONS) {
      throw makeServerError(
        'SESSION_LIMIT_EXCEEDED',
        `session limit reached (${MAX_SESSIONS}) — refusing to spawn more`,
      );
    }
    const promise = this.spawnSession(sessionId, cmd, env, envHash)
      .finally(() => this.pendingSpawns.delete(sessionId));
    this.pendingSpawns.set(sessionId, promise);
    return promise;
  }

  async kill(sessionId: string): Promise<void> {
    // in-flight spawn 也要能 kill(自审轮 2 HIGH):等 spawn 完成再杀。
    const pending = this.pendingSpawns.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch {
        // spawn 失败 = 没有活进程, kill 视为成功(幂等)。
        return;
      }
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw makeServerError('SESSION_NOT_FOUND', `no session ${sessionId}`);
    }
    if (entry.dying) {
      // 已在 kill 中:等它完成(不重复 kill)。deathPromise 的 reject
      // (SESSION_KILL_SURVIVED)由**首次** kill 的调用方传达。
      // 轮 42 P1(codex-connector):不得 catch 吞掉 —— restart 路径
      // (kill → spawn)若把 SESSION_KILL_SURVIVED 当成功继续, 会覆盖 retained
      // entry 而杀不死的旧进程仍持凭证在跑(双 spawn)。这里必须传播,
      // 让调用方(ensure 的 envHash 分支)收到 SESSION_KILL_SURVIVED 拒绝继续。
      await entry.deathPromise;
      return;
    }
    // 轮 40-w3 CRITICAL:显式 kill 无视 attached socket(用户关会话时 bridge
    // RPC 通道仍 attached, 早退会遗留持凭证进程)。
    await this.killChild(entry, { allowAttached: true });
    // await 清理 promise:restart 路径(kill → teardown → spawnSession 写同名
    // env-file)不得让旧 rm 晚到删除新文件(轮 1 发现 3)。
    await this.teardown(entry, 'killed');
  }

  list(): PiListEntry[] {
    const now = Date.now();
    return [...this.sessions.values()].map((entry) => ({
      sessionId: entry.sessionId,
      pid: entry.pid,
      sockPath: entry.sockPath,
      envHash: entry.envHash,
      lastActivity: entry.lastActivity,
      startedAt: entry.startedAt,
      isAttached: entry.attachedSocket !== null,
      // 轮 23-H1 HIGH:ageMs/lastActivityMs 由 **daemon 自己时钟** 计算 ——
      // desktop 拿到的 epoch(startedAt/lastActivity) 是远端时钟, 与本机
      // Date.now() 跨机器比较会因时钟偏移误判(30s 新生保护失效 → 误杀)。
      // desktop 只消费这两个 daemon 侧时长, 不再跨机器减。
      ageMs: Math.max(0, now - entry.startedAt),
      lastActivityMs: Math.max(0, now - entry.lastActivity),
    }));
  }

  get(sessionId: string): PiSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Kill all sessions (daemon shutdown). */
  async shutdownAll(reason: 'killed' | 'completed' = 'killed'): Promise<void> {
    this.shuttingDown = true;
    // collector 必须在 drain pending spawn **之前**挂上 —— 等待期间已注册
    // 的 child 可能自然退出, close-handler teardown 否则无人收集, daemon
    // process.exit 会抢在 env-file rm 前。
    const cleanupBatch: Promise<void>[] = [];
    this.shutdownCleanupBatch = (p) => { cleanupBatch.push(p); };
    // 先等 in-flight spawn 完成(否则 spawnSession 会在关停后注册孤儿 —— 自审轮 2 HIGH)。
    await Promise.allSettled([...this.pendingSpawns.values()]);
    // 二次扫描:spawn 完成后可能注册了新 entry, 一并收掉。
    // 轮 40-w4-t3 CRITICAL:杀不死的 entry 不得 teardown —— 否则删了 registry
    // 状态/env-file/socket 但进程仍活着, 残留持凭证进程不受管理, 与 kill()/
    // recycleIdle() 的「杀不死保留 entry 防双 spawn」不变量冲突。收集并最后抛出,
    // 让 bin/pi-manager 的 signal shutdown / pi/shutdown 后台路径拿到失败,
    // 避免「先 ACK 成功再静默残留」。其余错误(已死/无 pid)照常清理。
    const survivors: string[] = [];
    // 轮 18-T1:两轮 pass 只收「第二轮新增」的 entry —— 第一轮已处理过的
    // (含 survivor)不得重复 kill/push。否则 survivor 在 pass 1 被再次
    // killChild + 再次 push, survivors 重复(误报数量)且第二轮 kill 的
    // timer 链脱离本轮 await(测试外 unhandled rejection)。
    const handled = new Set<string>();
    for (let pass = 0; pass < 2; pass += 1) {
      const ids = [...this.sessions.keys()];
      if (ids.length === 0) break;
      for (const id of ids) {
        const entry = this.sessions.get(id);
        if (!entry) continue;
        if (handled.has(id)) continue;
        handled.add(id);
        try {
          // 轮 40-w3 CRITICAL:shutdownAll 同样无视 attached —— 关停必须收掉
          // 所有进程, 不能因 bridge attached 遗留持凭证进程。
          await this.killChild(entry, { allowAttached: true });
        } catch (err) {
          // 轮 40-w4-t3 CRITICAL:只有 SESSION_KILL_SURVIVED 才保留 entry(进程
          // 仍存活, 不能删状态);其它错误(已死/无 pid 等)继续 teardown 清理。
          const code = (err as { code?: string })?.code;
          if (code === 'SESSION_KILL_SURVIVED') {
            this.logger.error('shutdownAll: session survived SIGKILL — keeping entry (credentials still held)', {
              sessionId: entry.sessionId,
            });
            survivors.push(entry.sessionId);
            continue;
          }
        }
        this.teardown(entry, reason, undefined, (p) => cleanupBatch.push(p));
      }
    }
    // 等 teardown 的异步清理完成(env-file/socket rm)—— 防 process.exit 前
    // 凭证文件未删(退役审轮 3 M-1)。batch 局部变量, 正常路径不持有(退役审轮 8 M-1)。
    this.shutdownCleanupBatch = null;
    await Promise.allSettled(cleanupBatch);
    if (survivors.length > 0) {
      throw makeServerError(
        'SESSION_KILL_SURVIVED',
        `shutdown: ${survivors.length} pi session(s) survived SIGKILL — ${survivors.join(', ')}; daemon exit will leak credential-holding processes`,
        { sessionIds: survivors },
      );
    }
  }

  close(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async spawnSession(
    sessionId: string,
    cmd: string,
    env: Record<string, string>,
    envHash: string,
  ): Promise<{ sessionId: string; sockPath: string; isReattach: boolean }> {
    // 1) Write env-file (0600 from birth — Node mode applies at open, no
    //    TOCTOU window like chmod-after-write). pi reads it at spawn.
    // 轮 40-w4-t4 MEDIUM:原子写 —— tmp 文件 0600 写完整后 rename 到最终路径。
    // 直接 writeFile 在磁盘满/I/O 错/进程中断时会在最终路径留下半写凭证文件;
    // tmp + rename 保证最终路径要么旧内容要么完整新内容, 失败只清 tmp。
    const envFile = path.join(this.envDir, `env-${sessionId}`);
    // 轮 22 CRITICAL(LAZY_CREATE_FAILED 根因):env 值里的字面 $HOME/ 前缀
    // (PI_CODING_AGENT_DIR/CINDY_PI_PERMISSION_FILE/subagent runtime file 等
    // 派生自 agentHome 的路径)必须在写 env-file 时展开 —— pi 读 env 不会展开
    // $HOME, 字面值会指向不存在的字面目录 → models.json 找不到 →
    // "Unknown provider" → pi 秒退。daemon 用 os.homedir()(远端真实 HOME)。
    // 非 $HOME 开头的绝对路径(如 /tmp/...)保持原样。
    const remoteHome = os.homedir();
    const expandHome = (v: string): string =>
      v.startsWith('$HOME/') ? `${remoteHome}/${v.slice('$HOME/'.length)}` : v;
    const envContent = Object.entries(env)
      .map(([key, value]) => `${key}=${expandHome(value)}`)
      .join('\n');
    // 轮 1 发现 3 双保险:进程自然退出(close 回调 teardown 不 await)后用户
    // 立即 ensure 同 sessionId 时, 旧 fire-and-forget rm 可能仍在飞 —— 先 rm
    // 再写, 与已入队的 rm 在 libuv 线程池 FIFO 下同序(restart 主路径已由
    // kill() await teardown 消除, 这里是 close 路径的兜底)。
    await fsPromises.rm(envFile, { force: true }).catch(() => {});
    // 轮 18-T1 MEDIUM:写前清同 session 的历史 tmp —— daemon 在 writeFile 与
    // rename 之间被 SIGKILL/崩溃时, 上次的 env-<id>.tmp-* 会残留在 envDir
    // (kill/idle/teardown 只清 entry.envFile, 覆盖不到未登记 tmp; 启动时
    // cleanupStaleState 兜底但 daemon 未重启前一直在磁盘)。同 daemon 内
    // 同 sessionId 的 ensure 由 pendingSpawns 串行, glob 不会误删在写中的 tmp。
    try {
      const tmpPrefix = `env-${sessionId}.tmp-`;
      for (const f of await fsPromises.readdir(this.envDir)) {
        if (f.startsWith(tmpPrefix)) {
          await fsPromises.rm(path.join(this.envDir, f), { force: true }).catch(() => {});
        }
      }
    } catch {
      // 清理失败不阻断写(最终 rename 路径仍是原子的)。
    }
    // pid 后缀足以区分并发(同一 daemon 进程内同 sessionId 的 ensure 是串行的,
    // 由 pendingSpawns 去重)。
    const envTmp = path.join(this.envDir, `env-${sessionId}.tmp-${process.pid}`);
    try {
      await fsPromises.writeFile(envTmp, envContent, { mode: 0o600 });
      await fsPromises.rename(envTmp, envFile);
    } catch (err) {
      // 失败:清 tmp(凭证材料不残留), 抛错走调用方失败路径。
      await fsPromises.rm(envTmp, { force: true }).catch(() => {});
      throw makeServerError('INTERNAL', `env-file write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 关停守卫提前(spawn 前, 不创建再销毁 —— 自审轮 6 L-3)。
    // 必须 await 删凭证文件:shutdownAll 只等 pending spawn promise,
    // fire-and-forget rm 会在 daemon process.exit 前残留 env-<id>(含 gateway/BYOM key)。
    if (this.shuttingDown) {
      await fsPromises.rm(envFile, { force: true }).catch(() => {});
      throw makeServerError('INTERNAL', 'pi-manager is shutting down');
    }

    // 2) Spawn pi: bash -c cmd with env-file values merged into process env.
    // 轮 40-w4-t6 CRITICAL:不从全量 process.env 继承 —— daemon 宿主环境可能带
    // BASH_ENV/ENV(shell 启动钩子, bash -c 前执行 = 注入)、代理变量、证书变量、
    // 旧 PATH, 会串扰每个 PI 子进程(desktop 侧 remote 是从空环境注入 curated env,
    // daemon 侧必须等价)。allowlist 最小环境 + 显式剥离控制变量。
    const childEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin:/usr/local/bin',
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    };
    // 轮 25 CRITICAL:childEnv 必须用**展开后**的值 —— pi 进程实际读的是 spawn
    // env(不是 env-file!), 之前只展开 env-file 导致 PI_CODING_AGENT_DIR 在
    // spawn env 里仍是字面 $HOME → pi 从字面目录找 models.json → Unknown
    // provider → 秒退(LAZY_CREATE_FAILED 真正根因)。
    for (const [key, value] of Object.entries(env)) {
      childEnv[key] = expandHome(value);
    }
    // 轮 40-w5 MEDIUM 双保险:ensure() 已拒 NUL, 这里兜住任何其他同步 throw
    // (env value 类型异常 / argv 编码问题)—— 已写入的 env-file(含凭证)必须
    // 清理, 否则 spawn 失败会残留凭证文件且无 session entry 管理它。
    // stdio 显式 ['pipe','pipe','pipe'] → spawn 返回 ChildProcessWithoutNullStreams,
    // 保持 child.stdout/stderr 非空类型(显式注解 ChildProcess 会让它们变 nullable)。
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('bash', ['-c', cmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (err) {
      this.logger.warn?.('pi spawn threw synchronously — cleaning up env-file', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await fsPromises.rm(envFile, { force: true }).catch(() => {});
      throw makeServerError(
        'INVALID_PARAMS',
        `invalid spawn input: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sockPath = path.join(this.sockDir, sockFileName(sessionId));
    // Clean any stale socket file from a previous lifecycle. rm 失败(如 EACCES
    // 旧 sock 属于另一用户)不中断 spawn —— 中断会泄漏已 spawn 的 child 和
    // 已写的 env-file(轮 1 发现 4);server.listen 自会处理 EADDRINUSE。
    try {
      await fsPromises.rm(sockPath, { force: true });
    } catch (err) {
      this.logger.warn?.('stale sock cleanup failed — continuing', {
        sessionId,
        sockPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const state: PiSessionState = {
      sessionId,
      child,
      pid: child.pid ?? 0,
      sockPath,
      envHash,
      envFile,
      lastActivity: Date.now(),
      lastActivityMono: process.hrtime.bigint(),
      attachedSocket: null,
      server: net.createServer(),
      startedAt: Date.now(),
      dying: false,
      deathPromise: Promise.resolve(),
    };

    // 3) Session unix socket: single-connection semantics — new bridge
    //    connection replaces the old one.
    const server = state.server;
    server.on('connection', (conn) => {
      this.logger.debug('session bridge connected', { sessionId });
      // Replace any existing attached socket. 先移除旧 socket 的 data 监听
      // —— destroy 后仍可能有排队中的 data 事件写入 pi stdin(自审轮 2 MEDIUM)。
      if (state.attachedSocket) {
        const old = state.attachedSocket;
        old.removeAllListeners('data');
        try { old.destroy(); } catch { /* */ }
      }
      state.attachedSocket = conn;
      state.lastActivity = Date.now();
      state.lastActivityMono = process.hrtime.bigint();
      conn.on('data', (chunk: Buffer) => {
        // Client → pi direction. Updates lastActivity (active client input
        // keeps session alive even when pi is silently computing).
        state.lastActivity = Date.now();
        state.lastActivityMono = process.hrtime.bigint();
        if (child.stdin.destroyed) return;
        // 轮 23-H4 HIGH:child.stdin.write 返回 false = pi 读得慢, stdin 缓冲满
        // —— pause bridge socket(背压向上游传导), 等 stdin drain 再恢复。
        // 防大输入在 daemon 内存无界堆积。
        const ok = child.stdin.write(chunk);
        if (!ok && !conn.destroyed) {
          conn.pause();
          child.stdin.once('drain', () => {
            if (!conn.destroyed) conn.resume();
          });
        }
      });
      conn.on('close', () => {
        if (state.attachedSocket === conn) state.attachedSocket = null;
      });
      conn.on('error', () => { /* close follows */ });
    });
    server.on('error', (err) => {
      this.logger.warn('session socket error', { sessionId, error: err.message });
    });

    // 4) Drain pi stdout: no attached client → discard (prevents pi blocking
    //    on a full pipe, same as python daemon drain). Attached → forward.
    // 轮 42 P1(codex-connector):detached 时丢弃普通 stdout 可以(无客户端消费,
    // 丢弃是设计语义); 但**控制帧**(extension_ui_request 等需 extension_ui_response
    // 应答的帧)不能丢 —— 丢了 pi 会永久等一个无人回的 response, 会话卡死到
    // idle 回收, 手动 Retry 也重连不上未完成 turn。检测到丢弃控制帧 → fail-closed
    // kill 该会话(干净重来, 比卡死强)。
    let detachedBuffer = '';
    const isControlFrame = (text: string): boolean =>
      // 轮 43 P2(codex-connector):只匹配顶层 type 字段(JSON 开头), 避免
      // 嵌套对象(如 tool/MCP 参数)内的同名 type 字段被误判为控制帧。
      /^\s*\{\s*"type"\s*:\s*"extension_ui_(request|response|close)"/.test(text);
    child.stdout.on('data', (chunk: Buffer) => {
      state.lastActivity = Date.now();
      state.lastActivityMono = process.hrtime.bigint();
      const conn = state.attachedSocket;
      if (conn && !conn.destroyed) {
        // 轮 42 P1(codex-connector):detached 期间缓冲的半行不能直接丢 —— Pi 可能
        // 写了 extension_ui_request 前缀后 desktop 才重连, 丢前缀会让 desktop 收
        // 到残缺帧 → pi 永久等 response。先转发缓冲的前缀(保持帧连续性)再清空。
        if (detachedBuffer.length > 0) {
          const prefix = detachedBuffer;
          detachedBuffer = '';
          conn.write(prefix);
        }
        const ok = conn.write(chunk, (err) => {
          if (err && state.attachedSocket === conn) {
            state.attachedSocket = null;
            try { conn.destroy(); } catch { /* */ }
          }
        });
        // 轮 12 LOW-6 背压:conn.write 返回 false = 内部缓冲满(bridge 吞吐低于
        // pi 输出速率), 暂停 child.stdout 读, 等 conn drain 再 resume —— 防
        // daemon 内存随 pi 输出无界增长。
        // 轮 16 HIGH:conn 在 drain 前关闭(SSH 断/用户断连)时 drain 永不触发,
        // child.stdout 永久 paused → pi 写满 pipe 后阻塞挂起。close 时必须
        // resume(attach 语义:无连接 → 丢弃后续输出, 与未 pause 时一致)。
        if (!ok) {
          child.stdout.pause();
          let resumed = false;
          const resume = (): void => {
            if (resumed) return;
            resumed = true;
            if (!child.stdout.destroyed) child.stdout.resume();
          };
          conn.once('drain', resume);
          conn.once('close', resume);
        }
      } else {
        // detached: 累积行缓冲检测控制帧(JSONL 行边界跨 chunk)。
        detachedBuffer += chunk.toString('utf8');
        let nl = detachedBuffer.indexOf('\n');
        while (nl >= 0) {
          const line = detachedBuffer.slice(0, nl).trim();
          detachedBuffer = detachedBuffer.slice(nl + 1);
          if (line && isControlFrame(line)) {
            // 轮 42 P1(codex-connector):**不打原文** —— 控制帧是序列化的
            // ctx.ui.confirm 请求, 可能含 bash 命令/文件路径/MCP 参数/粘贴的
            // 凭证, 落 pi-manager.log 后可能经 daemon log tail 回传桌面。
            // 只记元数据: frame type(从 JSON 提取, 无用户内容)。
            const frameType = /"type"\s*:\s*"([^"]+)"/.exec(line)?.[1] ?? 'unknown';
            this.logger.warn('pi dropped a control frame while detached — killing session (fail-closed)', {
              sessionId,
              frameType,
              frameLength: line.length,
            });
            void this.killChild(state, { allowAttached: true })
              .then((killed) => {
                if (killed) {
                  return this.teardown(state, 'error', 'dropped control frame while detached (fail-closed)');
                }
              })
              .catch((err) => {
                this.logger.error('pi control-frame kill failed — session may be wedged', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            return;
          }
          nl = detachedBuffer.indexOf('\n');
        }
        // 行缓冲防无界增长(极端: pi 疯狂输出但无换行)。
        // 轮 42 P1(codex-connector):超限清空前必须先检查**是否控制帧前缀** ——
        // >64KB 的 extension_ui_request(大权限/工具请求)前缀被清后, 后续 suffix
        // 不再匹配控制帧检测, pi 永久等无人回的 response。含控制帧前缀 →
        // fail-closed kill(干净重来); 纯普通 stdout 超限 → 丢弃。
        if (detachedBuffer.length > 64 * 1024) {
          if (/^\{?"type"\s*:\s*"extension_ui_/.test(detachedBuffer)) {
            const frameType = /"type"\s*:\s*"([^"]+)"/.exec(detachedBuffer)?.[1] ?? 'unknown';
            this.logger.warn('pi detached buffer overflowed with control frame prefix — killing session (fail-closed)', {
              sessionId,
              frameType,
            });
            void this.killChild(state, { allowAttached: true })
              .then((killed) => {
                if (killed) {
                  return this.teardown(state, 'error', 'detached control frame buffer overflow (fail-closed)');
                }
              })
              .catch((err) => {
                this.logger.error('pi control-frame overflow kill failed — session may be wedged', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            return;
          }
          detachedBuffer = '';
        }
      }
    });
    // pi stderr 记 daemon 日志(截断防洪水) —— 真机验证时 pi 启动失败的唯一
    // 线索就是 stderr, 丢弃会让排障无从下手(自审轮 10 B-2)。
    // 凭证 scrub:stderr 可能含 env 值(pi 崩溃 dump / 依赖 debug 输出), 记日志
    // 前按常见凭证格式掩码(深挖轮 5 L-2)。
    child.stderr.on('data', (chunk: Buffer) => {
      const text = scrubCredentialText(chunk.toString('utf8').trim());
      if (text) {
        this.logger.warn?.('pi stderr', { sessionId, line: text.slice(0, 500) });
      }
    });
    child.on('error', (err) => {
      this.logger.warn('pi child error', { sessionId, error: err.message });
    });
    child.on('close', (code, signal) => {
      this.logger.info('pi child exited', { sessionId, code, signal });
      // 主动 kill 的进程(即使 code=0)语义是 'killed' 而非 'completed' ——
      // 对齐 python daemon 的 kill 语义(深度自审发现测试预期偏差)。
      this.teardown(
        state,
        state.dying ? 'killed' : code === 0 ? 'completed' : 'error',
        `pi exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        this.shutdownCleanupBatch ?? undefined,
      );
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      // 轮 11 MEDIUM-4:session socket 也显式 0600(与 manager socket 同款,
      // 独立于目录 0700 的第二层防线)。
      try {
        await fsPromises.chmod(sockPath, 0o600);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      // spawn/listen 失败:清理已 spawn 的 child + env-file + server, 不泄漏(自审轮 2 C-1)。
      // rm 必须 await(不是 fire-and-forget)—— 调用方 catch 到错误时 env-file
      // 必须已删除(深度自审:测试断言 env-file 不存在, fire-and-forget 有竞态)。
      // 轮 40-w2 MEDIUM:child.kill('SIGKILL') 后必须等死透 —— 否则 pendingSpawns
      // 释放后调用方立即 retry 同 sessionId, 会在旧进程未真正退出时双 spawn
      // (旧进程仍持有 env 凭证, 且不在 registry 管理内)。D-state 杀不死的
      // 情况抛 SESSION_KILL_SURVIVED, 调用方明确知道有存活进程。
      this.logger.warn('pi session spawn failed — cleaning up child', { sessionId, error: String(err) });
      try { server.close(); } catch { /* */ }
      try { child.kill('SIGKILL'); } catch { /* */ }
      const confirmed = await waitForExit(child, KILL_CONFIRM_MS);
      await fsPromises.rm(envFile, { force: true }).catch(() => {});
      if (!confirmed) {
        throw makeServerError(
          'SESSION_KILL_SURVIVED',
          `pi child survived SIGKILL after spawn failure — refusing to proceed`,
        );
      }
      throw err;
    }

    this.sessions.set(sessionId, state);
    // 轮 1 发现 2 僵尸会话:close 监听器在 sessions.set 之前注册, 若 pi 在
    // listen 期间秒退, close 回调里 teardown 的身份校验(get !== entry)会静默
    // 返回, 死进程随后被注册进 Map。set 后补查 exitCode, 已退出则立即清理。
    // 轮 42 P2(codex-connector):signal 退出时 exitCode null 但 signalCode 非空
    // —— 只查 exitCode 会把「已死」注册成僵尸, 后续 attach/reattach 访问死会话
    // 直到显式 kill / idle 回收。与 waitForExit 同口径用 != null 覆盖两者。
    if (child.exitCode != null || child.signalCode != null) {
      this.logger.warn('pi exited before registration — cleaning up zombie', {
        sessionId,
        code: child.exitCode,
        signal: child.signalCode,
      });
      this.teardown(
        state,
        state.dying ? 'killed' : child.exitCode === 0 ? 'completed' : 'error',
        `pi exited before registration code=${child.exitCode} signal=${child.signalCode}`,
      );
      // teardown 已删除 entry, 向调用方报失败(调用方会得到 spawn 失败语义)。
      throw makeServerError('INTERNAL', `pi exited immediately (code=${child.exitCode} signal=${child.signalCode})`);
    }
    this.logger.info('pi session spawned', { sessionId, pid: child.pid });
    // 临时诊断(排查 Unknown provider):env 展开后的关键项 + cmd —— env 值可能
    // 含凭证, 只打 key 与路径类值(脱敏), 不打印值本身。
    this.logger.info('pi session spawn debug', {
      sessionId,
      codingAgentDir: env.PI_CODING_AGENT_DIR ?? '(unset)',
      permissionFile: env.CINDY_PI_PERMISSION_FILE ?? '(unset)',
      cmdHead: cmd.slice(0, 120),
    });
    return { sessionId, sockPath, isReattach: false };
  }

  private async killChild(entry: PiSessionState, opts?: { allowAttached?: boolean }): Promise<boolean> {
    // dying 标志:kill 开始即置位, 并发 ensure 不得 reattach(自审轮 2 C-2/MEDIUM)。
    // deathPromise:并发 kill 的调用方 await 它等死透, 幂等。
    if (entry.dying) {
      await entry.deathPromise;
      return true;
    }
    // 连接守卫(自审轮 6 H-1 TOCTOU):recycleIdle 检查 attachedSocket 后、SIGTERM
    // 发出前, 客户端可能刚连上 —— 有连接存在的会话不杀(空闲回收豁免)。
    // 轮 40-w3 CRITICAL:attached 保护**仅限 idle recycle** —— 显式 kill(用户
    // 关会话 / piManagerKill)时 bridge RPC 通道很可能仍 attached, 早退会让
    // teardown 删 entry 但进程未杀(脱离 registry 持凭证继续跑)。显式 kill /
    // shutdownAll 传 allowAttached 强制杀。
    // 返回 false = 早退未杀:调用方(仅 recycleIdle)不得 teardown —— 否则删
    // entry/socket/env-file 而 pi 进程仍活着, 游离持凭证进程 + 同 id 双 spawn
    // (codex-connector 2026-08-12 P1 复述)。
    if (!opts?.allowAttached && entry.attachedSocket !== null) {
      this.logger.debug('killChild aborted — client attached', { sessionId: entry.sessionId });
      return false;
    }
    // 轮 40-w4-t12 HIGH-2:kill 信号发出前**二次复核** attachedSocket —— 首检
    // 后、SIGTERM 前 bridge 可能刚连上(刚恢复活跃的会话不能被 idle 回收误杀)。
    // 此时入口已进 kill 流程, 但信号尚未发, 可安全放弃。
    if (!opts?.allowAttached && entry.attachedSocket !== null) {
      this.logger.debug('killChild aborted — client attached between check and signal (TOCTOU)', {
        sessionId: entry.sessionId,
      });
      return false;
    }
    entry.dying = true;
    entry.deathPromise = (async (): Promise<void> => {
      const child = entry.child;
      if (!child.pid) return;
      // SIGTERM → grace → SIGKILL → survival confirmation (escalation ported
      // from python _kill_pi; raises SESSION_KILL_SURVIVED if still alive after
      // SIGKILL — D-state process would otherwise allow double-spawn).
      try {
        child.kill('SIGTERM');
      } catch { /* already dead */ }
      const terminated = await waitForExit(child, KILL_GRACE_MS);
      if (terminated) return;
      try {
        child.kill('SIGKILL');
      } catch { /* already dead */ }
      const confirmed = await waitForExit(child, KILL_CONFIRM_MS);
      if (!confirmed) {
        // SESSION_KILL_SURVIVED 由首次 kill 的调用方(await deathPromise)收到;
        // 并发 await 的调用方在各自 dying 分支 catch(不重复传播)。
        throw makeServerError('SESSION_KILL_SURVIVED', `pi process survived SIGKILL (uninterruptible state); refusing to proceed`);
      }
    })();
    await entry.deathPromise;
    return true;
  }

  private teardown(
    entry: PiSessionState,
    reason: 'completed' | 'killed' | 'idle_timeout' | 'error',
    detail?: string,
    onCleanup?: (p: Promise<void>) => void,
  ): Promise<void> {
    // 身份校验(Map 当前值 === entry 才删):空闲回收的迟到 teardown 不得删除
    // 同 sessionId 的新 spawn(自审轮 2 C-2 —— stale 引用删新会话)。
    // return 类型 Promise<void>(轮 1 发现 3 改动后), early-return 用 resolve。
    if (this.sessions.get(entry.sessionId) !== entry) return Promise.resolve();
    this.sessions.delete(entry.sessionId);
    try { entry.server.close(); } catch { /* */ }
    try { entry.server.unref?.(); } catch { /* */ }
    if (entry.attachedSocket) {
      try { entry.attachedSocket.destroy(); } catch { /* */ }
      entry.attachedSocket = null;
    }
    // Clean env-file (credentials) + socket file. 删除失败留日志(自审轮 5 LOW-6)。
    // 正常路径:不持有 promise(防数组无界增长 —— 退役审轮 8 M-1);
    // shutdownAll 传 onCleanup 收集, 在 process.exit 前 await(退役审轮 3 M-1)。
    const cleanupEnv = fsPromises.rm(entry.envFile, { force: true }).catch((err) => {
      this.logger.warn?.('env-file cleanup failed', {
        sessionId: entry.sessionId,
        envFile: entry.envFile,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const cleanupSock = fsPromises.rm(entry.sockPath, { force: true }).catch((err) => {
      this.logger.warn?.('socket cleanup failed', {
        sessionId: entry.sessionId,
        sockPath: entry.sockPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const settled = Promise.allSettled([cleanupEnv, cleanupSock]).then(() => undefined);
    onCleanup?.(settled);
    this.logger.info('pi session torn down', { sessionId: entry.sessionId, reason, detail });
    try {
      this.onSessionClosed?.(entry.sessionId, reason, detail);
    } catch {
      /* listener must not throw into teardown */
    }
    // 返回清理 promise:kill() 会 await —— 消除「teardown 的 fire-and-forget rm
    // 晚到删除 restart 新写的 env-file」竞态(轮 1 发现 3)。close/recycleIdle
    // 调用方保持不 await(正常路径不持有, 防数组无界增长语义不变)。
    return settled;
  }

  private recycleIdle(): void {
    // 轮 23-H1 MEDIUM:idle 判断用单调时钟(process.hrtime.bigint())——
    // Date.now() 非单调, NTP/手动回拨会让 `now - lastActivity` 失真
    // (回拨 → 会话多活一个偏移周期; 前跳 → 刚 detach 被立即回收)。
    const monoNow = process.hrtime.bigint();
    for (const entry of [...this.sessions.values()]) {
      if (entry.attachedSocket !== null) continue; // connected sessions never idle-recycled
      const idleMs = Number((monoNow - entry.lastActivityMono) / 1_000_000n);
      if (idleMs <= this.idleTimeoutMs) continue;
      this.logger.info('recycling idle pi session', { sessionId: entry.sessionId, idleMs });
      void this.killChild(entry)
        .then((killed) => {
          // 只有 killChild 确认**真的杀了进程**才 teardown —— killChild 在
          // attached 守卫早退(返回 false)时进程还活着, 若照跑 teardown 会删
          // entry/socket/env-file 而 pi 游离(持凭证继续跑)+ 同 id 双 spawn
          // (codex-connector 2026-08-12 P1)。早退会话保持 registry 管理,
          // 下一次 idle tick 重新判定。
          if (!killed) {
            this.logger.debug('idle recycle aborted — session attached during kill, kept managed', {
              sessionId: entry.sessionId,
            });
            return;
          }
          return this.teardown(entry, 'idle_timeout', 'no client and silent beyond idle timeout');
        })
        .catch((err) => {
          // SESSION_KILL_SURVIVED(D 状态杀不死):**不 teardown** —— entry 保留
          // (dying 状态) 防同 sessionId 双 spawn; 等进程自然退出后 close handler
          // 会清理(深挖轮 5 M-1)。
          this.logger.error('idle recycle kill failed — session kept (dying) to prevent double spawn', {
            sessionId: entry.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }
}

/**
 * 凭证文本掩码:pi stderr 可能包含 env 凭证值(崩溃 dump / 依赖 debug 输出)。
 * 按常见凭证格式掩码(深挖轮 5 L-2)。截断前先 scrub, 防 API key 落 daemon 日志。
 * 轮 4 MEDIUM #13 扩展:sk- 通用前缀(admin/svcacct 等)、ghp_/github_pat_/gho_
 * (GitHub)、AIza(Google)、hf_(HuggingFace)、xox(Slack)。lookbehind 防误伤
 * 普通文本(如 "ask-foobar")。掩码只影响日志, 漏掩代价 > 误掩。
 */
// 轮 30 MEDIUM-1:对齐 host 侧 redact.ts 的覆盖差 —— 补 Aliyun LTAI、AWS
// AKIA/ASIA、PEM 私钥块(daemon 日志最可能出现的远端凭证形态)。
const CREDENTIAL_SCRUB_RE = /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|LTAI[A-Za-z0-9]{16,}|A(?:KIA|SIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g;

// 轮 40-w4-t5 CRITICAL:key-aware 敏感字段名(env var / JSON key)。值形状正则
// 覆盖不了 64-hex sessionToken 等 opaque 值 —— 只要字段名命中就整体替换。
// 兼容 `KEY=value`、`"key": "value"`(JSON 带引号键)。
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential|CINDY_PI_MCP_BRIDGE|CINDY_PI_REMOTE_MCP_SECRET)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)([^,\s}\]]+)/gi;

export function scrubCredentialText(text: string): string {
  let out = text.replace(CREDENTIAL_SCRUB_RE, '[REDACTED]');
  // key-aware:字段名命中敏感名 → 值整体替换(含 64-hex / 自定义 header 值)。
  out = out.replace(SENSITIVE_KEY_RE, (_m, pre: string, quote: string, _k1: string, _k2: string, _k3: string, sep: string) =>
    `${pre}${quote}[REDACTED]${sep}[REDACTED]`);
  return out;
}

/** Wait for child exit with timeout. Returns true if exited within budget. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // 轮 42 P2(codex-connector):signal 退出时 Node 记 signalCode 而 exitCode
    // 仍为 null —— 只在 kill 信号发出前刚被 signal 杀死的窗口里, 只查
    // exitCode 会把「已死」误判为「存活」, 拖到超时后误报 SESSION_KILL_SURVIVED。
    // 用 != null 同时覆盖 null 与 undefined(mock child 未设 signalCode 时
    // 是 undefined, 属「未退出」—— 必须与 null 同等对待)。
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
