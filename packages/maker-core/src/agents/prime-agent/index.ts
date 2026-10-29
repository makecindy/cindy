/**
 * PrimeAgent —— Prime Agent(Prime Intlect 的开源 RLM coding agent, Rust 构建)接入。
 *
 * 形态: spawn `prime-agent --mode rpc`(JSONL/stdio), translator 把 Prime Agent 事件
 * 映射进统一 `AgentEvent`。协议权威定义在 Prime Agent 源码
 * `crates/pa-daemon/src/rpc/{protocol,mod,commands,prompt_commands,model_commands,
 * session_commands}.rs`。
 *
 * ## 与 pi 适配层的结构差异(为什么这个文件比 pi/index.ts 小一个数量级)
 *
 * Prime Agent 的 `--mode rpc` 与 pi 的 `--mode rpc` 协议高度同构, 但有三整块不需要:
 *
 * 1. **模型通道**: Prime Agent 自带 7 个 provider 与内联 API 密钥
 *    (bigmodel / minimax / zhipu-direct / step / deepseek-direct / sensenova / magpie),
 *    不接 Cindy 的模型通道 —— 所以 pi 那套 `writeModelsJson`
 *    (packages/maker-core/src/agents/pi/index.ts:2263-2626)整块不写。
 *    本文件只做「Cindy 的 model id → Prime Agent 目录里的 (provider, id)」翻译,
 *    用 `get_available_models` 查表, 不注入任何凭证。
 * 2. **权限审批**: 用户明确不需要权限审批。Prime Agent 的 RPC 协议里也没有
 *    `extension_ui_request` 权限子协议 —— pi 那套注入 cindy-bridge 扩展 +
 *    权限子协议整块不写。`setInteractionResolver` 仍然实现(接口要求), 但
 *    Prime Agent 永远不会调它。
 * 3. **MCP 网关**: 同上, 不注入桥接扩展就没有 MCP 工具面, 不写网关。
 *
 * ## 启动握手
 *
 * `set_auto_compaction{enabled:true}` → `get_state` 作 ready 门禁。
 * 前者失败只 warn(它会往磁盘写 settings, 只读目录下不该阻断启动);
 * 后者失败直接抛 —— 拿不到合法 session 身份就不算启动成功。
 *
 * ## turn 收口
 *
 * 见 `translator.ts` 文件头: Prime Agent 只有 `agent_end`, 每个 `agent_end`
 * (含 abort / 启动失败兜底路径)都恰好对应一次 `run_loop` 的退出, 因此合成为
 * `agent_settled` 是语义等价而非近似。
 */

import { promises as fs } from 'node:fs';

import {
  AgentStartupCleanupPendingError,
  AgentStartupStoppedError,
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type StartSessionOptions,
} from '../base-agent.js';
import { NotSupportedError } from '../../types/capabilities.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import type { Capabilities, ManualCompactResult } from '../../types/capabilities.js';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import type { AgentKind, Effort, UserContentBlock, UserMessage } from '../../types/common.js';

import { PrimeAgentRpcProcess, type PrimeAgentRpcEvent } from './rpc-client.js';
import { createPrimeAgentStdioTransport } from './transport.js';
import {
  PRIME_AGENT_KIND,
  PRIME_AGENT_SOURCE,
  createPrimeAgentTranslateContext,
  disposePrimeAgentTranslateContext,
  markPrimeAgentHostAbortRequested,
  markPrimeAgentHostTurnStartPending,
  rollbackPrimeAgentHostAbortRequest,
  rollbackPrimeAgentHostTurnStart,
  translatePrimeAgentEvent,
  usageSnapshotOf,
} from './translator.js';

/** Prime Agent RPC 命令的超时。`compact` 会调 LLM 生成摘要, 用事件刷新 idle 计时。 */
const RPC_TIMEOUT_MS = 60_000;
const RPC_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Prime Agent `set_thinking_level` 的合法线名
 * (crates/pa-daemon/src/rpc/model_commands.rs:159)。
 */
