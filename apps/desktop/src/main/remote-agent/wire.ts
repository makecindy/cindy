/**
 * 远程 Agent 的载荷编解码(两端共用)。
 *
 * maker-core 的启动选项与发送选项里有回调、AbortSignal 和 Symbol 键(只有本进程主线程能附上的
 * 证明)，不能原样过设备互联。这里把它们换成可序列化的描述：
 *  - 回调 → 标记位，被控端调用时作为反向请求回到控制端执行；
 *  - Symbol 键 → `cindy` 子对象，被控端解码后重新附到 Symbol 键上(请求来自已鉴权的同账号
 *    控制端主进程，与本机主进程附上这些证明的前提一致。供应商分享的受邀者同样还原：这些证明
 *    只影响受邀者自己电脑上的权限判断与确认，工具执行仍经它自己电脑的执行器把关)；
 *  - 每轮权限策略 → 已知策略按名字还原(两端同一份代码)，认不出的一律按「全部确认」还原；
 *  - 消息里的图片 → 字节随载荷带过去，被控端写到本次任务的附件目录再引用。
 * 被控端解码时按最小合同校验类型，不认识的字段丢弃。
 */
import {
  AUTO_REVIEW_DELEGATED_CONTINUATION,
  AUTO_REVIEW_SOURCE_CONTENT,
  AUTO_REVIEW_USER_INTENT,
  INHERITED_CAPABILITY_SELECTION,
  MAIN_OWNED_SEND_CONTEXT,
  type SendOptions,
  type StartSessionOptions,
  type TurnPermissionOrigin,
  type TurnPermissionPolicy,
  type UserContentBlock,
  type UserMessage,
} from '@cindy/maker-core';
import { projectAutoReviewUserReferences } from '@cindy/maker-shared/auto-review-intent';

import {
  channelForceConfirmMutatingToolCall,
  channelForceConfirmToolCall,
} from '../im/shared/channelToolPolicy';

export const REMOTE_AGENT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PROJECT_FILES = 512;
const MAX_TEXT = 512 * 1024;

// ─── 通用校验 ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optString(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown, maxItems = 256): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 4096);
  return items.length === value.length ? items : undefined;
}

/** JSON 往返：丢掉函数、Symbol 键与 undefined，保证能过设备互联。 */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function prune<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

// ─── 打开任务 ────────────────────────────────────────────────────

/** 任务所在电脑的工作区描述(给 Agent 的提示与执行器边界用)。 */
export interface RemoteAgentWireWorkspace {
  workingDir: string;
  extraDirs: string[];
  writableDirs: string[];
  platform: NodeJS.Platform;
  shell: string;
  osVersion?: string;
  homeDir?: string;
  isGitRepo: boolean;
}

/** 同步到 Agent 所在电脑影子目录的项目说明类小文件(相对工作目录、`/` 分隔)。 */
export interface RemoteAgentWireFile {
  path: string;
  data: string;
}

export interface RemoteAgentWireStartOptions {
  model: string;
  providerId?: string | null;
  effort?: string;
  fastMode?: boolean;
  thinkingEnabled?: boolean;
  userPrompt?: string;
  botProfilePrompt?: string;
  botProfileContextPrompt?: string;
  botUserProfilePrompt?: string;
  makerMemoryEnabled?: boolean;
  makerMemoryScopeKey?: string;
  makerMemoryIndexSnapshot?: string;
  permissionMode?: string;
  planMode?: boolean;
  displayReasoning?: string;
  resumeSessionId?: string;
  codexHistoryHasProductPrompt?: boolean;
  vendorOptions?: Record<string, unknown>;
  /** 控制端注入了 invalid-resume CAS 回调。 */
  invalidResumeCallback?: boolean;
}

/** 项目上级目录里的说明文件(相对工作目录向上 up 级)。 */
export interface RemoteAgentWireAncestorFile {
  up: number;
  name: string;
  data: string;
}

/** 你这台的个人配置(用户级)，在那台电脑上以项目级配置的形式提供给 Agent。 */
export interface RemoteAgentWirePersonal {
  /** 个人说明(Claude Code 的 ~/.claude/CLAUDE.md)：放在影子目录最外层，最先加载、优先级最低。 */
  memory?: string;
  /** 个人 Skill / 子代理 / 命令(相对影子目录的路径，如 `.claude/skills/x/SKILL.md`)；项目里有同名的以项目为准。 */
  files: RemoteAgentWireFile[];
  /** 个人权限规则(并入项目 local 设置)。 */
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  /** 个人说明(Codex 的 AGENTS.md 等)：写进给 Agent 的环境说明。 */
  instructions?: string;
}

