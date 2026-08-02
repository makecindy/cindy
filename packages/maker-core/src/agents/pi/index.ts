/**
 * PiAgent —— pi coding agent(earendil-works/pi)接入。
 *
 * 形态:spawn `pi --mode rpc`(JSONL/stdio,与 codex app-server 同构但协议薄得多),
 * translator 把 pi 事件映射进统一 AgentEvent。
 *
 * 凭证/模型:pi 本身无 Cindy 账号概念。PiAgent 在 host 注入的 pi 配置目录里生成
 * models.json,把 host 提供的模型清单(capabilityAdditions.availableModels)挂到
 * 单一 provider `cindy` 下,baseUrl = runtimeConfig.endpoint(Cindy 网关 /
 * 本地 proxy),apiKey 走 env 插值($CINDY_PI_API_KEY,由 auth.getAuthEnv 提供),
 * 凭证不落盘。
 *
 * system prompt:保留 pi 内置默认 prompt(工具用法/工程约定是 pi 自己调好的),
 * 经 `--append-system-prompt` 追加 runtimeConfig.systemPrompt(host 产品段)→
 * opts.userPrompt。前缀稳定(默认 prompt 静态),对齐缓存规则。
 *
 * P0 骨架已支持:流式文本/thinking/工具事件、steer、abort、set_model/set_thinking_level、
 * resume(switch_session)、usage/cost 快照。
 * SSH remote host 尚未支持；跨设备控制走 device-link，在目标设备本地启动 Pi。
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';

import {
  AgentNotAuthenticatedError,
  BaseAgent,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
  type PiExtraSpawnConfig,
  type PiNativeProviderSpec,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import {
  CINDY_BRIDGE_EXTENSION_FILENAME,
  CINDY_BRIDGE_EXTENSION_SOURCE,
} from './cindy-bridge-source.js';
import { normalizePiToolForAutoReview } from './auto-review-policy.js';
import {
  extractAutoReviewUserIntent,
  resolveAutoReviewDecision,
  type AutoReviewDecision,
} from '../shared/auto-review-decision.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import { buildMemoryScopeKey } from '../../memory/storage.js';
import type {
  Capabilities,
  ManualCompactResult,
  ModelDescriptor,
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type {
  AgentEvent,
  ForkSdkSessionOptions,
  ForkSdkSessionResult,
  InteractionResolver,
  RewindFilesResult,
  UsageSnapshot,
} from '../../types/events.js';
import type { MemoryResetResult, MemorySetResult, MemoryStatus } from '../../types/memory.js';
import type { AgentKind, Effort, UserMessage, UserContentBlock } from '../../types/common.js';
import type { ListAgentSkillsOptions, ListAgentSkillsResult } from '../../types/palette.js';
import { scanPiCustomizations } from './customization-scanner.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { resolveAgentCredentialMode } from '../credential-mode.js';
import { PiRpcProcess, type PiRpcEvent } from './rpc-client.js';
import {
  createPiTranslateContext,
  translatePiEvent,
  usageSnapshotOf,
  type PiTranslateContext,
} from './translator.js';
import {
  activePiHistoryFromTree,
  findPiTreeEntry,
  normalizePiSessionTree,
  piContextTokensFromTree,
  userDraftTextFromPiEntry,
} from './session-tree.js';

const PI_PROVIDER_ID = 'cindy';
// 既非 Cindy 网关(cindy/xd)也非订阅直连(openai/anthropic/xai)的 providerId = 显式 BYOM
// 路由,必须在本会话解析出的 nativeProviders 里;缺席时不得静默回落网关(见 startSession /
// setModel 的 fail-closed)。
const NON_BYOM_PROVIDER_IDS = new Set([PI_PROVIDER_ID, 'xd', 'openai', 'anthropic', 'xai']);
const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_SESSION_ID_ENV = 'CINDY_PI_SESSION_ID';
const PI_SESSION_TOKEN_ENV = 'CINDY_PI_SESSION_TOKEN';
const PI_MCP_BRIDGE_ENV = 'CINDY_PI_MCP_BRIDGE';
const PI_SECRET_ENV_NAMES_ENV = 'CINDY_PI_SECRET_ENV_NAMES';
/** 手动压缩 = 一次完整 LLM 摘要调用(大上下文 + 网关排队),远超默认 30s RPC 超时。 */
const PI_COMPACT_TIMEOUT_MS = 600_000;
/** 分支摘要同样可能触发一次完整 LLM 调用。 */
const PI_BRANCH_NAVIGATION_TIMEOUT_MS = 600_000;

/**
 * digest 分片 body 的**字节**上限(硬上限 8192,留 headroom)。存储层按 UTF-8 字节
 * 卡 hardShardBytes,故截断必须按字节而非字符 —— 否则中文摘要(每字 3 字节)会在
 * 字符数远未到阈值时就超字节硬上限,write 抛 shard-too-large 被吞掉,digest 静默丢失。
 */
const PI_DIGEST_MAX_BODY_BYTES = 7000;

/** 按 UTF-8 字节预算截断(码点安全,不切断多字节字符);超预算时补省略号。 */
function truncateToByteBudget(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '\n…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > budget) break;
    bytes += chBytes;
    out += ch;
  }
  return out + ellipsis;
}

/** 任意串 → memory slug 片段([a-z0-9-],截断)。 */
function slugifyForMemory(input: string, maxLen: number): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'anon').slice(0, maxLen);
}

/** 摘要正文 → 一行 description(折叠空白、去换行、截断)。 */
function oneLineDescription(text: string, maxLen: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line;
}

/**
 * NO_PROXY 兜底:pi 的模型请求打的是 Cindy 本地 compat proxy(loopback),bridge 的
 * MCP fetch 也是 localhost —— 用户设了全局 HTTP_PROXY 时这些请求不能进代理隧道。
 * 合并用户已有 NO_PROXY,同时吞并小写 no_proxy 并删除,防止大小写双份互相覆盖
 * (与 codex/env-builder.ts 同一策略)。
 */
function mergeLoopbackNoProxy(env: NodeJS.ProcessEnv): void {
  const existing = [env.NO_PROXY, env.no_proxy]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  env.NO_PROXY = Array.from(new Set([...existing, '127.0.0.1', 'localhost', '::1'])).join(',');
  delete env.no_proxy;
}

/** cindy Effort → pi thinking level(pi 无 ultra;cindy 无 off)。 */
function effortToPiThinkingLevel(effort: Effort): string {
  return effort === 'ultra' ? 'max' : effort;
}

/**
 * pi 的 RPC prompt 会**执行**扩展命令(实测:/plan 直接被 plan-mode 扩展吃掉,零 LLM
 * 请求)并展开 /skill: 与 /template;内置 TUI 命令(/help、/model 等)则按字面进模型。
 * 用户输入以 / 开头时,除显式技能调用(/skill:)外一律前置空格转义成字面文本(实测
 * 有效)—— 防止误触扩展命令让 Cindy 侧状态镜像脱同步(如 /plan),也堵住未来扩展/包
 * 新增命令带来的攻击面。内部控制路径(setPlanMode 的 /plan)不走本函数。
 */
function escapeLeadingSlashCommand(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/') && !trimmed.startsWith('/skill:')) return ' ' + text;
  return text;
}

/**
 * 组合发给 Pi 的 prompt 正文:有 Extra Dir 时前置引用目录段。但 Pi 只在 RPC prompt **起始**
 * 识别扩展命令(仅 /skill: 会真正执行,见 escapeLeadingSlashCommand)。若正文以 /skill: 起始,
 * 前置 refs 会把命令挤离起始、退化成普通模型文本使技能不加载,故此时**不前置** refs——优先
 * 保证技能调用生效(该轮省去 Extra Dir 提醒)。send 与 steer 同口径(codex review)。
 */
function composePiPromptText(text: string, refs: string): string {
  if (!refs) return text;
  if (text.trimStart().startsWith('/skill:')) return text;
  return `${refs}\n\n${text}`;
}

/** fork 尾部丢弃 turn 数归一:非有限/负值 → 0。 */
function normalizeTailTurnsToDrop(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function guessImageMime(filePath: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

interface PiPromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

/** UserMessage → pi prompt 文本 + images。mention/file 以路径文本引用。 */
async function buildPiPrompt(message: UserMessage): Promise<{ text: string; images: PiPromptImage[] }> {
  if (typeof message.content === 'string') {
    return { text: message.content, images: [] };
  }
  const textParts: string[] = [];
  const images: PiPromptImage[] = [];
  for (const block of message.content as UserContentBlock[]) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text);
        break;
      case 'mention':
        textParts.push(`\`${block.path}\``);
        break;
      case 'file':
        textParts.push(`Attached file (read-only reference): \`${block.path}\``);
        break;
      case 'image': {
        try {
          const data = await fs.readFile(block.path);
          images.push({
            type: 'image',
            data: data.toString('base64'),
            mimeType: guessImageMime(block.path, block.mimeType),
          });
        } catch {
          textParts.push(`(image unavailable: ${block.path})`);
        }
        break;
      }
    }
  }
  return { text: textParts.join(' ').trim(), images };
}

function piExtraDirsPrompt(dirs: readonly string[]): string {
  if (dirs.length === 0) return '';
  return [
    '<cindy-extra-reference-directories>',
    'The following absolute directories are available as read-only references. Do not modify them:',
    ...dirs.map((dir) => `- ${dir}`),
    '</cindy-extra-reference-directories>',
  ].join('\n');
}

