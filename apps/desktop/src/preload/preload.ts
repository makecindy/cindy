import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL,
  AGENT_ISLAND_PREVIEW_SOUND_CHANNEL,
  AGENT_ISLAND_SELECT_SOUND_FILE_CHANNEL,
  AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL,
  AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL,
  AGENT_ISLAND_SET_ENABLED_CHANNEL,
  AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL,
  AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL,
  AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL,
  type AgentIslandDisplayOption,
  type AgentIslandDisplayTarget,
  type AgentIslandMascotSkin,
  type AgentIslandSessionActivity,
  type AgentIslandSoundChoice,
  type AgentIslandSoundSettings,
} from '../shared/agentIsland';
import {
  WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL,
  WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL,
  WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL,
  WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL,
  WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL,
  type WindowsCloseBehavior,
} from '../shared/windowBehavior';
import { SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL } from '../shared/selectionContextMenu';
import { SESSION_ATTENTION_CLEARED_CHANNEL } from '../shared/sessionAttention';
import {
  type ApplicationMenuCommand,
  isApplicationMenuCommand,
} from '../shared/applicationMenuCommands';
import type {
  LocalThemeOpenDirResult,
  LocalThemesResult,
  LocalThemeWriteRequest,
  LocalThemeWriteResult,
} from '../shared/local-themes';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '../shared/locale';
import {
  MODEL_ACCESS_STATUS_CHANNEL,
  type ModelAccessStatus as ModelAccessStatusPayload,
} from '../shared/modelAccess';
import type {
  ImDefaultSettingsPatch,
  ImDefaultSettingsState,
} from '../shared/imDefaultSettings';
import type {
  SubagentModelSettingsPatch,
  SubagentModelSettingsState,
} from '../shared/subagentModelSettings';
import type { VoiceInputAsrMode, VoiceInputProviderKind } from '../shared/voiceInputAsrProfiles';
import type { VoiceInputRefinerProviderKind, VoiceInputRefinerTransport } from '../shared/voiceInputRefinerProfiles';
import { isIpcErrorCode, type IpcErrorCode } from '../shared/ipc-errors';
import type { VoiceInputSyncErrorResult } from '../shared/voiceInputData';
import type { UtilityTextFailure } from '../shared/utilityTextResult';
import type {
  ReviewBranchDiffData,
  ReviewCommitDiffData,
  ReviewCommitListData,
  ReviewCommitRequest,
  ReviewCommitResult,
  ReviewData,
  ReviewDirtySummary,
  FileDiff,
  ReviewFileDiffData,
  ReviewFileDiffRequest,
  ReviewFileTarget,
  ReviewHunkOperationRequest,
  ReviewImagePreviewData,
  ReviewMarkdownPreviewData,
  ReviewPushConfirmForce,
  ReviewPushResult,
  ReviewStageOperationResult,
} from '../shared/gitReviewWire';
import type {
  RsbWindowCommandRouteRequest,
  RsbWindowCommandRouteResult,
} from '../shared/rightSidebarWindow';
import type {
  DesktopAccountDeletionAvailabilityResult,
  DesktopAccountDeletionChallengeResult,
  DesktopAccountDeletionConfirmInput,
  DesktopAccountDeletionConfirmResult,
  DesktopAccountDeletionStatusResult,
  DesktopLoginAction,
  DesktopLoginActionResult,
} from '../shared/authIpc';
import { BILLING_INVOKE, type BillingRendererApi } from '../shared/billing';

// Codex 元 IPC 全部升级到 maker.* (agentKind 参数化), preload 不再 import vendor/codex/ipcChannels。
//   auth      → maker:auth:*(agentKind)
//   binary    → maker:agent:status(agentKind)
//   usage     → maker:usage:today(agentKind)
//   OAuth 进度 → maker:auth:login-progress (取代老 codex-oauth)
//   session   → maker:event / maker:send (上一轮已迁)

// ---------------------------------------------------------------------------
// Multi-subscriber IPC fan-out (F-PSI-1)
// ---------------------------------------------------------------------------
// Each IPC channel gets exactly ONE low-level `ipcRenderer.on` binding that
// fans out to a Set of subscriber callbacks. Subscribers receive an unsubscribe
// function; when the last subscriber leaves, the underlying binding is removed.

type IpcCallback = (data: unknown) => void;

function throwVoiceInputSyncError(result: unknown): void {
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== false) return;
  const candidate = result as Partial<VoiceInputSyncErrorResult>;
  if (!isIpcErrorCode(candidate.code)) return;
  const error = new Error(`[${candidate.code}] ${candidate.message ?? 'voice input data operation failed'}`);
  (error as { code?: IpcErrorCode }).code = candidate.code;
  throw error;
}

// ApplicationMenuCommand 从 ../shared/applicationMenuCommands 单点导入。
type ApplicationMenuLocale = SupportedLocale;

function isApplicationMenuLocale(value: unknown): value is ApplicationMenuLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function readInitialPreferredSystemLocale(): ApplicationMenuLocale {
  try {
    const locale = ipcRenderer.sendSync('app-locale:get-preferred-system-locale-sync');
    return isApplicationMenuLocale(locale) ? locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

type VoiceInputShortcutWire = {
  trigger?: 'keyboard' | 'modifier';
  code: string;
  key: string;
  modifiers: {
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    fn: boolean;
  };
};
type VoiceInputGlobalResult =
  | { ok: true }
  | { ok: false; error: string; errorCode?: 'empty' | 'unavailable' | 'unconfirmed' | 'permission' | 'failed' };
type VoiceInputSettingsUpdateResult =
  | { ok: true; settings: import('../shared/voiceInputData').VoiceInputSettings }
  | { ok: false; error: string; errorCode?: 'empty' | 'unavailable' | 'unconfirmed' | 'permission' | 'failed' };
type VoiceInputReadinessWire = {
  ok: boolean;
  provider: VoiceInputProviderKind;
  providerModel: string;
  auth: 'api-key' | 'codex';
  settingsTab: 'api-keys' | 'connections' | 'providers';
  error?: string;
  authErrorReason?: string;
};
type VoiceInputModelSelectionWire = {
  serviceMode: 'cindy' | 'byok';
  serviceModeConfigured: boolean;
  asrProvider: VoiceInputProviderKind;
  refinerProvider: VoiceInputRefinerProviderKind;
  refinerModel?: string;
  configPath: string;
};
type VoiceInputModelSelectionResultWire = {
  selection: VoiceInputModelSelectionWire;
  asrProfiles: Array<{
    id: VoiceInputProviderKind;
    model: string;
    mode: VoiceInputAsrMode;
    auth: 'api-key' | 'codex';
  }>;
  refinerProfiles: Array<{
    id: VoiceInputRefinerProviderKind;
    model: string;
    transport: VoiceInputRefinerTransport;
    auth: 'api-key' | 'codex';
  }>;
  readiness: VoiceInputReadinessWire;
};
type VoiceInputModelSelectionPatchWire = {
  serviceMode?: 'cindy' | 'byok' | null;
  asrProvider?: string | null;
  refinerProvider?: string | null;
  refinerModel?: string | null;
};
type DiscordBotSessionAuthCheckWire = {
  ok: boolean;
  missing: 'gateway-key' | 'agent-oauth' | 'provider-key' | 'provider-disconnected' | null;
  agentKind: 'claude-code' | 'codex';
  model: string;
  providerId: string | null;
  providerLabel: string | null;
};

/**
 * Factory for lazy, ref-counted IPC fan-out subscriptions.
 * - First subscriber → binds `ipcRenderer.on(channel, ...)`
 * - Last unsubscribe → removes the binding
 * - Returns a subscribe function: `(cb) => unsubscribe`
 */
/**
 * Subscribe function plus a dev-only `__reset()` to wipe ALL listeners on the
 * channel. Used on the renderer side via vite HMR `import.meta.hot.dispose` to
 * undo leaked listeners from prior module instances (the old module's
 * `ipcUnsubscribers` array got GC'd along with the module, but the callbacks
 * inside this Set are still strongly referenced — without `__reset` they pile
 * up across HMR cycles, and a single IPC event ends up triggering the same
 * reducer N times → N duplicate rows in SQLite).
 */
type FanOut = ((callback: IpcCallback) => () => void) & { __reset: () => void };

function createIpcFanOut(channel: string): FanOut {
  const listeners = new Set<IpcCallback>();
  let bound = false;
  const bridge = (_event: Electron.IpcRendererEvent, data: unknown) => {
    listeners.forEach((cb) => {
      cb(data);
    });
  };
  const subscribe = ((callback: IpcCallback): (() => void) => {
    listeners.add(callback);
    if (!bound) {
      ipcRenderer.on(channel, bridge);
      bound = true;
    }
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && bound) {
        ipcRenderer.removeListener(channel, bridge);
        bound = false;
      }
    };
  }) as FanOut;
  subscribe.__reset = (): void => {
    listeners.clear();
    if (bound) {
      ipcRenderer.removeListener(channel, bridge);
      bound = false;
    }
  };
  return subscribe;
}

// Stage 2 C1: cc-agent:* push channel fanout 全部退役 (renderer 已切到 maker:event 等),
// 老 7 个 fanOut + fanOutUserMessagePersisted 一起拿掉。
const fanOutUpdateStatus = createIpcFanOut('update-status');
const fanOutOrcaWorkerChanged = createIpcFanOut('maker:orca:worker-changed');
// 右侧栏独立子窗口(RSB window)状态 / 上下文 / 命令推送
const fanOutRsbWindowStateChanged = createIpcFanOut('maker:rsb-window:state-changed');
const fanOutRsbWindowContextChanged = createIpcFanOut('maker:rsb-window:context-changed');
const fanOutRsbWindowCommand = createIpcFanOut('maker:rsb-window:command');
const fanOutBinaryDownloadProgress = createIpcFanOut('binary-download-progress');
// Settings →「电脑使用」cua-driver 更新的下载进度(main 侧采样后广播)
const fanOutComputerDriverUpdateProgress = createIpcFanOut('computer-driver-update-progress');
const fanOutAppUpdateProgress = createIpcFanOut('app-update-progress');
const fanOutAuthStateChange = createIpcFanOut('auth:state-change');
const fanOutAuthSessionExpired = createIpcFanOut('auth:session-expired');
const fanOutTapdbDailyActive = createIpcFanOut('tapdb:daily-active');
const fanOutFullscreenChange = createIpcFanOut('fullscreen-change');
const fanOutApplicationMenuCommand = createIpcFanOut('app-menu:command');
// 首登轻量数据迁移(mToc)弹窗阶段推送(confirm / running / done / failed)
const fanOutLegacyMigrationState = createIpcFanOut('legacy-migration:state');
const fanOutCorruptionRestored = createIpcFanOut('local-db:corruption-restored');
// #37: release 端检测到 schema drift 时一次性 toast 提示开发者切回 dev 自动修复
const fanOutSchemaDriftWarning = createIpcFanOut('local-db:schema-drift-warning');
const fanOutProjectAliasesChanged = createIpcFanOut('local-db:project-aliases:changed');
// Workdir File Browser — push events from chokidar (add/change/unlink/...)
const fanOutFileBrowserEvent = createIpcFanOut('maker:file-browser:event');
const fanOutFileBrowserTransfer = createIpcFanOut('maker:file-browser:transfer');
// Project-wide text search (rg-backed) — match/end/error stream events keyed by searchId.
const fanOutSearchEvent = createIpcFanOut('maker:search:event');
// 系统级通知点击回调：把 sessionId 广播给 renderer 做路由跳转。
const fanOutNotificationFocusSession = createIpcFanOut('notification:focus-session');
// 会话已读广播:main 端 clearSessionAttention 后同步给所有窗口。清除来源可能是
// device-link 远程控制端(手机看完会话),renderer 的 sessionAttentionStore 靠这条
// 把本机侧栏红绿点一并清掉(本机自己发起的清除收到回声做幂等 no-op)。
const fanOutSessionAttentionCleared = createIpcFanOut(SESSION_ATTENTION_CLEARED_CHANNEL);
// cindy://(+ 历史 xdt-maker://)深度链接：main 端解析出 sessionId / workingDir 后广播,
// renderer 端 MainLayout 订阅 → 路由 / 聚焦 project。
const fanOutDeepLinkNavigate = createIpcFanOut('deep-link:navigate');
// RSB web-browser plugin:guest webview 内 window.open / target=_blank 路由。
// main 端 webview-security setWindowOpenHandler 把 popup URL 推到这里,renderer
// 端 RightSidebarShell 订阅 → store.addTab 开新 web-browser tab。
const fanOutRsbBrowserPopup = createIpcFanOut('rsb:browser-popup');
// RSB terminal plugin: main 端 PTY onData / onExit 推过来,renderer 按 id filter。
// 每个 tab 自己订阅,fanOut 内部去重 ipcRenderer.on 绑定。
const fanOutTerminalData = createIpcFanOut('terminal:data');
const fanOutTerminalExit = createIpcFanOut('terminal:exit');
// RSB web-browser plugin:guest webview 内 Cmd/Ctrl+L 路由。main 端
// webview-security before-input-event 拦截 → 通知 host renderer 让 active 的
// BrowserTabBody 调 chrome.focusUrlBar()。
const fanOutRsbBrowserFocusUrlBar = createIpcFanOut('rsb:browser-focus-url-bar');
const fanOutRsbBrowserCommand = createIpcFanOut('rsb:browser-command');
// RSB browser bridge:main 端 TabRegistry 在 pin set 变化时通知 renderer 把
// 对应 tab 标记 / 取消标记 automation pinned。renderer 端的 BrowserWebviewPool
// LRU 据此跳过 pinned tab,避免 automation 操作期间 webContents 被销毁。
const fanOutRsbBrowserBridgePin = createIpcFanOut('rsb-browser-bridge:pin');
const fanOutRsbBrowserBridgeUnpin = createIpcFanOut('rsb-browser-bridge:unpin');
// Phase 3: RsbWebviewBackend (open/focus/close) push 给 renderer 让它代调 store。
const fanOutRsbBrowserBridgeTabOpRequest = createIpcFanOut('rsb-browser-bridge:tab-op-request');
// session-git-pr-context: HEAD 分支变化 / session PR 引用变化推送
const fanOutGitContextChanged = createIpcFanOut('git-context:changed');
const fanOutGitContextPrRefsChanged = createIpcFanOut('git-context:pr-refs-changed');
// 系统级瞬时网络错误 tip：lifecycle 兜底 catch 到 ETIMEDOUT/ECONNRESET 等不杀进程时,
// 把 err.code / address / port 推给 renderer, renderer 自己 toast (带节流) 让用户感知。
const fanOutSystemTransientNetworkError = createIpcFanOut('system:transient-network-error');
// Find in Page (F-FIP-1): Chromium 异步回推匹配数 / 当前 ordinal。
const fanOutFindInPageResult = createIpcFanOut('find-in-page:result');
const fanOutSelectionContextMenuAddToChat = createIpcFanOut(SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL);
// session 级别"终身累计 cost"实时变化（每个 cc done 事件后 main 推）。chip 用它显示"$X.XX session"。
// today aggregate 已搬到 maker.usage.* 下面 (取代老 fanOutUsageTodaySpendChanged + codex.usage.onChanged)。
const fanOutUsageSessionSpendChanged = createIpcFanOut('usage:session-spend-changed');
const fanOutUsageSessionTokensChanged = createIpcFanOut('usage:session-tokens-changed');
// per-message 维度: turn 结束后 main 把该轮费用挂到最后一条 assistant 并推送
// (MessageActionBar 显示)。payload 同时带原始 SDK 分段成本 turnCost* 与展示用
// 用户轮累计 userTurnCost*；账单汇总只消费前者。
const fanOutUsageMessageTurnCost = createIpcFanOut('usage:message-turn-cost');
// per-message 维度: turn 结束检测到模型被上游降级 / 替换时推标记(AssistantMessage
// 渲染降级提示行)。payload: { sessionId, clientId, modelMismatch: { selected, actual } }。
const fanOutUsageMessageModelMismatch = createIpcFanOut('usage:message-model-mismatch');
// FeiShu Bot：状态变化 + 冲突检测 + 注册流程 push channel。
const fanOutFeishuBotStatusChange = createIpcFanOut('feishuBot:status-change');
const fanOutFeishuBotConflict = createIpcFanOut('feishuBot:conflict');
const fanOutFeishuBotRegistrationStatus = createIpcFanOut('feishuBot:registration-status');
// Discord Bot：本机凭证模式；这里只暴露 @cindy/im DiscordIM 的 transport 状态。
const fanOutDiscordBotStatusChange = createIpcFanOut('discordBot:status-change');
const fanOutVoiceInputEvent = createIpcFanOut('voice-input:event');
const fanOutVoiceInputGlobalShortcutTrigger = createIpcFanOut('voice-input:global-shortcut-trigger');
const fanOutVoiceInputGlobalOverlayCommand = createIpcFanOut('voice-input:global-overlay-command');
const fanOutVoiceInputDictionaryLearningEvidence = createIpcFanOut('voice-input:dictionary-learning-evidence');
const fanOutVoiceInputDataChanged = createIpcFanOut('voice-input:data-changed');
// 应用级快捷键 override 变化广播 (设置页改绑 / reset 后 main 推全量 overrides,
// renderer 侧 appShortcutStore 订阅热更新)。
const fanOutAppShortcutsChanged = createIpcFanOut('app-shortcuts:changed');
// 主界面布局树变化广播 (layout:set / layout:reset 后 main 推全量布局快照,
// 多窗口热更新;见 main/layout/index.ts)。
const fanOutLayoutChanged = createIpcFanOut('layout:changed');
// 意识仓库变化广播 (install/uninstall 后 main 推全量已装清单,多窗口热更新;
// 见 main/cindy-brain/index.ts)。
const fanOutGhostsChanged = createIpcFanOut('ghosts:changed');
// Plugin 顶部已安装快捷行的最近使用顺序，多窗口同步。
const fanOutGhostRecentUsageChanged = createIpcFanOut('ghosts:recent-usage-changed');
// 双击 .cindy 转交信号(main 缓存路径,renderer 收信号后来取,统一走应用内确认流程)。
const fanOutGhostInstallRequested = createIpcFanOut('ghosts:install-requested');
// 意识运行时状态广播(crashed/fused → 面板原地错误接管态)。
const fanOutGhostRuntimeChanged = createIpcFanOut('ghosts:runtime-changed');
// 意识面板「点图看大图」推送(main 拦下 /preview/ 导航并过闸后推 cindy-media 地址)。
const fanOutGhostPreviewMedia = createIpcFanOut('ghosts:preview-media');
// 意识聊天卡片更新推送(卡槽③:card-update 过闸后带 html 全量推,renderer 免回查)。
const fanOutGhostCardUpdated = createIpcFanOut('ghosts:card-updated');
// 意识后台活动(card-action 干活)会话忙闲推送(0↔1 转变才推;侧栏呼吸用)。
const fanOutGhostSessionActivity = createIpcFanOut('ghosts:session-activity');
// 用户消息被意识钩子拦下(卡槽①:renderer 把乐观气泡原地降级为被拦态)。
const fanOutGhostMessageBlocked = createIpcFanOut('ghosts:user-message-blocked');
// 用户消息被意识钩子改写(卡槽①:renderer 把气泡正文换成改写版并留痕署名)。
const fanOutGhostMessageRewritten = createIpcFanOut('ghosts:user-message-rewritten');
// AI 回复被出口钩子(will-assistant-message)改写(renderer 气泡静默换文本)。
const fanOutGhostAssistantRewritten = createIpcFanOut('ghosts:assistant-message-rewritten');
// 出口钩子后台处理中/完成的轻指示(renderer 在该 assistant 气泡挂"意识处理中")。
const fanOutGhostAssistantPending = createIpcFanOut('ghosts:assistant-message-pending');
// 意识钩子熔断(连续超时/崩溃 → 降级只旁听,renderer 弹提示)。
const fanOutGhostHookFused = createIpcFanOut('ghosts:hook-fused');
// 意识系统提示(notify 槽:宿主 Toast 渲染,带意识身份头)。
const fanOutGhostNotify = createIpcFanOut('ghosts:notify');
// 插件预览开页(preview 槽:renderer 在右侧栏开 web-browser 标签)。
const fanOutGhostPreviewOpen = createIpcFanOut('ghosts:preview-open');
const fanOutVoiceInputModifierShortcutKeys = createIpcFanOut('voice-input:modifier-shortcut-keys');
// Remote SSH (Phase A) — host status fan-out. Channel literal kept in
// sync with REMOTE_SSH_PUSH.STATUS_CHANGED in main/remote-ssh/index.ts;
// preload can't import from main due to vite chunking.
const fanOutRemoteSshStatus = createIpcFanOut('maker:remote-ssh:status-changed');
// Phase B — install progress events (per hostId + agentKind).
const fanOutRemoteSshInstallProgress = createIpcFanOut('maker:remote-ssh:install-progress');
// Phase D — silent install status (maker:send 触发的自动 install 给 toast 用)。
const fanOutRemoteSshSilentInstallStatus = createIpcFanOut('maker:remote-ssh:silent-install-status');
// cc-mgr 版本不匹配的 banner push (per hostId set / clear)。
const fanOutRemoteSshCcMgrUpgradeAvailable = createIpcFanOut('maker:remote-ssh:cc-mgr-upgrade-available');
// Hook 连接(hook-control)状态推送(单条连接快照)。
const fanOutHookControlStatus = createIpcFanOut('maker:hook-control:status-changed');
// Hook 目录偏好快照推送(prefs.state; 含 Slack /model 卡改动的实时同步)。
const fanOutHookControlPrefs = createIpcFanOut('maker:hook-control:prefs-changed');
const fanOutHookControlProviderPrefs = createIpcFanOut(
  'maker:hook-control:provider-prefs-changed',
);

// ─── Maker Core 一阶段重构（新链路）── 与 cc-agent:* / codex:* 双轨并行 ─────
const fanOutMakerEvent = createIpcFanOut('maker:event');
const fanOutMakerStatusChanged = createIpcFanOut('maker:status-changed');
const fanOutMakerInputProjection = createIpcFanOut('maker:input:projection');
const fanOutMakerInteractionRequest = createIpcFanOut('maker:interaction-request');
const fanOutMakerInteractionDismissed = createIpcFanOut('maker:interaction-dismissed');
// Agent 鉴权 + today usage push (取代老 codex:auth:state-changed / codex-oauth / codex:usage:changed)
const fanOutMakerAuthStateChanged = createIpcFanOut('maker:auth:state-changed');
const fanOutMakerAuthLoginProgress = createIpcFanOut('maker:auth:login-progress');
// 自定义供应商增删改广播 → 各 useProviders 实例 refetch（设置页列表 + 对话模型选择器 live 刷新）。
const fanOutMakerProvidersChanged = createIpcFanOut('maker:provider:changed');
// 自定义 MCP 服务器增删改广播 → 设置页 McpServersSection refetch。
const fanOutMakerMcpChanged = createIpcFanOut('maker:mcp:changed');
// 自定义供应商上游错误的结构化广播（payload = { agent, providerId, providerName, code, retryable, status }）。
const fanOutMakerProviderUpstreamError = createIpcFanOut('maker:provider:upstream-error');
// Claude Auto classifier 失败后单会话降级到 ask 的结构化广播。
const fanOutMakerAutoPermissionFallback = createIpcFanOut('maker:auto-permission:fallback');
const fanOutMakerCodexRuntimeRouteChanged = createIpcFanOut('maker:codex-runtime-route-changed');
// 延迟凭证切换在 turn 结束兑现的广播(payload = { sessionId, model, providerId })。
const fanOutMakerSessionCredentialSwitchApplied = createIpcFanOut('maker:session-credential-switch-applied');
const fanOutMakerClaudeSessionRouteChanged = createIpcFanOut('maker:claude-session-route-changed');
// 会话后台活动翻转广播(payload = { sessionId, active }):turn 已结束但 CC 子进程仍在调模型。
const fanOutMakerSessionBackgroundActivityChanged = createIpcFanOut('maker:session-background-activity-changed');
const fanOutMakerUsageTodaySpend = createIpcFanOut('usage:today-spend-changed');    // Claude USD
const fanOutMakerUsageTodayTokens = createIpcFanOut('usage:today-tokens-changed');  // Codex token
const fanOutMakerUsageClaudeAccount = createIpcFanOut('usage:claude-account-changed'); // Claude 月度配额
const fanOutMakerUsageCodexAccount = createIpcFanOut('usage:codex-account-changed'); // Codex 订阅用量
const fanOutMakerUsageXaiRateLimit = createIpcFanOut('usage:xai-rate-limit-changed'); // xAI bridge 限流快照
const fanOutMakerUsageClaudeSubscription = createIpcFanOut('usage:claude-subscription-changed'); // Claude 订阅余量
// 跨 Agent 工作区互转 — 转换进度 push (per step)
const fanOutCrossAgentStep = createIpcFanOut('maker:cross-agent:step');
// Scheduler (Phase 4) — 4 个 SchedulerEvent 类型 ('fired'|'completed'|'failed'|'changed')
// 共用一个 channel；renderer 拿到 payload 后按 .type 分支。
const fanOutScheduleEvent = createIpcFanOut('maker:schedule:event');
const fanOutProjectAutomationEvent = createIpcFanOut('maker:project-automation:event');
// 会话内 /goal 状态变化 push（GoalStatusUpdate）。renderer useGoalStatus 按 sessionId 过滤。
const fanOutGoalStatusChanged = createIpcFanOut('maker:goal:status-changed');
// 设备互联(跨设备远程控制)— presence / relay 连接状态 / 远程事件转发 push
const fanOutDeviceLinkPresenceChanged = createIpcFanOut('device-link:presence-changed');
const fanOutDeviceLinkStatusChanged = createIpcFanOut('device-link:status-changed');
const fanOutDeviceLinkConnectionIssue = createIpcFanOut('device-link:connection-issue');
const fanOutDeviceLinkRemotePush = createIpcFanOut('device-link:remote-push');
const fanOutDeviceLinkControlledState = createIpcFanOut('device-link:controlled-state');
const fanOutDeviceLinkAccessRevoked = createIpcFanOut('device-link:access-revoked');
const fanOutDeviceLinkControlTargetChanged = createIpcFanOut('device-link:control-target-changed');
const fanOutDeviceLinkKeepAwakeChanged = createIpcFanOut('device-link:keep-awake-changed');

// device-link 模型列表写穿:被控端本地 main → 自身 renderer,把控制端写穿的草稿 / 会话 pref
// 交给 renderer 调它原来的本地 setter。仅被控端进程会收到(控制端从不收 → 监听不误触发)。
const fanOutMakerDraftPrefApply = createIpcFanOut('maker:draft-pref:apply');
const fanOutMakerSessionPrefApply = createIpcFanOut('maker:session-pref:apply');

// 跨 Agent 迁移项的 wire 形态（同 main/cross-agent-convert/types.ts 的 MigrationItem，
// 但 preload 是单独编译单元，不便 import；renderer 真正消费在 vite-env.d.ts 重新声明）。
interface CrossAgentMigrationItem {
  id: string;
  kind: 'agents-md' | 'agents' | 'hooks' | 'mcp';
  direction: 'to-claude' | 'to-codex';
  label: string;
  source: string;
  target: string;
  subItems?: { name: string; sourcePath: string; targetPath: string }[];
}

interface PluginListItem {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'hub' | 'local';
  essential: boolean;
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
}

interface PluginEnableState {
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
}

interface PluginEnableUpdateResult {
  codexMcpRefreshed: boolean;
}

interface BrowserAvailability {
  detected: boolean;
  browserKind: string | null;
  executablePath: string | null;
}

