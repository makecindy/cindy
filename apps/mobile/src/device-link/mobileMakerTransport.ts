import type {
  InputProjection,
  PendingInteraction,
  QueuedRemoteMessage,
  RemoteMessage,
  RemoteSession,
} from '@/session/types';
import type {
  MobileSessionReference,
  MobileSessionReferenceContext,
} from '@/session/sessionReferences';
import {
  DEVICE_LINK_MEDIA_FETCH_CHANNEL,
  DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL,
  DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL,
  DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL,
  MOBILE_REMOTE_INVOKE_CHANNELS,
} from '@cindy/maker-shared/device-link-contract';
import { CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2 } from '@cindy/device-link';
import type {
  MobileGoalLimitsInput,
  MobileGoalStatusPayload,
  MobileCodexRateLimitResetResult,
  MobileCodexRateLimitsResult,
  MobileSessionAgentSwitchIntent,
  MobileSessionAgentSwitchResult,
  MobileVoiceDictionaryLearningRequest,
  MobileVoiceDictionarySnapshotResult,
  MobileVoiceDictionaryLearningResult,
} from '@cindy/maker-shared/device-link-contract';
import type { ProviderView } from '@cindy/model-providers/registry';
import type { RewindPreviewPayload } from '@/session/rewindPreview';
import type { MobileRemoteMediaFetchResult } from '@/session/remoteMedia';
import type {
  RemoteSchedule,
  RemoteScheduleCreateFromTemplateInput,
  RemoteScheduleRun,
  RemoteScheduleTemplate,
  RemoteScheduleWriteInput,
  ScheduleListFilter,
} from '@/scheduler/types';

export type RemoteInvoke = <T = unknown>(
  deviceId: string,
  channel: string,
  args?: unknown[],
) => Promise<T>;

export interface MobileMakerTransportDeps {
  deviceId: string;
  invoke: RemoteInvoke;
}

export interface SendOptions {
  messageUuid?: string;
  userName?: string;
  throwOnStartFailure?: boolean;
}

export interface CreateSessionOptions {
  agentKind: 'claude-code' | 'codex';
  /**
   * 控制端预生成的 sessionId(新建会话乐观管线用):被控端 readCreateSessionOpts
   * 自手机远控首版(2026-06-21)起透传 body.id,maker-core createSession 对
   * provided id 幂等(active 复用 / storage 命中跳过 insert)——乐观会话行、路由、
   * 订阅从一开始就用最终 id,无需 rekey。省略 = 被控端生成。
   */
  id?: string;
  workingDir?: string;
  model: string;
  effort?: string;
  permissionMode?: string;
  fastMode?: boolean;
  workspaceKind?: 'project' | 'dialogue';
  extraDirs?: string[];
  /**
   * 显式选中的供应商(来源)id。仅当用户在模型下拉里选了非默认来源时带上;
   * 被控端据此把 sessions.provider_id 落库,使新会话首个请求即按该来源路由。
   * 省略 = NULL = 跟随被控端默认路由(对齐桌面 deviceLinkCreateArgs)。
   */
  providerId?: string;
  [key: string]: unknown;
}

export interface CreateSessionResult {
  sessionId: string;
  agentKind?: string;
  workDir?: string;
  capabilities?: unknown;
  usedProjectContext?: boolean;
}

export type MobileAgentKind = 'claude-code' | 'codex';

export type MobileSlashCommand =
  | { kind: 'agent-builtin'; name: string; description: string }
  | {
      kind: 'agent-skill';
      name: string;
      description?: string;
      source: 'user' | 'skill';
      path?: string;
      scope?: string;
      enabled?: boolean;
    }
  // desktop 自有命令(被控端 main 的 DesktopCommandRegistry,如 /learn):
  // 由控制端按名字分流执行,不转发给 agent。
  | { kind: 'desktop'; name: string; description: string };

export interface MobileAgentCommandListResult {
  success: boolean;
  error?: string;
  commands?: MobileSlashCommand[];
}

export interface MobileDesktopCommandListResult {
  success: boolean;
  error?: string;
  commands?: MobileSlashCommand[];
}

/** learn:start 请求(形状对齐被控端 learn-host 的 LearnStartRequest 校验)。 */
export interface MobileLearnStartRequest {
  input: string;
  sourceKind: 'freetext' | 'session' | 'hub';
  hubSlug?: string;
  originSessionId?: string;
}

