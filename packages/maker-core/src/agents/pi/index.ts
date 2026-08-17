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
 * SSH remote:远端会话由 host 注入的 getRemotePiTransport 承担(createSshPiDaemonTransport,
 * 经 pi-manager daemon 持久;见 pi-remote-transport.ts)—— 远端路径真实存在, 文件头不再
 * 写「尚未支持」。跨设备控制仍走 device-link, 在目标设备本地启动 Pi。
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * 轮 40-w4-t5 CRITICAL:远端 agentHome 是 POSIX 路径($HOME/... 或展开后的
 * /home/...), 平台相关 path.join 在 Windows 上会拼出反斜杠
 * ($HOME\.xdt-server\...), 经 fileOps 单引号 quote 后远端 bash 不展开 $HOME
 * 也不认反斜杠分隔 —— 数据写到错误路径。所有远端派生路径必须 POSIX join。
 */
function joinRemotePosixPath(...parts: string[]): string {
  return path.posix.join(...parts);
}

/**
 * 轮 21-W1 HIGH:sdkSessionId(pi get_state 的 sessionFile/sessionId)是 resume 的
 * 权威键, 直接持久化并被 workflow 回读。异常/损坏的 pi 输出(远端被攻破或
 * 半崩溃)可能回传任意值 → 跨会话误路由或把恢复状态绑到错误会话。fail-closed:
 * 非空字符串 + 长度上限 + 无控制字符(换行/NUL 会破坏 DB 行与 resume 参数),
 * 不满足则抛错拒绝启动(与「拿不到 session 身份就 refuse」同语义)。
 * 合法 pi 的 sessionFile 是绝对路径 / sessionId 是 UUID, 两者都远小于上限。
 */
function validateSdkSessionId(value: string): string {
  if (value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new Error(
      'pi get_state returned an unsafe sessionFile/sessionId (empty, overlong, or containing control characters) — refusing to start',
    );
  }
  return value;
}

import {
  AgentNotAuthenticatedError,
  BaseAgent,
  TurnDispatchRejectedError,
  TurnDispatchUnconfirmedError,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
  type PiExtraSpawnConfig,
  type PiNativeModelSpec,
  type PiNativeProviderSpec,
  type SendOptions,
  type StartSessionOptions,
  type TurnPermissionPolicy,
} from '../base-agent.js';
import {
  CINDY_BRIDGE_EXTENSION_FILENAME,
  CINDY_BRIDGE_EXTENSION_SOURCE,
} from './cindy-bridge-source.js';
import {
  CINDY_SUBAGENT_ENV,
  CINDY_SUBAGENT_EXTENSION_FILENAME,
  CINDY_SUBAGENT_EXTENSION_SOURCE,
} from './cindy-subagent-source.js';
import { normalizePiToolForAutoReview } from './auto-review-policy.js';
import {
  annotatePermissionRequestForUnavailableReview,
  createAutoReviewConfirmUndeliveredNotice,
  createAutoReviewUnavailableNotice,
  extractAutoReviewUserIntent,
  isSystemPermissionDenialReason,
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
import type { ListCustomizationsOptions, ListCustomizationsResult } from '../../types/customizations.js';
import { scanPiCustomizations } from './customization-scanner.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { resolveMcpToolTarget } from '../shared/mcp-tool-target.js';
import {
  assertReviewMessageContentPaths,
  buildReviewReadGrants,
} from '../shared/review-read-scope.js';
import { resolveAgentCredentialMode } from '../credential-mode.js';
import { PiRpcProcess, type PiRpcEvent } from './rpc-client.js';
import { createPiStdioTransport, type PiTransport } from './transport.js';
import type { PiRemoteFileOps } from '../base-agent.js';
import { capturePiRuntimeCapabilityManifest } from './runtime-capabilities.js';
import {
  assembleApprovedPiProjectResources,
  reconcilePiProjectResourceRuntime,
  stageApprovedPiProjectResources,
  unavailablePiProjectResourceAssembly,
} from './project-resource-assembly.js';
import {
  createPiTranslateContext,
  disposePiTranslateContext,
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
import type { PiRuntimeCapabilityManifest } from '../../types/pi-runtime-capabilities.js';

const PI_PROVIDER_ID = 'cindy';
// 既非 Cindy 网关(cindy/xd)也非经 compat proxy 的订阅直连(openai/anthropic)的 providerId = 显式 BYOM
// 路由,必须在本会话解析出的 nativeProviders 里;缺席时不得静默回落网关(见 startSession /
// setModel 的 fail-closed)。xAI 已改走 Pi 原生 provider，同样必须解析成功。
const NON_BYOM_PROVIDER_IDS = new Set([PI_PROVIDER_ID, 'xd', 'openai', 'anthropic']);
const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_SESSION_ID_ENV = 'CINDY_PI_SESSION_ID';
const PI_SESSION_TOKEN_ENV = 'CINDY_PI_SESSION_TOKEN';
const PI_MCP_BRIDGE_ENV = 'CINDY_PI_MCP_BRIDGE';
const PI_SECRET_ENV_NAMES_ENV = 'CINDY_PI_SECRET_ENV_NAMES';
const PI_MANAGED_RG_PATH_ENV = 'CINDY_PI_MANAGED_RG_PATH';
/** 轮 42 P1:models.json 内容指纹(远端 daemon 启动身份的一部分, 值无凭证)。 */
const PI_MODELS_JSON_HASH_ENV = 'CINDY_PI_MODELS_JSON_HASH';
/** 远端权限/Extra Dir 快照指纹 —— 档位变则 envHash 变, daemon 重启而非覆盖热读文件。 */
const PI_PERMISSION_HASH_ENV = 'CINDY_PI_PERMISSION_HASH';
/** Cindy-owned extension 源码指纹。bridge/subagent 字节变则远端必须 restart，不能 reattach 到旧进程。 */
const PI_EXTENSION_BUNDLE_HASH_ENV = 'CINDY_PI_EXTENSION_BUNDLE_HASH';
/** 远端附件内联上限:超过则 fail-before-dispatch, 不静默截断。 */
const REMOTE_PI_ATTACHMENT_MAX_BYTES = 256 * 1024;
/**
 * Compatibility fallback for hosts that do not provide persistent derivation.
 * Desktop injects its owner-scoped safeStorage-backed deriver so restart and
 * reattach keep the same token; other hosts retain the previous process-stable
 * behavior without making the token derivable from the public session id alone.
 */
const PI_PROXY_SESSION_TOKEN_KEY = randomBytes(32);

/**
 * baseUrl 是否指向本机 loopback(远端会话不可达)。与 host 侧 isLoopbackUrl 同口径:
 * localhost / ::1 / 0.0.0.0 / **整个 127.0.0.0/8**(轮 42 P2 —— 只匹配 127.0.0.1
 * 会漏 127.0.1.1 等别名, 那些 URL 在远端解析到远端自己)。
 */
function isLoopbackOnlyBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
    // 127.0.0.0/8:第一段 127, 后三段任意。
    const m = /^127(?:\.\d{1,3}){3}$/.exec(host);
    if (m) {
      const parts = host.split('.').map(Number);
      return parts.every((p) => p >= 0 && p <= 255);
    }
    return false;
  } catch {
    return false; // 非法 URL 不判 loopback(其它校验兜底)
  }
}
const PI_IMAGE_INPUT_UNSUPPORTED_CODE = 'PI_IMAGE_INPUT_UNSUPPORTED';
/** 手动压缩 = 一次完整 LLM 摘要调用(大上下文 + 网关排队),远超默认 30s RPC 超时。 */
const PI_COMPACT_TIMEOUT_MS = 600_000;
/** prompt 接受前可能自动压缩，同样必须覆盖一次完整摘要调用。 */
const PI_PROMPT_ACCEPTANCE_TIMEOUT_MS = PI_COMPACT_TIMEOUT_MS;
const PI_PROMPT_ACCEPTANCE_PROGRESS_EVENTS = new Set([
  'compaction_start',
  'compaction_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
]);
/** 分支摘要同样可能触发一次完整 LLM 调用。 */
const PI_BRANCH_NAVIGATION_TIMEOUT_MS = 600_000;

/** PI 的 OpenAI Responses client 以 baseUrl 为 `/v1` 根；Anthropic client 则自行追加 `/v1/messages`。 */
function piResponsesBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

class PiImageInputUnsupportedError extends Error {
  readonly code = PI_IMAGE_INPUT_UNSUPPORTED_CODE;

  constructor() {
    super(
      `[${PI_IMAGE_INPUT_UNSUPPORTED_CODE}] Image input is not enabled for the current Pi model. ` +
        'Switch to an image-capable model, or enable image input for this custom model and start a new Pi task.',
    );
    this.name = 'PiImageInputUnsupportedError';
  }
}

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
/**
 * 轮 42 P1:远端会话 spawn env 路径的稳定派生段 —— sha256(sessionId) 前 12 hex。
 * 同 session 断链重连/恢复复用同一路径 → env 稳定 → envHash 稳定 → daemon
 * 纯 attach 保活。匿名会话(无 sessionId)无法跨 startSession 复用, 回落
 * randomBytes 语义(每次新路径, 无 attach 语义可言)。
 */
function stableSessionPathSegment(sid: string | undefined): string {
  if (!sid) return randomBytes(8).toString('hex');
  return createHash('sha256').update(sid).digest('hex').slice(0, 12);
}

function stableRemoteProxySessionToken(
  sid: string | undefined,
  hostDeriver?: (sessionId: string) => string,
): string {
  if (!sid) return randomBytes(32).toString('base64url');
  const token = hostDeriver
    ? hostDeriver(sid)
    : createHmac('sha256', PI_PROXY_SESSION_TOKEN_KEY).update(sid).digest('base64url');
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(token)) {
    throw new Error('pi: host returned an invalid proxy session token');
  }
  return token;
}

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
  env.NO_PROXY = Array.from(new Set([
    ...existing,
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
  ])).join(',');
  delete env.no_proxy;
}

/**
 * 把 host 已校验的 rg 复制到本会话私有 bin。
 *
 * Pi 上游 grep 会先从 PI_CODING_AGENT_DIR/bin 解析工具并返回该绝对路径；find bridge
 * 也直接 spawn 同一路径。不能只改 PATH：Windows executable lookup 会先看 cwd，仓库里的
 * rg.exe 便可劫持自动放行的只读工具并继承 Pi 父进程凭证。
 */