const PRIME_AGENT_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/** Cindy `Effort` → Prime Agent thinking level。`ultra` 无对应档位, 直接拒绝。 */
function primeAgentThinkingLevelFor(effort: Effort): string {
  if (effort === 'ultra') {
    throw new NotSupportedError('effort', {
      supported: false,
      reason: 'sdk-missing',
      message: 'Prime Agent has no thinking level above "max".',
    });
  }
  return effort;
}

/** Prime Agent `get_available_models` 目录里的一条。 */
interface PrimeAgentCatalogModel {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
  contextWindow?: unknown;
}

/**
 * `get_state.data` 里 translator / handle 需要的字段子集
 * (crates/pa-daemon/src/rpc/commands.rs:281-341)。
 */
interface PrimeAgentStateData {
  sessionId?: unknown;
  sessionFile?: unknown;
  sessionName?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  isStreaming?: unknown;
  messageCount?: unknown;
  autoCompactionEnabled?: unknown;
}

/**
 * Prime Agent 的 `compact` 应答 `CompactionResult`
 * (crates/pa-daemon/src/rpc/commands.rs:430-442 → `compaction_result_value`)。
 */
interface PrimeAgentCompactionData {
  tokensBefore?: unknown;
  estimatedTokensAfter?: unknown;
  summary?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * session 身份 fail-closed 校验(与 pi 的 `validateSdkSessionId` 同语义):
 * Prime Agent 的输出可能因损坏/异常回传任意值 → 跨会话误路由。非空字符串 +
 * 长度上限 + 无控制字符, 不满足则拒绝启动。
 */
function validatePrimeAgentSessionId(value: string, field: string): string {
  if (value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new Error(
      `prime-agent get_state returned an unsafe ${field} (empty, overlong, or containing control characters) — refusing to start`,
    );
  }
  return value;
}

/** 从 `get_state.data.model` 取模型 id(`pa_types::ai::Model` 的 `id` 字段)。 */
function primeAgentModelIdOf(data: PrimeAgentStateData): string {
  const model = data.model;
  if (isRecord(model) && typeof model.id === 'string' && model.id.length > 0) return model.id;
  return '';
}

/** Cindy 的 `UserContentBlock` 图片 → Prime Agent 的 `{type:'image', data, mimeType}`。 */
async function primeAgentImagePayload(
  block: Extract<UserContentBlock, { type: 'image' }>,
): Promise<Record<string, unknown> | null> {
  // Prime Agent 的 `command_images` 丢掉没有 payload data 或 mimeType 的条目
  // (crates/pa-daemon/src/rpc/protocol.rs:109-127), 所以缺任一项就整张跳过。
  const mimeType = block.mimeType ?? 'image/png';
  try {
    const bytes = await fs.readFile(block.path);
    return { type: 'image', data: bytes.toString('base64'), mimeType };
  } catch {
    return null;
  }
}

/** 把 `UserMessage` 摊成 Prime Agent prompt 的 `message` + `images`。 */
async function buildPrimeAgentPrompt(message: UserMessage): Promise<{
  text: string;
  images: Record<string, unknown>[];
}> {
  if (typeof message.content === 'string') {
    return { text: message.content, images: [] };
  }
  const texts: string[] = [];
  const images: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      const payload = await primeAgentImagePayload(block);
      if (payload) images.push(payload);
    }
    // file / mention 块不进 prompt 正文: Prime Agent 自己按 cwd 读文件。
  }
  return { text: texts.join('\n\n'), images };
}

