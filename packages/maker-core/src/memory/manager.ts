/**
 * MakerMemoryManager — Maker Memory 顶层单例 + 状态机 + per-workdir Store 实例池。
 *
 * 职责:
 *  - 维护全局 enabled 状态 (mode='maker' 时 true), 跟 native auto-memory 强制互斥
 *    (enable 时遍历 agents 调 setMemory(false))
 *  - per-workdir Store 实例池: 第一次 getStore(workdir) 时 lazy 创建 storage dir + open
 *    SQLite db, 同 workdir 复用同一 store + db 实例 (避免 db 多 open 句柄)
 *  - Manager.dispose() 时关闭所有 db, 跟 BaseAgent.dispose() 同生命周期
 *  - review 通过 host 注入的某个 agent.oneShot 跑 (默认 claude haiku, 最便宜)
 *
 * 跟 Maker 的关系:
 *  Maker 持有 makerMemory 字段 (可选), host 通过 MakerDeps.makerMemory 注入。
 *  agent 端 (claude-code/index.ts, codex/index.ts) 在 startSession 拼 prompt 时
 *  通过 deps.runtimeConfig.makerMemoryEnabled 判断是否注入 memory 段;
 *  通过 host 传入的 makerMemory.getStore(workdir).getIndex() 拿当前索引内容拼。
 *
 * 不管:
 *  - sqliteFactory / userDataPath 的具体值 (host 在 desktop 一侧处理 better-sqlite3 +
 *    app.getPath('userData'))
 *  - settings 持久化 (renderer localStorage 模式)
 *  - flush before compaction (那是 flush-controller 的职责, 后续阶段)
 */

import * as path from 'node:path';
import type Database from 'better-sqlite3';

import { MakerMemoryStore, memoryScopeDirName, parseFilename } from './store.js';
import {
  MemoryError,
  type MemoryConfig,
  type WriteOptions,
} from './types.js';
import type { BaseAgent } from '../agents/base-agent.js';
import { NotSupportedError } from '../types/capabilities.js';
import type { AgentKind } from '../types/common.js';
import type { Logger } from '../interfaces/logger.js';

/** 工厂函数: 给一个绝对文件路径, 返回 better-sqlite3 Database 实例。host 注入。 */
export type SqliteFactory = (filePath: string) => Database.Database;

export interface MakerMemoryManagerDeps {
  /** Maker memory 文件根目录, host 注入 (e.g. <electron userData>/maker-memory) */
  basePath: string;
  /**
   * 动态解析当前 owner 作用域的存储根（desktop: 按 getActiveAppSession().dataOwnerId 现取）。
   * 返回 null = owner 作用域不可用（signed-out / 认证未就绪 / 边界切换中），此时 manager
   * 必须 fail-closed（抛 memory:not-ready），绝不降级写临时目录。
   * 缺席 = 退化为静态 basePath（测试 / 无 owner 概念宿主）。
   *
   * 修复 #2341：构造时冻结 basePath 会让冷启动竞态把根锁死在
   * %TEMP%\cindy-no-session\<pid>\ 且不再重解析 —— 每次访问都重新解析根，
   * 配合 ownerScopeKey 在作用域变化时清池换根。
   */
  resolveBasePath?: () => string | null;
  /**
   * 当前 owner 作用域的不透明键（desktop: activeOwnerScopeKey 的脱敏形态，
   * 含 mode + 脱敏 owner + generation）。每次 commit（登录/登出/切账号，generation+1）
   * 都会变化：manager 检测到变化时先关闭全部旧 store db 再重建到新根，杜绝旧句柄
   * 与新 owner 数据混用。缺席 = 不做作用域追踪（静态 basePath 宿主）。
   */
  ownerScopeKey?: () => string;
  /**
   * owner 作用域变化（首次解析 / 换根）后重新读取 enabled 初值的回调
   * （desktop: 按新 owner 根读 memory-settings.json）。修复冷启动竞态里
   * initialEnabled 在 owner 未就绪时冻结为全局默认、owner 就绪后不重绑定的
   * 问题（#2388 review Codex 4th P1）。缺席 = 不重绑定（静态宿主）。
   */
  reloadEnabled?: () => boolean;
  /** SQLite open 工厂, host 注入 (better-sqlite3 是 native module, 不能在 maker-core require) */
  sqliteFactory: SqliteFactory;
  /** Agent 引用 — 强联动 setMemory(false) 关原生时用 */
  agents: Partial<Record<AgentKind, BaseAgent>>;
  /** 跑 memory_review 时用哪个 agent 的 oneShot. 默认 'claude-code' (haiku 最便宜) */
  reviewAgent?: AgentKind;
  /**
   * review 派发前的停用轴守卫(host 注入,desktop = isAgentOneShotRouteDisabled)。
   * memory_review 的 oneShot 是一次新的付费调用:该 agent 的默认 one-shot 路由被
   * 用户停用时不派发,抛错让 MCP 工具面把原因回给调用方(PR #744 review 第十六轮)。
   * 缺席 = 不裁决(未接入停用设置的宿主)。
   */
  isOneShotRouteDisabled?: (agent: AgentKind) => Promise<boolean>;
  logger: Logger;
  /** 配置覆盖 */
  config?: Partial<MemoryConfig>;
  /**
   * 启动时初值. 来自 settings (host 透传 runtimeConfig.makerMemoryEnabled).
   * 默认 false — host 必须明确开启，避免未接入设置系统的宿主意外改变行为。
   */
  initialEnabled?: boolean;
}