type AndroidMcpErrorCode =
  | 'ADB_NOT_FOUND'
  | 'NO_DEVICE'
  | 'MULTIPLE_DEVICES'
  | 'DEVICE_UNAUTHORIZED'
  | 'DEVICE_OFFLINE'
  | 'UI_DUMP_FAILED'
  | 'SCREENSHOT_FAILED'
  | 'INVALID_NODE'
  | 'ANDROID_DRIVER_ERROR';

type AndroidAdbPathSource =
  | 'custom'
  | 'env'
  | 'prepared'
  | 'bundled'
  | 'sdk'
  | 'path'
  | 'fallback';

interface AndroidConnectedDevice {
  device_serial: string;
  state: string;
  product?: string;
  model?: string;
  device?: string;
  transport_id?: string;
  usb?: string;
}

interface AndroidAdbPreparationState {
  supported: boolean;
  ready: boolean;
  platform: string;
  path: string | null;
  source: AndroidAdbPathSource | null;
  error?: string;
}

interface AndroidStatusSummary {
  adb_available: boolean;
  adb_path: string | null;
  adb_path_source?: AndroidAdbPathSource | null;
  adb_preparation?: AndroidAdbPreparationState;
  version: string | null;
  devices: AndroidConnectedDevice[];
  default_device_serial?: string | null;
  configured_default_device_serial?: string | null;
  issue?: AndroidMcpErrorCode | null;
  error?: string;
}

interface AndroidAutomationSettings {
  defaultDeviceSerial: string | null;
  adbPathOverride: string | null;
}

interface AndroidAutomationConfigState {
  value: AndroidAutomationSettings;
  isCustomized: boolean;
  defaults: AndroidAutomationSettings;
  customizedKeys: string[];
}

interface ComputerDriverStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  daemonRunning: boolean;
  daemonStatus?: string;
  doctor?: unknown;
  permissions?: unknown;
  permissionState?: ComputerDriverPermissionState;
  installCommand: string;
  docsUrl: string;
  error?: string;
}

interface ComputerDriverStatusOptions {
  includeDoctor?: boolean;
  forcePermissionProbe?: boolean;
  freshPermissionProbe?: boolean;
  bypassPermissionProbeCache?: boolean;
}

type ComputerDriverPermissionPlatform = 'macos' | 'windows' | 'linux' | 'unsupported';
type ComputerDriverPermissionStatus = 'granted' | 'missing' | 'unknown' | 'not_required';
type ComputerDriverPermissionGrant = 'granted' | 'missing' | 'unknown' | 'not_required';

interface ComputerDriverPermissionState {
  platform: ComputerDriverPermissionPlatform;
  required: boolean;
  status: ComputerDriverPermissionStatus;
  accessibility?: ComputerDriverPermissionGrant;
  screenRecording?: ComputerDriverPermissionGrant;
  screenRecordingCapturable?: ComputerDriverPermissionGrant;
  source?: string;
  reason?: string;
  canGrant: boolean;
}

interface ComputerDriverInstallResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: ComputerDriverStatus;
}

type ComputerDriverPermissionGrantResult = ComputerDriverInstallResult;

interface ComputerDriverUpdateCheck {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updating: boolean;
}

const appDisplayVersionInfo = ipcRenderer.sendSync('get-app-display-version-info') as {
  display: string;
  detail: string;
};

