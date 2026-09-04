/**
 * controller.ts —— learn run 状态机编排(learn-host 核心)。
 *
 * 生命周期:
 *   startLearn → collecting(证据打包) → distilling(独立后台 session 蒸馏)
 *   → awaiting-review(staging 扫描+校验通过) → apply/discard;
 *   任一阶段失败 → failed(+staging 清理);collecting/distilling 可 cancel。
 *
 * 设计:
 *   - 全部外部效应(session 创建 / 检索 / staging IO / 落盘 / 广播)经 deps 注入,
 *     单测用内存 fake + tmpdir 直接驱动状态机(规则 14)。
 *   - 活跃管线全局并发 1(collecting/distilling 同时只允许一个);awaiting-review
 *     的 run 不占并发额度 —— 它只是在等用户,可以积压多个待审查提案。
 *   - prompt 是 per-call user message,经 session.send 注入,绝不碰 system prompt
 *     (规则 10/11,不破坏缓存前缀)。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import {
  parseToolLoopErrorDetails,
  type ToolLoopErrorDetails,
} from '@cindy/maker-shared/tool-loop-error';

import {
  LEARN_TERMINAL_STATUSES,
  type LearnEventPayload,
  type LearnProvenance,
  type LearnRunPublic,
  type LearnRunStatus,
  type LearnStartRequest,
} from '../../shared/learnTypes';
import type { FileChange } from '../skillhub/snapshot';
import { getSkillInstallLockOwner, tryAcquireSkillInstallLock } from '../skillhub/installLock';
import { prependHandoffToUserMessage } from '../maker-ipc/agentHandoff';
import type { EvidenceSearchFn } from './evidence';
import { collectEvidence } from './evidence';
import { extractKeywords } from './evidence.pure';
import { buildLearnPrompt } from './promptBuilder';
import { redactSensitive } from './redaction';
import type { ScanStagingResult } from './staging';
import type { ProposalFile } from './stagingValidation.pure';
import {
  MAX_PROPOSAL_TOTAL_BYTES,
  computeProposalFingerprint,
  isExcludedProposalPath,
  validateProposal,
} from './stagingValidation.pure';
import type { ApplyProposalParams, ApplyProposalResult } from './apply';

/** run 持久化的结构化形态(LearnRunStore 的窄化接口,便于测试用内存 fake)。 */
export interface LearnRunStoreLike {
  load(): Promise<void>;
  list(): LearnRunPublic[];
  get(runId: string): LearnRunPublic | undefined;
  put(run: LearnRunPublic): Promise<void>;
}

/** 蒸馏 turn 超时(超过即 abort → failed)。 */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** awaiting-review 超龄阈值(sweep 时标 expired)。 */
const AWAITING_REVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** controller 抛出的业务错误 —— registerIpc 映射到 throwIpcError。 */
export class LearnError extends Error {
  constructor(
    public code: 'LEARN_BUSY' | 'LEARN_INVALID_STATE' | 'INVALID_PARAMS' | 'NOT_FOUND' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'LearnError';
  }
}

/** Terminal agent errors retain their stable projection while crossing the
 * learn pipeline so persisted runs can be localized by the renderer. */
interface LearnTerminalError extends Error {
  reason?: string;
  toolLoop?: ToolLoopErrorDetails;
}

/** 蒸馏 session 的窄化形态(maker Session 的子集,便于测试 fake)。 */
export type LearnSessionSendResult =
  | { accepted: true }
  | { accepted: false; reason?: string };

export interface LearnSessionLike {
  id: string;
  send(
    message: { type: 'user'; content: string },
    opts?: { onAccepted?: () => Promise<void> | void },
  ): Promise<LearnSessionSendResult>;
  onEvent(listener: (ev: { type: string; data?: unknown; turnContinuationId?: number }) => void): () => void;
  abort(): Promise<void>;
}

export interface LearnControllerDeps {
  /** 新建蒸馏 session(learn-host/index.ts 里桥接 maker.createSession + wireSessionToIpc)。
   *  originSessionId 用于继承触发会话的 agentKind/model/effort —— 用户在哪个
   *  模型上下发 /learn,蒸馏就用哪个模型,不写死默认。 */
  createSession(opts: { id: string; workingDir: string; title: string; originSessionId?: string }): Promise<LearnSessionLike>;

  /** 判定事件是否终态错误(maker-core 的 isTerminalAgentErrorEvent)。 */
  isTerminalErrorEvent(ev: { type: string; data?: unknown }): boolean;
  search: EvidenceSearchFn;
  store: LearnRunStoreLike;
  broadcast(payload: LearnEventPayload): void;
  staging: {
    create(runId: string): Promise<string>;
    scan(runId: string): Promise<ScanStagingResult>;
    cleanup(runId: string): Promise<void>;
    renameProposalDir(absPath: string, newName: string): Promise<string>;
    /** apply 冻结:原子 rename 把提案目录挪出会话可写范围,返回冻结后绝对路径。 */
    freezeProposal(runId: string, dirName: string): Promise<string>;
    /** 冻结目录的文件采集(apply 校验来源,不能复用冻结前的扫描快照)。 */
    collectProposal(absPath: string): Promise<{ files: ProposalFile[]; violations: string[] }>;
    /** 校验/落盘失败时把冻结目录放回 staging(用户可继续对话迭代)。 */
    unfreezeProposal(frozenAbsPath: string, runId: string): Promise<void>;
    dirForRun(runId: string): string;
    /** hub 参考文件写入 staging/_reference/<slug>/,返回相对 staging 的目录标识。 */
    writeReferenceFiles(runId: string, slug: string, files: Array<{ path: string; content: string }>): Promise<string>;
  };
  applyProposal(params: ApplyProposalParams): Promise<ApplyProposalResult>;
  computeDiff(
    oldDir: string | null,
    newDir: string,
    opts?: {
      skipOld?: (rel: string, size: number | null) => boolean;
      skipNew?: (rel: string, size: number | null) => boolean;
    },
  ): Promise<FileChange[]>;
  computeExcludedOldSideRemovals?(oldDir: string, newDir: string): Promise<FileChange[]>;
  /** 已装目标目录 fingerprint;用于确认 apply 时用户审查过的基线没变。 */
  computeTargetFingerprint(targetDir: string): Promise<string>;
  /** 已装 skill 目录解析 + 存在性(diff 基线 / existingSkillContent)。 */
  resolveInstalledSkillDir(name: string): string;
  /** 可选多目录候选:共享 .agents 与 Claude 侧真实目录都算用户已装 skill。 */
  resolveInstalledSkillDirs?(name: string): string[];
  dirExists(dir: string): Promise<boolean>;
  readFileText(filePath: string): Promise<string | null>;
  /** 蒸馏 session 落一条干净的 user 消息(对话起点;完整 prompt 不落库,同 goal-host)。 */
  persistUserMessage(sessionId: string, content: string): Promise<void>;
  /** 修正 sessions 行(source='learn' + acceptEdits + 继承的 providerId),失败仅 warn。 */
  backfillSessionMeta(sessionId: string): Promise<void>;
  beforeDispatchUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
  peekPendingHandoff?: (sessionId: string) => Promise<string | null>;
  consumePendingHandoff?: (sessionId: string) => void;
  /** 应用当前语言(shared/locale SupportedLocale)—— 蒸馏自述语言跟随系统语言配置。 */
  getAppLocale(): string;
  /** 当前 data owner id(run 归属标记 + 按 owner 过滤;未登录返回 null)。 */
  getCurrentDataOwnerId(): string | null;
  /** learn-host 启动期 resume+sweep 完成门:防新 run staging 被启动 sweep 误删。 */
  waitForStartupSweep?(): Promise<void>;
  /** 用户画像收集(profile.ts;originWorkdir=触发会话的 workdir,无则 null)。 */
  collectProfile(originWorkdir: string | null): Promise<{ block: string; used: boolean }>;
  /** 触发会话 → workdir(画像的 feedback/project 域边界;查不到返 null)。 */
  getSessionWorkdir(sessionId: string): Promise<string | null>;
  /** 无参 /learn:读取触发会话的消息并格式化为 prompt 块(空会话返空串)。 */
  getConversationBlock(sessionId: string): Promise<string>;
  /** 已装 skill 清单块("改 vs 加"决策依据;无 skill 返空串)。 */
  getInstalledSkillsIndex(): Promise<string>;
  /** hub 源:拉市场 skill 详情 + 全部已发布文件(PR3 注入;未注入时 hub 源报 INVALID_PARAMS)。 */
  fetchHubSkill?: (slug: string, catalogScope?: 'market' | 'team') => Promise<{
    name: string;
    description: string;
    content: string;
    /** SKILL.md 之外的已发布文件(scripts/references/...),写入 staging/_reference 供 agent 复制。 */
    files?: Array<{ path: string; content: string }>;
    /** 未写入 _reference 的文件及原因,用于 prompt 明示 reference set 是部分内容。 */
    omittedFiles?: Array<{ path: string; reason: string }>;
  } | null>;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  turnTimeoutMs?: number;
  now?: () => number;
}