export interface RemoteAgentOpenPayload {
  /** 控制端任务 id。 */
  sessionId: string;
  /** 能力增量：Agent 使用本机虚拟工作区；新控制端在 open 前必须确认对端 caps 支持。 */
  virtualWorkspace?: boolean;
  options: RemoteAgentWireStartOptions;
  workspace: RemoteAgentWireWorkspace;
  projectFiles: RemoteAgentWireFile[];
  /** 项目上级目录里的说明文件。 */
  ancestorFiles: RemoteAgentWireAncestorFile[];
  /** 你这台的个人配置。 */
  personal: RemoteAgentWirePersonal;
  /** 控制端经隧道提供的 Cindy MCP 服务名。 */
  mcpServers: string[];
}

/** 上级目录说明文件只认这几个名字，最多向上这么多级。 */
export const ANCESTOR_INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'] as const;
export const MAX_ANCESTOR_LEVELS = 24;
/**
 * 同步到影子目录的项目文件白名单(控制端按它收集；被控端对不受信任的控制端按它复核)：
 * 工作目录根上的说明文件、Claude Code 项目设置(只保留权限规则)，以及这些目录下的
 * Skill / 子代理 / 命令 / 提示词模板。
 */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'] as const;
export const PROJECT_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;
export const PROJECT_INSTRUCTION_DIRECTORIES = [
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.agents/skills',
  '.pi/skills',
  '.pi/prompts',
] as const;
/** 个人配置只能落在这些子目录下。 */
const PERSONAL_PREFIXES = ['.claude/skills/', '.claude/agents/', '.claude/commands/'];

const START_STRING_FIELDS = [
  'effort', 'userPrompt', 'botProfilePrompt', 'botProfileContextPrompt', 'botUserProfilePrompt',
  'makerMemoryScopeKey', 'makerMemoryIndexSnapshot', 'permissionMode', 'displayReasoning', 'resumeSessionId',
] as const;
const START_BOOL_FIELDS = [
  'fastMode', 'thinkingEnabled', 'makerMemoryEnabled', 'planMode', 'codexHistoryHasProductPrompt',
] as const;

/** vendorOptions 里只有这些是可序列化、对另一台电脑有意义的。 */
const VENDOR_OPTION_KEYS = new Set(['source', 'resumeSessionAt', 'forkSession']);

export function encodeStartOptions(opts: StartSessionOptions): RemoteAgentWireStartOptions {
  const record = opts as unknown as Record<string, unknown>;
  const wire: RemoteAgentWireStartOptions = { model: opts.model };
  if (opts.providerId !== undefined) wire.providerId = opts.providerId;
  for (const key of START_STRING_FIELDS) {
    const value = record[key];
    if (typeof value === 'string') (wire as unknown as Record<string, unknown>)[key] = value;
  }
  for (const key of START_BOOL_FIELDS) {
    const value = record[key];
    if (typeof value === 'boolean') (wire as unknown as Record<string, unknown>)[key] = value;
  }
  if (opts.vendorOptions) {
    const vendor: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(opts.vendorOptions)) {
      if (VENDOR_OPTION_KEYS.has(key) && typeof value !== 'function') vendor[key] = jsonSafe(value);
    }
    if (Object.keys(vendor).length) wire.vendorOptions = vendor;
  }
  if (opts.onInvalidResumeSession) wire.invalidResumeCallback = true;
  return wire;
}

export function decodeStartOptions(value: unknown): RemoteAgentWireStartOptions {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model || value.model.length > 512) {
    throw new Error('REMOTE_AGENT_INVALID');
  }
  const wire: RemoteAgentWireStartOptions = { model: value.model };
  if (value.providerId === null || typeof value.providerId === 'string') wire.providerId = value.providerId as string | null;
  for (const key of START_STRING_FIELDS) {
    const item = optString(value[key]);
    if (item !== undefined) (wire as unknown as Record<string, unknown>)[key] = item;
  }
  for (const key of START_BOOL_FIELDS) {
    const item = optBool(value[key]);
    if (item !== undefined) (wire as unknown as Record<string, unknown>)[key] = item;
  }
  if (isRecord(value.vendorOptions)) {
    const vendor: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.vendorOptions)) {
      if (VENDOR_OPTION_KEYS.has(key)) vendor[key] = item;
    }
    if (Object.keys(vendor).length) wire.vendorOptions = vendor;
  }
  if (value.invalidResumeCallback === true) wire.invalidResumeCallback = true;
  return wire;
}

const PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd']);

function decodeWorkspace(value: unknown): RemoteAgentWireWorkspace {
  if (!isRecord(value)) throw new Error('REMOTE_AGENT_INVALID');
  const workingDir = optString(value.workingDir, 4096);
  const platform = optString(value.platform, 32);
  if (!workingDir || !platform || !PLATFORMS.has(platform)) throw new Error('REMOTE_AGENT_INVALID');
  return {
    workingDir,
    extraDirs: stringArray(value.extraDirs) ?? [],
    writableDirs: stringArray(value.writableDirs) ?? [],
    platform: platform as NodeJS.Platform,
    shell: optString(value.shell, 256) ?? 'bash',
    ...(optString(value.osVersion, 256) ? { osVersion: optString(value.osVersion, 256) } : {}),
    ...(optString(value.homeDir, 4096) ? { homeDir: optString(value.homeDir, 4096) } : {}),
    isGitRepo: value.isGitRepo === true,
  };
}

/** 影子目录里允许出现的相对路径：不能越出、不能是隐藏的 Cindy/git 内部文件。 */
export function isSafeProjectFilePath(relative: string): boolean {
  if (!relative || relative.length > 1024 || relative.includes('\0') || relative.includes('\\')) return false;
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false;
  const parts = relative.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') && parts[0] !== '.git';
}

export function decodeOpenPayload(value: unknown): RemoteAgentOpenPayload {
  if (!isRecord(value)) throw new Error('REMOTE_AGENT_INVALID');
  const sessionId = optString(value.sessionId, 128);
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('REMOTE_AGENT_INVALID');
  const files = Array.isArray(value.projectFiles) ? value.projectFiles : [];
  if (files.length > MAX_PROJECT_FILES) throw new Error('REMOTE_AGENT_INVALID');
  const projectFiles = files.flatMap((item): RemoteAgentWireFile[] => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.data !== 'string') return [];
    return isSafeProjectFilePath(item.path) ? [{ path: item.path, data: item.data }] : [];
  });
  const ancestors = Array.isArray(value.ancestorFiles) ? value.ancestorFiles : [];
  if (ancestors.length > MAX_ANCESTOR_LEVELS * ANCESTOR_INSTRUCTION_FILES.length) throw new Error('REMOTE_AGENT_INVALID');
  const ancestorFiles = ancestors.flatMap((item): RemoteAgentWireAncestorFile[] => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.data !== 'string') return [];
    if (typeof item.up !== 'number' || !Number.isInteger(item.up) || item.up < 1 || item.up > MAX_ANCESTOR_LEVELS) return [];
    return (ANCESTOR_INSTRUCTION_FILES as readonly string[]).includes(item.name)
      ? [{ up: item.up, name: item.name, data: item.data }]
      : [];
  });
  return {
    sessionId,
    ...(value.virtualWorkspace === true ? { virtualWorkspace: true } : {}),
    options: decodeStartOptions(value.options),
    workspace: decodeWorkspace(value.workspace),
    projectFiles,
    ancestorFiles,
    personal: decodePersonal(value.personal),
    mcpServers: (stringArray(value.mcpServers, 128) ?? []).filter((name) => /^[a-z0-9_-]{1,64}$/i.test(name)),
  };
}

function decodePersonal(value: unknown): RemoteAgentWirePersonal {
  if (!isRecord(value)) return { files: [] };
  const files = Array.isArray(value.files) ? value.files : [];
  if (files.length > MAX_PROJECT_FILES) throw new Error('REMOTE_AGENT_INVALID');
  const personal: RemoteAgentWirePersonal = {
    files: files.flatMap((item): RemoteAgentWireFile[] => {
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.data !== 'string') return [];
      const filePath = item.path;
      return isSafeProjectFilePath(filePath) && PERSONAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))
        ? [{ path: filePath, data: item.data }]
        : [];
    }),
  };
  const memory = optString(value.memory);
  if (memory) personal.memory = memory;
  const instructions = optString(value.instructions);
  if (instructions) personal.instructions = instructions;
  if (isRecord(value.permissions)) {
    const rules = (key: string) => (stringArray(value.permissions && (value.permissions as Record<string, unknown>)[key], 1024) ?? []).slice(0, 512);
    const permissions = { allow: rules('allow'), deny: rules('deny'), ask: rules('ask') };
    if (permissions.allow.length || permissions.deny.length || permissions.ask.length) personal.permissions = permissions;
  }
  return personal;
}