export class PiAgent extends BaseAgent {
  readonly kind: AgentKind = 'pi';
  readonly capabilities: Capabilities;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(PiAgent.baseCapabilities());
  }

  private static baseCapabilities(): Capabilities {
    return {
      switchModel: { supported: true },
      availableModels: [],
      // Pi 的 ChatGPT 模型经 Desktop responses bridge 调用。Fast 状态由 host 按
      // sessionId 注入 bridge prefs,再映射为 Codex `service_tier: priority`；实际
      // 是否显示开关仍由目录里该 (provider, model, pi) 的 supportsFastMode 门控。
      hasFastMode: true,
      effort: { supported: true },
      effortLevels: [
        { id: 'minimal', displayName: 'Minimal' },
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
        { id: 'xhigh', displayName: 'Extra High' },
        { id: 'max', displayName: 'Max' },
      ],
      reasoningDisplay: ['off', 'full'],
      // 权限执行层在 cindy-bridge extension 的 tool_call 拦截:ask 档下只读内置
      // 工具放行,bash/edit/write 与全部桥接 MCP 工具逐次经 cindy 审批;
      // bypassPermissions 全放行。档位从权限文件热读,setPermissionMode 即时生效。
      // auto 档:bridge 行为同 ask(非只读全部冒泡),Cindy 侧 dispatcher 先过
      // Auto-Review Core(shared/auto-review.ts)—— 区内写/安全命令静默放行,
      // 灰区由当前会话模型轻量诊断；仅确定性红线或 reviewer 明确 ask 才弹窗
      // (见 handleExtensionUiRequest)。
      // displayName/description 为英文 fallback,真实文案走 i18n
      // newChat.permissionSelector.modes.pi.*(与 cc/codex 同结构)。
      permissionModes: [
        { id: 'ask', displayName: 'Default permissions', description: 'Read-only tools run directly; writing files, running commands, and MCP tools ask each time.' },
        { id: 'auto', displayName: 'Auto-review', description: 'In-workspace writes and safe commands run automatically; out-of-workspace writes, risky commands, and MCP tools still ask.' },
        { id: 'bypassPermissions', displayName: 'Full access', description: 'Every tool runs without asking. Highest risk; use only for trusted tasks.' },
      ],
      setPermissionModeMidSession: { supported: true },
      // plan 模式经 pi 自带 plan-mode 扩展(--extension 加载):开启后禁用 edit/write、
      // bash 仅允许只读白名单;plan 提示词仅在激活时注入(不增基线上下文)。
      // Cindy 用 setPlanMode 经 /plan 命令 toggle 驱动 enter/exit。
      planMode: { supported: true },
      multimodal: {
        text: { supported: true },
        image: { supported: true },
        // Pi 的 read 工具可直接消费 host 归一化后的本地附件路径。
        file: { supported: true },
      },
      // fork:整条克隆(clone)或按 tailTurnsToDrop rewind 到某条 user 消息(fork{entryId}),
      // 与 Codex 粗粒度 fork 同构(uuidMap 空、upToMessageId 忽略)。见 forkSdkSession。
      fork: { supported: true },
      // 对话精确裁剪走 Pi 原生 fork(entryId)，文件恢复复用 Cindy Git savepoint。
      rewind: { supported: true },
      // pi JSONL 原生 append-only entry tree:get_tree + bridge navigateTree。
      sessionTree: { supported: true },
      abort: { supported: true },
      sameTurnSteer: { supported: true },
      memory: {
        supported: { supported: true },
        displayName: 'Pi Auto Memory',
        description: 'Preserve compacted context as searchable Cindy memory.',
        stage: 'stable',
        defaultEnabled: true,
        resettable: true,
        setEnabledMidSession: {
          supported: false,
          reason: 'not-implemented',
          message: 'The updated Pi Auto Memory setting applies to new sessions.',
        },
      },
      extraDirs: { supported: true },
      // pi 原生 export_html RPC:自带 export-html 渲染器,离线、无网关。
      sessionHtmlExport: { supported: true },
      // pi 原生 compact RPC:手动压缩(可带聚焦指令,调 LLM 生成摘要)。
      // 斜杠转义后用户无法手输 /compact,此能力是 pi 会话手动压缩的唯一入口。
      manualCompact: { supported: true },
    };
  }

  /** host 注入的 pi 配置目录(auth/models/settings/sessions);缺省落系统临时目录。 */
  private resolveAgentHome(): string {
    const injected = this.deps.resolvePiAgentHome?.();
    if (injected && injected.trim().length > 0) return injected;
    return path.join(os.tmpdir(), 'cindy-pi-agent-home');
  }

  /**
   * 生成 agentHome/models.json:
   *   - 网关模型 → 单一 provider `cindy`(baseUrl = compat proxy);
   *   - BYOM 原生 provider(nativeProviders)→ **各自独立 provider 块**,baseUrl 直连用户端点,
   *     不过 compat 代理(设计原则:pi 主导,禁双重转义)。
   * apiKey 一律用 `$ENV` 插值,凭证本体只进子进程 env,不落盘。
   */
  private async writeModelsJson(
    agentHome: string,
    nativeProviders: PiNativeProviderSpec[] = [],
    retainedRuntimeModel?: ModelDescriptor,
  ): Promise<void> {
    const endpoint = this.deps.runtimeConfig.endpoint;
    if (!endpoint) {
      this.deps.logger.warn('pi: runtimeConfig.endpoint missing — models.json will have no usable provider');
    }
    const publicModels = this.capabilities.availableModels;
    const runtimeModels = retainedRuntimeModel && !publicModels.some((m) => m.id === retainedRuntimeModel.id)
      ? [...publicModels, retainedRuntimeModel]
      : publicModels;
    const models = runtimeModels
      .map((m: ModelDescriptor) => ({
      id: m.id,
      name: m.displayName,
      reasoning: m.efforts.length > 0,
      input: ['text', 'image'],
      contextWindow: m.contextWindow > 0 ? m.contextWindow : 200_000,
      maxTokens: m.maxOutputTokens && m.maxOutputTokens > 0 ? m.maxOutputTokens : 32_000,
      // 计费单位与目录一致($/1M tokens);pi 按此自行计价,usage 事件的 cost 才有真值。
      cost: {
        input: m.cost?.input ?? 0,
        output: m.cost?.output ?? 0,
        cacheRead: m.cost?.cacheRead ?? 0,
        cacheWrite: m.cost?.cacheWrite ?? 0,
      },
    }));
    const providers: Record<string, unknown> = {
      [PI_PROVIDER_ID]: {
        name: 'Cindy AI',
        baseUrl: endpoint ?? 'http://127.0.0.1:0',
        api: 'anthropic-messages',
        apiKey: `$${PI_API_KEY_ENV}`,
        headers: {
          'x-cindy-pi-session-id': `$${PI_SESSION_ID_ENV}`,
          'x-cindy-pi-session-token': `$${PI_SESSION_TOKEN_ENV}`,
        },
        models,
      },
    };
    for (const np of nativeProviders) {
      if (np.id === PI_PROVIDER_ID) {
        this.deps.logger.warn('pi: native provider id collides with gateway provider "cindy" — skipped', { id: np.id });
        continue;
      }
      providers[np.id] = {
        name: np.name,
        baseUrl: np.baseUrl,
        api: np.api,
        // keyless(本机 Ollama 等)也要给 dummy key,否则 pi /model 不显示该模型。
        apiKey: np.apiKeyEnvVar ? `$${np.apiKeyEnvVar}` : 'pi-native-keyless',
        ...(np.headers && Object.keys(np.headers).length > 0 ? { headers: np.headers } : {}),
        models: np.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: m.reasoning ?? false,
          input: m.input ?? ['text'],
          contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 128_000,
          maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : 16_000,
        })),
      };
    }
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(path.join(agentHome, 'models.json'), JSON.stringify({ providers }, null, 2) + '\n');
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (opts.remoteHostId) {
      throw new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: 'pi sessions are local-only for now',
      });
    }

    // BYOM:host 解析当前会话可用的原生 provider(用户自定义/本地模型)+ 需注入的 env(keys)。
    // 缺省 → 空,只有网关 provider `cindy`(现状不变)。失败不致命,降级为无原生 provider。
    let nativeProviders: PiNativeProviderSpec[] = [];
    let nativeEnv: Record<string, string> = {};
    let nativeResolveFailed = false;
    if (this.deps.resolvePiNativeProviders) {
      try {
        const resolved = await this.deps.resolvePiNativeProviders({
          workingDir: opts.workingDir,
          remoteHostId: opts.remoteHostId,
        });
        nativeProviders = resolved?.providers ?? [];
        nativeEnv = resolved?.env ?? {};
      } catch (err) {
        nativeResolveFailed = true;
        this.deps.logger.warn('pi resolvePiNativeProviders failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const nativeProviderById = new Map(
      nativeProviders
        .filter((provider) => provider.id !== PI_PROVIDER_ID)
        .map((provider) => [provider.id, provider] as const),
    );
    // providerId 是模型来源的主键；同名模型可同时存在于 Cindy 网关和多个 BYOM provider。
    // 三态语义(与 session-provider-store 对齐):
    //   - 显式 BYOM id → 该 native provider(经上面的 model-combo fail-closed 校验);
    //   - null(显式清除来源)→ **固定走默认路由 cindy**,绝不按模型自动挑 BYOM ——
    //     否则默认路由的会话在启动/恢复/切模(Main 传 null)时,若某 BYOM 与网关同名模型,
    //     提示词会被发往用户并未选择的 BYOM 端点(codex review P1);
    //   - undefined(旧会话从未持久化 providerId)→ 才按模型做兼容回退(首个原生来源优先)。
    const resolveProviderForModel = (
      model: string,
      providerId?: string | null,
    ): string => {
      if (providerId) {
        const native = nativeProviderById.get(providerId);
        return native?.models.some((candidate) => candidate.id === model)
          ? native.id
          : PI_PROVIDER_ID;
      }
      if (providerId === null) return PI_PROVIDER_ID;
      return nativeProviders.find(
        (provider) => provider.id !== PI_PROVIDER_ID
          && provider.models.some((candidate) => candidate.id === model),
      )?.id ?? PI_PROVIDER_ID;
    };
    // 显式 BYOM 路由必须 fail closed:当调用方钉了一个既非 Cindy 网关(cindy/xd)也非
    // 订阅直连(openai/anthropic/xai)的自定义/本地 provider 时,该来源必须在本次解析出的
    // nativeProviders 里。若原生解析失败(配置/safeStorage 暂时读不到)或该 provider 缺席,
    // resolveProviderForModel 会静默回落到 PI_PROVIDER_ID(网关)——用户又恰好有 Cindy key
    // 时鉴权仍过,提示词就被发往 Cindy 网关而非用户选的本地/自定义端点(计费/凭证错配,
    // codex review P1)。这里对这种「显式 BYOM 却无法解析」的情形直接抛,不换目的地。
    // 显式 BYOM 的 provider-model 组合无法在本会话解析时,是否要 fail closed。用于
    // startSession(nativeResolveFailed 也算不可解析)与 setModel(会话启动后新增的
    // provider 不在启动快照里 → 需重启会话而非静默走网关)。
    // 关键:不仅要 provider 存在,还要该 provider **确实提供目标 model** —— 否则用户编辑
    // 配置后从现有 provider 里删/改了当前 model 时,provider 仍在但 resolveProviderForModel
    // 的 models.some(...) 为 false,会静默回落 PI_PROVIDER_ID(cindy);若该 model id 也在
    // 网关目录里,resume/setModel 会“成功”却把请求发往网关而非用户选的 BYOM(codex review P1)。
    const explicitByomUnresolvable = (
      providerId: string | null | undefined,
      model: string,
      resolveFailed = false,
    ): providerId is string => {
      if (!providerId || NON_BYOM_PROVIDER_IDS.has(providerId)) return false;
      if (resolveFailed) return true;
      const native = nativeProviderById.get(providerId);
      return !native || !native.models.some((candidate) => candidate.id === model);
    };
    if (explicitByomUnresolvable(opts.providerId, opts.model, nativeResolveFailed)) {
      throw new Error(
        `pi: BYOM provider '${opts.providerId}' cannot serve model '${opts.model}'` +
          `${nativeResolveFailed
            ? ' (native provider resolution failed)'
            : ' (provider absent, or it no longer offers this model)'}; ` +
          'refusing to fall back to the Cindy gateway (would send prompts to the wrong endpoint).',
      );
    }
    const initialProvider = resolveProviderForModel(opts.model, opts.providerId);

    // availableModels 是公开的新选择面,retired/disabled 会被有意过滤;但恢复中的旧 Pi
    // 会话仍需要 models.json 内存在当前模型,Pi 才能解析持久化的 --model。仅对真实 resume
    // 且公开清单缺失的 compat 模型请求 host 补一个私有描述符;不回写 capabilities,也不
    // 放宽 setModel / route guard。
    let retainedRuntimeModel: ModelDescriptor | undefined;
    if (
      opts.resumeSessionId &&
      initialProvider === PI_PROVIDER_ID &&
      !this.capabilities.availableModels.some((model) => model.id === opts.model)
    ) {
      retainedRuntimeModel = this.deps.resolvePiRuntimeModelDescriptor?.(
        opts.providerId,
        opts.model,
      ) ?? undefined;
      if (!retainedRuntimeModel) {
        this.deps.logger.warn('pi: selected model missing from public and retained runtime catalogs', {
          model: opts.model,
          providerId: opts.providerId ?? null,
        });
      }
    }

    // 先解析 native provider 再做 auth：老会话/远端控制端可能没有持久化 providerId，
    // 仍必须能从 model→provider 映射识别纯 BYOM，不能误落 Cindy gateway 登录门。
    const authProviderId =
      opts.providerId ??
      (initialProvider !== PI_PROVIDER_ID
        ? initialProvider
        : opts.model.startsWith('chatgpt/')
          ? 'openai'
          : opts.model.startsWith('xai/')
            ? 'xai'
            : null);
    const credentialMode =
      resolveAgentCredentialMode({ agentKind: 'pi', providerId: authProviderId, model: opts.model }) ??
      'gateway-key';
    const authState = await this.deps.auth.getState({ credentialMode, providerId: authProviderId });
    // 携带具体 reason(与 claude-code / codex 同模板 `<agent> not authenticated: <reason>`),
    // 否则默认构造只产生 `agent-not-authenticated:pi`,跨端映射(describeAgentAuthError)
    // 识别不了,手机端只能直出内部错误串、无法按 reason 引导修复(codex review)。
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'pi',
        `pi not authenticated: ${authState.errorReason ?? 'no_key'}`,
      );
    }
    const authEnv = await this.deps.auth.getAuthEnv({ credentialMode, providerId: authProviderId });

    const agentHome = this.resolveAgentHome();
    // 每个 startSession 用独立的配置目录承载 models.json + cindy-bridge extension
    // (经 PI_CODING_AGENT_DIR 交给子进程),隔离并发普通会话:两个会话同写共享的
    // agentHome/models.json 时,第二次写入会在首次写完到 spawn 之间(多个 await)截断/
    // 覆盖 provider 快照,让先启动的进程读到半写入内容或另一份 BYOM 路由(codex review P2)。
    // session 状态仍由 --session-dir 指向共享 sessions;权限档由 CINDY_PI_PERMISSION_FILE
    // 显式路径提供 —— 两者都与配置目录独立(同 forkSdkSession 的 forkHome 隔离手法),
    // configHome 在进程退出/close/启动失败时清理。
    const configHome = path.join(agentHome, 'run-tmp', randomBytes(8).toString('hex'));
    let configHomeCleaned = false;
    const cleanupConfigHome = (): void => {
      if (configHomeCleaned) return;
      configHomeCleaned = true;
      void fs.rm(configHome, { recursive: true, force: true }).catch(() => {});
    };
    await this.writeModelsJson(configHome, nativeProviders, retainedRuntimeModel);
    const sessionDir = path.join(agentHome, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });

    // cindy-bridge extension:每次 startSession 覆写,保证桥代码与本版本一致。
    // 与 models.json 同放隔离 configHome(Pi 从 PI_CODING_AGENT_DIR/extensions 扫描)。
    const extensionsDir = path.join(configHome, 'extensions');
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.writeFile(
      path.join(extensionsDir, CINDY_BRIDGE_EXTENSION_FILENAME),
      CINDY_BRIDGE_EXTENSION_SOURCE,
    );

    // 权限档文件:extension 每次 tool_call 现读(热切换);读不到按 ask fail-closed。
    const runtimeDir = path.join(agentHome, 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    // 防御:sessionId 会拼进文件名,不能含路径分隔符 / 上级引用 —— 否则可逃出 runtimeDir
    // 覆盖任意文件(codex review)。IPC 边界已统一校验,这里对所有 startSession 调用方
    // (scheduler / orca / resume 等)再兜一层 fail-closed,与安全底线一致。
    const sid = opts.sessionId;
    if (sid !== undefined && (sid === '.' || sid === '..' || /[\\/\0]/.test(sid))) {
      throw new Error(`pi: unsafe sessionId for runtime path: ${JSON.stringify(sid)}`);
    }
    const permissionFile = path.join(
      runtimeDir,
      `perm-${sid ?? `anon-${process.pid}-${Date.now()}`}.json`,
    );
    // auto 保留(Cindy 侧 dispatcher 用);bridge 只特判 bypassPermissions,auto 在
    // 桥内行为同 ask(非只读全部冒泡)。其余档(default/acceptEdits/plan)归 ask 最严。
    const normalizePermissionMode = (mode: string | undefined): 'ask' | 'auto' | 'bypassPermissions' =>
      mode === 'bypassPermissions' ? 'bypassPermissions' : mode === 'auto' ? 'auto' : 'ask';
    let permissionMode = normalizePermissionMode(opts.permissionMode);
    let mutableExtraDirs = [...(opts.extraDirs ?? [])];
    type PermissionSnapshot = {
      mode: 'ask' | 'auto' | 'bypassPermissions';
      readOnlyRoots: string[];
    };
    const permissionPrivilege = (mode: PermissionSnapshot['mode']): number =>
      mode === 'bypassPermissions' ? 2 : mode === 'auto' ? 1 : 0;
    let requestedPermissionSnapshot: PermissionSnapshot = {
      mode: permissionMode,
      readOnlyRoots: [...mutableExtraDirs],
    };
    let persistedPermissionSnapshot: PermissionSnapshot = {
      mode: permissionMode,
      readOnlyRoots: [...mutableExtraDirs],
    };
    // 权限档写入串行化 + 代际跳过。并发/连续切档(本地与远程控制端同时切,或用户快速连点)时,
    // 无串行的 fs.writeFile 可能让较早的 Full-access 写在较新的 Ask 写之后落盘 —— bridge 每次
    // tool_call 现读就会读到过期的 bypassPermissions,而 host 闭包/UI 已切到 Ask,后续破坏性工具
    // 不再确认(codex review P1)。内存态(host 权限门 778/1549/1571 现读)仍即时反映最新意图;
    // 仅文件写按代际串行,被更晚意图取代的写直接跳过,保证文件最终收敛到最新意图、绝不 stale 覆盖。
    let permissionWriteChain: Promise<void> = Promise.resolve();
    let permissionWriteGen = 0;
    const writePermissionFile = (next: PermissionSnapshot): Promise<void> => {
      requestedPermissionSnapshot = {
        mode: next.mode,
        readOnlyRoots: [...next.readOnlyRoots],
      };
      // 收紧必须立刻约束 host 侧审批门；等待磁盘 I/O 才改闭包会留下一个 Full access
      // 的窗口。放宽反过来只能等对应快照成功落盘，避免 host 已放行而 bridge 仍是旧档。
      if (permissionPrivilege(requestedPermissionSnapshot.mode) < permissionPrivilege(permissionMode)) {
        permissionMode = requestedPermissionSnapshot.mode;
      }
      const gen = ++permissionWriteGen;
      // 排队时刻捕获意图快照;运行时若已被更晚的写取代则跳过(旧内容不得在新内容之后落盘)。
      const snapshot = { ...requestedPermissionSnapshot, readOnlyRoots: [...requestedPermissionSnapshot.readOnlyRoots] };
      const run = permissionWriteChain.then(async () => {
        if (gen !== permissionWriteGen) return;
        try {
          await fs.writeFile(permissionFile, JSON.stringify(snapshot) + '\n');
        } catch (error) {
          // 失败的最新意图不能留在 requested 里。否则一次 Full-access 写失败后，
          // 随后的 Extra Dirs 更新会从 requested 继承 bypassPermissions，再把失败的
          // 放宽意图重放到 bridge 文件。旧代际失败不能回滚较新的并发意图。
          if (gen === permissionWriteGen) {
            requestedPermissionSnapshot = {
              // 收紧在 I/O 前已 fail-closed 提交到 host；保留这个更安全的 mode。
              // 放宽失败时 permissionMode 仍是旧的已提交 mode，同样达到回滚效果。
              mode: permissionMode,
              readOnlyRoots: [...persistedPermissionSnapshot.readOnlyRoots],
            };
          }
          throw error;
        }
        // 只有落盘成功且仍是最新代际，host 才提交放宽/目录变更。失败时调用方
        // 收到 reject；已提前采取的收紧仍保留（fail-closed），下一次写可沿恢复后的链重试。
        if (gen === permissionWriteGen) {
          permissionMode = snapshot.mode;
          mutableExtraDirs = [...snapshot.readOnlyRoots];
          persistedPermissionSnapshot = {
            mode: snapshot.mode,
            readOnlyRoots: [...snapshot.readOnlyRoots],
          };
        }
      });
      // 排序链必须永不停在 rejected 上:单次 fs.writeFile 失败若污染链,后续 .then 全部不再执行,
      // 文件系统恢复后的重写也永远追加不进去,bridge 会一直卡在旧档(codex review P1)。故链只吞错
      // 保持“已收口”供下一次写继续;真实成败通过 run 返回给调用方(setPermissionMode 据此可上报)。
      permissionWriteChain = run.catch(() => {});
      return run;
    };
    await writePermissionFile(requestedPermissionSnapshot);

    // MCP 桥:host 把 in-process MCP providers 暴露成 localhost streamable-HTTP。
    // 传 session 身份(sessionId/workingDir/vendorOptions)让 host 在 bridge 上注册
    // 身份 ctx + 给 server URL 打 `?session=` 路由 —— orca/会话身份类工具据此绑定
    // 当前 pi 会话。disposeSessionCtx 在 close() 注销该注册(幂等)。
    let mcpBridge: PiExtraSpawnConfig['mcpBridge'] = null;
    let disposeSessionCtx: (() => void) | undefined;
    if (this.deps.preparePiExtraSpawnConfig) {
      try {
        const extra = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          sessionId: opts.sessionId,
          workingDir: opts.workingDir,
          vendorOptions: opts.vendorOptions,
        });
        mcpBridge = extra?.mcpBridge ?? null;
        disposeSessionCtx = extra?.disposeSessionCtx;
      } catch (err) {
        this.deps.logger.error('pi MCP bridge prep failed, continuing without cindy tools', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 压缩即记忆:makerMemory 开启时,把 pi 压缩上下文时丢弃内容的摘要沉淀成 `digest`
    // 记忆(进 FTS 可 memory_search 检索,但排除出 MEMORY.md / system prompt,不污染
    // curated 记忆)。gate 与 CC 同口径;best-effort,失败只 warn,绝不阻断会话。
    const compactionMemoryEnabled =
      (opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled ?? false) === true &&
      (this.memoryOverride ?? true) === true &&
      !!this.deps.makerMemory;
    const memoryScopeKey = buildMemoryScopeKey(opts.workingDir, opts.remoteHostId);
    const digestSlugBase = slugifyForMemory(opts.sessionId ?? `pi-${process.pid}`, 24);
    let digestSeq = 0;
    const writeCompactionDigest = async (summary: string, reason: string): Promise<void> => {
      const manager = this.deps.makerMemory;
      if (!compactionMemoryEnabled || !manager) return;
      const body = truncateToByteBudget(summary, PI_DIGEST_MAX_BODY_BYTES);
      const seq = ++digestSeq;
      // slug 唯一:sessionId 片段 + 递增序号;resume/跨会话用 Date.now 防撞名(create 模式撞名会抛)。
      const slug = slugifyForMemory(`digest-${digestSlugBase}-${Date.now()}-${seq}`, 64);
      try {
        await manager.write(memoryScopeKey, {
          type: 'digest',
          name: slug,
          // reason 收敛(去换行 + 截断):防某版本 pi 给出长 reason 撑爆 maxTitleLen(100)被吞。
          title: `PI compaction digest (${oneLineDescription(reason, 40)})`,
          description: oneLineDescription(summary, 180),
          body,
          mode: 'create',
        });
        this.deps.logger.debug('pi compaction digest saved to memory', { slug, reason });
      } catch (err) {
        this.deps.logger.warn('pi compaction digest write failed (non-fatal)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 追加而非替换:pi 默认 prompt(工具用法/工程约定)原样保留,只追加 host 产品段
    // 与用户段。前缀稳定(默认 prompt 静态),易变内容禁止进入(缓存规则 3.1)。
    const appendSections = [
      this.deps.runtimeConfig.systemPrompt?.trim(),
      opts.userPrompt?.trim(),
      piExtraDirsPrompt(mutableExtraDirs),
    ].filter((s): s is string => !!s && s.length > 0);
    const appendSystemPrompt = appendSections.join('\n\n');

    // plan 模式:挂载 pi 自带的 plan-mode example 扩展(随 pi 分发,版本匹配,免 vendoring)。
    // 只在文件存在时 --extension;缺失则 plan 模式静默降级(setPlanMode 时 warn)。
    // 加载本身零副作用:plan 模式默认关,扩展 hook 全早返;仅 /plan 开启后才注入 plan 提示词。
    const planModeExtPath = path.join(
      path.dirname(this.deps.binaryPath),
      'examples', 'extensions', 'plan-mode', 'index.ts',
    );
    let planModeExtAvailable = false;
    try {
      planModeExtAvailable = (await fs.stat(planModeExtPath)).isFile();
    } catch {
      /* 缺失 → 不挂载 plan-mode */
    }

    const args = [
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--provider', initialProvider,
      '--model', opts.model,
      ...(appendSystemPrompt.length > 0 ? ['--append-system-prompt', appendSystemPrompt] : []),
      ...(planModeExtAvailable ? ['--extension', planModeExtPath] : []),
    ];

    const queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const ctx: PiTranslateContext = createPiTranslateContext(this.deps.logger);
    let interactionResolver: InteractionResolver | null = null;
    let mutableModel = opts.model;
    let mutableProviderId: string | null | undefined = opts.providerId ?? authProviderId;
    let currentAutoReviewIntent = '';
    const autoReviewDecisionCache = new Map<string, Promise<AutoReviewDecision>>();
    const setAutoReviewIntent = (content: UserMessage['content']): void => {
      currentAutoReviewIntent = extractAutoReviewUserIntent(content);
      autoReviewDecisionCache.clear();
    };
    const reviewAutoAction = (action: ReviewableAction): Promise<AutoReviewDecision> => {
      const request = {
        sessionId: opts.sessionId,
        agentKind: 'pi' as const,
        providerId: mutableProviderId,
        model: mutableModel,
        userIntent: currentAutoReviewIntent,
        action,
        workspaceRoots: [opts.workingDir, ...mutableExtraDirs],
        platform: opts.remoteHostId ? 'linux' as const : process.platform,
      };
      const cacheKey = JSON.stringify(request);
      let pending = autoReviewDecisionCache.get(cacheKey);
      if (!pending) {
        pending = resolveAutoReviewDecision(request, this.deps.reviewAutoPermissionAction);
        autoReviewDecisionCache.set(cacheKey, pending);
      }
      return pending;
    };
    let closed = false;
    // Cindy 侧对 pi plan 模式的镜像态;setPlanMode 经 /plan toggle 驱动,与 pi 内部
    // planModeEnabled 保持一致(RPC 下 Execute/Refine 选择框被 auto-cancel,pi 不会自行
    // 翻转,故镜像不漂移)。
    let planModeActive: boolean | null = planModeExtAvailable ? null : false;
    let planModeWriteChain: Promise<void> = Promise.resolve();

    // proc 构造即 spawn 子进程 —— spawn 参数非法等会**同步**抛。此刻 ctx 已在
    // preparePiExtraSpawnConfig 注册、但 handle 尚未交出,close() 不会跑 → 单独
    // 兜底注销 ctx 再抛(构造失败没有 proc 可关)。catch 必抛,故其后 proc 恒已赋值。
    let proc: PiRpcProcess;
    const proxySessionToken = randomBytes(32).toString('base64url');
    let disposeProxySession: (() => void) | undefined;
    // 幂等:onExit(进程异常退出)与 close()(用户结束)可能都调用它;首次注销后置位,
    // 后续调用直接返回,避免二次注销(codex review:crash 时须由 onExit 立即释放)。
    let sessionRegistrationsDisposed = false;
    const disposeSessionRegistrations = (): void => {
      if (sessionRegistrationsDisposed) return;
      sessionRegistrationsDisposed = true;
      let firstError: unknown;
      for (const dispose of [disposeProxySession, disposeSessionCtx]) {
        try {
          dispose?.();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    };
    try {
      if (opts.sessionId && this.deps.registerPiProxySession) {
        const disposer = this.deps.registerPiProxySession(opts.sessionId, proxySessionToken);
        if (typeof disposer === 'function') disposeProxySession = disposer;
      }
      // 这些值必须留在 Pi 父进程，供 models.json 的 $ENV 请求期解析及 bridge
      // client 使用；cindy-bridge 用该**仅含变量名**的清单在 bash spawn 边界剥离
      // 真值，阻止 LLM shell 绕过工具审批直连 localhost proxy/MCP 或盗用 BYOM key。
      const piSecretEnvNames = Array.from(new Set([
        PI_API_KEY_ENV,
        PI_SESSION_ID_ENV,
        PI_SESSION_TOKEN_ENV,
        ...Object.keys(authEnv),
        ...Object.keys(nativeEnv),
        ...(mcpBridge && mcpBridge.servers.length > 0 ? [PI_MCP_BRIDGE_ENV] : []),
      ]));
      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...authEnv,
        // BYOM 原生 provider 的 api keys(键名对应 spec.apiKeyEnvVar,models.json 用 $ENV 引用)。
        ...nativeEnv,
        [PI_SESSION_ID_ENV]: opts.sessionId ?? '',
        [PI_SESSION_TOKEN_ENV]: proxySessionToken,
        [PI_SECRET_ENV_NAMES_ENV]: JSON.stringify(piSecretEnvNames),
        PI_CODING_AGENT_DIR: configHome,
        CINDY_PI_PERMISSION_FILE: permissionFile,
        // 嵌入式 runtime 不做启动期联网:关掉 pi 的版本检查与安装遥测
        // (pi.dev/api/latest-version、report-install)。LLM 请求走 provider 通道不受影响。
        PI_OFFLINE: '1',
        // 保留稳定 system/tool 前缀的长缓存。不支持的 provider 会忽略该选项；
        // 支持者（如 Anthropic）可避免较长会话在短 TTL 后重新计费。
        PI_CACHE_RETENTION: 'long',
        ...(mcpBridge && mcpBridge.servers.length > 0
          ? { [PI_MCP_BRIDGE_ENV]: JSON.stringify(mcpBridge) }
          : {}),
      };
      mergeLoopbackNoProxy(spawnEnv);
      proc = new PiRpcProcess({
        binaryPath: this.deps.binaryPath,
        args,
        cwd: opts.workingDir,
        env: spawnEnv,
        logger: this.deps.logger,
        onEvent: (event: PiRpcEvent) => {
          if (event.type === 'extension_ui_request') {
            this.handleExtensionUiRequest(event, proc, () => ({
              resolver: interactionResolver,
              permissionMode,
              workspaceRoots: [opts.workingDir],
              readRoots: [opts.workingDir, ...mutableExtraDirs],
              reviewAutoAction,
            }));
            return;
          }
          // 压缩即记忆:compaction_end 带摘要正文时沉淀 digest(auto/manual 都触发,pi
          // 文档:两种压缩都发此事件)。fire-and-forget,不阻塞事件流。
          if (event.type === 'compaction_end' && compactionMemoryEnabled) {
            const summary = (event.result as { summary?: unknown } | null)?.summary;
            if (typeof summary === 'string' && summary.trim().length > 0) {
              const reason = typeof event.reason === 'string' ? event.reason : 'auto';
              void writeCompactionDigest(summary.trim(), reason);
            }
          }
          translatePiEvent(event, queue, ctx);
        },
        onExit: ({ code, signal }) => {
          if (!closed) {
            // 非用户 close 的进程死亡:terminal error + 收尾,避免 UI 永久 running。
            queue.push({
              type: 'error',
              data: { message: `pi process exited unexpectedly (code=${code}, signal=${signal})`, isTerminal: true },
              source: 'pi',
            });
            // 崩溃/被杀:上层见迭代器结束即把 session 标 closed,close() 随后短路,
            // proxy token 与 MCP session ctx 会滞留 Main 内存直到重启 —— 期间任何本地
            // 进程仍可拿旧 token 经 loopback 代理盗用宿主凭证(codex review)。在此幂等注销。
            try {
              disposeSessionRegistrations();
            } catch (err) {
              this.deps.logger.warn('pi dispose on unexpected exit failed (non-fatal)', {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // 进程已死:隔离的 configHome(models.json + extension)不再被读,清理。
          cleanupConfigHome();
          queue.end();
        },
      });
    } catch (err) {
      try {
        disposeSessionRegistrations();
      } catch {
        /* best-effort:注销失败不掩盖原始构造错误 */
      }
      cleanupConfigHome();
      throw err;
    }

    const readPersistedPlanMode = async (): Promise<boolean | null> => {
      const entriesResp = await proc.request({ type: 'get_entries' });
      if (!entriesResp.success) return null;
      const entries =
        (entriesResp.data as { entries?: Array<{ customType?: string; data?: { enabled?: boolean } }> } | undefined)
          ?.entries ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.customType !== 'plan-mode') continue;
        const enabled = entries[i]?.data?.enabled;
        return typeof enabled === 'boolean' ? enabled : null;
      }
      return false;
    };

    const readPiUserEntryIds = async (): Promise<Set<string> | null> => {
      try {
        const response = await proc.request({ type: 'get_entries' });
        if (!response.success) return null;
        const data = typeof response.data === 'object' && response.data !== null
          ? response.data as Record<string, unknown>
          : null;
        // malformed success 不能当“空历史”，否则下一次正常读取会把任意既有 user entry
        // 误判成刚发送的消息并串错附件。
        if (!Array.isArray(data?.entries)) return null;
        const entries = data.entries;
        const ids = new Set<string>();
        for (const raw of entries) {
          if (typeof raw !== 'object' || raw === null) continue;
          const entry = raw as Record<string, unknown>;
          if (entry.type !== 'message' || typeof entry.id !== 'string' || entry.id.length === 0) continue;
          const message = typeof entry.message === 'object' && entry.message !== null
            ? entry.message as Record<string, unknown>
            : null;
          if (message?.role === 'user') ids.add(entry.id);
        }
        return ids;
      } catch (error) {
        this.deps.logger.warn('pi user-entry snapshot failed (attachment link unavailable)', {
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    const reportAcceptedPiUserEntry = async (
      before: Set<string> | null,
      callback: SendOptions['onTranscriptUserEntry'],
    ): Promise<void> => {
      if (!before || !callback) return;
      // prompt RPC 在 Pi 的 preflight acceptance 点返回，entry 紧接着才 append。短轮询
      // get_entries，按“此前不存在的 user entry”取稳定 id；捕获失败只影响附件分支恢复，
      // 不能把已被 Pi 接受的发送伪报成失败。
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const current = await readPiUserEntryIds();
        const entryId = current ? [...current].find((id) => !before.has(id)) : undefined;
        if (entryId) {
          try {
            await callback(entryId);
          } catch (error) {
            this.deps.logger.warn('pi user-entry link callback failed (non-fatal)', {
              entryId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 8));
      }
      this.deps.logger.warn('pi user-entry id was not observable after prompt acceptance');
    };

    const writePermissionSnapshotOrFailClosed = async (next: PermissionSnapshot): Promise<void> => {
      try {
        await writePermissionFile(next);
      } catch (error) {
        // bridge 在 Pi 子进程内现读文件；若磁盘仍是 Full access，单改 host 闭包并不能
        // 拦住下一次 tool_call。安全收紧或新增 Extra Dir 的只读边界落盘失败时，唯一
        // 可证明 fail-closed 的动作是关掉该 Pi 进程，要求重启后重新生成权限文件。
        const staleBypassWouldRemain = persistedPermissionSnapshot.mode === 'bypassPermissions'
          && (
            next.mode !== 'bypassPermissions'
            || next.readOnlyRoots.some((root) => !persistedPermissionSnapshot.readOnlyRoots.includes(root))
          );
        if (staleBypassWouldRemain) {
          await proc.close().catch(() => undefined);
        }
        throw error;
      }
    };

    // startSession 在把 handle 交给调用方之前若失败(resume 硬失败、启动期 RPC
    // 超时/进程夭折等),close() 永远不会被调用。这里 try/catch 兜底:注销 bridge
    // 身份注册(否则 ?session= ctx 泄漏)+ 关掉可能已 spawn 的子进程(否则僵尸 pi
    // 仍持有本会话的 MCP 路由),再把原始错误抛给调用方。
    let sdkSessionId = '';
    try {
      // Resume:pi 的会话钥匙是 session JSONL 绝对路径(get_state.sessionFile),
      // 落库 sdk_session_id 存的就是它;切换失败走 invalid-resume CAS 协定。
      if (opts.resumeSessionId) {
        // Pi 对不存在的路径会“成功”创建一条同名空会话，不能把历史丢失伪装成
        // resume 成功。Cindy 先做本地文件存在性检查，再决定是否允许 fresh fallback。
        let resumeFileExists = false;
        try {
          resumeFileExists = (await fs.stat(opts.resumeSessionId)).isFile();
        } catch {
          resumeFileExists = false;
        }
        if (!resumeFileExists) {
          const mayFallback = (await opts.onInvalidResumeSession?.(opts.resumeSessionId)) ?? true;
          if (!mayFallback) {
            throw new Error('pi resume failed and fallback rejected: session file missing');
          }
          this.deps.logger.warn('pi resume session file missing, starting fresh session', {
            resumeSessionId: opts.resumeSessionId,
          });
        } else {
          const switched = await proc.request({ type: 'switch_session', sessionPath: opts.resumeSessionId });
          if (!switched.success) {
            const mayFallback = (await opts.onInvalidResumeSession?.(opts.resumeSessionId)) ?? true;
            if (!mayFallback) {
              // proc 关闭 + ctx 注销由下面的 catch 统一处理,这里只抛。
              throw new Error(`pi resume failed and fallback rejected: ${switched.error ?? 'unknown'}`);
            }
            this.deps.logger.warn('pi resume failed, starting fresh session', {
              resumeSessionId: opts.resumeSessionId,
              error: switched.error,
            });
          }
        }
      }

      if (opts.effort) {
        const resp = await proc.request({
          type: 'set_thinking_level',
          level: effortToPiThinkingLevel(opts.effort),
        });
        if (!resp.success) {
          this.deps.logger.warn('pi set_thinking_level rejected', { effort: opts.effort, error: resp.error });
        }
      }

      // 显式保证 auto-compaction 开 —— 这是"pi 保持轻上下文"的不变量:上下文接近满时
      // pi 自动压缩(与 CC/Codex 一致)。pi 默认即开,这里显式化并兜底(幂等,失败不致命)。
      {
        const resp = await proc.request({ type: 'set_auto_compaction', enabled: true });
        if (!resp.success) {
          this.deps.logger.warn('pi set_auto_compaction failed (non-fatal)', { error: resp.error });
        }
      }

      const state = await proc.request({ type: 'get_state' });
      const stateData = (state.data ?? {}) as {
        sessionFile?: string | null;
        sessionId?: string;
        model?: { contextWindow?: number } | null;
      };
      if (typeof stateData.model?.contextWindow === 'number' && stateData.model.contextWindow > 0) {
        ctx.contextWindow = stateData.model.contextWindow;
      }
      sdkSessionId = stateData.sessionFile || stateData.sessionId || `pi-${Date.now()}`;
      queue.push({ type: 'session_id', data: sdkSessionId, source: 'pi' });

      // plan 镜像与 pi 持久态对齐(resume 关键):pi 的 plan-mode 扩展在 session_start 会从
      // session entry 自恢复 planModeEnabled,但不发 notify。若镜像固定为 false 而 pi 实为 true,
      // 由于 /plan 是 toggle + setPlanMode 幂等短路,会导致方向反转或关不掉。故从 get_entries
      // 读最后一条 plan-mode custom entry 的 enabled 校正镜像(get_entries 已验证暴露该 entry)。
      if (planModeExtAvailable) {
        try {
          planModeActive = await readPersistedPlanMode();
          if (planModeActive === null) {
            this.deps.logger.warn('pi plan-mode state sync: get_entries failed or returned an invalid state; plan mirror remains unknown');
          }
        } catch (err) {
          planModeActive = null;
          this.deps.logger.warn('pi plan-mode state sync failed; plan mirror remains unknown', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      try {
        disposeSessionRegistrations();
      } catch {
        /* best-effort:注销失败不掩盖原始启动错误 */
      }
      await proc.close().catch(() => {});
      cleanupConfigHome();
      throw err;
    }

    const deps = this.deps;
    const agentKind = this.kind;

    // 取消边界:main 的队列协调器在 Stop/close 抢占时会 abort 传入的 signal 并撤下
    // steer 标记。send/steer 必须在**构建 prompt(读附件是 async)前后、投递 RPC 前**
    // 复查该 signal —— 否则 Pi 已消费该消息、协调器却按已撤标记丢弃不落库,模型就在
    // 一条“不可见 steer”上继续跑(codex review)。
    const rejectIfCancelled = (sendOpts: SendOptions | undefined, action: string): void => {
      if (sendOpts?.signal?.aborted) {
        throw new Error(`pi ${action} cancelled before acceptance`);
      }
    };

    const handle: AgentSessionHandle = {
      // getter 而非固定值:setModel / commitRewindFiles 会更新闭包里的 mutableModel /
      // sdkSessionId,Session.model / Session.sdkSessionId 直读这两个 handle 属性 ——
      // 固定复制会让切模后 Orca listWorkers 仍报旧模型、rewind 后宿主仍读旧 session 文件
      // (与 Claude/Codex handle 同款 getter,codex review)。
      get id() { return sdkSessionId; },
      agentKind,
      get model() { return mutableModel; },

      // 每轮权限策略(IM 群等)是 host 侧的 forceConfirmToolCall 回调,必须在工具执行前的
      // 审批边界强制执行。Pi 的工具审批在独立进程的 cindy-bridge extension(按 perm 文件
      // 现读 ask/auto/bypass 档),没有逐 tool_call 回调进 host 的通道,任何档位都无法执行
      // 该 host 回调;故一旦带策略就 fail-closed 拒绝,避免成员可控的群上下文在 auto/bypass
      // 下不经 owner 确认执行破坏性工具(codex review P1)。
      validateSendOptions(sendOpts: SendOptions) {
        if (sendOpts.turnPermissionPolicy) {
          throw new TurnPermissionPolicyUnsupportedError('pi', permissionMode);
        }
      },

      async send(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        rejectIfCancelled(sendOpts, 'send');
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        setAutoReviewIntent(message.content);
        const { text, images } = await buildPiPrompt(message);
        rejectIfCancelled(sendOpts, 'send');
        // setExtraDirs 是热更新；Pi 没有独立的 mid-session system-prompt RPC，所以在
        // 后续 user turn 前附上短引用目录段(但 /skill: 起始时不前置,见 composePiPromptText)。
        const promptText = composePiPromptText(text, piExtraDirsPrompt(mutableExtraDirs));
        const command: Record<string, unknown> = { type: 'prompt', message: escapeLeadingSlashCommand(promptText) };
        if (images.length > 0) command.images = images;
        // send 语义 = 排队开新 turn;pi streaming 中裸 prompt 会被拒,补 followUp。
        if (ctx.isStreaming) command.streamingBehavior = 'followUp';
        const userEntriesBefore = sendOpts?.onTranscriptUserEntry
          ? await readPiUserEntryIds()
          : null;
        rejectIfCancelled(sendOpts, 'send');
        const resp = await proc.request(command);
        if (!resp.success) {
          throw new Error(`pi prompt rejected: ${resp.error ?? 'unknown'}`);
        }
        await reportAcceptedPiUserEntry(userEntriesBefore, sendOpts?.onTranscriptUserEntry);
      },

      async steer(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        rejectIfCancelled(sendOpts, 'steer');
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        setAutoReviewIntent(message.content);
        const { text, images } = await buildPiPrompt(message);
        rejectIfCancelled(sendOpts, 'steer');
        // /skill: 起始时不前置 Extra Dir 引用段(否则命令退化成文本),与 send 同口径。
        const promptText = composePiPromptText(text, piExtraDirsPrompt(mutableExtraDirs));
        const command: Record<string, unknown> = { type: 'steer', message: escapeLeadingSlashCommand(promptText) };
        if (images.length > 0) command.images = images;
        const resp = await proc.request(command);
        if (!resp.success) {
          throw new Error(`pi steer rejected: ${resp.error ?? 'unknown'}`);
        }
      },

      async abort(): Promise<void> {
        if (proc.isClosed) return;
        await proc.request({ type: 'abort' }).catch((err: unknown) => {
          deps.logger.warn('pi abort request failed', { message: (err as Error).message });
        });
      },

      async close(): Promise<void> {
        closed = true;
        // 先注销 bridge 身份注册(幂等),再关子进程。放前面:即便 proc.close 抛错
        // 也不泄漏 ctx —— 该 sessionId 的 `?session=` 路由必须随会话结束失效。
        try {
          disposeSessionRegistrations();
        } catch (err) {
          deps.logger.warn('pi dispose session registration failed (non-fatal)', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
        await proc.close();
        // 会话结束:清理隔离的 configHome(onExit 幂等,二者先到先清)。
        cleanupConfigHome();
      },

      events(): AsyncIterable<AgentEvent> {
        return queue;
      },

      getUsageSnapshot(): UsageSnapshot {
        return usageSnapshotOf(ctx);
      },

      setInteractionResolver(resolver: InteractionResolver): void {
        interactionResolver = resolver;
      },

      async setModel(model: string, setOpts?: { providerId?: string | null }): Promise<void> {
        const requestedProviderId = setOpts && Object.hasOwn(setOpts, 'providerId')
          ? setOpts.providerId
          : undefined;
        // 显式选一个启动快照 nativeProviderById 里“无法服务该 model”的 BYOM provider 时 fail
        // closed:要么该 provider 是会话启动后才新增的(不在快照),要么它虽在、但用户编辑
        // 配置后从中删/改了这个 model。两种都会让 resolveProviderForModel 静默回落 cindy 网关;
        // 若该 model id 也在网关目录里则 set_model “成功”、后续 prompt 发往网关而非用户选的
        // 本地/自定义端点(codex review P1)。提示重启会话以刷新启动快照,而不是静默换目的地。
        if (explicitByomUnresolvable(requestedProviderId, model)) {
          throw new Error(
            `pi: BYOM provider '${requestedProviderId}' cannot serve model '${model}' in this session's ` +
              'startup provider set (provider not present, or it no longer offers this model); restart the ' +
              'session to use it (refusing to fall back to the Cindy gateway).',
          );
        }
        const provider = resolveProviderForModel(model, requestedProviderId);
        const resp = await proc.request({ type: 'set_model', provider, modelId: model });
        if (!resp.success) throw new Error(`pi set_model failed: ${resp.error ?? 'unknown'}`);
        mutableModel = model;
        if (setOpts && Object.hasOwn(setOpts, 'providerId')) mutableProviderId = setOpts.providerId;
        autoReviewDecisionCache.clear();
        const data = (resp.data ?? {}) as { contextWindow?: number };
        if (typeof data.contextWindow === 'number' && data.contextWindow > 0) {
          ctx.contextWindow = data.contextWindow;
        }
      },

      async setEffort(effort: Effort): Promise<void> {
        const resp = await proc.request({
          type: 'set_thinking_level',
          level: effortToPiThinkingLevel(effort),
        });
        if (!resp.success) throw new Error(`pi set_thinking_level failed: ${resp.error ?? 'unknown'}`);
      },

      async setPermissionMode(mode): Promise<void> {
        // ask/auto/bypass 三档;extension 每次 tool_call 现读,写完即生效。
        // auto 的差异在 Cindy 侧 dispatcher(handleExtensionUiRequest),bridge 无感知。
        await writePermissionSnapshotOrFailClosed({
          ...requestedPermissionSnapshot,
          mode: normalizePermissionMode(mode),
        });
      },

      async setExtraDirs(dirs: string[]): Promise<void> {
        await writePermissionSnapshotOrFailClosed({
          ...requestedPermissionSnapshot,
          readOnlyRoots: [...dirs],
        });
      },

      isTurnRunning(): boolean {
        // ctx.isStreaming 由 agent_start / agent_settled 翻转(translator 维护)。
        return ctx.isStreaming;
      },

      async setPlanMode(enabled: boolean): Promise<void> {
        if (!planModeExtAvailable) {
          deps.logger.warn('pi setPlanMode ignored: plan-mode extension not available');
          return;
        }
        // /plan 是 toggle，必须把全部调用串行；否则两个并发“开启”都会看到 false，
        // 连续 toggle 两次后实际回到关闭。未知镜像先重新读取，无法证明方向就拒绝，
        // 不能把 sync 失败伪报成 false 后盲切。
        const run = planModeWriteChain.then(async () => {
          if (planModeActive === null) {
            planModeActive = await readPersistedPlanMode();
            if (planModeActive === null) {
              throw new Error('pi setPlanMode refused: persisted plan-mode state is unavailable');
            }
          }
          if (enabled === planModeActive) return;
          let resp: Awaited<ReturnType<typeof proc.request>>;
          try {
            resp = await proc.request({ type: 'prompt', message: '/plan' });
          } catch (error) {
            // transport 超时/断线不能证明命令未到达 Pi；它可能已经完成 toggle。
            // 旧 boolean 此后不再可信，下次调用必须先从持久 entry 重同步。
            planModeActive = null;
            throw error;
          }
          if (!resp.success) {
            // RPC 失败响应也不拿旧镜像继续猜 toggle 方向，统一回到未知态。
            planModeActive = null;
            throw new Error(`pi setPlanMode(/plan) rejected: ${resp.error ?? 'unknown'}`);
          }
          planModeActive = enabled;
        });
        planModeWriteChain = run.catch(() => {});
        return run;
      },

      getPlanMode(): boolean | null {
        return planModeActive;
      },

      async exportSessionHtml(outputPath?: string): Promise<string> {
        // pi 原生 export_html:纯本地渲染,不调网关。省略 outputPath 时 pi 自选默认位置。
        const command: Record<string, unknown> = { type: 'export_html' };
        if (outputPath && outputPath.trim().length > 0) command.outputPath = outputPath;
        const resp = await proc.request(command);
        if (!resp.success) {
          throw new Error(`pi export_html failed: ${resp.error ?? 'unknown'}`);
        }
        const path = (resp.data as { path?: string } | undefined)?.path;
        if (!path || path.trim().length === 0) {
          throw new Error('pi export_html: output path unavailable');
        }
        return path;
      },

      async compactSession(instructions?: string): Promise<ManualCompactResult> {
        // pi 原生 compact:调 LLM 生成摘要(耗时数秒起),压缩边界经
        // compaction_start/end 事件流上报,translator 映射成 compact_boundary。
        // 压缩请求本身可能远超 RPC 默认 30s 超时(大上下文 + 网关排队),放宽到 10 分钟。
        const command: Record<string, unknown> = { type: 'compact' };
        if (instructions && instructions.trim().length > 0) command.customInstructions = instructions.trim();
        const resp = await proc.request(command, { timeoutMs: PI_COMPACT_TIMEOUT_MS });
        if (!resp.success) {
          // 良性拒绝:上下文太小 / 无内容可压缩 —— 不是错误,返回 noop 让 UI 给信息性提示。
          const err = (resp.error ?? '').toLowerCase();
          if (err.includes('nothing to compact') || err.includes('too small')) {
            return { noop: true };
          }
          throw new Error(`pi compact failed: ${resp.error ?? 'unknown'}`);
        }
        const data = (resp.data ?? {}) as { tokensBefore?: number; estimatedTokensAfter?: number };
        const result: ManualCompactResult = {};
        if (typeof data.tokensBefore === 'number') result.tokensBefore = data.tokensBefore;
        if (typeof data.estimatedTokensAfter === 'number') result.estimatedTokensAfter = data.estimatedTokensAfter;
        return result;
      },

      async previewRewindFiles(): Promise<RewindFilesResult> {
        // 文件变化由 Desktop 的 Cindy Git savepoint 预览；Pi 原生层只负责对话裁剪。
        return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
      },

      async commitRewindFiles(_userUuid, _priorAssistantUuid, rewindOpts) {
        const tailTurnsToDrop = normalizeTailTurnsToDrop(rewindOpts?.tailTurnsToDrop);
        if (tailTurnsToDrop <= 0) return { sdkSessionId };
        if (ctx.isStreaming) throw new Error('SESSION_RUNNING: 会话进行中，无法 rewind');

        const forkMessages = await proc.request({ type: 'get_fork_messages' });
        if (!forkMessages.success) {
          throw new Error(`pi rewind get_fork_messages failed: ${forkMessages.error ?? 'unknown'}`);
        }
        const messages =
          (forkMessages.data as { messages?: Array<{ entryId?: string }> } | undefined)?.messages ?? [];
        const targetIndex = messages.length - tailTurnsToDrop;
        const entryId = targetIndex >= 0 ? messages[targetIndex]?.entryId : undefined;
        if (!entryId) {
          throw new Error(
            `pi rewind target unavailable (drop=${tailTurnsToDrop}, userMessages=${messages.length})`,
          );
        }
        const forked = await proc.request({ type: 'fork', entryId });
        if (!forked.success) throw new Error(`pi rewind fork failed: ${forked.error ?? 'unknown'}`);
        const state = await proc.request({ type: 'get_state' });
        if (!state.success) throw new Error(`pi rewind get_state failed: ${state.error ?? 'unknown'}`);
        const replacement = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
        if (!replacement) throw new Error('pi rewind replacement session path unavailable');
        sdkSessionId = replacement;
        queue.push({ type: 'session_id', data: replacement, source: 'pi' });
        return { sdkSessionId: replacement };
      },

      async getSessionTree(): Promise<SessionTreeSnapshot> {
        const resp = await proc.request({ type: 'get_tree' });
        if (!resp.success) throw new Error(`pi get_tree failed: ${resp.error ?? 'unknown'}`);
        return normalizePiSessionTree(resp.data);
      },

      async navigateSessionTree(
        entryId: string,
        options: NavigateSessionTreeOptions = {},
      ): Promise<NavigateSessionTreeResult> {
        if (!entryId || entryId.length > 128) throw new Error('pi session tree: invalid entry id');
        if (ctx.isStreaming) throw new Error('SESSION_RUNNING: 会话进行中，无法切换分支');
        const customInstructions = options.customInstructions?.trim();
        if (customInstructions && customInstructions.length > 4_000) {
          throw new Error('pi session tree: summary instructions too long');
        }
        const label = options.label?.trim();
        if (label && label.length > 120) throw new Error('pi session tree: label too long');

        const before = await proc.request({ type: 'get_tree' });
        if (!before.success) throw new Error(`pi get_tree failed: ${before.error ?? 'unknown'}`);
        const selected = findPiTreeEntry(before.data, entryId);
        if (!selected) throw new Error(`pi session tree entry not found: ${entryId}`);
        const payload = encodeURIComponent(JSON.stringify({
          entryId,
          summarize: options.summarize === true,
          ...(customInstructions ? { customInstructions } : {}),
          ...(label ? { label } : {}),
        }));
        const switched = await proc.request(
          { type: 'prompt', message: `/cindy-branch-switch ${payload}` },
          { timeoutMs: PI_BRANCH_NAVIGATION_TIMEOUT_MS },
        );
        if (!switched.success) {
          throw new Error(`pi branch navigation failed: ${switched.error ?? 'unknown'}`);
        }

        const after = await proc.request({ type: 'get_tree' });
        if (!after.success) throw new Error(`pi get_tree after navigation failed: ${after.error ?? 'unknown'}`);
        const tree = normalizePiSessionTree(after.data);
        const draftText = userDraftTextFromPiEntry(selected);
        // get_session_stats.contextUsage 是 pi 自己用于 compaction/footer 的权威估算，
        // 比从最后一条 assistant usage 反推更准确（尤其是 compaction/branch summary 后）。
        const stats = await proc.request({ type: 'get_session_stats' });
        const contextUsage = stats.success
          ? (stats.data as {
              contextUsage?: { tokens?: number | null; contextWindow?: number | null };
            } | undefined)?.contextUsage
          : undefined;
        const contextTokens = typeof contextUsage?.tokens === 'number' && contextUsage.tokens >= 0
          ? contextUsage.tokens
          : piContextTokensFromTree(after.data, tree);
        const contextWindow = typeof contextUsage?.contextWindow === 'number' && contextUsage.contextWindow > 0
          ? contextUsage.contextWindow
          : ctx.contextWindow;
        ctx.contextTokens = contextTokens;
        ctx.contextWindow = contextWindow;
        return {
          tree,
          messages: activePiHistoryFromTree(after.data, tree),
          contextTokens,
          contextWindow,
          ...(draftText ? { draftText } : {}),
        };
      },

      async getContextUsage() {
        const stats = await proc.request({ type: 'get_session_stats' });
        if (!stats.success) {
          throw new Error(`pi get_session_stats failed: ${stats.error ?? 'unknown'}`);
        }
        const contextUsage = (stats.data as {
          contextUsage?: { tokens?: number | null; contextWindow?: number | null };
        } | undefined)?.contextUsage;
        const totalTokens = typeof contextUsage?.tokens === 'number' && contextUsage.tokens >= 0
          ? contextUsage.tokens
          : ctx.contextTokens;
        const maxTokens = typeof contextUsage?.contextWindow === 'number' && contextUsage.contextWindow > 0
          ? contextUsage.contextWindow
          : ctx.contextWindow;
        const percentage = maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0;
        return {
          categories: [{ name: 'Messages', tokens: totalTokens, color: '#8b8b8b' }],
          totalTokens,
          maxTokens,
          rawMaxTokens: maxTokens,
          percentage,
          gridRows: [],
          model: mutableModel,
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: {
            input_tokens: ctx.turnInput,
            output_tokens: ctx.turnOutput,
            cache_creation_input_tokens: ctx.turnCacheWrite,
            cache_read_input_tokens: ctx.turnCacheRead,
          },
        };
      },
    };

    return handle;
  }

  async getMemoryStatus(): Promise<MemoryStatus> {
    const manager = this.deps.makerMemory;
    const state = manager?.getState();
    return {
      enabled: (this.memoryOverride ?? true) && (manager?.isEnabled() ?? false),
      source: this.memoryOverride === undefined ? 'agent-default' : 'host-runtime',
      ...(state ? { stats: { entryCount: state.activeWorkdirs.length } } : {}),
    };
  }

  async setMemory(enabled: boolean): Promise<MemorySetResult> {
    this.memoryOverride = enabled;
    // Live session 已捕获 compaction callback；下一次 session 采用新值。
    return { effective: 'next-session' };
  }

  async resetMemory(): Promise<MemoryResetResult> {
    const result = await this.deps.makerMemory?.resetDigests();
    return { removedEntries: result?.removedCount ?? 0 };
  }

  /**
   * 会话分支(fork）—— 与 Codex 粗粒度 fork 同构。
   *
   * pi 的会话是 append-only entry 树,提供两条纯文件操作(不调模型):
   *   - clone:整条复制当前活动分支成新 session 文件并切过去(get_state.sessionFile 给新路径)
   *   - fork{entryId}:rewind 到某条 user 消息之前,同样落新 session 文件
   * 二者都离线,故这里 spawn 一个短命 `pi --mode rpc --offline` one-shot 进程完成,
   * 无需网关、无需真凭证。
   *
   * 语义映射(对齐 ForkSdkSessionOptions):
   *   - tailTurnsToDrop=0 → clone(整条 fork)
   *   - tailTurnsToDrop=N → fork 到倒数第 N 条 user 消息(丢掉尾部 N 个 turn);越界退化为 clone
   *   - upToMessageId 被忽略(pi 的锚点是 entry id,非 SDK message uuid;与 Codex 一致)
   *   - uuidMap 返回空(pi agentMeta 不落 SDK uuid,host 无处可 remap,不会 break 再 fork)
   */
  async forkSdkSession(opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    const log = this.deps.logger;
    const agentHome = this.resolveAgentHome();
    const sessionDir = path.join(agentHome, 'sessions');
    // 离线 fork 只需 models.json 里有 `cindy` 供应商供 pi 启动校验 --provider。
    // 不能写共享的 agentHome/models.json:另一窗口正启动 BYOM 会话时(startSession
    // 写入 native providers 后到 spawn 之间还有多个 await),本处覆盖会把该 provider
    // 清掉,导致那个 spawn 携带 --provider <byom> 却找不到而启动失败(codex review)。
    // 用隔离的 coding-agent 目录承载 fork 专属 models.json(PI_CODING_AGENT_DIR),
    // --session-dir 仍指向共享 sessions(两者是独立 flag),互不干扰。
    const forkHome = path.join(agentHome, 'fork-tmp', randomBytes(8).toString('hex'));
    await this.writeModelsJson(forkHome);

    // fork 全程离线(clone/fork 是纯 session 文件操作),真凭证拿不到也不影响;
    // 尽量取真 authEnv(含网关相关变量),失败则占位。
    const credentialMode = resolveAgentCredentialMode({ agentKind: 'pi' }) ?? 'gateway-key';
    let authEnv: Record<string, string | undefined> = {};
    try {
      authEnv = await this.deps.auth.getAuthEnv({ credentialMode });
    } catch {
      /* offline fork 不需要真凭证 */
    }

    // 模型 id 必须在 models.json 内(pi 启动校验 --model);用 host 注入的首个可用模型。
    const forkModel = this.capabilities.availableModels[0]?.id ?? 'claude-sonnet-5';

    const proc = new PiRpcProcess({
      binaryPath: this.deps.binaryPath,
      args: [
        '--mode', 'rpc',
        '--session-dir', sessionDir,
        '--session', opts.sourceSdkSessionId,
        '--provider', PI_PROVIDER_ID,
        '--model', forkModel,
        '--no-context-files',
        '--offline',
      ],
      cwd: opts.workingDir && opts.workingDir.trim().length > 0 ? opts.workingDir : sessionDir,
      env: {
        ...process.env,
        ...authEnv,
        [PI_API_KEY_ENV]: authEnv[PI_API_KEY_ENV] ?? 'pi-fork-offline',
        // 隔离的 models.json 家目录(见上);session 文件仍由 --session-dir 提供。
        PI_CODING_AGENT_DIR: forkHome,
      },
      logger: log,
      onEvent: () => {},
      onExit: () => {},
    });

    try {
      // 首个 get_state 兼作"进程就绪"探测。
      const ready = await proc.request({ type: 'get_state' });
      if (!ready.success) {
        throw new Error(`pi fork: session load failed: ${ready.error ?? 'unknown'}`);
      }

      const tailDrop = normalizeTailTurnsToDrop(opts.tailTurnsToDrop);
      if (tailDrop > 0) {
        const fm = await proc.request({ type: 'get_fork_messages' });
        // 必须查 success:失败时 fm.data 为空会让 idx 恒负,误落"越界→整条 clone"分支,
        // 把 RPC 故障静默降级成"保留全部历史"(用户要丢尾却拿到全量),且日志误导排障。
        if (!fm.success) {
          throw new Error(`pi get_fork_messages failed: ${fm.error ?? 'unknown'}`);
        }
        const messages =
          (fm.data as { messages?: Array<{ entryId?: string }> } | undefined)?.messages ?? [];
        const idx = messages.length - tailDrop;
        const target = idx >= 0 ? messages[idx]?.entryId : undefined;
        if (target) {
          const fk = await proc.request({ type: 'fork', entryId: target });
          if (!fk.success) throw new Error(`pi fork(entryId) failed: ${fk.error ?? 'unknown'}`);
        } else {
          // 越界(要丢的 turn 比 user 消息还多）→ 退化为整条 clone,不静默丢语义。
          log.warn('pi fork: tailTurnsToDrop out of range, falling back to full clone', {
            tailTurnsToDrop: tailDrop,
            userMessageCount: messages.length,
          });
          const cl = await proc.request({ type: 'clone' });
          if (!cl.success) throw new Error(`pi clone failed: ${cl.error ?? 'unknown'}`);
        }
      } else {
        const cl = await proc.request({ type: 'clone' });
        if (!cl.success) throw new Error(`pi clone failed: ${cl.error ?? 'unknown'}`);
      }

      const st = await proc.request({ type: 'get_state' });
      const newPath = (st.data as { sessionFile?: string } | undefined)?.sessionFile;
      if (!newPath || newPath.trim().length === 0) {
        throw new Error('pi fork: forked session file path unavailable');
      }

      if (opts.title && opts.title.trim().length > 0) {
        await proc
          .request({ type: 'set_session_name', name: opts.title })
          .catch((err: unknown) =>
            log.warn('pi fork: set_session_name failed (non-fatal)', {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
      }

      log.info('pi forkSdkSession ◀', {
        source: opts.sourceSdkSessionId,
        newSdkSessionId: newPath,
        tailTurnsToDrop: tailDrop,
      });
      // uuidMap 空:与 Codex 一致,pi agentMeta 不存 SDK message uuid。
      return { newSdkSessionId: newPath, uuidMap: new Map() };
    } finally {
      await proc.close();
      // 清理隔离的 fork 家目录(只含 models.json;新分支 session 文件在共享 sessions,不受影响)。
      await fs.rm(forkHome, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * ChatInput `/` palette 的 agent-skill 类目 —— 纯文件系统发现,与 CC/Codex 对齐。
   *
   * 扫共享根 ~/.agents/skills(cc/codex 同源,pi 因此看到一致的技能包)+ pi 原生
   * ~/.pi/agent/skills + 项目目录。只暴露技能"存在"(name/description),技能正文仅
   * 在 /skill:name 被调用时进上下文 —— 故此发现层零基线上下文增长(契合精简 pi)。
   */
  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    const { items, errors } = await scanPiCustomizations({
      workingDirs: opts.workingDir ? [opts.workingDir] : [],
    });
    const out: ListAgentSkillsResult = {
      skills: items
        .filter((it) => it.kind === 'skill' && it.enabled !== false)
        .map((it) => ({
          kind: 'agent-skill' as const,
          name: it.name,
          description: it.description,
          source: 'skill' as const,
          path: it.absolutePath,
          scope: (it.scope === 'repo' ? 'repo' : 'user') as 'user' | 'repo',
          enabled: it.enabled ?? true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    if (errors.length > 0) out.errors = errors;
    return out;
  }

  /**
   * pi extension UI 子协议桥。
   *
   * cindy-bridge 的权限询问走 confirm(title='cindy:permission', message=JSON
   * {toolName, input}),映射成 InteractionRequest(kind='permission')交给
   * cindy 审批 UI;resolver 缺失或抛错一律 deny(fail-closed —— ask 档没人接
   * 不得放行)。其它 dialog 请求 cancelled 兜底,不挂死 agent loop。
   *
   * auto 档 dispatcher:弹窗前先过 Cindy Auto-Review Core(pi adapter 见
   * auto-review-policy.ts)—— 本地绿灯静默放行,灰区交当前会话模型轻量诊断,
   * 确定性红线或 reviewer 明确 `ask` 才升级弹窗。reviewer 缺失/超时/抛错均
   * 静默 deny,让主 Agent 改用更安全的做法。
   */
  private handleExtensionUiRequest(
    event: PiRpcEvent,
    proc: PiRpcProcess,
    getPermissionCtx: () => {
      resolver: InteractionResolver | null;
      permissionMode: 'ask' | 'auto' | 'bypassPermissions';
      workspaceRoots: string[];
      readRoots: string[];
      reviewAutoAction: (action: ReviewableAction) => Promise<AutoReviewDecision>;
    },
  ): void {
    const method = typeof event.method === 'string' ? event.method : '';
    const id = typeof event.id === 'string' ? event.id : undefined;
    if (!id) return;

    if (method === 'confirm' && event.title === 'cindy:permission') {
      let toolName = 'tool';
      let input: Record<string, unknown> = {};
      try {
        const payload = JSON.parse(typeof event.message === 'string' ? event.message : '{}') as {
          toolName?: unknown;
          input?: unknown;
        };
        if (typeof payload.toolName === 'string' && payload.toolName.length > 0) toolName = payload.toolName;
        if (payload.input && typeof payload.input === 'object') input = payload.input as Record<string, unknown>;
      } catch {
        /* keep defaults */
      }
      const {
        resolver,
        permissionMode,
        workspaceRoots,
        readRoots,
        reviewAutoAction,
      } = getPermissionCtx();
      const requestUserConfirmation = async (): Promise<boolean> => {
        if (!resolver) {
          this.deps.logger.warn('pi permission request denied: no interaction resolver', { toolName });
          return false;
        }
        try {
          const decision = await resolver({
            kind: 'permission',
            requestId: id,
            toolName,
            input,
          });
          return decision.kind === 'permission' && decision.behavior === 'allow';
        } catch (err) {
          this.deps.logger.warn('pi permission resolver failed; denying', {
            toolName,
            message: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      };
      void (async () => {
        if (permissionMode !== 'auto') {
          proc.send({
            type: 'extension_ui_response',
            id,
            confirmed: await requestUserConfirmation(),
          });
          return;
        }
        try {
          const action = normalizePiToolForAutoReview({
            toolName,
            input,
            workspaceRoots,
            readRoots,
          });
          const decision = await reviewAutoAction(action);
          // 权限热切换:reviewAutoAction 是 async 的,期间用户可能改档。按**最新**档位收口,
          // 不能用进入审查前捕获的旧 auto 档直接放行(Pi 明确支持热切换,codex review P1):
          //   - 已收紧到 ask(或其它非 auto/bypass)→ 破坏性调用即便 verdict=allow 也必须走
          //     用户确认;
          //   - 已切到 bypassPermissions(Full access)→ 直接放行(与 bypass 语义一致);
          //   - 仍是 auto → 按本次审查 verdict 收口(下方原逻辑)。
          const modeAfterReview = getPermissionCtx().permissionMode;
          if (modeAfterReview === 'bypassPermissions') {
            proc.send({ type: 'extension_ui_response', id, confirmed: true });
            return;
          }
          if (modeAfterReview !== 'auto') {
            proc.send({
              type: 'extension_ui_response',
              id,
              confirmed: await requestUserConfirmation(),
            });
            return;
          }
          if (decision.verdict === 'ask') {
            proc.send({
              type: 'extension_ui_response',
              id,
              confirmed: await requestUserConfirmation(),
            });
            return;
          }
          if (decision.verdict === 'block') {
            this.deps.logger.debug('pi auto-review blocked tool call', {
              toolName,
              reason: decision.reason,
            });
          }
          proc.send({
            type: 'extension_ui_response',
            id,
            confirmed: decision.verdict === 'allow',
          });
        } catch (err) {
          this.deps.logger.warn('pi auto-review failed; denying', {
            toolName,
            message: err instanceof Error ? err.message : String(err),
          });
          proc.send({ type: 'extension_ui_response', id, confirmed: false });
        }
      })();
      return;
    }

    const isDialog = method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
    if (!isDialog) return;
    this.deps.logger.warn('pi extension dialog auto-cancelled (no mapping)', { method });
    proc.send({ type: 'extension_ui_response', id, cancelled: true });
  }
}