export interface MobileAgentSkillListResult {
  success: boolean;
  error?: string;
  skills?: MobileSlashCommand[];
}

export interface MobileAtResourceItem {
  type: 'file' | 'dir' | 'agent';
  name: string;
  relPath: string;
  description?: string;
}

export interface MobileAtResourceScanResult {
  success: boolean;
  error?: string;
  items?: MobileAtResourceItem[];
  truncated?: boolean;
}

export interface MessageListOptions {
  limit?: number;
  before?: string;
  beforeTs?: number;
}

export interface MessageAroundOptions {
  radius?: number;
}

export interface RemoteDirectoryEntry {
  name: string;
  kind: 'dir' | 'symlink' | 'file';
  path: string;
}

export interface RemoteDirectoryListResult {
  resolvedPath: string;
  entries: RemoteDirectoryEntry[];
  parent: string | null;
}

export interface RemotePathStatResult {
  kind: 'dir' | 'file' | 'missing';
  resolvedPath: string;
}

export interface RemoteTextFilePreviewResult {
  success: boolean;
  error?: string;
  reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';
  data?: string;
  size: number;
  limitMb?: number;
}

/* ---- file-browser:remote-op(完整文件浏览通道)响应形状 ----
 * 与被控端 apps/desktop/src/main/file-browser/device-op.ts 逐字段一致;
 * listDir 返回裸 entries 数组,归一化交给 maker-shared 的
 * normalizeRemoteOpDirEntries(跨版本被控端防御)。 */

export interface FileBrowserCapsResult {
  ok: boolean;
  gzip?: boolean;
  /** 老被控端对未知 op 返回 {ok:false,message:'unknown op: caps'}。 */
  message?: string;
}

export interface FileBrowserReadFileData {
  relPath: string;
  /** contentEncoding 为 'gzip' 时是 gzip+base64,需用 pako 解压。 */
  content: string;
  size: number;
  mtimeMs: number;
  truncated?: boolean;
  contentEncoding?: 'gzip';
}

export type FileBrowserReadFileResult =
  | { ok: true; data: FileBrowserReadFileData }
  | {
      ok: false;
      code?: 'OVERSIZE' | 'BINARY_FILE' | 'READ_FAILED';
      message?: string;
      stat?: { relPath: string; type: 'file'; size: number; mtimeMs: number };
    };

export type FileBrowserThumbnailResult =
  | { ok: true; dataBase64: string; mimeType: 'image/webp'; width: number; height: number; size: number; mtimeMs: number }
  | { ok: false; code?: 'THUMB_UNSUPPORTED' | 'THUMB_TOO_LARGE' | 'THUMB_FAILED'; message?: string };