export interface MakerMemoryState {
  enabled: boolean;
  /** 已 lazy create 的 workdir 列表 (调试 / UI 列表用) */
  activeWorkdirs: string[];
}

export interface SetEnabledResult {
  /** 'next-session': 已经在跑的 session 不会被影响; 改完下次 startSession 才生效 */
  effective: 'next-session';
  /** enabled=true 时, 联动调过的 agent kind 列表 (各自 setMemory(false) 的结果) */
  affectedAgents?: Array<{ kind: AgentKind; effective: 'immediate' | 'next-session' | 'unsupported' }>;
}

interface PooledEntry {
  store: MakerMemoryStore;
  db: Database.Database;
}

const MEMORY_SUBDIR = 'maker-memory';
const FTS_DB_FILENAME = 'fts.db';

export class MakerMemoryManager {
  private enabled: boolean;
  private readonly stores = new Map<string, PooledEntry>();
  private readonly logger: Logger;
  /**
   * 最近一次校验通过的 owner 作用域 key（deps.ownerScopeKey 的快照）。
   * 变化时清池换根；null = 尚未校验过。仅用于相等性比较，日志已由 host
   * 注入的 ownerScopeKey 保证脱敏（不落明文 owner id）。
   */
  private activeScopeKey: string | null = null;

  constructor(private readonly deps: MakerMemoryManagerDeps) {
    this.enabled = deps.initialEnabled ?? false;
    this.logger = deps.logger;
    this.logger.info('MakerMemoryManager initialized', {
      enabled: this.enabled,
      basePath: deps.basePath,
      reviewAgent: deps.reviewAgent ?? 'claude-code',
    });
  }

  /**
   * 当前生效的存储根: 优先动态 resolveBasePath (可为 null = owner 未就绪),
   * 缺席时退化为静态 basePath。
   *
   * 注意不能用 `deps.resolveBasePath?.() ?? deps.basePath` —— resolveBasePath
   * 返回 null 是「owner 不可用」的显式信号, `??` 会把 null 误当成未提供而
   * 回退到静态 basePath, 让 fail-closed 守卫失效 (#2341)。
   */
  private get resolvedBasePath(): string | null {
    return this.deps.resolveBasePath ? this.deps.resolveBasePath() : this.deps.basePath;
  }