interface ActiveTurn {
  runId: string;
  session: LearnSessionLike;
  stopListening?: () => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** cancel 时 reject 掉 turnFinished,让 pipeline 立即收口(否则悬挂 pending)。 */
  rejectTurn?: (err: Error) => void;
}

/** awaiting-review 后持续观察修订会话所需的句柄。 */
interface RevisionWatcher {
  session: LearnSessionLike;
  stopListening: () => void;
}

export class LearnController {
  private active: ActiveTurn | null = null;
  /** 审查动作互斥(apply/discard 的 await 窗口内不许另一动作插入 —— 双窗口/连点
   *  下 discard 清 staging 与 apply 落盘并发会留下"已放弃却已安装"的鬼状态)。 */
  private readonly reviewActionLocks = new Set<string>();
  // 最终安装目标互斥(同名 skill 的 final switch 必须串行,否则会互相覆盖备份与
  // registry)已收敛到 skillhub/installLock 的进程级共享锁 —— 与市场安装/卸载
  // 同一注册表,见 acquireSkillApplyLock。
  /** apply/discard 的真实 promise:dispose 必须等它们收口后才能换 controller。 */
  private readonly reviewActionPromises = new Map<string, Promise<void>>();
  /** 蒸馏会话的持续观察器(runId → 会话 + 解绑函数):对话即迭代 —— 每轮 done
   *  重扫 staging 更新提案,skill 是会话的活产物,不需要专用 iterate 接口。 */
  private watchers = new Map<string, RevisionWatcher>();
  /** awaiting-review 期间修订回合是否进行中(watcher 只把真实 turn 事件视为
   *  开始,done/终态错误 = 回合结束)。回合进行中拒绝 apply —— 模型可能已改写
   *  staging 而 diff 还是旧的。 */
  private readonly revisionTurnActive = new Set<string>();
  /** watcher 触发的异步重扫:apply 会先等待已启动的 rescan 完成,避免并发 rename。 */
  private readonly revisionRescans = new Map<string, Promise<void>>();
  /** dispose 后拒绝新动作:切账号时 collecting 阶段的管线还挂在 await 上,
   *  没有这个门会用旧账号的 deps 继续建蒸馏会话(Codex review)。 */
  private disposed = false;