export class PrimeAgent extends BaseAgent {
  readonly kind: AgentKind = PRIME_AGENT_KIND;
  readonly capabilities: Capabilities;
  /**
   * 启动失败但进程关闭未确认的记录(按 business sessionId 索引)。
   *
   * `--mode rpc` 子进程持有工作目录; 关闭未确认就不能把这次启动记成「尚未启动」,
   * 否则 Maker 会释放目录租约而进程可能还活着
   * (docs/dev-rules/maker-core-and-agent-behavior.md「启动失败与工作目录占用」)。
   * 下一次同 session 的 startSession 先重试确认退出, 绝不直接再 spawn 一个。
   */
  private readonly failedStartupCleanups = new Map<string, {
    close: () => Promise<void>;
    confirmStopped: () => void;
  }>();

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(PrimeAgent.baseCapabilities());
  }

  /**
   * Prime Agent 没有 agent 级共享子进程(每个 session 一个 `--mode rpc` 进程,
   * 由 handle.close() 各自回收), 所以这里无需像 Codex 那样 shutdown 共享 host。
   * 只把仍未确认退出的失败启动再收一次口。
   */
  override async dispose(): Promise<void> {
    const snapshot = [...this.failedStartupCleanups.entries()];
    await Promise.allSettled(snapshot.map(([key]) => this.retryFailedStartupCleanup(key)));
  }

  /** 重试确认一次未收口的启动失败进程。仍未确认时保留记录, 不覆盖原始错误。 */
  private async retryFailedStartupCleanup(key: string): Promise<void> {
    const entry = this.failedStartupCleanups.get(key);
    if (!entry) return;
    try {
      await entry.close();
    } catch {
      // 关闭仍未确认: 保留记录等下次重试。旧隔离进程的清理失败不能被新一轮
      // 「尚未启动」的状态覆盖。
      return;
    }
    this.failedStartupCleanups.delete(key);
    entry.confirmStopped();
  }

  private static baseCapabilities(): Capabilities {
    return {
      switchModel: { supported: true },
      // Prime Agent 自带 provider 目录, 不挂 Cindy 的模型清单。启动时 host 若需要
      // 展示选择面, 应经 handle 查 `get_available_models`(见 setModel 的实现)。
      availableModels: [],
      hasFastMode: false,
      effort: { supported: true },
      effortLevels: [
        { id: 'minimal', displayName: 'Minimal' },
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
        { id: 'xhigh', displayName: 'Extra High' },
        { id: 'max', displayName: 'Maximum' },
      ],
      // Prime Agent 的 reasoningDisplay 只由 thinking level 决定, 没有独立的
      // "summarized / full" 开关。
      reasoningDisplay: ['off'],
      // 权限审批整块不做(用户明确不需要): Prime Agent 的 RPC 协议也没有权限子协议。
      // 不声明任何 permissionModes, UI 因此不渲染权限选择器。
      permissionModes: [],
      setPermissionModeMidSession: {
        supported: false,
        reason: 'not-implemented',
        message: 'Prime Agent runs with its own tool permissions; Cindy does not gate them.',
      },
      multimodal: {
        text: { supported: true },
        // Prime Agent prompt 的 `images` 走 base64 内联
        // (crates/pa-daemon/src/rpc/protocol.rs:109-127)。
        image: { supported: true },
        // file / mention 块不注入 prompt; Prime Agent 自己按 cwd 读文件。
        file: { supported: false, reason: 'not-implemented' },
      },
      fork: { supported: false, reason: 'not-implemented' },
      rewind: { supported: false, reason: 'not-implemented' },
      abort: { supported: true },
      // Prime Agent 的 `steer` 命令把消息压进 agent 的 steering lane
      // (crates/pa-daemon/src/rpc/prompt_commands.rs:210-234), 与同 turn 插话同语义。
      sameTurnSteer: { supported: true },
      memory: {
        supported: { supported: false, reason: 'not-implemented' },
        displayName: 'Prime Agent Auto Memory',
        description: 'Prime Agent keeps its own refinement history; Cindy memory is not wired.',
        stage: 'experimental',
        defaultEnabled: false,
        resettable: false,
      },
      extraDirs: { supported: false, reason: 'not-implemented' },
      // Prime Agent 原生 `export_html` RPC(自带渲染器, 离线、无网关)。
      sessionHtmlExport: { supported: true },
      // Prime Agent 原生 `compact` RPC(可带聚焦指令, 调 LLM 生成摘要)。
      manualCompact: { supported: true },
    };
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const startupKey = opts.sessionId ?? '<anonymous>';
    // 上一次同 session 的失败启动若还留着未确认退出的进程, 先重试收口。
    await this.retryFailedStartupCleanup(startupKey);

    const binaryPath = this.deps.binaryPath;
    if (!binaryPath || binaryPath.trim().length === 0) {
      // 进程尚未创建: 按共享契约包成 AgentStartupStoppedError, Maker 释放目录租约。
      throw new AgentStartupStoppedError(
        new Error('prime-agent: binaryPath is required (host must provision the binary first)'),
      );
    }
    // 二进制缺失时早失败, 不要起一个必然起不来的进程再等超时。
    try {
      const stat = await fs.stat(binaryPath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch (cause) {
      throw new AgentStartupStoppedError(
        cause instanceof Error && cause.message === 'not a file'
          ? new Error(`prime-agent binary is not a file: ${binaryPath}`)
          : new Error(`prime-agent binary not found at ${binaryPath}`),
      );
    }

    const cwd = opts.workingDir;
    const args: string[] = ['--mode', 'rpc'];
    if (opts.resumeSessionId) {
      // `--resume` 的选择器可以是 sessionId 也可以是 session 文件路径
      // (crates/pa-cli/src/interactive_mode.rs:649-654)。
      args.push('--resume', opts.resumeSessionId);
    }
    if (cwd) args.push('--cwd', cwd);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) {
      args.push('--thinking', primeAgentThinkingLevelFor(opts.effort));
    }
    if (opts.userPrompt && opts.userPrompt.trim().length > 0) {
      // 用户级 system prompt 追加段, 顺序最末(优先级最高), 与 pi 的
      // `--append-system-prompt` 同位置语义。
      args.push('--append-system-prompt', opts.userPrompt);
    }

    let transport: ReturnType<typeof createPrimeAgentStdioTransport>;
    try {
      transport = createPrimeAgentStdioTransport({
        binaryPath,
        args,
        cwd: cwd || process.cwd(),
        env: this.buildSpawnEnv(opts),
        logger: this.deps.logger,
      });
    } catch (cause) {
      // spawn 同步失败(ENOENT / EACCES ...): 进程没有创建成功, 直接按「未启动」收口。
      throw new AgentStartupStoppedError(cause);
    }

    const queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const ctx = createPrimeAgentTranslateContext(this.deps.logger);
    if (typeof opts.contextWindowBudget === 'number' && opts.contextWindowBudget > 0) {
      ctx.workingContextWindow = opts.contextWindowBudget;
    }

    const logger = this.deps.logger;
    const proc = new PrimeAgentRpcProcess({
      transport,
      logger,
      onEvent: (event: PrimeAgentRpcEvent) => {
        translatePrimeAgentEvent(event, queue, ctx);
      },
      onExit: (info) => {
        // 进程退出: 收口事件流, 让 handle.events() 的消费者能退出循环。
        logger.warn('prime-agent process exited', { code: info.code, signal: info.signal });
        disposePrimeAgentTranslateContext(ctx);
        queue.end();
      },
      onDisconnect: (reason) => {
        logger.warn('prime-agent RPC disconnected', { reason });
      },
    });

    // ── 启动握手 ────────────────────────────────────────────────────────────
    // set_auto_compaction 会往磁盘写 settings(commands.rs:539-543), 只读目录下
    // 失败不该阻断启动 —— 记 warn 后继续。get_state 是硬门禁。
    try {
      const auto = await proc.request(
        { type: 'set_auto_compaction', enabled: true },
        { timeoutMs: RPC_STARTUP_TIMEOUT_MS },
      );
      if (!auto.success) {
        logger.warn('prime-agent set_auto_compaction refused', { error: auto.error });
      }
    } catch (error) {
      logger.warn('prime-agent set_auto_compaction failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let stateData: PrimeAgentStateData;
    let sessionId: string;
    let sessionFile: string | undefined;
    let model: string;
    let contextWindow: number;
    try {
      const state = await proc.request(
        { type: 'get_state' },
        { timeoutMs: RPC_STARTUP_TIMEOUT_MS },
      );
      if (!state.success) {
        throw new Error(`prime-agent get_state failed: ${state.error ?? 'unknown error'}`);
      }
      if (!isRecord(state.data)) {
        throw new Error('prime-agent get_state answered without a data object');
      }
      stateData = state.data as PrimeAgentStateData;
      // session 身份校验放在同一个 try 里: 拒绝一个不安全的身份时也必须回收进程,
      // 不能留一个孤儿 prime-agent 占着工作目录。
      sessionId = typeof stateData.sessionId === 'string'
        ? validatePrimeAgentSessionId(stateData.sessionId, 'sessionId')
        : '';
      sessionFile = typeof stateData.sessionFile === 'string'
        ? validatePrimeAgentSessionId(stateData.sessionFile, 'sessionFile')
        : undefined;
      model = primeAgentModelIdOf(stateData) || opts.model || '';
      contextWindow = primeAgentContextWindowOf(stateData);
    } catch (error) {
      // 启动失败: 必须回收已创建的进程, 不能留一个孤儿 prime-agent 占着工作目录。
      // 关闭**已确认**才抛 AgentStartupStoppedError(Maker 释放本次启动的目录租约);
      // 关闭未确认时按共享契约抛 AgentStartupCleanupPendingError 并保留
      // whenStopped, Maker 因此继续持有租约, 不会把「可能仍占用目录」的任务
      // 记成「尚未启动」。见 dev-rules「启动失败与工作目录占用」。
      let closeError: unknown = null;
      try {
        await proc.close();
      } catch (err) {
        closeError = err;
      }
      if (closeError) {
        let confirmStopped!: () => void;
        const whenStopped = new Promise<void>((resolve) => { confirmStopped = resolve; });
        this.failedStartupCleanups.set(startupKey, {
          close: () => proc.close(),
          confirmStopped,
        });
        throw new AgentStartupCleanupPendingError(
          'prime-agent startup failed and process cleanup remains unconfirmed: '
            + `${closeError instanceof Error ? closeError.message : String(closeError)}`,
          { cause: error, whenStopped },
        );
      }
      throw new AgentStartupStoppedError(error);
    }

    if (contextWindow > 0) ctx.contextWindow = contextWindow;
    let closed = false;
    /** 在途的宿主独占 RPC(手动压缩)计数 —— 运行时回收必须看得见。 */
    let pendingHostOperations = 0;
    /** Prime Agent 目录快照, setModel 时按 model id 反查 (provider, id)。 */
    let catalogModels: PrimeAgentCatalogModel[] = [];

    const refreshCatalog = async (): Promise<PrimeAgentCatalogModel[]> => {
      try {
        const response = await proc.request(
          { type: 'get_available_models' },
          { timeoutMs: RPC_STARTUP_TIMEOUT_MS },
        );
        if (response.success && isRecord(response.data)) {
          const models = (response.data as { models?: unknown }).models;
          if (Array.isArray(models)) {
            catalogModels = models.filter(isRecord) as PrimeAgentCatalogModel[];
          }
        }
      } catch (error) {
        logger.warn('prime-agent get_available_models failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return catalogModels;
    };

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // transport.close() 先 end(stdin): Prime Agent 的 RPC 模式把 stdin EOF 当
      // 优雅退出路径(settle 在飞 turn → drain 帧 → exit 0), Windows 上没有 SIGTERM
      // 可依赖(见 transport.ts 文件头)。
      await proc.close().catch((error) => {
        logger.warn('prime-agent close failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      queue.end();
    };

    const handle: AgentSessionHandle = {
      id: sessionId,
      agentKind: this.kind,
      model,

      events(): AsyncIterable<AgentEvent> {
        return queue;
      },

      getUsageSnapshot(): UsageSnapshot {
        return usageSnapshotOf(ctx);
      },

      setInteractionResolver(): void {
        // Prime Agent 的 RPC 协议没有权限 / 提问 / 计划审批子协议, 用户也明确
        // 不需要审批 —— 这个 resolver 永远不会被调用。保留空实现只为满足接口。
      },

      isTurnRunning(): boolean {
        return ctx.isStreaming;
      },

      hasPendingHostOperation(): boolean {
        return pendingHostOperations > 0;
      },

      async send(message: UserMessage): Promise<void> {
        if (closed || proc.isClosed) {
          throw new Error('prime-agent RPC is unavailable before prompt dispatch');
        }
        const turnToken = markPrimeAgentHostTurnStartPending(ctx);
        try {
          const { text, images } = await buildPrimeAgentPrompt(message);
          if (text.trim().length === 0 && images.length === 0) {
            throw new Error('prime-agent prompt requires a non-empty message');
          }
          const response = await proc.request(
            { type: 'prompt', message: text, ...(images.length > 0 ? { images } : {}) },
            { timeoutMs: RPC_TIMEOUT_MS },
          );
          if (!response.success) {
            throw new Error(`prime-agent prompt failed: ${response.error ?? 'unknown error'}`);
          }
        } catch (error) {
          // provider 未接受: 撤销待开始标记, 避免它吞掉后续真实 turn 的中止请求。
          rollbackPrimeAgentHostTurnStart(ctx, turnToken);
          throw error;
        }
      },

      async steer(message: UserMessage): Promise<void> {
        if (closed || proc.isClosed) {
          throw new Error('prime-agent RPC is unavailable before steer dispatch');
        }
        const { text, images } = await buildPrimeAgentPrompt(message);
        if (text.trim().length === 0 && images.length === 0) {
          throw new Error('prime-agent steer requires a non-empty message');
        }
        const response = await proc.request(
          { type: 'steer', message: text, ...(images.length > 0 ? { images } : {}) },
          { timeoutMs: RPC_TIMEOUT_MS },
        );
        if (!response.success) {
          throw new Error(`prime-agent steer failed: ${response.error ?? 'unknown error'}`);
        }
      },

      async abort(): Promise<void> {
        const abortToken = markPrimeAgentHostAbortRequested(ctx);
        try {
          const response = await proc.request(
            { type: 'abort' },
            { timeoutMs: RPC_TIMEOUT_MS },
          );
          if (!response.success) {
            throw new Error(`prime-agent abort failed: ${response.error ?? 'unknown error'}`);
          }
        } catch (error) {
          // abort 未被接受: 撤销请求标记, 防止旧标记把后续真实断流误判成主动停止。
          rollbackPrimeAgentHostAbortRequest(ctx, abortToken);
          throw error;
        }
      },

      async compactSession(instructions?: string): Promise<ManualCompactResult> {
        if (closed || proc.isClosed) {
          throw new Error('prime-agent RPC is unavailable before compact dispatch');
        }
        pendingHostOperations += 1;
        try {
          const response = await proc.request(
            {
              type: 'compact',
              ...(instructions && instructions.trim().length > 0
                ? { customInstructions: instructions }
                : {}),
            },
            {
              timeoutMs: RPC_TIMEOUT_MS,
              // compact 会调 LLM 生成摘要, 期间只有 compaction_* 事件; 用它们刷新
              // idle 计时, 否则长压缩会被误判成超时。
              refreshTimeoutOnEvent: (event) =>
                event.type === 'compaction_start' || event.type === 'compaction_end',
            },
          );
          const data = isRecord(response.data) ? (response.data as PrimeAgentCompactionData) : {};
          const tokensBefore = typeof data.tokensBefore === 'number' ? data.tokensBefore : undefined;
          const estimatedTokensAfter = typeof data.estimatedTokensAfter === 'number'
            ? data.estimatedTokensAfter
            : undefined;
          if (!response.success) {
            // Prime Agent 对「会话太短」答 success:false + 固定文案
            // (crates/pa-daemon/src/rpc/commands.rs:443-455)。这是良性空操作,
            // 不是压缩失败。
            const error = response.error ?? '';
            if (/too short to compact/i.test(error)) {
              return { noop: true };
            }
            throw new Error(`prime-agent compact failed: ${error || 'unknown error'}`);
          }
          return { ...(tokensBefore !== undefined ? { tokensBefore } : {}), estimatedTokensAfter };
        } finally {
          pendingHostOperations -= 1;
        }
      },

      async exportSessionHtml(outputPath?: string): Promise<string> {
        if (closed || proc.isClosed) {
          throw new Error('prime-agent RPC is unavailable before export dispatch');
        }
        const response = await proc.request(
          {
            type: 'export_html',
            ...(outputPath && outputPath.trim().length > 0 ? { outputPath } : {}),
          },
          { timeoutMs: RPC_TIMEOUT_MS },
        );
        if (!response.success) {
          throw new Error(`prime-agent export_html failed: ${response.error ?? 'unknown error'}`);
        }
        const written = isRecord(response.data) ? response.data.path : undefined;
        if (typeof written !== 'string' || written.length === 0) {
          throw new Error('prime-agent export_html answered without a path');
        }
        return written;
      },

      async setModel(
        nextModel: string,
        setOpts?: { providerId?: string | null },
      ): Promise<void> {
        if (closed || proc.isClosed) {
          throw new Error('prime-agent RPC is unavailable before set_model');
        }
        // Prime Agent 的 set_model 需要 (provider, modelId) 两元组
        // (crates/pa-daemon/src/rpc/model_commands.rs:26-50) —— Cindy 侧只有 model id,
        // 所以先查目录反查 provider。显式 providerId 优先。
        const models = catalogModels.length > 0 ? catalogModels : await refreshCatalog();
        const match = models.find((candidate) => {
          if (typeof candidate.id !== 'string' || candidate.id !== nextModel) return false;
          const provider = setOpts?.providerId;
          return !provider || candidate.provider === provider;
        });
        if (!match || typeof match.id !== 'string' || typeof match.provider !== 'string') {
          throw new Error(
            `prime-agent: model '${nextModel}' is not in Prime Agent's available catalog`
              + `${setOpts?.providerId ? ` for provider '${setOpts.providerId}'` : ''};`
              + ' Prime Agent manages its own providers and credentials.',
          );
        }
        const response = await proc.request(
          { type: 'set_model', provider: match.provider, modelId: match.id },
          { timeoutMs: RPC_TIMEOUT_MS },
        );
        if (!response.success) {
          throw new Error(`prime-agent set_model failed: ${response.error ?? 'unknown error'}`);
        }
      },

      async setEffort(effort: Effort): Promise<void> {
        if (closed || proc.isClosed) {
          throw new Error('prime-agent RPC is unavailable before set_thinking_level');
        }
        const level = primeAgentThinkingLevelFor(effort);
        const response = await proc.request(
          { type: 'set_thinking_level', level },
          { timeoutMs: RPC_TIMEOUT_MS },
        );
        if (!response.success) {
          throw new Error(
            `prime-agent set_thinking_level failed: ${response.error ?? 'unknown error'}`,
          );
        }
      },

      close,
    };

    // resume 场景: Prime Agent 可能已在启动时加载了历史, get_state 的 messageCount
    // 是恢复成功的直接证据, 记一行便于诊断。
    if (opts.resumeSessionId) {
      logger.info('prime-agent session resumed', {
        sessionId,
        messageCount: typeof stateData.messageCount === 'number' ? stateData.messageCount : null,
        sessionFile: sessionFile ?? null,
      });
    }
    // 预热模型目录: 下一次 setModel 不必等一次网络刷新。
    void refreshCatalog();

    return handle;
  }

  /**
   * spawn env。默认透传宿主环境 —— Prime Agent 自带 provider 与内联密钥, 凭证来自
   * 用户自己的 Prime Agent 配置, 不需要 Cindy 注入。
   *
   * 遥视默认关掉: Cindy 内嵌运行 Prime Agent 时, 用户没有对「Cindy 代为上报」
   * 表示过同意; 宿主环境已显式设置时尊重该值。
   */
  private buildSpawnEnv(opts: StartSessionOptions): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    if (!env.PRIME_AGENT_TELEMETRY) env.PRIME_AGENT_TELEMETRY = '0';
    if (!env.DO_NOT_TRACK) env.DO_NOT_TRACK = '1';
    // host 可通过 vendorOptions 覆盖(例如组织内统一开启)。
    const overrides = opts.vendorOptions?.primeAgentEnv;
    if (isRecord(overrides)) {
      for (const [key, value] of Object.entries(overrides)) {
        if (typeof value === 'string' || value === undefined) env[key] = value;
      }
    }
    return env;
  }
}

/** `get_state.data.model.contextWindow`(存在时) —— 用于上下文占用条。 */
function primeAgentContextWindowOf(data: PrimeAgentStateData): number {
  const model = data.model;
  if (!isRecord(model)) return 0;
  const value = model.contextWindow;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 供测试引用: Prime Agent 的合法 thinking level 全集。 */
export { PRIME_AGENT_THINKING_LEVELS, PRIME_AGENT_SOURCE };