  /**
   * owner 作用域守卫 (每次 getStore / resetDigests / resetAll 前调用):
   *  1. ownerScopeKey 变化 → 关闭旧 store 池全部 db, 重解析根 (修复 #2341 的
   *     「启动期根冻结后不再重解析」);
   *  2. resolveBasePath 返回 null → 抛 memory:not-ready, 绝不创建/写入临时目录
   *     (修复「write 返回成功但数据落 %TEMP% 一次性目录」的静默丢失)。
   *
   * 抛出的 MemoryError 会被 MCP 层 classifyMemoryError 翻译成
   * MAKER_MEMORY_NOT_READY, 与「空库返回 ok+[]」可区分。
   */
  private ensureOwnerScope(): void {
    if (this.deps.ownerScopeKey) {
      const key = this.deps.ownerScopeKey();
      if (this.activeScopeKey === null) {
        // 首次解析 — 构造期 owner 可能尚未就绪 (initialEnabled 是全局默认),
        // 这里锚定 scope 的同时按当前 owner 重绑定 enabled。
        this.activeScopeKey = key;
        this.rebindEnabled();
      } else if (key !== this.activeScopeKey) {
        this.logger.warn('maker memory owner scope changed — closing stores and rebinding root', {
          fromScope: this.activeScopeKey,
          toScope: key,
        });
        this.closeAllStores();
        this.activeScopeKey = key;
        this.rebindEnabled();
      }
      // 换根/首次锚定后新 owner 若关闭了 maker memory (enabled=false), 调用方
      // 可能已持过期的 isEnabled()=true 通过检查 (withStore / session opts 快照)
      // — 这里必须 fail-closed, 不得继续打开新 owner 的 store (review #2388
      // Codex 5th P1: rebind 到 disabled owner 后应立即停止)。
      // 仅在 host 提供 reloadEnabled (desktop) 时判定: 静态宿主/测试无 rebind
      // 语义, initialEnabled=false 属正常 disabled 态, 由调用方 isEnabled 拦截。
      if (this.deps.reloadEnabled && !this.enabled) {
        throw new MemoryError(
          'not-ready',
          'maker memory disabled for current owner scope; refusing to open store',
        );
      }
    }
    if (this.resolvedBasePath === null) {
      this.logger.warn('maker memory owner scope unavailable — refusing ephemeral fallback', {
        scopeKey: this.activeScopeKey,
      });
      throw new MemoryError(
        'not-ready',
        'owner scope unavailable (signed-out or auth not settled); refusing to fall back to ephemeral storage',
      );
    }
  }

  /**
   * 当前 owner 作用域键的公开只读快照 — 供 MCP 工具层 (withStore) 在拿到
   * store 后、对 store 发起 await 操作前捕获 / 操作后复核 (review #2388
   * Codex 4th P1: getStore 返回的裸 store 在 manager 守卫之外被调用方使用)。
   * 返回 null = 未注入 ownerScopeKey (静态宿主)。
   */
  currentOwnerScopeKey(): string | null {
    return this.deps.ownerScopeKey?.() ?? null;
  }

  /** owner 作用域变化时按新 owner 设置重绑定 enabled (host 注入 reloadEnabled)。 */
  private rebindEnabled(): void {
    if (!this.deps.reloadEnabled) return;
    const next = this.deps.reloadEnabled();
    if (next !== this.enabled) {
      this.logger.info('maker memory enabled rebound after owner scope change', { enabled: next });
      this.enabled = next;
    }
  }

  /** 关闭池内全部 db (作用域切换 / dispose / resetAll 共用)。幂等。 */
  private closeAllStores(): void {
    for (const [workdir, { db }] of this.stores) {
      try {
        db.close();
      } catch (e) {
        this.logger.warn('close store db failed', { workdir, error: String(e) });
      }
    }
    this.stores.clear();
  }

  /**
   * 跨 await 作用域复核 — owner 竞态守卫的第二道闸 (review #2388 P1):
   * 异步操作 (getStore 的 store.init、resetAll/resetDigests 的 fs 操作) 期间
   * owner 可能已提交/切换。用 ownerScopeKey() 的**实时值**与入口捕获的
   * scopeAtEntry 比较 (不能依赖 activeScopeKey —— 它只在 ensureOwnerScope
   * 被再次调用时才刷新), 不一致立即中止 fail-closed, 绝不把旧 owner 的结果
   * 提交到新 owner 的池/文件系统。
   */
  private assertScopeUnchanged(scopeAtEntry: string | null): void {
    if (!this.deps.ownerScopeKey) return;
    if (this.deps.ownerScopeKey() !== scopeAtEntry) {
      throw new MemoryError(
        'not-ready',
        'owner scope changed during async memory operation; aborting (retry against current scope)',
      );
    }
  }