// ─── 用户消息 ────────────────────────────────────────────────────

export interface RemoteAgentWireAttachment {
  /** base64 字节。 */
  data: string;
  ext: string;
}

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: number; mimeType?: string; managedUrl?: string }
  | { type: 'file'; path: string; mimeType?: string }
  | { type: 'mention'; name: string; path: string; kind?: 'file' | 'dir' | 'agent' };

export interface RemoteAgentWireMessage {
  content: string | WireBlock[];
  attachments: RemoteAgentWireAttachment[];
}

function extensionOf(file: string, mimeType?: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(file);
  if (match) return match[1].toLowerCase();
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'bin';
}

/** 控制端：图片按本机路径读出字节随消息带走；文件与提及只是路径引用，Agent 用工具到本机读。 */
export async function encodeUserMessage(
  message: UserMessage,
  readImage: (path: string) => Promise<Buffer>,
): Promise<RemoteAgentWireMessage> {
  if (typeof message.content === 'string') return { content: message.content, attachments: [] };
  const attachments: RemoteAgentWireAttachment[] = [];
  const content: WireBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'image' && !/^https?:\/\//.test(block.path)) {
      const data = await readImage(block.path);
      if (data.length > REMOTE_AGENT_MAX_ATTACHMENT_BYTES) {
        throw new Error(`Image ${block.path} is too large to send to the other computer.`);
      }
      attachments.push({ data: data.toString('base64'), ext: extensionOf(block.path, block.mimeType) });
      content.push(prune({
        type: 'image' as const,
        attachment: attachments.length - 1,
        mimeType: block.mimeType,
        managedUrl: block.managedUrl,
      }));
    } else if (block.type === 'image') {
      content.push({ type: 'file', path: block.path, mimeType: block.mimeType });
    } else {
      content.push(jsonSafe(block) as WireBlock);
    }
  }
  return { content, attachments };
}

/** 被控端：把附件写到本次任务的附件目录，换成本机路径。 */
export async function decodeUserMessage(
  value: unknown,
  writeAttachment: (data: Buffer, ext: string) => Promise<string>,
): Promise<UserMessage> {
  if (!isRecord(value)) throw new Error('REMOTE_AGENT_INVALID');
  if (typeof value.content === 'string') return { type: 'user', content: value.content };
  if (!Array.isArray(value.content) || value.content.length > 512) throw new Error('REMOTE_AGENT_INVALID');
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  const written = new Map<number, string>();
  const blocks: UserContentBlock[] = [];
  for (const raw of value.content) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case 'text':
        if (typeof raw.text === 'string') blocks.push({ type: 'text', text: raw.text });
        break;
      case 'image': {
        const index = optNumber(raw.attachment);
        const attachment = index !== undefined ? attachments[index] : undefined;
        if (!isRecord(attachment) || typeof attachment.data !== 'string') break;
        let file = written.get(index!);
        if (!file) {
          const ext = typeof attachment.ext === 'string' && /^[a-z0-9]{1,8}$/.test(attachment.ext) ? attachment.ext : 'bin';
          const data = Buffer.from(attachment.data, 'base64');
          if (data.length > REMOTE_AGENT_MAX_ATTACHMENT_BYTES) throw new Error('REMOTE_AGENT_INVALID');
          file = await writeAttachment(data, ext);
          written.set(index!, file);
        }
        blocks.push(prune({
          type: 'image' as const,
          path: file,
          mimeType: optString(raw.mimeType, 128),
          managedUrl: optString(raw.managedUrl, 2048),
        }));
        break;
      }
      case 'file':
        if (typeof raw.path === 'string') blocks.push(prune({ type: 'file' as const, path: raw.path, mimeType: optString(raw.mimeType, 128) }));
        break;
      case 'mention':
        if (typeof raw.path === 'string' && typeof raw.name === 'string') {
          const kind = raw.kind === 'file' || raw.kind === 'dir' || raw.kind === 'agent' ? raw.kind : undefined;
          blocks.push(prune({ type: 'mention' as const, name: raw.name, path: raw.path, kind }));
        }
        break;
      default:
        break;
    }
  }
  return { type: 'user', content: blocks };
}

// ─── 发送选项 ────────────────────────────────────────────────────

type WireForceConfirm = 'all' | 'channel' | 'channel-mutating';

