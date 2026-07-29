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

import { MakerMemoryStore, memoryScopeDirName } from './store.js';
import {
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
    const cached = this.stores.get(absWorkdir);
    if (cached) return cached.store;

    // 目录名派生见 memoryScopeDirName:本地键 = sanitizeWorkdir 原规则 (不迁移),
    // 远端 ssh: 键 = 碰撞安全的 hash 形态 (review R4 P2)。
    const sanitized = memoryScopeDirName(absWorkdir);
    const storageDir = path.join(this.deps.basePath, MEMORY_SUBDIR, sanitized);
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
    });
    await store.init();
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

  /** 清空所有 workdir 全部 memory. 慎用. */
  async resetAll(): Promise<{ removedCount: number }> {
    let total = 0;
    // 还没 open 的 workdir 文件也要清: 扫 basePath/maker-memory 下所有目录
    const fs = await import('node:fs/promises');
    const memoryRoot = path.join(this.deps.basePath, MEMORY_SUBDIR);
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
        await fs.rm(dir, { recursive: true, force: true });
        total += 1;
      } catch (e) {
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
    for (const [workdir, { db }] of this.stores) {
      try {
        db.close();
      } catch (e) {
        this.logger.warn('dispose: db close failed', { workdir, error: String(e) });
      }
    }
    this.stores.clear();
    this.logger.info('MakerMemoryManager disposed');
  }
}