  /**
   * Bootstrap-time agents 注入 — 解决"manager 需要 agents, agents 需要 manager"
   * 的鸡生蛋时序: manager 先建 (agents 传 {}) → agents 创建时拿 manager 引用 →
   * setAgents() 把 agents 挂回 manager。后续 enable() 才能遍历到。
   *
   * 仅在 host 装配阶段调一次, 不应该在运行期改。
   */
  setAgents(agents: Partial<Record<AgentKind, BaseAgent>>): void {
    this.deps.agents = agents;
  }

  // ── 状态查询 / 切换 ─────────────────────────────────────────────────────

  getState(): MakerMemoryState {
    return {
      enabled: this.enabled,
      activeWorkdirs: Array.from(this.stores.keys()),
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 启用 maker memory:
   *  1. 标记 enabled = true
   *  2. 遍历所有 agent 调 setMemory(false) 强制关原生 (capabilities 不支持的跳过, 不抛)
   *  3. 后续 startSession 自动注入 memory MCP + system prompt
   *
   * 已经在跑的 session 不会 hot-reload, 改完下次 startSession 生效。
   */
  async enable(opts?: { skipAgentSync?: boolean }): Promise<SetEnabledResult> {
    this.enabled = true;
    if (opts?.skipAgentSync) {
      // 状态先行、原生联动延迟:host 的「延迟生效」路径(Codex 会话在 turn 内)
      // 需要 enabled 立刻翻转(新 session 的 memory 注入按新值走),但 native
      // setMemory 的 live-host RPC 热更新不能打进正在跑的 turn —— 由 host 在
      // 会话空闲后自行调 syncNativeAgentsOff() 补齐。
      this.logger.info('maker memory enabled (agent sync deferred by caller)');
      return { effective: 'next-session' };
    }
    const affected = await this.syncNativeAgentsOff();
    this.logger.info('maker memory enabled', { affectedAgents: affected });
    return { effective: 'next-session', affectedAgents: affected };
  }

  /**
   * enable 的原生联动步骤:把各 agent 的原生 memory 关掉(setMemory(false),
   * maker memory 接管)。CodexAgent.setMemory 会立即 RPC 热更新所有 live host,
   * 因此单独暴露 —— enable({skipAgentSync:true}) 的调用方在会话空闲后再补这一步。
   * kinds 可选:只同步指定 agent(Claude 的 setMemory 是纯内存覆盖、不碰
   * shared host,调用方可以立即同步 Claude、只把 Codex 延迟到空闲后)。
   */
  async syncNativeAgentsOff(
    kinds?: AgentKind[],
  ): Promise<NonNullable<SetEnabledResult['affectedAgents']>> {
    const affected: NonNullable<SetEnabledResult['affectedAgents']> = [];
    for (const [kind, agent] of Object.entries(this.deps.agents) as Array<[AgentKind, BaseAgent]>) {
      if (kinds && !kinds.includes(kind)) continue;
      try {
        const r = await agent.setMemory(false);
        affected.push({ kind, effective: r.effective });
      } catch (e) {
        if (e instanceof NotSupportedError) {
          affected.push({ kind, effective: 'unsupported' });
        } else {
          this.logger.warn('enable: agent.setMemory(false) failed', { kind, error: String(e) });
        }
      }
    }
    return affected;
  }

  /**
   * 关闭 maker memory:
   *  1. 标记 enabled = false
   *  2. 不主动恢复各 agent 的原生 memory (用户独立控制) — 避免覆盖用户后续手动 toggle
   *  3. 已 open 的 store / db 不立即 close (留给 dispose), 因为可能 mode 短期内又切回来
   *
   * 后续 startSession 不会注入 memory MCP, 但 active session 仍带着 memory MCP
   * 直到自然结束。
   */
  async disable(): Promise<SetEnabledResult> {
    this.enabled = false;
    this.logger.info('maker memory disabled (native memory unchanged)');
    return { effective: 'next-session' };
  }

  // ── Store 实例池 ─────────────────────────────────────────────────────────

  /**
   * 拿到某 workdir 的 Store. 第一次访问时 lazy 创建:
   *  - mkdir <basePath>/<sanitized-workdir>/
   *  - open SQLite db: <basePath>/<sanitized-workdir>/fts.db
   *  - 调 store.init() (创建 FTS 表 + sanity check)
   *
   * 同 workdir 复用同一 store + db 实例。失败 (db open 失败 / mkdir 失败) 抛错。
   *
   * key 语义: 本地会话传 workdir 绝对路径; SSH remote 会话传
   * buildMemoryScopeKey 产出的 `ssh:<hostId>:<path>` 复合键 (调用方负责,
   * manager 不自己判远端) — 见 storage.ts buildMemoryScopeKey。
   */
  async getStore(absWorkdir: string): Promise<MakerMemoryStore> {
    if (!absWorkdir || absWorkdir.length === 0) {
      throw new Error('MakerMemoryManager.getStore: absWorkdir required');
    }
    // owner 作用域守卫: 缺 owner 直接拒绝 (不建临时库), scope 变化则换根。
    this.ensureOwnerScope();
    const cached = this.stores.get(absWorkdir);
    if (cached) return cached.store;

    // 异步初始化期间的竞态锚点 (review #2388 P1): 整个流程用入口捕获的 scope +
    // root, 不再跨 await re-read 动态根; 完成后复核 scope 未变才提交入池。
    const scopeAtEntry = this.deps.ownerScopeKey?.() ?? null;
    const rootAtEntry = this.resolvedBasePath!;

    // 目录名派生见 memoryScopeDirName:本地键 = sanitizeWorkdir 原规则 (不迁移),
    // 远端 ssh: 键 = 碰撞安全的 hash 形态 (review R4 P2)。
    const sanitized = memoryScopeDirName(absWorkdir);
    const storageDir = path.join(rootAtEntry, MEMORY_SUBDIR, sanitized);
    const dbPath = path.join(storageDir, FTS_DB_FILENAME);

    // mkdir 在 storage.init() 里也会做, 但 db open 时父目录必须存在 — 提前 mkdir
    const fs = await import('node:fs');
    fs.mkdirSync(storageDir, { recursive: true });

    const db = this.deps.sqliteFactory(dbPath);
    const store = new MakerMemoryStore({
      storageDir,
      absWorkdir,
      db,
      logger: this.logger.child(`memory:${sanitized}`),
      ...(this.deps.config ? { config: this.deps.config } : {}),
      // store 级 mutation 前置守卫 (review #2388 Codex 5th P1): 裸 store 在
      // manager 守卫之外被调用方使用 (withStore fn / agent prompt 注入路径),
      // 后置复核无法撤销已发生的写操作 —— 锚定 store 创建时 scope, 每次
      // write/delete/consolidate 前复核, scope 已变即抛 not-ready。
      ...(this.deps.ownerScopeKey
        ? { scopeCheck: () => this.assertScopeUnchanged(scopeAtEntry) }
        : {}),
    });
    await store.init();
    // 跨 await 复核: 期间 owner 已切换 → 丢弃刚建的旧 owner store, fail-closed,
    // 绝不入池。用实时 ownerScopeKey() 比较 (不依赖 activeScopeKey 被刷新)。
    if (this.deps.ownerScopeKey && this.deps.ownerScopeKey() !== scopeAtEntry) {
      try {
        db.close();
      } catch {
        /* swallow */
      }
      this.logger.warn('getStore aborted: owner scope changed during async init', {
        scopeAtEntry,
        activeScope: this.activeScopeKey,
      });
      throw new MemoryError(
        'not-ready',
        'owner scope changed during store init; retry against current scope',
      );
    }
    // 并发去重: 同 workdir 的并发 getStore 可能已把 store 提交入池, 复用池内实例。
    const existing = this.stores.get(absWorkdir);
    if (existing) {
      try {
        db.close();
      } catch {
        /* swallow */
      }
      return existing.store;
    }
    this.stores.set(absWorkdir, { store, db });
    this.logger.debug('memory store opened', { workdir: absWorkdir, sanitized });
    return store;
  }

  /** 当前是否已 open 过某 workdir 的 store (manager.getState 也能看, 这里给热路径用) */
  hasStore(absWorkdir: string): boolean {
    return this.stores.has(absWorkdir);
  }

  // ── 重置 ─────────────────────────────────────────────────────────────────

  /** 清空某 workdir 全部 memory (UI 调) */
  async resetWorkdir(absWorkdir: string): Promise<{ removedCount: number }> {
    const store = await this.getStore(absWorkdir);
    return store.resetAll();
  }

  /**
   * 仅清空 Pi 压缩产生的 digest，绝不触碰用户维护的四类 curated memory。
   *
   * 已打开的 store 经 facade 删除以同步 FTS；未打开目录直接删 digest 文件，遗留的
   * FTS 行会在下次打开时被 sanityCheck 的计数差异触发重建。digest 本来就不进入
   * MEMORY.md，因此无需改写用户索引。
   */
  async resetDigests(): Promise<{ removedCount: number }> {
    this.ensureOwnerScope();
    // 竞态锚点 (review #2388 P1): 捕获 scope + root, 跨 await 不再 re-read 动态根;
    // 每次 fs 写操作前复核, owner 已切换则中止, 绝不扫/删新 owner 的目录。
    const scopeAtEntry = this.deps.ownerScopeKey?.() ?? null;
    const memoryRoot = path.join(this.resolvedBasePath!, MEMORY_SUBDIR);
    let total = 0;
    const activeDirs = new Set<string>();
    // 入口快照池 — owner 切换时 closeAllStores 会 clear Map, for-of 直遍历会提前
    // 结束; 用快照保证循环体仍按原 owner 的 store 逐项复核+处理 (review #2388)。
    const storeSnapshot = [...this.stores.entries()];
    for (const [workdir, { store }] of storeSnapshot) {
      // 迭代前复核 (review #2388 第三轮 P1): resetType 自身 await (list/delete),
      // 期间 owner 切换会使本循环持有的 store 被 closeAllStores 关闭 —— 必须先
      // 复核再操作, 不得在切换后继续用已失效的 store。
      this.assertScopeUnchanged(scopeAtEntry);
      activeDirs.add(memoryScopeDirName(workdir));
      total += (await store.resetType('digest')).removedCount;
    }

    const fs = await import('node:fs/promises');
    this.assertScopeUnchanged(scopeAtEntry);
    let entries: string[];
    try {
      entries = await fs.readdir(memoryRoot);
    } catch {
      return { removedCount: total };
    }
    for (const entry of entries) {
      if (activeDirs.has(entry)) continue;
      const dir = path.join(memoryRoot, entry);
      let filenames: string[];
      try {
        if (!(await fs.stat(dir)).isDirectory()) continue;
        this.assertScopeUnchanged(scopeAtEntry);
        filenames = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const filename of filenames) {
        if (parseFilename(filename)?.type !== 'digest') continue;
        try {
          this.assertScopeUnchanged(scopeAtEntry);
          await fs.unlink(path.join(dir, filename));
          total += 1;
        } catch (error) {
          if (error instanceof MemoryError && error.code === 'not-ready') throw error;
          this.logger.warn('resetDigests: failed to remove digest', {
            filename,
            error: String(error),
          });
        }
      }
    }
    // 删除后复核 (review #2388 Greptile 5th): 目标 root 在入口已固定为操作开始时
    // owner (不会误删新 owner), 但删除期间 owner 若已切换, 结果不可信 ——
    // fail-closed 抛 not-ready, 调用方不得按「成功清空」对待。
    if (this.deps.ownerScopeKey && this.deps.ownerScopeKey() !== scopeAtEntry) {
      this.logger.warn('resetDigests crossed owner boundary; aborting as not-ready', {
        scopeAtEntry,
      });
      throw new MemoryError(
        'not-ready',
        'owner scope changed during resetDigests; result is partial and must not be trusted',
      );
    }
    return { removedCount: total };
  }

  /** 清空所有 workdir 全部 memory. 慎用. */
  async resetAll(): Promise<{ removedCount: number }> {
    this.ensureOwnerScope();
    // 竞态锚点 (review #2388 P1): 捕获 scope + root, 跨 await 不再 re-read 动态根;
    // 每次目录删除前复核, owner 已切换则中止, 绝不递归删新 owner 的 maker-memory。
    const scopeAtEntry = this.deps.ownerScopeKey?.() ?? null;
    const memoryRoot = path.join(this.resolvedBasePath!, MEMORY_SUBDIR);
    let total = 0;
    // 还没 open 的 workdir 文件也要清: 扫 basePath/maker-memory 下所有目录
    const fs = await import('node:fs/promises');
    this.assertScopeUnchanged(scopeAtEntry);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(memoryRoot);
    } catch {
      return { removedCount: 0 };
    }
    for (const entry of entries) {
      const dir = path.join(memoryRoot, entry);
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) continue;
        this.assertScopeUnchanged(scopeAtEntry);
        await fs.rm(dir, { recursive: true, force: true });
        total += 1;
      } catch (e) {
        if (e instanceof MemoryError && e.code === 'not-ready') throw e;
        this.logger.warn('resetAll: failed to remove workdir memory dir', {
          dir,
          error: String(e),
        });
      }
    }
    // 已 open 的 db 都失效了, 全部 close + 清池 — 下次 getStore 会重建
    for (const { db } of this.stores.values()) {
      try { db.close(); } catch { /* swallow */ }
    }
    this.stores.clear();
    // 删除后复核 (review #2388 Greptile 5th): 目标 root 在入口已固定为操作开始时
    // owner (不会误删新 owner), 但删除期间 owner 若已切换, 结果不可信 ——
    // fail-closed 抛 not-ready, 调用方不得按「成功清空」对待。
    if (this.deps.ownerScopeKey && this.deps.ownerScopeKey() !== scopeAtEntry) {
      this.logger.warn('resetAll crossed owner boundary; aborting as not-ready', {
        scopeAtEntry,
      });
      throw new MemoryError(
        'not-ready',
        'owner scope changed during resetAll; result is partial and must not be trusted',
      );
    }
    return { removedCount: total };
  }

  // ── Review (LLM 自审) ────────────────────────────────────────────────────

  /**
   * 让 LLM 审查当前 workdir 的所有 memory, 找出矛盾/过期/可合并条目。
   * 返回 LLM 的建议文本 (LLM 自己决定是否 follow up consolidate/delete tool 调用)。
   *
   * 不在 manager 内自动执行 delete/consolidate — 让 LLM 在 turn 内决定 + 走标准
   * write/delete tool, 保留可观测性。manager 只是 "起一次审查 LLM 调用" 的入口。
   */
  async runReview(absWorkdir: string): Promise<{ suggestions: string }> {
    // 竞态锚点 (review #2388 Codex 9th P1): 读记录与发 oneShot 之间有 await
    // (isOneShotRouteDisabled / agent 派发), 边界窗口内不得把旧 owner 的
    // memory dump 发给 review LLM — 构造/发送 prompt 前复核 scope。
    const scopeAtEntry = this.deps.ownerScopeKey?.() ?? null;
    const store = await this.getStore(absWorkdir);
    const records = await store.list();
    if (records.length === 0) {
      return { suggestions: 'No memories in this workdir yet.' };
    }
    const reviewAgentKind = this.deps.reviewAgent ?? 'claude-code';
    const agent = this.deps.agents[reviewAgentKind];
    if (!agent) {
      throw new Error(`runReview: review agent '${reviewAgentKind}' not registered`);
    }
    if (await this.deps.isOneShotRouteDisabled?.(reviewAgentKind)) {
      throw new Error(
        `runReview: one-shot route for '${reviewAgentKind}' is disabled in settings`,
      );
    }
    // 发送前复核: 边界已切换则丢弃旧 owner 的 records, fail-closed。
    this.assertScopeUnchanged(scopeAtEntry);

    const summary = records
      .map((r) => `### ${r.filename}\n- title: ${r.frontmatter.title}\n- description: ${r.frontmatter.description}\n- updatedAt: ${r.frontmatter.updatedAt}\n\n${r.body}`)
      .join('\n\n---\n\n');
    const prompt = [
      'You are reviewing a memory store for consistency.',
      'For each potential issue, classify as: contradiction / outdated / duplicate / fine.',
      'Output a concise plan (<= 200 words) listing which files to delete or merge and why.',
      '',
      `Memory dump (${records.length} entries):`,
      '',
      summary,
    ].join('\n');

    const suggestions = await agent.oneShot(prompt, { maxTokens: 800, timeoutMs: 60_000 });
    return { suggestions };
  }

  /** 直接给 store 一个 write 入口. mcp-server 层会拿这个 (而不是先 getStore 再 write) */
  async write(absWorkdir: string, opts: WriteOptions) {
    const store = await this.getStore(absWorkdir);
    return store.write(opts);
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /** Maker.shutdown 调 (跟 agent.dispose 同时机). 关闭所有 db, 清池. 幂等. */
  dispose(): void {
    this.closeAllStores();
    this.logger.info('MakerMemoryManager disposed');
  }
}