interface WireTurnPolicy {
  forceConfirm: WireForceConfirm;
  origin: TurnPermissionOrigin;
  confirmationSurface: 'desktop' | 'channel';
  confirmationTimeoutMs?: number;
  autoReviewContext?: unknown;
  stateCallback?: boolean;
}

export interface RemoteAgentWireSendOptions {
  logTitle?: string;
  messageUuid?: string;
  retryTranscriptUserEntryId?: string;
  userName?: string;
  planMode?: boolean;
  throwOnStartFailure?: boolean;
  origin?: unknown;
  turnAttemptToken?: number;
  toolsDisabled?: boolean;
  transcriptCallback?: boolean;
  turnPolicy?: WireTurnPolicy;
  cindy?: {
    /** autoReviewReferences is optional and additive; older peers drop it and review without it. */
    mainOwned?: { origin: TurnPermissionOrigin; rawChannelText?: string; autoReviewReferences?: unknown };
    autoReviewSourceContent?: RemoteAgentWireMessage;
    autoReviewUserIntent?: unknown;
    delegatedContinuation?: true;
    inheritedCapabilitySelection?: string;
  };
}

export interface EncodedSendOptions {
  wire: RemoteAgentWireSendOptions;
  /** 回调留在控制端，被控端经反向请求触发。 */
  onTranscriptUserEntry?: (entryId: string) => void | Promise<void>;
  onInteractionStateChange?: (state: 'waiting' | 'resolved' | 'cancelled') => void;
}

function forceConfirmKind(policy: TurnPermissionPolicy): WireForceConfirm {
  if (policy.forceConfirmToolCall === channelForceConfirmToolCall) return 'channel';
  if (policy.forceConfirmToolCall === channelForceConfirmMutatingToolCall) return 'channel-mutating';
  return 'all';
}

export async function encodeSendOptions(
  opts: SendOptions | undefined,
  readImage: (path: string) => Promise<Buffer>,
): Promise<EncodedSendOptions> {
  if (!opts) return { wire: {} };
  const wire: RemoteAgentWireSendOptions = prune({
    logTitle: opts.logTitle,
    messageUuid: opts.messageUuid,
    retryTranscriptUserEntryId: opts.retryTranscriptUserEntryId,
    userName: opts.userName,
    planMode: opts.planMode,
    throwOnStartFailure: opts.throwOnStartFailure,
    origin: jsonSafe(opts.origin),
    turnAttemptToken: opts.turnAttemptToken,
    toolsDisabled: opts.toolsDisabled,
    transcriptCallback: opts.onTranscriptUserEntry ? true : undefined,
  });
  const policy = opts.turnPermissionPolicy;
  if (policy) {
    wire.turnPolicy = prune({
      forceConfirm: forceConfirmKind(policy),
      origin: jsonSafe(policy.origin) as TurnPermissionOrigin,
      confirmationSurface: policy.confirmationSurface,
      confirmationTimeoutMs: policy.confirmationTimeoutMs,
      autoReviewContext: jsonSafe(policy.autoReviewContext),
      stateCallback: policy.onInteractionStateChange ? true : undefined,
    });
  }
  const cindy: NonNullable<RemoteAgentWireSendOptions['cindy']> = {};
  const mainOwned = opts[MAIN_OWNED_SEND_CONTEXT];
  if (mainOwned) cindy.mainOwned = jsonSafe(mainOwned) as NonNullable<typeof cindy.mainOwned>;
  const sourceContent = opts[AUTO_REVIEW_SOURCE_CONTENT];
  if (sourceContent !== undefined) {
    cindy.autoReviewSourceContent = await encodeUserMessage({ type: 'user', content: sourceContent }, readImage);
  }
  if (opts[AUTO_REVIEW_USER_INTENT] !== undefined) cindy.autoReviewUserIntent = jsonSafe(opts[AUTO_REVIEW_USER_INTENT]);
  if (opts[AUTO_REVIEW_DELEGATED_CONTINUATION]) cindy.delegatedContinuation = true;
  if (typeof opts[INHERITED_CAPABILITY_SELECTION] === 'string') cindy.inheritedCapabilitySelection = opts[INHERITED_CAPABILITY_SELECTION];
  if (Object.keys(cindy).length) wire.cindy = cindy;
  return {
    wire,
    ...(opts.onTranscriptUserEntry ? { onTranscriptUserEntry: opts.onTranscriptUserEntry } : {}),
    ...(policy?.onInteractionStateChange ? { onInteractionStateChange: policy.onInteractionStateChange } : {}),
  };
}