async function stageManagedRipgrep(
  configHome: string,
  sourcePath: string | undefined,
): Promise<string | undefined> {
  if (!sourcePath) return undefined;
  if (!path.isAbsolute(sourcePath)) {
    throw new Error('pi: managed ripgrep path must be absolute');
  }
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error('pi: managed ripgrep path must point to a file');
  }

  const binDir = joinRemotePosixPath(configHome, 'bin');
  const targetPath = path.join(binDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
  await fs.mkdir(binDir, { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  if (process.platform !== 'win32') await fs.chmod(targetPath, 0o755);
  return targetPath;
}

/** cindy Effort → pi thinking level(pi 无 ultra;cindy 无 off)。 */
function effortToPiThinkingLevel(effort: Effort): string {
  return effort === 'ultra' ? 'max' : effort;
}

const PI_NATIVE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 从本次启动写入 models.json 的 native model 快照提取可用 effort。 */
function startupEffortsOfNativeModel(model: PiNativeModelSpec | undefined): readonly Effort[] | undefined {
  if (!model) return undefined;
  if (model.thinkingLevelMap) {
    return PI_NATIVE_THINKING_LEVELS.filter((effort) => model.thinkingLevelMap?.[effort] != null);
  }
  // writeModelsJson 对缺省 reasoning 同样序列化为 false；因此缺省与显式 false
  // 都必须冻结为空能力，不能把 renderer 后续热刷出的 effort 放行给旧进程。
  return model.reasoning === true ? undefined : [];
}

/**
 * 启动时把任务里持久化的旧 effort 与当前 provider/model 的能力重新对齐。
 * 已支持档原样保留；能力未知/未声明档位时维持旧行为；只有明确不支持时才落到
 * 当前模型的合法默认档（病态 default 再落首档），避免 thinkingLevelMap 将旧档映成 null。
 */
function reconcilePiStartupEffort(
  requested: Effort | undefined,
  model: ModelDescriptor | undefined,
): Effort | undefined {
  if (!requested || !model || model.efforts.length === 0) return requested;
  if (model.efforts.includes(requested)) return requested;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) {
    return model.defaultEffort;
  }
  return model.efforts[0];
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
async function buildPiPrompt(
  message: UserMessage,
  opts?: { remote?: boolean },
): Promise<{ text: string; images: PiPromptImage[] }> {
  if (typeof message.content === 'string') {
    return { text: message.content, images: [] };
  }
  const remote = Boolean(opts?.remote);
  const textParts: string[] = [];
  const images: PiPromptImage[] = [];
  for (const block of message.content as UserContentBlock[]) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text);
        break;
      case 'mention':
        // 远端 Pi 读不到本机路径; mention 只是引用提示, 不内联目录/文件内容。
        if (remote) {
          throw new Error(
            `pi: remote sessions cannot use local path mentions (${block.path}) — the remote Pi process cannot read desktop paths`,
          );
        }
        textParts.push(`\`${block.path}\``);
        break;
      case 'file':
        if (remote) {
          // 远端 Pi 读不到本机路径。内联文本内容;二进制/超大文件 fail-before-dispatch,
          // 避免 turn 被接受但附件静默丢失,或远端同路径文件被误读。
          let data: Buffer;
          try {
            const stat = await fs.stat(block.path);
            if (stat.size > REMOTE_PI_ATTACHMENT_MAX_BYTES) {
              throw new Error(
                `pi: remote file attachment ${block.path} is ${stat.size} bytes (limit ${REMOTE_PI_ATTACHMENT_MAX_BYTES}) — upload to the remote host or send a smaller file`,
              );
            }
            data = await fs.readFile(block.path);
          } catch (err) {
            if (err instanceof Error && err.message.startsWith('pi: remote file attachment')) throw err;
            throw new Error(
              `pi: failed to read file attachment ${block.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (data.length > REMOTE_PI_ATTACHMENT_MAX_BYTES) {
            throw new Error(
              `pi: remote file attachment ${block.path} is ${data.length} bytes (limit ${REMOTE_PI_ATTACHMENT_MAX_BYTES}) — upload to the remote host or send a smaller file`,
            );
          }
          const name = path.basename(block.path);
          if (data.includes(0)) {
            throw new Error(
              `pi: remote sessions cannot inline binary file attachments (${name}) — upload the file to the remote host first`,
            );
          }
          textParts.push(
            `Attached file \`${name}\` (inlined from desktop; remote Pi cannot read the original path):\n\`\`\`\n${data.toString('utf8')}\n\`\`\``,
          );
          break;
        }
        textParts.push(`Attached file (read-only reference): \`${block.path}\``);
        break;
      case 'image': {
        // 轮 40-w4-t6 CRITICAL:用户显式发送的图片读取失败不得静默降级为文本
        // 占位 —— 否则 DB/UI 显示已发送图片但 Pi 实际只收到「图片不可用」,
        // 消息内容丢失且不可恢复。fail-before-dispatch:抛错让 Session.send
        // 未 accepted / 事务回滚, 用户看到可恢复错误。
        let data: Buffer;
        try {
          data = await fs.readFile(block.path);
        } catch (err) {
          throw new Error(
            `pi: failed to read image attachment ${block.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        images.push({
          type: 'image',
          data: data.toString('base64'),
          mimeType: guessImageMime(block.path, block.mimeType),
        });
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

interface FailedPiStartupCleanup {
  proc: PiRpcProcess;
  promise: Promise<void> | null;
  cleanupLocal?: () => void;
}

export class PiAgent extends BaseAgent {
  readonly kind: AgentKind = 'pi';
  readonly capabilities: Capabilities;
  private readonly failedStartupCleanups = new Map<string, FailedPiStartupCleanup>();
  private readonly inFlightStartups = new Set<Promise<AgentSessionHandle>>();
  private disposeStarted = false;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(PiAgent.baseCapabilities());
  }

  private async retryFailedStartupCleanup(
    sessionId: string,
    expectedEntry?: FailedPiStartupCleanup,
  ): Promise<void> {
    const entry = this.failedStartupCleanups.get(sessionId);
    if (!entry || (expectedEntry && entry !== expectedEntry)) return;
    const cleanup = entry.promise ?? entry.proc.close();
    entry.promise = cleanup;
    try {
      await cleanup;
    } catch (error) {
      if (this.failedStartupCleanups.get(sessionId) === entry && entry.promise === cleanup) {
        entry.promise = null;
      }
      throw error;
    }
    if (this.failedStartupCleanups.get(sessionId) === entry) {
      this.failedStartupCleanups.delete(sessionId);
      entry.cleanupLocal?.();
    }
  }

  override async dispose(): Promise<void> {
    this.disposeStarted = true;
    const startupSnapshot = Array.from(this.inFlightStartups);
    await Promise.allSettled(startupSnapshot);

    // startSession registers before yielding and new starts are fenced above,
    // so every failed pre-publication process is now visible in this snapshot.
    const cleanupSnapshot = Array.from(this.failedStartupCleanups.entries());
    const results = await Promise.allSettled(
      cleanupSnapshot.map(([sessionId, entry]) =>
        this.retryFailedStartupCleanup(sessionId, entry),
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Pi startup process cleanup remains unconfirmed');
    }
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
      // Host 每轮权限策略(个人微信 / Telegram 群等远程渠道):在 handleExtensionUiRequest
      // 的工具审批边界上,先于 MCP auto-approve 与 auto 档 Auto-Review 强制确认命中的调用。
      // bypassPermissions 下 cindy-bridge 直接放行、tool_call 不冒泡,host 无从执行策略 ——
      // 因此把 Full Access 列为不支持,由 host 在 provider 启动前 fail-closed 拒绝该组合,
      // 而不是给出无法兑现的"强制确认"承诺(与 CC/Codex 同口径)。
      turnPermissionPolicy: {
        supported: { supported: true },
        unsupportedPermissionModes: ['bypassPermissions'],
      },
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
      // Pi 的 get_commands runtime catalog 通过 per-session handle 查询；
      // manifest 本身在 ready/fork 后异步采集，暂不可用不代表能力不支持。
      runtimeCapabilities: { supported: true },
    };
  }

  /** host 注入的 pi 配置目录(auth/models/settings/sessions);缺省落系统临时目录。 */
  private resolveAgentHome(remoteHostId?: string | null): string {
    const injected = this.deps.resolvePiAgentHome?.(remoteHostId);
    if (injected && injected.trim().length > 0) return injected;
    // 轮 22 MEDIUM-4:兜底路径在远端会话必须是 POSIX —— Windows 上
    // os.tmpdir() 是 C:\...\Temp, 经 fileOps.mkdirp 送到远端 Linux 会创建
    // 含反斜杠的字面目录名。
    // 轮 40-w4-t3 CRITICAL:远端 agentHome 承载 session 历史(sessions/*.jsonl)
    // 与 DB sdk_session_id 持久关联 —— /tmp 会被远端重启/系统 tmp cleaner
    // 清掉, resume 时静默 fresh fallback + 覆盖 DB。迁到远端用户持久目录
    // ($HOME/.xdt-server/v1/pi-agent-home, 与 pi-manager 安装目录同级);
    // run-tmp/env-file 等短生命周期内容仍由各路径单独放临时目录。
    if (remoteHostId) {
      return '$HOME/.xdt-server/v1/pi-agent-home';
    }
    return path.join(os.tmpdir(), 'cindy-pi-agent-home');
  }

  /**
   * 构造 pi RPC 进程的字节流 transport。
   *
   * 本地:createPiStdioTransport(spawn `pi --mode rpc`, 接 stdin/stdout)。
   * 远端(remoteHostId 且 host 注入 getRemotePiTransport):交给 host 实现 ——
   * 通常是 RemoteHost.execStream 在远端跑同一命令、把 stdin/stdout 拽回本地
   * (SshPiTransport)。PiAgent 对两种来源的差异零感知(协议层只认行)。
   *
   * remoteBinaryPath:远端 pi 二进制绝对路径(host 已 probe)。需要它来决定
   * plan-mode 扩展路径 / subagent spawn env —— 本地场景即 this.deps.binaryPath。
   */
  private async createTransport(
    opts: {
      args: string[];
      cwd: string;
      env: Record<string, string | undefined>;
      sessionId?: string | null;
      hostProxyForwards?: ReadonlyArray<{
        localUrl: string;
        remotePort: number;
      }>;
    },
    onProcessSpawned?: (pid: number) => void | (() => void),
    remoteHostId?: string | null,
    remoteBinaryPath?: string,
  ): Promise<{ transport: PiTransport; remoteBinaryPath: string | undefined }> {
    if (remoteHostId && this.deps.getRemotePiTransport) {
      const transport = await this.deps.getRemotePiTransport(remoteHostId, {
        binaryPath: this.deps.binaryPath,
        // startSession 已在 plan-mode 段前 resolve;host 侧有 cache,重复 probe 秒回。
        remoteBinaryPath: remoteBinaryPath ?? this.deps.binaryPath,
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        logger: this.deps.logger,
        sessionId: opts.sessionId ?? null,
        hostProxyForwards: opts.hostProxyForwards,
      });
      return { transport, remoteBinaryPath: transport.remoteBinaryPath ?? remoteBinaryPath };
    }
    return {
      transport: createPiStdioTransport({
        binaryPath: this.deps.binaryPath,
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        logger: this.deps.logger,
        onProcessSpawned,
      }),
      remoteBinaryPath: undefined,
    };
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
    gatewayProviderId?: string | null,
    opts: { remote?: boolean; fileOps?: PiRemoteFileOps; preview?: boolean } = {},
  ): Promise<{
    gatewayImageInputByModel: Map<string, boolean>;
    gatewayApiByModel: Map<string, 'anthropic-messages' | 'openai-responses'>;
    /** models.json 内容 sha256 —— 远端 daemon 启动身份的一部分(轮 42 P1)。 */
    modelsJsonHash: string;
  }> {
    // 远端:baseUrl 用 host 注入的 upstream endpoint(remoteEndpoint,gateway key 同源),
    // 不用本地 loopback compat proxy(远端够不到)。订阅 OAuth 的 loopback 分流远端不可达,
    // 远端恒走 gateway-key(见 docs/research/pi-ssh-remote-feasibility.md §2)。
    const endpoint = opts.remote
      ? this.deps.runtimeConfig.remoteEndpoint
      : this.deps.runtimeConfig.endpoint;
    if (!endpoint) {
      // 远端缺 remoteEndpoint(host 未装配/网关凭据未就绪):
      // - 有 BYOM native provider → 不 throw(BYOM 用自己的 baseUrl + env key 可跑);
      //   cindy gateway 块写 127.0.0.1:0(无调用方选它, 纯摆设, 与本地缺 endpoint 同款)。
      // - 纯 gateway(无 BYOM)→ fail-fast,不静默写 127.0.0.1:0 让会话「看似启动、
      //   首回合网络错误」(对齐 CC 的 [REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE] guard)。
      // 轮 42 P1(codex-connector):BYOM-only 用户不该被 XD gateway 凭据挡住。
      if (opts.remote && nativeProviders.length === 0) {
        throw new Error(
          '[REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE] Remote Pi sessions need the XD gateway endpoint issued after sign-in (runtimeConfig.remoteEndpoint is empty)',
        );
      }
      this.deps.logger.warn('pi: runtimeConfig.endpoint missing — models.json will have no usable provider');
    }
    const publicModels = this.capabilities.availableModels;
    const runtimeModels = retainedRuntimeModel && !publicModels.some((m) => m.id === retainedRuntimeModel.id)
      ? [...publicModels, retainedRuntimeModel]
      : publicModels;
    const gatewayImageInputByModel = new Map<string, boolean>();
    const gatewayApiByModel = new Map<string, 'anthropic-messages' | 'openai-responses'>();
    const models = runtimeModels.map((publicModel: ModelDescriptor) => {
      // availableModels 为跨 provider 拍平的公开能力；BYOM 同 id 冲突时 effort
      // 会按设计收敛成交集。cindy gateway 块则代表内置路由，必须回查其
      // provider-aware 描述符，不能被同名 non-reasoning BYOM 清空 reasoning。
      // host 未注入 resolver 或只有 BYOM 条目时保留旧 flat fallback。
      const m = this.deps.resolvePiGatewayModelDescriptor?.(
        gatewayProviderId,
        publicModel.id,
      ) ?? publicModel;
      const resolvedApi = this.deps.resolvePiGatewayModelApi?.(gatewayProviderId, m.id);
      if (
        resolvedApi === null ||
        (resolvedApi !== undefined &&
          resolvedApi !== 'anthropic-messages' &&
          resolvedApi !== 'openai-responses')
      ) {
        throw new Error(`Model Access v3 did not provide a Pi wire protocol for model: ${m.id}`);
      }
      // undefined 明确表示该模型不属于 XD Pi 目录。订阅直连及 BYOM-only 模型仍需出现在
      // cindy compat provider 的模型表中，沿用它们既有的 Messages 前门；只有 null 才是
      // “属于 XD 但 v3 配置不完整”，上面已 fail closed。
      const api = resolvedApi ?? 'anthropic-messages';
      gatewayApiByModel.set(m.id, api);
      const supportsImageInput = m.supportsImageInput === true;
      gatewayImageInputByModel.set(m.id, supportsImageInput);
      return {
        id: m.id,
        name: m.displayName,
        // Pi 0.83 支持同一 provider 下逐模型覆盖 API/baseUrl。provider 身份仍是
        // `cindy`；Model Access v3 让 PI 固定命中 Gateway 的 `/v1/responses` 前门。
        // 该前门可由 Gateway 翻译到不同上游，不代表底层模型原生实现 Responses。
        api,
        ...(api === 'openai-responses' && endpoint
          ? { baseUrl: piResponsesBaseUrl(endpoint) }
          : {}),
        reasoning: m.efforts.length > 0,
        input: supportsImageInput ? ['text', 'image'] : ['text'],
        // Model Access v3 requires this value; never replace the server limit with a client guess.
        contextWindow: m.contextWindow,
        maxTokens: m.maxOutputTokens && m.maxOutputTokens > 0 ? m.maxOutputTokens : 32_000,
        // 计费单位与目录一致($/1M tokens);pi 按此自行计价,usage 事件的 cost 才有真值。
        cost: {
          input: m.cost?.input ?? 0,
          output: m.cost?.output ?? 0,
          cacheRead: m.cost?.cacheRead ?? 0,
          cacheWrite: m.cost?.cacheWrite ?? 0,
        },
      };
    });
    const providers: Record<string, unknown> = {
      [PI_PROVIDER_ID]: {
        name: 'Cindy AI',
        baseUrl: endpoint ?? 'http://127.0.0.1:0',
        api: 'anthropic-messages',
        apiKey: `$${PI_API_KEY_ENV}`,
        // 本地 loopback compat proxy 用 session headers 做订阅 OAuth 注入;远端打真上游
        // 网关(remoteEndpoint)不该带(对齐 claude-env「本地 proxy 专用物不上远端」)。
        ...(opts.remote
          ? {}
          : {
              headers: {
                'x-cindy-pi-session-id': `$${PI_SESSION_ID_ENV}`,
                'x-cindy-pi-session-token': `$${PI_SESSION_TOKEN_ENV}`,
              },
            }),
        models,
      },
    };
    for (const np of nativeProviders) {
      if (np.id === PI_PROVIDER_ID) {
        this.deps.logger.warn('pi: native provider id collides with gateway provider "cindy" — skipped', { id: np.id });
        continue;
      }
      const nativeModels = (
        np.inheritModels
          ? np.models.filter(
              (model) => model.api !== undefined || model.catalogAddition === true,
            )
          : np.models
      ).map((m) => ({
        id: m.wireId ?? m.id,
        name: m.name ?? m.id,
        ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
        ...(m.headers && Object.keys(m.headers).length > 0 ? { headers: m.headers } : {}),
        ...(m.api ? { api: m.api } : {}),
        reasoning: m.reasoning ?? false,
        ...(m.thinkingLevelMap ? { thinkingLevelMap: { ...m.thinkingLevelMap } } : {}),
        input: m.input ?? ['text'],
        contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 128_000,
        maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : 16_000,
        ...(m.cost ? { cost: structuredClone(m.cost) } : {}),
        ...(m.compat ? { compat: structuredClone(m.compat) } : {}),
        ...(m.samplingParams ? { samplingParams: structuredClone(m.samplingParams) } : {}),
      }));
      if (!np.inheritModels && !np.api) {
        throw new Error(`pi: native provider '${np.id}' has no default api`);
      }
      providers[np.id] = {
        name: np.name,
        baseUrl: np.baseUrl,
        ...(np.api ? { api: np.api } : {}),
        // keyless(本机 Ollama 等)也要给 dummy key,否则 pi /model 不显示该模型。
        apiKey: np.apiKeyEnvVar ? `$${np.apiKeyEnvVar}` : 'pi-native-keyless',
        ...(np.headers && Object.keys(np.headers).length > 0 ? { headers: np.headers } : {}),
        ...(nativeModels.length > 0 ? { models: nativeModels } : {}),
      };
    }
    const modelsJsonPath = joinRemotePosixPath(agentHome, 'models.json');
    const modelsJsonContent = JSON.stringify({ providers }, null, 2) + '\n';
    const modelsJsonHash = createHash('sha256').update(modelsJsonContent).digest('hex');
    const settingsJsonPath = joinRemotePosixPath(agentHome, 'settings.json');
    // The native ChatGPT adapter prefers WebSocket in auto mode. Cindy's
    // authenticated loopback proxy is an HTTP/SSE boundary, so pin SSE for the
    // isolated embedded runtime. Other PI providers ignore this transport knob.
    const settingsJsonContent = JSON.stringify({ transport: 'sse' }, null, 2) + '\n';
    if (!opts.preview) {
      // 诊断(排查 LAZY_CREATE_FAILED):远端写前留痕 —— 确认 writeModelsJson 是否
      // 执行、endpoint 是否有值、路径形态。
      this.deps.logger.info?.('pi writeModelsJson', {
        remote: opts.remote === true,
        hasFileOps: Boolean(opts.fileOps),
        endpointSet: Boolean(endpoint),
        modelsJsonPath,
        providerKeys: Object.keys(providers),
      });
      if (opts.fileOps) {
        await opts.fileOps.mkdirp(agentHome);
        // fileOps 远端写入内部已 umask 077(创建即 600,无 TOCTOU —— R5 H-1)。
        await opts.fileOps.writeFile(modelsJsonPath, modelsJsonContent);
        await opts.fileOps.writeFile(settingsJsonPath, settingsJsonContent);
        this.deps.logger.info?.('pi writeModelsJson done', { modelsJsonPath });
      } else {
        await fs.mkdir(agentHome, { recursive: true });
        // 控制面文件:显式 600,防同机其他用户读 BYOM baseUrl / provider 路由
        // (R5 安全审计 H-5)。
        await fs.writeFile(modelsJsonPath, modelsJsonContent, { mode: 0o600 });
        await fs.writeFile(settingsJsonPath, settingsJsonContent, { mode: 0o600 });
      }
    }
    return {
      gatewayImageInputByModel,
      gatewayApiByModel,
      // 轮 42 P1(codex-connector):models.json 内容 hash 纳入远端 daemon 启动身份
      // —— BYOM baseUrl/wire 或 gateway endpoint 变更会改写此文件, 但 env/cmd
      // 可能不变; 不加这个 daemon 会误判纯 attach 用旧配置。
      modelsJsonHash,
    };
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (this.disposeStarted) {
      throw new Error('Pi agent is disposing; refusing to start a new session');
    }
    const startup = this.startSessionWhileRunning(opts);
    this.inFlightStartups.add(startup);
    try {
      return await startup;
    } finally {
      this.inFlightStartups.delete(startup);
    }
  }

  private async startSessionWhileRunning(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const startupCleanupKey = opts.sessionId ?? '<anonymous>';
    // A previous pre-publication Pi process for this business session must be
    // confirmed dead before another spawn can begin.
    await this.retryFailedStartupCleanup(startupCleanupKey);
    // 轮 22 LOW-6:空串 remoteHostId 规范化 —— Boolean('') 是 false 会让会话
    // 被判定本地但后续仍把 '' 传给 resolvePiNativeProviders 等, 行为分裂。
    if (opts.remoteHostId === '') opts.remoteHostId = undefined;
    if (opts.remoteHostId && !this.deps.getRemotePiTransport) {
      throw new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: 'pi remote sessions require a host-provided getRemotePiTransport hook',
      });
    }
    const reviewMode = opts.reviewMode === true;

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
          providerId: opts.providerId,
          model: opts.model,
          resumeSessionId: opts.resumeSessionId,
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
    const nativeProviderBySourceId = new Map(
      nativeProviders
        .filter((provider) => provider.id !== PI_PROVIDER_ID)
        .map((provider) => [provider.sourceProviderId ?? provider.id, provider] as const),
    );
    const nativeProviderForSource = (
      providerId: string,
    ): PiNativeProviderSpec | undefined =>
      nativeProviderBySourceId.get(providerId) ?? nativeProviderById.get(providerId);
    const resolveNativeModelId = (providerId: string, model: string): string =>
      nativeProviderById.get(providerId)?.modelIdAliases?.[model] ?? model;
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
        const native = nativeProviderForSource(providerId);
        const nativeModel = native ? resolveNativeModelId(native.id, model) : model;
        return native?.models.some((candidate) => candidate.id === nativeModel)
          ? native.id
          : PI_PROVIDER_ID;
      }
      if (providerId === null) return PI_PROVIDER_ID;
      // 旧会话/旧客户端没有 providerId 时，只能按启动快照做兼容回退。每个 provider
      // 必须先应用自己的 alias：例如 xAI 的裸 `grok-4.6` 实际对应
      // `xai/grok-4.6`。若多个 native provider 都能解释同一个 id，则来源并不唯一，
      // 直接拒绝恢复，不能靠数组顺序猜一个端点，更不能把提示词改发到默认网关。
      const matches = nativeProviders.filter((provider) => {
        if (provider.id === PI_PROVIDER_ID) return false;
        if (
          provider.sourceProviderId !== undefined &&
          !(
            (provider.sourceProviderId === 'openai' && model.startsWith('chatgpt/')) ||
            (provider.sourceProviderId === 'xai' && model.startsWith('xai/')) ||
            (provider.sourceProviderId === 'anthropic' && model.startsWith('claude-'))
          )
        ) return false;
        const candidateModel = provider.modelIdAliases?.[model] ?? model;
        return provider.models.some((candidate) => candidate.id === candidateModel);
      });
      if (matches.length > 1) {
        throw new Error(
          `pi: provider-less model '${model}' matches multiple native providers `
          + `(${matches.map((provider) => provider.id).join(', ')}); refusing to guess an endpoint.`,
        );
      }
      return matches[0]?.id ?? PI_PROVIDER_ID;
    };
    const resolveWireModel = (providerId: string, model: string): string => {
      const nativeModel = resolveNativeModelId(providerId, model);
      return nativeProviderById
        .get(providerId)
        ?.models.find((candidate) => candidate.id === nativeModel)?.wireId ?? nativeModel;
    };
    const resolveSourceProvider = (providerId: string): string =>
      nativeProviderById.get(providerId)?.sourceProviderId ?? providerId;
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
      const native = nativeProviderForSource(providerId);
      const nativeModel = native ? resolveNativeModelId(native.id, model) : model;
      return !native || !native.models.some((candidate) => candidate.id === nativeModel);
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
    // 轮 42 P2(codex-connector):远端 Pi 会话 + baseUrl 指向本机 loopback 的 BYOM
    // provider 必须拒绝 —— 远端 pi 进程在 SSH 主机上连 localhost 连的是**远端
    // 自己**, 用户本机的 Ollama 等服务不可达, 首回合必然失败/错配(甚至连到远端
    // 无关服务)。与订阅 provider 拒绝同款 fail-fast, 引导换网关或远端可达的 BYOM。
    // 同时校验显式 providerId 与 legacy/default 路由 resolve 出的 native provider
    // (providerId 未持久化时 resolveProviderForModel 也能选出 BYOM)。
    if (opts.remoteHostId) {
      const candidateRuntimeIds = new Set<string>();
      if (opts.providerId && !NON_BYOM_PROVIDER_IDS.has(opts.providerId)) {
        const explicitNative = nativeProviderForSource(opts.providerId);
        if (explicitNative) candidateRuntimeIds.add(explicitNative.id);
      }
      if (
        initialProvider !== PI_PROVIDER_ID &&
        !NON_BYOM_PROVIDER_IDS.has(resolveSourceProvider(initialProvider))
      ) {
        candidateRuntimeIds.add(initialProvider);
      }
      for (const runtimeProviderId of candidateRuntimeIds) {
        const loopbackNative = nativeProviderById.get(runtimeProviderId);
        if (loopbackNative && isLoopbackOnlyBaseUrl(loopbackNative.baseUrl) && !loopbackNative.hostProxyForward) {
          throw new Error(
            `[REMOTE_LOCAL_ONLY_PROVIDER] pi: BYOM provider '${resolveSourceProvider(runtimeProviderId)}' baseUrl ${loopbackNative.baseUrl} is loopback-only — ` +
              'a remote Pi session runs on the SSH host and cannot reach a service on this machine; ' +
              'pick the XD gateway or a BYOM endpoint reachable from that host.',
          );
        }
      }
    }
    const initialWireModel = resolveWireModel(initialProvider, opts.model);
    // 先解析 native provider 再做 auth：老会话/远端控制端可能没有持久化 providerId，
    // 仍必须能从 model→provider 映射识别纯 BYOM，不能误落 Cindy gateway 登录门。
    // startup effort 快照也使用同一来源，因此必须在快照 resolver 之前完成初始化。
    const authProviderId =
      opts.providerId ??
      (initialProvider !== PI_PROVIDER_ID
        ? resolveSourceProvider(initialProvider)
        : opts.model.startsWith('chatgpt/')
          ? 'openai'
          : opts.model.startsWith('xai/')
            ? 'xai'
            : null);

    // availableModels 是跨 provider 拍平的公开选择面；启动旧任务时必须按实际来源重查
    // provider-aware 描述符，不能拿同 id 的内置/BYOM 首见条目校验持久化 effort。
    // 新建时若模型连公开清单都不在，仍不调用私有解析器（不借此放宽新选择准入）；resume
    // 才允许读取 disabled/retired 描述符继续运行。
    const publicRuntimeModel = this.capabilities.availableModels.find(
      (model) => model.id === opts.model,
    );
    const runtimeProviderId =
      opts.providerId === undefined && initialProvider !== PI_PROVIDER_ID
        ? resolveSourceProvider(initialProvider)
        : opts.providerId;
    const mayResolveRuntimeModel = publicRuntimeModel !== undefined || !!opts.resumeSessionId;
    const selectedRuntimeModel = mayResolveRuntimeModel
      ? this.deps.resolvePiRuntimeModelDescriptor?.(runtimeProviderId, opts.model)
        ?? publicRuntimeModel
      : undefined;

    // 恢复中的旧 Pi 网关会话仍需要 models.json 内存在当前模型,Pi 才能解析持久化的
    // --model。仅对真实 resume 且公开清单缺失的 compat 模型补一个私有描述符；不回写
    // capabilities,也不放宽 setModel / route guard。
    let retainedRuntimeModel: ModelDescriptor | undefined;
    if (
      opts.resumeSessionId &&
      initialProvider === PI_PROVIDER_ID &&
      !publicRuntimeModel
    ) {
      retainedRuntimeModel = selectedRuntimeModel;
      if (!retainedRuntimeModel) {
        this.deps.logger.warn('pi: selected model missing from public and retained runtime catalogs', {
          model: opts.model,
          providerId: opts.providerId ?? null,
        });
      }
    }
    const startupEffort = reconcilePiStartupEffort(opts.effort, selectedRuntimeModel);
    if (opts.effort && startupEffort !== opts.effort) {
      this.deps.logger.info('pi: reconciled persisted effort against current runtime model', {
        model: opts.model,
        providerId: runtimeProviderId ?? null,
        requestedEffort: opts.effort,
        resolvedEffort: startupEffort ?? null,
      });
    }

    // Pi 子进程只读取本次启动生成的 models.json。renderer 目录热更新后，不能把新出现的
    // effort 直接发送给仍在运行的旧进程；否则 Pi 会把 thinkingLevelMap 中的 null 当作
    // 关闭 reasoning。这里冻结每个可路由模型在该启动快照中的能力，setModel 成功后只
    // 切换到同一快照里已有的目标模型能力。
    const resolveStartupEffortSnapshot = (
      providerId: string,
      modelId: string,
    ): readonly Effort[] | undefined => {
      if (providerId !== PI_PROVIDER_ID) {
        return startupEffortsOfNativeModel(
          nativeProviderById.get(providerId)?.models.find(
            (model) => model.id === resolveNativeModelId(providerId, modelId),
          ),
        );
      }
      const gatewayModel = modelId === opts.model && selectedRuntimeModel
        ? selectedRuntimeModel
        : this.deps.resolvePiGatewayModelDescriptor?.(authProviderId, modelId)
          ?? this.capabilities.availableModels.find((model) => model.id === modelId);
      return gatewayModel?.efforts;
    };
    const initialEffortSnapshot = resolveStartupEffortSnapshot(initialProvider, opts.model);
    const assertStartupEffortAllowed = (
      snapshot: readonly Effort[] | undefined,
      effort: Effort,
    ): void => {
      // efforts:[] 仍可能收到 resolveEffort 的 UI 占位值 low；它代表“不支持切换”，
      // 只需跳过 RPC。其它档位必须拒绝，避免热刷目录后的新 effort 绕过启动快照。
      if (!snapshot || (snapshot.length === 0 && effort === 'low')) return;
      if (snapshot.includes(effort)) return;
      throw new Error(
        `pi set_thinking_level refused: effort '${effort}' is not available in this session's ` +
          'startup model snapshot; restart the Pi session after changing provider capabilities.',
      );
    };

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
    // 轮 42 P1(codex-connector):远端 pi + 订阅凭证(oauth-bearer)必须拒绝 ——
    // getAuthEnv 返回的是**本地 loopback proxy 的占位 key**, 远端 models.json
    // 却写真实 upstream endpoint 且不携带本地 proxy 的 OAuth 注入 headers,
    // pi 会把占位 key 当网关 key 打真实 upstream → 每个远端 turn 都失败。
    // 远端只支持 gateway-key(与 writeModelsJson 的远端分支一致)。fail-fast
    // 拒绝比「看似启动、首回合 401」可诊断。
    const remoteOAuthViaHostProxy = Boolean(
      opts.remoteHostId && nativeProviderById.get(initialProvider)?.hostProxyForward,
    );
    if (opts.remoteHostId && credentialMode === 'oauth-bearer' && !remoteOAuthViaHostProxy) {
      // 轮 42 P2(codex-connector):NotSupportedError 自己拼 message, 不带
      // bracketed code —— sessionCreateHandler 只认 [REMOTE_*] 前缀。message
      // 前加 [REMOTE_NATIVE_OAUTH_UNAVAILABLE] 让 renderer 走 5 语言可行动
      // 文案(引导换 gateway-key / BYOM)。
      throw new NotSupportedError('remoteSubscriptionProvider', {
        supported: false,
        reason: 'platform-limited',
        message:
          '[REMOTE_NATIVE_OAUTH_UNAVAILABLE] remote pi sessions require gateway-key auth (subscription/OAuth providers are local-only for now — pick an XD gateway or BYOM API-key provider)',
      });
    }

    const agentHome = this.resolveAgentHome(opts.remoteHostId);
    // 远端会话的 agentHome 文件操作走 host 注入的 SSH fs 原语;本地走 node:fs。
    // 语义:远端 pi 进程在远端读这些文件,host 侧必须把写/读/删落到远端机器。
    // 轮 22 HIGH-2 fail-fast:远端会话缺 fileOps 时静默回落 node:fs 会把
    // models.json/perm/扩展写到本地而 pi 在远端读 —— 「静默做错事」。
    // 与 getRemotePiTransport 缺失同款 NotSupportedError 拒绝启动。
    const fileOps = opts.remoteHostId
      ? this.deps.getRemotePiFileOps?.(opts.remoteHostId)
      : undefined;
    if (opts.remoteHostId && !fileOps) {
      throw new NotSupportedError('remoteFileOps', {
        supported: false,
        reason: 'not-implemented',
        message: 'remote pi sessions require getRemotePiFileOps — host must provide SSH file primitives',
      });
    }
    const remote = Boolean(opts.remoteHostId);
    const mkdirp = async (dir: string): Promise<void> => {
      if (fileOps) return fileOps.mkdirp(dir);
      await fs.mkdir(dir, { recursive: true });
    };
    const writeFile = async (file: string, content: string, mode?: number): Promise<void> => {
      if (fileOps) return fileOps.writeFile(file, content, mode);
      if (mode !== undefined) {
        await fs.writeFile(file, content, { mode });
      } else {
        // 凭证/控制面文件(models.json 的 BYOM baseUrl、权限档、bridge 扩展)对
        // 同机其他用户应不可读:默认 600(R5 安全审计 H-5)。显式 mode 由调用方决定。
        await fs.writeFile(file, content, { mode: 0o600 });
      }
    };
    const statFile = async (file: string): Promise<{ isFile: boolean } | null> => {
      if (fileOps) return fileOps.stat(file);
      try {
        const s = await fs.stat(file);
        return { isFile: s.isFile() };
      } catch {
        return null;
      }
    };
    const rmPath = async (target: string, opts2?: { recursive?: boolean }): Promise<void> => {
      // 轮 22 MEDIUM-5:两分支统一吞错(force 语义) —— 远端 fileOps.rm 抛错
      // 时本地分支却静默, 语义不对称会误导未来调用方。rm 失败由上层
      // cleanupConfigHome 的 catch 兜底。
      try {
        if (fileOps) {
          await fileOps.rm(target, opts2);
        } else {
          await fs.rm(target, { recursive: opts2?.recursive === true, force: true });
        }
      } catch {
        /* best-effort:rm 失败不致命 */
      }
    };
    // 每个 startSession 用独立的配置目录承载 models.json + cindy-bridge extension
    // (经 PI_CODING_AGENT_DIR 交给子进程),隔离并发普通会话:两个会话同写共享的
    // agentHome/models.json 时,第二次写入会在首次写完到 spawn 之间(多个 await)截断/
    // 覆盖 provider 快照,让先启动的进程读到半写入内容或另一份 BYOM 路由(codex review P2)。
    // session 状态仍由 --session-dir 指向共享 sessions;权限档由 CINDY_PI_PERMISSION_FILE
    // 显式路径提供 —— 两者都与配置目录独立(同 forkSdkSession 的 forkHome 隔离手法),
    // configHome 在进程退出/close/启动失败时清理。
    // 轮 42 P1(codex-connector):远端会话的 configHome 必须**稳定派生**——
    // 之前用 randomBytes, 每次 startSession 变 → spawn env 变 → envHash 必变
    // → daemon 判配置变更 → kill + respawn, 断链重连的 attach 保活失效
    // (与轮 41 session token 同源)。隔离语义(并发会话不共享 models.json /
    // extensions)由 daemon 的 envHash 串行化保证: 同 session 的 envHash 相同
    // → 纯 attach 复用同一路径, 无并发写; envHash 不同(如模型变更) → kill
    // 先于 spawn, 旧进程已死, 路径复用安全。本地会话无 envHash 约束, 保持
    // randomBytes 隔离(多实例并发启动)。
    // 远端再叠 models.json hash:startSession 在 pi/ensure 之前就会写
    // models.json, 若只按 sessionId 分目录, 另一实例改路由会先覆盖仍在跑的
    // 旧 Pi / 子代理热读快照。
    let configHome = remote
      ? joinRemotePosixPath(agentHome, 'run-tmp', stableSessionPathSegment(opts.sessionId))
      : joinRemotePosixPath(agentHome, 'run-tmp', randomBytes(8).toString('hex'));
    let configHomeCleaned = false;
    // 清理失败(SSH 断链时 fileOps.rm 抛错)不置标志 —— 下次会话的 startSession
    // 会主动清陈旧 configHome(见下),且不因「一次失败永久跳过」累积泄漏
    // (R4-2 竞态 1/6)。
    const cleanupConfigHome = (): void => {
      if (configHomeCleaned) return;
      void rmPath(configHome, { recursive: true }).then(
        () => { configHomeCleaned = true; },
        // 失败不置标志(下次 startSession 清陈旧目录兜底), 但必须留日志——
        // 否则远端 SSH fs 卡死等根因不可见(R7 审计 L-3)。
        (err) => {
          this.deps.logger.debug('pi configHome cleanup failed (retried next startSession)', {
            configHome,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );
    };
    // 轮 40-w4-t4 CRITICAL:不再在新会话启动时清 run-tmp 其它目录 —— 远端
    // 并发会话 A 的 configHome 会被 B 的启动清理删除(无 owner/lease 校验),
    // 破坏 A 的 bridge extension/models.json 运行期快照。清理只绑定到
    // 本会话自己的 close/失败(cleanupConfigHome);run-tmp 残留(断链时清理
    // 失败的孤儿)由本会话 close 路径的低频清理覆盖, 不牺牲活跃会话。
    // 注:断链残留的孤儿 configHome 会累积 —— 但删错活跃会话是毁任务,
    // 宁可残留(可由用户手动清或未来加 lease 机制), 不误删。
    if (remote) {
      const preview = await this.writeModelsJson(
        configHome,
        nativeProviders,
        retainedRuntimeModel,
        authProviderId,
        { remote, fileOps, preview: true },
      );
      configHome = joinRemotePosixPath(
        agentHome,
        'run-tmp',
        `${stableSessionPathSegment(opts.sessionId)}-${preview.modelsJsonHash.slice(0, 16)}`,
      );
    }
    const { gatewayImageInputByModel, gatewayApiByModel, modelsJsonHash } = await this.writeModelsJson(
      configHome,
      nativeProviders,
      retainedRuntimeModel,
      authProviderId,
      { remote, fileOps },
    );
    const sessionDir = joinRemotePosixPath(agentHome, 'sessions');
    await mkdirp(sessionDir);

    // cindy-bridge extension:每次 startSession 覆写,保证桥代码与本版本一致。
    // 远端 launch identity 另含 CINDY_PI_EXTENSION_BUNDLE_HASH(源码字节指纹),
    // 避免路径不变时 daemon 把仍在跑的旧进程当成可 reattach。
    // 与 models.json 同放隔离 configHome(Pi 从 PI_CODING_AGENT_DIR/extensions 扫描)。
    const extensionsDir = joinRemotePosixPath(configHome, 'extensions');
    await mkdirp(extensionsDir);
    // 轮 40-w4-t15 HIGH:远端派生路径一律 posix join —— 宿主机 path.join 在
    // Windows 上对 POSIX 路径的混合分隔符处理不可依赖(扩展文件扫描不到
    // 会导致 bridge/subagent 静默失效)。
    const bridgeExtensionPath = joinRemotePosixPath(extensionsDir, CINDY_BRIDGE_EXTENSION_FILENAME);
    await writeFile(bridgeExtensionPath, CINDY_BRIDGE_EXTENSION_SOURCE);
    // cindy-subagent extension:与 bridge 并列的独立扩展(职责分离 —— bridge 管权限门与
    // MCP 桥,这个只管子代理)。子进程继承 PI_CODING_AGENT_DIR,因此同样加载 bridge,
    // 权限门对子代理照样生效;递归由扩展内的 depth env 自己截断。
    const subagentExtensionPath = joinRemotePosixPath(extensionsDir, CINDY_SUBAGENT_EXTENSION_FILENAME);
    if (!reviewMode) {
      await writeFile(subagentExtensionPath, CINDY_SUBAGENT_EXTENSION_SOURCE);
    }

    // 权限档文件:extension 每次 tool_call 现读(热切换);读不到按 ask fail-closed。
    const runtimeDir = joinRemotePosixPath(agentHome, 'runtime');
    await mkdirp(runtimeDir);
    // 防御:sessionId 会拼进文件名,不能含路径分隔符 / 上级引用 —— 否则可逃出 runtimeDir
    // 覆盖任意文件(codex review)。IPC 边界已统一校验,这里对所有 startSession 调用方
    // (scheduler / orca / resume 等)再兜一层 fail-closed,与安全底线一致。
    const sid = opts.sessionId;
    if (sid !== undefined && (sid === '.' || sid === '..' || /[\\/\0]/.test(sid))) {
      throw new Error(`pi: unsafe sessionId for runtime path: ${JSON.stringify(sid)}`);
    }
    // 每运行时 nonce —— 与 configHome(`agentHome/run-tmp/<hex>`)同一套隔离思路。
    //
    // dev + 打包版共用同一个 userData、以及 `--passive` 任意多开,都是**明确支持**的工作流
    // (单实例锁按 flavor 分域,passive 完全跳过锁;见 `bootstrap-electron.ts` 的单实例锁注释)。
    // 那种拓扑下 runtimeDir 里只按 sessionId 命名的文件会被另一个**活着的**实例覆盖:
    //   - 路由快照被覆盖 → 本实例的父会话还在自己的路由上,它的下一个子代理却按另一个进程的
    //     provider 起来 —— 提示词发往用户在**这个**实例里并没选的端点(review);
    //   - 权限档被覆盖 → 另一个实例切到 Full Access,本实例的 bridge 下一次 tool_call 现读到
    //     bypassPermissions,本实例的破坏性工具不再确认。这是跨实例权限提升,比路由更严重,
    //     属于「本 PR 代码路径会走到的权限类缺陷」,一并收口而不是外推。
    // 代价是文件按 startSession 而非 sessionId 唯一 → 必须显式回收,见 cleanupRuntimeFiles。
    // 轮 42 P1:远端会话用稳定派生(同 session 重连复用路径 → env 稳定 →
    // envHash 稳定 → attach 保活); 本地保持 nonce 隔离(多实例并发启动)。
    // 远端同路径热读文件的覆盖:权限/Extra Dir 快照 hash 进 spawn env
    // (CINDY_PI_PERMISSION_HASH) —— 档位变则 envHash 变, daemon 先 kill 再 spawn,
    // 不让另一实例把 Full Access 写进仍在跑的 Pi。
    const runtimeInstanceId = remote
      ? stableSessionPathSegment(sid)
      : randomBytes(8).toString('hex');
    // 轮 20-V1 HIGH:远端路径必须 POSIX join —— path.join 在 Windows 本地会把
    // runtimeDir 与文件名拼成反斜杠(远端 shell 不认, 权限文件/子代理 runtime
    // 写不进删不掉, 破坏权限门与子代理路由)。runtimeDir 已是 posix(956 行)。
    // 远端权限/子代理文件名带启动快照 hash:startSession 在 pi/ensure 之前就会写文件,
    // 若复用旧路径, 另一实例的更宽档位会先覆盖仍在跑的 Pi 热读文件。
    // auto 保留(Cindy 侧 dispatcher 用);bridge 只特判 bypassPermissions,auto 在
    // 桥内行为同 ask(非只读全部冒泡)。其余档(default/acceptEdits/plan)归 ask 最严。
    const normalizePermissionMode = (mode: string | undefined): 'ask' | 'auto' | 'bypassPermissions' =>
      mode === 'bypassPermissions' ? 'bypassPermissions' : mode === 'auto' ? 'auto' : 'ask';
    let permissionMode = reviewMode ? 'ask' : normalizePermissionMode(opts.permissionMode);
    let mutableExtraDirs = [...(opts.extraDirs ?? [])];
    const reviewReadGrants = reviewMode
      ? await buildReviewReadGrants(opts.workingDir, opts.reviewReadPaths ?? [])
      : [];
    const reviewReadPaths = reviewReadGrants.map((grant) => grant.realPath);
    // Keep ordinary permission files shape-compatible with older Cindy/Pi
    // sessions. The Review-only marker is capability-like: absence means the
    // normal bridge, while `true` selects the restricted Review bridge.
    const reviewPathSnapshot = reviewMode ? { reviewReadPaths, reviewOnly: true as const } : {};
    // 与 Claude / Codex 一致，运行期 Orca 身份更新必须原地落在同一个对象上。
    // Desktop Pi MCP bridge 在 startSession 时持有这个引用；start_team 成功后 host
    // 调 setVendorOptions，后续 create_worker 等工具才能立即读到最新 Lead 身份。
    const mutableVendorOptions: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };
    type PermissionSnapshot = {
      mode: 'ask' | 'auto' | 'bypassPermissions';
      readOnlyRoots: string[];
      reviewReadPaths?: string[];
      reviewOnly?: true;
    };
    const permissionPrivilege = (mode: PermissionSnapshot['mode']): number =>
      mode === 'bypassPermissions' ? 2 : mode === 'auto' ? 1 : 0;
    let requestedPermissionSnapshot: PermissionSnapshot = {
      mode: permissionMode,
      readOnlyRoots: [...mutableExtraDirs],
      ...reviewPathSnapshot,
    };
    let persistedPermissionSnapshot: PermissionSnapshot = {
      mode: permissionMode,
      readOnlyRoots: [...mutableExtraDirs],
      ...reviewPathSnapshot,
    };
    const permissionSnapshotHash = createHash('sha256')
      .update(JSON.stringify(requestedPermissionSnapshot))
      .digest('hex')
      .slice(0, 16);
    const permissionFile = joinRemotePosixPath(
      runtimeDir,
      `perm-${sid ?? `anon-${process.pid}-${Date.now()}`}-${runtimeInstanceId}${remote ? `-${permissionSnapshotHash}` : ''}.json`,
    );
    // 子代理运行期快照(model + provider)。与权限档同机制:文件而非 env —— env 在 spawn
    // 时定型,会话中途 setModel 后子代理会继续用启动时的旧模型(greptile P1),而 BYOM /
    // 本地 provider 不一起传还会让同名模型落到错误 endpoint(codex P2,pi-harness §3 要求
    // BYOM 直连原生 provider)。扩展每次派子代理现读本文件。
    const subagentRuntimeFile = joinRemotePosixPath(
      runtimeDir,
      `subagent-${sid ?? `anon-${process.pid}-${Date.now()}`}-${runtimeInstanceId}${remote ? `-${permissionSnapshotHash}` : ''}.json`,
    );
    let runtimeFilesCleaned = false;
    /**
     * 回收本运行时的两个 runtime 文件(幂等)。带 nonce 之后它们不再按 sessionId 复用,
     * 不回收就会随每次 startSession 无界堆积在 runtimeDir 里。
     */
    const cleanupRuntimeFiles = (): void => {
      if (runtimeFilesCleaned) return;
      runtimeFilesCleaned = true;
      void rmPath(permissionFile);
      void rmPath(subagentRuntimeFile);
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
        ...reviewPathSnapshot,
      };
      // 收紧必须立刻约束 host 侧审批门；等待磁盘 I/O 才改闭包会留下一个 Full access
      // 的窗口。放宽反过来只能等对应快照成功落盘，避免 host 已放行而 bridge 仍是旧档。
      if (permissionPrivilege(requestedPermissionSnapshot.mode) < permissionPrivilege(permissionMode)) {
        permissionMode = requestedPermissionSnapshot.mode;
      }
      const gen = ++permissionWriteGen;
      // 排队时刻捕获意图快照;运行时若已被更晚的写取代则跳过(旧内容不得在新内容之后落盘)。
      const snapshot = {
        ...requestedPermissionSnapshot,
        readOnlyRoots: [...requestedPermissionSnapshot.readOnlyRoots],
        ...reviewPathSnapshot,
      };
      const run = permissionWriteChain.then(async () => {
        if (gen !== permissionWriteGen) return;
        try {
          await writeFile(permissionFile, JSON.stringify(snapshot) + '\n');
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
              ...reviewPathSnapshot,
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
            ...reviewPathSnapshot,
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

    // 子代理运行期快照的写入:代际串行,最新意图胜出(理由同权限档 —— 并发/连续 setModel
    // 时无串行的 writeFile 可能让较早的模型写在较新的之后落盘,子代理就会读到过期模型)。
    //
    // **返回 Promise 且调用方必须 await**:不能 fire-and-forget。startSession 要在会话对外
    // 暴露(模型能调 subagent)**之前**落盘初始 provider/model,否则 BYOM / 本地 provider 或
    // 非默认模型的会话一开始就调子代理时,文件还不存在 → 扩展不传 --provider/--model → 子进程
    // 走 pi 默认解析,直接跑错 endpoint(review)。setModel 同理:切完模型立刻派子代理必须
    // 已经能看到新值。
    //
    // **写失败一律 fail-closed,不许 catch 成功**(review):runtime 目录只读 / 磁盘满时,
    // 若把失败吞成成功,子代理会带着空快照或旧快照继续跑 —— BYOM / 本地 provider 的请求
    // 就发到错误 endpoint 去了。返回 false 表示"本次未能持久化",调用方据此**禁用本次会话
    // 的子代理路由**;失败时还会 best-effort 删掉该文件,让扩展在使用点也失败关闭
    // (它把"读不到快照"当作不可用,而不是退回 pi 默认解析)。
    let subagentRuntimeWriteChain: Promise<void> = Promise.resolve();
    let subagentRuntimeWriteGen = 0;
    /**
     * 首次快照持久化失败 → 本次会话根本不注入 runtime 文件 env,扩展因此不注册 subagent 工具。
     *
     * **只在 spawn 之前有意义**:它的唯一消费点是下面构造 spawnEnv 的那一处。进程一旦起来,改它
     * 既收不回已注入的 env、也拦不住扩展继续读快照文件 —— 所以**禁止**在 setModel 等运行期路径上
     * 用它当"撤销开关"(上一版就是这么用的,那是个空操作,review 连点两轮)。运行期要收回子代理
     * 能力只有一条可证明有效的路:终止会话。
     */
    const subagentRoutingEnabled = !reviewMode;
    const writeSubagentRuntimeFile = async (
      next: { model?: string; provider?: string; pending?: boolean },
    ): Promise<boolean> => {
      const gen = ++subagentRuntimeWriteGen;
      const snapshot = {
        ...(next.model ? { model: next.model } : {}),
        ...(next.provider ? { provider: next.provider } : {}),
        // `pending: true` = 这条路由**尚未**被 pi 确认。扩展见到它就拒绝派发(fail-closed),
        // 于是模型切换的等待窗口里一个子进程都起不来 —— 详见 setModel 的注释。
        ...(next.pending ? { pending: true } : {}),
      };
      const run = subagentRuntimeWriteChain.then(async (): Promise<boolean> => {
        // 已被更晚的意图取代:旧内容不得在新内容之后落盘(视作成功,最新那次负责收口)。
        if (gen !== subagentRuntimeWriteGen) return true;
        await writeFile(subagentRuntimeFile, JSON.stringify(snapshot) + '\n');
        return true;
      });
      // 链永不停在 rejected 上(同权限档):否则一次写失败后续写永远追加不进去。
      subagentRuntimeWriteChain = run.then(() => {}, () => {});
      try {
        return await run;
      } catch (error) {
        this.deps.logger.error('pi subagent runtime snapshot write failed; disabling subagent routing', {
          message: error instanceof Error ? error.message : String(error),
        });
        // 留着旧内容比没有更危险(会把请求发到过期 provider),删掉让使用点也失败关闭。
        await rmPath(subagentRuntimeFile);
        return false;
      }
    };
    // 会话暴露前先落初始快照(await:模型第一次调 subagent 时文件必须已经在)。
    // 轮 40-w4-t16 MEDIUM(降级回退):初始写失败**不永久禁用** subagent ——
    // 一次临时 fs/权限错误锁死整个会话的 subagent 路由不可接受。保留 enabled,
    // 但文件缺失让扩展 fail-closed(不派发);后续每次 setModel 都会重试写
    // (writeSubagentRuntimeFile 由 subagentRuntimeWriteChain 串行), 文件恢复
    // 可写即自动恢复。
    if (subagentRoutingEnabled && !(await writeSubagentRuntimeFile({ model: initialWireModel, provider: initialProvider }))) {
      this.deps.logger.warn('pi subagent initial runtime snapshot write failed — routing stays enabled, will retry on next model set', {
        sessionId: opts.sessionId,
      });
    }

    // MCP:host 把 in-process providers 暴露成 localhost streamable-HTTP，也可给出
    // 外部 HTTP server 描述（header 真值另走 mcpEnv，不进入描述符）。
    // 传 session 身份(sessionId/workingDir/vendorOptions)让 host 在 bridge 上注册
    // 身份 ctx + 给 server URL 打 `?session=` 路由 —— orca/会话身份类工具据此绑定
    // 当前 pi 会话。disposeSessionCtx 在 close() 注销该注册(幂等)。
    let mcpBridge: PiExtraSpawnConfig['mcpBridge'] = null;
    let mcpEnv: PiExtraSpawnConfig['mcpEnv'] = {};
    let disposeSessionCtx: (() => void) | undefined;
    const registeredMcpServerNames = new Set<string>();
    // 远端会话:host 可 gate 掉 in-process MCP bridge(loopback URL 远端够不到;
    // Phase 1 不桥 orca/memory/ghost)。外部 HTTP MCP 直连不受影响。
    const remoteSkipMcpBridge = Boolean(
      opts.remoteHostId && this.deps.remotePiSkipMcpBridge?.(opts.remoteHostId),
    );
    if (!reviewMode && !remoteSkipMcpBridge && this.deps.preparePiExtraSpawnConfig) {
      try {
        const extra = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          sessionId: opts.sessionId,
          ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
          workingDir: opts.workingDir,
          vendorOptions: mutableVendorOptions,
          mcpCallerKind: 'root',
          mcpCallerAttested: true,
          ...(opts.remoteHostId ? { remoteHostId: opts.remoteHostId } : {}),
        });
        mcpBridge = extra?.mcpBridge ?? null;
        mcpEnv = extra?.mcpEnv ?? {};
        disposeSessionCtx = extra?.disposeSessionCtx;
        // 归属判定只认本会话实际注册过的 server 名(见 shared/mcp-tool-target.ts:
        // 盲切 `__` 会让第三方 server 冒名顶替第一方信任表)。
        for (const server of mcpBridge?.servers ?? []) {
          if (typeof server.name === 'string' && server.name.length > 0) {
            registeredMcpServerNames.add(server.name);
          }
        }
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
      !reviewMode &&
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
    const ghostRosterPrompt = reviewMode
      ? ''
      : this.deps.getGhostRosterPrompt?.({ workingDir: opts.workingDir }) ?? '';
    const appendSections = [
      this.deps.runtimeConfig.systemPrompt?.trim(),
      ghostRosterPrompt.trim(),
      reviewMode ? undefined : opts.userPrompt?.trim(),
      piExtraDirsPrompt(mutableExtraDirs),
    ].filter((s): s is string => !!s && s.length > 0);
    const appendSystemPrompt = appendSections.join('\n\n');

    // 远端会话先 resolve 远端 pi 二进制路径(probe;plan-mode 扩展路径 / subagent
    // spawn env 都依赖它)。本地场景即 this.deps.binaryPath,无额外开销。
    // 轮 22 HIGH-1 fail-fast:远端缺 resolveRemotePiBinaryPath 或 probe 失败时,
    // 静默回落本地 binaryPath 会让 subagent 在远端 spawn 本地路径(No such file)
    // + plan-mode 扩展静默禁用 —— 拒绝启动, 与 getRemotePiTransport 同款守卫。
    const effectivePiBinaryPath = opts.remoteHostId
      ? await (async (hostId: string): Promise<string> => {
          const resolved = await this.deps.resolveRemotePiBinaryPath?.(hostId);
          if (!resolved) {
            throw new NotSupportedError('remotePiBinaryPath', {
              supported: false,
              reason: 'not-implemented',
              message: 'remote pi sessions require resolveRemotePiBinaryPath — host must probe the remote pi binary',
            });
          }
          return resolved;
        })(opts.remoteHostId)
      : this.deps.binaryPath;

    // plan 模式:挂载 pi 自带的 plan-mode example 扩展(随 pi 分发,版本匹配,免 vendoring)。
    // 只在文件存在时 --extension;缺失则 plan 模式静默降级(setPlanMode 时 warn)。
    // 加载本身零副作用:plan 模式默认关,扩展 hook 全早返;仅 /plan 开启后才注入 plan 提示词。
    // 远端:扩展随远端 pi 分发(installer 解压整包),路径基于远端二进制。
    // 轮 40-w4-t15:远端二进制是 POSIX 路径, 本地是平台路径 —— 按会话远端性
    // 选择 dirname 语义。
    const planModeExtPath = opts.remoteHostId
      ? joinRemotePosixPath(
          path.posix.dirname(effectivePiBinaryPath),
          'examples', 'extensions', 'plan-mode', 'index.ts',
        )
      : path.join(
          path.dirname(effectivePiBinaryPath),
          'examples', 'extensions', 'plan-mode', 'index.ts',
        );
    let planModeExtAvailable = false;
    try {
      planModeExtAvailable = (await statFile(planModeExtPath))?.isFile === true;
    } catch {
      /* 缺失 → 不挂载 plan-mode */
    }

    // Project resources have exactly one authority: the host-owned PR3 trust
    // snapshot. Freeze it once per new runtime, then assemble only its eligible
    // skills. Missing/throwing authorities and paths fail closed; never infer
    // approval from permission mode, MCP/plugin state, or caller vendor options.
    let projectResourceAssembly = unavailablePiProjectResourceAssembly(
      reviewMode
        ? 'review-mode-project-resources-disabled'
        : 'approval-resolver-unavailable',
    );
    if (!reviewMode && this.deps.resolvePiProjectTrustInput) {
      try {
        const trustInput = await this.deps.resolvePiProjectTrustInput({
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          workingDir: opts.workingDir,
          ...(opts.remoteHostId ? { remoteHostId: opts.remoteHostId } : {}),
        });
        projectResourceAssembly = await assembleApprovedPiProjectResources(
          trustInput,
          opts.workingDir,
        );
        projectResourceAssembly = await stageApprovedPiProjectResources(
          projectResourceAssembly,
          configHome,
        );
      } catch {
        projectResourceAssembly = unavailablePiProjectResourceAssembly(
          'approval-resolver-failed',
        );
        this.deps.logger.warn('pi project approval resolver failed closed', {
          sessionId: opts.sessionId ?? null,
        });
      }
    }
    this.deps.logger.debug('pi project resource assembly snapshot', {
      sessionId: opts.sessionId ?? null,
      status: projectResourceAssembly.diagnostic.status,
      reason: projectResourceAssembly.diagnostic.reason,
      approvalRevision: projectResourceAssembly.diagnostic.approvalRevision,
      requestedSkillCount: projectResourceAssembly.diagnostic.requestedSkillCount,
    });

    const args = [
      '--mode', 'rpc',
      // Keep Pi's project trust and implicit extension discovery disabled even
      // when project settings declare packages/extensions. Cindy-owned/pinned
      // extensions and approved skills are the only explicit additions below.
      '--no-approve',
      '--no-extensions',
      '--session-dir', sessionDir,
      '--provider', initialProvider,
      '--model', initialWireModel,
      ...(reviewMode ? ['--tools', 'read,grep,find,ls'] : []),
      ...(appendSystemPrompt.length > 0 ? ['--append-system-prompt', appendSystemPrompt] : []),
      '--extension', bridgeExtensionPath,
      ...(!reviewMode ? ['--extension', subagentExtensionPath] : []),
      ...(!reviewMode && planModeExtAvailable ? ['--extension', planModeExtPath] : []),
      ...projectResourceAssembly.launchSkillPaths.flatMap((skillPath) => ['--skill', skillPath]),
    ];

    const queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const ctx: PiTranslateContext = createPiTranslateContext(this.deps.logger);
    let interactionResolver: InteractionResolver | null = null;
    // Host 每轮权限策略(个人微信 / Telegram 群)。刻意保留在 send 之外的闭包里:
    // pi 的内部续跑(plan 审批后的实施轮、自动继续)不再经 handle.send,却必须继续
    // 强制确认策略命中的工具 —— 与 Claude(task_notification 续跑)/ Codex(plan
    // follow-up send)同口径。清空只认 turn 终态,由 send 预检覆盖为最新值。
    let activeTurnPermissionPolicy: TurnPermissionPolicy | null = null;
    let mutableModel = opts.model;
    let mutableWireModel = initialWireModel;
    // Pi RPC 实际选中的 provider。与用于宿主鉴权/审阅元数据的 mutableProviderId 分开：
    // null/订阅来源会归一到 cindy，setModel 未显式传来源时也必须跟随本次解析结果。
    let mutablePiProviderId = initialProvider;
    let mutableProviderId: string | null | undefined = opts.providerId ?? authProviderId;
    let activeEffortSnapshot = initialEffortSnapshot;
    let currentAutoReviewIntent = '';
    const autoReviewDecisionCache = new Map<string, Promise<AutoReviewDecision>>();
    const setAutoReviewIntent = (content: UserMessage['content']): void => {
      currentAutoReviewIntent = extractAutoReviewUserIntent(content);
      autoReviewDecisionCache.clear();
    // 每条新用户消息 = 新一轮,提示重新武装。ErrorBanner 那份只活到下一条非 error 事件
    // (renderer 的 handleStreamEvent 会清 recoverableError),所以「整个会话只说一次」
    // 会让用户在后续轮次里完全看不到;改为每轮至多一条 —— 不刷屏,又保证每一轮遇到时
    // 都有机会看见。持久呈现需要一条真正的会话级 notice 通道,见 issue 外推。
      autoReviewUnavailableNotice.reset();
      autoReviewConfirmUndeliveredNotice.reset();
    };
    /**
     * 挂起的权限卡登记表 —— 档位切换 / 会话关闭时必须能把它们强制 settle 并让 UI 收卡,
     * 与 Claude / Codex 的 `dismissAllPending` 同口径(Pi 此前是唯一没有这套的 harness)。
     *
     * 没有它的后果:用户看到卡之后切到 Full access,`resolver` 仍只挂在那张卡上,不会被唤醒,
     * 于是「Full access 不该再问」永远等不到生效 —— 工具调用一直卡住,直到用户手动回答一张
     * 已经失效的卡(codex review P1)。
     */
    type PendingPrompt = {
      settle: (resolveAs: 'allow' | 'deny') => void;
      /** 高风险审批(MCP prompt-each-time、灰区 ask、审查中收紧):放宽档位不得批量放行。 */
      forcePrompt: boolean;
      /** Auto 审阅故障降级来的确认:系统收口不能当成用户点了拒绝。 */
      unavailableHandoff?: boolean;
    };
    const pendingPrompts = new Map<string, PendingPrompt>();
    const registerPendingPrompt = (requestId: string, entry: PendingPrompt): (() => void) => {
      pendingPrompts.set(requestId, entry);
      return () => pendingPrompts.delete(requestId);
    };
    const dismissAllPendingPrompts = (reason: string, resolveAs: 'allow' | 'deny'): void => {
      if (pendingPrompts.size === 0) return;
      for (const [requestId, entry] of Array.from(pendingPrompts.entries())) {
        // 放宽档位不能替用户批准他还没表态的高风险调用:没拿到这一次的明确确认就 fail-closed
        // (与 CC / Codex 的同名逻辑一致 —— 否则 pending 期间切档能让破坏性调用自动过)。
        const effectiveResolveAs: 'allow' | 'deny' =
          resolveAs === 'allow' && entry.forcePrompt ? 'deny' : resolveAs;
        if (effectiveResolveAs === 'deny' && entry.unavailableHandoff) {
          autoReviewConfirmUndeliveredNotice.notify();
        }
        pendingPrompts.delete(requestId);
        entry.settle(effectiveResolveAs);
        queue.push({
          type: 'interaction_dismissed',
          data: { requestId, reason, resolvedAs: effectiveResolveAs },
          source: 'pi',
        });
      }
    };
    const clearActiveTurnPermissionPolicy = (
      reason: string,
      opts?: { dismissPending?: boolean },
    ): void => {
      activeTurnPermissionPolicy = null;
      if (opts?.dismissPending) dismissAllPendingPrompts(reason, 'deny');
    };
    // 「自动审核不可用」的会话级一次性提示(issue #1574);与 Claude / Codex 同口径,走既有的
    // 非终止 error 事件 + `[CODE]` 约定,不新增事件类型。
    const emitAutoReviewRuntimeNotice = (message: string): void => {
      queue.push({
        type: 'error',
        data: { message, isTerminal: false },
        source: 'pi',
      });
    };
    const autoReviewUnavailableNotice = createAutoReviewUnavailableNotice(emitAutoReviewRuntimeNotice);
    const autoReviewConfirmUndeliveredNotice =
      createAutoReviewConfirmUndeliveredNotice(emitAutoReviewRuntimeNotice);
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
    let sessionTransport: PiTransport | undefined;
    let runtimeCapabilityManifest: PiRuntimeCapabilityManifest | undefined;
    let runtimeCapabilityGeneration = 0;
    const runtimeCapabilityListeners = new Set<(
      manifest: PiRuntimeCapabilityManifest | undefined,
    ) => void>();
    const notifyRuntimeCapabilityListener = (
      listener: (manifest: PiRuntimeCapabilityManifest | undefined) => void,
      manifest: PiRuntimeCapabilityManifest | undefined,
    ): void => {
      try {
        listener(manifest);
      } catch (error) {
        this.deps.logger.warn('pi runtime capability listener failed (non-fatal)', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const publishRuntimeCapabilities = (manifest: PiRuntimeCapabilityManifest | undefined): void => {
      runtimeCapabilityManifest = manifest;
      for (const listener of runtimeCapabilityListeners) {
        notifyRuntimeCapabilityListener(listener, manifest);
      }
    };
    // 普通远端会话直连网关(remoteEndpoint),不生成本地 proxy token。只有显式声明
    // hostProxyForward 的 provider（当前为 xAI）仍通过 Desktop compat proxy：
    // SSH 只解决可达性，session token 继续提供逐会话鉴权，不能把 loopback 端口
    // 当作信任边界。
    const remoteUsesHostProxy = remote && nativeProviders.some((provider) => provider.hostProxyForward);
    const proxySessionToken = remoteUsesHostProxy
      ? stableRemoteProxySessionToken(opts.sessionId, this.deps.derivePiProxySessionToken)
      : !remote
        ? randomBytes(32).toString('base64url')
        : undefined;
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
      // 远端不 stage 本地 rg(本机二进制远端无意义)—— 远端走 PATH 上的 rg(远端 POSIX
      // 系统常见),与 CC/Codex 远端一致(不注入受管工具路径)。
      const managedRipgrepPath = remote
        ? undefined
        : await stageManagedRipgrep(
            configHome,
            this.deps.runtimeConfig.managedExecutablePaths?.ripgrep,
          );
      if (proxySessionToken && opts.sessionId && this.deps.registerPiProxySession) {
        const disposer = this.deps.registerPiProxySession(
          opts.sessionId,
          proxySessionToken,
          () => mutablePiProviderId === PI_PROVIDER_ID
            ? null
            : resolveSourceProvider(mutablePiProviderId),
        );
        if (typeof disposer === 'function') disposeProxySession = disposer;
      }
      // 视觉桥后端 env（层 C）：host 解析后注入，cindy-bridge 的 vision 工具读取。
      // 键名可能含 API key，须纳入 piSecretEnvNames 剥离面。
      // 传当前 session model：未命中视觉桥目标模型的 Pi 模型不注入 env、不注册
      // vision 工具（零干扰，不因别的模型配置了视觉桥而改变本模型工具面）。
      const visionBridgeEnv =
        this.deps.resolvePiVisionBridgeEnv?.(opts.model) ?? null;
      // 这些值必须留在 Pi 父进程，供 models.json 的 $ENV 请求期解析及 bridge
      // client 使用；cindy-bridge 用该**仅含变量名**的清单在 bash spawn 边界剥离
      // 真值，阻止 LLM shell 绕过工具审批直连 localhost proxy/MCP 或盗用 BYOM key。
      const piSecretEnvNames = Array.from(new Set([
        PI_API_KEY_ENV,
        PI_SESSION_ID_ENV,
        PI_SESSION_TOKEN_ENV,
        ...(visionBridgeEnv ? Object.keys(visionBridgeEnv) : []),
        ...Object.keys(authEnv),
        ...Object.keys(nativeEnv),
        ...Object.keys(mcpEnv),
        ...(mcpBridge && mcpBridge.servers.length > 0 ? [PI_MCP_BRIDGE_ENV] : []),
        // 子代理路由快照:虽然不是凭证,但它是**控制面** —— 一次获批的 bash 拿到路径就能改写
        // provider/model,让后续每次委派都打到攻击者选定的 endpoint(提示词与代码随之外泄)。
        // 与 CINDY_PI_PERMISSION_FILE 同一类:靠改写受信文件给后续调用永久换向(review)。
        // 只从 bash/模型工具的 spawn 边界剥离;子代理自己的 spawn 不走 bridge 的 bash 钩子,
        // 扩展照旧现读快照,能力不受影响。
        CINDY_SUBAGENT_ENV.runtimeFile,
        // 受管工具路径同属控制面：不得让获批 bash 改写/替换后影响后续自动放行的 grep/find。
        ...(managedRipgrepPath ? [PI_MANAGED_RG_PATH_ENV] : []),
      ]));
      // 远端会话零继承本机 env(对齐 claude env-builder mode:'remote')—— 本机全量 env
      // 对远端无意义且是隐私泄漏面;远端只有精选集合(CINDY_PI_* + authEnv + MCP header)。
      // 本地保持历史行为(继承本机 env)。
      // 「Agent 流量走本地 Proxy」:远端会话注入 HTTPS_PROXY/HTTP_PROXY/NO_PROXY
      // (指向本地代理经 SSH remote-forward 隧道),与 CC 远端同机制。
      // 失败(fail-closed)直接传播 —— 用户显式开启代理却静默直连是安全语义缺陷
      // (R2 MCP BUG-2):隧道 arm 失败应让会话启动失败,而非绕过代理。
      const proxyEnv = remote && this.deps.getRemotePiAgentProxyEnv
        ? await this.deps.getRemotePiAgentProxyEnv(opts.remoteHostId!)
        : null;
      const spawnEnv: NodeJS.ProcessEnv = {
        ...(remote ? {} : process.env),
        ...authEnv,
        ...(proxyEnv ?? {}),
        // BYOM 原生 provider 的 api keys(键名对应 spec.apiKeyEnvVar,models.json 用 $ENV 引用)。
        ...nativeEnv,
        // 外部 MCP header 真值只经 env 交给 bridge extension；host 生成独立名字，
        // 且这些键已进入 piSecretEnvNames，LLM 可调用的 bash 子进程拿不到。
        ...mcpEnv,
        // 视觉桥后端 env（层 C）：键含 API key 已纳入 piSecretEnvNames 剥离面。
        ...(visionBridgeEnv ? visionBridgeEnv : {}),
        [PI_SESSION_ID_ENV]: opts.sessionId ?? '',
        ...(proxySessionToken !== undefined
          ? { [PI_SESSION_TOKEN_ENV]: proxySessionToken }
          : {}),
        [PI_SECRET_ENV_NAMES_ENV]: JSON.stringify(piSecretEnvNames),
        PI_CODING_AGENT_DIR: configHome,
        CINDY_PI_PERMISSION_FILE: permissionFile,
        // 轮 40-w4-t12 HIGH-1:review-only 启动标记 —— 独立于权限文件(文件损坏/
        // 缺失时 bridge 仍保留 reviewOnly 语义, 不降级成普通 ask;见
        // cindy-bridge-source currentPermissionState fail-closed)。
        ...(reviewMode ? { CINDY_PI_REVIEW_ONLY: '1' } : {}),
        // 子代理:cindy-subagent 扩展据此 spawn 子 pi 进程。给二进制路径而不是让扩展猜
        // process.execPath —— host 本来就知道本次会话用的是哪个 pi。远端会话用远端
        // 二进制路径(effectivePiBinaryPath;本地路径远端不存在,spawn 会失败)。
        [CINDY_SUBAGENT_ENV.binary]: effectivePiBinaryPath,
        // 只给文件路径:model/provider 由扩展每次现读,setModel 后立即生效。
        // 快照没能持久化时**不传**该 env —— 扩展据此完全不注册 subagent 工具(fail-closed,
        // 宁可本次会话没有子代理,也不让它带着空/旧快照把请求发到错误 endpoint)。
        ...(subagentRoutingEnabled ? { [CINDY_SUBAGENT_ENV.runtimeFile]: subagentRuntimeFile } : {}),
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
      // 不继承宿主进程里碰巧存在的同名变量；Windows 环境键大小写不敏感，必须先清掉
      // 所有 casing 再写入 host 校验并 stage 后的唯一绝对路径。
      for (const key of Object.keys(spawnEnv)) {
        if (key.toLowerCase() === PI_MANAGED_RG_PATH_ENV.toLowerCase()) delete spawnEnv[key];
      }
      if (managedRipgrepPath) spawnEnv[PI_MANAGED_RG_PATH_ENV] = managedRipgrepPath;
      // 轮 42 P1:models.json 内容 hash 进 spawn env —— 远端 daemon 的 envHash
      // 覆盖它, 配置变更(models.json 改写)时条件 restart 判定生效, 不误 attach。
      // 仅远端注入(本地无 envHash 机制); 值本身无凭证(只是内容指纹)。
      if (remote) {
        spawnEnv[PI_MODELS_JSON_HASH_ENV] = modelsJsonHash;
        spawnEnv[PI_PERMISSION_HASH_ENV] = permissionSnapshotHash;
        spawnEnv[PI_EXTENSION_BUNDLE_HASH_ENV] = createHash('sha256')
          .update(CINDY_BRIDGE_EXTENSION_SOURCE)
          .update('\n')
          .update(CINDY_SUBAGENT_EXTENSION_SOURCE)
          .digest('hex')
          .slice(0, 16);
      }
      mergeLoopbackNoProxy(spawnEnv);
      const initialHostProxyForward = nativeProviderById.get(initialProvider)?.hostProxyForward;
      const { transport } = await this.createTransport(
        {
          args,
          cwd: opts.workingDir,
          env: spawnEnv,
          sessionId: opts.sessionId,
          hostProxyForwards: initialHostProxyForward ? [initialHostProxyForward] : [],
        },
        (pid) =>
          this.deps.registerLocalAgentProcess?.({
            pid,
            kind: 'pi',
            role: 'task-host',
          }),
        opts.remoteHostId,
        effectivePiBinaryPath,
      );
      sessionTransport = transport;
      proc = new PiRpcProcess({
        transport,
        logger: this.deps.logger,
        onEvent: (event: PiRpcEvent) => {
          if (event.type === 'extension_ui_request') {
            this.handleExtensionUiRequest(event, proc, () => ({
              resolver: interactionResolver,
              permissionMode,
              workspaceRoots: [opts.workingDir],
              readRoots: [opts.workingDir, ...mutableExtraDirs],
              reviewAutoAction,
              notifyAutoReviewUnavailable: () => autoReviewUnavailableNotice.notify(),
              notifyAutoReviewConfirmUndelivered: () => autoReviewConfirmUndeliveredNotice.notify(),
              registeredMcpServerNames,
              registerPendingPrompt,
              turnPermissionPolicy: activeTurnPermissionPolicy,
              sessionId: opts.sessionId ?? '',
              workingDir: opts.workingDir ?? '',
              remote: Boolean(opts.remoteHostId),
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
          // Pi 的真实 turn 终态是 agent_settled；auto-retry 耗尽则先发 terminal error。
          // 两条路径都必须立即清本轮 host policy，避免它泄漏到后续 Desktop turn。
          if (
            event.type === 'agent_settled'
            || (event.type === 'auto_retry_end' && event.success !== true)
          ) {
            clearActiveTurnPermissionPolicy('turn_terminal', { dismissPending: true });
          }
          translatePiEvent(event, queue, ctx);
        },
        onExit: ({ code, signal }) => {
          disposePiTranslateContext(ctx);
          clearActiveTurnPermissionPolicy('process_exit', { dismissPending: true });
          runtimeCapabilityGeneration++;
          publishRuntimeCapabilities(undefined);
          runtimeCapabilityListeners.clear();
          if (!closed) {
            // 非用户 close 的进程死亡:terminal error + 收尾,避免 UI 永久 running。
            queue.push({
              type: 'error',
              data: { message: `pi process exited unexpectedly (code=${code}, signal=${signal})`, isTerminal: true },
              source: 'pi',
            });
            // 轮 43 P1(codex-connector):**远端 daemon 模式不注销 MCP 注册** ——
            // transport onClose(SSH 闪断/桥断)≠ 进程死, daemon 仍持有同一个 pi
            // 子进程继续跑; 注销 MCP 注册会关闭 SSH remote-forward 隧道并清掉
            // MCP session context, 远端 pi 的 cindy_memory/cindy_orca/cindy_ghost
            // 等 MCP 调用在 detach 期间立即 401 或不可达, 破坏断链保活语义。
            // 本地 stdio 无 daemon, onExit 即真死, 保持清理。
            if (!remote) {
              try {
                disposeSessionRegistrations();
              } catch (err) {
                this.deps.logger.warn('pi dispose on unexpected exit failed (non-fatal)', {
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
          // 进程已死:隔离的 configHome(models.json + extension)与 runtime 文件不再被读,清理。
          // 轮 42 P1(codex-connector):**远端会话不清理** —— daemon 模式下
          // transport onClose(SSH 闪断)≠ 进程死, daemon 仍持有同一个 pi 子进程
          // 继续跑; 删 configHome/permission/subagent runtime 会让存活 pi 的
          // 后续工具调用降级 ask / 审批卡死 / 子代理路由丢, 破坏断链保活语义。
          // 远端只在用户显式关闭时由 daemon 的 killRemoteSession 清 session,
          // runtime 文件残留由下次 startSession 的清陈旧目录兜底(轮 40-w4-t4)。
          // 本地 stdio 无 daemon, onExit 即真死, 保持清理。
          if (!remote) {
            cleanupConfigHome();
            cleanupRuntimeFiles();
          }
          queue.end();
        },
      });
    } catch (err) {
      disposePiTranslateContext(ctx);
      try {
        disposeSessionRegistrations();
      } catch {
        /* best-effort:注销失败不掩盖原始构造错误 */
      }
      // 轮 42 P1:远端失败也不清理 runtime 文件(可能与并发存活会话共享/复用)。
      if (!remote) {
        cleanupConfigHome();
        cleanupRuntimeFiles();
      }
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
    const refreshRuntimeCapabilities = async (
      stage: 'ready' | 'switch_session' | 'fork',
    ): Promise<void> => {
      const generation = ++runtimeCapabilityGeneration;
      const capturedManifest = await capturePiRuntimeCapabilityManifest(
        proc,
        {
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(sdkSessionId ? { sdkSessionId } : {}),
        },
        generation,
        stage,
      );
      const manifest = {
        ...capturedManifest,
        projectResources: reconcilePiProjectResourceRuntime(
          projectResourceAssembly,
          capturedManifest,
        ),
      };
      if (!closed && generation === runtimeCapabilityGeneration) publishRuntimeCapabilities(manifest);
    };
    let runtimeCaptureStage: 'ready' | 'switch_session' = 'ready';
    try {
      // Resume:pi 的会话钥匙是 session JSONL 绝对路径(get_state.sessionFile),
      // 落库 sdk_session_id 存的就是它;切换失败走 invalid-resume CAS 协定。
      if (opts.resumeSessionId) {
        // Pi 对不存在的路径会“成功”创建一条同名空会话，不能把历史丢失伪装成
        // resume 成功。Cindy 先做本地文件存在性检查，再决定是否允许 fresh fallback。
        let resumeFileExists = false;
        try {
          resumeFileExists = (await statFile(opts.resumeSessionId))?.isFile === true;
        } catch {
          resumeFileExists = false;
        }
        if (!resumeFileExists) {
          // 轮 25 CRITICAL:session 文件缺失 = 历史数据已不存在, fresh 是唯一
          // 合理选择 —— 不因 onInvalidResumeSession 的 CAS 结果(防并发覆盖的
          // claude 语义)拒绝 fallback。CAS 仍执行(清 DB 残留 id), 但返回值
          // 不作为 fallback 门禁:文件都没了, 不存在「覆盖并发新值」的风险。
          // (main 已合入的集成测试固化了该语义: CAS=false 仍允许 fresh)
          await opts.onInvalidResumeSession?.(opts.resumeSessionId).catch(() => undefined);
          this.deps.logger.warn('pi resume session file missing, starting fresh session', {
            resumeSessionId: opts.resumeSessionId,
          });
        } else {
          const switched = await proc.request({ type: 'switch_session', sessionPath: opts.resumeSessionId });
          if (!switched.success) {
            // 轮 25 CRITICAL:switch 失败也允许 fallback(同文件缺失理由)——
            // CAS 结果不作门禁, fresh 比卡死强。CAS 仍执行清 DB 残留。
            // 轮 42 P2(codex-connector):fresh fallback 前**必须**检查 CAS 结果
            // —— 并发 owner 已把 sdk_session_id 替换成更新的 resume 身份时,
            // 直接 fresh 新建会话会把新 handle 写回同 session row, 覆盖并发者
            // 的新身份。CAS false = 不是唯一 owner, abort 让上层重试/走并发路径。
            const casCleared = await opts.onInvalidResumeSession?.(opts.resumeSessionId).catch(() => false) ?? true;
            if (casCleared === false) {
              await proc.close().catch(() => undefined);
              throw new Error(
                `pi resume of ${opts.resumeSessionId} failed and CAS did not clear it (concurrent owner replaced it) — aborting fresh fallback to avoid overwriting the newer resume identity`,
              );
            }
            this.deps.logger.warn('pi resume failed, starting fresh session', {
              resumeSessionId: opts.resumeSessionId,
              error: switched.error,
            });
          } else {
            runtimeCaptureStage = 'switch_session';
          }
        }
      }

      if (startupEffort) {
        const resp = await proc.request({
          type: 'set_thinking_level',
          level: effortToPiThinkingLevel(startupEffort),
        });
        if (!resp.success) {
          this.deps.logger.warn('pi set_thinking_level rejected', { effort: startupEffort, error: resp.error });
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
      // 轮 40-w4-t4 CRITICAL:get_state 是 ready 边界 —— success:false(会话
      // 加载失败等)或缺失 boolean success 时, 不得把它当成启动成功并发布伪
      // session id(resume/remote 场景会把「无法确认真实会话状态」的协议失败
      // 降级成新会话, 误导上层认为恢复成功)。fail-closed: 抛错走启动失败清理。
      if (typeof state.success !== 'boolean' || !state.success) {
        throw new Error(
          `pi get_state failed (success=${String(state.success)} error=${String(state.error)}) — refusing to start with unknown session state`,
        );
      }
      const stateData = (state.data ?? {}) as {
        sessionFile?: string | null;
        sessionId?: string;
        model?: { contextWindow?: number } | null;
      };
      if (typeof stateData.model?.contextWindow === 'number' && stateData.model.contextWindow > 0) {
        ctx.contextWindow = stateData.model.contextWindow;
      }
      if (
        (typeof stateData.sessionFile !== 'string' || stateData.sessionFile.length === 0)
        && (typeof stateData.sessionId !== 'string' || stateData.sessionId.length === 0)
      ) {
        // 轮 40-w4-t4:不再用 pi-${Date.now()} 掩盖 —— 拿不到真实 session 身份
        // 就 fail-closed(伪 id 会让 resume 指向不存在的路径)。
        throw new Error('pi get_state returned no sessionFile/sessionId — refusing to start');
      }
      sdkSessionId = validateSdkSessionId(stateData.sessionFile || stateData.sessionId!);
      queue.push({ type: 'session_id', data: sdkSessionId, source: 'pi' });

      // get_state is the ready boundary. Capture exactly once after the final
      // fresh/resumed runtime has been selected; list/customization calls never
      // trigger this RPC.
      // Capability discovery is optional and must not delay session creation.
      // The ready boundary has selected the final Pi session identity; publish
      // the result later through the per-session query/listener contract.
      void refreshRuntimeCapabilities(runtimeCaptureStage);

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
      disposePiTranslateContext(ctx);
      try {
        disposeSessionRegistrations();
      } catch {
        /* best-effort:注销失败不掩盖原始启动错误 */
      }
      // startup 失败时必须确认 proc 已关闭。关闭失败的 proc 进入 session-keyed
      // quarantine；后续同 session startSession 会先重试 cleanup，绝不直接 spawn。
      // 远端失败时不清 runtime 文件；本地也只有确认进程结束后才清，避免存活
      // 进程丢 bridge/permission 状态。
      let closeError: unknown = null;
      try {
        await proc.close();
      } catch (error) {
        closeError = error;
        this.failedStartupCleanups.set(startupCleanupKey, {
          proc,
          promise: null,
          ...(!remote
            ? { cleanupLocal: () => {
                cleanupConfigHome();
                cleanupRuntimeFiles();
              } }
            : {}),
        });
      }
      if (!remote && !closeError) {
        cleanupConfigHome();
        cleanupRuntimeFiles();
      }
      if (closeError) {
        throw new Error(
          `pi startup failed and process cleanup remains unconfirmed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          { cause: err },
        );
      }
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

    const assertImageInputSupported = (images: readonly PiPromptImage[]): void => {
      if (images.length === 0) return;
      const supportsImageInput = mutablePiProviderId === PI_PROVIDER_ID
        ? gatewayImageInputByModel.get(mutableModel) === true
        : nativeProviderById
          .get(mutablePiProviderId)
          ?.models.find(
            (candidate) => candidate.id === resolveNativeModelId(mutablePiProviderId, mutableModel),
          )
          ?.input?.includes('image') === true;
      if (supportsImageInput) return;
      throw new PiImageInputUnsupportedError();
    };

    /** setModel 的串行闸(见 handle.setModel)。 */
    let setModelChain: Promise<void> = Promise.resolve();
    /**
     * setModel 的临界区正文。经 `setModelChain` 串行化后调用 —— 不要直接调它,
     * 并发进入会让 pending / 落定两次写交错。
     */
    const switchModel = async (
      model: string,
      setOpts?: { providerId?: string | null; effort?: Effort },
    ): Promise<void> => {
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
      const wireModel = resolveWireModel(provider, model);
      if (provider === PI_PROVIDER_ID) {
        const routeProviderId = requestedProviderId !== undefined
          ? requestedProviderId
          : mutableProviderId;
        const resolvedApi = this.deps.resolvePiGatewayModelApi?.(routeProviderId, model);
        if (
          resolvedApi === null ||
          (resolvedApi !== undefined &&
            resolvedApi !== 'anthropic-messages' &&
            resolvedApi !== 'openai-responses')
        ) {
          throw new Error(
            `Model Access v3 did not provide a Pi wire protocol for model: ${model}`,
          );
        }
        const desiredApi = resolvedApi ?? 'anthropic-messages';
        const configuredApi = gatewayApiByModel.get(model);
        if (configuredApi && configuredApi !== desiredApi) {
          throw new Error(
            `pi: provider switch for model '${model}' requires API '${desiredApi}', but this session ` +
              `started with '${configuredApi}'; restart the Pi session to change provider wire protocol.`,
          );
        }
      }
      // effort 能力校验必须排在写路由快照**之前**:它会抛错中止本次切换,而快照一旦落盘就
      // 指向了新 provider —— 那正是父子路由分叉的形状(upstream #1451 与本 PR 的合并点)。
      const nextEffortSnapshot = resolveStartupEffortSnapshot(provider, model);
      if (setOpts?.effort) {
        assertStartupEffortAllowed(nextEffortSnapshot, setOpts.effort);
      }
      // 远端启动快照保留会话内可切换的全部 native provider，但 SSH reverse-forward
      // 只为当前实际路由建立。否则用户仅仅登录过 xAI，就会在启动任意 Cindy/BYOM
      // 远程会话时抢占固定端口 47989；端口冲突会阻断一个完全不使用 xAI 的任务。
      // 切到 host-backed provider 前先按需建隧道，且必须排在子代理路由快照与
      // set_model RPC 之前：建隧道失败时父子路由都保持原值。
      const hostProxyForward = nativeProviderById.get(provider)?.hostProxyForward;
      if (remote && hostProxyForward) {
        if (!sessionTransport?.ensureHostProxyForward) {
          throw new Error(
            `[REMOTE_HOST_PROXY_FORWARD_UNAVAILABLE] pi: provider '${provider}' requires a Desktop host proxy forward, ` +
              'but this remote transport cannot establish one; restart the session after reconnecting the remote host.',
          );
        }
        await sessionTransport.ensureHostProxyForward(hostProxyForward);
      }
      // 子代理路由快照必须**先落盘、再切 pi 侧模型**,顺序不能反(review)。
      //
      // 上一版是先 set_model 成功、再写快照,写失败就置 `subagentRoutingEnabled = false`。
      // 那个撤销是**无效的**:该标志只在构造 spawnEnv 时读一次(会话启动、进程 spawn 之前),
      // 进程起来之后改它既不能收回已注入的 env、也不能让扩展停止读那个文件。于是"写失败 +
      // 删除也失败"(只读挂载 / 磁盘满)时,父会话已经切到新 provider,而子代理还在按**上一个
      // 有效快照**跑 —— 委派请求发往旧 endpoint,提示词与代码随之外泄到用户并没选的目的地。
      //
      // 改为:写不成就**让整个模型切换失败**,一个字节都不改。父子路由要么一起前进、要么都
      // 不动,不存在"父已切、子没切"的中间态。代价是只读文件系统下切不了模型 —— 那是显式
      // 报错、用户看得见,远好过静默把委派发到错误端点。
      //
      // 但"先落盘"单独还不够。落的若是**新路由**,那么从这一刻到 RPC 回包之间存在一个等待
      // 窗口:pi 侧仍在旧模型上,而这段时间里模型发起的 subagent 派发会现读快照、按新 provider
      // 起子进程。RPC 随后返回 `success: false` 时,回滚快照撤不回已经起来的子进程 —— 它已经
      // 在用一个 pi 明确拒绝了的 endpoint 干活(review)。
      //
      // 所以这一步落的是**带 pending 标记的**新路由:内容已经就位(证明可写、内容可回滚),但
      // 扩展见到 `pending: true` 就拒绝派发。等待窗口里一个子进程都起不来,既不会用未确认的新
      // 路由、也不会用与父不一致的旧路由;确认后再清掉标记放行。
      const previousSnapshot = {
        model: mutableWireModel,
        provider: mutablePiProviderId,
      };
      if (!(await writeSubagentRuntimeFile({ model: wireModel, provider, pending: true }))) {
        throw new Error(
          'pi: 无法持久化子代理路由快照,已取消本次模型切换(避免父会话切到新 provider 而子代理仍按旧路由派发)。'
          + '请检查运行目录是否可写后重试。',
        );
      }
      let resp;
      try {
        resp = await proc.request({
          type: 'set_model',
          provider,
          modelId: wireModel,
        });
      } catch (err) {
        // RPC **reject / 超时 / 写 stdin 失败 / 进程已退出**:与 `success:false` 有本质区别 ——
        // 那种情况我们**知道**没生效,可以回滚;这里我们**不知道** pi 侧到底切没切。
        //
        // 因此两条路都不能走:回滚可能与真实状态正好相反(RPC 其实生效了,回滚后父会话在新
        // 模型、快照指向旧模型);放行则可能相反(RPC 没生效,快照却指向新模型)。任一方向都是
        // 父子路由分叉 —— 下一次委派打到用户并未启用的端点(错误计费 + 提示词外泄)。
        //
        // 也没选"重新读取并校准":`get_state` 在本文件消费的形状里只暴露 `contextWindow`,
        // 拿不到权威的 model / provider 身份;靠未经验证的字段去猜,比直接失败更糟。而且 RPC
        // 刚超时,紧接着再发一条 RPC 很可能同样挂住。
        //
        // 所以按 fail-closed 收口:终止会话,让这个 pi 进程不再有下一次派发。快照**刻意**保持
        // `pending: true` 不动:它既不是已确认的新路由、也不是旧路由,扩展会一律拒绝派发 ——
        // 这条路径上留着 pending 正是我们想要的终态,不要"顺手"回滚成旧值。
        deps.logger.error('pi: set_model RPC did not confirm; terminating session to avoid split subagent routing', {
          message: err instanceof Error ? err.message : String(err),
        });
        try {
          await proc.close();
        } catch (closeErr) {
          deps.logger.warn('pi: session termination after unconfirmed set_model also failed', {
            message: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
        throw new Error(
          'pi: 模型切换请求未收到确认(超时或链路错误),无法确定 pi 侧是否已生效;'
          + '已终止本会话以避免子代理按不确定的路由派发。请重开会话后再切换模型。',
        );
      }
      if (!resp.success) {
        // pi 侧没切成:快照必须回滚成上一份**已确认**的路由,否则子代理会一直被 pending 挡住。
        // 这次回滚是安全的 —— 等待窗口里 pending 标记挡住了全部派发,不存在"已经起来的子进程
        // 正在用被拒绝的 provider"这种撤不回的状态(review)。
        if (!(await writeSubagentRuntimeFile(previousSnapshot))) {
          // 回滚也失败(第一次写成功之后文件系统才转只读之类):此刻盘上的快照指向**被拒绝的**
          // provider/model,而父会话仍在旧路由 —— 子代理的下一次派发就会打到用户并未启用的
          // 端点(错误计费 + 提示词与仓库上下文外泄)。
          //
          // 这里**不能**再退回 `subagentRoutingEnabled = false`(上一版就是这么写的,而它是个
          // 空操作,我在上面的注释里已经承认过):该标志只在构造 spawnEnv 时读一次,进程早就
          // 起来了,改它既收不回已注入的 env,也拦不住扩展继续读那个文件。删除文件同样已经
          // 试过并失败 —— 使用点的 fail-closed 因此也指望不上。
          //
          // 写不了、删不掉,唯一还能保证的手段就是**让这个 pi 进程不再有下一次派发**:直接
          // 终止会话。代价明确(会话中断,用户要重开),但它是可证明有效的;继续跑下去的代价
          // 是把提示词发到错误端点,那个不可接受。
          deps.logger.error(
            'pi: set_model failed and the subagent routing snapshot could not be rolled back; '
            + 'terminating the session because subagent delegation would otherwise route to the rejected provider',
          );
          try {
            await proc.close();
          } catch (err) {
            deps.logger.warn('pi: session termination after routing rollback failure also failed', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
          throw new Error(
            'pi: 模型切换失败且子代理路由快照无法回滚,已终止本会话以避免委派请求发往未启用的端点。'
            + '请检查运行目录是否可写后重开会话。',
          );
        }
        throw new Error(`pi set_model failed: ${resp.error ?? 'unknown'}`);
      }
      // pi 已确认 → 清掉 pending 标记放行派发。写失败时**不**抛错:模型切换本身确实成功了,
      // 谎报失败会让上层与 UI 状态和 pi 真实状态背离。代价是这个会话的子代理一直被 pending
      // 挡住(可见的降级、拒绝时有明确文案),而它是安全方向 —— 绝不会把委派发到错误 endpoint。
      if (!(await writeSubagentRuntimeFile({ model: wireModel, provider }))) {
        deps.logger.error(
          'pi: model switch confirmed but the subagent routing snapshot stayed pending; '
          + 'subagent delegation stays disabled for this session (fail-closed)',
        );
      }
      mutableModel = model;
      mutableWireModel = wireModel;
      mutablePiProviderId = provider;
      activeEffortSnapshot = nextEffortSnapshot;
      if (setOpts && Object.hasOwn(setOpts, 'providerId')) {
        mutableProviderId = setOpts.providerId;
      } else if (provider !== PI_PROVIDER_ID) {
        // 轮 40-w4-t13 MEDIUM:providerless 切模时实际路由变了 —— 宿主鉴权/审查
        // 元数据必须跟随实际路由, 否则 reviewAutoAction 用旧 provider 做决策
        // (AutoReviewRequest.providerId + 缓存键都错)。null/订阅来源已归一为
        // cindy(PI_PROVIDER_ID), 不在此分支。
        mutableProviderId = resolveSourceProvider(provider);
      }
      autoReviewDecisionCache.clear();
      // 换模型 / 换路由可能正好修掉了审阅器不可用的原因;换完又不可用值得再提醒一次。
      autoReviewUnavailableNotice.reset();
      autoReviewConfirmUndeliveredNotice.reset();
      const data = (resp.data ?? {}) as { contextWindow?: number };
      if (typeof data.contextWindow === 'number' && data.contextWindow > 0) {
        ctx.contextWindow = data.contextWindow;
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
      getRuntimeCapabilities() { return runtimeCapabilityManifest; },
      onRuntimeCapabilitiesChange(listener) {
        if (closed) {
          notifyRuntimeCapabilityListener(listener, undefined);
          return () => undefined;
        }
        runtimeCapabilityListeners.add(listener);
        // Replay the current snapshot synchronously so late subscribers cannot
        // miss an async ready/rewind capture that completed before registration.
        notifyRuntimeCapabilityListener(listener, runtimeCapabilityManifest);
        return () => runtimeCapabilityListeners.delete(listener);
      },

      // 每轮权限策略(IM 群 / 个人微信等)是 host 侧的 forceConfirmToolCall 回调,必须在
      // 工具执行前的审批边界强制执行。ask/auto 下 cindy-bridge 会把非只读内置工具与桥接
      // MCP 工具冒泡进 host 审批,故 host 每轮策略可被执行;唯 bypassPermissions 下 bridge
      // 按 perm 文件现读直接放行、tool_call 根本不冒泡,host 无从执行该回调 —— 故只在
      // Full Access 下 fail-closed 拒绝带策略的 send(与 capability
      // turnPermissionPolicy.unsupportedPermissionModes 一致,也与 CC/Codex 同口径)。
      validateSendOptions(sendOpts: SendOptions) {
        if (sendOpts.turnPermissionPolicy && permissionMode === 'bypassPermissions') {
          throw new TurnPermissionPolicyUnsupportedError('pi', permissionMode);
        }
      },

      async send(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        rejectIfCancelled(sendOpts, 'send');
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        // 本轮策略覆盖:无策略显式清 null,不继承上一轮渠道策略(§7.2.5);内部续跑
        // (plan 审批实施轮 / 自动继续)不经 send,仍读这份闭包值继承(§7.10)。
        // provider 接受前任何失败都必须撤销,避免"任务显示已开始、实际未启动"却残留策略。
        const previousTurnPermissionPolicy = activeTurnPermissionPolicy;
        activeTurnPermissionPolicy = sendOpts?.turnPermissionPolicy ?? null;
        let providerAccepted = false;
        let promptRequestStarted = false;
        try {
          if (reviewMode) {
            await assertReviewMessageContentPaths(
              message.content,
              opts.workingDir,
              reviewReadGrants,
            );
          }
          const { text, images } = await buildPiPrompt(message, { remote });
          rejectIfCancelled(sendOpts, 'send');
          assertImageInputSupported(images);
          setAutoReviewIntent(message.content);
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
          promptRequestStarted = true;
          const resp = await proc.request(command, {
            timeoutMs: PI_PROMPT_ACCEPTANCE_TIMEOUT_MS,
            // Prompt acceptance may legitimately span multiple compaction
            // retries. Bound each silent interval, not the whole progressing
            // preflight, so a healthy long compaction is not killed at 10m.
            refreshTimeoutOnEvent: (event) =>
              PI_PROMPT_ACCEPTANCE_PROGRESS_EVENTS.has(event.type),
          });
          if (!resp.success) {
            if (resp.command !== command.type) {
              throw new Error('pi prompt rejection response missing matching command');
            }
            throw new TurnDispatchRejectedError(
              `pi prompt rejected before acceptance: ${resp.error ?? 'unknown'}`,
            );
          }
          providerAccepted = true;
          await reportAcceptedPiUserEntry(userEntriesBefore, sendOpts?.onTranscriptUserEntry);
        } catch (err) {
          // 只在 Provider 尚未接受本轮时回滚。接受后的 transcript 回调失败不代表
          // turn 没启动；此时恢复旧 policy 会让正在运行的新 turn 用错安全边界。
          if (!providerAccepted) activeTurnPermissionPolicy = previousTurnPermissionPolicy;
          // Before proc.request the turn is known not to have reached Pi. Once
          // request starts, a transport/write/envelope failure cannot prove
          // whether Pi accepted the prompt; only success:false is an explicit
          // rejection. Fence every other unknown result before Goal may resume.
          if (
            promptRequestStarted
            && !providerAccepted
            && !(err instanceof TurnDispatchRejectedError)
          ) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new TurnDispatchUnconfirmedError(
              `Pi did not confirm prompt acceptance: ${detail}`,
              { cause: err },
            );
          }
          throw err;
        }
      },

      async steer(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        rejectIfCancelled(sendOpts, 'steer');
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        if (reviewMode) {
          await assertReviewMessageContentPaths(
            message.content,
            opts.workingDir,
            reviewReadGrants,
          );
        }
        const { text, images } = await buildPiPrompt(message, { remote });
        rejectIfCancelled(sendOpts, 'steer');
        assertImageInputSupported(images);
        setAutoReviewIntent(message.content);
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
        // 先把等待中的调用 fail-closed 唤醒；即使 abort RPC 失败，也不能让用户刚拒绝/
        // 停止的那次工具继续等一张已失效的卡。policy 仅在 Pi 确认接受 abort 后清空，
        // RPC 失败时继续保留，防止仍在运行的 turn 失去渠道安全边界。
        dismissAllPendingPrompts('turn_aborted', 'deny');
        try {
          const resp = await proc.request({ type: 'abort' });
          if (resp.success) {
            clearActiveTurnPermissionPolicy('turn_aborted');
          } else {
            deps.logger.warn('pi abort request rejected', { message: resp.error ?? 'unknown' });
          }
        } catch (err) {
          deps.logger.warn('pi abort request failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },

      async close(): Promise<void> {
        closed = true;
        disposePiTranslateContext(ctx);
        runtimeCapabilityGeneration++;
        publishRuntimeCapabilities(undefined);
        runtimeCapabilityListeners.clear();
        // 会话结束时挂起的卡已经不可能有人回答:清 policy 并强制 deny,别让等它的调用
        // 悬着(同 CC / Codex)。
        clearActiveTurnPermissionPolicy('session_closed', { dismissPending: true });
        // 先注销 bridge 身份注册(幂等),再关子进程。放前面:即便 proc.close 抛错
        // 也不泄漏 ctx —— 该 sessionId 的 `?session=` 路由必须随会话结束失效。
        try {
          disposeSessionRegistrations();
        } catch (err) {
          deps.logger.warn('pi dispose session registration failed (non-fatal)', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
        // A local close is only complete after proc.close confirms process exit.
        // Until then the still-live process may continue reading its isolated
        // config, permission policy, and subagent routing snapshot.
        await proc.close();
        if (!remote) {
          // 会话结束:清理隔离的 configHome 与 runtime 文件(onExit 幂等,二者先到先清)。
          cleanupConfigHome();
          cleanupRuntimeFiles();
        }
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

      async setModel(model: string, setOpts?: { providerId?: string | null; effort?: Effort }): Promise<void> {
        if (reviewMode) return;
        // 会话级串行闸:整段"写待切换快照 → set_model RPC → 落定/回滚"必须是一个临界区。
        // 并发或连点切换(本地 + 远程控制端同时切)若交错,A 写 pending、B 写 pending、A 落定 B 的
        // 内容,盘上就会出现没人确认过的组合。串行化之后每次切换都看到确定的前一状态,
        // `previousSnapshot` 才是真正可回滚的那一份(review)。
        const run = setModelChain.then(() => switchModel(model, setOpts));
        // 链永不停在 rejected 上:一次失败之后的切换仍要能排进来。
        setModelChain = run.then(() => {}, () => {});
        return run;
      },

      async setEffort(effort: Effort): Promise<void> {
        if (reviewMode) return;
        assertStartupEffortAllowed(activeEffortSnapshot, effort);
        if (activeEffortSnapshot?.length === 0) return;
        const resp = await proc.request({
          type: 'set_thinking_level',
          level: effortToPiThinkingLevel(effort),
        });
        if (!resp.success) throw new Error(`pi set_thinking_level failed: ${resp.error ?? 'unknown'}`);
      },

      async setPermissionMode(mode): Promise<void> {
        if (reviewMode) {
          deps.logger.debug('pi setPermissionMode ignored for hard read-only Review session', {
            requested: mode,
          });
          return;
        }
        // ask/auto/bypass 三档;extension 每次 tool_call 现读,写完即生效。
        // auto 的差异在 Cindy 侧 dispatcher(handleExtensionUiRequest),bridge 无感知。
        const nextMode = normalizePermissionMode(mode);
        // 用户自己动过权限档 → 一次性提示重新武装(与 Claude / Codex 同口径)。
        // 档位变了 → 连**裁决缓存**一起清。缓存 key 不含 permissionMode,切离 Auto 再切回时
        // 会命中先前那条 `unavailable` block —— 审阅器早就恢复了,同一个动作还是被拒
        // (greptile P1 of #1574)。一次性提示同步重新武装:用户既然接管过,之后又不可用
        // 值得再提醒一次。
        if (nextMode !== requestedPermissionSnapshot.mode) {
          autoReviewDecisionCache.clear();
          autoReviewUnavailableNotice.reset();
          autoReviewConfirmUndeliveredNotice.reset();
        }
        const previousMode = requestedPermissionSnapshot.mode;
        await writePermissionSnapshotOrFailClosed({
          ...requestedPermissionSnapshot,
          mode: nextMode,
        });
        // 写入成功后才 settle 挂起的卡(写失败会 fail-closed 抛出,档位没真变就不该收卡)。
        // 没有这一步,用户切到 Full access 后仍要手动回答一张已失效的卡,调用一直卡着。
        //
        // 只有**最新且已落盘**的那次切换可以收卡:被更晚意图取代的写会在代际检查处提前
        // 返回、但 promise 仍 resolve 成功(见 writePermissionFile 的 `gen !== permissionWriteGen`),
        // 旧 continuation 若照自己捕获的 transition 收卡,就会用一次早已作废的放宽把 pending
        // 调用错误放行,而真正生效的收紧只能看到卡已经没了(codex review P1)。
        const stillLatestIntent = requestedPermissionSnapshot.mode === nextMode;
        const persisted = persistedPermissionSnapshot.mode === nextMode;
        if (nextMode !== previousMode && stillLatestIntent && persisted) {
          // **只有 bypassPermissions 算「放宽」**。Auto 的语义是「区内放行、越界升级」而不是
          // 全放行,而挂起的卡本就是被升级的越界/风险动作 —— 切到 Auto 若替用户 allow,等于
          // 把待确认的越界动作橡皮图章掉;应当 deny,让模型重试时重新过一遍 fail-closed 的
          // Auto dispatcher。与 CC / Codex 的同名裁决一致(claude-code/index.ts 的 moreOpen)。
          dismissAllPendingPrompts(
            `permission_mode_changed_to_${nextMode}`,
            nextMode === 'bypassPermissions' ? 'allow' : 'deny',
          );
        }
      },

      async setExtraDirs(dirs: string[]): Promise<void> {
        if (reviewMode) return;
        await writePermissionSnapshotOrFailClosed({
          ...requestedPermissionSnapshot,
          readOnlyRoots: [...dirs],
        });
      },

      async setVendorOptions(patch: Record<string, unknown>): Promise<void> {
        Object.assign(mutableVendorOptions, patch);
        deps.logger.debug('pi setVendorOptions', { patchKeys: Object.keys(patch) });
      },

      isTurnRunning(): boolean {
        // ctx.isStreaming 由 agent_start / agent_settled 翻转(translator 维护)。
        return ctx.isStreaming;
      },

      async setPlanMode(enabled: boolean): Promise<void> {
        if (reviewMode) return;
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
        // Pi has switched runtime identity at the successful fork response. Clear
        // the old catalog before any follow-up get_state can fail or time out.
        runtimeCapabilityGeneration++;
        publishRuntimeCapabilities(undefined);
        const state = await proc.request({ type: 'get_state' });
        if (!state.success) throw new Error(`pi rewind get_state failed: ${state.error ?? 'unknown'}`);
        const replacement = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
        if (!replacement) throw new Error('pi rewind replacement session path unavailable');
        sdkSessionId = validateSdkSessionId(replacement);
        queue.push({ type: 'session_id', data: replacement, source: 'pi' });
        // 轮 40-w4-t17 HIGH-2:rewind 切到新 session file 后必须重读 plan-mode
        // entry —— 与 ready 路径(readPersistedPlanMode)同语义:新分支的 plan
        // 状态可能与旧闭包 planModeActive 不一致, 不校正会让 UI/DB 残留旧分支
        // 状态, 且下次 setPlanMode 因 enabled===planModeActive 直接 no-op。
        const planModeAfterFork = planModeExtAvailable ? await readPersistedPlanMode() : null;
        if (planModeAfterFork !== null && planModeAfterFork !== planModeActive) {
          planModeActive = planModeAfterFork;
          queue.push({ type: 'plan_mode_changed', data: { enabled: planModeAfterFork }, source: 'pi' });
        } else if (planModeAfterFork === null && planModeActive) {
          // 新分支读不到 plan entry(异常/旧格式):不能假定沿用旧分支的开启态,
          // 置回未开启并通知(保守, 用户可再开)。
          planModeActive = false;
          queue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'pi' });
        }
        // The Pi session has already switched to the replacement file. Do not
        // make rewind wait for optional discovery; the generation fence keeps
        // this asynchronous refresh from publishing stale data.
        void refreshRuntimeCapabilities('fork');
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
    // 远端会话的 session 文件在远端机器,本地 fork 的 stdio 读不到;且 fork 是离线
    // 纯文件操作,走本地 fs 会误读本机 agentHome。显式报错(对齐 CC/Codex 远端 fork 语义
    // —— 它们由 daemon 在远端执行;PI 的 daemon 化见 Phase 3)。
    // 判定用 opts.remoteHostId(编排层从源 session 传), 不用实例字段 —— 并发
    // 会话覆盖 lastRemoteHostId 会双向误判(R4 竞态 #1)。
    if (opts.remoteHostId) {
      throw new NotSupportedError('remoteFork', {
        supported: false,
        reason: 'not-implemented',
        message: 'pi fork is not supported for remote sessions yet (Phase 3 daemon)',
      });
    }
    const log = this.deps.logger;
    const agentHome = this.resolveAgentHome(opts.remoteHostId);
    const sessionDir = joinRemotePosixPath(agentHome, 'sessions');
    // 离线 fork 只需 models.json 里有 `cindy` 供应商供 pi 启动校验 --provider。
    // 不能写共享的 agentHome/models.json:另一窗口正启动 BYOM 会话时(startSession
    // 写入 native providers 后到 spawn 之间还有多个 await),本处覆盖会把该 provider
    // 清掉,导致那个 spawn 携带 --provider <byom> 却找不到而启动失败(codex review)。
    // 用隔离的 coding-agent 目录承载 fork 专属 models.json(PI_CODING_AGENT_DIR),
    // --session-dir 仍指向共享 sessions(两者是独立 flag),互不干扰。
    const forkHome = joinRemotePosixPath(agentHome, 'fork-tmp', randomBytes(8).toString('hex'));
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

    // fork 始终走本地 stdio transport(session 文件在本地 agentHome;远端分支见
    // forkSdkSession 的 remote 化,暂未支持)。
    const { transport: forkTransport } = await this.createTransport(
      {
        args: [
          '--mode', 'rpc',
          '--no-approve',
          '--no-extensions',
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
      },
      (pid) =>
        this.deps.registerLocalAgentProcess?.({
          pid,
          kind: 'pi',
          role: 'control-plane-service',
        }),
    );
    const proc = new PiRpcProcess({
      transport: forkTransport,
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
      // This short-lived control-plane process is closed immediately. The
      // newly created live session will capture its own authoritative catalog
      // at ready; do not hold this fork path for an optional 5s RPC timeout.
      return { newSdkSessionId: newPath, uuidMap: new Map() };
    } finally {
      await proc.close();
      // 清理隔离的 fork 家目录(只含 models.json;新分支 session 文件在共享 sessions,不受影响)。
      await fs.rm(forkHome, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** SkillHub raw view; project items remain discovered until runtime truth says otherwise. */
  override async listCustomizations(
    opts: ListCustomizationsOptions,
  ): Promise<ListCustomizationsResult> {
    return scanPiCustomizations(opts);
  }

  /**
   * ChatInput `/` palette 的 agent-skill 类目 —— 纯文件系统发现,与 CC/Codex 对齐。
   *
   * 扫共享根 ~/.agents/skills + 项目 .pi/skills 和从 cwd 到 Git 根的
   * .agents/skills。项目条目仅表示已发现；只有 get_commands 能确认 loaded。
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
          runtimeStatus: it.runtimeStatus,
          runtimeCommandName: `skill:${it.name}`,
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
      /** 审阅器不可用时的会话级一次性提示;去重与重置由会话侧持有(issue #1574)。 */
      notifyAutoReviewUnavailable: () => void;
      /** 故障确认没送到 / 被系统收口时纠正「用户拒绝」归因。 */
      notifyAutoReviewConfirmUndelivered: () => void;
      /** 本会话实际注册过的桥接 MCP server 名;MCP 归属判定只认这批(防冒名顶替)。 */
      registeredMcpServerNames: ReadonlySet<string>;
      sessionId: string;
      workingDir: string;
      remote: boolean;
      /**
       * 把一张挂起的权限卡登记进会话级表,返回注销函数。档位切换 / 关闭会话时由
       * `dismissAllPendingPrompts` 强制 settle,避免放宽档位后调用仍卡在失效的卡上。
       */
      registerPendingPrompt: (
        requestId: string,
        entry: {
          settle: (resolveAs: 'allow' | 'deny') => void;
          forcePrompt: boolean;
          unavailableHandoff?: boolean;
        },
      ) => () => void;
      /**
       * 本轮 host 权限策略(个人微信 / Telegram 群等);无策略为 null。命中
       * forceConfirmToolCall 的调用必须走用户确认,压过 MCP auto-approve 与 auto
       * 档 Auto-Review 的 allow(§7.4 优先级)。策略抛异常按"必须询问"收口。
       */
      turnPermissionPolicy: TurnPermissionPolicy | null;
    },
  ): void {
    const method = typeof event.method === 'string' ? event.method : '';
    const id = typeof event.id === 'string' ? event.id : undefined;
    if (!id) return;

    if (method === 'confirm' && event.title === 'cindy:turn-change-capture') {
      let toolName = '';
      let input: Record<string, unknown> = {};
      try {
        const payload = JSON.parse(typeof event.message === 'string' ? event.message : '{}') as {
          toolName?: unknown;
          input?: unknown;
        };
        if (typeof payload.toolName === 'string') toolName = payload.toolName;
        if (payload.input && typeof payload.input === 'object') input = payload.input as Record<string, unknown>;
      } catch {
        // Malformed capture payload is non-fatal; let the tool proceed and mark it opaque.
      }
      const context = getPermissionCtx();
      void (async () => {
        if (!context.sessionId || !context.workingDir) return;
        const targetPath = typeof input.path === 'string' ? input.path : null;
        if (targetPath && (toolName === 'edit' || toolName === 'write')) {
          await this.deps.turnChangeCapture?.beforeKnownFileWrite({
            sessionId: context.sessionId,
            provider: 'pi',
            cwd: context.workingDir,
            targetPath,
            ...(context.remote ? { remote: true } : {}),
          });
        } else {
          this.deps.turnChangeCapture?.noteOpaqueWrite({
            sessionId: context.sessionId,
            provider: 'pi',
            cwd: context.workingDir,
            ...(context.remote ? { remote: true } : {}),
          });
        }
      })().catch((error) => {
        this.deps.logger.warn('pi turn change capture failed', {
          toolName,
          message: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        proc.send({ type: 'extension_ui_response', id, confirmed: true });
      });
      return;
    }

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
        notifyAutoReviewUnavailable,
        notifyAutoReviewConfirmUndelivered,
        registeredMcpServerNames,
        registerPendingPrompt,
        turnPermissionPolicy,
      } = getPermissionCtx();
      /**
       * 本轮策略是否强制确认此工具调用。命中 → 必须走用户确认(forcePrompt),
       * 不被 MCP auto-approve 或 Auto-Review allow 覆盖。策略回调是 host 注入的外部
       * 代码:同步抛错不能变成放行,按"必须询问" fail-closed(与 CC/Codex 同口径)。
       */
      const turnPolicyForcePrompt = ((): boolean => {
        if (!turnPermissionPolicy) return false;
        try {
          return turnPermissionPolicy.forceConfirmToolCall(toolName, input) === true;
        } catch (err) {
          this.deps.logger.error('pi turn permission policy threw -> force confirmation', {
            toolName,
            origin: turnPermissionPolicy.origin,
            message: err instanceof Error ? err.message : String(err),
          });
          return true;
        }
      })();
      const mcpTarget = resolveMcpToolTarget(toolName, registeredMcpServerNames);
      const hostApprovalPresentation = (() => {
        const presenter = this.deps.getMcpToolApprovalPresentation;
        if (!presenter || !mcpTarget) return undefined;
        try {
          return presenter({
            serverName: mcpTarget.serverName,
            toolName: mcpTarget.toolName,
            toolParams: input,
          });
        } catch (err) {
          this.deps.logger.error('MCP approval presentation threw -> generic copy', {
            serverName: mcpTarget.serverName,
            message: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      })();
      /**
       * 向用户要一次表态。`decided` 区分「用户明确表态」与「压根拿不到决策」(无 resolver /
       * resolver 抛错 / kind 不匹配) —— 调用方对后者才允许按 Full access 语义放行,
       * 不能把用户的明确拒绝也一并翻转。
       */
      const requestUserDecision = async (
        opts: { forcePrompt: boolean; unavailableHandoff?: boolean },
      ): Promise<{ decided: boolean; approved: boolean }> => {
        if (!resolver) {
          this.deps.logger.warn('pi permission request has no interaction resolver', { toolName });
          if (opts.unavailableHandoff) notifyAutoReviewConfirmUndelivered();
          return { decided: false, approved: false };
        }
        // 登记进会话级 pending 表:等卡期间用户切档(或关会话)时由 dismissAllPendingPrompts
        // 强制 settle,不再干等一张已经失效的卡。settled 门防止两边重复 resolve。
        return new Promise<{ decided: boolean; approved: boolean }>((resolve) => {
          let settled = false;
          let unregister: (() => void) | null = null;
          const finalize = (outcome: { decided: boolean; approved: boolean }): void => {
            if (settled) return;
            settled = true;
            unregister?.();
            resolve(outcome);
          };
          unregister = registerPendingPrompt(id, {
            forcePrompt: opts.forcePrompt,
            ...(opts.unavailableHandoff ? { unavailableHandoff: true } : {}),
            // 切档替用户做的临时决定同样是「已决」—— 调用方不该再按 bypass 语义二次翻转。
            settle: (resolveAs) => finalize({ decided: true, approved: resolveAs === 'allow' }),
          });
          // resolver 是 host 注入的外部回调:可能同步 throw,也可能返回非 Promise。直接
          // `.then` 会让同步异常绕过下面的 finalize —— pending 条目永不注销、这次请求永不
          // settle,调用就此悬挂(copilot 报)。包一层把同步失败也收进 fail-closed 分支。
          const permissionRequest = {
            kind: 'permission' as const,
            requestId: id,
            toolName,
            input,
            ...(hostApprovalPresentation?.title
              ? { title: hostApprovalPresentation.title }
              : {}),
            ...(hostApprovalPresentation?.description
              ? { description: hostApprovalPresentation.description }
              : {}),
          };
          Promise.resolve().then(() => resolver(
            opts.unavailableHandoff
              ? annotatePermissionRequestForUnavailableReview(permissionRequest)
              : permissionRequest,
          )).then((decision) => {
            if (decision.kind !== 'permission') {
              this.deps.logger.warn('pi permission got mismatched decision kind', {
                toolName,
                decisionKind: decision.kind,
              });
              if (opts.unavailableHandoff) notifyAutoReviewConfirmUndelivered();
              finalize({ decided: false, approved: false });
              return;
            }
            if (
              opts.unavailableHandoff
              && decision.behavior === 'deny'
              && isSystemPermissionDenialReason(decision.reason)
            ) {
              notifyAutoReviewConfirmUndelivered();
            }
            finalize({ decided: true, approved: decision.behavior === 'allow' });
          }).catch((err) => {
            this.deps.logger.warn('pi permission resolver failed', {
              toolName,
              message: err instanceof Error ? err.message : String(err),
            });
            if (opts.unavailableHandoff) notifyAutoReviewConfirmUndelivered();
            finalize({ decided: false, approved: false });
          });
        });
      };
      /**
       * Full access 的语义是「不问、全放行」。档位支持会话中途热切换(bridge 每次 tool_call
       * 现读 perm 文件),所以必须**按最新档位**判断,不能用请求冒泡那一刻的快照。
       */
      const isFullAccessNow = (): boolean =>
        getPermissionCtx().permissionMode === 'bypassPermissions';
      /**
       * `forcePrompt` 标记高风险审批(MCP prompt-each-time、灰区 ask、审查中收紧档位):
       * 等卡期间用户把档位放宽,这类**不**接受批量放行,仍按 fail-closed 拒绝 —— 与 CC /
       * Codex 的 dismissAllPending 同口径。
       */
      const requestUserConfirmation = async (
        opts?: { forcePrompt?: boolean; unavailableHandoff?: boolean },
      ): Promise<boolean> => {
        // 发起确认前:已切到 Full access 就不该再弹卡。
        // 但 forcePrompt 代表不能被权限放宽追认的安全边界；若 host lease / 预检失效
        // 真的让 policy turn 落进 Full access，宁可拒绝也不能静默放行。
        if (isFullAccessNow()) {
          if (opts?.forcePrompt === true && opts.unavailableHandoff) {
            notifyAutoReviewConfirmUndelivered();
          }
          return opts?.forcePrompt === true ? false : true;
        }
        const outcome = await requestUserDecision({
          forcePrompt: opts?.forcePrompt === true,
          ...(opts?.unavailableHandoff ? { unavailableHandoff: true } : {}),
        });
        // 已有决策(用户明确表态,或切档时代为 settle)→ 以它为准,不再被档位二次翻转。
        if (outcome.decided) return outcome.approved;
        // 拿不到决策:Full access 下按 bypass 语义放行,其余一律 fail-closed。
        return opts?.forcePrompt === true ? false : isFullAccessNow();
      };
      void (async () => {
        // Full access 优先收口,压在所有后续判定之前。bridge 侧按 perm 文件现读已把 bypass
        // 拦在冒泡之前,但档位是热切换的:confirm 冒泡之后用户仍可能切到 Full access。此时
        // MCP 策略 / 灰区审阅 / 弹窗都不该再改变「全放行」语义,也不该因为没有 resolver 就
        // 拒掉工具调用(与 auto 分支既有的 modeAfterReview bypass 收口同口径)。
        // 本轮策略命中时不吃 Full Access 短路:policy + bypassPermissions 已在 send 预检
        // 拒绝、且 policy turn 持 host lease 堵死热切到 bypass,故此处 turnPolicyForcePrompt
        // 为真本不可达;仍显式 fail-closed,避免任一上游闸门被绕过就静默放行破坏性调用。
        if (isFullAccessNow() && !turnPolicyForcePrompt) {
          proc.send({ type: 'extension_ui_response', id, confirmed: true });
          return;
        }
        // 桥接 MCP 工具走 host 审批策略,**不进 Auto-review 灰区** —— 与 Claude Code /
        // Codex 同一份真源(`getDesktopMcpToolApprovalPolicy`)。
        //
        // 为什么不能交模型判:auto-review 是安全分类器,而"要不要开协同团队 / 该不该用
        // 某个 MCP 工具"是做法选择,不是安全判断。实测把 `mcp__cindy_orca__start_team`
        // 送去审阅时,模型会按 prompt 里"有更安全替代方案就 block"的字面判成"这点小事
        // 不必开团队"→ block 对用户静默 → 冒泡回 bridge 就是
        // "User denied this tool call via Cindy",团队永远建不起来且没有任何弹窗。
        // 同一个第一方 MCP 在三个 harness 下必须给出同一个答案(base-agent.ts
        // getMcpToolApprovalPolicy 注释),此前 Pi 是唯一没接这条的。
        //
        // 位置与 CC 一致:策略判定在档位分支**之前** —— auto-approve 的第一方 server 在
        // ask 档也不弹窗(CC claude-code/index.ts 的 mcpApprovalPolicy 分支同义)。
        //
        // 返回 null = 不查策略,**回落原有权限链**(ask 档弹窗 / auto 档进灰区审阅),行为与
        // 接策略之前完全一致:host 没提供 classifier,或工具名对不上任何本会话已注册的
        // server(认不出归属就不敢按第一方放行)。策略抛错或返回非法值则不回落 ——
        // 那是策略本身故障,按 prompt-each-time fail-closed 收口。
        const mcpPolicy = ((): 'auto-approve' | 'prompt' | 'prompt-each-time' | null => {
          const classifier = this.deps.getMcpToolApprovalPolicy;
          if (!classifier) return null;
          if (!mcpTarget) return null;
          try {
            const policy = classifier({
              serverName: mcpTarget.serverName,
              toolName: mcpTarget.toolName,
              toolParams: input,
            });
            if (policy === 'auto-approve' || policy === 'prompt' || policy === 'prompt-each-time') {
              return policy;
            }
            this.deps.logger.error('invalid MCP approval policy -> user confirmation', {
              serverName: mcpTarget.serverName,
              policy,
            });
          } catch (err) {
            this.deps.logger.error('MCP approval policy threw -> user confirmation', {
              serverName: mcpTarget.serverName,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return 'prompt-each-time';
        })();
        if (mcpPolicy !== null) {
          // Pi 的权限门只有放行/拒绝两态,没有会话级持久化规则,因此 prompt 与
          // prompt-each-time 在这里收敛成同一个动作:每次都问用户。本轮策略命中时
          // auto-approve 也不放行 —— 渠道安全契约压过第一方 MCP 自动批准(§7.4)。
          proc.send({
            type: 'extension_ui_response',
            id,
            confirmed: mcpPolicy === 'auto-approve' && !turnPolicyForcePrompt
              ? true
              : await requestUserConfirmation({
                  forcePrompt: turnPolicyForcePrompt || mcpPolicy === 'prompt-each-time',
                }),
          });
          return;
        }
        if (permissionMode !== 'auto') {
          proc.send({
            type: 'extension_ui_response',
            id,
            confirmed: await requestUserConfirmation({ forcePrompt: turnPolicyForcePrompt }),
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
            proc.send({
              type: 'extension_ui_response',
              id,
              confirmed: !turnPolicyForcePrompt,
            });
            return;
          }
          if (modeAfterReview !== 'auto') {
            // 审查期间用户主动收紧了档位 → 这一次必须拿到明确确认,等卡期间再放宽也不追认
            // (forcePrompt,与 CC 对 AI ask / 确定性红线的处理同口径)。
            proc.send({
              type: 'extension_ui_response',
              id,
              confirmed: await requestUserConfirmation({ forcePrompt: true }),
            });
            return;
          }
          // 本轮策略命中:压过 Auto-Review 的 allow / block,一律走渠道确认(forcePrompt)。
          if (turnPolicyForcePrompt) {
            proc.send({
              type: 'extension_ui_response',
              id,
              confirmed: await requestUserConfirmation({ forcePrompt: true }),
            });
            return;
          }
          if (decision.verdict === 'ask') {
            // 审阅器故障降级来的 ask 提示一次:用户需要知道自己为何突然开始被问,
            // 否则 Auto 档看起来像坏了。模型判定的 ask 不提示(那是正常工作)。
            if (decision.unavailable) notifyAutoReviewUnavailable();
            // policy turn + auto 的灰区语义对齐 Codex:只有渠道 policy 明确命中的调用
            // 才打扰 owner；普通 Auto-Review ask 直接 fail-closed，不再额外弹微信确认。
            // 无 policy 的 Desktop auto 会话维持既有逐次确认行为。
            //
            // **故障降级(unavailable)例外**:上面刚告诉用户"已转由你确认",若这里仍按
            // policy 静默拒绝,提示与行为就自相矛盾 —— 用户看到可接管的说明却没有确认
            // 入口,操作照样被拒(PR #2474 review)。故障不是"模型判定该问",而是基础
            // 设施失灵,用户有权亲自决定,所以走真实确认。
            const askNeedsUserDecision = decision.unavailable || !turnPermissionPolicy;
            proc.send({
              type: 'extension_ui_response',
              id,
              confirmed: askNeedsUserDecision
                ? await requestUserConfirmation({
                    forcePrompt: true,
                    unavailableHandoff: decision.unavailable === true,
                  })
                : false,
            });
            return;
          }
          if (decision.verdict === 'block') {
            // 模型判定动作有更安全的做法 —— 按 Auto 本意保持静默。
            // (审阅器故障已在 resolveAutoReviewDecision 降级成 ask,不会走到这里。)
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