export interface FileBrowserListAllFilesResult {
  files: string[];
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

export type FileBrowserExportStartResult =
  | { ok: true; transferId: string; size: number; mtimeMs: number }
  | { ok: false; message?: string };

export type FileBrowserExportStatusResult =
  | { ok: true; state: 'uploading' | 'done' | 'error'; key?: string; message?: string; size: number; uploaded: number }
  | { ok: false; message?: string };

export interface FileBrowserSearchMatch {
  relPath: string;
  lineNumber: number;
  lineText: string;
}

export interface FileBrowserSearchCollectResult {
  matches: FileBrowserSearchMatch[];
  truncated: boolean;
  totalMatches: number;
  totalFiles: number;
}

export interface MobileVoiceTranscribeRequest {
  ossKey: string;
  mimeType?: string;
  fileName?: string;
  sourceLanguage?: string;
}

export interface MobileVoiceTranscribeResult {
  text: string;
  provider?: string;
  model?: string;
  audioBytes?: number;
}

export interface MobileActiveSessionSnapshot {
  sessionId: string;
  agentKind?: string;
  workDir?: string;
  capabilities?: unknown;
  isTurnRunning?: boolean;
}

/** 被控端视角的模型单价(USD / 百万 token,同桌面 useModelPricing 形状)。 */
export interface MobileModelPrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

export type MobileModelPricingMap = Record<string, MobileModelPrice>;

/**
 * 会话「非选中模型」effort/fast 写穿入参(隧道 maker:set-session-model-pref,形状对齐被控端
 * register.ts 的 SET_SESSION_MODEL_PREF 校验)。被控端 renderer 写真实会话记忆后经
 * maker:session-model-pref:changed push 回流刷新手机镜像。
 */
export interface MobileSessionModelPref {
  sessionId: string;
  agent: MobileAgentKind;
  providerId: string;
  model: string;
  effort?: string;
  fast?: boolean;
}

/**
 * 草稿「模型 effort/fast」写穿入参(隧道 maker:apply-new-maker-draft-pref,形状对齐被控端
 * APPLY_NEW_MAKER_DRAFT_PREF 校验)。手机只做非选中行双写(active 恒 false),被控端草稿
 * 默认随之更新,使「下次在被控端 / 桌面控制端选中该模型」拿到同一份 effort/fast。
 */
export interface MobileNewMakerDraftPref {
  agent: MobileAgentKind;
  providerId: string;
  modelId: string;
  active: false;
  effort?: string;
  fast?: boolean;
}

export interface MobileMakerTransport {
  createSession(opts: CreateSessionOptions): Promise<CreateSessionResult>;
  getCapabilities(agentKind: MobileAgentKind): Promise<unknown>;
  /**
   * 列被控端的供应商(来源)结构,用于 provider-aware 模型下拉(隧道 maker:provider:list)。
   * modelVisibilityOverrides = 被控端「模型显示/隐藏」override 快照(旧被控端不回传)。
   */
  listProviders(): Promise<{
    providers: ProviderView[];
    modelVisibilityOverrides?: Record<string, boolean>;
  }>;
  getSession(sessionId: string): Promise<RemoteSession>;
  patchSessionMeta(sessionId: string, patch: SessionMetaPatch): Promise<RemoteSession>;
  /**
   * error-tail「忽略」:被控端把该 role='error' 行的 content merge dismissed:true
   * 持久化(不丢原字段),重连/历史重拉后 banner 不复活。老被控端无此 channel →
   * CHANNEL_NOT_ALLOWED,调用方吞掉降级为本视图内存隐藏。
   */
  dismissErrorMessage(sessionId: string, clientId: string): Promise<void>;
  /**
   * interrupted「忽略」:被控端写 ended 时间戳,双时间戳判定跨重启不再命中。
   * 老被控端无此 channel → 调用方吞掉降级(本视图内存 acked)。
   */
  ackInterruptedTurn(sessionId: string): Promise<void>;
  /**
   * 自动起名:被控端读该会话最新对话素材重新生成标题(与桌面重命名 Magic 按钮同一
   * handler)。只生成不落库,持久化仍走 patchSessionMeta;失败/无素材时 title 为 null。
   */
  regenerateSessionTitle(sessionId: string): Promise<{ title: string | null }>;
  listMessages(sessionId: string, opts?: MessageListOptions): Promise<RemoteMessage[]>;
  aroundMessages(sessionId: string, messageId: string, opts?: MessageAroundOptions): Promise<RemoteMessage[]>;
  aroundMessagesByClientId(sessionId: string, clientId: string, opts?: MessageAroundOptions): Promise<RemoteMessage[]>;
  send(
    sessionId: string,
    message: string | { type: 'user'; content: unknown },
    createOpts?: CreateSessionOptions,
    sendOpts?: SendOptions,
  ): Promise<{ accepted: true } | { accepted: false; reason?: string }>;
  listActiveSessions(): Promise<MobileActiveSessionSnapshot[]>;
  /**
   * 切模型。可选第 3 参 providerId = 同时切来源(被控端按其路由 + 持久化 provider_id)。
   * 不传 providerId = 老 2 参语义,不动会话当前来源选择。
   */
  setModel(sessionId: string, model: string, providerId?: string): Promise<void>;
  /** 登记跨 Agent 切换意图；真正切换在下一条消息发送时由 desktop main 执行。 */
  switchSessionAgent(
    sessionId: string,
    targetAgentKind: MobileAgentKind,
    model: string,
    providerId: string | null,
    effort?: string,
    fastMode?: boolean,
  ): Promise<MobileSessionAgentSwitchResult>;
  /** 读取 desktop main 的权威 pending intent，用于重连 / 重进页面恢复。 */
  getSessionAgentSwitchIntent(sessionId: string): Promise<MobileSessionAgentSwitchIntent | null>;
  setEffort(sessionId: string, effort: string): Promise<void>;
  setPermissionMode(sessionId: string, mode: string): Promise<void>;
  /** 计划模式一级开关(#494 新协议,capabilities.planMode.supported 时可用);
   *  被控端武装 live 会话并持久化 planModeEnabled,一次性消耗后经 sessions:patched 回流。 */
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
  setFastMode(sessionId: string, enabled: boolean): Promise<void>;
  setExtraDirs(sessionId: string, dirs: string[]): Promise<void>;
  /** 被控端视角的模型单价表(只读;老被控端 CHANNEL_NOT_ALLOWED → 调用方隐藏价格)。 */
  getModelPricing(): Promise<MobileModelPricingMap | null>;
  /**
   * 被控端账号级限额/用量快照(只读):codex → RateLimitSnapshot(窗口构成以上游
   * 接口返回为准,shape 见 maker-shared summarizeAccountRateLimits),claude-code →
   * 网关配额。老被控端 CHANNEL_NOT_ALLOWED → 调用方隐藏限额区块。
   */
  getAccountUsage(agentKind: MobileAgentKind): Promise<unknown>;
  /** Codex app-server authoritative windows plus banked reset credits and a bound reset offer. */
  getCodexRateLimits(): Promise<MobileCodexRateLimitsResult>;
  /** Consume the desktop-issued offer; retries must pass the same idempotency key. */
  resetCodexRateLimits(idempotencyKey: string): Promise<MobileCodexRateLimitResetResult>;
  /** 网关 API key presence-only 探测(只回 boolean;老被控端 → 调用方按 unknown 处理)。 */
  getApiKeyPresent(): Promise<{ present: boolean }>;
  /** 会话「非选中模型」effort/fast 写穿(老被控端 → 调用方吞掉降级)。 */
  setSessionModelPref(pref: MobileSessionModelPref): Promise<void>;
  /** 草稿「模型 effort/fast」写穿(active 恒 false;老被控端 → 调用方吞掉降级)。 */
  applyNewMakerDraftPref(pref: MobileNewMakerDraftPref): Promise<void>;
  listAgentCommands(agentKind: MobileAgentKind): Promise<MobileAgentCommandListResult>;
  /** 被控端 desktop 自有 slash 命令清单(palette 展示;移动端只放行可执行子集)。 */
  listDesktopCommands(): Promise<MobileDesktopCommandListResult>;
  /**
   * 触发被控端 learn-host 蒸馏(/learn):全流程(证据收集/staging/技能落盘)都在
   * 被控端执行,这里只拿 runId;评审 UI 暂只有桌面端,移动端以系统卡提示去桌面评审。
   */
  learnStart(req: MobileLearnStartRequest): Promise<{ runId: string }>;
  listAgentSkills(agentKind: MobileAgentKind, opts: { workingDir?: string; forceReload?: boolean }): Promise<MobileAgentSkillListResult>;
  scanAtResources(agentKind: MobileAgentKind, opts: { workingDir: string; cap?: number; query?: string }): Promise<MobileAtResourceScanResult>;
  fetchRemoteMedia(url: string, opts?: { skipCache?: boolean; thumbnail?: boolean }): Promise<MobileRemoteMediaFetchResult>;
  transcribeVoice(input: MobileVoiceTranscribeRequest): Promise<MobileVoiceTranscribeResult>;
  recordVoiceDictionaryLearning(input: MobileVoiceDictionaryLearningRequest): Promise<MobileVoiceDictionaryLearningResult>;
  /**
   * 拉取被控桌面的语音词典只读快照。老被控端不识别该 channel 会回
   * CHANNEL_NOT_ALLOWED,调用方据此静默回退到「无词典」,不打断语音输入。
   */
  getVoiceDictionary(): Promise<MobileVoiceDictionarySnapshotResult>;
  getPendingInteractions(sessionId: string): Promise<PendingInteraction[]>;
  resolveInteraction(requestId: string, decision: Record<string, unknown>): Promise<void>;
  getContextUsage(sessionId: string, createOpts?: Record<string, unknown>): Promise<unknown>;
  fork(sourceSessionId: string, messageClientId: string): Promise<RemoteSession>;
  rewindPreview(sessionId: string, clientId: string): Promise<RewindPreviewPayload>;
  rewindCommit(sessionId: string, clientId: string): Promise<RemoteSession>;
  deleteMessage(
    sessionId: string,
    clientId: string,
  ): Promise<{ sessionId: string; clientId: string; clientIds?: string[] }>;
  closeSession(sessionId: string): Promise<void>;
  /**
   * 会话未读已读回执:手机端真实展示会话内容后,清掉被控端该会话的未读态
   * (灵动岛 / Dock 角标 / 桌面侧栏红绿点)。被控端清完会经 sessions relay 推回
   * attention=false,手机端列表绿/红点随之收敛。intent 语义与桌面一致:
   * 'explicit' = 内容真实展示(可清 error 未读);'passive' = 导航类被动信号。
   * 老被控端无此 channel → CHANNEL_NOT_ALLOWED,调用方吞掉降级。
   */
  clearSessionAttention(sessionId: string, intent: 'explicit' | 'passive'): Promise<void>;
  /** 目标模式:goal 状态机在被控端 GoalController 执行,这里只是隧道封装(路 A)。 */
  goal: {
    set(input: { sessionId: string; objective: string; limits?: MobileGoalLimitsInput }): Promise<void>;
    clear(sessionId: string): Promise<void>;
    getStatus(sessionId: string): Promise<MobileGoalStatusPayload | null>;
    pause(sessionId: string): Promise<void>;
    resume(sessionId: string): Promise<void>;
    update(
      sessionId: string,
      patch: Partial<{ objective: string } & MobileGoalLimitsInput>,
    ): Promise<void>;
  };
  schedule: {
    list(filter?: ScheduleListFilter): Promise<RemoteSchedule[]>;
    get(id: string): Promise<RemoteSchedule>;
    listTemplates(): Promise<RemoteScheduleTemplate[]>;
    createFromTemplate(input: RemoteScheduleCreateFromTemplateInput): Promise<RemoteSchedule>;
    create(input: RemoteScheduleWriteInput): Promise<RemoteSchedule>;
    update(id: string, patch: Partial<RemoteScheduleWriteInput>): Promise<RemoteSchedule>;
    listRuns(id: string, limit?: number): Promise<RemoteScheduleRun[]>;
    runNow(id: string): Promise<void>;
    pause(id: string): Promise<RemoteSchedule>;
    resume(id: string): Promise<RemoteSchedule>;
    delete(id: string): Promise<void>;
    getInflightCount(id: string): Promise<number>;
    markRunRead(runId: string): Promise<void>;
    markScheduleRunsRead(scheduleId: string): Promise<void>;
    deleteRun(runId: string): Promise<void>;
  };
  projectAutomation: {
    removeSchedule(input: { workingDir: string; id: string }): Promise<unknown>;
  };
  input: {
    getProjection(sessionId: string): Promise<InputProjection>;
    enqueue(sessionId: string, item: QueuedRemoteMessage, opts?: { sendAtMs?: number }): Promise<InputProjection>;
    compact(sessionId: string): Promise<InputProjection>;
    steer(
      sessionId: string,
      item: QueuedRemoteMessage,
      opts?: { removeFromQueue?: boolean; touchUserSend?: boolean },
    ): Promise<boolean>;
    stop(sessionId: string, opts?: { keepQueue?: boolean; pauseQueue?: boolean }): Promise<InputProjection>;
    resume(sessionId: string): Promise<InputProjection>;
    retryLastError(sessionId: string): Promise<InputProjection>;
    clearError(sessionId: string): Promise<InputProjection>;
    remove(sessionId: string, clientId: string): Promise<InputProjection>;
    updateText(
      sessionId: string,
      clientId: string,
      newText: string,
      sessionRefs?: MobileSessionReference[],
      trustedContexts?: MobileSessionReferenceContext[],
    ): Promise<InputProjection>;
    /** 整条内容替换(文本+附件),排队消息复用 composer 编辑的保存入口;老桌面端无此通道会抛 CHANNEL_NOT_ALLOWED。 */
    updateContent(sessionId: string, clientId: string, item: QueuedRemoteMessage): Promise<InputProjection>;
    move(sessionId: string, clientId: string, targetIndex: number): Promise<InputProjection>;
    setExpanded(sessionId: string, expanded: boolean): Promise<InputProjection>;
    setInteractionLock(sessionId: string, lockId: string, locked: boolean): Promise<InputProjection>;
    setEditLock(sessionId: string, clientId: string, locked: boolean): Promise<InputProjection>;
    clearSession(sessionId: string): Promise<InputProjection>;
  };
  fs: {
    listDir(path: string): Promise<RemoteDirectoryListResult>;
    statPath(path: string): Promise<RemotePathStatResult>;
    mkdirP(path: string): Promise<{ resolvedPath: string }>;
    readTextFilePreview(path: string): Promise<RemoteTextFilePreviewResult>;
  };
  /** 完整文件浏览(workdir 相对路径语义,被控端 file-browser:remote-op 聚合通道)。 */
  fileBrowser: {
    caps(workdir: string): Promise<FileBrowserCapsResult>;
    /** 返回裸 entries(unknown),消费方用 normalizeRemoteOpDirEntries 归一化。 */
    listDir(workdir: string, relPath: string): Promise<unknown>;
    readFile(workdir: string, relPath: string, opts?: { acceptGzip?: boolean }): Promise<FileBrowserReadFileResult>;
    listAllFiles(workdir: string, cap?: number): Promise<FileBrowserListAllFilesResult>;
    /** ripgrep 内容搜索(被控端 searchCollect,一次性收集,上限被控端封顶 500)。 */
    searchCollect(
      workdir: string,
      query: string,
      opts?: { caseSensitive?: boolean; maxMatches?: number },
    ): Promise<FileBrowserSearchCollectResult>;
    thumbnail(workdir: string, relPath: string): Promise<FileBrowserThumbnailResult>;
    exportFileStart(workdir: string, relPath: string): Promise<FileBrowserExportStartResult>;
    exportFileStatus(workdir: string, transferId: string): Promise<FileBrowserExportStatusResult>;
  };
}

export type SessionMetaPatch = Partial<Pick<RemoteSession, 'status' | 'title' | 'pinnedAt'>>;

export const MOBILE_MAKER_CHANNELS = MOBILE_REMOTE_INVOKE_CHANNELS;

export function createMobileMakerTransport({
  deviceId,
  invoke,
}: MobileMakerTransportDeps): MobileMakerTransport {
  const call = <T,>(channel: string, args: unknown[] = []): Promise<T> => {
    if (!deviceId) return Promise.reject(new Error('remote device id is required'));
    return invoke<T>(deviceId, channel, args);
  };

  return {
    createSession: (opts) => call('maker:create-session', [opts]),
    getCapabilities: (agentKind) => call('maker:get-capabilities', [agentKind]),
    listProviders: () => call('maker:provider:list', [{
      capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2],
    }]),
    getSession: (sessionId) => call('local-db:sessions:get', [sessionId]),
    patchSessionMeta: (sessionId, patch) => call('local-db:sessions:patch-meta', [sessionId, patch]),
    dismissErrorMessage: (sessionId, clientId) =>
      call('local-db:messages:dismiss-error', [sessionId, clientId]),
    ackInterruptedTurn: (sessionId) => call('local-db:sessions:ack-interrupted', [sessionId]),
    regenerateSessionTitle: (sessionId) => call('maker:regenerate-title', [{ sessionId }]),
    listMessages: (sessionId, opts) => call('local-db:messages:list', [sessionId, opts]),
    aroundMessages: (sessionId, messageId, opts) =>
      call('local-db:messages:around', [sessionId, messageId, opts]),
    aroundMessagesByClientId: (sessionId, clientId, opts) =>
      call('local-db:messages:around-client-id', [sessionId, clientId, opts]),
    send: (sessionId, message, createOpts, sendOpts) =>
      call('maker:send', [sessionId, message, createOpts, sendOpts]),
    listActiveSessions: () => call('maker:list-active'),
    setModel: (sessionId, model, providerId) =>
      call('maker:set-model', providerId ? [sessionId, model, providerId] : [sessionId, model]),
    switchSessionAgent: (
      sessionId,
      targetAgentKind,
      model,
      providerId,
      effort,
      fastMode,
    ) => call('maker:switch-session-agent', [
      sessionId,
      targetAgentKind,
      model,
      providerId,
      effort,
      fastMode,
    ]),
    getSessionAgentSwitchIntent: (sessionId) =>
      call('maker:get-session-agent-switch-intent', [sessionId]),
    setEffort: (sessionId, effort) => call('maker:set-effort', [sessionId, effort]),
    setPermissionMode: (sessionId, mode) => call('maker:set-permission-mode', [sessionId, mode]),
    setPlanMode: (sessionId, enabled) => call('maker:set-plan-mode', [sessionId, enabled]),
    setFastMode: (sessionId, enabled) => call('maker:set-fast-mode', [sessionId, enabled]),
    setExtraDirs: (sessionId, dirs) => call('maker:set-extra-dirs', [sessionId, dirs]),
    getModelPricing: () => call('maker:usage:model-pricing'),
    getAccountUsage: (agentKind) => call('maker:usage:account', [agentKind]),
    getCodexRateLimits: () => call('maker:usage:codex-rate-limits'),
    resetCodexRateLimits: (idempotencyKey) => (
      call('maker:usage:codex-rate-limit-reset', [idempotencyKey])
    ),
    getApiKeyPresent: () => call('maker:api-key:present'),
    setSessionModelPref: (pref) => call('maker:set-session-model-pref', [pref]),
    applyNewMakerDraftPref: (pref) => call('maker:apply-new-maker-draft-pref', [pref]),
    listAgentCommands: (agentKind) => call('maker:list-agent-commands', [agentKind]),
    listDesktopCommands: () => call('maker:list-desktop-commands', []),
    learnStart: (req) => call('learn:start', [req]),
    listAgentSkills: (agentKind, opts) => call('maker:list-agent-skills', [agentKind, opts]),
    scanAtResources: (agentKind, opts) => call('maker:scan-at-resources', [agentKind, opts]),
    // skipCache:上次拿到的 ossKey 已悬空(对象被删)时,强制被控端绕过上传去重缓存重传。
    // thumbnail:聊天列表只要缩略图,被控端缩到 1024px webp inline 回包(老被控端
    // 不识别该字段,回落原图 ossKey,消费方两种回包都兼容)。
    fetchRemoteMedia: (url, opts) => call(
      DEVICE_LINK_MEDIA_FETCH_CHANNEL,
      [{
        url,
        ...(opts?.skipCache ? { skipCache: true } : {}),
        ...(opts?.thumbnail ? { thumbnail: true } : {}),
      }],
    ),
    transcribeVoice: (input) => call(DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL, [input]),
    recordVoiceDictionaryLearning: (input) => call(DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL, [input]),
    getVoiceDictionary: () => call(DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL, []),
    getPendingInteractions: (sessionId) => call('maker:get-pending-interactions', [sessionId]),
    resolveInteraction: (requestId, decision) =>
      call('maker:resolve-interaction', [requestId, decision]),
    getContextUsage: (sessionId, createOpts) =>
      call('maker:get-context-usage', [sessionId, createOpts]),
    fork: (sourceSessionId, messageClientId) =>
      call('maker:fork', [sourceSessionId, messageClientId]),
    rewindPreview: (sessionId, clientId) => call('maker:rewind:preview', [sessionId, clientId]),
    rewindCommit: (sessionId, clientId) => call('maker:rewind:commit', [sessionId, clientId]),
    deleteMessage: (sessionId, clientId) => call('maker:message:delete', [sessionId, clientId]),
    closeSession: (sessionId) => call('maker:close-session', [sessionId]),
    clearSessionAttention: (sessionId, intent) =>
      call('notification:clear-session-attention', [sessionId, intent]),
    goal: {
      set: (input) => call('maker:goal:set', [input]),
      clear: (sessionId) => call('maker:goal:clear', [sessionId]),
      getStatus: (sessionId) => call('maker:goal:get-status', [sessionId]),
      pause: (sessionId) => call('maker:goal:pause', [sessionId]),
      resume: (sessionId) => call('maker:goal:resume', [sessionId]),
      update: (sessionId, patch) => call('maker:goal:update', [{ sessionId, patch }]),
    },
    schedule: {
      list: (filter) => call('maker:schedule:list', filter ? [filter] : []),
      get: (id) => call('maker:schedule:get', [id]),
      listTemplates: () => call('maker:schedule:list-templates'),
      createFromTemplate: (input) => call('maker:schedule:create-from-template', [input]),
      create: (input) => call('maker:schedule:create', [input]),
      update: (id, patch) => call('maker:schedule:update', [id, patch]),
      listRuns: (id, limit) => call('maker:schedule:list-runs', [id, limit]),
      runNow: (id) => call('maker:schedule:run-now', [id]),
      pause: (id) => call('maker:schedule:pause', [id]),
      resume: (id) => call('maker:schedule:resume', [id]),
      delete: (id) => call('maker:schedule:delete', [id]),
      getInflightCount: (id) => call('maker:schedule:get-inflight-count', [id]),
      markRunRead: (runId) => call('maker:schedule:mark-run-read', [runId]),
      markScheduleRunsRead: (scheduleId) =>
        call('maker:schedule:mark-schedule-runs-read', [scheduleId]),
      deleteRun: (runId) => call('maker:schedule:delete-run', [runId]),
    },
    projectAutomation: {
      removeSchedule: (input) => call('maker:project-automation:remove-schedule', [input]),
    },
    input: {
      getProjection: (sessionId) => call('maker:input:get-projection', [sessionId]),
      enqueue: (sessionId, item, opts) => call('maker:input:enqueue', [sessionId, item, opts]),
      compact: (sessionId) => call('maker:input:compact', [sessionId]),
      steer: (sessionId, item, opts) => call('maker:input:steer', [sessionId, item, opts]),
      stop: (sessionId, opts) => call('maker:input:stop', [sessionId, opts]),
      resume: (sessionId) => call('maker:input:resume', [sessionId]),
      retryLastError: (sessionId) => call('maker:input:retry-last-error', [sessionId]),
      clearError: (sessionId) => call('maker:input:clear-error', [sessionId]),
      remove: (sessionId, clientId) => call('maker:input:remove', [sessionId, clientId]),
      updateText: (sessionId, clientId, newText, sessionRefs, trustedContexts) =>
        call(
          'maker:input:update-text',
          sessionRefs
            ? [sessionId, clientId, newText, sessionRefs, trustedContexts]
            : [sessionId, clientId, newText],
        ),
      updateContent: (sessionId, clientId, item) =>
        call('maker:input:update-content', [sessionId, clientId, item]),
      move: (sessionId, clientId, targetIndex) =>
        call('maker:input:move', [sessionId, clientId, targetIndex]),
      setExpanded: (sessionId, expanded) =>
        call('maker:input:set-expanded', [sessionId, expanded]),
      setInteractionLock: (sessionId, lockId, locked) =>
        call('maker:input:set-interaction-lock', [sessionId, lockId, locked]),
      setEditLock: (sessionId, clientId, locked) =>
        call('maker:input:set-edit-lock', [sessionId, clientId, locked]),
      clearSession: (sessionId) => call('maker:input:clear-session', [sessionId]),
    },
    fs: {
      listDir: (path) => call('fs:list-dir', [{ path }]),
      statPath: (path) => call('fs:stat-path', [{ path }]),
      mkdirP: (path) => call('fs:mkdir-p', [{ path }]),
      readTextFilePreview: (filePath) => call('text-file:read-preview', [{ filePath }]),
    },
    fileBrowser: {
      caps: (workdir) => call('file-browser:remote-op', [{ op: 'caps', workdir }]),
      listDir: (workdir, relPath) =>
        call('file-browser:remote-op', [{ op: 'listDir', workdir, relPath }]),
      readFile: (workdir, relPath, opts) =>
        call('file-browser:remote-op', [
          { op: 'readFile', workdir, relPath, ...(opts?.acceptGzip ? { acceptGzip: true } : {}) },
        ]),
      listAllFiles: (workdir, cap) =>
        call('file-browser:remote-op', [{ op: 'listAllFiles', workdir, ...(cap ? { cap } : {}) }]),
      searchCollect: (workdir, query, opts) =>
        call('file-browser:remote-op', [{
          op: 'searchCollect',
          workdir,
          query,
          ...(opts?.caseSensitive ? { caseSensitive: true } : {}),
          ...(opts?.maxMatches ? { maxMatches: opts.maxMatches } : {}),
        }]),
      thumbnail: (workdir, relPath) =>
        call('file-browser:remote-op', [{ op: 'thumbnail', workdir, relPath }]),
      exportFileStart: (workdir, relPath) =>
        call('file-browser:remote-op', [{ op: 'exportFileStart', workdir, relPath }]),
      exportFileStatus: (workdir, transferId) =>
        call('file-browser:remote-op', [{ op: 'exportFileStatus', workdir, transferId }]),
    },
  };
}