// 运行期端点清单(main 在 createWindow 前解析完成;首帧同步可用)。
// 只暴露 renderer 实际消费的字段,新增消费点时在此处扩展。
const clientEndpointsInfo = ipcRenderer.sendSync('client-endpoints:get-sync') as {
  websiteUrl: string;
};

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  osRelease: ipcRenderer.sendSync('get-os-release') as string,
  appVersion: ipcRenderer.sendSync('get-app-version') as string,
  clientEndpoints: { websiteUrl: clientEndpointsInfo?.websiteUrl ?? '' },
  preferredSystemLocale: readInitialPreferredSystemLocale(),
  appDisplayVersion: appDisplayVersionInfo.display,
  appDisplayVersionDetail: appDisplayVersionInfo.detail,
  getDeviceId: (): Promise<string> => ipcRenderer.invoke('get-device-id'),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  /**
   * 手动窗口拖拽(no-drag 元素上"按住拖动移动窗口"):start 后 main 用光标
   * 位置驱动本窗口跟随,直到 stop。见 main/windowManualDrag.ts。
   */
  windowDragMoveStart: () => ipcRenderer.send('window-drag-move-start'),
  windowDragMoveStop: () => ipcRenderer.send('window-drag-move-stop'),
  /**
   * mac ⌘W 的窗口级 fallback:对本窗口 win.close()(主窗被 main 的 close handler
   * 转成隐藏,副窗正常关闭)。与 windowClose(自定义 X,主窗 = 退出 app)语义不同。
   */
  windowCloseSelf: () => ipcRenderer.send('window-close-self'),
  /**
   * 查询当前是否有 session 在 turn 中。WindowControls 用它决定关闭按钮是否弹确认框。
   * splash / login 阶段 maker-ipc handler 还没注册时,invoke 会 reject — 由调用方
   * catch 后兜底当作 false (那个阶段本来就不可能有 in-flight)。
   */
  anySessionInTurn: (): Promise<boolean> =>
    ipcRenderer.invoke('maker:any-session-in-turn'),
  pageZoomIn: (): Promise<{ ok: true; zoomLevel: number }> => ipcRenderer.invoke('page-zoom:in'),
  pageZoomOut: (): Promise<{ ok: true; zoomLevel: number }> => ipcRenderer.invoke('page-zoom:out'),
  pageZoomReset: (): Promise<{ ok: true; zoomLevel: number }> =>
    ipcRenderer.invoke('page-zoom:reset'),
  onApplicationMenuCommand: (
    callback: (command: ApplicationMenuCommand) => void,
  ): (() => void) =>
    fanOutApplicationMenuCommand((payload) => {
      if (isApplicationMenuCommand(payload)) {
        callback(payload);
      }
    }),
  setApplicationMenuLocale: (locale: ApplicationMenuLocale): Promise<{ ok: true }> =>
    ipcRenderer.invoke('app-menu:set-locale', locale),

  // 主进程兜底 catch 到瞬时网络错误时推一次 (lifecycle.ts), payload: { code, address?, port? }。
  // 节流由 renderer 侧 (systemNetworkErrorToast.ts) 负责, 这里只透传, 不去重。
  onSystemTransientNetworkError: (
    callback: (payload: { code: string; address?: string; port?: number }) => void,
  ): (() => void) =>
    fanOutSystemTransientNetworkError((payload) => {
      if (
        payload &&
        typeof payload === 'object' &&
        typeof (payload as { code?: unknown }).code === 'string'
      ) {
        callback(payload as { code: string; address?: string; port?: number });
      }
    }),

  // Renderer 日志转发到 main.log（全级别 + scope，dev/packaged 都调用，
  // main 端按 LOG_LEVEL 过滤）
  logToMain: (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    scope: string,
    msg: string,
  ): void => ipcRenderer.send('renderer:log', level, scope, msg),

  localThemes: {
    listSync: (): LocalThemesResult => {
      try {
        return ipcRenderer.sendSync('local-themes:list-sync') as LocalThemesResult;
      } catch (err) {
        return { success: false, error: String(err), themes: [], diagnostics: [] };
      }
    },
    list: (): Promise<LocalThemesResult> => ipcRenderer.invoke('local-themes:list'),
    write: (req: LocalThemeWriteRequest): Promise<LocalThemeWriteResult> =>
      ipcRenderer.invoke('local-themes:write', req),
    openDir: (): Promise<LocalThemeOpenDirResult> =>
      ipcRenderer.invoke('local-themes:open-dir'),
  },

  // RSB terminal tab(PTY 后端 + xterm.js)
  // - create / write / resize / dispose / restart: 单 PTY 生命周期管理
  // - listAvailableShells / get|setDefaultShellPref: Settings 个性化下拉用
  // - onData / onExit: main → renderer 推送(fanOut 内部一次绑定多订阅,每个 tab 自己按 id filter)
  terminal: {
    create: (params: unknown) => ipcRenderer.invoke('terminal:create', params),
    write: (id: string, data: string) =>
      ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    dispose: (id: string) => ipcRenderer.invoke('terminal:dispose', id),
    restart: (id: string) => ipcRenderer.invoke('terminal:restart', id),
    listAvailableShells: () =>
      ipcRenderer.invoke('terminal:list-available-shells'),
    getDefaultShellPref: () =>
      ipcRenderer.invoke('terminal:get-default-shell-pref'),
    setDefaultShellPref: (value: string) =>
      ipcRenderer.invoke('terminal:set-default-shell-pref', value),
    onData: (cb: IpcCallback) => fanOutTerminalData(cb),
    onExit: (cb: IpcCallback) => fanOutTerminalExit(cb),
  },

  // 应用级快捷键 (shared/appShortcuts registry 的用户 override 通道)。
  // renderer 只拿 overrides + platform, 生效值合并在 renderer 侧用同一份
  // shared 代码完成 —— 与 main 消费端判定不漂移。
  appShortcuts: {
    getState: (): { overrides: Record<string, unknown>; platform: string } =>
      ipcRenderer.sendSync('app-shortcuts:get'),
    setOverride: (id: string, combo: unknown): Promise<{ overrides: Record<string, unknown> }> =>
      ipcRenderer.invoke('app-shortcuts:set-override', id, combo),
    clearOverride: (id: string): Promise<{ overrides: Record<string, unknown> }> =>
      ipcRenderer.invoke('app-shortcuts:clear-override', id),
    resetAll: (): Promise<{ overrides: Record<string, unknown> }> =>
      ipcRenderer.invoke('app-shortcuts:reset-all'),
    // 设置页录制态通知: main 侧据此暂停菜单 accelerator 注册与 before-input
    // 消费 (录制互斥的 main 半边; renderer 半边是 body dataset 旗标)。
    setRecording: (active: boolean): void =>
      ipcRenderer.send('app-shortcuts:set-recording', active),
    onChanged: fanOutAppShortcutsChanged,
  },

  // 主界面布局树 (shared/layoutTree.ts)。getStateSync 走 sendSync:布局必须
  // 首帧就位,禁止"先渲染默认再跳成用户布局"(设计规范规则 7);文件极小,
  // 同步读不卡启动,与 app-shortcuts:get 同模式。
  layout: {
    getStateSync: (): { layout: unknown } => ipcRenderer.sendSync('layout:get'),
    set: (layout: unknown): Promise<{ layout: unknown }> =>
      ipcRenderer.invoke('layout:set', layout),
    reset: (): Promise<{ layout: unknown }> => ipcRenderer.invoke('layout:reset'),
    onChanged: fanOutLayoutChanged,
  },

  // 意识仓库 (shared/ghost.ts)。listSync 走 sendSync:意识面板要与内置
  // 面板同帧注册进布局引擎(规则 7 无跳变);目录扫描极小,同步读不卡启动。
  ghosts: {
    listSync: (): { ghosts: unknown[] } => ipcRenderer.sendSync('ghosts:list'),
    recentUsageSync: (): { ids: string[] } => {
      try {
        const result = ipcRenderer.sendSync('ghosts:recent-usage') as { ids?: unknown } | null;
        return {
          ids: Array.isArray(result?.ids)
            ? result.ids.filter((id): id is string => typeof id === 'string')
            : [],
        };
      } catch {
        // MRU 是非关键展示数据；main 不可用 /旧版无 channel 时首屏按空历史渲染。
        return { ids: [] };
      }
    },
    markUsed: (id: string): Promise<{ ids: string[] }> =>
      ipcRenderer.invoke('ghosts:mark-used', id),
    /** 配置就绪检查(插件页「使用」前置门;main 现查凭证/账号/连接/kv)。 */
    setupStatus: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('ghosts:setup-status', id),
    install: (
      lizFilePath: string,
      opts: { enable?: boolean; expectedPackageSha256: string },
    ): Promise<{ ghost: unknown } | { canceled: true }> =>
      ipcRenderer.invoke('ghosts:install', lizFilePath, opts),
    update: (
      lizFilePath: string,
      opts: { expectedPackageSha256: string },
    ): Promise<{ ghost: unknown } | { canceled: true }> =>
      ipcRenderer.invoke('ghosts:update', lizFilePath, opts),
    cindyPrefsSync: (
      id: string,
    ): {
      overrides: Record<string, string>;
      /** 每类目一份下拉数据(能力键按类目取对应清单)。 */
      image: { options: Array<{ id: string; label: string }>; defaultModel: { id: string; label: string } };
      video: { options: Array<{ id: string; label: string }>; defaultModel: { id: string; label: string } };
    } => ipcRenderer.sendSync('ghosts:cindy-prefs', id),
    setCindyPref: (id: string, capability: string, model: string | null): Promise<{ overrides: Record<string, string> }> =>
      ipcRenderer.invoke('ghosts:cindy-prefs:set', id, capability, model),
    pickFile: (): Promise<{ canceled: true } | { filePath: string }> =>
      ipcRenderer.invoke('ghosts:pick-file'),
    inspect: (lizFilePath: string): Promise<{
      manifest: unknown;
      trust: unknown;
      packageSha256: string;
      iconDataUrl?: string;
    }> =>
      ipcRenderer.invoke('ghosts:inspect', lizFilePath),
    uninstall: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('ghosts:uninstall', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('ghosts:set-enabled', id, enabled),
    /** 目录级禁用清单(插件页项目范围视图;sendSync 保证切换同帧渲染)。 */
    workdirPrefsSync: (workdir: string): { disabled: string[] } =>
      ipcRenderer.sendSync('ghosts:workdir-prefs', workdir),
    setWorkdirDisabled: (workdir: string, id: string, disabled: boolean): Promise<{ disabled: string[] }> =>
      ipcRenderer.invoke('ghosts:workdir-prefs:set', workdir, id, disabled),
    takePendingInstall: (): Promise<{ filePath: string | null }> =>
      ipcRenderer.invoke('ghosts:take-pending-install'),
    onChanged: fanOutGhostsChanged,
    onRecentUsageChanged: fanOutGhostRecentUsageChanged,
    onInstallRequested: fanOutGhostInstallRequested,
    onRuntimeChanged: fanOutGhostRuntimeChanged,
    onPreviewMedia: fanOutGhostPreviewMedia,
    onCardUpdated: fanOutGhostCardUpdated,
    onSessionActivity: fanOutGhostSessionActivity,
    onUserMessageBlocked: fanOutGhostMessageBlocked,
    onUserMessageRewritten: fanOutGhostMessageRewritten,
    onAssistantMessageRewritten: fanOutGhostAssistantRewritten,
    onAssistantMessagePending: fanOutGhostAssistantPending,
    onHookFused: fanOutGhostHookFused,
    onNotify: fanOutGhostNotify,
    onPreviewOpen: fanOutGhostPreviewOpen,
    getCard: (
      callId: string,
    ): Promise<{
      card: { callId: string; ghostId: string; html: string; height: number; v: number } | null;
    }> => ipcRenderer.invoke('ghosts:card:get', callId),
    listCardsBySession: (
      sessionId: string,
    ): Promise<{
      cards: Array<{ callId: string; ghostId: string; html: string; height: number; v: number }>;
    }> => ipcRenderer.invoke('ghosts:card:list-by-session', sessionId),
    // 会话切换上报(订阅槽① did-session-switched 的数据源):路由 effect 每次
    // 路由变化调,单向 send 零等待;去重/资格门全在 main。
    noteSessionFocused: (sessionId: string | null): void =>
      ipcRenderer.send('ghosts:session-focused', sessionId),
    reportCardHeight: (callId: string, height: number): Promise<{ ok: true }> =>
      ipcRenderer.invoke('ghosts:card:report-height', callId, height),
    // 交互卡(v2)按钮点击回传:renderer 受信桥捕获 data-ghost-action 点击后调,
    // 主机验卡片归属→唤醒意识→管子下发 card-action 事件。fire-and-forget。
    // prompt 仅 data-ghost-prompt 类动作有(宿主输入框收集的用户文字)。
    dispatchCardAction: (callId: string, actionId: string, prompt?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('ghosts:card:action', callId, actionId, prompt),
    resolvePanelMedia: (
      uri: string,
      purpose?: 'attach' | 'menu',
    ): Promise<
      | { url: string; kind?: 'image' }
      | { url: string; kind: 'video'; absPath: string; size: number; name: string; ext: string; mimeType: string }
    > => ipcRenderer.invoke('ghosts:resolve-panel-media', uri, purpose),
    runtimeStates: (): Promise<{ states: Record<string, string> }> =>
      ipcRenderer.invoke('ghosts:runtime-states'),
    reload: (id: string): Promise<{ state: string }> => ipcRenderer.invoke('ghosts:reload', id),
    // dev-only 运行时控制(packaged 版 main 侧不注册该 channel)。
    devRuntime: (action: 'status' | 'spawn' | 'stop' | 'crash', id?: string): Promise<unknown> =>
      ipcRenderer.invoke('ghosts:dev-runtime', action, id),
  },

  voiceInput: {
    prewarm: (payload?: { sourceLanguage?: string; refinementEnabled?: boolean }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:prewarm', payload),
    getBenchmarkFixtureAudio: (): Promise<{ ok: true; path: string; wav: ArrayBuffer } | { ok: false }> =>
      ipcRenderer.invoke('voice-input:benchmark-fixture-audio'),
    getMicrophonePermissionCached: ():
      | { ok: true; status: string }
      | { ok: false; status: string; error: string } =>
      ipcRenderer.sendSync('voice-input:get-microphone-permission-cached'),
    getSystemPermissionsCached: (): {
      microphone: { ok: true; status: string } | { ok: false; status: string; error: string };
      inputMonitoring: { ok: true; status: string } | { ok: false; status: string; error: string };
      accessibility: { ok: true; status: string } | { ok: false; status: string; error: string };
    } =>
      ipcRenderer.sendSync('voice-input:get-system-permissions-cached'),
    requestMicrophonePermission: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('voice-input:request-microphone-permission'),
    setRendererMicrophonePermissionVerified: (verified: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:set-renderer-microphone-permission-verified', verified),
    getSystemPermissions: (): Promise<{
      microphone: { ok: true; status: string } | { ok: false; status: string; error: string };
      inputMonitoring: { ok: true; status: string } | { ok: false; status: string; error: string };
      accessibility: { ok: true; status: string } | { ok: false; status: string; error: string };
    }> =>
      ipcRenderer.invoke('voice-input:get-system-permissions'),
    openMicrophoneSettings: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('voice-input:open-microphone-settings'),
    openInputMonitoringSettings: (): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:open-input-monitoring-settings'),
    muteSystemAudio: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('voice-input:mute-system-audio'),
    restoreSystemAudio: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('voice-input:restore-system-audio'),
    getReadiness: (): Promise<VoiceInputReadinessWire> => ipcRenderer.invoke('voice-input:get-readiness'),
    getReadinessCached: (): VoiceInputReadinessWire | null =>
      ipcRenderer.sendSync('voice-input:get-readiness-cached'),
    getModelSelection: (): Promise<VoiceInputModelSelectionResultWire> =>
      ipcRenderer.invoke('voice-input:model-selection:get'),
    setModelSelection: (patch: VoiceInputModelSelectionPatchWire): Promise<VoiceInputModelSelectionResultWire> =>
      ipcRenderer.invoke('voice-input:model-selection:set', patch),
    reloadModelSelection: (): Promise<VoiceInputModelSelectionResultWire> =>
      ipcRenderer.invoke('voice-input:model-selection:reload'),
    openSettings: (tab: 'voice-input' | 'providers'): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:open-settings', tab),
    start: (params?: {
      sourceLanguage?: string;
      refinementEnabled?: boolean;
      refinementCacheScope?: string;
      refinementContext?: {
        uiLanguage?: string;
        sourceLanguage?: string;
        userRefinementInstructions?: string;
        userDictionary?: string;
        voiceInputHistory?: string;
        selectionBefore?: string;
        selectedText?: string;
        selectionAfter?: string;
        replyToMessage?: string;
      };
    }): Promise<{ ok: true; runId: string } | { ok: false; error: string; authErrorReason?: string }> =>
      ipcRenderer.invoke('voice-input:start', params),
    appendAudio: (chunk: { pcm16k: ArrayBuffer; trace?: unknown }): void =>
      ipcRenderer.send('voice-input:audio', chunk),
    drainAudioQueue: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:audio-drain'),
    stop: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('voice-input:stop'),
    cancel: (params?: { runId?: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:cancel', params),
    onEvent: fanOutVoiceInputEvent,
    getDataSnapshot: (): unknown => ipcRenderer.sendSync('voice-input:data:get'),
    migrateLegacyRendererData: (payload: { settingsRaw?: string | null; historyRaw?: string | null }): unknown => {
      const result = ipcRenderer.sendSync('voice-input:data:migrate-legacy', payload);
      throwVoiceInputSyncError(result);
      return result;
    },
    updateSettings: (patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('voice-input:settings:update', patch),
    updateShortcutSetting: (shortcut: VoiceInputShortcutWire | null): Promise<VoiceInputSettingsUpdateResult> =>
      ipcRenderer.invoke('voice-input:settings:update-shortcut', shortcut),
    deleteDictionaryEntries: (entryIds: string[]): Promise<unknown> =>
      ipcRenderer.invoke('voice-input:dictionary:delete-entries', entryIds),
    recordDictionaryLearningActions: (actions: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke('voice-input:dictionary-learning:record-actions', actions),
    getHistory: (limit?: number): unknown => {
      const result = ipcRenderer.sendSync('voice-input:history:get', limit);
      throwVoiceInputSyncError(result);
      return result;
    },
    getHistoryForRefinement: (): unknown => {
      const result = ipcRenderer.sendSync('voice-input:history:get-for-refinement');
      throwVoiceInputSyncError(result);
      return result;
    },
    recordHistory: (text: string): string | null => {
      const result = ipcRenderer.sendSync('voice-input:history:record', text);
      throwVoiceInputSyncError(result);
      return result as string | null;
    },
    updateHistoryEntry: (id: string, text: string): void => {
      const result = ipcRenderer.sendSync('voice-input:history:update', { id, text });
      throwVoiceInputSyncError(result);
    },
    deleteHistoryEntry: (id: string): void => {
      const result = ipcRenderer.sendSync('voice-input:history:delete', id);
      throwVoiceInputSyncError(result);
    },
    onDataChanged: fanOutVoiceInputDataChanged,
    setGlobalShortcut: (shortcut: VoiceInputShortcutWire | null): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:global-shortcut:set', shortcut),
    startModifierShortcutRecording: (): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:modifier-shortcut-recording:start'),
    stopModifierShortcutRecording: (): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:modifier-shortcut-recording:stop'),
    onModifierShortcutKeys: fanOutVoiceInputModifierShortcutKeys,
    onGlobalShortcutTrigger: fanOutVoiceInputGlobalShortcutTrigger,
    claimGlobalShortcutTrigger: (id: string): void =>
      ipcRenderer.send('voice-input:global-shortcut-claim', { id }),
    onGlobalOverlayCommand: fanOutVoiceInputGlobalOverlayCommand,
    adviseDictionaryLearning: (payload: unknown): Promise<unknown> =>
      ipcRenderer.invoke('voice-input:dictionary-learning:advise', payload),
    onDictionaryLearningEvidence: fanOutVoiceInputDictionaryLearningEvidence,
    notifyGlobalOverlayReady: (): void =>
      ipcRenderer.send('voice-input:global-overlay-ready'),
    pasteIntoFocusedTarget: (text: string, rawTranscriptText?: string): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:global-paste', { text, rawTranscriptText }),
    restoreGlobalPasteTargetFocus: (): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:global-restore-target-focus'),
    closeGlobalOverlay: (options?: { preservePasteTarget?: boolean }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:global-overlay-close', options),
    showGlobalOverlay: (): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:global-overlay-show-passive'),
    // 浮窗自定义拖动:renderer 只报告手势相位,坐标由 main 读系统光标位置;
    // send(fire-and-forget)保证 move tick 不阻塞渲染帧。
    beginGlobalOverlayDrag: (): void =>
      ipcRenderer.send('voice-input:global-overlay-drag-start'),
    moveGlobalOverlayDrag: (): void =>
      ipcRenderer.send('voice-input:global-overlay-drag-move'),
    endGlobalOverlayDrag: (): void =>
      ipcRenderer.send('voice-input:global-overlay-drag-end'),
    resetGlobalOverlayPosition: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:global-overlay-position-reset'),
    openAccessibilitySettings: (): Promise<VoiceInputGlobalResult> =>
      ipcRenderer.invoke('voice-input:open-accessibility-settings'),
    showDictionaryToast: (payload: {
      entryId?: string;
      term?: string;
      entries?: Array<{ entryId: string; term: string }>;
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('voice-input:dictionary-toast-show', payload),
    closeDictionaryToast: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('voice-input:dictionary-toast-close'),
  },

  windowBehavior: {
    // 通知 main 落盘"首次点击是否吞掉"。仅落盘,不改变已创建窗口的行为——macOS
    // acceptFirstMouse 是 BrowserWindow 构造参数,需要下次启动才读到新值。Windows
    // 上此调用只是保持 userData 落盘和 renderer localStorage 一致,Windows JS
    // swallow 的即时开关由 renderer 本地读 localStorage 完成。
    setSwallowActivationClick: (enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke(WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL, enabled),
    getWindowsCloseBehavior: (): Promise<WindowsCloseBehavior | null> =>
      ipcRenderer.invoke(WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL),
    setWindowsCloseBehavior: (
      behavior: WindowsCloseBehavior,
    ): Promise<WindowsCloseBehavior> =>
      ipcRenderer.invoke(WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL, behavior),
    onWindowsCloseBehaviorRequested: (callback: () => void): (() => void) => {
      const listener = (): void => callback();
      ipcRenderer.on(WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL, listener);
      return () => ipcRenderer.removeListener(
        WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL,
        listener,
      );
    },
    notifyWindowsCloseBehaviorPromptShown: (): void =>
      ipcRenderer.send(WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL),
  },

  // ── 右侧栏独立子窗口(RSB window)──────────────────────────────────────
  // 「侧边栏在新窗口中显示」偏好 + 子窗口生命周期。状态机在 main
  // (right-sidebar-window/controller.ts),renderer 只 invoke + 订阅广播。
  rightSidebarWindow: {
    getState: (): Promise<{ detached: boolean; lastOpen: boolean; open: boolean }> =>
      ipcRenderer.invoke('maker:rsb-window:get-state'),
    /** 幂等:已开则 show + focus。 */
    open: (): Promise<void> => ipcRenderer.invoke('maker:rsb-window:open'),
    close: (): Promise<void> => ipcRenderer.invoke('maker:rsb-window:close'),
    /** 写偏好;true 附带开窗,false 附带关窗。返回新 state。 */
    setDetached: (
      detached: boolean,
    ): Promise<{ detached: boolean; lastOpen: boolean; open: boolean }> =>
      ipcRenderer.invoke('maker:rsb-window:set-detached', detached),
    /** 子窗口 mount 时拉主窗上报的渲染上下文(main 缓存的最后一份)。 */
    getContext: (): Promise<{
      sessionId: string | null;
      workdir: string | null;
      remoteHostId: string | null;
      available: boolean;
    } | null> => ipcRenderer.invoke('maker:rsb-window:get-context'),
    /** 子窗口根组件挂载握手(main 侧 ensureOpen 等它)。 */
    ready: (): Promise<void> => ipcRenderer.invoke('maker:rsb-window:ready'),
    /** 主窗请求 main 原子裁决命令宿主；必要时 main 开窗、排队或取消 stale intent。 */
    sendCommand: (request: RsbWindowCommandRouteRequest): Promise<RsbWindowCommandRouteResult> =>
      ipcRenderer.invoke('maker:rsb-window:send-command', request),
    /** 主窗上报侧边栏渲染上下文。fire-and-forget,main 只信主窗 sender。 */
    setContext: (ctx: {
      sessionId: string | null;
      workdir: string | null;
      remoteHostId: string | null;
      available: boolean;
    }): void => ipcRenderer.send('maker:rsb-window:set-context', ctx),
    onStateChanged: fanOutRsbWindowStateChanged,
    onContextChanged: fanOutRsbWindowContextChanged,
    onCommand: fanOutRsbWindowCommand,
  },

  agentIsland: {
    setVisibleSession: (sessionId: string | string[] | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL, sessionId),
    setEnabled: (enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke(AGENT_ISLAND_SET_ENABLED_CHANNEL, enabled),
    setSoundSettings: (settings: AgentIslandSoundSettings): Promise<{ ok: true }> =>
      ipcRenderer.invoke(AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL, settings),
    setMascotSkin: (skin: AgentIslandMascotSkin): Promise<{ ok: true }> =>
      ipcRenderer.invoke(AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL, skin),
    setDisplayTarget: (target: AgentIslandDisplayTarget): Promise<{ ok: true }> =>
      ipcRenderer.invoke(AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL, target),
    getDisplayOptions: (): Promise<{
      ok: true;
      options: AgentIslandDisplayOption[];
      target?: AgentIslandDisplayTarget;
    }> =>
      ipcRenderer.invoke(AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL),
    previewSound: (sound: AgentIslandSoundChoice): Promise<{ ok: true }> =>
      ipcRenderer.invoke(AGENT_ISLAND_PREVIEW_SOUND_CHANNEL, sound),
    selectSoundFile: (): Promise<{ ok: true; path: string | null; name: string | null }> =>
      ipcRenderer.invoke(AGENT_ISLAND_SELECT_SOUND_FILE_CHANNEL),
    /** 订阅 per-session 活动快照(侧栏卡片用)。返回取消订阅。 */
    onSessionActivity: (cb: (list: AgentIslandSessionActivity[]) => void): (() => void) => {
      const handler = (_e: unknown, list: AgentIslandSessionActivity[]) => cb(list);
      ipcRenderer.on(AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL, handler);
      return () => ipcRenderer.removeListener(AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL, handler);
    },
  },

  // ── Find in Page (F-FIP-1) ──
  findInPage: (params: {
    text: string;
    forward?: boolean;
    findNext?: boolean;
    matchCase?: boolean;
  }): Promise<number | null> => ipcRenderer.invoke('find-in-page:start', params),
  stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection') =>
    ipcRenderer.send('find-in-page:stop', action),
  onFindInPageResult: fanOutFindInPageResult,
  onSelectionContextMenuAddToChat: fanOutSelectionContextMenuAddToChat,

  // CC 网络调试日志开关 (Settings → Experimental → CC 网络调试日志)
  // main 端 mutate process.env.XDT_CC_DEBUG_NET, buildClaudeEnv 在 spawn cc 时
  // 注入 ANTHROPIC_LOG=info + NODE_DEBUG=http,https,net,tls。仅对开关后新建的
  // session 生效, 进程重启回 off。
  ccSetDebugNet: (enabled: boolean): Promise<{ ok: true }> =>
    ipcRenderer.invoke('cc:set-debug-net', enabled),

  // safeStorage
  safeStorageStore: (key: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('safe-storage-store', key, value),
  safeStorageRead: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('safe-storage-read', key),
  safeStorageRemove: (key: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('safe-storage-remove', key),

  // ── 网关凭据自动下发(model-access,shared/modelAccess.ts) ──
  modelAccess: {
    getStatus: (): Promise<ModelAccessStatusPayload> =>
      ipcRenderer.invoke('model-access:get-status'),
    retry: (): Promise<ModelAccessStatusPayload> => ipcRenderer.invoke('model-access:retry'),
    rotate: (): Promise<ModelAccessStatusPayload> => ipcRenderer.invoke('model-access:rotate'),
    onStatusChange: (callback: (status: ModelAccessStatusPayload) => void): (() => void) => {
      const listener = (_e: unknown, status: ModelAccessStatusPayload) => callback(status);
      ipcRenderer.on(MODEL_ACCESS_STATUS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(MODEL_ACCESS_STATUS_CHANNEL, listener);
    },
  },

  // ── Auth (delegated to main process authManager) ──
  /** 首启亮色门会话线索:主进程是否持有存量会话(持久化 refresh token / local
   * 模式)。sendSync——renderer bootstrap 在首帧前判定「真首启」用,异步赶不上。 */
  authHasPersistedSessionHintSync: (): boolean =>
    ipcRenderer.sendSync('auth:has-persisted-session-hint-sync') === true,
  authInitialize: (): Promise<{
    user: unknown;
    mode: 'signed-out' | 'local' | 'cloud';
    dataOwnerId: string | null;
    canEnterApp: boolean;
    isAuthenticated: boolean;
    isCanary: boolean;
    deviceId: string;
    hasAccountDeletionReceipt: boolean;
    accountDeletionRestored: boolean;
  }> =>
    ipcRenderer.invoke('auth:initialize'),
  authGetLoginState: (): Promise<DesktopLoginActionResult> =>
    ipcRenderer.invoke('auth:get-login-state'),
  authDispatchLoginAction: (action: DesktopLoginAction): Promise<DesktopLoginActionResult> =>
    ipcRenderer.invoke('auth:dispatch-login-action', action),
  authLogout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  authEnterLocal: () => ipcRenderer.invoke('auth:enter-local'),
  authExitLocal: () => ipcRenderer.invoke('auth:exit-local'),
  authRefresh: (): Promise<boolean> => ipcRenderer.invoke('auth:refresh'),
  authGetAccountDeletionAvailability: (): Promise<DesktopAccountDeletionAvailabilityResult> =>
    ipcRenderer.invoke('auth:account-deletion:get-availability'),
  authRequestAccountDeletionChallenge: (): Promise<DesktopAccountDeletionChallengeResult> =>
    ipcRenderer.invoke('auth:account-deletion:request-challenge'),
  authConfirmAccountDeletion: (
    input: DesktopAccountDeletionConfirmInput,
  ): Promise<DesktopAccountDeletionConfirmResult> =>
    ipcRenderer.invoke('auth:account-deletion:confirm', input),
  authGetAccountDeletionStatus: (): Promise<DesktopAccountDeletionStatusResult> =>
    ipcRenderer.invoke('auth:account-deletion:get-status'),
  authClearAccountDeletionReceipt: (): Promise<void> =>
    ipcRenderer.invoke('auth:account-deletion:clear-receipt'),
  authConsumeAccountDeletionRestoredNotice: (): Promise<boolean> =>
    ipcRenderer.invoke('auth:account-deletion:consume-restored-notice'),

  // ── Profile 编辑(设置 → 用户卡片编辑名字 / 头像;直写服务端,跨设备生效) ──
  profileGetState: (): Promise<{
    name: string;
    avatarUrl: string | null;
  }> => ipcRenderer.invoke('profile:get-state'),
  profileChooseAvatar: (): Promise<{
    canceled: boolean;
    filePath?: string;
    previewDataUrl?: string;
  }> => ipcRenderer.invoke('profile:choose-avatar'),
  profileUpdate: (params: {
    name: string | null;
    avatar: { type: 'keep' } | { type: 'set'; filePath: string } | { type: 'reset' };
  }): Promise<{ ok: true }> => ipcRenderer.invoke('profile:update', params),
  onAuthStateChange: fanOutAuthStateChange,
  onAuthSessionExpired: fanOutAuthSessionExpired,
  onTapdbDailyActive: (callback: (payload: { date: string }) => void): (() => void) =>
    fanOutTapdbDailyActive((payload) => {
      if (
        payload &&
        typeof payload === 'object' &&
        typeof (payload as { date?: unknown }).date === 'string'
      ) {
        callback(payload as { date: string });
      }
    }),

  // Slack 官方 MCP(slackOfficial)已于 2026-07-15 退役(能力迁入内置意识 cindy-slack);
  // GitHub / GitLab PAT bridge 已于 2026-07-14 退役(GitHub 能力迁入内置意识
  // cindy-github,GitLab 能力迁入内置意识 cindy-gitlab)

  // ── FeiShu Bot (Settings → FeiShu Bot tab) ──
  // 完全独立的飞书机器人模块；与 google OAuth 不同，这里用的是用户自建的飞书 App
  // 通过 WebSocket 长连接订阅个人消息，实现飞书 ↔ 本机 Claude Agent 直连。
  feishuBot: {
    getState: (): Promise<{
      status: 'idle' | 'testing' | 'connected' | 'reconnecting' | 'conflict' | 'error';
      appId: string | null;
      appSecret: string | null;
      hasSecret: boolean;
      ownerOpenId: string | null;
      error?: string;
      lifecycleAnnouncement: boolean;
    }> => ipcRenderer.invoke('feishuBot:get-state'),
    save: (payload: { appId: string; appSecret: string }): Promise<{
      verdict: 'connected' | 'conflict' | 'error' | 'pending';
    }> => ipcRenderer.invoke('feishuBot:save', payload),
    reconnect: (): Promise<{ verdict: 'connected' | 'conflict' | 'error' }> =>
      ipcRenderer.invoke('feishuBot:reconnect'),
    clear: (): Promise<{ ok: true }> => ipcRenderer.invoke('feishuBot:clear'),
    setLifecycleAnnouncement: (enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('feishuBot:set-lifecycle-announcement', { enabled }),
    registrationBegin: (): Promise<{
      ok: boolean;
      deviceCode?: string;
      userCode?: string;
      verificationUrl?: string;
      expiresIn?: number;
      interval?: number;
      error?: string;
    }> => ipcRenderer.invoke('feishuBot:registration-begin'),
    registrationCancel: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('feishuBot:registration-cancel'),
    onStatusChange: fanOutFeishuBotStatusChange,
    onConflict: fanOutFeishuBotConflict,
    onRegistrationStatus: fanOutFeishuBotRegistrationStatus,
  },

  // ── Discord Bot (Settings → IM Bot tab) ──
  // 用户本机自建 Discord App + Bot Token;凭证保存在本机 secrets。
  discordBot: {
    getStatus: (): Promise<{
      status:
        | { kind: 'idle' }
        | { kind: 'connecting' }
        | { kind: 'connected'; appId: string }
        | { kind: 'conflict'; appId: string }
        | { kind: 'error'; reason: string };
      ownerUserId: string | null;
    }> => ipcRenderer.invoke('discordBot:get-status'),
    setConfig: (payload: { token: string; ownerUserId: string }): Promise<{
      status:
        | { kind: 'idle' }
        | { kind: 'connecting' }
        | { kind: 'connected'; appId: string }
        | { kind: 'conflict'; appId: string }
        | { kind: 'error'; reason: string };
      saveErrorStatus?:
        | { kind: 'idle' }
        | { kind: 'connecting' }
        | { kind: 'connected'; appId: string }
        | { kind: 'conflict'; appId: string }
        | { kind: 'error'; reason: string };
      ownerUserId: string | null;
    }> => ipcRenderer.invoke('discordBot:set-config', payload),
    disconnect: (): Promise<{
      status:
        | { kind: 'idle' }
        | { kind: 'connecting' }
        | { kind: 'connected'; appId: string }
        | { kind: 'conflict'; appId: string }
        | { kind: 'error'; reason: string };
    }> => ipcRenderer.invoke('discordBot:disconnect'),
    checkSessionAuth: (): Promise<DiscordBotSessionAuthCheckWire> =>
      ipcRenderer.invoke('discordBot:check-session-auth'),
    onStatusChange: fanOutDiscordBotStatusChange,
  },

  // Renderer → main 的 "用户已登录 + localDb 已就绪" 信号。LocalDbGate 在
  // ensureReady 成功之后 fire-and-forget 调一次。main 收到后才启动 FeishuBot
  // 的 WS 长连接 —— 在此之前 bot 不上线,避免"bot 已上线但 db/auth 未就绪,
  // 用户回消息撞 localDb not ready" 的 race。幂等,多次调用无副作用。
  appReadyForBot: (): Promise<{ ok: true }> =>
    ipcRenderer.invoke('app:ready-for-bot'),

  // ── IM Binding (feishu /ctr 接管 → desktop session 路由) ──
  // 整体接管态由 main/im/binding.ts 维护; renderer 用这套 API 实时知道
  // 某个 sessionId 是否被某 IM 用户接管 (用来渲染 mask + 收回按钮)。
  /** renderer 启动/cc prefs 变化时推送当前 cc vendor 偏好给 main，供接管新建 session 时使用 */
  syncDesktopCcPrefs: (prefs: {
    model: string;
    effort: string;
    permissionMode: string;
    fastMode: boolean;
  }): void => ipcRenderer.send('desktop:cc-prefs-changed', prefs),

  /**
   * renderer 把 newMakerDraft 的 vendor/model 偏好快照推给 main 缓存 ——
   * collab mode spawn worker (enableOrca / orca-bridge.create_worker) 读这份
   * 缓存决定 worker 的 model/effort/fastMode, 让 worker 默认 = "用户在 New Maker
   * 面板该 vendor 当前的选择"。启动时推一次 + 用户每次改 New Maker 偏好都推,
   * fire-and-forget。
   */
  syncNewMakerDraft: (snapshot: {
    lastByVendor: Partial<
      Record<
        'cc' | 'codex',
        { model?: string; effort?: string; permissionMode?: string; providerId?: string | null }
      >
    >;
    fastModeByModel: Record<string, boolean>;
    effortByModel: Record<string, string>;
  }): void => ipcRenderer.send('maker:sync-new-maker-draft', snapshot),

  /**
   * 被控端 renderer → 自身 main:providerModelMemory 全量快照镜像。device-link 草稿列表行的真实
   * 读源(非选中模型),控制端据此完整镜像被控端草稿模型列表。启动推一次 + 变化增量推。
   */
  syncProviderModelMemory: (snapshot: Record<
    string,
    { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
  >): void => ipcRenderer.send('maker:sync-provider-model-memory', snapshot),

  /**
   * 被控端 renderer → 自身 main:会话「非选中模型」effort/fast 在本端变化时镜像给 main,
   * main 据此转发给订阅了 session:<id> 的控制端(无控制者订阅时近似 no-op)。fire-and-forget。
   */
  syncSessionModelPref: (pref: {
    sessionId: string;
    agent: 'claude-code' | 'codex';
    providerId: string;
    model: string;
    effort?: string;
    fast?: boolean;
  }): void => ipcRenderer.send('maker:sync-session-model-pref', pref),

  /**
   * 被控端本地 main → 自身 renderer:控制端写穿的草稿 / 会话「模型 effort/fast」pref,
   * renderer 收到后调它原来的本地 setter 写真实草稿 / 会话记忆。仅被控端进程消费。
   */
  onMakerDraftPrefApply: fanOutMakerDraftPrefApply,
  onMakerSessionPrefApply: fanOutMakerSessionPrefApply,

  binding: {
    /** 查指定 sessionId 当前是否被任何 IM 接管。命中带 displayName (channel
     *  上下文里取的姓名, e.g. 飞书姓名), 失败 null, mask 用 fallback 文案。 */
    resolveSession: (sessionId: string): Promise<{
      attached: boolean;
      identity?: { channel: string; botContextId: string; userId: string } | null;
      displayName?: string | null;
    }> => ipcRenderer.invoke('binding:resolve-session', sessionId),
    /** desktop UI 收回按钮: 触发 detach + 通知对应 IM 用户 */
    revoke: (sessionId: string): Promise<{
      ok: true;
      alreadyDetached?: boolean;
    }> => ipcRenderer.invoke('binding:revoke', sessionId),
    /** 一次性拿当前所有被接管的 sessionId — sidebar mount 时拉一次, 之后
     *  跟 onChanged 增量。 */
    listAttached: (): Promise<{ sessionIds: string[] }> =>
      ipcRenderer.invoke('binding:list-attached'),
    /** 订阅 binding 变更广播 — main 端 attach/detach 后推一次 */
    onChanged: createIpcFanOut('binding:changed'),
  },

  // Environment
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  onBinaryDownloadProgress: fanOutBinaryDownloadProgress,

  // App update (hot-update) — startup check + progress + status query
  // `error` distinguishes the two failure modes so the renderer can show the
  // right dialog: 'manifest_failed' = couldn't fetch the version manifest,
  // 'download_failed' = manifest said there is an update but we couldn't pull
  // (or verify) the file after MAX_RETRIES. Both keep the user in splash.
  checkAppUpdate: (): Promise<{
    hasUpdate: boolean;
    action?: 'relaunch' | 'none';
    version?: string;
    error?: 'manifest_failed' | 'download_failed';
  }> =>
    ipcRenderer.invoke('update-check-startup'),
  getUpdateStatus: (): Promise<{ status: string; version?: string; errorCode?: string }> =>
    ipcRenderer.invoke('update-get-status'),
  getAutoUpdateSettings: (): Promise<{
    autoRelaunchOnIdle: boolean;
    isCustomized?: boolean;
    defaultAutoRelaunchOnIdle?: boolean;
  }> => ipcRenderer.invoke('update-auto-settings-get'),
  setAutoUpdateSettings: (settings: {
    autoRelaunchOnIdle: boolean;
  }): Promise<{
    autoRelaunchOnIdle: boolean;
    isCustomized?: boolean;
    defaultAutoRelaunchOnIdle?: boolean;
  }> => ipcRenderer.invoke('update-auto-settings-set', settings),
  resetAutoUpdateSettings: (): Promise<{
    autoRelaunchOnIdle: boolean;
    isCustomized?: boolean;
    defaultAutoRelaunchOnIdle?: boolean;
  }> => ipcRenderer.invoke('update-auto-settings-reset'),
  setUpdateRelaunchTheme: (theme: 'light' | 'dark'): void => {
    ipcRenderer.send('update-set-relaunch-theme', theme);
  },

  // E4D 毛玻璃:family 切换/启动时通知 main 开关 macOS vibrancy(仅 CINDY 透壁纸)
  theme: {
    applyVibrancy: (familyId: string, isDark: boolean): void => {
      ipcRenderer.send('theme:apply-vibrancy', { familyId, isDark });
    },
  },
  onAppUpdateProgress: fanOutAppUpdateProgress,

  // apiRequest(renderer → main → 主 server 通用代理)与 imageUpload.putToOss
  // (presign 直传桥)已随 2026-07 apiBaseUrl 清理退役:renderer 对业务 server
  // 零请求;头像等上传走 main 侧 profileEdit 链路。
  billing: {
    getBalance: () => ipcRenderer.invoke(BILLING_INVOKE.GET_BALANCE),
    getCreditUsage: () => ipcRenderer.invoke(BILLING_INVOKE.GET_CREDIT_USAGE),
    getCatalog: () => ipcRenderer.invoke(BILLING_INVOKE.GET_CATALOG),
    listOrders: (payload) => ipcRenderer.invoke(BILLING_INVOKE.LIST_ORDERS, payload),
    getOrder: (payload) => ipcRenderer.invoke(BILLING_INVOKE.GET_ORDER, payload),
    createTopup: (payload) => ipcRenderer.invoke(BILLING_INVOKE.CREATE_TOPUP, payload),
    refreshTopup: (payload) => ipcRenderer.invoke(BILLING_INVOKE.REFRESH_TOPUP, payload),
    cancelTopup: (payload) => ipcRenderer.invoke(BILLING_INVOKE.CANCEL_TOPUP, payload),
    retryTopup: (payload) => ipcRenderer.invoke(BILLING_INVOKE.RETRY_TOPUP, payload),
    createSubscription: (payload) =>
      ipcRenderer.invoke(BILLING_INVOKE.CREATE_SUBSCRIPTION, payload),
    getCurrentSubscription: () => ipcRenderer.invoke(BILLING_INVOKE.GET_CURRENT_SUBSCRIPTION),
    refreshSubscriptionPurchase: (payload) =>
      ipcRenderer.invoke(BILLING_INVOKE.REFRESH_SUBSCRIPTION_PURCHASE, payload),
    quotePlanChange: (payload) => ipcRenderer.invoke(BILLING_INVOKE.QUOTE_PLAN_CHANGE, payload),
    confirmPlanChange: (payload) =>
      ipcRenderer.invoke(BILLING_INVOKE.CONFIRM_PLAN_CHANGE, payload),
    refreshPlanChange: (payload) =>
      ipcRenderer.invoke(BILLING_INVOKE.REFRESH_PLAN_CHANGE, payload),
    cancelPlanChange: (payload) => ipcRenderer.invoke(BILLING_INVOKE.CANCEL_PLAN_CHANGE, payload),
    openPaymentRedirect: (payload) =>
      ipcRenderer.invoke(BILLING_INVOKE.OPEN_PAYMENT_REDIRECT, payload),
  } satisfies BillingRendererApi,

  // ── Workdir File Browser (vscode-style file tree + content viewer) ──
  // All paths in/out are workdir-relative POSIX. Main side blocks traversal.
  // listDir is per-folder (lazy expansion); chokidar push events drive
  // incremental tree updates while user is in the browse view.
  fileBrowser: {
    listDir: (params: {
      /** 非空 = SSH remote 会话,操作经远端 file-service 执行(main 侧路由)。 */
      remoteHostId?: string | null;
      workdir: string;
      relPath?: string;
      hideMetaFiles?: boolean;
      docMode?: boolean;
    }): Promise<Array<{
      name: string;
      relPath: string;
      type: 'file' | 'directory';
      size: number;
      mtimeMs: number;
    }>> => ipcRenderer.invoke('maker:file-browser:list-dir', params),
    /** 项目级文件名扁平列表(ripgrep --files honor .gitignore);供 RSB 快速文件
     *  筛选用。失败返回空数组 + `error`,renderer fallback 渲染"项目空"占位。 */
    listAllFiles: (params: { remoteHostId?: string | null; workdir: string; cap?: number }): Promise<{
      files: string[];
      truncated: boolean;
      elapsedMs: number;
      error?: string;
    }> => ipcRenderer.invoke('maker:file-browser:list-all', params),
    readFile: (params: { remoteHostId?: string | null; workdir: string; relPath: string }): Promise<
      | { ok: true; data: { relPath: string; content: string; size: number; mtimeMs: number; truncated: boolean } }
      | { ok: false; code: 'BINARY_FILE' | 'READ_FAILED'; message?: string }
      /** OVERSIZE = 远程文本超传输上限(device-link 帧限预判),stat 供"文件过大"占位卡。 */
      | { ok: false; code: 'OVERSIZE'; stat: { relPath: string; type: 'file'; size: number; mtimeMs: number } }
    > => ipcRenderer.invoke('maker:file-browser:read-file', params),
    writeFile: (params: { remoteHostId?: string | null; workdir: string; relPath: string; content: string }): Promise<
      | { ok: true; size: number; mtimeMs: number }
      | { ok: false; message: string }
    > => ipcRenderer.invoke('maker:file-browser:write-file', params),
    createFile: (params: { remoteHostId?: string | null; workdir: string; relPath: string }): Promise<
      | { ok: true; stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number } }
      | { ok: false; message: string }
    > => ipcRenderer.invoke('maker:file-browser:create-file', params),
    createFolder: (params: { remoteHostId?: string | null; workdir: string; relPath: string }): Promise<
      | { ok: true; stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number } }
      | { ok: false; message: string }
    > => ipcRenderer.invoke('maker:file-browser:create-folder', params),
    deleteEntry: (params: { remoteHostId?: string | null; workdir: string; relPath: string }): Promise<
      | { ok: true }
      | { ok: false; message: string }
    > => ipcRenderer.invoke('maker:file-browser:delete-entry', params),
    renameEntry: (params: { remoteHostId?: string | null; workdir: string; fromRel: string; toRel: string }): Promise<
      | { ok: true; stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number } }
      | { ok: false; message: string }
    > => ipcRenderer.invoke('maker:file-browser:rename-entry', params),
    stat: (params: { remoteHostId?: string | null; workdir: string; relPath: string }): Promise<{
      relPath: string;
      type: 'file' | 'directory';
      size: number;
      mtimeMs: number;
    }> => ipcRenderer.invoke('maker:file-browser:stat', params),
    startWatch: (params: { remoteHostId?: string | null; workdir: string; hideMetaFiles?: boolean }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('maker:file-browser:start-watch', params),
    stopWatch: (params: { remoteHostId?: string | null; workdir: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('maker:file-browser:stop-watch', params),
    onEvent: (
      cb: (event: {
        workdir: string;
        type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
        relPath: string;
      }) => void,
    ): (() => void) => fanOutFileBrowserEvent(cb as IpcCallback),
    /** 大文件取回:>2MiB inline 上限的远程文件拉到本地缓存,返回缓存绝对路径。 */
    fetchRemote: (params: {
      workdir: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      remoteHostId?: string | null;
      deviceId?: string | null;
    }): Promise<{ ok: true; cachePath: string; stale: boolean } | { ok: false; message: string }> =>
      ipcRenderer.invoke('maker:file-browser:fetch-remote', params),
    /** 读缓存副本内容(cached 态文本预览;32MB 显示上限,二进制回 kind:'binary')。 */
    readCached: (params: { cachePath: string }): Promise<
      | { ok: true; kind: 'text'; content: string; truncated: boolean }
      | { ok: true; kind: 'binary' }
      | { ok: false; message: string }
    > => ipcRenderer.invoke('maker:file-browser:read-cached', params),
    /** 远程小文件写穿到磁盘缓存(fire-and-forget,断线兜底用)。 */
    cachePut: (params: {
      workdir: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      content: string;
      remoteHostId?: string | null;
      deviceId?: string | null;
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke('maker:file-browser:cache-put', params),
    /** 大文件取回进度(发起窗口收):{ workdir, relPath, received, total }。 */
    onTransferProgress: (
      cb: (event: { workdir: string; relPath: string; received: number; total: number; phase?: 'upload' | 'download' }) => void,
    ): (() => void) => fanOutFileBrowserTransfer(cb as IpcCallback),
    /**
     * 聊天流文件取回:远端绝对路径 → 本地缓存副本(fetch-到缓存-再操作)。
     * 进度沿用 onTransferProgress,relPath 键 = 原始 absPath。失败按 code 分流:
     * OUTSIDE_WORKDIR(SSH workdir 外,明确占位)/ NOT_FOUND / FETCH_FAILED。
     */
    chatFetch: (params: {
      origin: { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };
      workdir: string;
      absPath: string;
    }): Promise<
      | { ok: true; cachePath: string; stale: boolean; size: number }
      | { ok: false; code: 'BAD_ARGS' | 'OUTSIDE_WORKDIR' | 'NOT_FOUND' | 'FETCH_FAILED'; message?: string }
    > => ipcRenderer.invoke('maker:chat-file:fetch', params),
    /** 聊天流文件 chip 点亮预检:远端精确 stat。file=点亮;nonfile=保持纯文本;unknown=乐观点亮。 */
    chatStat: (params: {
      origin: { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };
      workdir: string;
      absPath: string;
    }): Promise<{ verdict: 'file' | 'directory' | 'nonfile' | 'unknown' }> =>
      ipcRenderer.invoke('maker:chat-file:stat', params),
  },

  // ── Project-wide text search (rg-backed, NDJSON stream) ──
  // start 返回 { ok, searchId }; 后续 match / end / error 事件全部走 onEvent。
  // 同一 window 同时只允许一个 active search (main 端单 active 策略,新 start
  // 会自动 cancel 旧的)。详见 main/file-browser/search/index.ts。
  search: {
    start: (params: {
      /** 非空 = SSH remote 会话,操作经远端 file-service 执行(main 侧路由)。 */
      remoteHostId?: string | null;
      workdir: string;
      query: string;
      caseSensitive: boolean;
      maxMatches: number;
    }): Promise<
      | {
          ok: true;
          searchId: string;
          /** 远程搜索启动窗口内 daemon 秒回的事件(main 先于响应 push 会被
           *  renderer 当 stale 丢弃),随响应带回由 renderer 回放。 */
          replay?: Array<
            | {
                type: 'match';
                searchId: string;
                relPath: string;
                lineNumber: number;
                lineText: string;
                submatches: Array<{ start: number; end: number }>;
              }
            | { type: 'end'; searchId: string; truncated: boolean; totalMatches: number; totalFiles: number }
            | { type: 'error'; searchId: string; message: string }
          >;
        }
      /** code = 稳定错误码(如 RG_UNAVAILABLE),renderer 按码映射友好文案。 */
      | { ok: false; message: string; code?: string }
    > =>
      ipcRenderer.invoke('maker:search:start', params),
    cancel: (params: { searchId: string; remoteHostId?: string | null }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:search:cancel', params),
    onEvent: (
      cb: (event:
        | {
            type: 'match';
            searchId: string;
            relPath: string;
            lineNumber: number;
            lineText: string;
            submatches: Array<{ start: number; end: number }>;
          }
        | {
            type: 'end';
            searchId: string;
            truncated: boolean;
            totalMatches: number;
            totalFiles: number;
          }
        | { type: 'error'; searchId: string; message: string }
      ) => void,
    ): (() => void) => fanOutSearchEvent(cb as IpcCallback),
  },

  // API Key test connection

  // Show native directory picker dialog
  showOpenDirectoryDialog: (): Promise<{ canceled: boolean; path?: string }> =>
    ipcRenderer.invoke('show-open-directory-dialog'),

  // ── Command Palette (F1/F2 @mention + / slash) workspace scans ──

  /**
   * Scan workingDir for @-mention candidates: files, directories, and
   * .claude/agents/*.md. Returns up to `cap` items total (agents + files +
   * dirs combined). When truncated, caller should show "keep typing" hint.
   */
  scanAtResources: (params: {
    workingDir: string;
    cap?: number;
    query?: string;
    agentKind?: 'claude-code' | 'codex';
  }): Promise<{
    success: boolean;
    error?: string;
    items?: Array<
      | { type: 'file'; name: string; relPath: string; description?: string }
      | { type: 'dir'; name: string; relPath: string; description?: string }
      | { type: 'agent'; name: string; relPath: string; description?: string }
    >;
    truncated?: boolean;
  }> => ipcRenderer.invoke('maker:scan-at-resources', params.agentKind ?? 'claude-code', params),

  // (老 scanSlashCommands 桥已下线 —— 由 electronAPI.maker.{listAgentSkills,listAgentCommands,
  //  listDesktopCommands,executeDesktopCommand} 取代; 详见下方 maker.* 块。)

  // ── Learn (/learn 蒸馏 —— 系统级"学成 skill"能力) ──
  // 状态流:learn:start 后经 onEvent 订阅 run 状态推进(collecting → distilling →
  // awaiting-review);提案经 getProposalDiff 审查,apply 确认落盘 / discard 放弃。
  learn: {
    start: (
      req: import('../shared/learnTypes').LearnStartRequest,
    ): Promise<{ runId: string }> => ipcRenderer.invoke('learn:start', req),

    listRuns: (): Promise<{ runs: import('../shared/learnTypes').LearnRunPublic[]; ready: boolean }> =>
      ipcRenderer.invoke('learn:list-runs'),

    getProposalDiff: (params: { runId: string }): Promise<import('../shared/learnTypes').LearnProposalDiff> =>
      ipcRenderer.invoke('learn:get-proposal-diff', params),

    apply: (params: { runId: string }): Promise<{ name: string; absolutePath: string; replacedBackupPath?: string }> =>
      ipcRenderer.invoke('learn:apply', params),


    discard: (params: { runId: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('learn:discard', params),

    cancel: (params: { runId: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('learn:cancel', params),

    onEvent: (
      callback: (payload: import('../shared/learnTypes').LearnEventPayload) => void,
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/learnTypes').LearnEventPayload): void =>
        callback(payload);
      ipcRenderer.on('learn:event', listener);
      return () => ipcRenderer.removeListener('learn:event', listener);
    },
  },

  // ── SkillHub (xdt-maker-技能中心 v0.2) ──
  // 当前视图消费 maker-core 暴露的 Claude Code customization：global 来源是
  // ~/.claude/{skills,commands,agents}，project 来源由调用方传入的 projectRoot 决定。
  // 返回商店层 Skill[] 与兼容用 sources[]；scan 本身只读。
  skillhub: {
    scan: (params: {
      projects?: import('../main/skillhub/scanner').ProjectInput[];
    }): Promise<{
      success: boolean;
      error?: string;
      skills?: import('../main/skillhub/scanner').Skill[];
      sources?: import('../main/skillhub/scanner').SourceReport[];
    }> => ipcRenderer.invoke('skillhub:scan', params),

    readSkill: (params: { mdPath: string }): Promise<{
      success: boolean;
      error?: string;
      content?: string;
    }> => ipcRenderer.invoke('skillhub:read-skill', params),

    // Lazy directory expansion under a skill's folder (FILES panel tree).
    listChildren: (params: { dirPath: string }): Promise<{
      success: boolean;
      error?: string;
      entries?: import('../main/skillhub/scanner').SkillFileEntry[];
    }> => ipcRenderer.invoke('skillhub:list-children', params),

    // Read a sibling file (any text file inside a skill folder) for in-pane
    // preview. Returns raw content; renderer wraps non-md files in a code
    // fence based on their extension.
    readSiblingFile: (params: { filePath: string }): Promise<{
      success: boolean;
      error?: string;
      content?: string;
    }> => ipcRenderer.invoke('skillhub:read-sibling-file', params),

    // v0.2.2: read raw .md (frontmatter intact) for the in-app MD editor.
    // Different from readSkill (which strips frontmatter for view rendering).
    readRaw: (params: { filePath: string }): Promise<{
      success: boolean;
      error?: string;
      content?: string;
    }> => ipcRenderer.invoke('skillhub:read-raw', params),

    // v0.2.2: write a .md back to disk after edit. main enforces path
    // whitelist + atomic write + 1MB cap + file-must-exist.
    writeFile: (params: { filePath: string; content: string }): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:write-file', params),

    // 解析并校验 .md frontmatter,返回 issues 列表(空数组=通过)。
    // 解析失败时返回 success:true + issues:[] —— 编辑器目的是让用户改,不阻断保存。
    validateFrontmatter: (params: {
      content: string;
      kind: 'skill' | 'command' | 'agent' | 'sibling';
    }): Promise<
      | { success: true; issues: { field: string; message: string }[] }
      | { success: false; error: string }
    > => ipcRenderer.invoke('skillhub:validate-frontmatter', params),

    // 改名整个 skill (目录名 + SKILL.md frontmatter `name`)。
    // 用于"市场撞名,本地需改名再发布"流程。失败时盘上已回滚。
    renameLocal: (params: { absolutePath: string; newName: string }): Promise<
      | { success: true; newAbsolutePath: string }
      | { success: false; error: string }
    > => ipcRenderer.invoke('skillhub:rename-local', params),

    // ── SkillHub v0.2.1: 发布链路 ──────────────────────────────────────────

    // 批量同步 skill 市场状态
    sync: (params: string[] | {
      slugs?: string[];
    }): Promise<{
      success: boolean;
      results?: unknown[];
      availableUninstalledCount?: number;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:sync', Array.isArray(params) ? { slugs: params } : params),

    // Market 浏览列表 — 分页 + 排序 + 搜索 + mine 过滤。
    // available 保留兼容旧调用；renderer 当前按本地扫描结果自行过滤。
    listMarket: (params?: {
      cursor?: string;
      limit?: number;
      sort?: 'trending' | 'downloads' | 'updated_at' | 'created_at';
      q?: string;
      mine?: boolean;
      available?: boolean;
      category?: string;
      /** Legacy: Hub-side available filtering input. Current renderer does not use it. */
      installedSkills?: Array<{ slug: string; version: string }>;
    }): Promise<{
      success: boolean;
      items?: Array<{
        name: string;
        displayName: string;
        description: string;
        authorId: string;
        authorName: string;
        authorAvatarUrl: string | null;
        isMine: boolean;
        latestVersion: string;
        visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
        publishedVisibility?: 'private' | 'shared' | 'public';
        ownerType?: string;
        moderationStatus?: string;
        marketVersion?: string;
        pendingVersion?: {
          version: string;
          status?: string;
        };
        visibleDeptIds: string[];
        categories?: string[];
        publishedAt: string;
        downloads: number;
        /** 跨设备识别：null = pre-feature 历史版本 */
        latestPublishedFromDeviceId: string | null;
      }>;
      nextCursor?: string | null;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:list-market', params),

    // 查询单个 skill 市场详情（有 in-flight dedupe 在 renderer 侧）
    info: (name: string): Promise<{
      success: boolean;
      info?: unknown;
      deleted?: boolean;
      error?: string;
      errorCode?: string;
    }> => ipcRenderer.invoke('skillhub:info', { name }),

    getPublishedFiles: (params: { name: string; version?: string }): Promise<{
      success: boolean;
      slug?: string;
      version?: string;
      files?: Array<{ path: string; size: number; language: string; truncated: boolean }>;
      error?: string;
      errorCode?: string;
    }> => ipcRenderer.invoke('skillhub:get-published-files', params),

    readPublishedFile: (params: { name: string; path: string; version?: string }): Promise<{
      success: boolean;
      file?: { path: string; size: number; language: string; truncated: boolean; content: string };
      error?: string;
      errorCode?: string;
    }> => ipcRenderer.invoke('skillhub:read-published-file', params),

    listPublishedVersions: (name: string): Promise<{
      success: boolean;
      versions?: unknown[];
      error?: string;
      errorCode?: string;
    }> => ipcRenderer.invoke('skillhub:list-published-versions', { name }),

    updatePublished: (params: {
      name: string;
      fields: {
        displayName?: string;
        summary?: string;
        description?: string;
        categories?: string[];
        visibility?: 'private' | 'shared' | 'public';
        /** 归属统一参数:团队 slug / od- 部门 id;null = 收回到个人 */
        teamSlug?: string | null;
      };
    }): Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }> =>
      ipcRenderer.invoke('skillhub:update-published', params),

    deletePublished: (name: string): Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }> =>
      ipcRenderer.invoke('skillhub:delete-published', { name }),

    unpublishPublished: (name: string): Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }> =>
      ipcRenderer.invoke('skillhub:unpublish-published', { name }),

    setPublishedVisibility: (params: {
      name: string;
      visibility: 'private' | 'shared' | 'public';
      teamSlug?: string;
      visibleSlugs?: string[];
    }): Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }> =>
      ipcRenderer.invoke('skillhub:set-published-visibility', params),

    // 读取已发布 skill 的可见对象(共享团队 + 可见部门),编辑可见范围弹窗回显用
    getPublishedVisibility: (name: string): Promise<{
      success: boolean;
      sharedTeams?: Array<{ id: number; slug: string; name: string }>;
      visibleDepts?: string[];
      error?: string;
      errorCode?: string;
    }> => ipcRenderer.invoke('skillhub:get-published-visibility', { name }),

    // Market 分类列表
    listCategories: (): Promise<{
      success: boolean;
      categories?: import('../shared/skillhubCategory').MarketCategory[];
      totalCount?: number;
      myTotalCount?: number;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:list-categories'),

    // 查询发布后的安全扫描状态
    getScanStatus: (params: { slug: string; version?: string }): Promise<{
      success: boolean;
      status: string;
      gates?: Array<{ name: string; status: string; issues?: unknown[] }>;
      scorecard?: Record<string, unknown>;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:get-scan-status', params),

    // 拉当前用户所属团队列表（PublishDialog 多团队可见选择用）
    listUserTeams: (): Promise<{
      success: boolean;
      teams: Array<{ slug: string; name: string; type: string; source?: string | null; isPersonal?: boolean; myRole?: 'admin' | 'publisher' | 'viewer' }>;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:list-user-teams'),

    // 计算本地 skill 文件夹 hash（30s 缓存在 renderer 侧）
    // manifest 是参与 hash 的文件清单(path + sha256),用于 dirty 排查
    getFolderHash: (absolutePath: string): Promise<{
      success: boolean;
      folderHash?: string;
      manifest?: Array<{ path: string; sha256: string }>;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:get-folder-hash', { absolutePath }),

    // 计算本地 skill 与上次发布快照的文件级 diff
    // hasSnapshot=false 时表示本地没有发布快照(历史 publish 或换机器),UI 显示提示
    getSnapshotDiff: (params: {
      absolutePath: string;
      name: string;
    }): Promise<{
      success: boolean;
      hasSnapshot?: boolean;
      changes?: Array<{
        path: string;
        kind: 'added' | 'removed' | 'modified';
        isBinary: boolean;
        oldContent: string;
        newContent: string;
        oldSize: number;
        newSize: number;
      }>;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:get-snapshot-diff', params),

    // 仅查快照是否存在(轻量 fs.stat) — DetailView 区分"无快照"vs"有快照但 dirty"
    hasSnapshot: (name: string): Promise<{
      success: boolean;
      exists?: boolean;
      error?: string;
    }> => ipcRenderer.invoke('skillhub:has-snapshot', { name }),

    getUsageSummary: (params: { name: string; mdPath?: string }): Promise<
      | { success: true; summary: import('../main/skillhub/usageStore').SkillUsageSummary; refreshing: boolean }
      | { success: false; error: string }
    > => ipcRenderer.invoke('skillhub:get-usage-summary', params),

    onUsageAnalyticsRefreshed: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('skillhub:usage-analytics-refreshed', handler);
      return () => ipcRenderer.removeListener('skillhub:usage-analytics-refreshed', handler);
    },

    getUsageDiagnosisContext: (params: { name: string; mdPath?: string }): Promise<
      | { success: true; context: import('../main/skillhub/usageStore').SkillUsageDiagnosisContext }
      | { success: false; error: string }
    > => ipcRenderer.invoke('skillhub:get-usage-diagnosis-context', params),

    // 拉当前用户所属一级部门（PublishDialog 打开前按需获取）
    getMyDepts: (): Promise<{
      success: boolean;
      ids: string[];
      names: string[];
      error?: string;
    }> => ipcRenderer.invoke('skillhub:get-my-depts'),

    // 发布 skill（触发 main 进程完整编排链路）
    publish: (params: {
      absolutePath: string;
      name: string;
      isFirstPublish: boolean;
      version?: string;
      displayName?: string;
      summary?: string;
      description?: string;
      categoryMode?: 'auto' | 'manual';
      categories?: string[];
      visibility?: 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE';
      visibleSlugs?: string[];
      deptTeamSlug?: string;
      teamSlug?: string;
      changelog?: string;
    }): Promise<{
      success: boolean;
      result?: { name: string; version: string };
      error?: string;
      errorCode?: string;
    }> => ipcRenderer.invoke('skillhub:publish', params),

    // 取消当前发布
    cancelPublish: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('skillhub:cancel-publish'),

    stopScanPoll: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('skillhub:stop-scan-poll'),

    startScanPoll: (params: { slug: string; version: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('skillhub:start-scan-poll', params),

    // 订阅 publish 进度事件（main → renderer fan-out 推送）
    onPublishProgress: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, evt: unknown) => cb(evt);
      ipcRenderer.on('skillhub:publish-progress', handler);
      return () => ipcRenderer.removeListener('skillhub:publish-progress', handler);
    },

    // ── Market install / uninstall / cancel ──────────────────────────────
    // 安装：异步流程，进度通过 onInstallProgress 推。返回值是终态。
    // installPath 不传时默认 ~/.agents/skills/{name}/，并 best-effort 创建 Claude symlink。
    // 同名手写技能冲突时返回 errorCode='CONFLICT_USER_OWNED'，UI 弹确认后
    // 重发 install with force:true 即可覆盖（旧目录会被自动备份到 {name}.bak.{ts}/）。
    install: (params: {
      name: string;
      version?: string;
      force?: boolean;
      /** 完整安装目标路径。不传 → global scope 默认路径。 */
      installPath?: string;
      /** force 覆盖时跳过 .bak.{ts}/ 持久备份,直接 rmrf 旧目录(完整替换)。 */
      skipBackup?: boolean;
    }): Promise<
      | { success: true; name: string; version: string; absolutePath: string }
      | { success: false; errorCode: string; message: string }
    > => ipcRenderer.invoke('skillhub:install', params),

    // 取消正在进行的 install（按 name 索引）
    cancelInstall: (name: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('skillhub:cancel-install', { name }),

    // 卸载（删本地文件夹）—— main 会校验目标必须有 registry 记录
    uninstall: (absolutePath: string): Promise<
      | { success: true }
      | { success: false; errorCode: string; message: string }
    > => ipcRenderer.invoke('skillhub:uninstall', { absolutePath }),

    // 订阅 install 进度事件
    onInstallProgress: (
      cb: (event: {
        phase: 'fetching-info' | 'downloading' | 'verifying' | 'extracting' | 'registering' | 'done' | 'failed';
        name: string;
        version?: string;
        absolutePath?: string;
        errorCode?: string;
        message?: string;
      }) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, evt: unknown) =>
        cb(evt as Parameters<typeof cb>[0]);
      ipcRenderer.on('skillhub:install-progress', handler);
      return () => ipcRenderer.removeListener('skillhub:install-progress', handler);
    },

    // ── SkillHub Registry（v0.6 新增） ────────────────────────────────────────
    registry: {
      /** 按 skillName 读取整个 registry manifest（含所有 install 条目）。 */
      getByName: (params: { name: string }): Promise<{
        success: boolean;
        manifest?: StoredManifest | null;
        error?: string;
      }> => ipcRenderer.invoke('skillhub:registry:get-by-name', params),
    },

    /** 一次性补齐:把 server 权威 authorId 写回本地 registry。
     *  added = 新建 install 条数;flipped = 把已有 authorId 错或为空的覆盖更新数。 */
    reconcileMineRegistry: (
      items: Array<{ name: string; absolutePath: string; version: string; authorId: string; folderHash?: string }>,
    ): Promise<{
      success: boolean;
      added: number;
      flipped: number;
      failures: Array<{ name: string; error: string }>;
    }> => ipcRenderer.invoke('skillhub:reconcile-mine-registry', { items }),
  },

  // ── Dialog（v0.6 新增） ───────────────────────────────────────────────────
  dialog: {
    /** 打开系统目录选择对话框，返回用户选中的目录路径（取消时 path=null）。 */
    showOpenDirectory: (params?: { defaultPath?: string }): Promise<{
      success: boolean;
      path: string | null;
    }> => ipcRenderer.invoke('dialog:show-open-directory', params ?? {}),
    /** 打开系统文件选择对话框，返回用户选中的文件路径（取消时 path=null）。 */
    showOpenFile: (params?: {
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{
      success: boolean;
      path: string | null;
    }> => ipcRenderer.invoke('dialog:show-open-file', params ?? {}),
  },

  // Open URL in system default browser
  openExternal: (url: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('shell:open-external', url),

  // file-chip 右键菜单 "在浏览器中查看": 把本地文件用 file:// 喂给系统
  // 默认浏览器(或 .html/.pdf/.svg 等扩展名的默认 handler)。main 端会再做
  // 一次扩展名白名单校验和 isPathAllowed 安全校验。
  openFileInBrowser: (filePath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:open-file-in-browser', filePath),

  // ── 系统级通知（CC Agent session 状态变更）──
  // kind: 'done' = 真正完成；'error' = 执行失败；'needs-reply' = 等用户回复 ask/permission/plan-review。
  // channels: 选择性走哪些通知通道; 缺省 / 未传 → 兼容旧行为(仅桌面)。
  // mobile = 手机推送(经 device-link relay 下发 APNs;桌面侧无独立开关,防打扰在 main 收口)。
  notificationShowSessionEvent: (payload: {
    sessionId: string;
    title: string;
    kind: 'done' | 'error' | 'needs-reply';
    channels?: { desktop?: boolean; feishu?: boolean; mobile?: boolean };
  }): Promise<void> =>
    ipcRenderer.invoke('notification:show-session-event', payload),
  notificationSetDesktopEnabled: (enabled: boolean): Promise<{ ok: true }> =>
    ipcRenderer.invoke('notification:set-desktop-enabled', enabled),
  notificationMarkSessionAttention: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('notification:mark-session-attention', sessionId),
  // intent:'explicit' = 用户真实看到了内容(报错 banner 聚焦驻留 / 全部标为已读等);
  // 省略或 'passive' = 导航 / 聚焦类被动信号,main 侧对未读 error 免疫(fail-safe 默认)。
  notificationClearSessionAttention: (sessionId: string, intent?: 'explicit' | 'passive'): Promise<void> =>
    ipcRenderer.invoke('notification:clear-session-attention', sessionId, intent),
  // main → renderer 的会话已读广播(含远程控制端发起的清除),payload:{ sessionId, intent }。
  onSessionAttentionCleared: fanOutSessionAttentionCleared,
  onNotificationFocusSession: fanOutNotificationFocusSession,

  // RSB web-browser plugin popup 路由 — main 端 webview-security 推送
  // `{ url, disposition }`,renderer 端 RightSidebarShell 订阅 → addTab。
  onRsbBrowserPopup: (
    callback: (payload: { url: string; disposition: string }) => void,
  ): (() => void) =>
    fanOutRsbBrowserPopup((payload) => {
      if (
        payload &&
        typeof payload === 'object' &&
        typeof (payload as { url?: unknown }).url === 'string'
      ) {
        callback(payload as { url: string; disposition: string });
      }
    }),

  // RSB web-browser plugin:guest webview 内 Cmd/Ctrl+L 命中 → 让 active 的
  // BrowserTabBody 焦点 chrome URL bar。payload 是 null,只用作信号。
  onRsbBrowserFocusUrlBar: (callback: () => void): (() => void) =>
    fanOutRsbBrowserFocusUrlBar(() => callback()),
  // RSB web-browser plugin:guest webview 内浏览器级快捷键(导航 + ⌘W 关 tab)。
  onRsbBrowserCommand: (
    callback: (payload: {
      command: 'go-back' | 'go-forward' | 'reload' | 'close-tab' | 'right-tab-prev' | 'right-tab-next';
    }) => void,
  ): (() => void) =>
    fanOutRsbBrowserCommand((payload) => {
      const command = (payload as { command?: unknown } | null)?.command;
      if (
        command === 'go-back' ||
        command === 'go-forward' ||
        command === 'reload' ||
        command === 'close-tab' ||
        command === 'right-tab-prev' ||
        command === 'right-tab-next'
      ) {
        callback({ command });
      }
    }),

  // cindy://(+ 历史 xdt-maker://)deep link / --open-folder 推送 — main 端解析后通过此 channel 通知 renderer。
  // payload 形态在 vite-env.d.ts 上声明:
  //   - { type: 'session', id, messageClientId? } : 跳路由到指定 session(可带消息锚点)
  //   - { type: 'project', workingDir }    : 聚焦已有 project 节点
  //   - { type: 'new-session', workingDir }: 新建对话且预填 workingDir (右键 "通过 XDMaker 打开")
  //   - { type: 'share-import', filePath } : 打开 .cshare/.xdtshare 会话导入向导
  onDeepLinkNavigate: (
    callback: (
      payload:
        | { type: 'session'; id: string; messageClientId?: string }
        | { type: 'project'; workingDir: string }
        | { type: 'new-session'; workingDir: string }
        | { type: 'share-import'; filePath: string }
        | { type: 'settings'; tab: 'voice-input' | 'providers' },
    ) => void,
  ): (() => void) =>
    fanOutDeepLinkNavigate((payload) => {
      if (!payload || typeof payload !== 'object') return;
      const p = payload as {
        type?: unknown;
        id?: unknown;
        workingDir?: unknown;
        filePath?: unknown;
        tab?: unknown;
        messageClientId?: unknown;
      };
      if (p.type === 'session' && typeof p.id === 'string' && p.id.length > 0) {
        callback({
          type: 'session',
          id: p.id,
          ...(typeof p.messageClientId === 'string' && p.messageClientId.length > 0
            ? { messageClientId: p.messageClientId }
            : {}),
        });
      } else if (p.type === 'settings' && (p.tab === 'voice-input' || p.tab === 'providers')) {
        callback({ type: 'settings', tab: p.tab });
      } else if (
        p.type === 'project' &&
        typeof p.workingDir === 'string' &&
        p.workingDir.length > 0
      ) {
        callback({ type: 'project', workingDir: p.workingDir });
      } else if (
        p.type === 'new-session' &&
        typeof p.workingDir === 'string' &&
        p.workingDir.length > 0
      ) {
        callback({ type: 'new-session', workingDir: p.workingDir });
      } else if (
        p.type === 'share-import' &&
        typeof p.filePath === 'string' &&
        p.filePath.length > 0
      ) {
        callback({ type: 'share-import', filePath: p.filePath });
      }
    }),

  // 冷启动时 (mainWindow 未 ready / renderer 未挂 listener) 缓存的 payload。
  // MainLayout mount 后调一次,take 一次清空——已运行场景始终返回 null。
  // 详见 main/deepLink.ts 的 pending buffer 段。
  takePendingDeepLink: (): Promise<
    | { type: 'session'; id: string; messageClientId?: string }
    | { type: 'project'; workingDir: string }
    | { type: 'new-session'; workingDir: string }
    | { type: 'share-import'; filePath: string }
    | { type: 'settings'; tab: 'voice-input' | 'providers' }
    | null
  > => ipcRenderer.invoke('deep-link:take-pending'),

  // ── TextLightbox (text-lightbox F4/F5) ──
  // Read a text file (≤ MAX_PREVIEW_MB) for the in-app preview overlay. Returns
  // `reason: 'oversize'` when over the cap so the renderer can render the
  // Oversize body without re-statting the file. The `limitMb` field mirrors
  // the main-process cap so the renderer can write dynamic copy
  // ("exceeding the {limitMb} MB preview limit") without hard-coding.
  readTextFilePreview: (params: {
    filePath: string;
  }): Promise<{
    success: boolean;
    error?: string;
    reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';
    data?: string;
    size: number;
    limitMb?: number;
  }> => ipcRenderer.invoke('text-file:read-preview', params),

  // Open a local absolute path or a main-resolved cindy-media reference with
  // the OS default application (the renderer never receives the blob path).
  openPath: (filePathOrUrl: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:open-path', filePathOrUrl),

  // 安全降级聊天附件另存为。main 校验源路径并清洗 suggestedName；保存后
  // 只返回结果，不自动打开或执行目标文件。
  saveChatAttachmentAs: (params: {
    sourcePath: string;
    suggestedName: string;
  }): Promise<
    | { status: 'saved'; savedPath: string }
    | { status: 'canceled' }
    | {
        status: 'error';
        code:
          | 'invalid_source'
          | 'forbidden'
          | 'not_found'
          | 'not_file'
          | 'dialog_failed'
          | 'copy_failed';
      }
  > => ipcRenderer.invoke('chat-attachment:save-as', params),

  // Open <userData>/logs in the OS file manager (Settings → About).
  openLogsDir: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('app:open-logs-dir'),

  // Reveal a file in the OS file manager (Explorer / Finder).
  // Accepts either an xdt-image:// URL or an absolute file path.
  // Used by the chat image right-click "open image folder" menu.
  showItemInFolder: (params: {
    url?: string;
    filePath?: string;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:show-item-in-folder', params),

  // Copy an image / video (resolved from xdt-image:// or xdt-video:// URL,
  // or absolute path) into the system clipboard as a FILE REFERENCE. Used
  // by the chat right-click "copy image / copy video" menus so users can
  // paste into Explorer / Finder, chat apps, video editors, etc.
  copyMediaToClipboard: (params: {
    url?: string;
    filePath?: string;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('media:copy-to-clipboard', params),

  // ── 图片 lightbox 媒体动作(lightboxMediaActions.ts)──
  // url 接受 xdt-image:// / xdt-file://;save/cache 还接受 http(s):// 与 data:image。
  // 失败以 throwIpcError 编码抛出,renderer 用 extractIpcError 解码。

  // 用系统默认应用打开图片(仅本地源)。
  openMediaWithDefaultApp: (params: { url: string }): Promise<void> =>
    ipcRenderer.invoke('media:open-with-default-app', params),

  // 另存为:弹系统保存对话框;用户取消返回 { canceled: true },不算错误。
  saveMediaAs: (params: {
    url: string;
  }): Promise<{ canceled: boolean; savedPath?: string }> =>
    ipcRenderer.invoke('media:save-as', params),

  // "发送到对话":把图片复制成目标会话的一份新 xdt-image:// 缓存(draft
  // lifecycle),返回构造 AttachedFile 所需元数据。
  cacheMediaForSession: (params: {
    url: string;
    sessionId: string;
  }): Promise<{ url: string; name: string; ext: string; mimeType: string; size: number }> =>
    ipcRenderer.invoke('media:cache-for-session', params),

  // renderer 字节层:http / cindy-remote-media 图取字节(标注烧录、位图复制)。
  readImageBytes: (params: {
    url: string;
  }): Promise<{ base64: string; mimeType: string }> =>
    ipcRenderer.invoke('media:read-image-bytes', params),

  // markdown-monorepo-resolve: smart relative-path resolver.
  // Tries `cwd/href` first, then BFS the workspace for files whose absolute
  // path ends with `/<href>` so monorepo sub-package refs (`src/App.tsx`
  // meaning `apps/desktop/src/App.tsx`) resolve correctly. Returns 'none'
  // on bad input or no matches; renderer falls back to legacy resolution.
  resolvePath: (params: {
    href: string;
    workingDir: string;
  }): Promise<{
    status: 'unique' | 'multiple' | 'none';
    candidates: string[];
    /** unique 命中时的目标类型;缺省按 file 理解(老 main 兼容)。 */
    kind?: 'file' | 'directory';
  }> => ipcRenderer.invoke('fs:resolve-path', params),

  // markdown-monorepo-resolve: BATCH resolver. Collapses one render pass's
  // path-shaped targets into a single IPC + single workspace walk, so switching
  // to a session with hundreds of refs no longer fires hundreds of BFS calls.
  resolvePathBatch: (params: {
    hrefs: string[];
    workingDir: string;
  }): Promise<
    Record<string, { status: 'unique' | 'multiple' | 'none'; candidates: string[]; kind?: 'file' | 'directory' }>
  > => ipcRenderer.invoke('fs:resolve-path-batch', params),

  // 本机文件系统目录浏览(项目选择器「添加远程项目」)。device-link 经隧道在被控端执行
  // (deviceLink.invoke(deviceId, 'fs:list-dir'|..., [{ path }]));本地直接调下面这组。
  // 只读目录枚举 + mkdir -p,无文件读/写/删/exec(见 main/fsBrowse/ipc.ts 与 allowlist)。
  fsBrowse: {
    listDir: (
      path: string,
    ): Promise<{
      resolvedPath: string;
      entries: { name: string; kind: 'dir' | 'symlink'; path: string }[];
      parent: string | null;
    }> => ipcRenderer.invoke('fs:list-dir', { path }),
    statPath: (
      path: string,
    ): Promise<{ kind: 'dir' | 'file' | 'missing'; resolvedPath: string }> =>
      ipcRenderer.invoke('fs:stat-path', { path }),
    mkdirP: (path: string): Promise<{ resolvedPath: string }> =>
      ipcRenderer.invoke('fs:mkdir-p', { path }),
  },

  // Electron webUtils — get native file path from a dropped/selected File object.
  // Required because File.path is unavailable in sandboxed renderers (Electron 20+).
  getFilePath: (file: File): string => webUtils.getPathForFile(file),

  // File attachment IPC (F-FI-7)
  readFileForAttachment: (params: {
    filePath: string;
    encoding: 'base64' | 'utf8';
    maxSize?: number;
  }): Promise<{
    success: boolean;
    error?: string;
    data?: string;
    size: number;
    truncated?: boolean;
  }> => ipcRenderer.invoke('read-file-for-attachment', params),

  // File header peek IPC (F-FI-8 fallback inference)
  peekFileHeader: (params: {
    filePath: string;
    bytes?: number;
  }): Promise<{
    success: boolean;
    error?: string;
    data?: string;
    actualBytes: number;
    totalSize: number;
  }> => ipcRenderer.invoke('peek-file-header', params),

  // ── Image local cache (image-local-cache M4) ──
  /**
   * Copy a local image file into the cache directory for the given session.
   * Used by drag-and-drop attachments. Returns an xdt-image:// URL the
   * renderer can use directly as an <img src>.
   */
  cacheImageFromPath: (params: {
    sessionId: string;
    sourcePath: string;
    originalName: string;
  }): Promise<{ url: string; filename: string }> =>
    ipcRenderer.invoke('image-cache:from-path', params),

  /**
   * Write a clipboard image buffer into the cache directory for the session.
   * Used by clipboard paste. Returns an xdt-image:// URL.
   */
  cacheImageFromBuffer: (params: {
    sessionId: string;
    buffer: Uint8Array;
    mimeType: string;
    suggestedName?: string;
  }): Promise<{ url: string; filename: string }> =>
    ipcRenderer.invoke('image-cache:from-buffer', params),

  /**
   * Read a cached image as base64 (used as a renderer-side fallback when the
   * primary path — main reading inline during buildContentBlocks — needs to
   * be triggered from renderer code). Most consumers do NOT need this.
   */
  readCachedImageAsBase64: (params: {
    url: string;
  }): Promise<{ base64: string; mimeType: string }> =>
    ipcRenderer.invoke('image-cache:read-base64', params),

  /** Delete every file under userData/cc-agent/images/{sessionId}. */
  cleanupSessionImages: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('image-cache:cleanup-session', sessionId),

  /** Delete the files referenced by the given xdt-image:// URLs. */
  cleanupCachedImages: (urls: string[]): Promise<void> =>
    ipcRenderer.invoke('image-cache:cleanup-files', urls),

  // ── 媒体总仓存储管理(关于页存储空间卡片)──
  // 占用统计 / 清理预检(报数)/ 执行清理 / 对账体检。scan 与 cleanup 的
  // draftUrls 由 renderer 从 composerDraftStore 现场收集(main 读不到
  // renderer 内存,草稿附件是合法的零引用 blob,必须随参取证防误删)。
  cindyMediaStorage: {
    /**
     * 本窗口草稿附件 URL 变化时上报(composerDraftStore mutator 尾部调用,
     * fire-and-forget)。多窗口时回收器取全窗口并集豁免,防误删。
     */
    reportDraftUrls: (urls: string[]): void => {
      ipcRenderer.send('cindy-media:report-draft-urls', urls);
    },

    stats: (): Promise<{
      success: boolean;
      error?: string;
      blobs: { totalCount: number; totalBytes: number; cacheCount: number; cacheBytes: number };
      legacy: { bytes: number; fileCount: number };
      deadDirs: Array<{
        name: string;
        exists: boolean;
        bytes: number;
        fileCount: number;
        newestMtimeMs: number;
        eligible: boolean;
      }>;
    }> => ipcRenderer.invoke('cindy-media:storage-stats'),

    scan: (params: { draftUrls: string[] }): Promise<{
      success: boolean;
      error?: string;
      zeroRef: { count: number; bytes: number; hashes: string[]; protectedCount: number };
      cache: {
        totalBytes: number;
        count: number;
        limitBytes: number;
        excessBytes: number;
        evictable: Array<{ hash: string; ext: string; bytes: number }>;
      };
      tmpFileCount: number;
      deadDirs: Array<{
        name: string;
        exists: boolean;
        bytes: number;
        fileCount: number;
        newestMtimeMs: number;
        eligible: boolean;
      }>;
    }> => ipcRenderer.invoke('cindy-media:storage-scan', params),

    cleanup: (params: {
      draftUrls: string[];
      zeroRefHashes: string[];
      evictCacheHashes: string[];
      deadDirNames: string[];
      cleanTmpFiles: boolean;
    }): Promise<{
      zeroRef: { deleted: number; freedBytes: number; skipped: number };
      cacheEvicted: { deleted: number; freedBytes: number; skipped: number };
      deadDirs: { removed: string[]; skipped: string[]; freedBytes: number };
      tmpFilesRemoved: number;
      freedBytes: number;
    }> => ipcRenderer.invoke('cindy-media:storage-cleanup', params),

    reconcile: (): Promise<{
      success: boolean;
      error?: string;
      orphanCount: number;
      orphanBytes: number;
      missingCount: number;
      strayCount: number;
      tmpFileCount: number;
      orphanSamples: string[];
      missingSamples: string[];
    }> => ipcRenderer.invoke('cindy-media:storage-reconcile'),
  },

  // ── CC Agent SDK old IPC (Stage 2 C1 退役) ──
  // sendCCAgentMessage / __resetCCAgentFanOuts / onCCAgent* (7 个 push subscription) /
  // respondToPermission / answerUserQuestion / respondToPlanReview / writePlanFile /
  // stopCCAgentSession / closeCCAgentSession / updatePermissionMode /
  // setCCAgentModel / setCCAgentEffort / setCCAgentFastMode / setCCAgentThinkingSummaries /
  // getCCAgentContextUsage / setCCAgentSessionVisibility — 全部退役。
  // Renderer 现在统一走 electronAPI.maker.* (A4/A5/B/B'/B''):
  //   send / abort / close / setModel / setEffort / setPermissionMode / resolveInteraction /
  //   onEvent / onInteractionRequest / onInteractionDismissed / generateTitle / writePlanFile

  // Stage 2 C2: ccAgent.rewind 整块退役 — 已迁到 electronAPI.maker.rewindPreview /
  // rewindCommit (见下方 maker 块)。

  // ── App Update (F2/F4) ──

  onUpdateStatus: fanOutUpdateStatus,

  checkForUpdate: (): Promise<{
    result: 'ready' | 'idle' | 'downloading' | 'manifest_failed' | 'download_failed' | 'manual_download';
  }> => ipcRenderer.invoke('update-check-now'),

  /**
   * Tell the main process to apply the downloaded update and relaunch.
   */
  relaunchToUpdate: (theme: 'light' | 'dark'): void => {
    ipcRenderer.send('update-relaunch', theme);
  },

  /**
   * Apply a startup-discovered update only after main rechecks the complete
   * unattended-relaunch policy at the actual execution boundary.
   */
  autoRelaunchToUpdate: (theme: 'light' | 'dark'): Promise<{
    accepted: boolean;
    blockReason?: string;
  }> => ipcRenderer.invoke('update-relaunch-auto', theme),

  /**
   * Ask the main process to move the app into /Applications (macOS only).
   */
  moveToApplicationsFolder: (): Promise<{ moved: boolean }> =>
    ipcRenderer.invoke('update-move-to-applications'),

  // Fullscreen state
  onFullscreenChange: fanOutFullscreenChange,
  getFullscreenState: (): Promise<boolean> => ipcRenderer.invoke('get-fullscreen-state'),

  // ── Release notes (per-version, fetched from CDN by main) ──
  // Platform is resolved in main via getPlatformKey() to keep the CDN path
  // axis identical to the hot-update manifest.
  // Returns null on 404 / network / parse error — caller decides UX.
  fetchReleaseNotes: (
    version: string,
  ): Promise<RawReleaseNotesPayload | null> =>
    ipcRenderer.invoke('release-notes:fetch', version),

  // Sorted ascending list of every version with a notice on the CDN. Renderer
  // uses this to gather all unread notes between the user's last-read version
  // and the current app version on cross-version upgrades. Returns null on
  // any failure — caller falls back to showing only the current version.
  fetchReleaseNotesIndex: (): Promise<string[] | null> =>
    ipcRenderer.invoke('release-notes:fetch-index'),

  // ── Worktree (worktree-parallel-sessions F1 / F4 / F5 / F6) ──
  // renderer 端 7 个 IPC：create / detect-cwd / get-for-session / list-all /
  // reveal / suggest-name / list-branches。删除 / 孤儿扫描刻意不暴露——
  // renderer 不主动触发 worktree 删除（关闭会话由 main 在 close-session
  // 路径里自动收尾）。详见 worktree-parallel-sessions-frontend.md M7。
  // ── Device Link (设备互联/跨设备远程控制) ─────────────────────────────
  // 同账号设备经 server relay 互联;此处只暴露开关 + 设备列表管理面,
  // 隧道(远程会话控制)在 M3 接入。
  deviceLink: {
    getState: (): Promise<{
      remoteControlEnabled: boolean;
      keepAwake: boolean;
      linkStatus: 'stopped' | 'connecting' | 'online';
      connectionIssue: {
        kind: 'auth-failed' | 'replaced' | 'too-many-connections' | 'version-mismatch';
        closeCode?: number;
        detail?: string;
        at: number;
      } | null;
      controlledBy: Array<{ deviceId: string; name: string }>;
      revokedControllers: string[];
      disabledControlDeviceIds: string[];
    }> => ipcRenderer.invoke('device-link:get-state'),
    setEnabled: (enabled: boolean): Promise<{ remoteControlEnabled: boolean }> =>
      ipcRenderer.invoke('device-link:set-enabled', enabled),
    setKeepAwake: (enabled: boolean): Promise<{ keepAwake: boolean }> =>
      ipcRenderer.invoke('device-link:set-keep-awake', enabled),
    setDeviceControlEnabled: (
      deviceId: string,
      enabled: boolean,
    ): Promise<{ deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }> =>
      ipcRenderer.invoke('device-link:set-device-control-enabled', { deviceId, enabled }),
    listDevices: (): Promise<{
      devices: Array<{
        deviceId: string;
        name: string;
        selfName?: string | null;
        deviceInfo?: {
          cpuLabel?: string;
          memoryGb?: number;
          osVersion?: string;
          modelLabel?: string;
        } | null;
        platform: string | null;
        appVersion: string | null;
        lastSeenAt: string | null;
        online: boolean;
        busy: boolean;
        remoteControlEnabled: boolean;
        controlEnabled: boolean;
        isSelf: boolean;
      }>;
    }> => ipcRenderer.invoke('device-link:list-devices'),
    renameDevice: (deviceId: string, name: string | null): Promise<{ deviceId: string; name: string; manualName?: string | null }> =>
      ipcRenderer.invoke('device-link:rename-device', { deviceId, name }),
    deleteDevice: (deviceId: string): Promise<{ deviceId: string; deleted: boolean }> =>
      ipcRenderer.invoke('device-link:delete-device', { deviceId }),
    // —— 控制端:远程会话视图 ——
    openLink: (deviceId: string): Promise<{ appVersion: string; allowlistHash: string }> =>
      ipcRenderer.invoke('device-link:open-link', { deviceId }),
    closeLink: (deviceId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('device-link:close-link', { deviceId }),
    /** 远程调用被控端的 allowlist 内 channel;成功直接拿返回值,失败 reject 带 code 的 Error */
    invoke: (deviceId: string, channel: string, args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke('device-link:invoke', { deviceId, channel, args }),
    /** 控制端:订阅被控端某 topic 的变更推送(push 驱动侧边栏 / 会话视图) */
    subscribe: (deviceId: string, topics: string[]): Promise<{ ok: true }> =>
      ipcRenderer.invoke('device-link:topic-subscribe', { deviceId, topics }),
    /** 控制端:取消订阅 */
    unsubscribe: (deviceId: string, topics: string[]): Promise<{ ok: true }> =>
      ipcRenderer.invoke('device-link:topic-unsubscribe', { deviceId, topics }),
    /** 被控端:一键断开当前所有控制链路 */
    disconnectAll: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('device-link:disconnect-all'),
    /** 被控端:撤销某控制端的访问权限(逐设备黑名单) */
    revoke: (deviceId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('device-link:revoke', { deviceId }),
    /** 被控端:恢复某控制端的访问权限 */
    restore: (deviceId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('device-link:restore', { deviceId }),
    onPresenceChanged: fanOutDeviceLinkPresenceChanged,
    onStatusChanged: fanOutDeviceLinkStatusChanged,
    /** 本机 relay 连接问题变化(鉴权失效/被顶号/超限/版本不符;null = 已恢复) */
    onConnectionIssue: fanOutDeviceLinkConnectionIssue,
    onRemotePush: fanOutDeviceLinkRemotePush,
    /** 被控端可见性:本机正在被哪些控制端控制 */
    onControlledState: fanOutDeviceLinkControlledState,
    /** 控制端:被某被控端撤销了访问权限,payload: { deviceId } */
    onAccessRevoked: fanOutDeviceLinkAccessRevoked,
    /** 控制端本地偏好:某目标设备是否允许被本机主动控制 */
    onControlTargetChanged: fanOutDeviceLinkControlTargetChanged,
    /** 「保持电脑唤醒」在其它共享 userData 实例被翻转后推送,payload: { keepAwake: boolean } */
    onKeepAwakeChanged: fanOutDeviceLinkKeepAwakeChanged,
  },

  // ── Remote SSH (Phase A) ───────────────────────────────────────────────
  // 连接管理 + ~/.ssh/config IO. 暂未涉及 agent-on-remote / session 同步.
  // `host.config.id` 即 ssh alias, 与 ~/.ssh/config Host 行同名.
  remoteSsh: {
    list: (): Promise<{
      hosts: Array<{
        config: {
          id: string;
          hostname: string;
          port: number;
          user: string;
          authMethod: 'agent' | 'key';
          identityFile?: string;
          source: 'ssh-config' | 'manual';
        };
        status: 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'reconnecting' | 'failed';
        lastError?: string;
        statusChangedAt: number;
        /** Phase D — 启动时是否自动连接 (本地 prefs, 不写入 ~/.ssh/config). */
        autoConnect: boolean;
      }>;
    }> => ipcRenderer.invoke('maker:remote-ssh:list'),
    reloadConfig: (): Promise<{ hosts: unknown[] }> =>
      ipcRenderer.invoke('maker:remote-ssh:reload-config'),
    add: (host: {
      id: string;
      hostname: string;
      port?: number;
      user: string;
      authMethod?: 'agent' | 'key';
      identityFile?: string;
    }): Promise<{ host: unknown }> => ipcRenderer.invoke('maker:remote-ssh:add', host),
    update: (host: {
      id: string;
      hostname: string;
      port?: number;
      user: string;
      authMethod?: 'agent' | 'key';
      identityFile?: string;
    }): Promise<{ host: unknown }> => ipcRenderer.invoke('maker:remote-ssh:update', host),
    remove: (id: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:remote-ssh:remove', { id }),
    connect: (id: string): Promise<{ host: unknown }> =>
      ipcRenderer.invoke('maker:remote-ssh:connect', { id }),
    disconnect: (id: string): Promise<{ host: unknown }> =>
      ipcRenderer.invoke('maker:remote-ssh:disconnect', { id }),
    onStatusChanged: fanOutRemoteSshStatus,

    // ── Phase B: agent on remote ──────────────────────────────────────────
    probeAgent: (id: string, agentKind: 'claude-code' | 'codex'): Promise<{
      probe: {
        agentKind: 'claude-code' | 'codex';
        nodeReady: boolean;
        nodeVersion: string | null;
        installed: boolean;
        installedVersion: string | null;
        installDir: string;
        binaryPath: string | null;
        error: string | null;
      };
    }> => ipcRenderer.invoke('maker:remote-ssh:probe-agent', { id, agentKind }),

    installAgent: (id: string, agentKind: 'claude-code' | 'codex'): Promise<{
      result: {
        agentKind: 'claude-code' | 'codex';
        ready: boolean;
        installed: boolean;
        installedVersion: string | null;
        nodeVersion: string | null;
        installDir: string;
        binaryPath: string | null;
        error: string | null;
      };
    }> => ipcRenderer.invoke('maker:remote-ssh:install-agent', { id, agentKind }),

    uninstallAgent: (id: string, agentKind: 'claude-code' | 'codex'): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:remote-ssh:uninstall-agent', { id, agentKind }),

    runAgentOneShot: (
      id: string,
      agentKind: 'claude-code' | 'codex',
      prompt: string,
    ): Promise<{
      result: {
        stdout: string;
        stderr: string;
        exitCode: number | null;
        signal: string | null;
        durationMs: number;
      };
    }> => ipcRenderer.invoke('maker:remote-ssh:run-agent-one-shot', { id, agentKind, prompt }),

    // ── Generic remote fs primitives (Phase C) ─────────────────────────────
    // Reusable by a future remote file browser; currently used by
    // StartRemoteSessionPanel for "workdir doesn't exist → confirm + mkdir".
    // Both accept `~` / `~/...` and let the remote bash expand to $HOME.
    statRemotePath: (id: string, path: string): Promise<{
      kind: 'dir' | 'file' | 'missing';
      resolvedPath: string;
    }> => ipcRenderer.invoke('maker:remote-ssh:stat-remote-path', { id, path }),

    mkdirPRemote: (id: string, path: string): Promise<{
      resolvedPath: string;
    }> => ipcRenderer.invoke('maker:remote-ssh:mkdir-p-remote', { id, path }),

    // ── Phase D: autoConnect 偏好 + 远端目录浏览 ──────────────────────────
    setAutoConnect: (id: string, autoConnect: boolean): Promise<{ ok: true; autoConnect: boolean }> =>
      ipcRenderer.invoke('maker:remote-ssh:set-auto-connect', { id, autoConnect }),
    hasAnyAutoConnectHost: (): Promise<{ hasAny: boolean }> =>
      ipcRenderer.invoke('maker:remote-ssh:has-any-auto-connect-host'),
    listRemoteDir: (id: string, path: string): Promise<{
      resolvedPath: string;
      entries: Array<{ name: string; kind: 'dir' | 'symlink' }>;
    }> => ipcRenderer.invoke('maker:remote-ssh:list-remote-dir', { id, path }),

    onInstallProgress: fanOutRemoteSshInstallProgress,
    onSilentInstallStatus: fanOutRemoteSshSilentInstallStatus,
    onCcMgrUpgradeAvailable: fanOutRemoteSshCcMgrUpgradeAvailable,

    // cc-mgr 升级 banner 三连。force-upgrade 会 kill 该 host 上 daemon 跑 re-install,
    // 中断所有 alive cc session;listPending 给 renderer 挂载时同步 snapshot;
    // dismiss 关 banner (本 desktop 不再提示该 host)。
    // sessionId 是触发 upgrade 的 banner-clicker session — main 端只 soft-close
    // 它一个 (有 UpgradeBanner retry snapshot), 其它同 host session 不动避免
    // in-flight turn 静默丢。
    ccMgrForceUpgrade: (hostId: string, sessionId?: string): Promise<{ ok: true; daemonReady: boolean }> =>
      ipcRenderer.invoke('maker:remote-ssh:cc-mgr-force-upgrade', { hostId, sessionId }),
    ccMgrListPendingUpgrades: (): Promise<{
      pending: Array<{ hostId: string; currentVersion: string; availableVersion: string }>;
    }> => ipcRenderer.invoke('maker:remote-ssh:cc-mgr-list-pending-upgrades'),
    ccMgrDismissPendingUpgrade: (hostId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:remote-ssh:cc-mgr-dismiss-pending-upgrade', { hostId }),

    // ── Codex auth sync (Phase B+) ────────────────────────────────────────
    // Two-step UX: check first (so renderer can build the right confirm
    // dialog), then sync explicitly after user confirmation. The renderer
    // is the trust boundary — sync handler does NOT itself prompt.
    checkCodexAuth: (id: string): Promise<{
      localExists: boolean;
      remoteExists: boolean;
      remoteMtime: string | null;
    }> => ipcRenderer.invoke('maker:remote-ssh:check-codex-auth', { id }),
    syncCodexAuth: (
      id: string,
    ): Promise<{
      ok: true;
      // daemonRestart: auth.json 推送成功后, 杀旧 daemon 让其用新 auth 起的步骤。
      // ok=true: 杀掉了 (或本来就没 daemon, 也算成功); UI 可以显 "已同步, 点 Retry"。
      // ok=false reason='pkill_failed': pkill rc>1 或 pkill 不可用 (eg. minimal
      //   Alpine 容器), auth 文件已落盘但 daemon 还在用旧的 in-memory auth, UI 应该
      //   显软提示 "需要 reconnect 后才能用新 auth" 而不是误导的 "已同步"。
      daemonRestart: { ok: true } | { ok: false; reason: 'pkill_failed'; detail?: string };
    }> => ipcRenderer.invoke('maker:remote-ssh:sync-codex-auth', { id }),

    // ── SSH key setup wizard (Phase B++) ──────────────────────────────────
    // Read-only enumeration + opt-in mutating `generateKey`. Private key
    // contents are never returned over this bridge — pubkey only.
    listLocalKeys: (): Promise<{
      keys: Array<{
        privateKeyPath: string;
        pubkeyPath: string;
        type: string;
        comment: string;
        fingerprintSha256: string | null;
        inAgent: boolean;
        mtimeIso: string | null;
      }>;
    }> => ipcRenderer.invoke('maker:remote-ssh:list-local-keys'),
    generateKey: (params?: {
      name?: string;
      comment?: string;
      passphrase?: string;
    }): Promise<{
      result: {
        privateKeyPath: string;
        pubkeyPath: string;
        pubkeyContent: string;
        fingerprintSha256: string | null;
      };
      agentLoaded: boolean;
      agentErrorHint: string | null;
      agentFailureReason: 'agent_unavailable' | 'bad_passphrase' | 'no_such_file' | 'other' | null;
    }> => ipcRenderer.invoke('maker:remote-ssh:generate-key', params ?? {}),
    addKeyToAgent: (params: {
      privateKeyPath: string;
      passphrase?: string;
    }): Promise<{
      result: {
        success: boolean;
        failureReason: 'agent_unavailable' | 'bad_passphrase' | 'no_such_file' | 'other' | null;
        errorHint: string | null;
        stderr: string;
      };
    }> => ipcRenderer.invoke('maker:remote-ssh:add-key-to-agent', params),
    readPubkey: (pubkeyPath: string): Promise<{ content: string }> =>
      ipcRenderer.invoke('maker:remote-ssh:read-pubkey', { pubkeyPath }),
    buildInstallCmd: (id: string, pubkeyPath: string): Promise<{
      command: string;
      platform: NodeJS.Platform;
    }> =>
      ipcRenderer.invoke('maker:remote-ssh:build-install-cmd', { id, pubkeyPath }),
    /**
     * Inline variant — caller passes user/hostname/port directly instead of a
     * pool host id. Used by the in-form key-picker dialog where the host
     * may not be saved (or even exist) yet.
     */
    buildInstallCmdInline: (params: {
      user: string;
      hostname: string;
      port?: number;
      pubkeyPath: string;
    }): Promise<{
      command: string;
      platform: NodeJS.Platform;
    }> =>
      ipcRenderer.invoke('maker:remote-ssh:build-install-cmd-inline', params),
  },

  worktreeCreate: (req: {
    sessionId: string;
    baseRepo: string;
    name: string;
    sourceBranch: string;
  }): Promise<unknown> => ipcRenderer.invoke('worktree:create', req),
  worktreeDetectCwd: (req: { cwd: string }): Promise<unknown> =>
    ipcRenderer.invoke('worktree:detect-cwd', req),
  worktreeGetForSession: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('worktree:get-for-session', sessionId),
  worktreeListAll: (): Promise<unknown> =>
    ipcRenderer.invoke('worktree:list-all'),
  worktreeReveal: (req: { path: string }): Promise<unknown> =>
    ipcRenderer.invoke('worktree:reveal', req),
  worktreeSuggestName: (req: { baseRepo: string }): Promise<unknown> =>
    ipcRenderer.invoke('worktree:suggest-name', req),
  worktreeListBranches: (req: { baseRepo: string }): Promise<unknown> =>
    ipcRenderer.invoke('worktree:list-branches', req),
  // P1: 删除/归档确认预检(有无 worktree、是否有未提交更改)
  worktreeRemovalPreview: (sessionId: string): Promise<{ hasWorktree: boolean; dirty: boolean }> =>
    ipcRenderer.invoke('worktree:removal-preview', sessionId),
  // P1: worktree 被回收后的可恢复状态 + 一键恢复(分支重建 + 快照 apply)
  worktreeRestoreStatus: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('worktree:restore-status', sessionId),
  worktreeRestoreForSession: (sessionId: string): Promise<{ ok: boolean; snapshotApplied?: boolean; message?: string }> =>
    ipcRenderer.invoke('worktree:restore-for-session', sessionId),

  // ── Slack Hook(公司中心 slack-hook-server 接入, 单内置连接) ─────────────
  // 通道名与 shared/hookControlIpc.ts 保持一致(preload 因 vite chunking 不
  // import main/shared, 字面量对齐)。鉴权走登录 JWT, 无密钥面。
  hookControl: {
    get: (): Promise<{ hook: unknown }> => ipcRenderer.invoke('maker:hook-control:get'),
    // 开关只管连接/断开; 绑定阶段 4 起走 SIWS OIDC(bindStart 单独触发)
    setEnabled: (enabled: boolean): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:set-enabled', { enabled }),
    setProviderEnabled: (provider: 'telegram', enabled: boolean): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:set-provider-enabled', { provider, enabled }),
    setWorkspaces: (workspaces: Record<string, string>): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:set-workspaces', { workspaces }),
    // SIWS OIDC 绑定: 无参数; main 发 bind.start, server 回 pending + 授权链接
    bindStart: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:hook-control:bind-start', {}),
    bindRevoke: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:hook-control:bind-revoke'),
    // (multi-team)多 workspace 绑定动作: 添加 / 重绑指定 team / 解绑指定 team /
    // 取消在途授权 —— server 宣告 multi-team 能力后才可用(renderer 按快照隐藏入口)
    addBinding: (): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:add-binding'),
    rebindTeam: (teamId: string): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:rebind-team', { teamId }),
    revokeTeam: (teamId: string): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:revoke-team', { teamId }),
    cancelPendingBind: (): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:cancel-pending-bind'),
    providerBindStart: (): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:provider-bind-start'),
    providerBindCancel: (): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:provider-bind-cancel'),
    providerBindRevoke: (): Promise<{ hook: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:provider-bind-revoke'),
    openTelegramAction: (action: 'connect' | 'provider' | 'add-to-group'): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:hook-control:telegram-open-action', { action }),
    // 目录偏好远程读写(数据正本在 slack-hook-server, 与 Slack /model 卡同一份;
    // teamId 为 multi-team 下的归属 team, 单绑定缺省)
    getWorkspacePrefs: (): Promise<{ prefs: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:prefs-get'),
    setWorkspacePrefs: (
      workspace: string,
      patch: Record<string, string | null>,
      teamId?: string | null,
    ): Promise<{ prefs: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:prefs-set', {
        workspace,
        patch,
        ...(teamId !== undefined ? { teamId } : {}),
      }),
    getProviderWorkspacePrefs: (): Promise<{ prefs: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:provider-prefs-get'),
    setProviderWorkspacePrefs: (
      workspace: string,
      patch: Record<string, string | null>,
    ): Promise<{ prefs: unknown }> =>
      ipcRenderer.invoke('maker:hook-control:provider-prefs-set', { workspace, patch }),
    onPrefsChanged: fanOutHookControlPrefs,
    onProviderPrefsChanged: fanOutHookControlProviderPrefs,
    onStatusChanged: fanOutHookControlStatus,
  },

  // ── session-git-pr-context: 会话分支感知 + PR 关联状态 ──
  gitContext: {
    /** 读 workdir 当前分支(非 git 目录返回 head=null)。 */
    get: (workdir: string): Promise<unknown> =>
      ipcRenderer.invoke('git-context:get', workdir),
    /** 按 session 解析「对话真实工作目录」+ HEAD + 来源(遥测/worktree/working_dir)。 */
    getForSession: (input: {
      sessionId: string;
      workingDir: string | null;
      worktreePath: string | null;
    }): Promise<unknown> => ipcRenderer.invoke('git-context:get-for-session', input),
    /** 开始监听该 workdir 的 HEAD 变化(refcount;变化经 onChanged 推送)。 */
    watch: (workdir: string): Promise<void> =>
      ipcRenderer.invoke('git-context:watch', workdir),
    unwatch: (workdir: string): Promise<void> =>
      ipcRenderer.invoke('git-context:unwatch', workdir),
    /** 某 session 关联的 PR 引用列表(lastSeenAt 降序)。 */
    listPrRefs: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke('git-context:pr-refs:list', sessionId),
    /** 全部会话的 PR 引用(sidebar hover tips 启动期建缓存用)。 */
    listAllPrRefs: (): Promise<unknown> =>
      ipcRenderer.invoke('git-context:pr-refs:list-all'),
    /** 批量查 PR 实时状态(main 侧 60s TTL 缓存;未配 PAT 返回 no-token)。 */
    getPrStatuses: (
      queries: Array<{ owner: string; repo: string; prNumber: number }>,
    ): Promise<unknown> => ipcRenderer.invoke('git-context:pr-status', queries),
    /** 订阅 HEAD 分支变化。payload: { workdir, head }。 */
    onChanged: fanOutGitContextChanged,
    /** 订阅 PR 引用变化。payload: { sessionId }。 */
    onPrRefsChanged: fanOutGitContextPrRefsChanged,
  },

  gitReview: {
    get: (params: { sessionId: string; ignoreWhitespace?: boolean }): Promise<ReviewData> =>
      ipcRenderer.invoke('git-review:get', params),
    summary: (params: { sessionId: string }): Promise<ReviewDirtySummary> =>
      ipcRenderer.invoke('git-review:summary', params),
    commits: (params: { sessionId: string; baseRef?: string | null }): Promise<ReviewCommitListData> =>
      ipcRenderer.invoke('git-review:commits', params),
    commitDiff: (params: { sessionId: string; oid: string; ignoreWhitespace?: boolean }): Promise<ReviewCommitDiffData> =>
      ipcRenderer.invoke('git-review:commit-diff', params),
    branchDiff: (params: { sessionId: string; baseRef?: string | null; ignoreWhitespace?: boolean }): Promise<ReviewBranchDiffData> =>
      ipcRenderer.invoke('git-review:branch-diff', params),
    fileDiff: (params: { sessionId: string } & ReviewFileDiffRequest): Promise<ReviewFileDiffData> =>
      ipcRenderer.invoke('git-review:file-diff', params),
    imagePreview: (params: { sessionId: string; diff: FileDiff; commitOid?: string | null; branchBaseRef?: string | null }): Promise<ReviewImagePreviewData> =>
      ipcRenderer.invoke('git-review:image-preview', params),
    markdownPreview: (params: { sessionId: string; diff: FileDiff; commitOid?: string | null; branchBaseRef?: string | null }): Promise<ReviewMarkdownPreviewData> =>
      ipcRenderer.invoke('git-review:markdown-preview', params),
    openFile: (params: { sessionId: string; path: string }): Promise<void> =>
      ipcRenderer.invoke('git-review:open-file', params),
    stageFile: (params: { sessionId: string; targets: ReviewFileTarget[] }): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:stage-file', params),
    unstageFile: (params: { sessionId: string; targets: ReviewFileTarget[] }): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:unstage-file', params),
    discardFile: (params: { sessionId: string; targets: ReviewFileTarget[] }): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:discard-file', params),
    stageHunk: (params: ReviewHunkOperationRequest): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:stage-hunk', params),
    unstageHunk: (params: ReviewHunkOperationRequest): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:unstage-hunk', params),
    discardHunk: (params: ReviewHunkOperationRequest): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:discard-hunk', params),
    stageAll: (params: { sessionId: string; targets: ReviewFileTarget[] }): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:stage-all', params),
    unstageAll: (params: { sessionId: string; targets: ReviewFileTarget[] }): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:unstage-all', params),
    discardAll: (params: { sessionId: string; targets: ReviewFileTarget[] }): Promise<ReviewStageOperationResult> =>
      ipcRenderer.invoke('git-review:discard-all', params),
    commit: (params: ReviewCommitRequest): Promise<ReviewCommitResult> =>
      ipcRenderer.invoke('git-review:commit', params),
    push: (params: { sessionId: string; confirmForce?: ReviewPushConfirmForce }): Promise<ReviewPushResult> =>
      ipcRenderer.invoke('git-review:push', params),
  },

  // sidebar 偏好(置顶手动顺序)走 main 进程 electron-store,跨 dev / installed 共享
  sidebarSettingsLoadPinnedOrderSync: (): string[] => {
    const value = ipcRenderer.sendSync('sidebar-settings:load-pinned-order-sync');
    return Array.isArray(value) ? (value as string[]) : [];
  },
  sidebarSettingsSavePinnedOrder: (order: readonly string[]): Promise<void> =>
    ipcRenderer.invoke('sidebar-settings:save-pinned-order', Array.from(order)),

  // ── session 级"终身累计 cost"变化 (per-session, 不是 today-aggregate) ──
  // 今日累计 (Claude USD + Codex token) 已搬到 electronAPI.maker.usage.* (取代老
  // getTodaySpend / onUsageTodaySpendChanged + electronAPI.codex.usage.*)。
  /** 订阅 session 级"终身累计 cost"变化。payload: { sessionId, totalCostUsd }。 */
  onUsageSessionSpendChanged: fanOutUsageSessionSpendChanged,
  /** 订阅 session 级"终身累计 token"变化。payload: { sessionId, totalTokens }。 */
  onUsageSessionTokensChanged: fanOutUsageSessionTokensChanged,
  /** 订阅单条消息的 per-turn 成本推送（含原始分段与展示用用户轮累计）。 */
  onUsageMessageTurnCost: fanOutUsageMessageTurnCost,
  /** 订阅单条消息的模型降级标记推送。payload: { sessionId, clientId, modelMismatch }。 */
  onUsageMessageModelMismatch: fanOutUsageMessageModelMismatch,

  // ── 首登轻量数据迁移(mToc):老 userData → Cindy 的一次性复制迁移 ──
  // main 在 ensureReady 前推送弹窗阶段;renderer 全局弹窗组件消费。
  legacyMigration: {
    /** 订阅迁移弹窗阶段推送。payload: { phase: 'confirm'|'running'|'done'|'failed' } */
    onState: fanOutLegacyMigrationState,
    /** 组件挂载时补拉当前阶段(避免 main 先推送、renderer 后订阅丢事件)。 */
    getState: (): Promise<{ phase: 'confirm' | 'running' | 'done' | 'failed' | null }> =>
      ipcRenderer.invoke('legacy-migration:get-state'),
    /** 用户点「确定」(confirm 态放行迁移)或「继续」(failed 态清态关窗)。 */
    confirm: (): Promise<void> => ipcRenderer.invoke('legacy-migration:confirm'),
  },

  // ── chat-data-localization (M-FE2)：本地 SQLite IPC 桥接 ──
  // 所有 db 操作 main 独占；renderer 仅通过这里间接访问。
  localDb: {
    ensureReady: (
      userId: string,
    ): Promise<
      | { ready: true }
      | { ready: false; error: { code: string; message: string } }
    > => ipcRenderer.invoke('local-db:ensure-ready', userId),
    sessions: {
      list: (limit?: number, status?: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:list', limit, status),
      create: (body?: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:create', body),
      get: (id: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:get', id),
      resolveReferences: (sessionIds: string[]): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:resolve-references', sessionIds),
      restoreIfArchived: (id: string, expected: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:restore-if-archived', id, expected),
      update: (id: string, patch: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:update', id, patch),
      touchUserSend: (id: string, atMs?: number): Promise<void> =>
        ipcRenderer.invoke('local-db:sessions:touchUserSend', id, atMs),
      /** interrupted-turn-resume:「疑似中断」(startedAt > endedAt)的 active 会话 id(启动红点)。 */
      interruptedPending: (): Promise<string[]> =>
        ipcRenderer.invoke('local-db:sessions:interrupted-pending'),
      /** interrupted-turn-resume:用户对中断提示点「忽略」,写一次正常收尾时刻。 */
      ackInterrupted: (id: string): Promise<void> =>
        ipcRenderer.invoke('local-db:sessions:ack-interrupted', id),
      // Stage 2 C2: fork 已迁到 electronAPI.maker.fork (走 maker:fork IPC)。
    },
    conversations: {
      search: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:conversations:search', request),
    },
    recentWorkdirs: {
      /** 列出"最近工作目录"按 lastUsedAt desc;sessions 归档/删除不影响本表。 */
      list: (): Promise<unknown> =>
        ipcRenderer.invoke('local-db:recent-workdirs:list'),
      /** 从最近列表移除一条(列表卫生,不动 sessions / 磁盘;再次使用会重新入列)。 */
      remove: (input: { path: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:recent-workdirs:remove', input),
      /** Broadcast: 任一窗口/远程调用删除条目后通知,其它窗口据此重拉列表。 */
      onChanged: createIpcFanOut('local-db:recent-workdirs:changed'),
    },
    rightSidebarTabs: {
      /** 按 sessionId 拉 tab 列表 + activeTabId。 */
      list: (input: { sessionId: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:right-sidebar-tabs:list', input),
      /** 新增 / 更新单个 tab(state JSON / position / kind)。state 缺省 → '{}'。 */
      upsert: (input: {
        id: string;
        sessionId: string;
        kind: string;
        position: number;
        state?: unknown;
      }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:right-sidebar-tabs:upsert', input),
      /** 删除单个 tab(不删 active flag,setActive 负责切换激活态)。 */
      close: (input: { id: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:right-sidebar-tabs:close', input),
      /** 切换激活 tab;id=null 表示清空激活(关闭最后一个 tab 时使用)。 */
      setActive: (input: { sessionId: string; id: string | null }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:right-sidebar-tabs:setActive', input),
      /** 一次性重写 session 内 tab position(orderedIds 数组下标 = 新 position)。 */
      reorder: (input: { sessionId: string; orderedIds: string[] }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:right-sidebar-tabs:reorder', input),
    },
    projectAliases: {
      list: (): Promise<unknown> =>
        ipcRenderer.invoke('local-db:project-aliases:list'),
      set: (input: { projectKey: string; alias: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:project-aliases:set', input),
      delete: (projectKey: string): Promise<void> =>
        ipcRenderer.invoke('local-db:project-aliases:delete', projectKey),
      onChanged: (cb: () => void) => fanOutProjectAliasesChanged(cb as IpcCallback),
    },
    sessionImport: {
      scan: (request?: { force?: boolean }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-import:scan', request),
      importSelected: (items: Array<{ source: 'codex' | 'claude'; id: string }>): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-import:import', { items }),
      linkCodexProject: (workingDir: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-import:link-codex-project', { workingDir }),
    },
    sessionShare: {
      /** 导出会话为 .cshare(main 弹保存对话框;password 可选,不落日志)。 */
      export: (request: {
        sessionId: string;
        password?: string;
        excludeMedia?: boolean;
      }): Promise<unknown> => ipcRenderer.invoke('local-db:session-share:export', request),
      /** 导入第一段:filePath 缺省时 main 弹打开对话框;拖入路径直接传。 */
      inspect: (request?: { filePath?: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-share:inspect', request ?? {}),
      unlock: (request: { draftId: string; password: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-share:unlock', request),
      /**
       * commit:draftPrefs = 导入端 New Maker 草稿默认值(导入语义 = 用草稿新建会话,agent 跟随分享包);
       * overwrite = 冲突弹窗确认后覆盖导入(软删同 resume id 的旧会话,替换而非叠加);
       * useWorktree = 在 worktree 中创建(仅 project 会话,main 编排建 worktree 后 workingDir 指向它)。
       */
      commit: (request: {
        draftId: string;
        workingDir?: string;
        draftPrefs?: {
          model?: string;
          effort?: string;
          permissionMode?: string;
          planMode?: boolean;
          fastMode?: boolean;
          providerId?: string | null;
        };
        overwrite?: boolean;
        useWorktree?: boolean;
      }): Promise<unknown> => ipcRenderer.invoke('local-db:session-share:commit', request),
      cancel: (request: { draftId: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-share:cancel', request),
      /** 窗口级拖拽路由:判定本地路径是分享文件(.cshare / 旧 .xdtshare)/ 目录 / 其它。 */
      classifyPath: (request: { path: string }): Promise<unknown> =>
        ipcRenderer.invoke('local-db:session-share:classify-path', request),
    },
    orcaWorkflows: {
      create: (input: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:orca-workflows:create', input),
      getByLeadSession: (leadSessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:orca-workflows:get-by-lead', leadSessionId),
      getByWorkerSession: (workerSessionId: string): Promise<unknown> =>
        ipcRenderer.invoke(
          'local-db:orca-workflows:get-by-worker-session',
          workerSessionId,
        ),
      listWorkersByLead: (leadSessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:orca-workflows:list-workers-by-lead', leadSessionId),
      addWorker: (input: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:orca-workflows:add-worker', input),
      updateWorkerStatus: (workerId: string, status: string): Promise<void> =>
        ipcRenderer.invoke(
          'local-db:orca-workflows:update-worker-status',
          workerId,
          status,
        ),
      onOrcaWorkerChanged: (cb: (payload: unknown) => void) =>
        fanOutOrcaWorkerChanged(cb as IpcCallback),
      createWorker: (input: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('maker:worker:create', input),
      switchFocus: (input: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('maker:worker:switch-focus', input),
      idleWorker: (leadSessionId: string, workerId: string, expectedStatus?: 'done'): Promise<unknown> => {
        if (expectedStatus === 'done') {
          return ipcRenderer.invoke('maker:worker:acknowledge-done', { leadSessionId, workerId });
        }
        return ipcRenderer.invoke('maker:worker:idle', {
          leadSessionId,
          workerId,
          ...(expectedStatus ? { expectedStatus } : {}),
        });
      },
      archiveWorker: (leadSessionId: string, workerId: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:worker:archive', { leadSessionId, workerId }),
      endTeam: (leadSessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:team:end', leadSessionId),
      getCollaborationSettings: (): Promise<unknown> =>
        ipcRenderer.invoke('maker:collaboration-settings:get'),
      setCollaborationSetting: (key: string, value: number): Promise<unknown> =>
        ipcRenderer.invoke('maker:collaboration-settings:set', { key, value }),
      resetCollaborationSettings: (): Promise<unknown> =>
        ipcRenderer.invoke('maker:collaboration-settings:reset'),
    },
    messages: {
      list: (
        sessionId: string,
        opts?: { limit?: number; before?: string; beforeTs?: number },
      ): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:list', sessionId, opts),
      estimatedSessionValue: (
        sessionId: string,
      ): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:estimatedSessionValue', sessionId),
      around: (
        sessionId: string,
        messageId: string,
        opts?: { radius?: number },
      ): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:around', sessionId, messageId, opts),
      aroundClientId: (
        sessionId: string,
        clientId: string,
        opts?: { radius?: number },
      ): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:around-client-id', sessionId, clientId, opts),
      create: (sessionId: string, body: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:create', sessionId, body),
      updateContent: (
        sessionId: string,
        clientId: string,
        content: unknown,
      ): Promise<unknown> =>
        ipcRenderer.invoke(
          'local-db:messages:updateContent',
          sessionId,
          clientId,
          content,
        ),
      /** error-tail-banner:忽略错误行(main 侧 merge dismissed:true,保留原字段)。 */
      dismissError: (sessionId: string, clientId: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:dismiss-error', sessionId, clientId),
      /** Broadcast: main 端创建消息后通知 (e.g. feishu /ctr 接管路径写库时)。
       *  renderer 用这个触发 makerChatStore push 到 in-memory state。 */
      onCreated: createIpcFanOut('local-db:messages:created'),
      /** Broadcast:一条 user / assistant 消息内容已从本地会话删除。 */
      onDeleted: createIpcFanOut('local-db:messages:deleted'),
      /** Broadcast: terminal error 行落库后,renderer 把该会话 historyLoaded 置 false,
       *  下次打开时 ensureInitialMessages 从 DB 重拉,error 卡正常浮现。 */
      onErrorPersisted: createIpcFanOut('local-db:session:error-persisted'),
    },
    sessionsPush: {
      /** Broadcast: main 端创建 session 后通知 (e.g. feishu /ctr New 接管时
       *  maker.createSession 创建)。renderer 用这个触发 sidebar 重拉。 */
      onCreated: createIpcFanOut('local-db:sessions:created'),
      /** Broadcast: main 端更新 session 字段后通知 (e.g. feishu /ctr New 自动命名)。 */
      onPatched: createIpcFanOut('local-db:sessions:patched'),
    },
    // V0.4：corruption 恢复后一次性 toast 事件
    onCorruptionRestored: fanOutCorruptionRestored,
    // #37: release 端检测到 schema drift 时的一次性 toast 事件
    onSchemaDriftWarning: fanOutSchemaDriftWarning,
  },

  // ── RSB browser bridge (Phase 2) ─────────────────────────────────────────
  /**
   * Renderer ↔ main 桥,把 RSB `<webview>` 注册到 main 端 TabRegistry,Phase 3
   * 自动化 backend 据此取 webContents。channel 不归 localDb 管(运行时状态,不是
   * 持久化),所以跟 localDb 平级放在 electronAPI 顶层。
   *  - report:webview attach 后(`dom-ready`)上报 webContentsId
   *  - release:pool 释放 tab 时清理 main 端注册
   *  - snapshot:RSB mount 时重新校对全部 entry,清除 HMR / crash 残留
   *  - onPin / onUnpin:main → renderer 推 automation pin 状态
   */
  rsbBrowserBridge: {
    report: (input: {
      sessionId: string;
      tabId: string;
      webContentsId: number;
    }): Promise<unknown> => ipcRenderer.invoke('rsb-browser-bridge:report', input),
    release: (input: { tabId: string; webContentsId?: number }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:release', input),
    snapshot: (input: { liveTabIds: string[] }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:snapshot', input),
    /** 工具栏截图按钮:main 端 capturePage 后写入系统剪贴板。 */
    captureScreenshot: (input: { tabId: string }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:capture-screenshot', input),
    /** 页面评论:main 端 capturePage 后把 PNG 字节返回(不写剪贴板)。 */
    captureScreenshotData: (input: {
      tabId: string;
    }): Promise<{ ok: true; data: Uint8Array }> =>
      ipcRenderer.invoke('rsb-browser-bridge:capture-screenshot-data', input),
    onPin: (cb: (payload: { tabId: string }) => void) =>
      fanOutRsbBrowserBridgePin(cb as IpcCallback),
    onUnpin: (cb: (payload: { tabId: string }) => void) =>
      fanOutRsbBrowserBridgeUnpin(cb as IpcCallback),
    /** main → renderer "do this tab op against the RSB store" — Phase 3 backend. */
    onTabOpRequest: (cb: (req: unknown) => void) =>
      fanOutRsbBrowserBridgeTabOpRequest(cb as IpcCallback),
    /** renderer → main "here's the result of that tab-op-request". */
    tabOpResult: (result: unknown): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:tab-op-result', result),
    /** Push renderer's currently-focused RSB sessionId to main (Phase 5). */
    setActiveSession: (input: { sessionId: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:set-active-session', input),
  },

  // ── Browser backend toggle (Phase 5) ─────────────────────────────────────
  /**
   * Settings UI driver — switches the MCP `browser` tool between external
   * Chrome (vendored) and the RSB sidebar `<webview>` (Phase 3 backend).
   */
  browserBackend: {
    /** Read current active kind + system default + override flag. */
    getState: (): Promise<{
      active: 'external' | 'rsb-webview';
      systemDefault: 'external' | 'rsb-webview';
      isOverride: boolean;
    }> => ipcRenderer.invoke('browser-backend:get-state'),
    /** Swap the active backend AND persist as user override. */
    setKind: (kind: 'external' | 'rsb-webview'): Promise<unknown> =>
      ipcRenderer.invoke('browser-backend:set-kind', { kind }),
    /** Clear user override → follow current system default. */
    reset: (): Promise<unknown> => ipcRenderer.invoke('browser-backend:reset'),
  },

  // electronAPI.codex.* 已退役 —— auth / agent status / usage 全部走 electronAPI.maker.*(agentKind),
  // 详见下方 maker 块的 auth / agent / usage 三个子对象。

  // ─── Maker Core IPC ─────────────────────────────────────────────────────
  // renderer 通过统一 maker API 按 agentKind 调用 Claude Code / Codex。
  maker: {
    listAvailableAgents: (): Promise<Array<'claude-code' | 'codex'>> =>
      ipcRenderer.invoke('maker:list-available-agents'),
    getCapabilities: (agentKind: 'claude-code' | 'codex'): Promise<unknown> =>
      ipcRenderer.invoke('maker:get-capabilities', agentKind),

    // workflow 逐 agent 进度树(只读)。读不到 / 解析失败返回 null,由 renderer 回退到
    // workflow 级卡片。数据源是 Claude Code 内部记录文件(见 main workflow-progress/reader)。
    getWorkflowProgress: (
      sessionId: string,
      taskId: string,
    ): Promise<import('../shared/workflow-progress').WorkflowProgress | null> =>
      ipcRenderer.invoke('maker:get-workflow-progress', sessionId, taskId),

    // 模型供应商目录（只读）—— 内置目录元数据 + 各供应商实时连接状态。
    listProviders: (): Promise<{ providers: import('@cindy/model-providers').ProviderView[] }> =>
      ipcRenderer.invoke('maker:provider:list'),

    // 自定义供应商配置 CRUD（密钥另走通用 safeStorage IPC，不经这里）。
    createCustomProvider: (
      config: import('@cindy/model-providers').CustomProviderConfig,
    ): Promise<{ ok: true }> => ipcRenderer.invoke('maker:provider:custom:create', config),
    updateCustomProvider: (
      config: import('@cindy/model-providers').CustomProviderConfig,
    ): Promise<{ ok: true }> => ipcRenderer.invoke('maker:provider:custom:update', config),
    deleteCustomProvider: (providerId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:provider:custom:delete', providerId),
    /** 自定义供应商创建模板（目录 presets 段，纯 UI 模板数据）。 */
    listProviderPresets: (): Promise<{ presets: import('@cindy/model-providers').ProviderPreset[] }> =>
      ipcRenderer.invoke('maker:provider:presets'),
    /**
     * 供应商「测试连接」—— 与真实会话同路由口径的最小探测请求。
     * saved: 已保存供应商（key main 侧从 safeStorage 读）；adhoc: 表单未保存值（key 仅内存透传）。
     */
    testProviderConnection: (
      input:
        | { kind: 'saved'; providerId: string; agent: 'claude-code' | 'codex' }
        | {
            kind: 'adhoc';
            spec: {
              agent: 'claude-code' | 'codex';
              baseUrl: string;
              modelId: string;
              apiKey?: string | null;
              headers?: Record<string, string>;
            };
          },
    ): Promise<{
      ok: boolean;
      code?: import('../shared/providerErrors').ProviderErrorCode;
      status?: number;
      latencyMs: number;
      detail?: string;
    }> => ipcRenderer.invoke('maker:provider:test-connection', input),
    /**
     * 供应商「获取模型列表」—— 用表单值 GET 该供应商的列模型端点（key 仅内存透传）。
     * 结构化结果：ok=true 带 models；失败 code 走 providerError.* i18n。
     */
    fetchProviderModels: (input: {
      agent: 'claude-code' | 'codex';
      baseUrl: string;
      modelsUrl?: string | null;
      apiKey?: string | null;
      headers?: Record<string, string>;
    }): Promise<{
      ok: boolean;
      models?: { id: string; name: string }[];
      code?: import('../shared/providerErrors').ProviderErrorCode;
      status?: number;
      detail?: string;
    }> => ipcRenderer.invoke('maker:provider:models-fetch', input),
    /**
     * 本机 agent CLI 安装 / 登录态扫描（设置「检测建议」用）。只 stat 不读凭证内容;
     * 失败降级空数组。
     */
    scanLocalCli: (): Promise<{
      detections: import('../shared/localCliDetect').LocalCliDetection[];
    }> => ipcRenderer.invoke('maker:provider:local-cli-scan'),
    /** 自定义供应商变更广播订阅（返回 off）。 */
    onProvidersChanged: fanOutMakerProvidersChanged,

    // 自定义 MCP 服务器配置 CRUD（可选 bearer token 另走通用 safeStorage IPC，不经这里）。
    listCustomMcpServers: (): Promise<{
      servers: import('../shared/customMcp').CustomMcpConfig[];
    }> => ipcRenderer.invoke('maker:mcp:custom:list'),
    createCustomMcpServer: (
      config: import('../shared/customMcp').CustomMcpConfig,
    ): Promise<{ ok: true }> => ipcRenderer.invoke('maker:mcp:custom:create', config),
    updateCustomMcpServer: (
      config: import('../shared/customMcp').CustomMcpConfig,
    ): Promise<{ ok: true }> => ipcRenderer.invoke('maker:mcp:custom:update', config),
    deleteCustomMcpServer: (mcpId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:mcp:custom:delete', mcpId),
    /** token-only 后置刷新：safeStorage write/remove 完成后调用，消除竞态窗口。 */
    refreshCustomMcpCodex: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:mcp:custom:refresh'),
    /** 自定义 MCP 变更广播订阅（返回 off）。 */
    onMcpChanged: fanOutMakerMcpChanged,
    /** 自定义供应商上游错误订阅（payload = { agent, providerId, code, retryable, status, detail? }）。 */
    onProviderUpstreamError: fanOutMakerProviderUpstreamError,
    /** Claude Auto classifier 失败后降级到 ask 的会话级通知。 */
    onAutoPermissionFallback: fanOutMakerAutoPermissionFallback,
    /** 会话后台活动只读快照(turn 已结束但 CC 子进程仍在调模型)。 */
    getSessionBackgroundActivity: (sessionId: string): Promise<{ active: boolean }> =>
      ipcRenderer.invoke('maker:session-background-activity', sessionId),
    /** 后台活动活跃会话全量列表(全局 store 挂载时的初始快照,增量走 push 订阅)。 */
    listSessionBackgroundActivity: (): Promise<{ sessionIds: string[] }> =>
      ipcRenderer.invoke('maker:session-background-activity:list'),
    /** 一键停止会话全部任务(含当前 turn 与后台子 agent；关闭运行句柄后会话仍可续)。 */
    stopSessionBackgroundTasks: (sessionId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:session-background-tasks:stop', sessionId),
    /** 会话后台活动翻转订阅(payload = { sessionId, active },返回 off)。 */
    onSessionBackgroundActivityChanged: fanOutMakerSessionBackgroundActivityChanged,
    /** 精确停止会话内单个后台任务(不中断当前 turn;任务已结束幂等成功)。 */
    stopAgentTask: (sessionId: string, taskId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:agent-task:stop', sessionId, taskId),
    /** 会话仍在运行的后台任务快照(挂载 / 重载后补回存量;实时增量走事件流)。 */
    listSessionBackgroundTasks: (
      sessionId: string,
    ): Promise<{ tasks: Array<{ taskId: string; taskType?: string; toolUseId?: string; title?: string }> }> =>
      ipcRenderer.invoke('maker:session-background-tasks:list', sessionId),
    /** 通用 OAuth 供应商（目录 auth.oauth 描述符驱动）登录 / 登出 / 取消。 */
    providerOAuthLogin: (providerId: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('maker:provider:oauth:login', providerId),
    providerOAuthLogout: (providerId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:provider:oauth:logout', providerId),
    providerOAuthCancel: (providerId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:provider:oauth:cancel', providerId),
    /**
     * renderer → main 单向镜像「模型显示/隐藏」override 整张快照(modelVisibilityPrefs)。
     * 让 IM /model 在 main 侧复用同一套可见性过滤,与应用内模型列表逐模型一致。
     * fire-and-forget(忽略返回),main 仅缓存于内存、不落盘。
     */
    syncModelVisibility: (map: Record<string, boolean>): Promise<void> =>
      ipcRenderer.invoke('maker:model-visibility:sync', map),

    // 「在新窗口打开」会话多开 —— 新建一个完整窗口定位到该 session。
    openSessionInNewWindow: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('maker:open-session-in-new-window', sessionId),

    // ── Palette `/` 命令三源 (palette refactor) ─────────────────────────
    // Renderer 通过这四个调用合并三路数据 + 触发 desktop 命令 execute。
    // 老 scanSlashCommands 已下线 —— 数据等价于 listAgentSkills, 改名是为了和
    // listAgentCommands / listDesktopCommands 形成清晰的 "三源 + execute" 命名族。
    listDesktopCommands: (): Promise<{
      success: boolean;
      error?: string;
      commands?: Array<{ kind: 'desktop'; name: string; description: string }>;
    }> => ipcRenderer.invoke('maker:list-desktop-commands'),

    executeDesktopCommand: (
      name: string,
      // deviceId:device-link 远程会话的归属设备(main 侧 /goal /learn /cmd 据此隧道路由)。
      ctx: { sessionId?: string; workingDir?: string; args?: string; deviceId?: string },
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('maker:execute-desktop-command', name, ctx),

    listAgentCommands: (
      agentKind: 'claude-code' | 'codex',
    ): Promise<{
      success: boolean;
      error?: string;
      commands?: Array<{ kind: 'agent-builtin'; name: string; description: string }>;
    }> => ipcRenderer.invoke('maker:list-agent-commands', agentKind),

    listAgentSkills: (
      agentKind: 'claude-code' | 'codex',
      params: { workingDir: string; forceReload?: boolean },
    ): Promise<{
      success: boolean;
      error?: string;
      skills?: Array<{
        kind: 'agent-skill';
        name: string;
        description?: string;
        source: 'user' | 'skill';
        path?: string;
        scope?: string;
        enabled?: boolean;
      }>;
    }> => ipcRenderer.invoke('maker:list-agent-skills', agentKind, params),

    /**
     * 订阅 main 端 DesktopCommandRegistry execute 后广播的"做 UI 动作"信号。
     * payload.command = 'help' | 'clear' | 'cmd' 等 (内置), renderer 按此分支调
     * 本地副作用 (insertSystemCard / clearSession / ...)。/cmd 这种执行型命令
     * 在 payload.result 里带 stdout / stderr / exitCode 等结果字段。返回 unsubscribe。
     */
    onDesktopCommandTriggered: (
      handler: (payload: {
        command: string;
        sessionId?: string;
        workingDir?: string;
        args?: string;
        result?: {
          cmdLine: string;
          cwd: string;
          exitCode: number;
          stdout: string;
          stderr: string;
          elapsedMs: number;
          timedOut: boolean;
          spawnError?: string;
        };
        error?: string;
        goalAction?: 'set' | 'cleared' | 'open-dialog';
      }) => void,
    ): (() => void) => {
      const channel = 'maker:desktop-command-triggered';
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        handler(payload as Parameters<typeof handler>[0]);
      };
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },

    // ── 会话内 /goal 自主续跑 ───────────────────────────────────────────────
    /** 设/替换会话目标(主入口是 /goal 命令;此为 renderer 备用入口)。 */
    setGoal: (input: {
      sessionId: string;
      objective: string;
      /** GUI 新建弹窗高级设置;缺省 → 走系统默认上限。 */
      limits?: { maxTurns: number | null; budgetTokens: number | null; noProgressLimit: number | null };
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke('maker:goal:set', input),
    /** 用户清除会话目标(GoalIndicator ✕)。 */
    clearGoal: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('maker:goal:clear', sessionId),
    /** 暂停 active 目标(GoalIndicator ⏸);保留计数,可 resume。非 active 为 no-op。 */
    pauseGoal: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('maker:goal:pause', sessionId),
    /** 恢复 paused/blocked 目标(GoalIndicator ▶ / resume-on-open);保留计数续跑。 */
    resumeGoal: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('maker:goal:resume', sessionId),
    /** 更新当前目标的目标文本 / 上限;不写全局默认。 */
    updateGoal: (
      sessionId: string,
      patch: { objective?: string; maxTurns?: number | null; budgetTokens?: number | null; noProgressLimit?: number | null },
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('maker:goal:update', { sessionId, patch }),
    /** 取会话当前 goal 扁平状态;无 goal 返回 null。 */
    getGoalStatus: (
      sessionId: string,
    ): Promise<{
      sessionId: string;
      status: 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';
      objective: string;
      turnsUsed: number;
      tokensUsed: number;
      maxTurns: number | null;
      noProgressLimit: number | null;
      budgetTokens: number | null;
      usageResetAt: number | null;
      lastReason: string | null;
    } | null> => ipcRenderer.invoke('maker:goal:get-status', sessionId),
    /** 订阅 goal 状态变化;payload = { sessionId, goal: GoalStatusPayload | null }。返回 unsubscribe。 */
    onGoalStatusChanged: fanOutGoalStatusChanged,

    scanAtResources: (
      agentKind: 'claude-code' | 'codex',
      params: { workingDir: string; cap?: number; query?: string },
    ): Promise<{
      success: boolean;
      error?: string;
      items?: Array<
        | { type: 'file'; name: string; relPath: string; description?: string }
        | { type: 'dir'; name: string; relPath: string; description?: string }
        | { type: 'agent'; name: string; relPath: string; description?: string }
      >;
      truncated?: boolean;
    }> => ipcRenderer.invoke('maker:scan-at-resources', agentKind, params),

    createSession: (opts: {
      /** 可选: 复用外部 sessionId(本端 chat 用 local-db:sessions:create 拿到的 id) */
      id?: string;
      agentKind: 'claude-code' | 'codex';
      workingDir: string;
      model: string;
      title?: string;
      parentSessionId?: string;
      orcaRole?: 'lead' | 'worker' | null;
      // 与 @cindy/maker-core types/common.ts Effort union 一致
      effort?: string;
      fastMode?: boolean;
      permissionMode?: string;
      /** 计划模式一级开关(与 permissionMode 正交)。 */
      planMode?: boolean;
      systemPrompt?: string;
      /**
       * 用户级 system prompt 末段, agent.startSession 时拼到 systemPrompt /
       * developerInstructions 第 4 段。值由 renderer 的 lib/userPromptStore 提供
       * (本地 localStorage), 每次 startSession 透传当前最新值, 不持久化到 DB。
       */
      userPrompt?: string;
      /**
       * Maker Memory 启用 flag (per-session)。值由 renderer 的 lib/memorySettingsStore
       * 提供, mode==='maker' 时透传 true。每次 startSession 透传当前值, 老 session
       * 维持启动时快照 (跟 userPrompt 同语义)。
       */
      makerMemoryEnabled?: boolean;
      displayReasoning?: 'off' | 'summarized' | 'full';
      /**
       * 远端 host alias (Settings → Remote 里加好并已 connect 的)。设置后, codex
       * agent 进程跑在远端机器上, workingDir 须为远端绝对路径。仅 Codex 支持。
       */
      remoteHostId?: string;
      vendorOptions?: Record<string, unknown>;
    }): Promise<{ sessionId: string; agentKind: string; workDir: string; capabilities: unknown; usedProjectContext?: boolean }> =>
      ipcRenderer.invoke('maker:create-session', opts),

    markOrcaRole: (sessionId: string, role: 'lead' | 'worker'): Promise<void> =>
      ipcRenderer.invoke('maker:mark-orca-role', sessionId, role),

    /**
     * F-COLLAB: 在已存在的 lead session 上开启协同模式。
     * 后端会创建新 workflow + Worker session(spawn SDK)+ 把 lead 标 orca_role='lead',
     * 并在 lead session 在线时调 setVendorOptions 让下一 turn 拿到协同 MCP 工具。
     * 返回的 workerSessionId 是新建 Worker 的 sessionId,renderer 可立即跳转到
     * /cc-agent/orca/<leadSessionId>?worker=<workerSessionId> 渲染 split pane。
     */
    enableOrca: (
      leadSessionId: string,
      opts: {
        workerAgent: 'claude-code' | 'codex';
        delegateTask?: string;
        role?: string;
        label?: string;
        model?: string;
        effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
      },
    ): Promise<{ workflowId: string; workerSessionId: string; workerId: string }> =>
      ipcRenderer.invoke('maker:session:enable-orca', leadSessionId, opts),

    /**
     * F-COLLAB: 关闭 lead session 的当前协同 workflow。
     * 后端会 abort+close 所有 Worker session、把 workflow 标 completed、
     * sessions.status='archived' 让 sidebar 自动隐藏 Worker。
     */
    disableOrca: (leadSessionId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('maker:session:disable-orca', leadSessionId),

    /**
     * Send message; lazy-create session if not yet started (createOpts required when lazy).
     * createOpts.id is **forced** to sessionId by the IPC handler — pass agentKind/model/workingDir.
     */
    send: (
      sessionId: string,
      message: string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> },
      createOpts?: {
        agentKind: 'claude-code' | 'codex';
        workingDir: string;
        model: string;
        orcaRole?: 'lead' | 'worker' | null;
        effort?: string;
        fastMode?: boolean;
        permissionMode?: string;
        /** 计划模式一级开关(与 permissionMode 正交)。 */
        planMode?: boolean;
        /** 用户级 system prompt 末段; 仅 lazy-create 那一次生效, 已 spawn 的 session 忽略。 */
        userPrompt?: string;
        /** Maker Memory 启用 flag; 仅 lazy-create 时生效, 已 spawn 的 session 忽略。 */
        makerMemoryEnabled?: boolean;
        displayReasoning?: 'off' | 'summarized' | 'full';
        vendorOptions?: Record<string, unknown>;
        resumeSessionId?: string;
      },
      sendOpts?: {
        /** 这条消息的 SDK uuid (renderer 与 messages.agent_meta.uuid 同源, rewind 锚点)。 */
        messageUuid?: string;
        /** 当前用户的展示名 (个人化 turn-start status: "<name> Just Wait ...")。 */
        userName?: string;
        /** Codex renderer 队列路径需要“已接受或已拒绝”的语义,再决定是否落库。 */
        throwOnStartFailure?: boolean;
        /** Direct Continue fallback:执行端在 dispatch 成功后确认旧中断。 */
        ackInterruptedTurnOnDispatch?: boolean;
      },
    ): Promise<{ accepted: true } | { accepted: false; reason?: string }> =>
      ipcRenderer.invoke('maker:send', sessionId, message, createOpts, sendOpts),

    steer: (
      sessionId: string,
      message: string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> },
      sendOpts?: {
        /** 这条消息的 SDK uuid (renderer 与 messages.agent_meta.uuid 同源, rewind 锚点)。 */
        messageUuid?: string;
        /** 当前用户的展示名 (个人化 turn-start status: "<name> Just Wait ...")。 */
        userName?: string;
      },
    ): Promise<void> => ipcRenderer.invoke('maker:steer', sessionId, message, sendOpts),

    getContextUsage: (
      sessionId: string,
      createOpts?: {
        agentKind: 'claude-code' | 'codex';
        workingDir: string;
        model: string;
        orcaRole?: 'lead' | 'worker' | null;
        effort?: string;
        fastMode?: boolean;
        permissionMode?: string;
        /** 计划模式一级开关(与 permissionMode 正交)。 */
        planMode?: boolean;
        userPrompt?: string;
        makerMemoryEnabled?: boolean;
        extraDirs?: string[];
        displayReasoning?: 'off' | 'summarized' | 'full';
        vendorOptions?: Record<string, unknown>;
        remoteHostId?: string;
        resumeSessionId?: string;
      },
    ): Promise<import('@cindy/maker-core').ContextUsageData> =>
      ipcRenderer.invoke('maker:get-context-usage', sessionId, createOpts),

    abortSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('maker:abort-session', sessionId),

    // preserveWorkspace: 软重启语义(/clear、鉴权重连)——close 不触发 worktree
    // 回收 / 临时附件清理等 onClose 重副作用,会话逻辑上还活着。
    closeSession: (sessionId: string, opts?: { preserveWorkspace?: boolean }): Promise<void> =>
      ipcRenderer.invoke('maker:close-session', sessionId, opts),

    /** 删除 user 目标行或 assistant 所属整轮输出，并从剩余本地历史重建 Agent 上下文。 */
    deleteMessage: (
      sessionId: string,
      clientId: string,
    ): Promise<{ sessionId: string; clientId: string; clientIds: string[] }> =>
      ipcRenderer.invoke('maker:message:delete', sessionId, clientId),

    listActive: (): Promise<Array<{
      sessionId: string;
      agentKind: 'claude-code' | 'codex';
      workDir: string;
      capabilities: unknown;
      isTurnRunning: boolean;
    }>> => ipcRenderer.invoke('maker:list-active'),

    resolveInteraction: (
      requestId: string,
      // InteractionDecision union (permission/ask_user_question/plan_review,按 kind 分支)
      decision: Record<string, unknown>,
    ): Promise<void> => ipcRenderer.invoke('maker:resolve-interaction', requestId, decision),

    // 快照:某会话当前挂起的交互(permission/ask/plan)。打开/重连/刷新会话时拉一次重建面板
    // —— pending 状态原本只由实时 INTERACTION_REQUEST push 设置,后加入的窗口靠它补回。
    getPendingInteractions: (
      sessionId: string,
    ): Promise<Array<{ request: { kind: string; requestId: string; [k: string]: unknown }; persistId?: string }>> =>
      ipcRenderer.invoke('maker:get-pending-interactions', sessionId),

    // ── 运行时切换 (Stage 2 B) ─────────────────────────────────────────────
    // session 不存在(没 send 过/已 close)时 main 侧 no-op,renderer 可乐观调用。
    // providerId 可选 —— 选了某供应商的模型时一并传,决定本会话路由到哪个上游/钥匙。
    // 不传 = 不改动该会话的供应商选择(老调用兼容);传 null = 清除选择回落默认路由。
    // 返回 { deferred } —— deferred=true 表示会话自己在跑 turn,凭证切换已登记为
    // pending、turn 结束自动生效(renderer 据此提示"任务结束后生效")。旧被控端 /
    // 老 host 可能返回 undefined,调用方按非 deferred 处理。
    setModel: (
      sessionId: string,
      model: string,
      providerId?: string | null,
    ): Promise<{ deferred: boolean } | undefined> =>
      ipcRenderer.invoke('maker:set-model', sessionId, model, providerId),
    // session-agent-switch:同一会话切换 agent 引擎(claude-code ↔ codex)。
    // 与 setModel 的边界:同引擎换模型走 setModel,跨引擎必须走本方法。
    // 意图制:本调用只登记切换意图(deferred=true 为常态返回),真正的交接与
    // 引擎重建在下一条消息发送时刻执行;effort/fastMode 为目标引擎下应生效的值
    // (renderer 按目标目录与预设解析好带入,apply 时一并落库)。
    // switched=false 且无 deferred = 同引擎 no-op(用户选回当前引擎,意图已清)。
    switchSessionAgent: (
      sessionId: string,
      targetAgentKind: 'claude-code' | 'codex',
      model: string,
      providerId?: string | null,
      effort?: string,
      fastMode?: boolean,
    ): Promise<{ switched: boolean; agentKind: 'claude-code' | 'codex'; model: string; engineReady: boolean; deferred?: boolean }> =>
      ipcRenderer.invoke('maker:switch-session-agent', sessionId, targetAgentKind, model, providerId, effort, fastMode),
    // effort/mode 透传 string —— 合法值由 maker capabilities 在运行时校验,
    // preload 不重复枚举 (避免 capabilities 加新值时这里也要改)。
    setEffort: (sessionId: string, effort: string): Promise<void> =>
      ipcRenderer.invoke('maker:set-effort', sessionId, effort),
    setPermissionMode: (sessionId: string, mode: string): Promise<void> =>
      ipcRenderer.invoke('maker:set-permission-mode', sessionId, mode),
    setFastMode: (sessionId: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('maker:set-fast-mode', sessionId, enabled),
    // 计划模式一级开关(与 permissionMode 正交)。runtime-only; DB 持久化由 renderer
    // 同步调 sessionService.update({ planModeEnabled })(与 setModel 双 IPC 协调先例一致)。
    setPlanMode: (sessionId: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('maker:set-plan-mode', sessionId, enabled),
    // 附加只读引用目录的 closure 推送; DB 持久化由 renderer 同步调
    // sessionService.update({ extraDirs }) (跟 setModel + sessionService.update 双 IPC 协调先例一致)。
    // session 不在 / agent capability=false 都 no-op, 不会抛错。
    setExtraDirs: (sessionId: string, dirs: string[]): Promise<void> =>
      ipcRenderer.invoke('maker:set-extra-dirs', sessionId, dirs),

    // Memory 控制 (Personalization → Memory section)。
    // 由 BaseAgent 子类落地; UI 层负责 Reset 前 confirm dialog。
    memoryGet: (agentKind: 'claude-code' | 'codex'): Promise<{
      enabled: boolean;
      source: 'agent-default' | 'host-runtime' | 'user-config';
      stats?: { entryCount?: number; sizeBytes?: number; storagePath?: string };
    }> => ipcRenderer.invoke('maker:memory:get', agentKind),
    memorySet: (
      agentKind: 'claude-code' | 'codex',
      enabled: boolean,
    ): Promise<{
      effective: 'immediate' | 'next-session';
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean };
    }> =>
      ipcRenderer.invoke('maker:memory:set', agentKind, enabled),
    memoryReset: (agentKind: 'claude-code' | 'codex'): Promise<{
      removedEntries?: number;
      removedBytes?: number;
    }> => ipcRenderer.invoke('maker:memory:reset', agentKind),

    /**
     * 立即开启/关闭 Maker Memory — manager.enable()/disable() 在 main 立即跑,
     * 联动调各 agent.setMemory(false) 关原生 (enable 时); disable 不主动恢复 native。
     * 返回 effective: 'next-session' (新 session 才注入 prompt 段, 这是 SDK 限制)。
     * codexRestartDeferred: true = 本地 Codex 会话正忙, 存活会话的软重启延迟到
     * 任务结束后自动补做 (设置本身已生效, UI 据此提示生效时机)。
     */
    makerMemorySetEnabled: (enabled: boolean): Promise<{
      effective: 'next-session';
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean };
      codexRestartDeferred: boolean;
    }> =>
      ipcRenderer.invoke('maker:maker-memory:set-enabled', enabled),

    /** Maker Memory 整库重置: 删 <userData>/maker-memory/ 全部 workdir 目录 + close db pool */
    makerMemoryReset: (): Promise<{ removedCount: number }> =>
      ipcRenderer.invoke('maker:maker-memory:reset'),

    /**
     * 启动期同步三个 memory 开关的真实持久化值 (main <userData>/memory-settings.json)。
     * renderer localStorage 只是 UI 即时态镜像 — 启动时调一次, main 是 source of truth。
     */
    memoryGetSettings: (): Promise<{ maker: boolean; claudeCode: boolean; codex: boolean }> =>
      ipcRenderer.invoke('maker:memory:get-settings'),
    memoryGetSettingsState: (): Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean };
    }> =>
      ipcRenderer.invoke('maker:memory:get-settings-state'),
    /** 启动期迁移旧版 renderer/native memory opt-out；null 表示 renderer marker 缺失。 */
    memoryPreserveLegacyMakerDisabled: (legacyRendererValue: boolean | null): Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }> =>
      ipcRenderer.invoke('maker:memory:preserve-legacy-maker-disabled', legacyRendererValue),
    memoryResetSettings: (): Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean };
      codexRestartDeferred: boolean;
    }> =>
      ipcRenderer.invoke('maker:memory:reset-settings'),

    /** IM 新会话默认 agent/model/effort/provider。仅影响新 IM session 和 Feishu `/new`。 */
    imDefaultSettingsGet: (): Promise<ImDefaultSettingsState> =>
      ipcRenderer.invoke('maker:im-default-settings:get'),
    imDefaultSettingsSet: (
      patch: ImDefaultSettingsPatch,
    ): Promise<ImDefaultSettingsState> =>
      ipcRenderer.invoke('maker:im-default-settings:set', patch),
    imDefaultSettingsReset: (): Promise<ImDefaultSettingsState> =>
      ipcRenderer.invoke('maker:im-default-settings:reset'),

    /** 子代理模型覆盖。null 表示不注入覆盖，仅对新建 agent 会话生效。 */
    subagentModelSettingsGet: (): Promise<SubagentModelSettingsState> =>
      ipcRenderer.invoke('maker:subagent-model-settings:get'),
    subagentModelSettingsSet: (
      patch: SubagentModelSettingsPatch,
    ): Promise<SubagentModelSettingsState> =>
      ipcRenderer.invoke('maker:subagent-model-settings:set', patch),
    subagentModelSettingsReset: (): Promise<SubagentModelSettingsState> =>
      ipcRenderer.invoke('maker:subagent-model-settings:reset'),

    silentEncryptedRetryGet: (): Promise<{ enabled: boolean; isCustomized?: boolean; defaultEnabled?: boolean }> =>
      ipcRenderer.invoke('maker:silent-encrypted-retry:get'),
    silentEncryptedRetrySet: (enabled: boolean): Promise<{ enabled: boolean; isCustomized: boolean; defaultEnabled: boolean; effective: 'immediate' }> =>
      ipcRenderer.invoke('maker:silent-encrypted-retry:set', enabled),
    silentEncryptedRetryReset: (): Promise<{ enabled: boolean; isCustomized: boolean; defaultEnabled: boolean; effective: 'immediate' }> =>
      ipcRenderer.invoke('maker:silent-encrypted-retry:reset'),

    // Claude Code 自动上下文压缩阈值。仅对新建会话生效。
    compactionGetPct: (): Promise<number> =>
      ipcRenderer.invoke('maker:compaction:get-pct'),
    compactionGetState: (): Promise<{ pct: number; isCustomized: boolean; defaultPct: number }> =>
      ipcRenderer.invoke('maker:compaction:get-state'),
    compactionSetPct: (pct: number): Promise<{ pct: number; isCustomized: boolean; defaultPct: number }> =>
      ipcRenderer.invoke('maker:compaction:set-pct', pct),
    compactionResetPct: (): Promise<{ pct: number; isCustomized: boolean; defaultPct: number }> =>
      ipcRenderer.invoke('maker:compaction:reset-pct'),

    // LSP Beta 开关 —— 控制 mcp providers 是否注入 lsp_* 工具 (Phase 1 Beta)。
    // 默认 false; 仅对**新 session** 生效, 已开 session 工具列表已固化, 不变。
    lspModeGet: (): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke('maker:lsp-mode:get'),
    lspModeSet: (enabled: boolean): Promise<{ effective: 'next-session' }> =>
      ipcRenderer.invoke('maker:lsp-mode:set', enabled),

    // 聊天嵌入开关 —— 控制 chat-history-embedder 是否对新消息入队嵌入。
    // 默认 false; 关闭状态下零成本 (createMessage hook 在 enabled 守卫处直接 return)。
    chatEmbeddingGet: (): Promise<{ enabled: boolean; isCustomized?: boolean; defaultEnabled?: boolean }> =>
      ipcRenderer.invoke('maker:chat-embedding:get'),
    chatEmbeddingSet: (enabled: boolean): Promise<{ enabled: boolean; isCustomized: boolean; defaultEnabled: boolean }> =>
      ipcRenderer.invoke('maker:chat-embedding:set', enabled),
    chatEmbeddingReset: (): Promise<{ enabled: boolean; isCustomized: boolean; defaultEnabled: boolean }> =>
      ipcRenderer.invoke('maker:chat-embedding:reset'),

    // Git safety workflow —— 控制 turn end 自动 XDT snapshot commit。
    // 默认 false; Codex rewind 按钮跟随该开关显示。
    gitSafetyGet: (): Promise<{
      autoSnapshotEnabled: boolean;
      isCustomized: boolean;
      defaultAutoSnapshotEnabled: boolean;
    }> => ipcRenderer.invoke('maker:git-safety:get'),
    gitSafetySet: (enabled: boolean): Promise<{
      autoSnapshotEnabled: boolean;
      isCustomized: boolean;
      defaultAutoSnapshotEnabled: boolean;
    }> => ipcRenderer.invoke('maker:git-safety:set', enabled),
    gitSafetyReset: (): Promise<{
      autoSnapshotEnabled: boolean;
      isCustomized: boolean;
      defaultAutoSnapshotEnabled: boolean;
    }> => ipcRenderer.invoke('maker:git-safety:reset'),

    // 智能通讯录(maker-contacts)—— 设置页管理 UI 的数据通道。
    // DTO 形状即 @cindy/maker-core contacts/types.ts(renderer 直接 type-import),
    // 这里保持 unknown 透传, 类型收敛在 renderer service 层做。
    // 开关只 gate agent 侧 cindy_contacts MCP; 数据通道恒可用。
    contacts: {
      settingsGet: (): Promise<{ enabled: boolean; isCustomized: boolean }> =>
        ipcRenderer.invoke('maker:contacts:settings:get'),
      // codexMcpRefreshed:false = 开关已落盘但 Codex 失效失败(会话正忙), 对 Codex 延迟生效
      settingsSet: (enabled: boolean): Promise<{ enabled: boolean; codexMcpRefreshed?: boolean }> =>
        ipcRenderer.invoke('maker:contacts:settings:set', enabled),
      list: (opts?: unknown): Promise<unknown[]> => ipcRenderer.invoke('maker:contacts:list', opts),
      get: (id: string): Promise<unknown> => ipcRenderer.invoke('maker:contacts:get', id),
      create: (input: unknown): Promise<unknown> => ipcRenderer.invoke('maker:contacts:create', input),
      update: (id: string, patch: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:update', id, patch),
      delete: (id: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke('maker:contacts:delete', id),
      merge: (targetId: string, sourceId: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:merge', targetId, sourceId),
      resolve: (value: string, opts?: unknown): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:contacts:resolve', value, opts),
      search: (query: string, opts?: unknown): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:contacts:search', query, opts),
      stats: (): Promise<{ people: number; orgs: number; pending: number; groups: number }> =>
        ipcRenderer.invoke('maker:contacts:stats'),
      addIdentity: (contactId: string, input: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:add-identity', contactId, input),
      removeIdentity: (identityId: string): Promise<{ removed: boolean }> =>
        ipcRenderer.invoke('maker:contacts:remove-identity', identityId),
      appendEvent: (contactId: string, input: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:append-event', contactId, input),
      deleteEvent: (eventId: string): Promise<{ deleted: boolean }> =>
        ipcRenderer.invoke('maker:contacts:delete-event', eventId),
      addRelation: (fromId: string, input: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:add-relation', fromId, input),
      removeRelation: (relationId: string): Promise<{ removed: boolean }> =>
        ipcRenderer.invoke('maker:contacts:remove-relation', relationId),
      groupsList: (): Promise<unknown[]> => ipcRenderer.invoke('maker:contacts:groups:list'),
      groupsCreate: (name: string, description?: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:groups:create', name, description),
      groupsUpdate: (groupId: string, patch: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:groups:update', groupId, patch),
      groupsDelete: (groupId: string): Promise<{ deleted: boolean }> =>
        ipcRenderer.invoke('maker:contacts:groups:delete', groupId),
      groupsSetMembers: (
        groupId: string,
        payload: { add?: string[]; remove?: string[] },
      ): Promise<{ added: number; removed: number }> =>
        ipcRenderer.invoke('maker:contacts:groups:set-members', groupId, payload),
      resetAll: (): Promise<{ removedCount: number }> => ipcRenderer.invoke('maker:contacts:reset-all'),
      systemRead: (): Promise<unknown[]> => ipcRenderer.invoke('maker:contacts:system-read'),
      parseVcf: (text: string): Promise<unknown[]> => ipcRenderer.invoke('maker:contacts:parse-vcf', text),
      import: (records: unknown[], opts?: { groupId?: string }): Promise<unknown> =>
        ipcRenderer.invoke('maker:contacts:import', records, opts),
      onChanged: createIpcFanOut('maker:contacts:changed'),
    },

    // Codex app-server 当前进程启动冻结的鉴权注入方式(oauth-bearer = 走订阅 / env-key = 走网关 / provider-oauth = proxy 注入供应商 OAuth)。
    // 右下角用量 chip 据此显示订阅/API 计费形态。退役全局鉴权开关后无 SET。
    codexRuntimeRouteGet: (): Promise<{
      authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth';
    }> => ipcRenderer.invoke('maker:codex-runtime-route:get'),
    onCodexRuntimeRouteChanged: fanOutMakerCodexRuntimeRouteChanged,
    // 延迟凭证切换兑现(见 setModel deferred):清"任务结束后生效"标记 / 会话内轻提示。
    onSessionCredentialSwitchApplied: fanOutMakerSessionCredentialSwitchApplied,

    // cc 默认路由会话的生效计费路由(proxy 按请求观察): 'gateway' | 'subscription' |
    // null(会话尚未发过请求)。用量 chip 优先用它显示订阅/网关形态。
    claudeSessionRouteGet: (sessionId: string): Promise<'gateway' | 'subscription' | null> =>
      ipcRenderer.invoke('maker:claude-session-route:get', sessionId),
    onClaudeSessionRouteChanged: fanOutMakerClaudeSessionRouteChanged,

    // Claude.ai 订阅 OAuth 登录(浏览器流程,凭证落系统 ~/.claude,与本地 claude 共用)。
    // 与鉴权模式开关正交。LOGIN 拉浏览器、成功写凭证;LOGOUT 清凭证(同时登出本地 claude);
    // CANCEL 取消进行中登录;STATUS 回 { authorized }。
    claudeOAuthStatus: (): Promise<{ authorized: boolean }> =>
      ipcRenderer.invoke('maker:claude-oauth:status'),
    claudeOAuthLogin: (): Promise<{ ok: boolean; authorized: boolean; reason?: string }> =>
      ipcRenderer.invoke('maker:claude-oauth:login'),
    claudeOAuthLogout: (): Promise<{ authorized: boolean }> =>
      ipcRenderer.invoke('maker:claude-oauth:logout'),
    claudeOAuthCancel: (): Promise<{ authorized: boolean }> =>
      ipcRenderer.invoke('maker:claude-oauth:cancel'),

    // xAI(SuperGrok 订阅)OAuth —— 与 claudeOAuth* 同形态。
    xaiOAuthLogin: (): Promise<{ ok: boolean; authorized: boolean; reason?: string }> =>
      ipcRenderer.invoke('maker:xai-oauth:login'),
    xaiOAuthLogout: (): Promise<{ authorized: boolean }> =>
      ipcRenderer.invoke('maker:xai-oauth:logout'),
    xaiOAuthCancel: (): Promise<{ authorized: boolean }> =>
      ipcRenderer.invoke('maker:xai-oauth:cancel'),

    // 事件订阅
    onEvent: fanOutMakerEvent,
    onStatusChanged: fanOutMakerStatusChanged,
    onInputProjection: fanOutMakerInputProjection,
    onInteractionRequest: fanOutMakerInteractionRequest,
    onInteractionDismissed: fanOutMakerInteractionDismissed,

    // HMR 兜底: contextBridge 跨 context 不保证返回的 unsubscribe proxy 可调,
    // 所以 makerChatStore 的 import.meta.hot.dispose 调 unsub 不一定真把旧
    // callback 从 fanOut Set 里删掉。新模块加载时强制 reset 这 4 个 fanOut,
    // 把残留旧 callback 全清零, 然后让新模块的 initGlobalListeners 重新注册。
    // dev-only 调用, prod renderer 不会 HMR 也不会调。
    __resetMakerFanOuts: (): void => {
      fanOutMakerEvent.__reset();
      fanOutMakerStatusChanged.__reset();
      fanOutMakerInputProjection.__reset();
      fanOutMakerInteractionRequest.__reset();
      fanOutMakerInteractionDismissed.__reset();
    },

    input: {
      getProjection: (sessionId: string): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:get-projection', sessionId),
      enqueue: (
        sessionId: string,
        item: import('../shared/agentInputQueue').AgentInputQueuedMessage,
        opts?: { sendAtMs?: number },
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:enqueue', sessionId, item, opts),
      compact: (
        sessionId: string,
        createOpts: import('../shared/agentInputQueue').AgentInputCreateOpts,
        opts?: { userName?: string },
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:compact', sessionId, createOpts, opts),
      steer: (
        sessionId: string,
        item: import('../shared/agentInputQueue').AgentInputQueuedMessage,
        opts?: { removeFromQueue?: boolean; touchUserSend?: boolean },
      ): Promise<boolean> =>
        ipcRenderer.invoke('maker:input:steer', sessionId, item, opts),
      stop: (
        sessionId: string,
        opts?: { keepQueue?: boolean; pauseQueue?: boolean },
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:stop', sessionId, opts),
      resume: (sessionId: string): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:resume', sessionId),
      retryLastError: (sessionId: string): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:retry-last-error', sessionId),
      clearError: (sessionId: string): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:clear-error', sessionId),
      persistTurnErrorDeferred: (sessionId: string, errData: Record<string, unknown> | null, agentMeta?: import('../renderer/lib/ccAgent.types').AgentMeta | null): Promise<void> =>
        ipcRenderer.invoke('maker:persist-turn-error-deferred', sessionId, errData, agentMeta ?? null),
      remove: (sessionId: string, clientId: string): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:remove', sessionId, clientId),
      updateText: (
        sessionId: string,
        clientId: string,
        newText: string,
        sessionRefs?: import('../shared/agentInputQueue').AgentInputSessionRef[],
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:update-text', sessionId, clientId, newText, sessionRefs),
      move: (
        sessionId: string,
        clientId: string,
        targetIndex: number,
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:move', sessionId, clientId, targetIndex),
      setExpanded: (sessionId: string, expanded: boolean): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:set-expanded', sessionId, expanded),
      setInteractionLock: (
        sessionId: string,
        lockId: string,
        locked: boolean,
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:set-interaction-lock', sessionId, lockId, locked),
      setEditLock: (
        sessionId: string,
        clientId: string,
        locked: boolean,
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:set-edit-lock', sessionId, clientId, locked),
      clearSession: (
        sessionId: string,
        clearedAt?: string,
      ): Promise<import('../shared/agentInputQueue').AgentInputProjection> =>
        ipcRenderer.invoke('maker:input:clear-session', sessionId, clearedAt),
    },

    // Stage 2 C1: chat utility (前身 cc-agent:generate-title / cc-agent:plan-file-write)
    generateTitle: (message: string, agentKind: 'claude-code' | 'codex', sessionId?: string): Promise<{ title: string | null }> =>
      ipcRenderer.invoke('maker:generate-title', { message, agentKind, sessionId }),
    // 重命名输入框 Magic 按钮:按会话最新对话内容重新生成标题(素材由 main 读 DB)
    regenerateSessionTitle: (sessionId: string): Promise<{ title: string | null }> =>
      ipcRenderer.invoke('maker:regenerate-title', { sessionId }),
    helpAsk: (
      request: import('../shared/helpTypes').HelpAskRequest,
    ): Promise<import('../shared/helpTypes').HelpAnswerResult> =>
      ipcRenderer.invoke('maker:help:ask', request),
    helpFeedbackCreate: (
      input: import('../shared/helpTypes').HelpFeedbackDraftInput,
    ): Promise<import('../shared/helpTypes').HelpFeedbackDraft> =>
      ipcRenderer.invoke('maker:help:feedback:create', input),
    writePlanFile: (params: {
      requestId: string;
      planFilePath: string;
      content: string;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('maker:write-plan-file', params),

    // Stage 2 C2: rewind / fork (前身 cc-agent:rewind:* + local-db:sessions:fork)
    // SDK 调用全部走 maker-core; main/maker-orchestration/{rewind,fork}.ts 只剩 DB 业务编排。
    rewindPreview: (
      sessionId: string,
      clientId: string,
    ): Promise<{
      canRewind: boolean;
      error?: string;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
    }> => ipcRenderer.invoke('maker:rewind:preview', sessionId, clientId),
    rewindCommit: (
      sessionId: string,
      clientId: string,
      opts?: { requireLatestUser?: boolean; stopIfRunning?: boolean },
    ): Promise<unknown> =>
      ipcRenderer.invoke('maker:rewind:commit', sessionId, clientId, opts),
    fork: (sourceSessionId: string, messageClientId: string): Promise<unknown> =>
      ipcRenderer.invoke('maker:fork', sourceSessionId, messageClientId),
    forkStripEncrypted: (sourceSessionId: string): Promise<unknown> =>
      ipcRenderer.invoke('maker:fork-strip-encrypted', sourceSessionId),

    // ── Agent 鉴权 (取代老 electronAPI.codex.auth.*) ────────────────────────
    auth: {
      getState: (agentKind: 'claude-code' | 'codex'): Promise<unknown> =>
        ipcRenderer.invoke('maker:auth:get-state', agentKind),
      triggerLogin: (agentKind: 'claude-code' | 'codex'): Promise<unknown> =>
        ipcRenderer.invoke('maker:auth:trigger-login', agentKind),
      cancelLogin: (agentKind: 'claude-code' | 'codex'): Promise<void> =>
        ipcRenderer.invoke('maker:auth:cancel-login', agentKind),
      logout: (agentKind: 'claude-code' | 'codex'): Promise<void> =>
        ipcRenderer.invoke('maker:auth:logout', agentKind),
      onStateChanged: fanOutMakerAuthStateChanged,
      onLoginProgress: fanOutMakerAuthLoginProgress,
    },

    // ── Agent 联合状态 (取代老 electronAPI.codex.binary.getStatus) ──────────
    agent: {
      getStatus: (agentKind: 'claude-code' | 'codex'): Promise<unknown> =>
        ipcRenderer.invoke('maker:agent:status', agentKind),
      /** spawn 当前应用使用的 binary `--version`, 进程内缓存。About 面板用。 */
      getBinaryVersion: (agentKind: 'claude-code' | 'codex'): Promise<{
        kind: 'claude-code' | 'codex';
        binaryPath: string | null;
        version: string | null;
        error?: string;
      }> => ipcRenderer.invoke('maker:agent:binary-version', agentKind),
    },

    // ── Agent 今日累计 (取代老 electronAPI.codex.usage.* + electronAPI.onUsageTodaySpendChanged) ─
    usage: {
      getToday: (agentKind: 'claude-code' | 'codex'): Promise<unknown> =>
        ipcRenderer.invoke('maker:usage:today', agentKind),
      getAccount: (agentKind: 'claude-code' | 'codex'): Promise<unknown> =>
        ipcRenderer.invoke('maker:usage:account', agentKind),
      /** Claude 订阅账号余量 (5h/周/分模型窗口, cached-first, main 侧按需后台刷新)。 */
      getClaudeSubscription: (): Promise<unknown | null> =>
        ipcRenderer.invoke('maker:usage:claude-subscription'),
      /** 模型单价表 (LiteLLM /model_group/info, main 端内存 + 磁盘缓存)。失败时 null。 */
      getModelPricing: (): Promise<unknown | null> =>
        ipcRenderer.invoke('maker:usage:model-pricing'),
      /** 用量历史聚合 (首页仪表盘: 热力图 + streak + 按模型拆分, main 侧算好)。 */
      getHistory: (opts?: { days?: number; forceRefresh?: boolean }): Promise<unknown> =>
        ipcRenderer.invoke('maker:usage:history', opts),
      /** Claude USD 推送 (per-turn, agentKind=claude-code 时订阅它)。 */
      onTodaySpendChanged: fanOutMakerUsageTodaySpend,
      /** Codex token 推送 (per-turn, agentKind=codex 时订阅它)。 */
      onTodayTokensChanged: fanOutMakerUsageTodayTokens,
      /** Claude 月度配额推送 (turn done 后 best-effort fetch, agentKind=claude-code 时订阅)。 */
      onClaudeAccountChanged: fanOutMakerUsageClaudeAccount,
      /** Codex 订阅用量推送 (WHAM 后台刷新成功后 best-effort 推送)。 */
      onCodexAccountChanged: fanOutMakerUsageCodexAccount,
      /** xAI(SuperGrok bridge)限流快照推送 (bridge 每个成功上游响应解析 x-ratelimit-* 后推送)。 */
      onXaiRateLimitChanged: fanOutMakerUsageXaiRateLimit,
      /** Claude 订阅余量推送 (端点后台刷新 / proxy 旁路 headers 更新时推送)。 */
      onClaudeSubscriptionChanged: fanOutMakerUsageClaudeSubscription,
    },

    // ── Scheduler (Phase 4) ────────────────────────────────────────────────
    // 写入路径全部走 scheduler 实例（main/scheduler-host:64）；renderer 不直接操作
    // schedules 表。`Schedule` / `ScheduleRun` / `CreateScheduleInput` 等 wire 形态
    // 与 `@cindy/maker-scheduler` types.ts 完全同形，preload 不在这里重声明。
    schedule: {
      list: (filter?: { status?: 'active' | 'paused' | 'expired' }): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:schedule:list', filter),
      listTemplates: (): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:schedule:list-templates'),
      createFromTemplate: (params: {
        templateId: string;
        paramValues?: Record<string, string>;
        overrides?: unknown;
      }): Promise<unknown> =>
        ipcRenderer.invoke('maker:schedule:create-from-template', params),
      get: (id: string): Promise<unknown | null> =>
        ipcRenderer.invoke('maker:schedule:get', id),
      create: (input: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:schedule:create', input),
      update: (id: string, patch: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:schedule:update', id, patch),
      delete: (id: string): Promise<void> =>
        ipcRenderer.invoke('maker:schedule:delete', id),
      pause: (id: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:schedule:pause', id),
      resume: (id: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:schedule:resume', id),
      runNow: (id: string): Promise<{ runId: string }> =>
        ipcRenderer.invoke('maker:schedule:run-now', id),
      /** script 任务能力选择器:各能力的运行时可用性(依赖意识的装入/唤醒态)。 */
      scriptCapabilityStatus: (): Promise<{
        statuses: Array<{ capability: string; state: 'ok' | 'ghost-missing' | 'ghost-asleep'; ghostName?: string }>;
      }> => ipcRenderer.invoke('maker:schedule:script-capability-status'),
      /** 表单「测试运行」:立即执行一次前置检查脚本,返回判定 / exit code / 输出 / 耗时。 */
      testPreRunHook: (params: {
        command: string;
        timeoutMs?: number;
        workingDir?: string;
        /** 绑定会话任务:workingDir 空时 main 按会话 meta.workDir 解析测试 cwd(与生产一致)。 */
        targetSessionId?: string;
        scheduleName?: string;
      }): Promise<{
        status: 'passed' | 'skipped' | 'failed' | 'timed_out' | 'aborted';
        decision: 'run' | 'skip' | 'block';
        exitCode: number | null;
        durationMs: number;
        stdout: string;
        stderr: string;
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
        timedOut: boolean;
        aborted: boolean;
        spawnError?: string;
        error?: string;
      }> => ipcRenderer.invoke('maker:schedule:test-pre-run-hook', params),
      /** 表单「AI 生成」:生成前置检查脚本并落盘(落盘即自测),返回可填入的命令 + 自测结果。 */
      generatePreRunHook: (params: {
        description: string;
        scheduleName?: string;
        workingDir?: string;
        providerId?: string;
        agentKind?: 'claude-code' | 'codex';
        model?: string;
        /** 绑定会话任务:workingDir 空时 main 按会话 meta.workDir 解析落盘/自测目录。 */
        targetSessionId?: string;
        currentCommand?: string;
      }): Promise<{
        ok: true;
        command: string;
        filePath: string;
        content: string;
        test: {
          status: 'passed' | 'skipped' | 'failed' | 'timed_out' | 'aborted';
          decision: 'run' | 'skip' | 'block';
          exitCode: number | null;
          durationMs: number;
          stdout: string;
          stderr: string;
          stdoutTruncated: boolean;
          stderrTruncated: boolean;
          timedOut: boolean;
          aborted: boolean;
          spawnError?: string;
          error?: string;
        };
      } | UtilityTextFailure> => ipcRenderer.invoke('maker:schedule:generate-pre-run-hook', params),
      listRuns: (id: string, limit?: number): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:schedule:list-runs', id, limit),
      listSidebarIndexRuns: (): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:schedule:list-sidebar-index-runs'),
      listCostSummaries: (): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:schedule:list-cost-summaries'),
      deleteRun: (runId: string): Promise<void> =>
        ipcRenderer.invoke('maker:schedule:delete-run', runId),
      /** delete/pause 前查这条 schedule 当前 in-flight run 数,>0 时 renderer 弹二次确认。 */
      getInflightCount: (id: string): Promise<number> =>
        ipcRenderer.invoke('maker:schedule:get-inflight-count', id),
      /** 当前 Scheduler 实例的 in-flight / 并发等待瞬时快照。 */
      getRuntimeState: (): Promise<unknown> =>
        ipcRenderer.invoke('maker:schedule:get-runtime-state'),
      /** Sidebar Automations badge 用：全局未读 run 数。 */
      getUnreadRunCount: (): Promise<number> =>
        ipcRenderer.invoke('maker:schedule:get-unread-count'),
      /** 用户点 history 的 "Open session" 时调，把该单条 run 标已读。 */
      markRunRead: (runId: string): Promise<void> =>
        ipcRenderer.invoke('maker:schedule:mark-run-read', runId),
      /** sidebar 右键 "Automations" → "Mark all as read"：一次性把所有未读终态 run 标已读，返回受影响行数。 */
      markAllRunsRead: (): Promise<number> =>
        ipcRenderer.invoke('maker:schedule:mark-all-runs-read'),
      /** 用户查看某 schedule 的 run history 时，把该 schedule 下所有未读终态 run 标已读，返回受影响行数。 */
      markScheduleRunsRead: (scheduleId: string): Promise<number> =>
        ipcRenderer.invoke('maker:schedule:mark-schedule-runs-read', scheduleId),
      /**
       * 订阅 Scheduler 事件。payload 形态:
       *   { type: 'fired',     scheduleId, runId, silent? }
       *   { type: 'completed', scheduleId, runId, sessionId }
       *   { type: 'failed',    scheduleId, runId, error }
       *   { type: 'changed',   scheduleId }
       *   { type: 'read',      scheduleId }   // 主进程在 markRunsRead 后广播
       */
      onEvent: fanOutScheduleEvent,
    },

    projectAutomation: {
      reconcile: (params: { workingDir: string }): Promise<unknown> =>
        ipcRenderer.invoke('maker:project-automation:reconcile', params),
      listConsents: (): Promise<unknown[]> =>
        ipcRenderer.invoke('maker:project-automation:list-consents'),
      revokeConsent: (workingDir: string): Promise<{ deleted: number }> =>
        ipcRenderer.invoke('maker:project-automation:revoke-consent', { workingDir }),
      upsertSchedule: (params: { workingDir: string; config: unknown }): Promise<unknown> =>
        ipcRenderer.invoke('maker:project-automation:upsert-schedule', params),
      removeSchedule: (params: { workingDir: string; id: string }): Promise<unknown> =>
        ipcRenderer.invoke('maker:project-automation:remove-schedule', params),
      onEvent: fanOutProjectAutomationEvent,
    },

    // ── 跨 Agent 工作区互转（双向，5 项独立判断；进度 step 通过 push 流转）────
    crossAgent: {
      detect: (
        workingDir: string,
        agentKind: 'claude-code' | 'codex',
      ): Promise<{ items: CrossAgentMigrationItem[] }> =>
        ipcRenderer.invoke('maker:cross-agent:detect', workingDir, agentKind),
      convert: (
        items: CrossAgentMigrationItem[],
      ): Promise<{ total: number; successCount: number; skippedCount: number; failedCount: number }> =>
        ipcRenderer.invoke('maker:cross-agent:convert', items),
      onStep: fanOutCrossAgentStep,
    },

    // ── Plugin system (Phase 1) ──────────────────────────────────────────
    plugins: {
      list: (workingDir?: string): Promise<PluginListItem[]> =>
        ipcRenderer.invoke('maker:plugins:list', workingDir),
      getState: (id: string, workingDir?: string): Promise<PluginEnableState> =>
        ipcRenderer.invoke('maker:plugins:get-state', id, workingDir),
      setEnabled: (id: string, enabled: boolean): Promise<PluginEnableUpdateResult> =>
        ipcRenderer.invoke('maker:plugins:set-enabled', id, enabled),
      clearEnabled: (id: string): Promise<PluginEnableUpdateResult> =>
        ipcRenderer.invoke('maker:plugins:clear-enabled', id),
      setProjectEnabled: (workingDir: string, id: string, enabled: boolean): Promise<void> =>
        ipcRenderer.invoke('maker:plugins:set-project-enabled', workingDir, id, enabled),
      clearProjectEnabled: (workingDir: string, id: string): Promise<void> =>
        ipcRenderer.invoke('maker:plugins:clear-project-enabled', workingDir, id),
    },

    // ── Browser automation (Settings →「电脑使用」) ──────────────────────
    browser: {
      status: (): Promise<BrowserAvailability> =>
        ipcRenderer.invoke('maker:browser:status'),
      openForLogin: (): Promise<{ launched: boolean }> =>
        ipcRenderer.invoke('maker:browser:open-for-login'),
    },
    android: {
      status: (): Promise<AndroidStatusSummary> =>
        ipcRenderer.invoke('maker:android:status'),
      getConfig: (): Promise<AndroidAutomationConfigState> =>
        ipcRenderer.invoke('maker:android:get-config'),
      setDefaultDevice: (defaultDeviceSerial: string | null): Promise<AndroidAutomationConfigState> =>
        ipcRenderer.invoke('maker:android:set-default-device', { defaultDeviceSerial }),
      setAdbPath: (adbPathOverride: string | null): Promise<AndroidAutomationConfigState> =>
        ipcRenderer.invoke('maker:android:set-adb-path', { adbPathOverride }),
      prepareAdb: (): Promise<AndroidAdbPreparationState> =>
        ipcRenderer.invoke('maker:android:prepare-adb'),
    },
    computer: {
      status: (options?: ComputerDriverStatusOptions): Promise<ComputerDriverStatus> =>
        ipcRenderer.invoke('maker:computer:status', options),
      installDriver: (): Promise<ComputerDriverInstallResult> =>
        ipcRenderer.invoke('maker:computer:install-driver'),
      grantPermissions: (): Promise<ComputerDriverPermissionGrantResult> =>
        ipcRenderer.invoke('maker:computer:grant-permissions'),
      driverIcon: (): Promise<{ iconDataUrl: string | null }> =>
        ipcRenderer.invoke('maker:computer:driver-icon'),
      cancelPermissionGrant: (): Promise<{ cancelled: boolean }> =>
        ipcRenderer.invoke('maker:computer:cancel-permission-grant'),
      checkUpdate: (): Promise<ComputerDriverUpdateCheck> =>
        ipcRenderer.invoke('maker:computer:check-update'),
      updateDriver: (opts?: { joinOnly?: boolean }): Promise<ComputerDriverInstallResult> =>
        ipcRenderer.invoke('maker:computer:update-driver', opts),
      onUpdateProgress: fanOutComputerDriverUpdateProgress,
    },
  },

  // ── 剪贴板历史快捷面板 ────────────────────────────────────────────

});