function decodeOrigin(value: unknown): TurnPermissionOrigin | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  switch (value.kind) {
    case 'desktop':
    case 'scheduler':
      return { kind: value.kind };
    case 'hook':
      return typeof value.source === 'string' ? { kind: 'hook', source: value.source } : undefined;
    case 'im': {
      const channels = ['feishu', 'discord', 'slack', 'wechat', 'telegram', 'dingtalk', 'wecom'] as const;
      const channel = channels.find((item) => item === value.channel);
      return channel ? prune({ kind: 'im' as const, channel, taskId: optString(value.taskId, 256) }) : undefined;
    }
    default:
      return undefined;
  }
}

export interface DecodeSendCallbacks {
  onTranscriptUserEntry(entryId: string): Promise<void>;
  onInteractionStateChange(state: 'waiting' | 'resolved' | 'cancelled'): void;
  writeAttachment(data: Buffer, ext: string): Promise<string>;
}

export async function decodeSendOptions(value: unknown, callbacks: DecodeSendCallbacks): Promise<SendOptions> {
  if (!isRecord(value)) return {};
  const opts: Record<PropertyKey, unknown> = prune({
    logTitle: optString(value.logTitle, 1024),
    messageUuid: optString(value.messageUuid, 128),
    retryTranscriptUserEntryId: optString(value.retryTranscriptUserEntryId, 256),
    userName: optString(value.userName, 256),
    planMode: optBool(value.planMode),
    throwOnStartFailure: optBool(value.throwOnStartFailure),
    origin: isRecord(value.origin) && ['user', 'scheduler', 'goal'].includes(value.origin.kind as string) ? value.origin : undefined,
    turnAttemptToken: optNumber(value.turnAttemptToken),
    toolsDisabled: optBool(value.toolsDisabled),
  });
  if (value.transcriptCallback === true) opts.onTranscriptUserEntry = callbacks.onTranscriptUserEntry;
  if (isRecord(value.turnPolicy)) {
    const policy = value.turnPolicy;
    const origin = decodeOrigin(policy.origin);
    const surface = policy.confirmationSurface === 'channel' ? 'channel' : 'desktop';
    const force = policy.forceConfirm === 'channel'
      ? channelForceConfirmToolCall
      : policy.forceConfirm === 'channel-mutating'
        ? channelForceConfirmMutatingToolCall
        : () => true;
    if (origin) {
      opts.turnPermissionPolicy = prune({
        origin,
        confirmationSurface: surface,
        confirmationTimeoutMs: optNumber(policy.confirmationTimeoutMs),
        autoReviewContext: isRecord(policy.autoReviewContext) ? policy.autoReviewContext : undefined,
        onInteractionStateChange: policy.stateCallback === true ? callbacks.onInteractionStateChange : undefined,
        forceConfirmToolCall: force,
      }) as unknown as TurnPermissionPolicy;
    }
  }
  if (isRecord(value.cindy)) {
    const cindy = value.cindy;
    if (isRecord(cindy.mainOwned)) {
      const origin = decodeOrigin(cindy.mainOwned.origin);
      if (origin) {
        opts[MAIN_OWNED_SEND_CONTEXT] = prune({
          origin,
          rawChannelText: optString(cindy.mainOwned.rawChannelText),
          // Re-projected here: shape and bounds are never taken from the wire as-is.
          autoReviewReferences: projectAutoReviewUserReferences(cindy.mainOwned.autoReviewReferences),
        });
      }
    }
    if (isRecord(cindy.autoReviewSourceContent)) {
      const message = await decodeUserMessage(cindy.autoReviewSourceContent, callbacks.writeAttachment);
      opts[AUTO_REVIEW_SOURCE_CONTENT] = message.content;
    }
    const intent = cindy.autoReviewUserIntent;
    if (typeof intent === 'string' || (isRecord(intent) && typeof intent.currentUserMessage === 'string'
      && Array.isArray(intent.earlierUserMessages) && intent.earlierUserMessages.every((item) => typeof item === 'string'))) {
      opts[AUTO_REVIEW_USER_INTENT] = intent;
    }
    if (cindy.delegatedContinuation === true) opts[AUTO_REVIEW_DELEGATED_CONTINUATION] = true;
    const inherited = optString(cindy.inheritedCapabilitySelection);
    if (inherited !== undefined) opts[INHERITED_CAPABILITY_SELECTION] = inherited;
  }
  return opts as SendOptions;
}