  constructor(private readonly deps: LearnControllerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private resolveInstalledSkillDirs(name: string): string[] {
    const dirs = this.deps.resolveInstalledSkillDirs?.(name) ?? [
      this.deps.resolveInstalledSkillDir(name),
    ];
    return [...new Set(dirs.filter(Boolean))];
  }

  /** 审查基线的组合目标指纹:覆盖**所有**存在的候选目录(共享 .agents 与
   *  Claude 侧真实目录)。apply 会动到每一个候选(第二目录挪备份+换链),只
   *  fingerprint 第一个的话,另一个在审查后被改动就检测不到(Codex review)。 */
  private async computeCombinedTargetFingerprint(name: string): Promise<string | null> {
    const parts: string[] = [];
    for (const dir of this.resolveInstalledSkillDirs(name)) {
      if (!(await this.deps.dirExists(dir))) continue;
      parts.push(`${dir}:${await this.deps.computeTargetFingerprint(dir)}`);
    }
    return parts.length > 0 ? parts.join('|') : null;
  }

  private async findInstalledSkillDir(name: string): Promise<string | null> {
    for (const dir of this.resolveInstalledSkillDirs(name)) {
      if (await this.deps.dirExists(dir)) return dir;
    }
    return null;
  }

  // ── 启动恢复 ───────────────────────────────────────────────────────────────

  /**
   * 启动时调:中断态(collecting/distilling)转 failed;awaiting-review 校验
   * staging 仍在(丢了转 expired)+ 超龄转 expired;返回需保留 staging 的 runId 集。
   */
  async resume(): Promise<Set<string>> {
    await this.deps.store.load();
    const keep = new Set<string>();
    for (const run of this.deps.store.list()) {
      if (run.status === 'collecting' || run.status === 'distilling') {
        await this.update(run, { status: 'failed', error: 'interrupted by app restart' });
        continue;
      }
      if (run.status === 'awaiting-review') {
        const tooOld = this.now() - run.updatedAt > AWAITING_REVIEW_MAX_AGE_MS;
        const proposalDir = this.proposalDirOf(run);
        const alive = proposalDir ? await this.deps.dirExists(proposalDir) : false;
        if (tooOld || !alive) {
          await this.update(run, { status: 'expired' });
          continue;
        }
        keep.add(run.runId);
      }
    }
    return keep;
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  async listRuns(): Promise<LearnRunPublic[]> {
    await this.deps.store.load();
    return this.deps.store.list().filter((r) => this.ownedByCurrentDataOwner(r));
  }

  /** runs.json 已按 data owner 分文件;字段校验再防旧文件/测试数据混入。 */
  private ownedByCurrentDataOwner(run: LearnRunPublic): boolean {
    const runOwnerId = run.dataOwnerId ?? run.ownerUserId;
    if (!runOwnerId) return true;
    return runOwnerId === this.deps.getCurrentDataOwnerId();
  }

  private mustGet(runId: string): LearnRunPublic {
    const run = this.deps.store.get(runId);
    if (!run || !this.ownedByCurrentDataOwner(run)) {
      throw new LearnError('NOT_FOUND', `learn run ${runId} not found`);
    }
    return run;
  }

  /** awaiting-review 后提案目录 = staging/{runId}/{skillName}。 */
  private proposalDirOf(run: LearnRunPublic): string | null {
    if (!run.skillName) return null;
    return path.join(this.deps.staging.dirForRun(run.runId), run.skillName);
  }

  // ── 主流程 ────────────────────────────────────────────────────────────────

  async startLearn(req: LearnStartRequest): Promise<{ runId: string }> {
    // startLearnHost 启动时会异步 resume + sweep 孤儿 staging。新 run 必须等
    // sweep 完成后再创建 staging,否则会落入 keep 快照之后、readdir 之前的
    // 窗口,被当作孤儿删掉(Codex review)。
    await this.deps.waitForStartupSweep?.();
    if (this.disposed) {
      throw new LearnError('INTERNAL', 'learn controller is disposed (account switching?)');
    }
    // runs.json 由 resume() 异步载入;任何写入前必须确保已加载完成,否则
    // put() 落盘会丢掉尚未载入的历史 run(Codex review)。load() 幂等。
    await this.deps.store.load();
    const input = (req.input ?? '').trim();
    // IPC 边界校验:sourceKind 是 renderer 传入的自由字符串,未知值会流进管线
    // 生成无素材的垃圾 run(自查修正)。
    if (req.sourceKind !== 'freetext' && req.sourceKind !== 'session' && req.sourceKind !== 'hub') {
      throw new LearnError('INVALID_PARAMS', `unknown sourceKind: ${String(req.sourceKind)}`);
    }
    if (req.sourceKind === 'freetext' && !input) {
      throw new LearnError('INVALID_PARAMS', 'learn request text is required');
    }
    if (req.sourceKind === 'session' && !req.originSessionId) {
      throw new LearnError('INVALID_PARAMS', 'session source requires the origin session');
    }
    if (req.sourceKind === 'hub' && !req.hubSlug) {
      throw new LearnError('INVALID_PARAMS', 'hubSlug is required for hub source');
    }
    // hubSlug 会作为路径段进入 resolveInstalledSkillDir / writeReferenceFiles:
    // builtins 的 /learn hub: 正则已限,但 IPC learn:start 可直调 —— 边界处再校
    // 一次,拒绝分隔符 / '..' 等任意串(自查;与市场 slug 规则一致)。
    if (req.sourceKind === 'hub' && req.hubSlug && !/^[a-z0-9][a-z0-9-]*$/.test(req.hubSlug)) {
      throw new LearnError('INVALID_PARAMS', `invalid hubSlug: ${req.hubSlug}`);
    }
    if (req.sourceKind === 'hub' && req.hubCatalogScope && req.hubCatalogScope !== 'market' && req.hubCatalogScope !== 'team') {
      throw new LearnError('INVALID_PARAMS', `invalid hubCatalogScope: ${String(req.hubCatalogScope)}`);
    }
    if (req.sourceKind === 'hub' && !this.deps.fetchHubSkill) {
      throw new LearnError('INVALID_PARAMS', 'hub source is not available');
    }
    // 活跃管线并发 1:有 run 在 collecting/distilling 就拒绝(awaiting-review 不占额度)。
    const inFlight = this.deps.store
      .list()
      .find(
        (r) =>
          this.ownedByCurrentDataOwner(r) &&
          (r.status === 'collecting' || r.status === 'distilling'),
      );
    if (inFlight) {
      throw new LearnError('LEARN_BUSY', `learn run ${inFlight.runId} is already in progress`);
    }

    const runId = randomUUID();
    const dataOwnerId = this.deps.getCurrentDataOwnerId();
    const run: LearnRunPublic = {
      runId,
      status: 'collecting',
      sourceKind: req.sourceKind,
      ...(dataOwnerId ? { dataOwnerId } : {}),
      input,
      ...(req.hubSlug ? { hubSlug: req.hubSlug } : {}),
      ...(req.sourceKind === 'hub' ? { hubCatalogScope: req.hubCatalogScope ?? 'market' } : {}),
      ...(req.originSessionId ? { originSessionId: req.originSessionId } : {}),
      usedSessionEvidence: false,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.deps.store.put(run);
    this.deps.broadcast({ type: 'state-changed', run });

    // fire-and-forget:startLearn 立即返回 runId,管线异步推进,状态经 broadcast 可见。
    void this.runPipeline(runId).catch(async (err) => {
      this.deps.logger.error('[learn] pipeline failed', { runId, error: String(err) });
      const current = this.deps.store.get(runId);
      if (current && current.status !== 'failed' && current.status !== 'cancelled') {
        await this.fail(current, err instanceof Error ? err : String(err));
      }
    });

    return { runId };
  }

  private async runPipeline(runId: string): Promise<void> {
    let run = this.mustGet(runId);
    const stagingDir = await this.deps.staging.create(runId);

    // 1) hub 源:拉上游 skill 作为参考材料;证据 query 由元数据派生。
    //    可用已发布文件落 staging/_reference/<slug>/ —— 产物若依赖上游 scripts,
    //    agent 必须复制进自己的 skill 目录(否则装完引用悬空,实测踩过)。
    let referenceSkillContent: string | undefined;
    let referenceFilesDir: string | undefined;
    let referenceFilesOmissions: Array<{ path: string; reason: string }> | undefined;
    let evidenceQuery = run.input;
    if (run.sourceKind === 'hub' && run.hubSlug && this.deps.fetchHubSkill) {
      const hub = await this.deps.fetchHubSkill(run.hubSlug, run.hubCatalogScope ?? 'market');
      if (!hub) throw new LearnError('NOT_FOUND', `hub skill ${run.hubSlug} not found`);
      // fetch 的网络 await 期间可能被 cancel(cleanup 已删 staging):此处不设门
      // 的话 writeReferenceFiles 会把 _reference/ 整个重建成孤儿目录(自查)。
      // disposed 同样要终态收口 —— 只 return 会把 run 留在 collecting,重启前
      // startLearn 一直 LEARN_BUSY(Codex review)。
      const afterFetch = this.mustGet(runId);
      if (afterFetch.status !== 'collecting') return;
      if (this.disposed) {
        await this.cancelInFlightRunForDispose(afterFetch);
        return;
      }
      referenceSkillContent = hub.content;
      if (hub.files && hub.files.length > 0) {
        await this.deps.staging.writeReferenceFiles(run.runId, run.hubSlug, hub.files);
        referenceFilesDir = `./_reference/${run.hubSlug}/`;
      }
      referenceFilesOmissions = hub.omittedFiles;
      evidenceQuery = [run.input, extractKeywords(hub.name, hub.description)].filter(Boolean).join(' ');
    }

    // 1b) session 源:当前会话全文是蒸馏主素材(代码读消息表,不靠模型翻);
    //     该模式下跳过主题检索(素材就是会话本身),画像仍注入
    let conversationBlock = '';
    if (run.sourceKind === 'session' && run.originSessionId) {
      conversationBlock = await this.deps.getConversationBlock(run.originSessionId);
      if (!conversationBlock) {
        throw new LearnError('INVALID_PARAMS', 'the origin conversation has no distillable content');
      }
      evidenceQuery = '';
    }

    // 2) 证据打包(代码化;检索失败静默退化为无证据)+ 用户画像
    const evidence = await collectEvidence(evidenceQuery, this.deps.search);
    const originWorkdir = run.originSessionId
      ? await this.deps.getSessionWorkdir(run.originSessionId).catch(() => null)
      : null;
    const profile = await this.deps.collectProfile(originWorkdir);

    // 2b) 同名已装 skill 探测(hub 源按上游名;freetext 无从判断,跳过)
    let existingSkillContent: string | undefined;
    if (run.sourceKind === 'hub' && run.hubSlug) {
      const installedDir = await this.findInstalledSkillDir(run.hubSlug);
      if (installedDir) {
        // 本地 SKILL.md 是用户资产,可能存有密钥/内网地址等 —— 与证据/画像同责,
        // 注入 prompt(会发往模型 API)前先过 redactSensitive(Codex review)。
        const raw = await this.deps.readFileText(path.join(installedDir, 'SKILL.md'));
        existingSkillContent = raw != null ? redactSensitive(raw).text : undefined;
      }
    }

    // 画像/会话全文/检索证据/本地已装 skill 原文同责:任一注入即含个人上下文
    // ⇒ provenance.personal。已装 skill 是用户本地资产,其内容(含此前的个性化)
    // 进了 prompt,产物就不能默认可发布。
    run = await this.update(run, {
      usedSessionEvidence:
        evidence.usedSessionEvidence ||
        profile.used ||
        conversationBlock.length > 0 ||
        existingSkillContent != null,
    });
    // collecting 阶段被 cancel / dispose(切账号):update 的终态保护会原样返回
    // cancelled 快照,此处显式收口,不再创建蒸馏会话(Codex review 的 collecting
    // 竞态;disposed 门防止用旧账号 deps 继续建会话)。
    if (run.status !== 'collecting') return;
    if (this.disposed) {
      await this.cancelInFlightRunForDispose(run);
      return;
    }

    // 3) prompt 构造 + 蒸馏 session
    const installedSkillsIndex = await this.deps.getInstalledSkillsIndex().catch(() => '');
    const defaultRequest =
      run.sourceKind === 'session'
        ? 'Distill the repeatable workflow(s) from the current conversation below into a reusable skill.'
        : `Distill a reusable skill from the reference skill below.`;
    const prompt = buildLearnPrompt({
      userRequest: run.input || defaultRequest,
      appLocale: this.deps.getAppLocale(),
      evidenceBlock: evidence.block,
      userProfileBlock: profile.block,
      conversationBlock,
      installedSkillsIndex,
      referenceSkillContent,
      referenceFilesDir,
      referenceFilesOmissions,
      existingSkillContent,
    });

    const beforeCreate = this.mustGet(runId);
    if (beforeCreate.status !== 'collecting') return;
    if (this.disposed) {
      await this.cancelInFlightRunForDispose(beforeCreate);
      return;
    }
    const title = `[Learn] ${(run.input || run.hubSlug || '').slice(0, 40)}`;
    const session = await this.deps.createSession({
      id: randomUUID(),
      workingDir: stagingDir,
      title,
      ...(run.originSessionId ? { originSessionId: run.originSessionId } : {}),
    });
    await this.deps.backfillSessionMeta(session.id);
    const afterCreate = await this.update(run, { status: 'distilling', sessionId: session.id });
    // createSession/backfill 的 await 窗口内仍可能被 cancel(Codex fresh evidence):
    // update 的终态保护会拒绝 cancelled → distilling,此处按返回值收口,把刚建的
    // 会话中止掉,不再白跑一轮模型调用。
    if (afterCreate.status !== 'distilling' || this.disposed) {
      void session.abort().catch(() => undefined);
      // dispose 窗口里 'distilling' 已被持久化 —— 必须收口成终态,否则 runs.json
      // 留着非终态 run,重启前 startLearn 永远 LEARN_BUSY(Codex review)。cancel
      // 路径(afterCreate 非 distilling)本身已是终态,不动。
      if (this.disposed && afterCreate.status === 'distilling') {
        await this.update(afterCreate, {
          status: 'cancelled',
          error: 'learn host disposed (account switch)',
        }).catch(() => undefined);
      }
      return;
    }

    const cleanMessage =
      run.sourceKind === 'hub'
        ? `/learn hub:${run.hubCatalogScope ?? 'market'}:${run.hubSlug}`
        : run.sourceKind === 'session'
          ? '/learn (distill current conversation)'
          : `/learn ${run.input}`;
    await this.runDistillTurn(runId, session, prompt, cleanMessage);
  }

  /**
   * 跑首轮蒸馏 turn 并收口:listener+超时(scheduler runner 同款)→ send(干净
   * user 消息落库,完整 prompt 只进模型)→ 扫描校验 → awaiting-review,并挂上
   * 持续观察器(此后对话即迭代,见 attachRevisionWatcher)。
   */
  private async runDistillTurn(
    runId: string,
    session: LearnSessionLike,
    prompt: string,
    cleanMessage: string,
  ): Promise<void> {
    let assistantText = '';
    const turnFinished = new Promise<void>((resolve, reject) => {
      let off: () => void = () => undefined;
      off = session.onEvent((ev) => {
        if (ev.type === 'text') {
          const data = ev.data as { text?: string; isFinal?: boolean } | null;
          if (data && typeof data.text === 'string') {
            if (data.isFinal) assistantText = data.text;
            else assistantText += data.text;
          }
          return;
        }
        if (ev.type === 'done') {
          if (isTurnContinuationBoundaryEvent(ev)) return;
          off();
          resolve();
        } else if (this.deps.isTerminalErrorEvent(ev)) {
          off();
          reject(extractTerminalError(ev.data));
        }
      });
      this.active = { runId, session, stopListening: off, rejectTurn: reject };
    });
    void turnFinished.catch(() => undefined);

    const timeoutMs = this.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timedOut = new Promise<never>((_resolve, reject) => {
      const handle = setTimeout(() => {
        void session.abort().catch(() => undefined);
        reject(new Error(`distillation timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      if (this.active?.runId === runId) this.active.timeoutHandle = handle;
    });
    void timedOut.catch(() => undefined);

    let baselineStarted = false;
    try {
      const pendingHandoff = await this.deps.peekPendingHandoff?.(session.id) ?? null;
      const outgoingMessage = pendingHandoff
        ? (prependHandoffToUserMessage({ type: 'user', content: prompt }, pendingHandoff) as { type: 'user'; content: string })
        : { type: 'user' as const, content: prompt };
      const sendResult = await session.send(
        outgoingMessage,
        {
          onAccepted: async () => {
            await this.deps.persistUserMessage(session.id, cleanMessage).catch((err) => {
              this.deps.logger.warn('[learn] persist user message failed (non-fatal)', err);
            });
            if (this.deps.beforeDispatchUserTurn) {
              await this.deps.beforeDispatchUserTurn(session.id);
              baselineStarted = true;
            }
          },
        },
      );
      if (!sendResult.accepted) {
        if (baselineStarted) {
          this.deps.onUndispatchedUserTurn?.(session.id);
          baselineStarted = false;
        }
        throw new Error(`distillation send was not accepted${sendResult.reason ? `: ${sendResult.reason}` : ''}`);
      }
      if (pendingHandoff) {
        this.deps.consumePendingHandoff?.(session.id);
      }
      baselineStarted = false;
      await Promise.race([turnFinished, timedOut]);
    } catch (err) {
      if (baselineStarted) {
        this.deps.onUndispatchedUserTurn?.(session.id);
        baselineStarted = false;
      }
      throw err;
    } finally {
      this.clearActive(runId);
    }

    // cancel 可能已把状态改掉 —— 只有仍在 distilling 时才继续收口
    const run = this.mustGet(runId);
    if (run.status !== 'distilling') return;

    const settleProblem = async (reason: string): Promise<void> => {
      await this.fail(run, reason, assistantText);
    };

    // 扫描 + 校验 → awaiting-review
    const scan = await this.deps.staging.scan(runId);
    if (scan.candidates.length === 0) {
      await settleProblem('the agent produced no skill directory');
      return;
    }
    if (scan.candidates.length > 1) {
      await settleProblem(`expected exactly one skill directory, got ${scan.candidates.length}`);
      return;
    }
    const candidate = scan.candidates[0];
    const verdict = validateProposal({
      dirName: candidate.dirName,
      files: candidate.files,
      violations: candidate.violations,
    });
    if (!verdict.ok) {
      await settleProblem(verdict.reason);
      return;
    }
    if (verdict.needsRename) {
      try {
        await this.deps.staging.renameProposalDir(candidate.absPath, verdict.skillName);
      } catch (err) {
        await settleProblem(`rename proposal dir failed: ${String(err)}`);
        return;
      }
    }

    // 产物名命中本地已装 skill = 对本地用户资产的改进(prompt 的清单指令会让
    // 模型读原文),其内容进了产物 ⇒ 个人上下文(review 修正:freetext 路径此前漏标)。
    const improvedLocalSkill = (await this.findInstalledSkillDir(verdict.skillName)) != null;

    const settled = await this.update(run, {
      status: 'awaiting-review',
      skillName: verdict.skillName,
      proposalFiles: candidate.files.map((f) => f.relPath),
      proposalFingerprint: computeProposalFingerprint(candidate.files),
      reviewedProposalFingerprint: undefined,
      reviewTargetFingerprint: undefined,
      redactionWarnings: verdict.redactionWarnings,
      assistantText,
      error: undefined,
      ...(improvedLocalSkill ? { usedSessionEvidence: true } : {}),
    });
    // scan/校验的 await 窗口内被 cancel:终态保护会挡下 awaiting-review 写入,
    // 按返回值收口 —— cancelled run 不许挂 watcher(否则观察器悬到 dispose,
    // 且会话事件会继续污染 revisionTurnActive;自查)。
    if (settled.status === 'awaiting-review') {
      this.attachRevisionWatcher(runId, session);
    }
  }

  /**
   * 对话即迭代:提案就绪后持续观察蒸馏会话,用户在会话里继续说话、模型改完
   * (每轮 done)就重扫 staging 刷新提案。扫描失效(模型改坏/删了目录)保留
   * 上一版提案并带 error。终态(apply/discard/cancel/failed)时解绑。
   */
  private attachRevisionWatcher(runId: string, session: LearnSessionLike): void {
    this.detachWatcher(runId);
    let settling = false;
    let rescanPending = false;
    const scheduleRescan = (): void => {
      if (!this.watchers.has(runId)) return;
      const run = this.deps.store.get(runId);
      if (!run || run.status !== 'awaiting-review') {
        this.detachWatcher(runId);
        return;
      }
      if (settling) {
        rescanPending = true;
        return;
      }
      settling = true;
      const rescan = this.rescanProposal(runId)
        .catch((err) => {
          this.deps.logger.warn('[learn] revision rescan failed', { runId, error: String(err) });
        })
        .finally(() => {
          settling = false;
          this.revisionRescans.delete(runId);
          if (rescanPending && this.watchers.has(runId)) {
            rescanPending = false;
            scheduleRescan();
          }
        });
      this.revisionRescans.set(runId, rescan);
      void rescan;
    };
    const off = session.onEvent((ev) => {
      // 回合活跃跟踪只认真实 turn 事件:account_usage / interaction_dismissed
      // 这类全局通知不能把 apply 永久卡在 LEARN_BUSY。
      if (this.deps.isTerminalErrorEvent(ev)) {
        this.revisionTurnActive.delete(runId);
        return;
      }
      if (ev.type !== 'done') {
        if (isRevisionTurnActivityEvent(ev)) this.revisionTurnActive.add(runId);
        return;
      }
      if (isTurnContinuationBoundaryEvent(ev)) return;
      this.revisionTurnActive.delete(runId);
      scheduleRescan();
    });
    this.watchers.set(runId, { session, stopListening: off });
  }

  private detachWatcher(runId: string): RevisionWatcher | null {
    this.revisionTurnActive.delete(runId);
    const watcher = this.watchers.get(runId);
    if (watcher) {
      watcher.stopListening();
      this.watchers.delete(runId);
      return watcher;
    }
    return null;
  }

  private async pauseRevisionWatcherForApply(runId: string): Promise<RevisionWatcher | null> {
    const watcher = this.watchers.get(runId) ?? null;
    if (watcher) this.detachWatcher(runId);
    await this.revisionRescans.get(runId)?.catch(() => undefined);
    return watcher;
  }

  private resumeRevisionWatcherAfterApplyFailure(runId: string, watcher: RevisionWatcher | null): void {
    if (!watcher || this.disposed) return;
    const run = this.deps.store.get(runId);
    if (!run || run.status !== 'awaiting-review') return;
    this.attachRevisionWatcher(runId, watcher.session);
  }

  /** 蒸馏会话又完成了一轮对话 → 重扫 staging,提案有效则刷新,无效保留旧版 + error。 */
  private async rescanProposal(runId: string): Promise<void> {
    const run = this.mustGet(runId);
    const scan = await this.deps.staging.scan(runId);
    const candidate = scan.candidates.length === 1 ? scan.candidates[0] : null;
    if (!candidate) {
      await this.update(run, {
        error:
          scan.candidates.length === 0
            ? 'the last turn removed the skill directory — previous proposal kept'
            : `expected exactly one skill directory, got ${scan.candidates.length}`,
      });
      return;
    }
    const verdict = validateProposal({
      dirName: candidate.dirName,
      files: candidate.files,
      violations: candidate.violations,
    });
    if (!verdict.ok) {
      await this.update(run, { error: verdict.reason });
      return;
    }
    if (verdict.needsRename) {
      try {
        await this.deps.staging.renameProposalDir(candidate.absPath, verdict.skillName);
      } catch (err) {
        await this.update(run, { error: `rename proposal dir failed: ${String(err)}` });
        return;
      }
    }
    // 修订可能把提案改名到本地已装 skill 上 —— 与首次扫描同责,命中即个人上下文
    // (Codex review:此前 rescan 路径漏了这道 improved-local-skill 检查)。
    const improvedLocalSkill = (await this.findInstalledSkillDir(verdict.skillName)) != null;
    await this.update(run, {
      skillName: verdict.skillName,
      proposalFiles: candidate.files.map((f) => f.relPath),
      proposalFingerprint: computeProposalFingerprint(candidate.files),
      reviewedProposalFingerprint: undefined,
      reviewTargetFingerprint: undefined,
      redactionWarnings: verdict.redactionWarnings,
      error: undefined,
      ...(improvedLocalSkill ? { usedSessionEvidence: true } : {}),
    });
  }

  /**
   * app 重启后蒸馏会话被 renderer 侧 resume 重建时,重挂观察器
   * (index.ts 订阅 maker session:created 调进来)。
   */
  notifySessionAlive(session: LearnSessionLike): void {
    void this.deps.store.load().then(() => {
      // load() 的 await 期间可能发生登出/切账号:dispose 之后再 attach 的 watcher
      // 不在 dispose 的清理范围内,会带着旧依赖继续观察(Codex review)。
      if (this.disposed) return;
      const run = this.deps.store
        .list()
        .find((r) => r.sessionId === session.id && r.status === 'awaiting-review');
      if (run) this.attachRevisionWatcher(run.runId, session);
    });
  }

  // ── 审查动作 ──────────────────────────────────────────────────────────────

  async getProposalDiff(runId: string): Promise<{ targetExists: boolean; targetPath?: string; changes: FileChange[] }> {
    await this.deps.store.load();
    const run = this.mustGet(runId);
    if (run.status !== 'awaiting-review' || !run.skillName) {
      throw new LearnError('LEARN_INVALID_STATE', `run ${runId} has no reviewable proposal (${run.status})`);
    }
    const proposalDir = this.proposalDirOf(run);
    if (!proposalDir || !(await this.deps.dirExists(proposalDir))) {
      throw new LearnError('LEARN_INVALID_STATE', 'proposal directory is gone');
    }
    const installedDir = await this.findInstalledSkillDir(run.skillName);
    const targetExists = installedDir != null;
    const targetFingerprint = await this.computeCombinedTargetFingerprint(run.skillName);
    // diff 面板展示的是"剥除后的提案 vs 旧目录"(Codex review ×2):排除路径在
    // 提案侧一定不会被安装(apply 前剥除),但旧目录里已有的同名文件会随整目录
    // 替换一起消失 —— 删除必须让用户看见:
    //   added(仅提案侧)   → 不展示(装不进去的噪声)
    //   removed(仅旧侧)   → 保留(真的会被删)
    //   modified(两侧都有)→ 转 removed 展示(提案侧剥除后,最终效果是删旧文件)
    // skip 谓词分侧(Codex review ×3):
    //   新侧(提案):排除树目录级剪枝 + 超上限单文件不 hash 不读 —— 注定装不进,
    //     为它做全量流式 hash 只会把 main 进程挂住。
    //   旧侧(安装目录):只剪排除树(其删除由 computeExcludedOldSideRemovals 以
    //     摘要形态补回);**不能**按尺寸跳过 —— 超大旧文件也会随整目录替换被删,
    //     跳过它 = 用户看不见的删除。它超 1MB 会走 isBinary 摘要,不读内容。
    const skipNew = (rel: string, size: number | null): boolean =>
      isExcludedProposalPath(rel) || (size !== null && size > MAX_PROPOSAL_TOTAL_BYTES);
    const skipOld = (rel: string): boolean => isExcludedProposalPath(rel);
    const changes = (await this.deps.computeDiff(installedDir, proposalDir, { skipOld, skipNew })).flatMap(
      (c): FileChange[] => {
        if (!isExcludedProposalPath(c.path)) return [c];
        if (c.kind === 'removed') return [c];
        if (c.kind === 'modified') return [{ ...c, kind: 'removed', newContent: '', newSize: 0 }];
        return [];
      },
    );
    // computeDiff 会按 package ignore 跳过旧目录里的排除路径;但 apply 是整目录
    // 替换 + 剥除提案侧噪声,旧目录里的 .env/node_modules/AGENTS.md 等都会消失。
    // 这里补成 removed,保证用户审查到所有会被删除的旧侧内容(Codex review)。
    if (installedDir && this.deps.computeExcludedOldSideRemovals) {
      const existingPaths = new Set(changes.map((c) => c.path));
      for (const c of await this.deps.computeExcludedOldSideRemovals(installedDir, proposalDir)) {
        if (existingPaths.has(c.path)) continue;
        changes.push(c);
        existingPaths.add(c.path);
      }
      changes.sort((a, b) => a.path.localeCompare(b.path));
    }
    // 静默登记(不 bump updatedAt、不广播):update 的广播会让打开着的面板按
    // updatedAt 重拉 diff → 又触发登记 → 自触发循环,每圈都重 hash 提案与目标
    // (Codex review ×2)。审查登记是纯 bookkeeping,不是用户可见的状态变化。
    await this.updateSilent(run.runId, {
      reviewedProposalFingerprint: run.proposalFingerprint,
      reviewTargetFingerprint: targetFingerprint,
    });
    return { targetExists, ...(installedDir ? { targetPath: installedDir } : {}), changes };
  }

  async apply(runId: string): Promise<ApplyProposalResult> {
    return this.runReviewAction(runId, () => this.applyLocked(runId));
  }

  private async applyLocked(runId: string): Promise<ApplyProposalResult> {
    await this.deps.store.load();
    this.assertNotDisposedForReview(runId);
    let run = this.mustGet(runId);
    if (run.status !== 'awaiting-review' || !run.skillName) {
      throw new LearnError('LEARN_INVALID_STATE', `run ${runId} is not awaiting review (${run.status})`);
    }
    // 修订回合进行中拒绝 apply(Codex review):冻结只能挡扫描后的写入,挡不住
    // "回合已改写、尚未 done"的点击前写入 —— 此时 diff 面板展示的还是旧内容。
    if (this.revisionTurnActive.has(runId)) {
      throw new LearnError('LEARN_BUSY', 'a revision turn is still running — wait for it to finish, then review the refreshed proposal');
    }
    const pausedWatcher = await this.pauseRevisionWatcherForApply(runId);
    let frozenDir: string | null = null;
    let releaseSkillLock: (() => void) | null = null;
    let applied = false;
    try {
      this.assertNotDisposedForReview(runId);
      run = this.mustGet(runId);
      if (run.status !== 'awaiting-review' || !run.skillName) {
        throw new LearnError('LEARN_INVALID_STATE', `run ${runId} is not awaiting review (${run.status})`);
      }

      // apply 时先冻结再校验(review 修正 ×2):蒸馏会话在 awaiting-review 期间仍
      // 开放,不仅点击瞬间 staging 可能已被改动,还存在"扫描后、落盘前"的迟到写入
      // (修订回合尚未结束就点应用 —— TOCTOU)。freezeProposal 用原子 rename 把
      // 提案目录挪出会话可写范围,此后的写入物理上进不了本次安装;校验以冻结副本
      // 为准,不过直接拒绝并放回,用户可继续对话迭代。
      const scan = await this.deps.staging.scan(runId);
      this.assertNotDisposedForReview(runId);
      if (scan.candidates.length !== 1) {
        throw new LearnError('LEARN_INVALID_STATE', 'proposal directory is gone or ambiguous — review the latest state first');
      }
      const candidate = scan.candidates[0];
      frozenDir = await this.deps.staging.freezeProposal(runId, candidate.dirName);
      const collected = await this.deps.staging.collectProposal(frozenDir);
      this.assertNotDisposedForReview(runId);
      const verdict = validateProposal({
        dirName: candidate.dirName,
        files: collected.files,
        violations: collected.violations,
      });
      if (!verdict.ok) {
        throw new LearnError('LEARN_INVALID_STATE', `proposal is no longer valid: ${verdict.reason}`);
      }
      // 指纹比对:冻结副本必须与最后一次扫描通过(= 用户可审查到)的内容一致。
      // turn-active 门之外的兜底 —— 覆盖"回合刚发起、事件尚未到达"的窗口与任何
      // 非会话来源的 staging 篡改(Codex review:reviewed == installed 的最后一环)。
      if (
        run.proposalFingerprint &&
        computeProposalFingerprint(collected.files) !== run.proposalFingerprint
      ) {
        throw new LearnError('LEARN_INVALID_STATE', 'proposal changed after the last review — reopen the proposal to see the latest content');
      }
      if (verdict.needsRename) {
        frozenDir = await this.deps.staging.renameProposalDir(frozenDir, verdict.skillName);
      }
      if (verdict.skillName !== run.skillName) {
        run = await this.update(run, { skillName: verdict.skillName });
      }
      releaseSkillLock = this.acquireSkillApplyLock(verdict.skillName);
      // 必须先经 getProposalDiff 审查(reviewed 指纹已登记)且与当前提案一致。
      // 只查"已定义且不等"会留一个窗:重扫刚把 reviewed 清空、面板还没刷新完,
      // 这时点 apply 装的是没人看过的新内容(收严 Codex 的初版)。
      if (!run.reviewedProposalFingerprint || run.reviewedProposalFingerprint !== run.proposalFingerprint) {
        throw new LearnError('LEARN_INVALID_STATE', 'proposal changed after the last review — reopen the proposal to see the latest content');
      }
      if (run.reviewTargetFingerprint !== undefined) {
        const currentTargetFingerprint = await this.computeCombinedTargetFingerprint(verdict.skillName);
        if (currentTargetFingerprint !== run.reviewTargetFingerprint) {
          throw new LearnError('LEARN_INVALID_STATE', 'target skill changed after the last review — reopen the proposal to review the latest diff');
        }
      }
      // 最终名命中本地已装 skill ⇒ 个人上下文(与首扫/rescan 同责;点击前最后
      // 一轮修订可能改了名而 watcher 尚未跑到,这里以冻结副本的最终名兜底)。
      if (!run.usedSessionEvidence) {
        const improvedLocalSkill = (await this.findInstalledSkillDir(verdict.skillName)) != null;
        this.assertNotDisposedForReview(runId);
        if (improvedLocalSkill) run = await this.update(run, { usedSessionEvidence: true });
      }
      const provenance: LearnProvenance = {
        method: 'learn',
        sourceKind: run.sourceKind,
        ...(run.hubSlug ? { sourceRef: `${run.hubCatalogScope ?? 'market'}:${run.hubSlug}` } : {}),
        usedSessionEvidence: run.usedSessionEvidence,
        personal: run.usedSessionEvidence, // 硬规则:含 session 证据 ⇒ personal,不可配置
        learnedAt: Math.floor(this.now() / 1000),
        runId: run.runId,
      };
      this.assertNotDisposedForReview(runId);
      const result = await this.deps.applyProposal({
        proposalDir: frozenDir,
        // 用重校验后的 verdict 名(string 且为冻结副本的真实值;run.skillName 经
        // update 重赋值后类型收窄丢失,语义上两者已一致)
        skillName: verdict.skillName,
        provenance,
      });
      applied = true;
      this.detachWatcher(runId);
      await this.deps.staging.cleanup(runId);
      await this.update(run, { status: 'applied' });
      return result;
    } finally {
      releaseSkillLock?.();
      // 失败路径(校验拒绝 / applyProposal 抛错回滚到冻结位)把提案放回 staging。
      if (!applied) {
        if (frozenDir) await this.deps.staging.unfreezeProposal(frozenDir, runId).catch(() => undefined);
        this.resumeRevisionWatcherAfterApplyFailure(runId, pausedWatcher);
      }
    }
  }

  async discard(runId: string): Promise<void> {
    return this.runReviewAction(runId, async () => {
      await this.deps.store.load();
      const run = this.mustGet(runId);
      if (run.status !== 'awaiting-review') {
        throw new LearnError('LEARN_INVALID_STATE', `run ${runId} is not awaiting review (${run.status})`);
      }
      const watcher = this.detachWatcher(runId);
      await watcher?.session.abort().catch(() => undefined);
      await this.revisionRescans.get(runId)?.catch(() => undefined);
      await this.deps.staging.cleanup(runId);
      await this.update(this.mustGet(runId), { status: 'discarded' });
    });
  }

  private async runReviewAction<T>(runId: string, action: () => Promise<T>): Promise<T> {
    this.acquireReviewLock(runId);
    const actionPromise = action();
    this.reviewActionPromises.set(
      runId,
      actionPromise.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await actionPromise;
    } finally {
      this.reviewActionLocks.delete(runId);
      this.reviewActionPromises.delete(runId);
    }
  }

  /** apply/discard 互斥:同一 run 的另一审查动作还在 await 时直接拒 LEARN_BUSY
   *  (Codex review:discard 清 staging 与 apply 落盘并发会留"已放弃却已安装")。 */
  private acquireReviewLock(runId: string): void {
    if (this.reviewActionLocks.has(runId)) {
      throw new LearnError('LEARN_BUSY', `another review action for run ${runId} is in progress`);
    }
    this.reviewActionLocks.add(runId);
  }

  /** final-switch 共享锁(skillhub/installLock):同名 skill 的市场安装/卸载
   *  进行中同样拒 LEARN_BUSY,不再只对 learn 自己的 apply 互斥。 */
  private acquireSkillApplyLock(skillName: string): () => void {
    const release = tryAcquireSkillInstallLock(skillName, 'learn-apply');
    if (release) return release;
    const owner = getSkillInstallLockOwner(skillName);
    const message = owner === 'market-install' || owner === 'market-uninstall'
      ? `a market ${owner === 'market-install' ? 'install' : 'uninstall'} of ${skillName} is in progress — retry after it finishes`
      : `another learn proposal is applying ${skillName}`;
    throw new LearnError('LEARN_BUSY', message);
  }

  private assertNotDisposedForReview(runId: string): void {
    if (!this.disposed) return;
    throw new LearnError('LEARN_INVALID_STATE', `learn controller disposed while reviewing ${runId}`);
  }

  async cancel(runId: string): Promise<void> {
    await this.deps.store.load();
    const run = this.mustGet(runId);
    if (run.status !== 'collecting' && run.status !== 'distilling') {
      throw new LearnError('LEARN_INVALID_STATE', `run ${runId} is not cancellable (${run.status})`);
    }
    let rejectTurn: ((err: Error) => void) | undefined;
    if (this.active?.runId === runId) {
      void this.active.session.abort().catch(() => undefined);
      rejectTurn = this.active.rejectTurn;
    }
    this.clearActive(runId);
    this.detachWatcher(runId);
    // 先置 cancelled 再 reject —— pipeline 的 catch 按当前状态决定是否转 failed,
    // 反序会出现瞬时 failed 广播 + 双重 cleanup 的竞态。
    await this.update(run, { status: 'cancelled' });
    rejectTurn?.(new Error('cancelled by user'));
    await this.deps.staging.cleanup(runId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const aborts: Array<Promise<void>> = [];
    let rejectActiveTurn: ((err: Error) => void) | undefined;
    if (this.active) {
      // 登出/切账号时活跃蒸馏必须真正中止(Codex review):只摘监听不 abort 的话,
      // bypassPermissions 的模型进程会带着旧账号状态继续跑、烧 token;pipeline
      // promise 也会永久 pending。abort + rejectTurn 与 cancel() 同语义。
      aborts.push(this.active.session.abort().catch(() => undefined));
      rejectActiveTurn = this.active.rejectTurn;
      this.active.stopListening?.();
      if (this.active.timeoutHandle) clearTimeout(this.active.timeoutHandle);
      this.active = null;
    }
    for (const watcher of this.watchers.values()) {
      // awaiting-review 后的修订 turn 只由 watcher 观察,不在 this.active 里。
      // 切账号/登出时必须中止这些会话,否则模型会继续用旧 controller deps 写
      // staging、消耗 token(Codex review)。
      aborts.push(watcher.session.abort().catch(() => undefined));
      watcher.stopListening();
    }
    this.watchers.clear();
    const pendingReviewWork = [
      ...this.revisionRescans.values(),
      ...this.reviewActionPromises.values(),
    ];
    await Promise.allSettled([this.cancelInFlightRunsForDispose(), ...aborts, ...pendingReviewWork]);
    rejectActiveTurn?.(new Error('learn controller disposed'));
  }

  private async cancelInFlightRunsForDispose(): Promise<void> {
    await this.deps.store.load().catch(() => undefined);
    for (const run of this.deps.store.list()) {
      if (run.status === 'collecting' || run.status === 'distilling') {
        await this.cancelInFlightRunForDispose(run);
      }
    }
  }

  private async cancelInFlightRunForDispose(run: LearnRunPublic): Promise<void> {
    const current = this.deps.store.get(run.runId) ?? run;
    if (current.status !== 'collecting' && current.status !== 'distilling') return;
    await this.update(current, {
      status: 'cancelled',
      error: 'learn host disposed (account switch)',
    });
    await this.deps.staging.cleanup(current.runId);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private clearActive(runId: string): void {
    if (this.active?.runId !== runId) return;
    this.active.stopListening?.();
    if (this.active.timeoutHandle) clearTimeout(this.active.timeoutHandle);
    this.active = null;
  }

  private async fail(run: LearnRunPublic, error: string | Error, assistantText?: string): Promise<void> {
    await this.deps.staging.cleanup(run.runId);
    const projection = error instanceof Error ? error as LearnTerminalError : undefined;
    await this.update(run, {
      status: 'failed',
      error: error instanceof Error ? error.message : error,
      ...(projection?.reason ? { errorReason: projection.reason } : {}),
      ...(projection?.toolLoop ? { toolLoop: projection.toolLoop } : {}),
      ...(assistantText ? { assistantText } : {}),
    });
  }

  private async update(
    run: LearnRunPublic,
    patch: Partial<LearnRunPublic> & { status?: LearnRunStatus },
  ): Promise<LearnRunPublic> {
    // 竞态保护(Codex review):cancel()/fail() 可能在管线某个 await 期间落了
    // 终态,而管线手里还握着过期快照 —— 一律以 store 当前值为基底,且终态
    // run 不允许被非终态 patch 复活(cancelled 只能保持 cancelled)。
    const current = this.deps.store.get(run.runId) ?? run;
    if (LEARN_TERMINAL_STATUSES.includes(current.status)) {
      const nextStatus = patch.status ?? current.status;
      if (nextStatus !== current.status || !LEARN_TERMINAL_STATUSES.includes(nextStatus)) {
        return current;
      }
      if (patch.status === undefined) return current;
    }
    const next: LearnRunPublic = { ...current, ...patch, updatedAt: this.now() };
    await this.deps.store.put(next);
    this.deps.broadcast({ type: 'state-changed', run: next });
    return next;
  }

  /** 纯 bookkeeping 写入:不 bump updatedAt、不广播(审查指纹登记专用 ——
   *  广播会让面板的 updatedAt 依赖自触发重拉,见 getProposalDiff)。终态
   *  run 不写(与 update 的终态保护同界)。 */
  private async updateSilent(
    runId: string,
    patch: Partial<Pick<LearnRunPublic, 'reviewedProposalFingerprint' | 'reviewTargetFingerprint'>>,
  ): Promise<void> {
    const current = this.deps.store.get(runId);
    if (!current || LEARN_TERMINAL_STATUSES.includes(current.status)) return;
    await this.deps.store.put({ ...current, ...patch });
  }
}

function extractTerminalError(data: unknown): LearnTerminalError {
  const record = data && typeof data === 'object'
    ? data as { message?: unknown; reason?: unknown; toolLoop?: unknown }
    : undefined;
  const error = new Error(
    record?.message !== undefined && record.message !== null
      ? String(record.message)
      : String(data),
  ) as LearnTerminalError;
  if (typeof record?.reason === 'string') error.reason = record.reason;
  const toolLoop = parseToolLoopErrorDetails(record?.toolLoop);
  if (toolLoop) error.toolLoop = toolLoop;
  return error;
}

function isRevisionTurnActivityEvent(ev: { type: string; data?: unknown }): boolean {
  if (ev.type === 'status') {
    const data = ev.data as { isRunning?: unknown } | null | undefined;
    return data?.isRunning === true;
  }
  return (
    ev.type === 'text' ||
    ev.type === 'thinking' ||
    ev.type === 'tool_use' ||
    ev.type === 'tool_result' ||
    ev.type === 'tool_result_full' ||
    ev.type === 'agent_task_update' ||
    ev.type === 'image' ||
    ev.type === 'interaction_request' ||
    ev.type === 'compact_boundary'
  );
}
