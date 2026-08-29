/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CINDY_AUTH_REGION: 'cn' | 'global' | 'dev';
  /** 当前构建区域的端点清单自举基址；业务端点走 electronAPI.clientEndpoints。 */
  readonly VITE_ENDPOINT_MANIFEST_BASE_URL: string;
  /** 另一物理区域的受信任端点清单自举基址。 */
  readonly VITE_ENDPOINT_MANIFEST_PEER_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type AgentProxyPrefPayload = import('../shared/agentProxyConfig').SshHostAgentProxyPref;
type AgentProxyTunnelStatePayload = import('../shared/agentProxyConfig').AgentProxyTunnelState;
type ModelAccessStatusPayload = import('../shared/modelAccess').ModelAccessStatus;
type AnalyticsSettingsPayload = import('../shared/analyticsSettings').AnalyticsSettingsPayload;
type LogUploadSettingsPayload = import('../shared/logUpload').LogUploadSettingsPayload;
type LogUploadResult = import('../shared/logUpload').LogUploadResult;
type RsbWindowCommand = import('../shared/rightSidebarWindow').RsbWindowCommand;
type VoiceInputPowerStatePayload =
  import('../shared/voiceInputPowerIpc').VoiceInputPowerStatePayload;
type VoiceInputConnectionTestResult =
  import('../shared/voiceInputConnectionTest').VoiceInputConnectionTestResult;
type DesktopLoginAction = import('../shared/authIpc').DesktopLoginAction;
type DesktopLoginActionResult = import('../shared/authIpc').DesktopLoginActionResult;
type UtilityTextFailure = import('../shared/utilityTextResult').UtilityTextFailure;
type IOSSimulatorSessionStatus = import('../shared/iosSimulatorIpc').IOSSimulatorSessionStatus;
type IOSSimulatorAccessRequest = import('../shared/iosSimulatorIpc').IOSSimulatorAccessRequest;
type IOSSimulatorAccessRequestResult =
  import('../shared/iosSimulatorIpc').IOSSimulatorAccessRequestResult;
type IOSSimulatorStatusRequest = import('../shared/iosSimulatorIpc').IOSSimulatorStatusRequest;
type IOSSimulatorToolRequest = import('../shared/iosSimulatorIpc').IOSSimulatorToolRequest;
type IOSSimulatorToolResponse = import('../shared/iosSimulatorIpc').IOSSimulatorToolResponse;
type IOSSimulatorAgentControlRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorAgentControlRequest;
type IOSSimulatorFocusRequest = import('../shared/iosSimulatorIpc').IOSSimulatorFocusRequest;
type IOSSimulatorH264FramePush = import('../shared/iosSimulatorIpc').IOSSimulatorH264FramePush;
type IOSSimulatorRouteStatusPush = import('../shared/iosSimulatorIpc').IOSSimulatorRouteStatusPush;
type IOSSimulatorLiveTouchRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorLiveTouchRequest;
type IOSSimulatorMutationControlRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorMutationControlRequest;
type IOSSimulatorViewerRouteRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorViewerRouteRequest;
type IOSSimulatorViewerVisibilityRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorViewerVisibilityRequest;
type IOSSimulatorRetryNativeRouteRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorRetryNativeRouteRequest;
type IOSSimulatorStreamProfileRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorStreamProfileRequest;
type ProviderRoutingPayload = import('@cindy/model-providers').Provider['routing'];
type MakerSessionTreeSnapshot = import('@cindy/maker-core').SessionTreeSnapshot;
type BrowserBackendHealth = import('../shared/browserBackend').BrowserBackendHealth;
type BrowserBackendRecoveryResult = import('../shared/browserBackend').BrowserBackendRecoveryResult;
type BrowserBackendSourceReadAccess = import('../shared/browserBackend').BrowserBackendSourceReadAccess;
type DesktopAccountDeletionConfirmInput =
  import('../shared/authIpc').DesktopAccountDeletionConfirmInput;
type DesktopAccountDeletionAvailabilityResult =
  import('../shared/authIpc').DesktopAccountDeletionAvailabilityResult;
type DesktopAccountDeletionChallengeResult =
  import('../shared/authIpc').DesktopAccountDeletionChallengeResult;
type DesktopAccountDeletionConfirmResult =
  import('../shared/authIpc').DesktopAccountDeletionConfirmResult;
type DesktopAccountDeletionStatusResult =
  import('../shared/authIpc').DesktopAccountDeletionStatusResult;
type DesktopAccountSwitcherSnapshot = import('../shared/authIpc').DesktopAccountSwitcherSnapshot;
type PendingRemotePrecreatedWorktree =
  import('../shared/remotePrecreatedWorktreeLedger').PendingRemotePrecreatedWorktree;
type PendingRemotePrecreatedWorktreeTarget =
  import('../shared/remotePrecreatedWorktreeLedger').PendingRemotePrecreatedWorktreeTarget;
type RemotePrecreatedWorktreeLedgerSnapshot =
  import('../shared/remotePrecreatedWorktreeLedger').RemotePrecreatedWorktreeLedgerSnapshot;
type RawReleaseNotesPayload = import('../shared/releaseNotesContent').RawReleaseNotes;
type WorkLouderCodexSettingsPatch =
  import('../shared/workLouderCodex').WorkLouderCodexSettingsPatch;
type WorkLouderCodexState = import('../shared/workLouderCodex').WorkLouderCodexState;
type WorkLouderCodexRendererAction =
  import('../shared/workLouderCodex').WorkLouderCodexRendererAction;

interface NewMakerWorktreeBranchPreferenceSnapshot {
  baseRepo: string;
  sourceBranch: string;
  revision: number;
}

/* ── Environment check ── */

interface EnvCheckResult {
  claudeCode: { status: 'passed' | 'failed'; path?: string; error?: string };
  codex: { status: 'passed' | 'failed' | 'skipped'; path?: string; error?: string };
  /** pi 可选实验 agent:failed 不影响 allPassed；本次启动会禁用 pi。 */
  pi?: { status: 'passed' | 'failed' | 'skipped'; path?: string; error?: string };
  /** bundled ripgrep(必需):failed 时 allPassed=false,splash 进失败态可重试 (#1956)。 */
  ripgrep?: { status: 'passed' | 'failed' | 'skipped'; error?: string };
  allPassed: boolean;
  platform: 'darwin' | 'win32' | 'linux';
}

// Voice-input wire types: re-export from voice-input-core to keep the IPC
// surface and the core package's contract in sync. `VoiceInputShortcut` is
// renderer-only (defined in voice-input/shortcut.ts) so it stays inline.
// HostSnapshot 来自 transport-only package; desktop main 端 wrap 时附加
// autoConnect / agentProxy 偏好字段 (本地 prefs, 不写入 ~/.ssh/config), 渲染层统一用
// 这个扩展类型即可一次拿到完整信息, 不必再为单个字段单独 IPC。
type RemoteHostSnapshot = import('@cindy/maker-remote-ssh').HostSnapshot & {
  autoConnect: boolean;
  /** Agent 流量经 SSH 隧道走本地 Proxy 的 per-host 配置; 未开启 → null。 */
  agentProxy: AgentProxyPrefPayload | null;
  /** 隧道实时状态 (main 进程内存态); 无记录 → null。 */
  agentProxyTunnel: AgentProxyTunnelStatePayload | null;
};
/** 设备互联:REST 设备视图(同 shared/deviceLinkIpc.ts DeviceLinkDeviceView) */
interface DeviceLinkDeviceInfo {
  cpuLabel?: string;
  memoryGb?: number;
  osVersion?: string;
  modelLabel?: string;
}

interface DeviceLinkDeviceView {
  deviceId: string;
  name: string;
  selfName?: string | null;
  deviceInfo?: DeviceLinkDeviceInfo | null;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
  busy: boolean;
  remoteControlEnabled: boolean;
  /** 本机是否允许主动控制该目标设备(控制端本地偏好)。 */
  controlEnabled: boolean;
  isSelf: boolean;
}

/** 设备互联:relay 连接问题(镜像 @cindy/device-link 的 DeviceLinkConnectionIssue) */
interface DeviceLinkConnectionIssuePayload {
  kind: 'auth-failed' | 'replaced' | 'too-many-connections' | 'version-mismatch' | 'unstable';
  closeCode?: number;
  detail?: string;
  at: number;
}

/** 设备互联:presence 推送快照 */
interface DeviceLinkPresenceSnapshot {
  deviceId: string;
  online: boolean;
  deviceName: string;
  selfName?: string | null;
  deviceInfo?: DeviceLinkDeviceInfo | null;
  platform: string;
  appVersion: string;
  lastSeenAt: number;
  remoteControlEnabled: boolean;
  busy: boolean;
}

/** .cshare 导入向导的预览数据(main 侧 SharePreview 的镜像)。 */
interface SessionSharePreview {
  title: string;
  agentKind: 'cc' | 'codex' | 'pi';
  workspaceKind: 'project' | 'dialogue';
  originalWorkingDir: string | null;
  exportedAt: string;
  appVersion: string;
  fidelity: 'full' | 'partial' | 'db-only';
  messageCount: number;
  mediaCount: number;
  /** 协同包携带的 Worker 会话数;普通包为 0。 */
  orcaWorkerCount: number;
}

interface LocalSshKeyInfo {
  privateKeyPath: string;
  pubkeyPath: string;
  type: string;
  comment: string;
  fingerprintSha256: string | null;
  inAgent: boolean;
  mtimeIso: string | null;
}
type AgentFailureReason = 'agent_unavailable' | 'bad_passphrase' | 'no_such_file' | 'other';
type RemoteAgentKind = import('@cindy/maker-remote-ssh').RemoteAgentKind;
type RemoteAgentProbe = import('@cindy/maker-remote-ssh').ProbeResult;
type RemoteAgentInstallResult = import('@cindy/maker-remote-ssh').InstallResult;
type RemoteAgentInstallProgress = import('@cindy/maker-remote-ssh').InstallProgressEvent;

interface RemoteAgentInstallProgressPush {
  hostId: string;
  agentKind: RemoteAgentKind;
  event: RemoteAgentInstallProgress;
}

interface RemoteAgentSilentInstallStatusPush {
  hostId: string;
  agentKind: RemoteAgentKind;
  phase: 'started' | 'progress' | 'done' | 'failed';
  /** phase=progress 时附 InstallProgressEvent 的 kind, 给 toast 切阶段文案。 */
  eventKind?: RemoteAgentInstallProgress['kind'];
  /** phase=failed 时附错误信息, 给 error toast 显示。 */
  message?: string;
}

/** cc-mgr / pi-manager 版本升级 push payload。available=null 表示该 host 的 pending 已清空。 */
interface RemoteAgentCcMgrUpgradeAvailablePush {
  hostId: string;
  available: {
    currentVersion: string;
    availableVersion: string;
  } | null;
  agent: 'cc' | 'pi';
}

interface RemoteAgentExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

interface RemoteAgentOneShotResult extends RemoteAgentExecResult {
  durationMs: number;
}

type VoiceInputState = import('@cindy/voice-input-core').VoiceInputState;
type VoiceAudioTrace = import('@cindy/voice-input-core').AudioTrace;
type VoiceSpeechSegment = import('@cindy/voice-input-core').SpeechSegment;
type VoiceInputGlobalErrorCode =
  'empty' | 'unavailable' | 'unconfirmed' | 'permission' | 'failed' | 'superseded';
type VoiceInputGlobalResult =
  { ok: true } | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode };
type VoiceEditableRange = import('@cindy/voice-input-core').EditableRange;
type VoiceRefinementContext = import('@cindy/voice-input-core').DictationRefinementContext;
type VoiceInputDraftSource = import('@cindy/voice-input-core').VoiceInputDraftSource;
type VoiceInputRendererEvent = import('@cindy/voice-input-core').VoiceInputRendererEvent;
type VoiceInputDictionaryAdviceInput =
  import('@cindy/voice-input-core').DictationDictionaryAdviceInput;
type VoiceInputDictionaryLearningAction =
  import('@cindy/voice-input-core').DictationDictionaryLearningAction;
type VoiceInputSettingsData = import('../shared/voiceInputData').VoiceInputSettings;
type VoiceInputHistoryEntryData = import('../shared/voiceInputData').VoiceInputHistoryEntry;
type VoiceInputDataSnapshot = import('../shared/voiceInputData').VoiceInputDataSnapshot;
type VoiceInputProviderKindData = import('../shared/voiceInputAsrProfiles').VoiceInputProviderKind;
type VoiceInputAsrModeData = import('../shared/voiceInputAsrProfiles').VoiceInputAsrMode;
type VoiceInputRefinerProviderKindData =
  import('../shared/voiceInputRefinerProfiles').VoiceInputRefinerProviderKind;
type VoiceInputRefinerTransportData =
  import('../shared/voiceInputRefinerProfiles').VoiceInputRefinerTransport;
type VoiceInputServiceModeData = 'cindy' | 'byok';
type VoiceInputModelSelectionResultData = {
  selection: {
    serviceMode: VoiceInputServiceModeData;
    serviceModeConfigured: boolean;
    asrProvider: VoiceInputProviderKindData;
    asrProviderChain: VoiceInputProviderKindData[];
    asrProviderChainSource: 'default' | 'configured';
    customAsr?: {
      protocol: 'openai-realtime' | 'qwen-realtime';
      websocketUrl: string;
      model: string;
    };
    refinerProvider: VoiceInputRefinerProviderKindData;
    refinerModel?: string;
    /** Effective refiner chain, head first; length 1 = no fallback (BYOK default). */
    refinerProviderChain: VoiceInputRefinerProviderKindData[];
    refinerProviderChainSource: 'default' | 'configured';
    configPath: string;
  };
  asrProfiles: Array<{
    id: VoiceInputProviderKindData;
    model: string;
    mode: VoiceInputAsrModeData;
    auth: 'api-key' | 'codex';
  }>;
  refinerProfiles: Array<{
    id: VoiceInputRefinerProviderKindData;
    model: string;
    transport: VoiceInputRefinerTransportData;
    auth: 'api-key' | 'codex';
  }>;
  readiness: {
    ok: boolean;
    provider: VoiceInputProviderKindData;
    providerModel: string;
    auth: 'api-key' | 'codex';
    settingsTab: 'api-keys' | 'connections' | 'providers';
    error?: string;
    failureReason?:
      'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
  };
  customAsrApiKeyConfigured: boolean;
};
type LocalThemeOpenDirResult = import('../shared/local-themes').LocalThemeOpenDirResult;
type LocalThemesResult = import('../shared/local-themes').LocalThemesResult;
type LocalThemeWriteRequest = import('../shared/local-themes').LocalThemeWriteRequest;
type LocalThemeWriteResult = import('../shared/local-themes').LocalThemeWriteResult;
type ImDefaultSettingsPatch = import('../shared/imDefaultSettings').ImDefaultSettingsPatch;
type ImDefaultSettingsState = import('../shared/imDefaultSettings').ImDefaultSettingsState;
type ImDefaultSettingsChannel = import('../shared/imDefaultSettings').ImDefaultSettingsChannel;
type SubagentModelSettingsPatch =
  import('../shared/subagentModelSettings').SubagentModelSettingsPatch;
type SubagentModelSettingsState =
  import('../shared/subagentModelSettings').SubagentModelSettingsState;
type SubagentModelSettingsWriteResult =
  import('../shared/subagentModelSettings').SubagentModelSettingsWriteResult;
type AuxiliaryModelSettingsPatch =
  import('../shared/auxiliaryModelSettings').AuxiliaryModelSettingsPatch;
type AuxiliaryModelSettingsState =
  import('../shared/auxiliaryModelSettings').AuxiliaryModelSettingsState;
type VisionBridgeSettingsPatch =
  import('../shared/visionBridgeSettings').VisionBridgeSettingsPatch;
type VisionBridgeSettingsState =
  import('../shared/visionBridgeSettings').VisionBridgeSettingsState;

/** Agent 资源占用设置的 IPC wire 形状(main 侧 agentResourceSettingsWire)。 */
type AgentResourceProcessPriority = 'normal' | 'low' | 'lowest';
type AgentResourceSettingsWire = {
  maxConcurrentCommands: number;
  processPriority: AgentResourceProcessPriority;
  capToolchainThreads: boolean;
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: {
    maxConcurrentCommands: number;
    processPriority: AgentResourceProcessPriority;
    capToolchainThreads: boolean;
  };
};

interface VoiceInputShortcut {
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
  skipPermissionProbe?: boolean;
  freshPermissionProbe?: boolean;
  bypassPermissionProbeCache?: boolean;
  passivePermissionProbeOnly?: boolean;
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

interface ComputerDriverUpdateProgress {
  phase: 'downloading' | 'installing' | 'done';
  downloadedBytes: number | null;
  totalBytes: number | null;
}

/* ── CCD Progress ── */

interface BinaryDownloadProgressPayload {
  progress: number;
  speed?: string; // e.g. "2.5 MB/s"
  downloaded?: string; // e.g. "15.3 MB"
  total?: string; // e.g. "80.0 MB"
  /** Terminal failure flag from main; renderer should escape splash & show retry. */
  failed?: boolean;
  /** DownloadError code (e.g. 'NETWORK', 'CHECKSUM', 'HTTP_4XX', 'manifest_failed'). */
  error?: string;
  /** D 场景（两个及以上需要下载）: 当前阶段 1 / 2 / 3；B/C 场景缺省。 */
  step?: 1 | 2 | 3;
  /** D 场景 = 本次需要下载的二进制段数(2 或 3)；B/C 场景缺省。 */
  totalSteps?: 2 | 3;
  /** step 切换瞬间的同步信号——splash 收到立即 set 进度=0，禁用 transition 动画。 */
  reset?: boolean;
  /** 失败/调试文案使用，标识当前推进度的 vendor。 */
  vendor?: 'claude' | 'codex' | 'pi';
}

/* ── App Update Progress ── */

interface AppUpdateProgressPayload {
  progress: number;
  received: number;
  total: number;
  speed?: string;
  /** Terminal failure flag from main; renderer should escape splash & show retry. */
  failed?: boolean;
  /** DownloadError code (e.g. 'NETWORK', 'CHECKSUM', 'HTTP_4XX'). */
  error?: string;
}

/* ── Auth types ── */

interface AuthUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  /** 组织稳定标识(access token orgSlug claim);个人身份或旧 token 为 null。 */
  orgSlug: string | null;
  /** 企业 logo(auth console 组织设置上传);个人身份或未设置为 null。 */
  orgLogoUrl: string | null;
  passportId: string;
}

/* ── Google integration ── */

type GoogleAuthStatus = 'not_connected' | 'connecting' | 'connected' | 'reconnect_required';

type FeishuBotStatus = 'idle' | 'testing' | 'connected' | 'reconnecting' | 'conflict' | 'error';

/** @cindy/im DiscordIM 的 transport 状态(IMStatus union 的 mirror)。 */
type DiscordBotTransportStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  | { kind: 'error'; reason: string };

/** @cindy/im TelegramIM 的 transport 状态(IMStatus union 的 mirror)。 */
interface TelegramBotBehavior {
  emojiReactions: 'off' | 'minimal' | 'expressive';
  replyQuoteGroup: 'off' | 'first' | 'all';
  replyQuoteDm: 'off' | 'first';
}

type TelegramBotTransportStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  /** 凭证保留、用户主动下线(不轮询); 与 idle=未配置 严格区分。 */
  | { kind: 'offline'; appId: string }
  | { kind: 'error'; reason: string; code?: TelegramBotErrorCode };

/** 稳定错误分类;renderer 据此取 i18n 文案,不直接展示 main 层 reason。 */
type TelegramBotErrorCode = 'invalid-token' | 'provider-api' | 'network' | 'secret-unavailable';

type DingTalkBotTransportStatus = DiscordBotTransportStatus;
type WecomBotTransportStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  | { kind: 'error'; reason: string };

type WechatBotPhase =
  | 'disconnected'
  | 'authorizing'
  | 'waiting_confirmation'
  | 'connected'
  | 'reconnecting'
  | 'needs_reauth'
  | 'disabled_by_policy'
  | 'error';

interface WechatBotState {
  phase: WechatBotPhase;
  bound: boolean;
  connectedAt?: number;
  lastInboundAt?: number;
  queuedTasks: number;
  errorCode?: string;
}

interface WechatChannelSettingsState {
  version: 1;
  workingDir: string | null;
  workingDirAvailable: boolean;
}

type DiscordBotSessionAuthCheckResult = {
  ok: boolean;
  missing: 'gateway-key' | 'agent-oauth' | 'provider-key' | 'provider-disconnected' | null;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  providerLabel: string | null;
};

interface FeishuBotRegistrationBeginResult {
  ok: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  interval?: number;
  error?: string;
}

interface FeishuBotRegistrationStatusPayload {
  status: 'pending' | 'success' | 'expired' | 'cancelled' | 'error';
  appId?: string;
  ownerOpenId?: string | null;
  verdict?: 'connected' | 'conflict' | 'error' | 'pending';
  error?: string;
}

/** Auth state pushed from main → renderer via 'auth:state-change'. */
interface AuthStateChangePayload {
  user: AuthUser | null;
  mode: 'signed-out' | 'local' | 'cloud';
  dataOwnerId: string | null;
  ownerGeneration: number;
  canEnterApp: boolean;
  isAuthenticated: boolean;
  /** 当前账号是否加入 Canary 发布通道；由 main 的 feature-flags 同步结果驱动。 */
  isCanary: boolean;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都有值 */
  deviceId: string;
  hasAccountDeletionReceipt: boolean;
  accountDeletionRestored: boolean;
  /** 持久凭证库(safeStorage)连续多个刷新周期不可用(#1687);旧版 main 不带此字段。 */
  credentialStoreUnavailable?: boolean;
}

/**
 * 会话失效的客户端内部分类(镜像 main/authRefreshFailure.ts 的 SessionExpiredReason;
 * main 不透传服务端原文,renderer 按此映射本地化文案)。
 */
type AuthSessionExpiredReason =
  | 'replaced-elsewhere'
  | 'expired'
  | 'device-mismatch'
  | 'account-unavailable'
  | 'credential-lost'
  | 'unknown';

interface AuthSessionExpiredPayload {
  message: string;
  /** 缺省视为 'unknown'(老版本 main 不带此字段)。 */
  reason?: AuthSessionExpiredReason;
}

/** chat-data-localization F1 V0.4: corruption-restored toast payload (C10). */
interface CorruptionRestoredPayload {
  source: 'clean' | 'iso';
  /** ISO 8601 mtime of the backup file used for recovery. */
  backupMtime: string;
}

/** #37: release 端检测到 schema drift 的 toast payload。 */
interface SchemaDriftWarningPayload {
  /** 漂掉的 migration 文件名(可空,只用作日志附加信息;toast 文案不依赖) */
  driftedFiles: string[];
}

interface OrcaTeamRecord {
  id: string;
  leadSessionId: string;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
  workerPermissionMode: 'auto' | 'bypassPermissions';
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrcaWorkerRecord {
  id: string;
  teamId: string;
  leadSessionId: string;
  sessionId: string;
  status: 'idle' | 'running' | 'done' | 'error';
  label: string | null;
  worktreeBranch: string | null;
  role: string;
  focused: boolean;
  idleSince: string | null;
  createdAt: string;
  updatedAt: string;
  session: {
    id: string;
    title: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
    model: string;
    effort: string;
    permissionMode: string;
    fastMode: boolean;
    sdkSessionId?: string;
  };
}

/* ── Codex vendor auth types (Boss 4 M22) ── */

/** Codex OAuth auth state from main process / auth.json */
interface CodexAuthState {
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
  credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  recoveryRequiredReason?: string;
}

/** Codex progress event payload (binary download + login phases) */
interface CodexOAuthProgressPayload {
  phase: 'downloading' | 'extracting' | 'ready' | 'login-pending' | 'login-error';
  received?: number;
  total?: number;
  detail?: string;
}

/** Codex event stream payload — from main via CODEX_OAUTH_CHANNEL (M14) */
interface CodexEventPayload {
  sessionId: string;
  event: {
    type: string;
    text?: string;
    delta?: string;
    message?: string;
    [key: string]: unknown;
  };
}

/** M40: Codex 今日 token 累计 snapshot（与 main/vendor/codex/types.ts 对齐）*/
interface CodexUsageSnapshot {
  day: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** = prompt + completion + cached; reasoning is a diagnostic subset of completion */
  total: number;
}

/* ── ElectronAPI ── */

/* ── CC Agent stream event types ── */

interface CCAgentStreamEvent {
  sessionId: string;
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'tool_result_full'
    | 'agent_task_update'
    | 'status'
    | 'done'
    | 'error'
    | 'permission_request'
    | 'permission_dismissed'
    | 'ask_user_question'
    | 'plan_review'
    | 'thinking'
    | 'compact_boundary';
  data: unknown;
  source?: 'claude-code' | 'codex' | 'pi' | 'vision-bridge';
  /**
   * agent-meta: SDK 元信息（按 session.agentKind 解析）。当事件来自一条 SDK
   * message（assistant / tool_use / thinking final / done 等）时由 main 透传过来。
   * stream_event 中的 delta 类事件无此字段。
   */
  agentMeta?: import('@/lib/ccAgent.types').AgentMeta;
  /** Host-owned SDK boundary claim; claimed done/status events are not product completion. */
  turnContinuationId?: number;
  /** Idle/host compact is not a product turn; must not finalize live streaming. */
  turnScope?: 'turn' | 'background';
  /**
   * F1-a: 由 main 端 messagePersistBroadcaster 为这条消息分配的稳定 persistId,
   * 经 maker:event payload 透传。renderer 用它当在途气泡 clientId(不再自造随机),
   * 让 main 落库后的 onCreated(同 id)命中 dedup,把在途气泡替换为权威行而非新增。
   * assistant 'text' 与终止型 error 都会下发(error 为广播前预留的 persistId);
   * 其它类型暂为 undefined。
   */
  persistId?: string;
  /**
   * F1-a Option C(tool_result 家族专用):main 端 messagePersistBroadcaster 解析出的
   * 权威内容(summary↔全文 重排后),与落库内容同源同值。renderer 纯展示:tool_result /
   * tool_result_full 按 persistId 找气泡 → 用 resolvedContent 整体替换 / 新建。其它事件
   * 类型不下发。
   */
  resolvedContent?: string;
}

/**
 * Thinking block streaming payload (extended thinking from Anthropic API).
 *
 *  - 'start':    First sign of a thinking block in this API call. Renderer
 *                creates a new in-progress card. `startedAt` is the wall clock
 *                when the first delta arrived.
 *  - 'delta':    Append `text` to the card identified by `blockId`.
 *  - 'final':    Authoritative full text from the assistant message. Renderer
 *                replaces accumulated text and freezes the card with `durationMs`.
 *  - 'redacted': Server-side redacted reasoning. No text — show locked card.
 */
interface CCAgentThinkingPayload {
  sessionId: string;
  type: 'thinking';
  data:
    | { stage: 'start'; blockId: string; startedAt: number }
    | { stage: 'delta'; blockId: string; text: string }
    | { stage: 'final'; blockId: string; text: string; durationMs: number }
    | { stage: 'redacted'; blockId: string };
}

/* ── Permission prompt types (F-PERM-1) ── */

interface CCAgentPermissionRequestPayload {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: unknown[];
  autoReviewUnavailable?: boolean;
}

interface CCAgentPermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedPermissions?: unknown[];
  decisionClassification?: string;
}

/**
 * Sent from main → renderer when an in-flight permission prompt is auto-resolved
 * (e.g. user switched permissionMode mid-prompt). Renderer should clear its
 * pendingPermission state and close any open dialog matching `requestId`.
 */
interface CCAgentPermissionDismissedPayload {
  sessionId: string;
  requestId: string;
  reason:
    'mode_changed_to_bypassPermissions' | 'mode_changed_to_acceptEdits' | 'mode_changed_to_plan';
  resolvedAs: 'allow' | 'deny';
}

interface CCAgentStatusUpdate {
  sessionId: string;
  status: string;
  tokenUsage: number;
  costUsd?: number;
  contextTokens: number;
  contextWindow: number;
  outputTokens?: number;
  generationDurationMs?: number;
  generationActive?: boolean;
  generationReliable?: boolean;
  isRunning: boolean;
  /** Host-owned SDK boundary claim; a claimed `status(false)` is not product idle. */
  turnContinuationId?: number;
  /**
   * Side-channel running 标记 (mivo MJ 按钮等不走 LLM 的后台任务用)。
   * true 时:
   *  - handleStatusUpdate 不当成 turn start, 不把 tokenUsage / costUsd 打回零
   *  - tokenUsage / costUsd / contextTokens / contextWindow 字段被忽略, 保留 state 现有值
   * 目的是让侧栏 running 指示器闪起来, 同时不污染上一轮的 cost / token 数字。
   */
  skipTurnReset?: boolean;
}

/**
 * agent-meta: user 消息持久化结果回推 payload。
 *  - 成功：message 含完整 row；renderer 据此把乐观 pending 转正
 *  - 失败：error 非空且 message 为 null；renderer 据此回滚乐观显示并提示
 *
 * user-message-persist-race 修复后，main 在 sendMessage 入口同步落库后立刻
 * fire 一次（不再等 SDK 回显）；SDK 回显路径只补 agent_meta 不再 fire。
 */
interface CCAgentUserMessagePersistedPayload {
  sessionId: string;
  /** 与 sendCCAgentMessage 入参 pendingId 对应。 */
  pendingId: string;
  message: import('@/lib/ccAgent.types').Message | null;
  error?: string;
}

/* ── AskUserQuestion types (F7.1) ── */

interface CCAgentAskUserQuestionOption {
  label: string;
  description?: string;
}

interface CCAgentAskUserQuestionItem {
  question: string;
  header?: string;
  options?: CCAgentAskUserQuestionOption[];
  multiSelect?: boolean;
}

/**
 * Payload sent from main → renderer with ALL questions at once.
 * The renderer manages the wizard (Back/Next/animation) locally.
 */
interface CCAgentAskUserQuestionPayload {
  sessionId: string;
  requestId: string;
  questions: CCAgentAskUserQuestionItem[];
}

/**
 * All answers sent back from renderer → main in one shot.
 */
interface CCAgentAnswerUserQuestionParams {
  sessionId: string;
  requestId: string;
  answers: Record<string, string>;
}

/* ── Plan Review types (FP-2) ── */

/**
 * Payload sent from main → renderer when the SDK requests ExitPlanMode.
 * Mirrors AskUserQuestion contract.
 */
interface CCAgentPlanReviewPayload {
  sessionId: string;
  requestId: string;
  plan: string; // Markdown content
  planFilePath: string; // Absolute path of the plan file on disk
}

/**
 * Plan-review decision sent back from renderer → main.
 */
interface CCAgentPlanReviewResponseParams {
  sessionId: string;
  requestId: string;
  approved: boolean;
  feedback?: string;
  /** FP-edit: latest edited plan content; forwarded to SDK as updatedInput.plan. */
  latestPlan?: string;
}

/**
 * FP-edit: write the edited plan back to disk via main process.
 */
interface CCAgentWritePlanFileParams {
  requestId: string;
  planFilePath: string;
  content: string;
}

interface CCAgentSdkSessionIdPayload {
  sessionId: string;
  sdkSessionId: string;
}

/**
 * rewind-session: SDK rewindFiles 返回的结构（与 SDK 端 RewindFilesResult 同型）。
 * 不直接 re-export SDK 类型——避免在 renderer 端拉 main-only 包的 d.ts 编译开销。
 */
interface RewindFilesResultPayload {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/* ── App Update status ── */

interface UpdateStatusPayload {
  /**
   * `superseding`: 本地已经下好旧版补丁(banner 已弹出)、后台又发现了更新的版本,
   * 正在静默下载新版本。期间 banner 继续可见,但 relaunch 按钮显示 loading 并禁用,
   * 防止用户重启后装的是旧的。下载成功 → status 切回 'ready' + 新 version;
   * 失败 → 静默回到 'ready' + 旧 version,下次轮询再试。
   */
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'superseding' | 'error';
  version?: string;
  progress?: number;
  /** Machine-readable error subtype. 'translocated' = macOS App Translocation
   *  blocked the relaunch; renderer shows a fallback dialog instead of
   *  silently quitting into a broken state. */
  errorCode?: string;
}

interface AutoUpdateSettingsPayload {
  autoRelaunchOnIdle: boolean;
  isCustomized?: boolean;
  defaultAutoRelaunchOnIdle?: boolean;
}

/* ── 跨 Agent 工作区互转 wire 类型（同 main/cross-agent-convert/types.ts） ── */
type CrossAgentMigrationKind = 'agents-md' | 'agents' | 'hooks' | 'mcp';
type CrossAgentDirection = 'to-claude' | 'to-codex';
type CrossAgentStepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';

interface CrossAgentMigrationItem {
  id: string;
  kind: CrossAgentMigrationKind;
  direction: CrossAgentDirection;
  label: string;
  source: string;
  target: string;
  subItems?: { name: string; sourcePath: string; targetPath: string }[];
}

interface CrossAgentStepEvent {
  itemId: string;
  status: CrossAgentStepStatus;
  detail?: string;
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
  collabWorkspaceKind?: 'project' | 'dialogue';
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

type AndroidAdbPathSource = 'custom' | 'env' | 'prepared' | 'bundled' | 'sdk' | 'path' | 'fallback';

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

interface ProjectAutomationConsent {
  workingDir: string;
  consentedAt: number;
  configHash: string;
}

interface ProjectAutomationReconcileResult {
  workingDir: string;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: 'no-file' | 'parse-error' | null;
}

type ProjectAutomationEvent = {
  type: 'reconciled';
  workingDir: string;
  inserted: number;
  updated: number;
  deleted: number;
  isFirstTime: boolean;
  hashChanged: boolean;
};

type ApplicationMenuCommand = import('../shared/applicationMenuCommands').ApplicationMenuCommand;
type ApplicationMenuLocale = import('../shared/locale').SupportedLocale;
type AgentIslandDisplayOption = import('../shared/agentIsland').AgentIslandDisplayOption;
type AgentIslandDisplayTarget = import('../shared/agentIsland').AgentIslandDisplayTarget;
type AgentIslandMascotSkin = import('../shared/agentIsland').AgentIslandMascotSkin;
type AgentIslandSoundChoice = import('../shared/agentIsland').AgentIslandSoundChoice;
type AgentIslandSoundSettings = import('../shared/agentIsland').AgentIslandSoundSettings;
type AgentIslandSessionActivity = import('../shared/agentIsland').AgentIslandSessionActivity;

/** 会话内 /goal 状态扁平 payload(main goal-host → renderer)。 */
interface GoalStatusPayload {
  sessionId: string;
  status: 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';
  objective: string;
  turnsUsed: number;
  tokensUsed: number;
  maxTurns: number | null;
  noProgressLimit: number | null;
  /** null = 未设预算(对齐 Codex 可空 tokenBudget)。 */
  budgetTokens: number | null;
  /** usageLimited 时的限额重置时刻(unix ms);其它状态 null。 */
  usageResetAt: number | null;
  /** 目标创建时刻(unix ms),供 chip 显示实时运行时长。 */
  startedAt: number;
  lastReason: string | null;
}

type CindyMediaPreferenceOption = {
  id: string;
  label: string;
  group: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  routing?: import('@cindy/model-providers').Provider['routing'];
};

type CindyMediaPreferenceKind = {
  options: CindyMediaPreferenceOption[];
  defaultModel: CindyMediaPreferenceOption | null;
};

interface ElectronAPI {
  platform: string;
  windowBackdropMaterial: import('../shared/windowBackdrop').WindowsBackdropMaterial;
  onWindowBackdropMaterialChanged?: (
    cb: (material: import('../shared/windowBackdrop').WindowsBackdropMaterial) => void,
  ) => () => void;
  osRelease: string;
  appVersion: string;
  /** 运行期端点清单(main 启动时远程 → 缓存 → 烘焙解析;重启生效)。 */
  clientEndpoints: { websiteUrl: string };
  appDisplayVersion: string;
  appDisplayVersionDetail: string;
  preferredSystemLocale: ApplicationMenuLocale;
  onLocaleChanged?: (cb: (locale: import('../shared/locale').SupportedLocale) => void) => () => void;
  getDeviceId: () => Promise<string>;
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowExitFullscreen: () => void;
  windowClose: () => void;
  /**
   * 手动窗口拖拽(no-drag 元素上"按住拖动移动窗口"):start 后 main 用光标
   * 位置驱动本窗口跟随,直到 stop。renderer 侧统一经 useManualWindowDrag
   * (components/layout/windowDrag.tsx)使用,不要直接调。
   */
  windowDragMoveStart: () => void;
  windowDragMoveStop: () => void;
  /**
   * mac ⌘W 的窗口级 fallback:对本窗口 win.close()(主窗被 main close handler
   * 转成隐藏,副窗正常关闭)。与 windowClose(自定义 X,主窗 = 退出 app)语义不同。
   */
  windowCloseSelf: () => void;
  /**
   * 查询当前是否有 session 在 turn 中。WindowControls 用它决定是否弹确认框。
   * splash / login 阶段会 reject (handler 未注册), 调用方需 catch 兜底成 false。
   */
  anySessionInTurn: () => Promise<boolean>;
  pageZoomIn: () => Promise<{ ok: true; zoomFactor: number }>;
  pageZoomOut: () => Promise<{ ok: true; zoomFactor: number }>;
  pageZoomReset: () => Promise<{ ok: true; zoomFactor: number }>;
  appearanceSettings: {
    getSync: () => import('../shared/appearanceSettings').AppearanceSettings | null;
    get: () => Promise<unknown>;
    setPatch: (
      patch: Partial<import('../shared/appearanceSettings').AppearanceSettings>,
    ) => Promise<import('../shared/appearanceSettings').AppearanceSettings>;
    reset: () => Promise<import('../shared/appearanceSettings').AppearanceSettings>;
    onChanged: (
      callback: (settings: import('../shared/appearanceSettings').AppearanceSettings) => void,
    ) => () => void;
  };
  onApplicationMenuCommand: (callback: (command: ApplicationMenuCommand) => void) => () => void;
  setApplicationMenuLocale: (locale: ApplicationMenuLocale) => Promise<{ ok: true }>;
  billing: import('../shared/billing').BillingRendererApi;

  // lifecycle 兜底 catch 到瞬时网络错误时推一次。renderer 收到后由
  // systemNetworkErrorToast.ts 负责节流 + 多语言 toast。
  onSystemTransientNetworkError: (
    callback: (payload: { code: string; address?: string; port?: number }) => void,
  ) => () => void;

  // Renderer 日志转发到 main.log（全级别 + scope，main 端按 LOG_LEVEL 过滤）
  logToMain: (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    scope: string,
    msg: string,
  ) => void;

  localThemes: {
    listSync: () => LocalThemesResult;
    list: () => Promise<LocalThemesResult>;
    write: (req: LocalThemeWriteRequest) => Promise<LocalThemeWriteResult>;
    openDir: () => Promise<LocalThemeOpenDirResult>;
    /** 导入 VSCode / Obsidian 主题文件；对话框与读文件都在 main 侧。 */
    importExternal: () => Promise<import('../shared/theme-import/types').LocalThemeImportResult>;
  };

  /** RSB terminal tab —— PTY 后端 + xterm.js,详见 shared/terminal-bridge.ts 注释。 */
  terminal: import('../shared/terminal-bridge').TerminalBridge;

  /** 应用级快捷键 override 通道 —— registry 与合并逻辑见 shared/appShortcuts.ts。 */
  appShortcuts: {
    getState: () => {
      overrides: import('../shared/appShortcuts').AppShortcutOverrides;
      platform: string;
    };
    setOverride: (
      id: import('../shared/appShortcuts').AppShortcutId,
      combo: import('../shared/appShortcuts').AppShortcutCombo | null,
    ) => Promise<{ overrides: import('../shared/appShortcuts').AppShortcutOverrides }>;
    clearOverride: (
      id: import('../shared/appShortcuts').AppShortcutId,
    ) => Promise<{ overrides: import('../shared/appShortcuts').AppShortcutOverrides }>;
    resetAll: () => Promise<{ overrides: import('../shared/appShortcuts').AppShortcutOverrides }>;
    setRecording: (active: boolean) => void;
    onChanged: (
      callback: (payload: {
        overrides: import('../shared/appShortcuts').AppShortcutOverrides;
      }) => void,
    ) => () => void;
  };

  /** 主界面布局树 —— 数据模型与校验见 shared/layoutTree.ts,main 端见 main/layout/。 */
  layout: {
    /** 首帧同步拉取(规则 7:布局第一帧就位,不允许默认→用户布局的跳变)。 */
    getStateSync: () => { layout: import('../shared/layoutTree').Layout };
    set: (
      layout: import('../shared/layoutTree').Layout,
    ) => Promise<{ layout: import('../shared/layoutTree').Layout; persisted: boolean }>;
    reset: () => Promise<{
      layout: import('../shared/layoutTree').Layout;
      persisted: boolean;
    }>;
    onChanged: (
      callback: (payload: { layout: import('../shared/layoutTree').Layout }) => void,
    ) => () => void;
  };

  /** 意识仓库 —— 数据模型与校验见 shared/ghost.ts,main 端见 main/cindy-brain/。 */
  ghosts: {
    /** 首帧同步拉取已装清单(规则 7:意识面板与内置面板同帧注册,无跳变)。 */
    listSync: () => { ghosts: import('../shared/ghost').InstalledGhost[] };
    onForgeOidcInstallConfirmRequest: (
      callback: (payload: {
        requestId: string;
        ghostId: string;
        ghostName: string;
        hosts: string[];
      }) => void,
    ) => () => void;
    resolveForgeOidcInstallConfirm: (
      requestId: string,
      confirmed: boolean,
    ) => Promise<{ handled: boolean }>;
    /** Plugin 快捷行最近使用顺序(最新在前,首帧同步读取避免排序跳变)。 */
    recentUsageSync: () => { ids: string[] };
    /** 成功发送一次 Plugin 指令后记录最近使用。 */
    markUsed: (id: string) => Promise<{ ids: string[] }>;
    /**
     * 配置就绪检查(插件页「使用」前置门):main 按清单推导需求(setup
     * 声明或启发式)并现查凭证/OAuth 账号/连接/kv,未就绪时 renderer 弹窗
     * 引导去配置。未装 NOT_FOUND。
     */
    setupStatus: (id: string) => Promise<import('../shared/ghost').GhostSetupStatus>;
    /** 只列入口元数据，不运行插件工具；远程/device-link 不暴露。 */
    /** 用户选定一个入口后，按固定只读摘要契约搜索该插件。 */
    /** 最近使用顺序变化（发送 /卸载），多窗口同步。 */
    onRecentUsageChanged: (callback: (payload: { ids: string[] }) => void) => () => void;
    install: (
      lizFilePath: string,
      /** enable:装入后立即开启；缺省沉睡。 */
      opts: { enable?: boolean; expectedPackageSha256: string },
    ) => Promise<{ ghost: import('../shared/ghost').InstalledGhost }>;
    /** 原位更新(同 id 换版):唤醒状态与面板位置延续,沙箱熄灯待重拉。 */
    update: (
      lizFilePath: string,
      opts: {
        expectedPackageSha256: string;
        expectedInstalledApproval: string;
      },
    ) => Promise<{ ghost: import('../shared/ghost').InstalledGhost }>;
    /**
     * cindy 槽后端覆盖:首帧同步读(规则 7);overrides 键为 "image.generate"
     * 等能力键;image/video 各一份下拉数据,defaultModel = 目录默认
     * 选型的展示信息("默认(GPT Image 2)")。
     * options 空 + defaultModel null = 目录没给该类目模型(能力暂不可用),
     * 渲染层显示灰字而非下拉。
     */
    cindyPrefsSync: (id: string) => {
      overrides: Record<string, string>;
      image: CindyMediaPreferenceKind;
      imageEdit: CindyMediaPreferenceKind;
      video: CindyMediaPreferenceKind;
      videoEdit: CindyMediaPreferenceKind;
      /** 文本类(快问快答):选项是当前供应商目录的全部文本模型(cat: 编码钉值,
       *  带供应商/模型/徽标等结构化字段供富列表渲染);declaredModel = 身份卡声明
       *  的偏好模型(目录里解析得到才给,"跟随默认"行据此如实展示实际路由)。 */
      text: {
        options: Array<{
          id: string;
          label: string;
          group: string;
          providerId: string;
          agentKind: string;
          modelId: string;
          modelName: string;
          icon?: string;
          budget: boolean;
          subscription: boolean;
          routing?: ProviderRoutingPayload;
          agentSuffix?: string;
        }>;
        defaultModel: { id: string; label: string } | null;
        declaredModel?: { id: string; label: string } | null;
        /** 存量轻量档位钉(目录扩展前的合法钉值)的展示名表,老钉值回显友好名用。 */
        utilityProfiles?: Array<{ id: string; label: string }>;
      };
      /** 向量类(文本转向量):同 image/video 走目录派生。 */
      embed: {
        options: Array<{ id: string; label: string }>;
        defaultModel: { id: string; label: string } | null;
      };
    };
    /** 写/清一项覆盖(model=null 即恢复跟随默认);返回该意识最新覆盖表。 */
    setCindyPref: (
      id: string,
      capability: string,
      model: string | null,
    ) => Promise<{ overrides: Record<string, string> }>;
    /** 派活(errand)每插件配置:首帧同步读(规则 7);config 缺项 = 跟随默认。 */
    errandPrefsSync: (id: string) => { config: Record<string, unknown> };
    /** 整卡替换派活配置(null / 空对象 = 全恢复跟随默认);返回清洗后的落盘值。 */
    setErrandConfig: (
      id: string,
      config: Record<string, unknown> | null,
    ) => Promise<{ config: Record<string, unknown> }>;
    /** 系统文件选择框(.cindy 过滤),只选不装;取消返回 { canceled: true }。 */
    pickFile: () => Promise<{ canceled: true } | { filePath: string }>;
    /** 只验不装:读出清单、签名信任等级与 icon data URL,供安装编排使用。 */
    inspect: (lizFilePath: string) => Promise<{
      manifest: import('../shared/ghost').GhostManifest;
      trust: import('../shared/ghost').GhostTrustInfo;
      /** 本次检查的整包指纹；安装/更新时回传，防止确认后文件被替换。 */
      packageSha256: string;
      /** v2 清单中无法映射的历史 slot；仅用于兼容诊断，不阻塞安装。 */
      unsupportedSlots: string[];
      iconDataUrl?: string;
    }>;
    uninstall: (id: string) => Promise<{ ok: true }>;
    /** 详情页「导出 .cindy」:打包安装目录 → 保存对话框落盘。 */
    export: (
      id: string,
    ) => Promise<{ status: 'saved'; savedPath: string } | { status: 'canceled' }>;
    /** 启用/停用(停用 = 面板休眠,布局位置保留)。 */
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: true }>;
    /** 目录级禁用清单(插件页项目范围视图;sendSync 切换同帧渲染)。 */
    workdirPrefsSync: (workdir: string) => { disabled: string[] };
    /** 写/清一条目录级例外(disabled=false 即清除,回到跟随全局)。 */
    setWorkdirDisabled: (
      workdir: string,
      id: string,
      disabled: boolean,
    ) => Promise<{ disabled: string[] }>;
    /** 双击 .cindy 的待装路径，原子取走（取即清空；无则 null）。 */
    takePendingInstall: () => Promise<{ filePath: string | null }>;
    onChanged: (
      callback: (payload: { ghosts: import('../shared/ghost').InstalledGhost[] }) => void,
    ) => () => void;
    /** Host 校验 setup action 后请求打开固定的本地配置入口。 */
    onSetupNavigate: (
      callback: (
        payload:
          | { sessionId: string; target: 'plugin_settings'; ghostId: string }
          | { sessionId: string; target: 'client_settings' },
      ) => void,
    ) => () => void;
    /** 双击 .cindy 转交信号:收到后调 takePendingInstall 取路径走一键装入流程。 */
    onInstallRequested: (callback: () => void) => () => void;
    /** 运行时状态广播:crashed / fused 时面板原地显示错误接管态。 */
    onRuntimeChanged: (
      callback: (payload: { states: Record<string, string> }) => void,
    ) => () => void;
    /** 面板「点开产物大图」推送:main 拦下 /preview/ 导航并过闸后,推主机拼装的
     *  cindy-media:// 地址与媒体类别,GhostMediaLightboxHost 按 kind 弹
     *  ImageLightbox / VideoLightbox。 */
    onPreviewMedia: (
      callback: (payload: { ghostId: string; src: string; kind: 'image' | 'video' }) => void,
    ) => () => void;
    /** 面板媒体换发:把 cindy-ghost:// 媒体地址换发成宿主可用的 cindy-media://
     *  地址(main 验指纹形状 + 账本归属 + mime;不合格统一 NOT_FOUND)。
     *  purpose 缺省 'attach'(拖拽引渡落附件);'menu' 是面板右键菜单通道。
     *  图片 / 视频都放行:图片只回地址(kind 缺省按图片兜底,兼容旧 main);
     *  视频附带指纹仓磁盘路径 + 体积等元数据,引渡侧据此落 file 类别路径附件
     *  (不复制字节)。 */
    resolvePanelMedia: (
      uri: string,
      purpose?: 'attach' | 'menu',
    ) => Promise<
      | { url: string; kind?: 'image' }
      | {
          url: string;
          kind: 'video';
          absPath: string;
          size: number;
          name: string;
          ext: string;
          mimeType: string;
        }
    >;
    /** 意识聊天卡片更新推送(卡槽③):card-update 过闸后带净化 html 全量推,
     *  ghostCardStore 消费;toolUseId 仅 claude 路径有(codex 为 null,
     *  renderer 走同 ghost 启发式锚定)。 */
    onCardUpdated: (
      callback: (payload: {
        callId: string;
        ghostId: string;
        toolUseId: string | null;
        /** 静态版(settle 后 / 历史回放;与落库一致)。 */
        html: string;
        /** 意识自绘动画版(白名单校验通过才有;仅 running 装载,不落库)。 */
        animatedHtml: string | null;
        height: number;
        /** 意识声明的后台活动状态(card-action 干活):'working' 过程态 /
         *  'done' 终版 / null 未声明。不落库,历史回放恒无。 */
        state?: 'working' | 'done' | null;
      }) => void,
    ) => () => void;
    /** 意识后台活动(card-action 干活)会话忙闲推送:0↔1 转变才推,
     *  ghostSessionActivityStore 消费(侧栏呼吸 OR 信号)。 */
    onSessionActivity: (
      callback: (payload: { sessionId: string; busy: boolean }) => void,
    ) => () => void;
    /** 意识聊天卡片取件(历史回放):无卡返回 { card: null },renderer 降级
     *  为通用媒体渲染(远程会话 / 被 GC 的历史卡都走这条)。 */
    getCard: (callId: string) => Promise<{
      card: { callId: string; ghostId: string; html: string; height: number; v: number } | null;
    }>;
    /** 权威实测高回填:GhostToolCard 量出内容真实高度后写回卡片库,历史
     *  回放据此零动画首帧贴合(行不存在主机静默跳过)。 */
    reportCardHeight: (callId: string, height: number) => Promise<{ ok: true }>;
    /** 交互卡(v2)按钮点击回传:宿主桥捕获 data-ghost-action 点击后调,主机
     *  验卡片归属→唤醒意识→管子下发 card-action。fire-and-forget。prompt 仅
     *  data-ghost-prompt 类动作有(宿主输入框收集的用户文字)。 */
    dispatchCardAction: (
      callId: string,
      actionId: string,
      prompt?: string,
    ) => Promise<{ ok: boolean }>;
    /** 订阅槽①:用户消息被意识钩子拦下(renderer 把乐观气泡原地降级为被拦态;
     *  没有既有气泡时用 text 补渲一条——排队消息被拦不无声蒸发)。 */
    onUserMessageBlocked: (
      callback: (payload: {
        sessionId: string;
        clientId: string;
        ghostId: string;
        ghostName: string;
        reason: string;
        text: string;
      }) => void,
    ) => () => void;
    /** 订阅槽①:用户消息被意识钩子改写(renderer 把气泡正文静默换成改写版;v1 无留痕标记)。 */
    onUserMessageRewritten: (
      callback: (payload: {
        sessionId: string;
        clientId: string;
        ghostId: string;
        ghostName: string;
        text: string;
        originalText: string;
      }) => void,
    ) => () => void;
    /** 出口钩子(will-assistant-message):AI 回复被润色改写(renderer 气泡静默换文本)。 */
    onAssistantMessageRewritten: (
      callback: (payload: {
        sessionId: string;
        clientId: string;
        ghostId: string;
        ghostName: string;
        text: string;
      }) => void,
    ) => () => void;
    /** 出口钩子:后台处理中/完成的轻指示(回复已显示、意识还在跑那段)。 */
    onAssistantMessagePending: (
      callback: (payload: { sessionId: string; clientId: string; pending: boolean }) => void,
    ) => () => void;
    /** 会话批量取卡(历史回放):一次查出本会话全部卡片(含 turn 级自绘卡)。 */
    listCardsBySession: (sessionId: string) => Promise<{
      cards: Array<{ callId: string; ghostId: string; html: string; height: number; v: number }>;
    }>;
    /** 会话切换上报(did-session-switched 数据源;单向 send,main 去重+资格门)。 */
    noteSessionFocused: (sessionId: string | null) => void;
    /** 订阅槽①:意识钩子熔断(连续失败降级只旁听,renderer 弹提示)。 */
    onHookFused: (callback: (payload: { ghostId: string; name: string }) => void) => () => void;
    /** notify 槽 + 主机代言 notice:意识系统提示(宿主 Toast 渲染,带意识身份头)。
     *  意识自发的带 text(main 侧已净化+限速);主机代言的(凭证入库/授权成功)
     *  带 textKey/textArgs,renderer 按 GHOST_HOST_NOTICE_KEYS 白名单翻译。 */
    onNotify: (
      callback: (payload: {
        ghostId: string;
        name: string;
        iconDataUrl?: string;
        text?: string;
        textKey?: string;
        textArgs?: Record<string, string>;
        tone: 'info' | 'success' | 'warning' | 'error';
      }) => void,
    ) => () => void;
    /** badge 槽:意识未读角标变化(插件入口与插件卡上的绿点)。
     *  与 onNotify 的分工是持久状态对一次性 toast——用户没去看就一直亮着。
     *  summary/at 只在 unread:true 时给。 */
    onBadge: (
      callback: (payload: {
        ghostId: string;
        unread: boolean;
        summary?: string;
        at?: number;
      }) => void,
    ) => () => void;
    /** badge 槽:未读全量快照(换账号后整表替换;逐条 onBadge 只表达增量)。 */
    onUnreadSnapshot: (
      callback: (payload: {
        entries: Array<{ ghostId: string; summary?: string; at: number }>;
      }) => void,
    ) => () => void;
    /** badge 槽:未读角标首帧快照(同步读,避免绿点晚一帧跳出来)。 */
    unreadSync: () => { entries: Array<{ ghostId: string; summary?: string; at: number }> };
    /** badge 槽:用户侧熄灭未读(打开面板 = 明确已读)。seenAt = 当时看到的那条
     *  的点亮时刻,main 据此条件删除,避免陈旧清除抹掉更新的未读。 */
    clearUnread: (id: string, seenAt?: number) => Promise<{ ok: boolean }>;
    /** confirm 槽:插件请求弹主机同款确认框(main 已资格审+净化+限速+单飞)。
     *  main 只投单个窗口,所以收到即本窗口负责弹;答案用 resolveConfirm 回包。
     *  confirmText/cancelText 为 null 时用 renderer 自己的缺省文案(跟语言走)。 */
    onConfirmRequest: (
      callback: (payload: {
        requestId: string;
        ghostId: string;
        ghostName: string;
        iconDataUrl?: string;
        body: string;
        confirmText: string | null;
        cancelText: string | null;
        danger: boolean;
      }) => void,
    ) => () => void;
    /** confirm 槽回包:把用户的点击送回 main 结算挂起的管子请求。 */
    resolveConfirm: (requestId: string, confirmed: boolean) => Promise<{ handled: boolean }>;
    /** preview 槽:插件请求在右侧栏内置浏览器开预览标签(main 已白名单守门+限速)。 */
    onPreviewOpen: (
      callback: (payload: {
        ghostId: string;
        name: string;
        iconDataUrl?: string;
        sessionId: string;
        url: string;
      }) => void,
    ) => () => void;
    /**
     * agent 槽 schedule 加档:插件请求打开自动化创建面板并预填。
     * main 已做资格审 / 文本净化截断 / 频率钳制 / 限速;身份三件套由 main 按
     * 已装清单填(不信沙箱自报)。**只开面板** —— 任务由用户选模型后亲手保存。
     *
     * 投递是**单窗口**的:main 只投一个挂了完整主壳的窗口(打断式操作广播出去会让
     * 每个窗口都跳页弹表单)。独立的插件面板窗 / 右侧栏窗收不到本推送。
     */
    onScheduleDraft: (
      callback: (payload: {
        requestId: string;
        ghostId: string;
        ghostName: string;
        iconDataUrl?: string;
        name: string;
        prompt: string;
        intervalMs?: number;
      }) => void,
    ) => () => void;
    /** 运行时状态快照(错误接管态首帧数据源)。 */
    runtimeStates: () => Promise<{ states: Record<string, string> }>;
    /** 面板错误态「重载意识」:清熔断记账 + 重新拉起沙箱。 */
    reload: (id: string) => Promise<{ state: string }>;
    /** Library(持久作品库)设置面:概览/选位置/绑定/迁移/回默认/解绑/删除。 */
    libraryOverview: (id: string) => Promise<import('../shared/ghost').GhostLibraryOverview>;
    libraryPickLocation: (
      id: string,
    ) => Promise<{ ok: boolean; cancelled?: boolean; candidate?: string; warnings?: string[]; message?: string }>;
    libraryBind: (id: string, candidate: string) => Promise<{ ok: boolean; message?: string; warnings?: string[] }>;
    libraryRelocate: (id: string, candidate: string) => Promise<{ ok: boolean; message?: string }>;
    libraryRevertDefault: (id: string) => Promise<{ ok: boolean; message?: string }>;
    libraryUnbind: (id: string) => Promise<{ ok: boolean; message?: string }>;
    libraryDelete: (id: string) => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>;
    legacyRecoveryStatus: () => Promise<
      import('../shared/legacyGhostRecovery').LegacyGhostRecoveryStatus
    >;
    retryLegacyRecovery: () => Promise<
      import('../shared/legacyGhostRecovery').LegacyGhostRecoveryStatus
    >;
    /** dev-only 运行时控制(packaged 版 main 侧不注册,调用会 reject)。 */
    devRuntime: (
      action: 'status' | 'spawn' | 'stop' | 'crash',
      id?: string,
    ) => Promise<{ states?: Record<string, string>; state?: string }>;
    /** dev-only：经正式插件派发/权限链调用一个已声明工具。 */
    devCall: (id: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  };

  /** Plugin Protocol v2 市场；网络、下载与安装全部在 main 进程完成。 */
  pluginMarket: {
    snapshot: () => Promise<import('../shared/pluginMarket').PluginMarketSnapshot>;
    detail: (pluginId: string) => Promise<import('../shared/pluginMarket').PluginMarketDetail>;
    localIcons: (
      requests: import('../shared/pluginMarket').PluginMarketLocalIconRequest[],
    ) => Promise<import('../shared/pluginMarket').PluginMarketLocalIconResult[]>;
    install: (
      pluginId: string,
      options: import('../shared/pluginMarket').PluginMarketInstallOptions,
    ) => Promise<import('../shared/pluginMarket').PluginMarketInstallResult>;
    uninstall: (pluginId: string) => Promise<{ ok: true }>;
    consumeRemovalNotice: () => Promise<
      import('../shared/pluginMarket').PluginRemovalUserNotice | null
    >;
    onRemovalNoticeAvailable: (callback: () => void) => () => void;
    listSources: () => Promise<import('../shared/pluginMarket').MarketSourceSummary[]>;
    pickLocalSource: (
      defaultPath?: string,
    ) => Promise<
      | { canceled: true }
      | { canceled: false; summary: import('../shared/pluginMarket').MarketSourceSummary }
    >;
    addSource: (input: {
      source: string;
      ref?: string;
      sparsePaths?: string[];
    }) => Promise<import('../shared/pluginMarket').MarketSourceSummary>;
    removeSource: (name: string) => Promise<{ ok: true }>;
    refreshSource: (name: string) => Promise<import('../shared/pluginMarket').MarketSourceSummary>;
    gitPreflight: () => Promise<{ ok: boolean; version: string | null }>;
  };
  pluginPublisher: {
    start: (filePath: string) => Promise<{ transferId: string; uploadId: string | null }>;
    status: (transferId: string) => Promise<{ progress: unknown }>;
    cancel: (transferId: string) => Promise<{ cancelled: boolean }>;
    listMine: (cursor?: string) => Promise<{
      releases: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>;
    onProgress: (callback: (progress: unknown) => void) => () => void;
    onConfirm: (callback: (request: unknown) => void) => () => void;
    resolveConfirm: (requestId: string, confirmed: boolean) => Promise<{ handled: boolean }>;
  };
  voiceInput: {
    prewarm: (payload?: {
      sourceLanguage?: string;
      refinementEnabled?: boolean;
    }) => Promise<{ ok: true }>;
    getBenchmarkFixtureAudio: () => Promise<
      { ok: true; path: string; wav: ArrayBuffer } | { ok: false }
    >;
    getMicrophonePermissionCached: () =>
      { ok: true; status: string } | { ok: false; status: string; error: string };
    getSystemPermissionsCached: () => {
      microphone: { ok: true; status: string } | { ok: false; status: string; error: string };
      inputMonitoring: { ok: true; status: string } | { ok: false; status: string; error: string };
      accessibility: { ok: true; status: string } | { ok: false; status: string; error: string };
    };
    requestMicrophonePermission: () => Promise<{ ok: true } | { ok: false; error: string }>;
    setRendererMicrophonePermissionVerified: (verified: boolean) => Promise<{ ok: true }>;
    getSystemPermissions: () => Promise<{
      microphone: { ok: true; status: string } | { ok: false; status: string; error: string };
      inputMonitoring: { ok: true; status: string } | { ok: false; status: string; error: string };
      accessibility: { ok: true; status: string } | { ok: false; status: string; error: string };
    }>;
    openMicrophoneSettings: () => Promise<{ ok: true } | { ok: false; error: string }>;
    openInputMonitoringSettings: () => Promise<VoiceInputGlobalResult>;
    /**
     * 失败走统一 IPC 错误协议（reject），成功路径只有 ok:true + 权限状态。
     * status 与 getSystemPermissions 的各项同为 string 形状（granted / denied / …）。
     */
    requestInputMonitoringPermission: () => Promise<{ ok: true; status: string }>;
    muteSystemAudio: () => Promise<{ ok: true } | { ok: false; error: string }>;
    restoreSystemAudio: () => Promise<{ ok: true } | { ok: false; error: string }>;
    testConnection: () => Promise<VoiceInputConnectionTestResult>;
    getReadiness: () => Promise<{
      ok: boolean;
      serviceMode: VoiceInputServiceModeData;
      provider:
        | 'custom-realtime-asr'
        | 'elevenlabs-scribe-realtime'
        | 'openai-realtime-whisper'
        | 'litellm-gpt-realtime-whisper'
        | 'litellm-qwen3-asr-flash-realtime'
        | 'litellm-volcengine-sauc-asr'
        | 'litellm-batch';
      providerModel: string;
      auth: 'api-key' | 'codex';
      settingsTab: 'api-keys' | 'connections' | 'providers';
      error?: string;
      authErrorReason?: string;
      failureReason?:
        'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
    }>;
    getReadinessCached: () => {
      ok: boolean;
      serviceMode: VoiceInputServiceModeData;
      provider:
        | 'custom-realtime-asr'
        | 'elevenlabs-scribe-realtime'
        | 'openai-realtime-whisper'
        | 'litellm-gpt-realtime-whisper'
        | 'litellm-qwen3-asr-flash-realtime'
        | 'litellm-volcengine-sauc-asr'
        | 'litellm-batch';
      providerModel: string;
      auth: 'api-key' | 'codex';
      settingsTab: 'api-keys' | 'connections' | 'providers';
      error?: string;
      authErrorReason?: string;
      failureReason?:
        'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
    } | null;
    getModelSelection: () => Promise<VoiceInputModelSelectionResultData>;
    setModelSelection: (patch: {
      serviceMode?: VoiceInputServiceModeData | null;
      asrProvider?: string | null;
      refinerProvider?: string | null;
      refinerModel?: string | null;
      customAsr?: {
        protocol: 'openai-realtime' | 'qwen-realtime';
        websocketUrl: string;
        model: string;
      } | null;
      customAsrApiKey?: string | null;
      /** BYOK fallback tail; null clears the override (primary runs alone). */
      refinerProviderChain?: string[] | null;
    }) => Promise<VoiceInputModelSelectionResultData>;
    reloadModelSelection: () => Promise<VoiceInputModelSelectionResultData>;
    openSettings: (tab: 'voice-input' | 'providers') => Promise<{ ok: true }>;
    start: (params?: {
      sourceLanguage?: string;
      refinementEnabled?: boolean;
      refinementCacheScope?: string;
      refinementContext?: VoiceRefinementContext;
    }) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
    appendAudio: (chunk: { pcm16k: ArrayBuffer; trace?: VoiceAudioTrace }) => void;
    drainAudioQueue: () => Promise<{ ok: true }>;
    stop: () => Promise<{ ok: true } | { ok: false; error: string }>;
    cancel: (params?: { runId?: string }) => Promise<{ ok: true }>;
    onEvent: (callback: (event: VoiceInputRendererEvent) => void) => () => void;
    getDataSnapshot: () => VoiceInputDataSnapshot;
    migrateLegacyRendererData: (payload: {
      settingsRaw?: string | null;
      historyRaw?: string | null;
    }) => VoiceInputDataSnapshot;
    updateSettings: (patch: Partial<VoiceInputSettingsData>) => Promise<VoiceInputSettingsData>;
    updateShortcutSetting: (shortcut: VoiceInputShortcut | null) => Promise<
      | {
          ok: true;
          settings: VoiceInputSettingsData;
          /** 已存盘但 macOS 监听权限未授权，快捷键要等授权后才生效。 */
          pendingInputMonitoring?: boolean;
        }
      | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode }
    >;
    deleteDictionaryEntries: (entryIds: string[]) => Promise<VoiceInputSettingsData>;
    addDictionaryEntry: (text: string) => Promise<VoiceInputSettingsData>;
    importDictionaryEntries: (texts: string[]) => Promise<VoiceInputSettingsData>;
    renameDictionaryEntry: (entryId: string, text: string) => Promise<VoiceInputSettingsData>;
    editDictionaryEntry: (
      entryId: string,
      text: string,
      aliases: string[],
    ) => Promise<VoiceInputSettingsData>;
    recordDictionaryLearningActions: (actions: VoiceInputDictionaryLearningAction[]) => Promise<{
      settings: VoiceInputSettingsData;
      newAutomaticEntries: Array<{ id: string; text: string }>;
    }>;
    getHistory: (limit?: number) => VoiceInputHistoryEntryData[];
    getHistoryForRefinement: () => VoiceInputHistoryEntryData[];
    recordHistory: (text: string) => string | null;
    updateHistoryEntry: (id: string, text: string) => void;
    deleteHistoryEntry: (id: string) => void;
    onDataChanged: (callback: (payload: VoiceInputDataSnapshot) => void) => () => void;
    /** options.suspend = 录制期挂起（故意与存盘不同）；不带它的请求会被 main 按存盘校验。 */
    setGlobalShortcut: (
      shortcut: VoiceInputShortcut | null,
      options?: { suspend?: true },
    ) => Promise<VoiceInputGlobalResult>;
    startModifierShortcutRecording: () => Promise<VoiceInputGlobalResult>;
    stopModifierShortcutRecording: () => Promise<VoiceInputGlobalResult>;
    onModifierShortcutKeys: (callback: (payload: { keys: string[] }) => void) => () => void;
    /** 「待授权」快捷键在设置页之外自动恢复失败（helper 起不来）。 */
    onShortcutRecoveryFailed: (callback: () => void) => () => void;
    /**
     * 取走「自动恢复失败」这条待通知状态（取走即清，一次 App 运行只提示一次）。
     * 挂载时也要主动取一次：失败可能发生在常挂载 UI 之前，那时推送没有订阅者。
     */
    consumeShortcutRecoveryFailure: () => Promise<{ failed: boolean }>;
    onGlobalShortcutTrigger: (
      callback: (payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void,
    ) => () => void;
    claimGlobalShortcutTrigger: (id: string) => void;
    onGlobalOverlayCommand: (
      callback: (command: { type: 'start' | 'submit' | 'cancel' }) => void,
    ) => () => void;
    adviseDictionaryLearning: (payload: VoiceInputDictionaryAdviceInput) => Promise<
      | {
          ok: true;
          actions: VoiceInputDictionaryLearningAction[];
          elapsedMs: number;
          ignoreReason?: string | null;
        }
      | { ok: false; error: string }
    >;
    onDictionaryLearningEvidence: (
      callback: (payload: {
        evidence: Pick<
          VoiceInputDictionaryAdviceInput,
          'source' | 'rawTranscriptText' | 'beforeText' | 'afterText' | 'context'
        >;
      }) => void,
    ) => () => void;
    /** 系统挂起/锁屏 → 释放 fast activation 的保活麦克风。 */
    onPowerStateChange: (callback: (payload: VoiceInputPowerStatePayload) => void) => () => void;
    notifyGlobalOverlayReady: () => void;
    pasteIntoFocusedTarget: (
      text: string,
      rawTranscriptText?: string,
    ) => Promise<VoiceInputGlobalResult>;
    restoreGlobalPasteTargetFocus: () => Promise<VoiceInputGlobalResult>;
    closeGlobalOverlay: (options?: { preservePasteTarget?: boolean }) => Promise<{ ok: true }>;
    showGlobalOverlay: () => Promise<VoiceInputGlobalResult>;
    beginGlobalOverlayDrag: () => void;
    moveGlobalOverlayDrag: () => void;
    endGlobalOverlayDrag: () => void;
    resetGlobalOverlayPosition: () => Promise<{ ok: true }>;
    openAccessibilitySettings: () => Promise<VoiceInputGlobalResult>;
    showDictionaryToast: (payload: {
      entryId?: string;
      term?: string;
      entries?: Array<{ entryId: string; term: string }>;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    closeDictionaryToast: () => Promise<{ ok: true }>;
  };

  windowBehavior: {
    setSwallowActivationClick: (enabled: boolean) => Promise<{ ok: true }>;
    getWindowsCloseBehavior: () => Promise<'quit' | 'tray' | null>;
    setWindowsCloseBehavior: (behavior: 'quit' | 'tray') => Promise<'quit' | 'tray'>;
    onWindowsCloseBehaviorRequested: (callback: () => void) => () => void;
    notifyWindowsCloseBehaviorPromptShown: () => void;
  };

  workLouderCodex: {
    getState: () => Promise<WorkLouderCodexState>;
    setSettings: (patch: WorkLouderCodexSettingsPatch) => Promise<WorkLouderCodexState>;
    resetSettings: () => Promise<WorkLouderCodexState>;
    openInputMonitoringSettings: () => Promise<void>;
    /** Re-check whether the device is still attached; the SDK never says so itself. */
    probe: () => Promise<WorkLouderCodexState>;
    /**
     * Hand the sidebar's task list to the agent keys. Main cannot see tasks on
     * linked machines, nor which machine filter is applied.
     */
    publishTasks: (
      tasks: import('../shared/workLouderCodex').WorkLouderCodexPublishedTask[],
    ) => Promise<void>;
    setLayoutPreviewActive: (active: boolean) => Promise<void>;
    onStateChanged: (callback: (state: WorkLouderCodexState) => void) => () => void;
    onAction: (callback: (action: WorkLouderCodexRendererAction) => void) => () => void;
    onPreviewInput: (
      callback: (input: import('../shared/workLouderCodex').WorkLouderCodexPreviewInput) => void,
    ) => () => void;
  };

  xboxGamepad: {
    getState: () => Promise<import('../shared/xboxGamepad').GamepadAccessoriesState>;
    setSettings: (
      family: import('../shared/xboxGamepad').GamepadFamily,
      patch: import('../shared/xboxGamepad').XboxGamepadSettingsPatch,
    ) => Promise<import('../shared/xboxGamepad').GamepadAccessoriesState>;
    resetSettings: (
      family: import('../shared/xboxGamepad').GamepadFamily,
    ) => Promise<import('../shared/xboxGamepad').GamepadAccessoriesState>;
    probe: () => Promise<import('../shared/xboxGamepad').GamepadAccessoriesState>;
    setLayoutPreviewActive: (
      active: boolean,
      family?: import('../shared/xboxGamepad').GamepadFamily,
    ) => Promise<void>;
    onStateChanged: (
      callback: (state: import('../shared/xboxGamepad').GamepadAccessoriesState) => void,
    ) => () => void;
    onPreviewInput: (
      callback: (input: import('../shared/xboxGamepad').XboxGamepadPreviewInput) => void,
    ) => () => void;
  };

  // ── 右侧栏独立子窗口(RSB window)──────────────────────────────────────
  // 「侧边栏在新窗口中显示」偏好 + 子窗口生命周期(main: right-sidebar-window/)。
  rightSidebarWindow: {
    getState: () => Promise<{
      detached: boolean;
      lastOpen: boolean;
      open: boolean;
      hostSessionId?: string | null;
    }>;
    /**
     * 幂等开窗。缺省(用户手势)已开则 show + focus;
     * userInitiated:false(启动恢复 / 插件 / agent 自发)已开则完全不动窗口。
     */
    open: (options?: { userInitiated?: boolean; sessionId?: string }) => Promise<void>;
    close: () => Promise<void>;
    /** 写偏好;true 附带开窗,false 附带关窗。返回新 state。 */
    setDetached: (
      detached: boolean,
      handoff?: import('../shared/rightSidebarWindow').RsbWindowTabHandoff,
    ) => Promise<{ detached: boolean; lastOpen: boolean; open: boolean }>;
    /** 子窗口 mount 时拉主窗上报的渲染上下文(main 缓存的最后一份)。 */
    getContext: () => Promise<{
      sessionId: string | null;
      workdir: string | null;
      remoteHostId: string | null;
      deviceLinkDeviceId?: string | null;
      subagentsAvailable?: boolean;
      available: boolean;
    } | null>;
    /** 子窗口根组件挂载握手。 */
    ready: () => Promise<void>;
    rendererReady: () => Promise<void>;
    presentationReady: () => Promise<void>;
    refreshContext: () => Promise<void>;
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void) => () => void;
    /** 主窗把命令转发给子窗口(必要时 main 先开窗)。 */
    /** main 原子裁决 attached / routed / queued / stale-context。 */
    sendCommand: (
      request: import('../shared/rightSidebarWindow').RsbWindowCommandRouteRequest,
    ) => Promise<import('../shared/rightSidebarWindow').RsbWindowCommandRouteResult>;
    /** 主窗上报侧边栏渲染上下文(fire-and-forget)。 */
    setContext: (ctx: {
      sessionId: string | null;
      workdir: string | null;
      remoteHostId: string | null;
      deviceLinkDeviceId?: string | null;
      subagentsAvailable?: boolean;
      available: boolean;
    }) => void;
    onStateChanged: (cb: (state: {
      detached: boolean;
      open: boolean;
      hostSessionId?: string | null;
      userClose?: boolean;
    }) => void) => () => void;
    onContextChanged: (
      cb: (ctx: {
        sessionId: string | null;
        workdir: string | null;
        remoteHostId: string | null;
        deviceLinkDeviceId?: string | null;
        subagentsAvailable?: boolean;
        available: boolean;
      }) => void,
    ) => () => void;
    onTabHandoff: (
      callback: (handoff: import('../shared/rightSidebarWindow').RsbWindowTabHandoff) => void,
    ) => () => void;
    onCommand: (cb: (cmd: RsbWindowCommand) => void) => () => void;
  };

  /** 资源用量独立子窗口(单实例;入口在顶部菜单)。 */
  resourceUsageWindow: {
    open: () => Promise<void>;
    close: () => Promise<void>;
    rendererReady: () => Promise<void>;
    presentationReady: () => Promise<void>;
    onSamplingActiveChanged: (cb: (active: boolean) => void) => () => void;
    onLocaleChanged: (cb: (locale: import('../shared/locale').SupportedLocale) => void) => () => void;
  };

  /** 插件停靠面板独立窗口(每 ghostId 一扇窗;状态机在 main)。 */
  ghostPanelWindow: {
    /** 首帧同步读全量状态(ghostId → entry)。 */
    getStateSync: () => import('../shared/ghostPanelWindow').GhostPanelWindowsState;
    getState: () => Promise<import('../shared/ghostPanelWindow').GhostPanelWindowsState>;
    /** 幂等:已开则 show + focus。 */
    open: (ghostId: string) => Promise<void>;
    /** 写偏好;true 开窗抽离,false 关窗回停靠。返回新全量 state。 */
    setDetached: (
      ghostId: string,
      detached: boolean,
    ) => Promise<import('../shared/ghostPanelWindow').GhostPanelWindowsState>;
    onStateChanged: (
      cb: (state: import('../shared/ghostPanelWindow').GhostPanelWindowsState) => void,
    ) => () => void;
    rendererReady: () => Promise<void>;
    presentationReady: () => Promise<void>;
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void) => () => void;
    onCloseRequested: (cb: () => void) => () => void;
    onMinimizeRequested: (cb: () => void) => () => void;
    resolveCloseRequest: (approved: boolean) => Promise<void>;
  };

  agentIsland: {
    setVisibleSession: (sessionId: string | string[] | null) => Promise<{ ok: true }>;
    setEnabled: (enabled: boolean) => Promise<{ ok: true }>;
    setSoundSettings: (settings: AgentIslandSoundSettings) => Promise<{ ok: true }>;
    setMascotSkin: (skin: AgentIslandMascotSkin) => Promise<{ ok: true }>;
    setDisplayTarget: (target: AgentIslandDisplayTarget) => Promise<{ ok: true }>;
    getDisplayOptions: () => Promise<{
      ok: true;
      options: AgentIslandDisplayOption[];
      target?: AgentIslandDisplayTarget;
    }>;
    previewSound: (sound: AgentIslandSoundChoice) => Promise<{ ok: true }>;
    selectSoundFile: () => Promise<{ ok: true; path: string | null; name: string | null }>;
    onSessionActivity: (cb: (list: AgentIslandSessionActivity[]) => void) => () => void;
  };

  // ── Find in Page (F-FIP-1) ──
  findInPage: (params: {
    text: string;
    forward?: boolean;
    findNext?: boolean;
    matchCase?: boolean;
  }) => Promise<number | null>;
  stopFindInPage: (action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  onFindInPageResult: (
    callback: (result: {
      requestId: number;
      activeMatchOrdinal: number;
      matches: number;
      finalUpdate: boolean;
    }) => void,
  ) => () => void;
  onSelectionContextMenuAddToChat: (callback: () => void) => () => void;
  safeStorageStore: (key: string, value: string) => Promise<boolean>;
  safeStorageRead: (key: string) => Promise<string | null>;
  safeStorageRemove: (key: string) => Promise<{ success: boolean; error?: string }>;
  /** 内置 API-key 供应商专用 IPC(查/写/删,永不回读明文;对应 MAIN_ONLY 键)。mutation 失败抛统一 IPC 错误。 */
  builtinApiKeyHas: (providerId: string) => Promise<boolean>;
  builtinApiKeyStore: (providerId: string, value: string) => Promise<void>;
  builtinApiKeyRemove: (providerId: string) => Promise<void>;
  /** CC 网络调试日志开关 (admin experimental). main 端 mutate process.env.XDT_CC_DEBUG_NET。 */
  ccSetDebugNet: (enabled: boolean) => Promise<{ ok: true }>;
  /** 网关凭据自动下发(model-access,类型见 shared/modelAccess.ts)。 */
  modelAccess: {
    getStatus: () => Promise<ModelAccessStatusPayload>;
    retry: () => Promise<ModelAccessStatusPayload>;
    /** 轮换密钥;失败 reject(IPC 错误经 extractIpcError 解码)。 */
    rotate: () => Promise<ModelAccessStatusPayload>;
    onStatusChange: (callback: (status: ModelAccessStatusPayload) => void) => () => void;
  };
  // ── Auth (delegated to main process authManager) ──
  /** 首启亮色门会话线索:主进程是否持有存量会话(sendSync,首帧前判定用)。 */
  authHasPersistedSessionHintSync: () => boolean;
  authInitialize: () => Promise<{
    user: AuthUser | null;
    mode: 'signed-out' | 'local' | 'cloud';
    dataOwnerId: string | null;
    ownerGeneration: number;
    canEnterApp: boolean;
    isAuthenticated: boolean;
    isCanary: boolean;
    /** SkillHub 跨设备识别：本机 deviceId，登录前后都有值 */
    deviceId: string;
    hasAccountDeletionReceipt: boolean;
    accountDeletionRestored: boolean;
    /** 持久凭证库(safeStorage)连续多个刷新周期不可用(#1687)。 */
    credentialStoreUnavailable?: boolean;
  }>;
  authGetLoginState: () => Promise<DesktopLoginActionResult>;
  authDispatchLoginAction: (action: DesktopLoginAction) => Promise<DesktopLoginActionResult>;
  /** 登录 captcha 托管挑战页地址(不含 query);LoginCaptchaOverlay 装载 webview 用。 */
  authGetCaptchaChallengeUrl: () => Promise<string>;
  authLogout: () => Promise<void>;
  authListAccounts: () => Promise<DesktopAccountSwitcherSnapshot>;
  authSyncAccounts: () => Promise<DesktopAccountSwitcherSnapshot>;
  authSwitchAccount: (accountKey: string) => Promise<void>;
  authBeginAddAccount: () => Promise<DesktopLoginActionResult>;
  authCancelAddAccount: () => Promise<void>;
  authEnterLocal: () => Promise<AuthStateChangePayload>;
  authExitLocal: () => Promise<AuthStateChangePayload>;
  authRefresh: () => Promise<boolean>;
  authGetAccountDeletionAvailability: () => Promise<DesktopAccountDeletionAvailabilityResult>;
  authRequestAccountDeletionChallenge: () => Promise<DesktopAccountDeletionChallengeResult>;
  authConfirmAccountDeletion: (
    input: DesktopAccountDeletionConfirmInput,
  ) => Promise<DesktopAccountDeletionConfirmResult>;
  authGetAccountDeletionStatus: () => Promise<DesktopAccountDeletionStatusResult>;
  authClearAccountDeletionReceipt: () => Promise<void>;
  authConsumeAccountDeletionRestoredNotice: () => Promise<boolean>;
  onAuthStateChange: (callback: (state: AuthStateChangePayload) => void) => () => void;
  onAuthSessionExpired: (callback: (state: AuthSessionExpiredPayload) => void) => () => void;

  // ── 使用统计(TapDB)同意闸 ──
  getAnalyticsSettings: () => Promise<AnalyticsSettingsPayload>;
  setAnalyticsEnabled: (enabled: boolean) => Promise<AnalyticsSettingsPayload>;
  resetAnalyticsEnabled: () => Promise<AnalyticsSettingsPayload>;
  acceptPrivacyConsent: () => Promise<AnalyticsSettingsPayload>;
  onAnalyticsSettingsChange: (callback: (payload: AnalyticsSettingsPayload) => void) => () => void;

  // ── 客户端日志上报(设置 → 关于)──
  // 只上报 App 自身的运行记录 + 设备环境信息;对话内容、文件内容、提示词、工作目录路径
  // 永不上报,凭证与邮箱在上传前被自动抹除(实现见 main/log-upload/)。
  getLogUploadSettings: () => Promise<LogUploadSettingsPayload>;
  setLogUploadCrashAuto: (enabled: boolean) => Promise<LogUploadSettingsPayload>;
  /** 恢复默认:删掉开关 override,重新跟随当前版本默认值(默认关闭)。 */
  resetLogUploadCrashAuto: () => Promise<LogUploadSettingsPayload>;
  /**
   * 手动上传一次;成功返回可报的上传编号。失败以 IPC 错误码区分:
   * `LOG_UPLOAD_UNAVAILABLE`(未配置目标)/ `PRIVACY_CONSENT_REQUIRED`(未同意)/
   * `LOG_UPLOAD_EMPTY`(采到 0 条)/ `LOG_UPLOAD_FAILED`(网络)/ `LOG_UPLOAD_BUSY`。
   */
  uploadLogsNow: () => Promise<LogUploadResult>;
  onLogUploadSettingsChange: (callback: (payload: LogUploadSettingsPayload) => void) => () => void;

  // ── Profile 编辑(设置 → 用户卡片编辑名字 / 头像;直写服务端,跨设备生效) ──
  profileGetState: () => Promise<{
    name: string;
    avatarUrl: string | null;
  }>;
  profileChooseAvatar: () => Promise<{
    canceled: boolean;
    filePath?: string;
    previewDataUrl?: string;
  }>;
  profileUpdate: (params: {
    name: string | null;
    avatar: { type: 'keep' } | { type: 'set'; filePath: string } | { type: 'reset' };
  }) => Promise<{ ok: true }>;

  // Slack 官方 MCP(slackOfficial)已于 2026-07-15 退役(能力迁入内置意识 cindy-slack);
  // github / gitlab bridge 已于 2026-07-14 退役(GitHub 能力迁入内置意识
  // cindy-github,GitLab 能力迁入内置意识 cindy-gitlab)

  // ── FeiShu Bot (Settings → FeiShu Bot tab) ──
  feishuBot: {
    getState: () => Promise<{
      status: FeishuBotStatus;
      appId: string | null;
      appSecret: string | null;
      hasSecret: boolean;
      ownerOpenId: string | null;
      error?: string;
      lifecycleAnnouncement: boolean;
      service: 'feishu' | 'lark';
    }>;
    save: (payload: { appId: string; appSecret: string; service: 'feishu' | 'lark' }) => Promise<{
      verdict: 'connected' | 'conflict' | 'error' | 'pending';
    }>;
    reconnect: () => Promise<{
      verdict: 'connected' | 'conflict' | 'error';
    }>;
    clear: () => Promise<{ ok: true }>;
    setLifecycleAnnouncement: (enabled: boolean) => Promise<{ ok: true }>;
    registrationBegin: (service: 'feishu' | 'lark') => Promise<FeishuBotRegistrationBeginResult>;
    registrationCancel: () => Promise<{ ok: true }>;
    onStatusChange: (
      callback: (update: {
        status: FeishuBotStatus;
        error?: string;
        botAppId: string | null;
        ownerOpenId: string | null;
      }) => void,
    ) => () => void;
    onConflict: (callback: (payload: { appId: string }) => void) => () => void;
    onRegistrationStatus: (
      callback: (payload: FeishuBotRegistrationStatusPayload) => void,
    ) => () => void;
  };

  // ── Discord Bot (Settings → IM Bot tab) ──
  discordBot: {
    getStatus: () => Promise<{
      status: DiscordBotTransportStatus;
      ownerUserId: string | null;
      lifecycleAnnouncement: boolean;
    }>;
    setConfig: (payload: { token: string; ownerUserId: string }) => Promise<{
      status: DiscordBotTransportStatus;
      saveErrorStatus?: DiscordBotTransportStatus;
      ownerUserId: string | null;
    }>;
    disconnect: () => Promise<{
      status: DiscordBotTransportStatus;
    }>;
    setLifecycleAnnouncement: (enabled: boolean) => Promise<{
      ok: boolean;
      lifecycleAnnouncement: boolean;
    }>;
    checkSessionAuth: () => Promise<DiscordBotSessionAuthCheckResult>;
    onStatusChange: (
      callback: (update: { status: DiscordBotTransportStatus }) => void,
    ) => () => void;
  };

  // ── Personal Telegram Bot (Settings → IM Bot → Personal) ──
  telegramBot: {
    getStatus: () => Promise<{
      status: TelegramBotTransportStatus;
      ownerUserId: string | null;
      botUsername: string | null;
    }>;
    setConfig: (payload: { token: string; ownerUserId: string }) => Promise<{
      status: TelegramBotTransportStatus;
      saveErrorStatus?: TelegramBotTransportStatus;
      ownerUserId: string | null;
      botUsername: string | null;
    }>;
    disconnect: () => Promise<{
      status: TelegramBotTransportStatus;
    }>;
    /** 上线/下线(保留 token 与绑定信息, 只切轮询)。 */
    setOnline: (payload: { online: boolean }) => Promise<{
      status: TelegramBotTransportStatus;
    }>;
    checkSessionAuth: () => Promise<DiscordBotSessionAuthCheckResult>;
    getBehavior: () => Promise<TelegramBotBehavior>;
    setBehavior: (patch: Partial<TelegramBotBehavior>) => Promise<TelegramBotBehavior>;
    listGroups: () => Promise<{
      groups: Array<{ chatId: string; chatName: string | null; activation: 'mention' | 'always' }>;
    }>;
    setGroupActivation: (payload: {
      chatId: string;
      mode: 'mention' | 'always';
    }) => Promise<unknown>;
    getPersona: () => Promise<{ botName: string; soul: string }>;
    setPersona: (payload: {
      botName?: string;
      soul?: string;
      syncProfile?: boolean;
    }) => Promise<{ persona: { botName: string; soul: string }; profileSynced?: boolean }>;
    onStatusChange: (
      callback: (update: {
        status: TelegramBotTransportStatus;
        botUsername: string | null;
      }) => void,
    ) => () => void;
  };

  // ── Personal DingTalk Bot (Settings → IM Bot → Personal) ──
  dingtalkBot: {
    getState: () => Promise<{
      status: DingTalkBotTransportStatus;
      appKey: string | null;
      hasSecret: boolean;
      ownerUserId: string | null;
    }>;
    save: (payload: { appKey: string; appSecret: string }) => Promise<{
      status: DingTalkBotTransportStatus;
      appKey: string | null;
      hasSecret: boolean;
      ownerUserId: string | null;
    }>;
    reconnect: () => Promise<{
      status: DingTalkBotTransportStatus;
      appKey: string | null;
      hasSecret: boolean;
      ownerUserId: string | null;
    }>;
    clear: () => Promise<{ ok: true }>;
    onStatusChange: (
      callback: (update: { status: DingTalkBotTransportStatus }) => void,
    ) => () => void;
    onOwnerChange: (callback: (update: { ownerUserId: string }) => void) => () => void;
  };

  wecomBot: {
    getStatus: () => Promise<{
      status: WecomBotTransportStatus;
      botId: string | null;
      ownerUserId: string | null;
    }>;
    setConfig: (payload: { botId: string; secret: string }) => Promise<{
      status: WecomBotTransportStatus;
      saveErrorStatus?: WecomBotTransportStatus;
      botId: string | null;
      ownerUserId: string | null;
    }>;
    reconnect: () => Promise<{
      status: WecomBotTransportStatus;
      botId: string | null;
      ownerUserId: string | null;
    }>;
    disconnect: () => Promise<{
      status: WecomBotTransportStatus;
      botId: string | null;
      ownerUserId: string | null;
    }>;
    onStatusChange: (
      callback: (update: {
        status: WecomBotTransportStatus;
        botId: string | null;
        ownerUserId: string | null;
      }) => void,
    ) => () => void;
  };

  // ── Personal WeChat (Settings → IM Bot → Personal) ──
  wechatBot: {
    getState: () => Promise<WechatBotState>;
    authorize: () => Promise<{ started: true }>;
    cancelAuthorization: () => Promise<{ ok: true }>;
    unbind: () => Promise<{ ok: true }>;
    getChannelSettings: () => Promise<WechatChannelSettingsState>;
    chooseWorkingDirectory: () => Promise<{
      canceled: boolean;
      state: WechatChannelSettingsState;
    }>;
    resetWorkingDirectory: () => Promise<WechatChannelSettingsState>;
    onStateChange: (callback: (state: WechatBotState) => void) => () => void;
  };

  /**
   * Renderer → main signal that the user is logged in and localDb is open.
   * Triggers FeishuBot WS connection (gated; otherwise the bot would come
   * online before the app can actually serve requests). Idempotent.
   */
  appReadyForBot: () => Promise<{ ok: true }>;

  syncDesktopCcPrefs: (prefs: {
    model: string;
    effort: string;
    permissionMode: string;
    fastMode: boolean;
    providerId: string | null;
  }) => void;

  syncNewMakerDraft: (snapshot: {
    lastByVendor: Partial<
      Record<
        'cc' | 'codex' | 'pi',
        { model?: string; effort?: string; permissionMode?: string; providerId?: string | null }
      >
    >;
    /** 每个 vendor 是否由用户在 New Maker 中明确选过模型；device-link 默认校准据此保护显式选择。 */
    modelChosenByVendor: Partial<Record<'cc' | 'codex' | 'pi', boolean>>;
    fastModeByModel: Record<string, boolean>;
    effortByModel: Record<string, string>;
    /** 「新建会话默认启用 worktree」勾选记忆(vendor 无关根字段,远程草稿播种用)。 */
    worktreeEnabled: boolean;
  }) => void;

  /** Renderer localStorage workerCreationPrefs → main 内存镜像。 */
  syncWorkerCreationPrefs: (snapshot: {
    workerPermissionMode: 'auto' | 'bypassPermissions';
  }) => void;

  /** 被控端 renderer → 自身 main:providerModelMemory 全量快照镜像(草稿列表行真实读源)。 */
  syncProviderModelMemory: (
    snapshot: Record<
      string,
      { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
    >,
  ) => void;

  /** 被控端 renderer → 自身 main:会话「非选中模型」effort/fast 变化镜像(转发给控制端)。 */
  syncSessionModelPref: (pref: {
    sessionId: string;
    agent: 'claude-code' | 'codex' | 'pi';
    providerId: string;
    model: string;
    effort?: string;
    fast?: boolean;
  }) => void;

  /** 被控端本地 main → 自身 renderer:控制端写穿的草稿「模型 effort/fast」pref(调本地 setter)。 */
  onMakerDraftPrefApply: (
    cb: (payload: {
      agent: 'claude-code' | 'codex' | 'pi';
      providerId: string;
      modelId: string;
      active: boolean;
      markModelChoice?: boolean;
      effort?: string;
      fast?: boolean;
      thinking?: boolean;
    }) => void,
  ) => () => void;

  /** 被控端本地 main → 自身 renderer:控制端写穿的「新建会话默认启用 worktree」(patchDraft 写真实草稿)。 */
  onMakerWorktreePrefApply: (cb: (payload: { worktreeEnabled: boolean }) => void) => () => void;

  /** 工作端 canonical baseRepo scoped 的新建 worktree 源分支；未选过返回 null。 */
  getNewMakerWorktreeBranchPreference: (
    baseRepo: string,
  ) => Promise<NewMakerWorktreeBranchPreferenceSnapshot | null>;

  /** 写穿本机工作端的源分支选择，返回 host 接受后的权威 snapshot。 */
  applyNewMakerWorktreeBranchPreference: (
    baseRepo: string,
    sourceBranch: string,
  ) => Promise<NewMakerWorktreeBranchPreferenceSnapshot>;

  /** 本机或远程控制端改动本工作端源分支后的权威广播。 */
  onNewMakerWorktreeBranchChanged: (
    cb: (snapshot: NewMakerWorktreeBranchPreferenceSnapshot) => void,
  ) => () => void;

  /** Orca tool 显式修改 Worker 默认权限后，回写 renderer localStorage。 */
  onWorkerCreationPrefsApply: (
    cb: (payload: { workerPermissionMode: 'auto' | 'bypassPermissions' }) => void,
  ) => () => void;

  /** 被控端本地 main → 自身 renderer:控制端写穿的会话「模型 effort/fast」pref(调本地 setter)。 */
  onMakerSessionPrefApply: (
    cb: (payload: {
      sessionId: string;
      agent: 'claude-code' | 'codex' | 'pi';
      providerId: string;
      model: string;
      effort?: string;
      fast?: boolean;
    }) => void,
  ) => () => void;

  // ── IM Binding (feishu /ctr 接管 → desktop session 路由) ──
  binding: {
    resolveSession: (sessionId: string) => Promise<{
      attached: boolean;
      identity?: { channel: string; botContextId: string; userId: string } | null;
      displayName?: string | null;
    }>;
    revoke: (sessionId: string) => Promise<{
      ok: true;
      alreadyDetached?: boolean;
    }>;
    listAttached: () => Promise<{ sessionIds: string[] }>;
    onChanged: (
      callback: (payload: {
        sessionId: string | null;
        attached: boolean;
        channel: string | null;
        userId: string | null;
      }) => void,
    ) => () => void;
  };

  checkEnvironment: () => Promise<EnvCheckResult>;
  onBinaryDownloadProgress: (
    callback: (payload: BinaryDownloadProgressPayload) => void,
  ) => () => void;
  checkAppUpdate: () => Promise<{
    hasUpdate: boolean;
    action?: 'relaunch' | 'none';
    version?: string;
    error?: 'manifest_failed' | 'download_failed';
  }>;
  onAppUpdateProgress: (callback: (payload: AppUpdateProgressPayload) => void) => () => void;
  fileBrowser: {
    listDir: (params: {
      /** 非空 = SSH remote 会话,操作经远端 file-service 执行(main 侧路由)。 */
      remoteHostId?: string | null;
      workdir: string;
      relPath?: string;
      hideMetaFiles?: boolean;
      docMode?: boolean;
    }) => Promise<
      Array<{
        name: string;
        relPath: string;
        type: 'file' | 'directory';
        size: number;
        mtimeMs: number;
      }>
    >;
    /** 项目级文件名扁平列表(ripgrep --files honor .gitignore);失败返回空数组
     *  + error 字段,renderer 应做 fallback 渲染。 */
    listAllFiles: (params: {
      remoteHostId?: string | null;
      workdir: string;
      cap?: number;
    }) => Promise<{
      files: string[];
      truncated: boolean;
      elapsedMs: number;
      error?: string;
    }>;
    readFile: (params: {
      remoteHostId?: string | null;
      workdir: string;
      relPath: string;
    }) => Promise<
      | {
          ok: true;
          data: {
            relPath: string;
            content: string;
            size: number;
            mtimeMs: number;
            truncated: boolean;
          };
        }
      /** OVERSIZE = 远程文本超传输上限(device-link 帧限预判),stat 供"文件过大"占位卡。 */
      | { ok: false; code: 'BINARY_FILE' | 'READ_FAILED'; message?: string }
      | {
          ok: false;
          code: 'OVERSIZE';
          stat: { relPath: string; type: 'file'; size: number; mtimeMs: number };
        }
    >;
    writeFile: (params: {
      remoteHostId?: string | null;
      workdir: string;
      relPath: string;
      content: string;
    }) => Promise<{ ok: true; size: number; mtimeMs: number } | { ok: false; message: string }>;
    createFile: (params: {
      remoteHostId?: string | null;
      workdir: string;
      relPath: string;
    }) => Promise<
      | {
          ok: true;
          stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number };
        }
      | { ok: false; message: string }
    >;
    createFolder: (params: {
      remoteHostId?: string | null;
      workdir: string;
      relPath: string;
    }) => Promise<
      | {
          ok: true;
          stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number };
        }
      | { ok: false; message: string }
    >;
    deleteEntry: (params: {
      remoteHostId?: string | null;
      workdir: string;
      relPath: string;
    }) => Promise<{ ok: true } | { ok: false; message: string }>;
    renameEntry: (params: {
      remoteHostId?: string | null;
      workdir: string;
      fromRel: string;
      toRel: string;
    }) => Promise<
      | {
          ok: true;
          stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number };
        }
      | { ok: false; message: string }
    >;
    stat: (params: { remoteHostId?: string | null; workdir: string; relPath: string }) => Promise<{
      relPath: string;
      type: 'file' | 'directory';
      size: number;
      mtimeMs: number;
    }>;
    startWatch: (params: {
      remoteHostId?: string | null;
      workdir: string;
      hideMetaFiles?: boolean;
    }) => Promise<{ ok: boolean }>;
    stopWatch: (params: {
      remoteHostId?: string | null;
      workdir: string;
    }) => Promise<{ ok: boolean }>;
    onEvent: (
      cb: (event: {
        workdir: string;
        type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
        relPath: string;
      }) => void,
    ) => () => void;
    /** 大文件取回:远程文件拉到本地缓存,返回缓存绝对路径。 */
    fetchRemote: (params: {
      workdir: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      remoteHostId?: string | null;
      deviceId?: string | null;
    }) => Promise<{ ok: true; cachePath: string; stale: boolean } | { ok: false; message: string }>;
    readCached: (params: {
      cachePath: string;
    }) => Promise<
      | { ok: true; kind: 'text'; content: string; truncated: boolean }
      | { ok: true; kind: 'binary' }
      | { ok: false; message: string }
    >;
    cachePut: (params: {
      workdir: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      content: string;
      remoteHostId?: string | null;
      deviceId?: string | null;
    }) => Promise<{ ok: boolean }>;
    onTransferProgress: (
      cb: (event: {
        workdir: string;
        relPath: string;
        received: number;
        total: number;
        phase?: 'upload' | 'download';
      }) => void,
    ) => () => void;
    /** 聊天流文件取回:远端绝对路径 → 本地缓存副本(进度经 onTransferProgress,relPath 键 = absPath)。 */
    chatFetch: (params: {
      origin: { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };
      workdir: string;
      absPath: string;
    }) => Promise<
      | { ok: true; cachePath: string; stale: boolean; size: number }
      | {
          ok: false;
          code: 'BAD_ARGS' | 'OUTSIDE_WORKDIR' | 'NOT_FOUND' | 'FETCH_FAILED';
          message?: string;
        }
    >;
    /** 聊天流文件 chip 点亮预检:远端精确 stat。file=点亮;nonfile=保持纯文本;unknown=乐观点亮。 */
    chatStat: (params: {
      origin: { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };
      workdir: string;
      absPath: string;
    }) => Promise<{ verdict: 'file' | 'directory' | 'nonfile' | 'unknown' }>;
  };
  // Project-wide text search (rg-backed). 单 active 策略:start 时若已有 active
  // search 会自动被 cancel。所有结果通过 onEvent 流式回推。
  search: {
    start: (params: {
      /** 非空 = SSH remote 会话;P3 接远端 rg 前 main 直接拒绝。 */
      remoteHostId?: string | null;
      workdir: string;
      query: string;
      caseSensitive: boolean;
      maxMatches: number;
    }) => Promise<
      | {
          ok: true;
          searchId: string;
          /** 远程搜索启动窗口内 daemon 秒回的事件,随响应带回由 renderer 回放。 */
          replay?: Array<
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
          >;
        }
      /** code = 稳定错误码(如 RG_UNAVAILABLE),renderer 按码映射友好文案。 */
      | { ok: false; message: string; code?: string }
    >;
    cancel: (params: { searchId: string; remoteHostId?: string | null }) => Promise<{ ok: true }>;
    onEvent: (
      cb: (
        event:
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
          | { type: 'error'; searchId: string; message: string },
      ) => void,
    ) => () => void;
  };
  showOpenDirectoryDialog: () => Promise<{ canceled: boolean; path?: string }>;
  openExternal: (url: string) => Promise<{ success: boolean }>;
  openChatGPTApp: () => Promise<{ success: boolean }>;

  // 绝对路径或完整本地 file:// URL;URL 形态用于保留 query/hash 页面状态。
  openFileInBrowser: (filePathOrUrl: string) => Promise<{ success: true }>;

  // ── 系统级通知（CC Agent session 状态变更）──
  /**
   * 弹一条桌面通知。kind 决定文案：
   *   - 'done'        — 真完成，文案 "任务「xxx」已完成"
   *   - 'error'       — 执行失败，文案 "任务「xxx」执行失败"
   *   - 'needs-reply' — 等用户回复（ask-user / permission / plan-review），
   *                     文案 "任务「xxx」需要你回复"
   */
  notificationShowSessionEvent: (payload: {
    sessionId: string;
    title: string;
    kind: 'done' | 'error' | 'needs-reply';
    /**
     * 选择性走哪些通知通道; 缺省 / 未传 → 兼容旧行为(仅桌面)。
     * renderer 侧 gate(localStorage notifications.enabled /
     * notifications.feishuEnabled)后填入。
     * mobile = 手机推送:桌面侧无独立开关(手机端注册/注销 token 决定接收),
     * 发送侧防打扰在 main 的 device-link 模块收口,renderer 恒传 true。
     */
    channels?: { desktop?: boolean; feishu?: boolean; mobile?: boolean };
  }) => Promise<void>;
  /** Sync the renderer-owned global desktop-notification preference to main. */
  notificationSetDesktopEnabled?: (enabled: boolean) => Promise<{ ok: true }>;
  wecomGroupNotification: {
    getState: () => Promise<{ configured: boolean; enabled: boolean; maskedKey?: string }>;
    saveAndTest: (
      webhookUrl: string,
      testMessage: string,
    ) => Promise<{ configured: boolean; enabled: boolean; maskedKey?: string }>;
    test: (testMessage: string) => Promise<{ ok: true }>;
    setEnabled: (
      enabled: boolean,
    ) => Promise<{ configured: boolean; enabled: boolean; maskedKey?: string }>;
    clear: () => Promise<{ configured: boolean; enabled: boolean }>;
  };
  /** 将对应 session 标记为需要关注，显示 Dock/taskbar app badge。 */
  notificationMarkSessionAttention: (sessionId: string) => Promise<void>;
  /** 用户查看对应 session 后，清除系统级 Dock/taskbar attention badge。 */
  notificationClearSessionAttention: (
    sessionId: string,
    intent?: 'explicit' | 'passive',
  ) => Promise<void>;
  /**
   * main → renderer 的会话已读广播(payload:{ sessionId, intent })。清除来源可能是
   * device-link 远程控制端(手机看完会话),sessionAttentionStore 订阅后把本机侧栏
   * 红绿点一并清掉;本机自己发起的清除收到回声做幂等 no-op。
   */
  onSessionAttentionCleared: (callback: (payload: unknown) => void) => () => void;
  /** 用户点击系统通知后，主进程把对应 sessionId 广播过来，renderer 跳路由。 */
  onNotificationFocusSession: (callback: (sessionId: string) => void) => () => void;

  /**
   * RSB web-browser plugin popup 路由订阅。guest webview 内 `window.open` /
   * `<a target="_blank">` / window.location 跨 host 时,main 端 webview-security
   * setWindowOpenHandler 把 url + disposition(+ opener 归属,按发起方 guest 的
   * webContentsId 从 TabRegistry 反查)推过来,renderer 端 RightSidebarShell
   * 收到后调 store.addTab 开新 web-browser tab——有 openerSessionId 时落进该
   * session 的 bucket,而不是用户正在看的 session。
   */
  onRsbBrowserPopup: (
    callback: (payload: {
      url: string;
      disposition: string;
      openerTabId?: string;
      openerSessionId?: string;
      nativePopupSurfaceId?: string;
    }) => void,
  ) => () => void;

  /** Main-owned WebContentsView used only for Chromium-created popup contexts. */
  rsbNativePopup: {
    claim: (
      input: import('../shared/rsbNativePopup').RsbNativePopupClaimInput,
    ) => Promise<import('../shared/rsbNativePopup').RsbNativePopupClaimResult>;
    setBounds: (input: {
      surfaceId: string;
      bounds: import('../shared/rsbNativePopup').RsbNativePopupBounds;
      visible: boolean;
    }) => Promise<{ ok: true }>;
    command: (
      input: { surfaceId: string } & import('../shared/rsbNativePopup').RsbNativePopupCommand,
    ) => Promise<{ ok: true }>;
    close: (input: { surfaceId: string }) => Promise<{ ok: true }>;
    onEvent: (
      callback: (event: import('../shared/rsbNativePopup').RsbNativePopupEvent) => void,
    ) => () => void;
  };

  /**
   * RSB web-browser plugin:guest webview 内按下 Cmd/Ctrl+L 时,main 端
   * webview-security 用 before-input-event 拦截后推过来。BrowserTabBody 根据
   * 自身 active 状态过滤,active tab 调 chrome.focusUrlBar()。
   */
  onRsbBrowserFocusUrlBar: (callback: () => void) => () => void;

  /**
   * RSB web-browser plugin:guest webview 内按下浏览器级快捷键时,main 端
   * webview-security 用 before-input-event 拦截后推过来。BrowserTabBody 根据
   * 自身 active 状态过滤,active tab 执行对应 browser action。
   * 'close-tab' = guest 内 ⌘W / Ctrl+W,active tab 关掉自己。
   */
  onRsbBrowserCommand: (
    callback: (payload: {
      command:
        'go-back' | 'go-forward' | 'reload' | 'close-tab' | 'right-tab-prev' | 'right-tab-next';
    }) => void,
  ) => () => void;

  /**
   * cindy://(+ 历史 xdt-maker://)深度链接 + --open-folder 右键菜单订阅:main 端在 open-url /
   * second-instance / 冷启动 argv 解析后通过此 channel 推 payload。
   * renderer 端 MainLayout 订阅 → navigate (session) / requestProjectFocus
   * (project) / patchDraft+navigate('/cc-agent/new') (new-session)。
   */
  onDeepLinkNavigate: (
    callback: (
      payload:
        | { type: 'session'; id: string; messageClientId?: string }
        | { type: 'project'; workingDir: string }
        | { type: 'new-session'; workingDir: string }
        | { type: 'share-import'; filePath: string }
        | { type: 'settings'; tab: 'voice-input' | 'providers'; connect?: string },
    ) => void,
  ) => () => void;

  /**
   * 冷启动期间 (mainWindow 未 ready / renderer 未挂 listener) 缓存的 deep link /
   * --open-folder payload。MainLayout mount 后调一次,take 一次清空——已运行
   * 场景始终返回 null。未登录用户冷启动 + deep link 时,此机制保证用户完成
   * Feishu OAuth 后能继续消费当时的"点击意图"。
   */
  takePendingDeepLink: () => Promise<
    | { type: 'session'; id: string; messageClientId?: string }
    | { type: 'project'; workingDir: string }
    | { type: 'new-session'; workingDir: string }
    | { type: 'share-import'; filePath: string }
    | { type: 'settings'; tab: 'voice-input' | 'providers'; connect?: string }
    | null
  >;

  // ── TextLightbox (text-lightbox F4/F5) ──
  /**
   * Read a text file (≤ MAX_PREVIEW_MB) for the in-app preview overlay. When
   * the file is larger than the cap the response is
   * `{ success:false, reason:'oversize' }` — the renderer should switch to the
   * Oversize body using `size`. `limitMb` mirrors the main-process preview cap
   * (single-sourced) so the renderer can render dynamic
   * "exceeding the {limitMb} MB preview limit" copy.
   */
  readTextFilePreview: (params: { filePath: string }) => Promise<{
    success: boolean;
    error?: string;
    reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';
    data?: string;
    size: number;
    limitMb?: number;
  }>;
  /**
   * Open a local file path with the OS default application. Used by the
   * TextLightbox toolbar Open-in-System button and the Oversize main button.
   */
  openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;

  /**
   * 文件 chip 右键「打开方式」:枚举可打开该文件的应用(Windows 注册表;
   * 其余平台空列表)。appId 只在 main 侧映射到可执行体,renderer 原样回传。
   */
  listOpenWithApps: (params: { filePath: string }) => Promise<{
    success: boolean;
    apps: Array<{ id: string; label: string; iconDataUrl?: string }>;
    error?: string;
  }>;
  /** 用 listOpenWithApps 返回的 appId 指定应用打开文件;失败以 IPC 错误抛出。 */
  openFileWithApp: (params: { filePath: string; appId: string }) => Promise<void>;

  /** Copy a dangerous local attachment into the controlled inert cache. */
  stageChatAttachment: (params: { sourcePath: string; suggestedName: string }) => Promise<
    | { success: true; path: string }
    | {
        success: false;
        code:
          | 'invalid_source'
          | 'forbidden'
          | 'not_found'
          | 'not_file'
          | 'unsupported_type'
          | 'copy_failed';
      }
  >;

  /** Remove staged dangerous attachment copies from the controlled cache. */
  cleanupStagedChatAttachments: (filePaths: readonly string[]) => Promise<void>;

  /**
   * Save a safely materialized chat attachment under its sanitized original
   * filename. The main process validates the source and never opens the target.
   */
  saveChatAttachmentAs: (params: { sourcePath: string; suggestedName: string }) => Promise<
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
  >;

  /**
   * Open the app's log directory (`<userData>/logs`) in the OS file manager.
   * Path is derived in main; renderer cannot pass it. Used by Settings → About.
   */
  openLogsDir: () => Promise<{ success: boolean; error?: string }>;

  /**
   * Reveal a file in the OS file manager (Explorer / Finder). Accepts either
   * an `xdt-image://` URL (resolved on the main side) or an absolute file
   * path. Used by the chat image right-click "open image folder" menu.
   */
  showItemInFolder: (params: {
    url?: string;
    filePath?: string;
  }) => Promise<{ success: boolean; error?: string }>;

  /**
   * Copy an image or video (resolved from `xdt-image://` / `xdt-video://`
   * URL, or absolute path) into the system clipboard as a FILE REFERENCE.
   * Used by the chat right-click "复制图片 / 复制视频" menu items.
   */
  copyMediaToClipboard: (params: {
    url?: string;
    filePath?: string;
  }) => Promise<{ success: boolean; error?: string }>;

  /**
   * 图片 lightbox:用系统默认应用打开图片。仅本地源(`xdt-image://` /
   * `xdt-file://`)。失败以 IpcError 编码抛出(extractIpcError 解码)。
   */
  openMediaWithDefaultApp: (params: { url: string }) => Promise<void>;

  /**
   * 图片 lightbox:另存为。本地源直接复制,http(s)/data: 先取字节;用户取消
   * 保存对话框返回 `{ canceled: true }`,不算错误。
   */
  saveMediaAs: (params: { url: string }) => Promise<{ canceled: boolean; savedPath?: string }>;

  /**
   * 图片 lightbox "发送到对话":把图片复制成目标会话的一份新 `xdt-image://`
   * 缓存(draft lifecycle),返回构造 AttachedFile 所需元数据。
   */
  cacheMediaForSession: (params: {
    url: string;
    sessionId: string;
  }) => Promise<{ url: string; name: string; ext: string; mimeType: string; size: number }>;

  /** 图片 lightbox 字节层:http / cindy-remote-media 源取字节(标注/位图复制)。 */
  readImageBytes: (params: { url: string }) => Promise<{ base64: string; mimeType: string }>;

  /**
   * 附件卡缩略图:本机文件走系统缩略图服务(macOS QuickLook / Windows Shell)。
   * 路径越界 / 不是文件 / stat 失败 → 整体回 null;文件在但出不了图(系统不支持、
   * 超时、排不上并发名额)→ `dataUrl` 为 null,调用方回落自绘文件图标。
   * `byteSize` 是复核那一刻的当前大小,用来刷新卡片上「类型 · 大小」的快照值。
   */
  getFileThumbnail: (params: {
    path: string;
    size: number;
    /** 显式复核:跳过正缓存重新生成(负缓存仍尊重)。焦点复核时传 true。 */
    revalidate?: boolean;
  }) => Promise<{ dataUrl: string | null; byteSize: number } | null>;

  /**
   * markdown-monorepo-resolve: smart relative-path resolver. Tries direct
   * `cwd/href` first, then BFS the workspace for files whose absolute path
   * ends with `/<href>`. Returns 'none' on bad input or no matches so the
   * renderer can fall back to legacy resolveLocalPath.
   */
  resolvePath: (params: { href: string; workingDir: string }) => Promise<{
    status: 'unique' | 'multiple' | 'none';
    candidates: string[];
    /** unique 命中时的目标类型;缺省按 file 理解(老 main 兼容)。 */
    kind?: 'file' | 'directory';
  }>;

  /**
   * markdown-monorepo-resolve: BATCH resolver. Resolves many hrefs against one
   * workspace in a single async walk. Used by the renderer's batch scheduler so
   * switching to a session with hundreds of path targets does one IPC + one
   * workspace BFS instead of one per target.
   */
  resolvePathBatch: (params: {
    hrefs: string[];
    workingDir: string;
  }) => Promise<
    Record<
      string,
      { status: 'unique' | 'multiple' | 'none'; candidates: string[]; kind?: 'file' | 'directory' }
    >
  >;

  // 本机文件系统目录浏览(项目选择器「添加远程项目」;device-link 经隧道在被控端执行)。
  fsBrowse: {
    listDir: (path: string) => Promise<{
      resolvedPath: string;
      entries: { name: string; kind: 'dir' | 'symlink'; path: string }[];
      parent: string | null;
    }>;
    statPath: (path: string) => Promise<{
      kind: 'dir' | 'file' | 'missing';
      resolvedPath: string;
      mtimeMs?: number;
      birthtimeMs?: number;
    }>;
    mkdirP: (path: string) => Promise<{ resolvedPath: string }>;
  };

  // Electron webUtils — get native file path from a dropped/selected File object.
  // Required because File.path is unavailable in sandboxed renderers (Electron 20+).
  getFilePath: (file: File) => string;

  // ── File attachment IPC (F-FI-7) ──
  readFileForAttachment: (params: {
    filePath: string;
    encoding: 'base64' | 'utf8';
    maxSize?: number;
  }) => Promise<{
    success: boolean;
    error?: string;
    data?: string;
    size: number;
    truncated?: boolean;
  }>;

  /** Raw-bytes sibling of readFileForAttachment (PDF preview → pdf.js data).
   *  Rejects with an IpcError on failure (no partial payload). */
  readFileBytes: (params: {
    filePath: string;
    maxSize?: number;
  }) => Promise<{ bytes: Uint8Array; size: number }>;

  // ── File header peek IPC (F-FI-8 fallback inference) ──
  /**
   * Read at most `bytes` (default 8192, hard-cap 64KB) from the head of a
   * file. Used by the renderer to run magic-bytes + UTF-8 sniffing on files
   * whose extension didn't match any supported type.
   */
  peekFileHeader: (params: { filePath: string; bytes?: number }) => Promise<{
    success: boolean;
    error?: string;
    /** base64-encoded leading bytes; present when actualBytes > 0. */
    data?: string;
    /** Actual number of bytes read (may be < requested for tiny / empty files). */
    actualBytes: number;
    /** Total file size from fs.stat. */
    totalSize: number;
  }>;

  // ── Command Palette (F1/F2) workspace scans ──
  scanAtResources: (params: {
    workingDir: string;
    cap?: number;
    query?: string;
    agentKind?: 'claude-code' | 'codex' | 'pi';
  }) => Promise<{
    success: boolean;
    error?: string;
    items?: Array<
      | { type: 'file'; name: string; relPath: string; description?: string }
      | { type: 'dir'; name: string; relPath: string; description?: string }
      | { type: 'agent'; name: string; relPath: string; description?: string }
    >;
    truncated?: boolean;
  }>;
  // (老 scanSlashCommands 桥已下线 —— 由 electronAPI.maker.{listAgentSkills,
  //  listAgentCommands,listDesktopCommands,executeDesktopCommand} 取代。)

  // ── Learn (/learn 蒸馏 —— 系统级"学成 skill"能力) ──
  learn: {
    start: (req: import('../shared/learnTypes').LearnStartRequest) => Promise<{ runId: string }>;
    listRuns: () => Promise<{
      runs: import('../shared/learnTypes').LearnRunPublic[];
      ready: boolean;
    }>;
    getProposalDiff: (params: {
      runId: string;
    }) => Promise<import('../shared/learnTypes').LearnProposalDiff>;
    apply: (params: {
      runId: string;
    }) => Promise<{ name: string; absolutePath: string; replacedBackupPath?: string }>;
    discard: (params: { runId: string }) => Promise<{ ok: boolean }>;
    cancel: (params: { runId: string }) => Promise<{ ok: boolean }>;
    onEvent: (
      callback: (payload: import('../shared/learnTypes').LearnEventPayload) => void,
    ) => () => void;
  };

  // ── SkillHub (xdt-maker-技能中心 v0.2) ──
  skillhub: {
    scan: (params: { projects?: SkillhubProjectInput[] }) => Promise<{
      success: boolean;
      error?: string;
      skills?: SkillhubSkill[];
      sources?: SkillhubSourceReport[];
    }>;
    readSkill: (params: { mdPath: string }) => Promise<{
      success: boolean;
      error?: string;
      content?: string;
    }>;
    listChildren: (params: { dirPath: string }) => Promise<{
      success: boolean;
      error?: string;
      entries?: SkillhubFileEntry[];
    }>;
    readSiblingFile: (params: { filePath: string }) => Promise<{
      success: boolean;
      error?: string;
      content?: string;
    }>;
    readRaw: (params: { filePath: string }) => Promise<{
      success: boolean;
      error?: string;
      content?: string;
    }>;
    writeFile: (params: { filePath: string; content: string }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    /** 解析+校验 .md frontmatter,issues 为空数组即 schema 通过。 */
    validateFrontmatter: (params: {
      content: string;
      kind: 'skill' | 'command' | 'agent' | 'sibling';
    }) => Promise<
      | { success: true; issues: { field: string; message: string }[] }
      | { success: false; error: string }
    >;
    /** 改名整个 skill (目录名 + SKILL.md frontmatter `name`),用于撞名发布流程。 */
    renameLocal: (params: {
      absolutePath: string;
      newName: string;
    }) => Promise<{ success: true; newAbsolutePath: string } | { success: false; error: string }>;
    // ── v0.2.1: publish pipeline ──
    sync: (
      params:
        | string[]
        | {
            slugs?: string[];
          },
    ) => Promise<{
      success: boolean;
      error?: string;
      results?: SkillhubSyncResult[];
      availableUninstalledCount?: number;
    }>;
    /**
     * Market 浏览列表。cursor 分页 + sort + q + mine 过滤；available 由 renderer 本地过滤。
     * items 为 null 时即 success:false 的兜底。
     */
    listMarket: (params?: {
      cursor?: string;
      limit?: number;
      sort?: 'trending' | 'downloads' | 'updated_at' | 'created_at';
      q?: string;
      mine?: boolean;
      /** Legacy: Hub-side available filtering switch. Current renderer keeps this false and filters locally. */
      available?: boolean;
      category?: string;
      /** Legacy: Hub-side available filtering input. Current renderer does not use it. */
      installedSkills?: Array<{ slug: string; version: string }>;
    }) => Promise<{
      success: boolean;
      error?: string;
      items?: Array<{
        name: string;
        displayName: string;
        description: string;
        authorId: string;
        authorName: string;
        /** 飞书登录时拉到的头像 URL,可能为 null。 */
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
    }>;
    info: (name: string) => Promise<{
      success: boolean;
      error?: string;
      info?: SkillhubInfoResult;
      deleted?: boolean;
      errorCode?: string;
    }>;
    getPublishedFiles: (params: { name: string; version?: string }) => Promise<{
      success: boolean;
      slug?: string;
      version?: string;
      files?: Array<{ path: string; size: number; language: string; truncated: boolean }>;
      error?: string;
      errorCode?: string;
    }>;
    readPublishedFile: (params: { name: string; path: string; version?: string }) => Promise<{
      success: boolean;
      file?: { path: string; size: number; language: string; truncated: boolean; content: string };
      error?: string;
      errorCode?: string;
    }>;
    listPublishedVersions: (name: string) => Promise<{
      success: boolean;
      versions?: unknown[];
      error?: string;
      errorCode?: string;
    }>;
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
    }) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    deletePublished: (
      name: string,
    ) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    unpublishPublished: (
      name: string,
    ) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    setPublishedVisibility: (params: {
      name: string;
      visibility: 'private' | 'shared' | 'public';
      teamSlug?: string;
      visibleSlugs?: string[];
    }) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    getPublishedVisibility: (name: string) => Promise<{
      success: boolean;
      sharedTeams?: Array<{ id: number; slug: string; name: string }>;
      visibleDepts?: string[];
      error?: string;
      errorCode?: string;
    }>;
    getFolderHash: (absolutePath: string) => Promise<{
      success: boolean;
      error?: string;
      folderHash?: string;
      /** 参与 hash 的文件清单(含每个文件的 sha256) — 用于排查 dirty。 */
      manifest?: Array<{ path: string; sha256: string }>;
    }>;
    /**
     * 计算本地 skill 与上次发布快照的文件级 diff
     * - hasSnapshot=false:本地无快照(历史 publish 或换机器),UI 显示"无快照"提示
     * - changes:文件粒度 add/remove/modify,文本文件已带内容,二进制只带 size
     */
    getSnapshotDiff: (params: { absolutePath: string; name: string }) => Promise<{
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
    }>;
    getUsageSummary: (params: {
      name: string;
      mdPath?: string;
    }) => Promise<
      | { success: true; summary: SkillUsageSummary; refreshing: boolean }
      | { success: false; error: string }
    >;
    onUsageAnalyticsRefreshed: (callback: () => void) => () => void;
    getUsageDiagnosisContext: (params: {
      name: string;
      mdPath?: string;
    }) => Promise<
      { success: true; context: SkillUsageDiagnosisContext } | { success: false; error: string }
    >;
    getMyDepts: () => Promise<{
      success: boolean;
      ids: string[];
      names: string[];
      error?: string;
    }>;
    listCategories: () => Promise<{
      success: boolean;
      categories?: import('../shared/skillhubCategory').MarketCategory[];
      totalCount?: number;
      myTotalCount?: number;
      error?: string;
    }>;
    getScanStatus: (params: { slug: string; version?: string }) => Promise<{
      success: boolean;
      status: string;
      gates?: Array<{ name: string; status: string; issues?: unknown[] }>;
      scorecard?: Record<string, unknown>;
      error?: string;
    }>;
    listUserTeams: () => Promise<{
      success: boolean;
      teams: Array<{
        slug: string;
        name: string;
        type: string;
        source?: string | null;
        isPersonal?: boolean;
        myRole?: 'admin' | 'publisher' | 'viewer';
      }>;
      error?: string;
    }>;
    publish: (params: SkillhubPublishParams) => Promise<{
      success: boolean;
      error?: string;
      result?: { name: string; version: string };
      errorCode?: string;
    }>;
    cancelPublish: () => Promise<{ success: boolean }>;
    startScanPoll: (params: { slug: string; version: string }) => Promise<{ success: boolean }>;
    stopScanPoll: () => Promise<{ success: boolean }>;
    onPublishProgress: (callback: (event: SkillhubPublishProgressEvent) => void) => () => void;

    // ── Market install / uninstall / cancel ──
    // 冲突手写技能 → errorCode='CONFLICT_USER_OWNED'，UI 弹确认后重发 with force:true
    // installPath 不传 → 默认 ~/.agents/skills/{name}/（global scope），并 best-effort 创建 Claude symlink
    // installPath 传入完整路径 → basename 必须 === name，main 不做语义拼接
    install: (params: {
      name: string;
      version?: string;
      force?: boolean;
      /** 完整安装目标路径。不传 → global scope 默认路径。*/
      installPath?: string;
      /** force 覆盖时跳过 Cindy 持久备份,直接 rmrf 旧目录(完整替换)。 */
      skipBackup?: boolean;
    }) => Promise<
      | { success: true; name: string; version: string; absolutePath: string }
      | { success: false; errorCode: string; message: string }
    >;

    // ── Registry（v0.6） ──
    registry: {
      /** 按 skillName 读取整个 registry manifest（含所有 install 条目）。 */
      getByName: (params: { name: string }) => Promise<{
        success: boolean;
        manifest?: StoredManifest | null;
        error?: string;
      }>;
    };
    /** 一次性补齐:把 server 权威 authorId 写回本地 registry。 */
    reconcileMineRegistry: (
      items: Array<{
        name: string;
        absolutePath: string;
        version: string;
        authorId: string;
        folderHash?: string;
      }>,
    ) => Promise<{
      success: boolean;
      added: number;
      flipped: number;
      failures: Array<{ name: string; error: string }>;
    }>;
    cancelInstall: (name: string) => Promise<{ success: boolean }>;
    uninstall: (
      absolutePath: string,
    ) => Promise<{ success: true } | { success: false; errorCode: string; message: string }>;
    /** 在 main 内选择并检查本地包，成功时签发绑定当前 renderer 的短期导入授权。 */
    pickLocal: () => Promise<
      | { success: true; canceled: true }
      | {
          success: true;
          canceled: false;
          grantToken: string;
          name: string;
          description: string;
          version: string;
        }
      | { success: false; errorCode: string; message: string }
    >;
    /** 使用 main 签发的文件授权导入；registry origin=imported。 */
    importLocal: (params: { grantToken: string; installPath?: string; force?: boolean }) => Promise<
      | {
          success: true;
          name: string;
          description: string;
          version: string;
          absolutePath: string;
        }
      | { success: false; errorCode: string; message: string }
    >;
    onInstallProgress: (
      callback: (event: {
        phase:
          | 'fetching-info'
          | 'downloading'
          | 'verifying'
          | 'extracting'
          | 'registering'
          | 'done'
          | 'failed';
        name: string;
        version?: string;
        absolutePath?: string;
        errorCode?: string;
        message?: string;
      }) => void,
    ) => () => void;
  };
  // ── CC Agent SDK old IPC types (Stage 2 C1 退役) ──
  // sendCCAgentMessage / __resetCCAgentFanOuts / on/respond/answer 系列 / writePlanFile /
  // stop/close/update/setX 系列 / getCCAgentContextUsage / generateTitle 全部退役;
  // renderer 现在统一走 electronAPI.maker.* (定义见本文件下方 maker: { ... } 块)。

  // ── Image local cache (image-local-cache M4) ──
  /** Copy a local image into the cache for the session; returns xdt-image:// url. */
  cacheImageFromPath: (params: {
    sessionId: string;
    sourcePath: string;
    originalName: string;
  }) => Promise<{ url: string; filename: string }>;
  /** Write a clipboard image buffer into the cache; returns xdt-image:// url. */
  cacheImageFromBuffer: (params: {
    sessionId: string;
    buffer: Uint8Array;
    mimeType: string;
    suggestedName?: string;
  }) => Promise<{ url: string; filename: string }>;
  /** Read a cached image as base64 (renderer-side fallback path). */
  readCachedImageAsBase64: (params: {
    url: string;
  }) => Promise<{ base64: string; mimeType: string }>;
  /** Delete every file under userData/cc-agent/images/{sessionId}. */
  cleanupSessionImages: (sessionId: string) => Promise<void>;
  /** Delete the files referenced by the given xdt-image:// URLs. */
  cleanupCachedImages: (urls: string[]) => Promise<void>;

  /**
   * 媒体总仓存储管理(关于页存储空间卡片):占用统计 / 清理
   * 预检(报数)/ 执行清理 / 对账体检。draftUrls 由 renderer 从
   * composerDraftStore 现场收集随参带上(草稿附件是合法零引用,防误删)。
   */
  cindyMediaStorage: {
    /** 本窗口草稿附件 URL 变化时上报(fire-and-forget;多窗口防误删取证)。 */
    reportDraftUrls: (urls: string[]) => void;
    openLegacyImagesDir: () => Promise<{ opened: boolean }>;
    clearLegacyImagesDir: () => Promise<{ cleared: boolean }>;
    openChatAttachmentsDir: () => Promise<{ opened: boolean }>;
    clearChatAttachmentsDir: () => Promise<{ cleared: boolean }>;
    stats: () => Promise<{
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
    }>;
    scan: (params: { draftUrls: string[] }) => Promise<{
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
    }>;
    cleanup: (params: {
      draftUrls: string[];
      zeroRefHashes: string[];
      evictCacheHashes: string[];
      deadDirNames: string[];
      cleanTmpFiles: boolean;
    }) => Promise<{
      zeroRef: { deleted: number; freedBytes: number; skipped: number };
      cacheEvicted: { deleted: number; freedBytes: number; skipped: number };
      deadDirs: { removed: string[]; skipped: string[]; freedBytes: number };
      tmpFilesRemoved: number;
      freedBytes: number;
    }>;
    reconcile: () => Promise<{
      success: boolean;
      error?: string;
      orphanCount: number;
      orphanBytes: number;
      missingCount: number;
      strayCount: number;
      tmpFileCount: number;
      orphanSamples: string[];
      missingSamples: string[];
    }>;
  };

  // (Stage 2 C1) — onCCAgent* / respond/answer / setCCAgentX / writePlanFile /
  // generateTitle / getCCAgentContextUsage 等 ~16 项老 IPC 类型已退役;
  // renderer 走 electronAPI.maker.* (本文件下方 maker: { ... })。

  // Stage 2 C2: ccAgent.rewind 整块退役 — 已迁到 electronAPI.maker.rewindPreview /
  // rewindCommit (见下方 maker: { ... } 块)。

  // App Update (F2/F4)
  /** Register an update-status subscriber. Returns an unsubscribe function. */
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => () => void;
  /** Query current update status (no network, returns in-memory state). */
  getUpdateStatus: () => Promise<{ status: string; version?: string; errorCode?: string }>;
  /** Query and update auto-apply settings for downloaded app updates. */
  getAutoUpdateSettings: () => Promise<AutoUpdateSettingsPayload>;
  setAutoUpdateSettings: (settings: {
    autoRelaunchOnIdle: boolean;
  }) => Promise<AutoUpdateSettingsPayload>;
  resetAutoUpdateSettings: () => Promise<AutoUpdateSettingsPayload>;
  /** beta 测试渠道(设备级)开关的读/写/恢复默认。 */
  getUpdateChannelSettings: () => Promise<{
    enableBeta: boolean;
    isCustomized?: boolean;
  }>;
  setUpdateChannelSettings: (settings: {
    enableBeta: boolean;
  }) => Promise<{
    enableBeta: boolean;
    isCustomized?: boolean;
  }>;
  resetUpdateChannelSettings: () => Promise<{
    enableBeta: boolean;
    isCustomized?: boolean;
  }>;
  /** 用户主动重启,让 beta 通道切换在下次冷启动前生效。 */
  relaunchForChannelChange: () => Promise<void>;
  /** 打开 beta 前预检:探测 beta manifest 是否可达(HTTP 200)。 */
  probeBetaChannel: () => Promise<{ available: boolean }>;
  onUpdateChannelSettings: (
    callback: (payload: { enableBeta: boolean; isCustomized?: boolean }) => void,
  ) => () => void;
  setUpdateRelaunchTheme: (theme: 'light' | 'dark') => void;
  // E4D 毛玻璃:family 切换/启动通知 main 开关 vibrancy(仅 CINDY 透壁纸)
  theme: {
    applyVibrancy: (
      familyId: string,
      isDark: boolean,
      mode: 'system' | 'light' | 'dark',
      systemModeFollowsSystem: boolean,
    ) => void;
  };
  /**
   * Manually trigger an update check. Returns the resolved state so the
   * renderer can show the appropriate toast:
   *   - 'idle'             → 已经是最新版本
   *   - 'downloading'      → 正在下载新版本中,请稍后
   *   - 'ready'            → 新版本已就绪,等待重启
   *   - 'manifest_failed'  → 拉清单失败(网络问题)
   *   - 'download_failed'  → 找到了新版本但下载失败
   *   - 'manual_download'  → 保留给仍走手动安装的旧路径；现行 Linux 已应用内下 .deb
   */
  checkForUpdate: () => Promise<{
    result:
      'ready' | 'idle' | 'downloading' | 'manifest_failed' | 'download_failed' | 'manual_download';
  }>;
  /**
   * 现在重启会不会打断正在跑的活(逻辑 turn / Claude 后台活动 / Ghost card-action 后台活动
   * 三源聚合,判定在 main 侧一处)。UpdateBanner 用它决定「直接重启」还是「先弹中断警告」。
   * `silent: true` 只抑制 busy 的「manual relaunch」INFO,供横幅延后轮询;判定不变。
   */
  anyActivityBlockingRelaunch: (opts?: { silent?: boolean }) => Promise<boolean>;
  /** Tell main process to apply the update and relaunch the app.
   *  `theme` is the renderer's *resolved* light/dark (after collapsing 'system'),
   *  forwarded to cindy-updater so its splash matches the app the user is seeing. */
  relaunchToUpdate: (theme: 'light' | 'dark') => void;
  /** Startup-only apply path; main performs a final unattended-safety check. */
  autoRelaunchToUpdate: (theme: 'light' | 'dark') => Promise<{
    accepted: boolean;
    blockReason?: string;
  }>;

  /** macOS only — ask the main process to move the app bundle into
   *  /Applications (works around App Translocation). Resolves with
   *  `{ moved: false }` on non-darwin or when the app is already in
   *  /Applications. */
  moveToApplicationsFolder: () => Promise<{ moved: boolean }>;

  // Fullscreen state
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
  /** Query current fullscreen state synchronously on mount (covers IPC events
   *  that fired before the renderer had a chance to subscribe). */
  getFullscreenState: () => Promise<boolean>;
  toggleFullscreen: () => Promise<boolean>;

  /** 窗口是否对用户不可见(最小化 / hide)。装饰动画闸门用它兜底 ——
   *  backgroundThrottling 关闭时 document.visibilityState 会一直停在 visible。 */
  onWindowHiddenChange: (callback: (hidden: boolean) => void) => () => void;

  // ── Release notes (per-version, fetched from CDN by main) ──
  /**
   * Fetch the release notes JSON for a given version. Platform is resolved
   * inside main via getPlatformKey() (same axis as hot-update manifest).
   * Returns null on 404 / network error / parse error — caller decides
   * whether to surface a toast or stay silent.
   */
  fetchReleaseNotes: (version: string) => Promise<RawReleaseNotesPayload | null>;

  /**
   * Sorted ascending list of every version with a notice on the CDN. Used by
   * useUpdateNotice to compute the range of unread notices when the user
   * upgrades across several releases; returns null on 404 / network / parse.
   */
  fetchReleaseNotesIndex: () => Promise<string[] | null>;

  // ── Device Link (设备互联/跨设备远程控制) ─────────────────────────────
  deviceLink: {
    getState: () => Promise<{
      remoteControlEnabled: boolean;
      keepAwake: boolean;
      linkStatus: 'stopped' | 'connecting' | 'online';
      connectionIssue: DeviceLinkConnectionIssuePayload | null;
      standby: boolean;
      controlledBy: Array<{ deviceId: string; name: string }>;
      revokedControllers: string[];
      disabledControlDeviceIds: string[];
      unresponsiveDeviceIds: string[];
    }>;
    setEnabled: (enabled: boolean) => Promise<{ remoteControlEnabled: boolean }>;
    setKeepAwake: (enabled: boolean) => Promise<{ keepAwake: boolean }>;
    setDeviceControlEnabled: (
      deviceId: string,
      enabled: boolean,
    ) => Promise<{ deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }>;
    listDevices: () => Promise<{ devices: DeviceLinkDeviceView[] }>;
    renameDevice: (
      deviceId: string,
      name: string | null,
    ) => Promise<{ deviceId: string; name: string; manualName?: string | null }>;
    deleteDevice: (deviceId: string) => Promise<{ deviceId: string; deleted: boolean }>;
    // —— 控制端:远程会话视图 ——
    openLink: (deviceId: string) => Promise<{ appVersion: string; allowlistHash: string }>;
    closeLink: (deviceId: string) => Promise<{ ok: true }>;
    /** 远程调用被控端 allowlist 内 channel;成功拿返回值,失败 reject 带 code 的 Error */
    invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
    /** 控制端:订阅被控端某 topic 的变更推送(push 驱动侧边栏 / 会话视图) */
    subscribe: (deviceId: string, topics: string[]) => Promise<{ ok: true }>;
    /** 控制端:取消订阅某 topic */
    unsubscribe: (deviceId: string, topics: string[]) => Promise<{ ok: true }>;
    /** 被控端:一键断开当前所有控制链路 */
    disconnectAll: () => Promise<{ ok: true }>;
    /** 被控端:撤销某控制端的访问权限(逐设备黑名单) */
    revoke: (deviceId: string) => Promise<{ ok: true }>;
    /** 被控端:恢复某控制端的访问权限 */
    restore: (deviceId: string) => Promise<{ ok: true }>;
    /** 同账号某设备 presence 变化(上线/下线/开关/busy) */
    onPresenceChanged: (cb: (snap: DeviceLinkPresenceSnapshot) => void) => () => void;
    /** 本机 relay 连接状态变化 */
    onStatusChanged: (
      cb: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void,
    ) => () => void;
    /** 本机 relay 连接问题变化(鉴权失效/被顶号/超限/版本不符;null = 已恢复) */
    onConnectionIssue: (
      cb: (payload: { issue: DeviceLinkConnectionIssuePayload | null }) => void,
    ) => () => void;
    /** 同机单持有者仲裁角色变化。 */
    onOwnershipChanged: (cb: (payload: { standby: boolean }) => void) => () => void;
    /** 控制端:被控端转发回来的 renderer 广播事件 */
    onRemotePush: (
      cb: (
        payload: {
          deviceId: string;
          channel: string;
          payload: unknown;
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp;
        },
        localOwnerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    /** 被控端可见性:本机正在被哪些控制端控制 */
    onControlledState: (
      cb: (payload: { controllers: Array<{ deviceId: string; name: string }> }) => void,
    ) => () => void;
    /** 控制端:被某被控端撤销了访问权限,payload: { deviceId } */
    onAccessRevoked: (cb: (payload: { deviceId: string }) => void) => () => void;
    /** 控制端本地偏好:某目标设备是否允许被本机主动控制 */
    onControlTargetChanged: (
      cb: (payload: {
        deviceId: string;
        enabled: boolean;
        disabledControlDeviceIds: string[];
      }) => void,
    ) => () => void;
    /** 「保持电脑唤醒」在其它共享 userData 实例被翻转后推送 */
    onKeepAwakeChanged: (cb: (payload: { keepAwake: boolean }) => void) => () => void;
    /** 控制端:目标设备「无响应」熔断状态翻转(弱网 / 对端卡死;presence 可能仍在线) */
    onResponsivenessChanged: (
      cb: (payload: { deviceId: string; unresponsive: boolean }) => void,
    ) => () => void;
    /**
     * 控制端:远程会话镜像的本地冷缓存(main 落 userData,见
     * main/device-link/mirrorCacheStore.ts)。只做首屏加速、非权威 —— 缓存里没有 live 态,
     * fresh 数据一到由 renderer 整体接管。
     */
    mirrorCache: {
      getMessages: (
        deviceId: string,
        sessionId: string,
      ) => Promise<{
        messages: Record<string, unknown>[];
        invalidation?: number;
        ownerToken?: string;
        accountCounter?: number;
      }>;
      putMessages: (
        deviceId: string,
        sessionId: string,
        messages: readonly Record<string, unknown>[],
        expectedInvalidation?: number,
        expectedOwnerToken?: string,
        expectedAccountCounter?: number,
      ) => Promise<{ ok: true; invalidation?: number }>;
      getSessionList: () => Promise<{
        devices: Array<{
          deviceId: string;
          deviceName: string;
          sessions: Record<string, unknown>[];
        }>;
        ownerToken?: string;
        accountCounter?: number;
      }>;
      putSessionList: (
        devices: ReadonlyArray<{
          deviceId: string;
          deviceName: string;
          sessions: readonly Record<string, unknown>[];
        }>,
        expectedOwnerToken?: string,
        expectedAccountCounter?: number,
      ) => Promise<{ ok: true }>;
      /** 清掉一台设备的缓存;deviceId 必填(登出的整体清理由 main 在账号边界自己做) */
      clear: (deviceId: string) => Promise<{ ok: true }>;
    };
  };

  // ── Remote SSH (Phase A) ───────────────────────────────────────────────
  // 连接管理 + ~/.ssh/config IO. host.config.id == ssh alias.
  remoteSsh: {
    list: () => Promise<{ hosts: RemoteHostSnapshot[] }>;
    reloadConfig: () => Promise<{ hosts: RemoteHostSnapshot[] }>;
    add: (host: {
      id: string;
      hostname: string;
      port?: number;
      user: string;
      authMethod?: 'agent' | 'key';
      identityFile?: string;
      /** 「Agent 流量走本地 Proxy」pref; null = 关闭, 缺省 = 不动。 */
      agentProxy?: AgentProxyPrefPayload | null;
    }) => Promise<{ host: RemoteHostSnapshot }>;
    update: (host: {
      id: string;
      hostname: string;
      port?: number;
      user: string;
      authMethod?: 'agent' | 'key';
      identityFile?: string;
      agentProxy?: AgentProxyPrefPayload | null;
    }) => Promise<{ host: RemoteHostSnapshot }>;
    remove: (id: string) => Promise<{ ok: true }>;
    connect: (id: string) => Promise<{ host: RemoteHostSnapshot | null }>;
    disconnect: (id: string) => Promise<{ host: RemoteHostSnapshot | null }>;
    onStatusChanged: (cb: (snap: RemoteHostSnapshot) => void) => () => void;
    // Phase B: agent-on-remote
    probeAgent: (id: string, kind: RemoteAgentKind) => Promise<{ probe: RemoteAgentProbe }>;
    installAgent: (
      id: string,
      kind: RemoteAgentKind,
    ) => Promise<{ result: RemoteAgentInstallResult }>;
    uninstallAgent: (id: string, kind: RemoteAgentKind) => Promise<{ ok: true }>;
    runAgentOneShot: (
      id: string,
      kind: RemoteAgentKind,
      prompt: string,
    ) => Promise<{ result: RemoteAgentOneShotResult }>;
    // Generic remote fs primitives (Phase C) — reusable by a future remote
    // file browser. Both accept '~' / '~/...' and let remote bash expand to $HOME.
    statRemotePath: (
      id: string,
      path: string,
    ) => Promise<{ kind: 'dir' | 'file' | 'missing'; resolvedPath: string }>;
    mkdirPRemote: (id: string, path: string) => Promise<{ resolvedPath: string }>;
    setAutoConnect: (
      id: string,
      autoConnect: boolean,
    ) => Promise<{ ok: true; autoConnect: boolean }>;
    hasAnyAutoConnectHost: () => Promise<{ hasAny: boolean }>;
    listRemoteDir: (
      id: string,
      path: string,
    ) => Promise<{
      resolvedPath: string;
      entries: Array<{ name: string; kind: 'dir' | 'symlink' }>;
    }>;
    onInstallProgress: (cb: (payload: RemoteAgentInstallProgressPush) => void) => () => void;
    onSilentInstallStatus: (
      cb: (payload: RemoteAgentSilentInstallStatusPush) => void,
    ) => () => void;
    onCcMgrUpgradeAvailable: (
      cb: (payload: RemoteAgentCcMgrUpgradeAvailablePush) => void,
    ) => () => void;
    ccMgrForceUpgrade: (
      hostId: string,
      sessionId?: string,
      agent?: 'cc' | 'pi',
    ) => Promise<{ ok: true; daemonReady: boolean }>;
    ccMgrListPendingUpgrades: () => Promise<{
      pending: Array<{ hostId: string; currentVersion: string; availableVersion: string; agent: 'cc' | 'pi' }>;
    }>;
    ccMgrDismissPendingUpgrade: (hostId: string, agent?: 'cc' | 'pi') => Promise<{ ok: true }>;
    // Codex credential sync
    checkCodexAuth: (id: string) => Promise<{
      localExists: boolean;
      remoteExists: boolean;
      remoteMtime: string | null;
    }>;
    syncCodexAuth: (id: string) => Promise<{
      ok: true;
      daemonRestart: { ok: true } | { ok: false; reason: 'pkill_failed'; detail?: string };
    }>;
    // SSH key setup wizard
    listLocalKeys: () => Promise<{ keys: LocalSshKeyInfo[] }>;
    generateKey: (params?: { name?: string; comment?: string; passphrase?: string }) => Promise<{
      result: {
        privateKeyPath: string;
        pubkeyPath: string;
        pubkeyContent: string;
        fingerprintSha256: string | null;
      };
      agentLoaded: boolean;
      agentErrorHint: string | null;
      agentFailureReason: AgentFailureReason | null;
    }>;
    addKeyToAgent: (params: { privateKeyPath: string; passphrase?: string }) => Promise<{
      result: {
        success: boolean;
        failureReason: AgentFailureReason | null;
        errorHint: string | null;
        stderr: string;
      };
    }>;
    readPubkey: (pubkeyPath: string) => Promise<{ content: string }>;
    buildInstallCmd: (
      id: string,
      pubkeyPath: string,
    ) => Promise<{
      command: string;
      platform: NodeJS.Platform;
    }>;
    buildInstallCmdInline: (params: {
      user: string;
      hostname: string;
      port?: number;
      pubkeyPath: string;
    }) => Promise<{
      command: string;
      platform: NodeJS.Platform;
    }>;
  };

  // ── Worktree (worktree-parallel-sessions F1 / F4 / F5 / F6) ──
  // 7 个 IPC：create / detect-cwd / get-for-session / list-all / reveal /
  // suggest-name / list-branches。renderer **不**暴露删除 / 孤儿扫描——
  // close-session 由 main 自动处理 worktree 收尾。
  worktreeCreate: (req: {
    sessionId: string;
    baseRepo: string;
    name: string;
    sourceBranch: string;
  }) => Promise<import('@/lib/worktree.types').CreateWorktreeResp>;
  worktreeDetectCwd: (req: {
    cwd: string;
  }) => Promise<import('@/lib/worktree.types').DetectCwdResp>;
  worktreeGetForSession: (
    sessionId: string,
  ) => Promise<import('@/lib/worktree.types').WorktreeMeta | null>;
  worktreeListAll: () => Promise<import('@/lib/worktree.types').WorktreeMeta[]>;
  worktreeReveal: (req: { path: string }) => Promise<import('@/lib/worktree.types').RevealResp>;
  worktreeSuggestName: (req: {
    baseRepo: string;
  }) => Promise<import('@/lib/worktree.types').SuggestNameResp>;
  worktreeListBranches: (req: {
    baseRepo: string;
  }) => Promise<import('@/lib/worktree.types').ListBranchesResp>;
  // P1: 删除/归档确认预检
  worktreeRemovalPreview: (sessionId: string) => Promise<{ hasWorktree: boolean; dirty: boolean }>;
  // P1: worktree 回收后的可恢复状态 + 一键恢复
  worktreeRestoreStatus: (
    sessionId: string,
  ) => Promise<
    | { state: 'present'; worktreePath: string; hasSnapshot?: boolean }
    | { state: 'no-worktree' }
    | { state: 'restorable'; worktreePath: string; hasSnapshot: boolean }
    | { state: 'gone'; worktreePath: string }
  >;
  worktreeRestoreForSession: (sessionId: string) => Promise<{
    ok: boolean;
    snapshotApplied?: boolean;
    reason?: 'gone' | 'no-worktree' | 'git-error';
    detail?: string;
  }>;
  /** worktree 回收完成后，按实际受影响的 sessionId 增量更新本机缓存。 */
  onWorktreeChanged: (callback: (payload: { sessionId: string }) => void) => () => void;

  // ── Slack Hook(中心 slack-hook-server 接入) ── 类型正本在 shared/hookControlIpc.ts
  hookControl: {
    get: () => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setEnabled: (
      enabled: boolean,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setLifecycleAnnouncement: (
      enabled: boolean,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setProviderEnabled: (
      provider: 'telegram' | 'x',
      enabled: boolean,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setWorkspaces: (
      workspaces: Record<string, string>,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    /** 该 provider 派发任务的默认工作目录别名(null = 内置「对话」伪目录)。 */
    setProviderDefaultWorkspace: (
      provider: 'telegram' | 'x',
      alias: string | null,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    bindStart: () => Promise<{ ok: true }>;
    bindRevoke: () => Promise<{ ok: true }>;
    // (multi-team)多 workspace 绑定动作
    addBinding: () => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    rebindTeam: (
      teamId: string,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    revokeTeam: (
      teamId: string,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    cancelPendingBind: () => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    providerBindStart: (
      provider: 'telegram' | 'x',
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    providerBindCancel: (
      provider: 'telegram' | 'x',
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    providerBindRevoke: (
      provider: 'telegram' | 'x',
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    openProviderAction: (
      provider: 'telegram' | 'x',
      action: import('../shared/hookControlIpc').ProviderOpenAction,
    ) => Promise<{ ok: true }>;
    getWorkspacePrefs: () => Promise<{
      prefs: import('../shared/hookControlIpc').HookPrefsView;
    }>;
    setWorkspacePrefs: (
      workspace: string,
      patch: import('../shared/hookControlIpc').HookPrefsPatch,
      teamId?: string | null,
    ) => Promise<{ prefs: import('../shared/hookControlIpc').HookPrefsView }>;
    getProviderWorkspacePrefs: (provider: 'telegram' | 'x') => Promise<{
      prefs: import('../shared/hookControlIpc').ProviderPrefsView;
    }>;
    setProviderWorkspacePrefs: (
      provider: 'telegram' | 'x',
      workspace: string,
      patch: import('../shared/hookControlIpc').HookPrefsPatch,
    ) => Promise<{ prefs: import('../shared/hookControlIpc').ProviderPrefsView }>;
    getTelegramBehavior: (bindingId: string) => Promise<{
      behavior: import('../shared/hookControlIpc').TelegramHookBehaviorState;
    }>;
    setTelegramBehavior: (
      bindingId: string,
      patch: import('../shared/hookControlIpc').TelegramHookBehaviorPatch,
    ) => Promise<{
      behavior: import('../shared/hookControlIpc').TelegramHookBehaviorState;
    }>;
    listTelegramGroups: (bindingId: string) => Promise<{
      groups: import('../shared/hookControlIpc').TelegramHookKnownGroup[];
    }>;
    setTelegramGroupActivation: (
      bindingId: string,
      chatId: string,
      mode: import('../shared/hookControlIpc').TelegramHookGroupActivationMode,
    ) => Promise<{
      behavior: import('../shared/hookControlIpc').TelegramHookBehaviorState;
    }>;
    getWorkspaceProviderSources: () => Promise<{
      entries: import('../shared/hookControlIpc').HookWorkspaceProviderSourceEntry[];
    }>;
    setWorkspaceProviderSource: (payload: {
      channel: 'slack' | 'telegram' | 'x';
      teamId: string | null;
      workspace: string;
      providerId: string | null;
    }) => Promise<{
      entries: import('../shared/hookControlIpc').HookWorkspaceProviderSourceEntry[];
    }>;
    onWorkspaceProviderSourcesChanged: (
      listener: (
        entries: import('../shared/hookControlIpc').HookWorkspaceProviderSourceEntry[],
      ) => void,
    ) => () => void;
    onPrefsChanged: (
      cb: (view: import('../shared/hookControlIpc').HookPrefsView) => void,
    ) => () => void;
    onProviderPrefsChanged: (
      cb: (view: import('../shared/hookControlIpc').ProviderPrefsView) => void,
    ) => () => void;
    onTelegramBehaviorChanged: (
      cb: (view: import('../shared/hookControlIpc').TelegramHookBehaviorState) => void,
    ) => () => void;
    onStatusChanged: (
      cb: (view: import('../shared/hookControlIpc').SlackHookView) => void,
    ) => () => void;
  };

  // ── session-git-pr-context: 会话分支感知 + PR 关联状态 ──
  gitContext: {
    get: (workdir: string) => Promise<import('@/lib/gitContext.types').GitContextSnapshot>;
    getForSession: (input: {
      sessionId: string;
      workingDir: string | null;
      worktreePath: string | null;
      remoteHostId?: string | null;
    }) => Promise<import('@/lib/gitContext.types').SessionGitDirResult>;
    findLinkedWorktree: (input: { sessionId: string }) => Promise<{
      workdir: string;
      branch: string | null;
    } | null>;
    watch: (workdir: string) => Promise<void>;
    unwatch: (workdir: string) => Promise<void>;
    listPrRefs: (sessionId: string) => Promise<import('@/lib/gitContext.types').SessionPrRef[]>;
    /** null = main 侧 db 尚未就绪(登录前/启动期),调用方应稍后重试。 */
    listAllPrRefs: () => Promise<import('@/lib/gitContext.types').SessionPrRef[] | null>;
    getPrStatuses: (
      queries: Array<{ owner: string; repo: string; prNumber: number }>,
    ) => Promise<import('@/lib/gitContext.types').PrStatusResult[]>;
    onChanged: (
      cb: (data: import('@/lib/gitContext.types').GitContextSnapshot) => void,
    ) => () => void;
    onPrRefsChanged: (cb: (data: { sessionId: string }) => void) => () => void;
  };

  gitReview: {
    get: (params: {
      sessionId: string;
      ignoreWhitespace?: boolean;
    }) => Promise<import('@/lib/gitReview.types').ReviewData>;
    summary: (params: {
      sessionId: string;
    }) => Promise<import('@/lib/gitReview.types').ReviewDirtySummary>;
    commits: (params: {
      sessionId: string;
      baseRef?: string | null;
    }) => Promise<import('@/lib/gitReview.types').ReviewCommitListData>;
    commitDiff: (params: {
      sessionId: string;
      oid: string;
      ignoreWhitespace?: boolean;
    }) => Promise<import('@/lib/gitReview.types').ReviewCommitDiffData>;
    branchDiff: (params: {
      sessionId: string;
      baseRef?: string | null;
      ignoreWhitespace?: boolean;
    }) => Promise<import('@/lib/gitReview.types').ReviewBranchDiffData>;
    fileDiff: (
      params: { sessionId: string } & import('@/lib/gitReview.types').ReviewFileDiffRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewFileDiffData>;
    imagePreview: (params: {
      sessionId: string;
      diff: import('@/lib/gitReview.types').FileDiff;
      commitOid?: string | null;
      branchBaseRef?: string | null;
    }) => Promise<import('@/lib/gitReview.types').ReviewImagePreviewData>;
    markdownPreview: (params: {
      sessionId: string;
      diff: import('@/lib/gitReview.types').FileDiff;
      commitOid?: string | null;
      branchBaseRef?: string | null;
    }) => Promise<import('@/lib/gitReview.types').ReviewMarkdownPreviewData>;
    openFile: (params: { sessionId: string; path: string }) => Promise<void>;
    stageFile: (params: {
      sessionId: string;
      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    unstageFile: (params: {
      sessionId: string;
      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    discardFile: (params: {
      sessionId: string;
      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    stageHunk: (
      params: import('@/lib/gitReview.types').ReviewHunkOperationRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    unstageHunk: (
      params: import('@/lib/gitReview.types').ReviewHunkOperationRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    discardHunk: (
      params: import('@/lib/gitReview.types').ReviewHunkOperationRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    stageAll: (params: {
      sessionId: string;
      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    unstageAll: (params: {
      sessionId: string;
      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    discardAll: (params: {
      sessionId: string;
      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    commit: (
      params: import('@/lib/gitReview.types').ReviewCommitRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewCommitResult>;
    push: (params: {
      sessionId: string;
      confirmForce?: import('@/lib/gitReview.types').ReviewPushConfirmForce;
    }) => Promise<import('@/lib/gitReview.types').ReviewPushResult>;
  };

  sidebarSettings: {
    claimLegacyRendererOwner: () => import('../shared/sidebarSettings').SidebarLegacyRendererOwnerClaim;
    loadSnapshot: () => import('../shared/sidebarSettings').SidebarSettingsSnapshot;
    mutatePinnedOrder: (
      mutation: import('../shared/sidebarSettings').SidebarPinnedOrderMutation,
      ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => Promise<string[]>;
    onPinnedOrderChanged: (
      cb: (
        order: string[],
        ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    setProjectHidden: (
      projectKey: string,
      hidden: boolean,
      ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => Promise<boolean>;
    onHiddenProjectKeysChanged: (
      cb: (
        projectKeys: string[],
        ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    setMainViewHidden: (
      ghostId: string,
      hidden: boolean,
      ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => Promise<string[]>;
    onHiddenMainViewGhostIdsChanged: (
      cb: (
        ghostIds: string[],
        ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    getProjectOrder: () => Promise<import('../shared/projectOrderSettings').SyncedProjectOrderSnapshot>;
    applyProjectOrder: (request: {
      manualProjectOrder: readonly string[];
      ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp;
      projectOrder: 'activity' | 'custom';
    }) => Promise<import('../shared/projectOrderSettings').SyncedProjectOrderSnapshot>;
    onProjectOrderChanged: (
      cb: (
        snapshot: import('../shared/projectOrderSettings').SyncedProjectOrderSnapshot,
        ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
  };

  remotePrecreatedWorktreeLedger: {
    list: () => Promise<RemotePrecreatedWorktreeLedgerSnapshot>;
    register: (record: PendingRemotePrecreatedWorktree) => Promise<{ persisted: boolean }>;
    forget: (target: PendingRemotePrecreatedWorktreeTarget) => Promise<{ persisted: boolean }>;
  };

  // ── session 级"终身累计 cost"变化 (per-session, 不是 today-aggregate) ──
  // today aggregate 已搬到 electronAPI.maker.usage.* (Claude USD + Codex token 统一)。
  onUsageSessionSpendChanged: (
    cb: (
      data: {
        sessionId: string;
        totalMoney: import('../shared/regionalMoney').RegionalMoney;
        totalCostUsd?: number;
      },
      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;
  onUsageSessionTokensChanged: (
    cb: (
      data: { sessionId: string; totalTokens: number },
      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;

  // per-message 维度: turn 结束后 main 推该轮费用(挂在最后一条 assistant 上)。
  // 直接复用 main 侧的 payload 正本 —— 金额字段整组可选(无报价轮只带
  // turnUsageDetails),两侧各写一份必然漂移:曾出现 main 已放宽为可选、这里仍声明
  // 必填,消费方在 typecheck 通过的情况下解引用 undefined。
  onUsageMessageTurnCost: (
    cb: (
      data: import('../shared/turnCostPayload').MessageTurnCostPayload,
      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;

  // per-message 维度: turn 结束检测到模型被上游降级 / 替换时 main 推标记
  // (挂在该轮最后一条 assistant 上,AssistantMessage 渲染降级提示行)。
  onUsageMessageModelMismatch: (
    cb: (
      data: {
        sessionId: string;
        clientId: string;
        modelMismatch: import('../shared/modelMismatch').ModelMismatchInfo;
      },
      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;

  // ── 首登轻量数据迁移(mToc) — 老 userData → Cindy 一次性复制迁移弹窗 ──
  legacyMigration: {
    /** 订阅弹窗阶段推送。payload: { phase } */
    onState: (
      cb: (data: { phase: 'confirm' | 'running' | 'done' | 'failed' }) => void,
    ) => () => void;
    /** 挂载时补拉当前阶段(main 先推送、renderer 后订阅时不丢态)。 */
    getState: () => Promise<{ phase: 'confirm' | 'running' | 'done' | 'failed' | null }>;
    /** confirm 态点「确定」放行迁移;failed 态点「继续」清态。 */
    confirm: () => Promise<void>;
  };

  // ── chat-data-localization (M-FE2) — local SQLite IPC bridge ──
  localDb: {
    /** Open / migrate the per-user db file. Failure → fatal dialog + ready:false. */
    ensureReady: (userId: string) => Promise<
      | { ready: true }
      | {
          ready: false;
          error: {
            code: 'DB_INIT_FAILED' | 'DB_CORRUPT_NO_BACKUP' | 'MIGRATE_FAILED';
            message: string;
          };
        }
    >;
    maintenance: {
      scan: (
        input: import('../shared/localDbMaintenance').DbSlimmingScanInput,
      ) => Promise<import('../shared/localDbMaintenance').DbSlimmingScanResult>;
      chooseBackupDirectory: () => Promise<
        import('../shared/localDbMaintenance').DbSlimmingBackupDirectorySelection
      >;
      schedule: (
        input: import('../shared/localDbMaintenance').DbSlimmingScheduleInput,
      ) => Promise<import('../shared/localDbMaintenance').DbSlimmingScheduleResult>;
      getLastResult: () => Promise<
        import('../shared/localDbMaintenance').DbSlimmingResult | null
      >;
      openLastBackupDirectory: () => Promise<{ opened: boolean }>;
      getStartupProgress: () => Promise<
        import('../shared/localDbMaintenance').DbSlimmingStartupProgress | null
      >;
      cancelStartup: () => Promise<
        import('../shared/localDbMaintenance').DbSlimmingStartupCancelResult
      >;
      onStartupProgress: (
        callback: (
          progress: import('../shared/localDbMaintenance').DbSlimmingStartupProgress | null,
        ) => void,
      ) => () => void;
    };
    sessions: {
      list: (
        limit?: number,
        status?: 'active' | 'archived' | 'all',
        options?: { includePinned?: boolean; fresh?: boolean },
      ) => Promise<import('@/lib/ccAgent.types').Session[]>;
      create: (body?: {
        id?: string;
        workingDir?: string;
        workspaceKind?: import('@/lib/ccAgent.types').WorkspaceKind;
        model?: string;
        effort?: string;
        permissionMode?: string;
        fastMode?: boolean;
        planModeEnabled?: boolean;
        agentKind?: 'cc' | 'codex' | 'pi';
        orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;
        /** 附加只读引用目录列表 (绝对路径); main 端 mapper 会 JSON.stringify 后写库。 */
        extraDirs?: string[];
        writableDirs?: string[];
      }) => Promise<import('@/lib/ccAgent.types').Session>;
      get: (id: string) => Promise<import('@/lib/ccAgent.types').Session>;
      resolveReferences: (
        sessionIds: string[],
      ) => Promise<import('../shared/sessionReference').SessionReference[]>;
      restoreIfArchived: (
        id: string,
        expected: {
          workingDir: string | null;
          workspaceKind: import('@/lib/ccAgent.types').WorkspaceKind;
          remoteHostId: string | null;
        },
      ) => Promise<import('@/lib/ccAgent.types').Session | null>;
      update: (
        id: string,
        patch: {
          title?: string;
          workingDir?: string;
          workspaceKind?: import('@/lib/ccAgent.types').WorkspaceKind;
          model?: string;
          effort?: string;
          permissionMode?: string;
          fastMode?: boolean;
          planModeEnabled?: boolean;
          sdkSessionId?: string | null;
          totalTokenUsage?: number;
          totalCostUsd?: number;
          contextTokens?: number;
          contextWindow?: number;
          clearedAt?: string | null;
          pinnedAt?: string | null;
          status?: import('@/lib/ccAgent.types').SessionStatus;
          orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;
          /** 附加只读引用目录覆盖列表 (绝对路径)。 */
          extraDirs?: string[];
          writableDirs?: string[];
        },
      ) => Promise<import('@/lib/ccAgent.types').Session>;
      /**
       * 单字段 bump：把 user_send_at 设为 atMs（默认当前时间）。
       * fire-and-forget；renderer 应在 emitPatch userSendAt 之后调用，作为持久化兜底。
       */
      touchUserSend: (id: string, atMs?: number) => Promise<void>;
      /** 置顶段切到卡片模式才生成/回填任务摘要。 */
      setPinnedCardSummaries: (enabled: boolean) => Promise<void>;
      /** interrupted-turn-resume:「疑似中断」(startedAt > endedAt)的 active 会话 id。 */
      interruptedPending: () => Promise<string[]>;
      /** 红点派生的周期性重算源:尾部停在未 dismissed 错误行的 active 会话 id。 */
      errorTailPending: () => Promise<string[]>;
      /** 批量处置未处理告警(「全部标为已读」)。failed = 未处置成功的会话 id。 */
      dismissPendingAlerts: (
        sessionIds: string[],
      ) => Promise<{ dismissed: number; processed: string[]; failed: string[] }>;
      ackInterrupted: (id: string) => Promise<void>;
      // Stage 2 C2: fork 已迁到 electronAPI.maker.fork (走 maker:fork IPC)。
    };
    conversations: {
      search: (
        request: import('../shared/conversationSearch').ConversationSearchRequest,
      ) => Promise<import('../shared/conversationSearch').ConversationSearchResponse>;
    };
    recentWorkdirs: {
      /** 列出"最近工作目录"按 lastUsedAt desc;归档/删除 session 都不影响本列表。 */
      list: () => Promise<Array<{ path: string; lastUsedAt: string; exists: boolean }>>;
      /** 从最近列表移除一条(列表卫生,不动 sessions / 磁盘;再次使用会重新入列)。 */
      remove: (input: { path: string }) => Promise<{ deleted: boolean }>;
      /** Broadcast: 任一窗口/远程调用删除条目后通知;返回退订函数。 */
      onChanged: (
        callback: (
          data: { path: string },
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    rightSidebarTabs: {
      /** 按 sessionId 拉 tab 列表 + activeTabId(右侧栏多 Tab 容器)。 */
      list: (input: { sessionId: string }) => Promise<{
        tabs: Array<{
          id: string;
          sessionId: string;
          kind: string;
          position: number;
          state: unknown;
          isActive: boolean;
          createdAt: number;
          updatedAt: number;
        }>;
        activeTabId: string | null;
      }>;
      ensureSingleton: (input: { sessionId: string; kind: string; state?: unknown }) => Promise<{
        tab: {
          id: string;
          sessionId: string;
          kind: string;
          position: number;
          state: unknown;
          isActive: boolean;
          createdAt: number;
          updatedAt: number;
        } | null;
        created: boolean;
        persistable: boolean;
      }>;
      /** 新增 / 更新单个 tab;超 20 抛 RIGHT_SIDEBAR_TOO_MANY_TABS;state >16KB 抛 RIGHT_SIDEBAR_STATE_TOO_LARGE。 */
      upsert: (input: {
        id: string;
        sessionId: string;
        kind: string;
        position: number;
        state?: unknown;
      }) => Promise<{ ok: true }>;
      close: (input: { id: string }) => Promise<{ ok: true }>;
      setActive: (input: { sessionId: string; id: string | null }) => Promise<{ ok: true }>;
      reorder: (input: { sessionId: string; orderedIds: string[] }) => Promise<{ ok: true }>;
    };
    subagentRuns: {
      list: (
        input: import('@cindy/maker-shared/subagent-workspace').SubagentRunsListRequest,
      ) => Promise<import('@cindy/maker-shared/subagent-workspace').SubagentRunsListResponse>;
      detail: (
        input: import('@cindy/maker-shared/subagent-workspace').SubagentRunDetailRequest,
      ) => Promise<import('@cindy/maker-shared/subagent-workspace').SubagentRunDetailResponse>;
      transcript: (
        input: import('@cindy/maker-shared/subagent-workspace').SubagentTranscriptPageRequest,
      ) => Promise<import('@cindy/maker-shared/subagent-workspace').SubagentTranscriptPageResponse>;
      onChanged: (
        callback: (
          payload: import('@cindy/maker-shared/subagent-workspace').SubagentRunsChangedPayload,
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    projectAliases: {
      list: () => Promise<import('../shared/projectAliases').ProjectAlias[]>;
      set: (input: {
        projectKey: string;
        alias: string;
      }) => Promise<import('../shared/projectAliases').ProjectAlias | null>;
      delete: (projectKey: string) => Promise<void>;
      onChanged: (cb: () => void) => () => void;
    };
    sessionImport: {
      scan: (request?: { force?: boolean }) => Promise<{
        sources: {
          codexHomes: string[];
          claudeRoots: string[];
        };
        candidates: Array<{
          key: string;
          source: 'codex' | 'claude';
          id: string;
          title: string;
          cwd: string;
          updatedAt: string;
          archived: boolean;
          workspaceKind: import('@/lib/ccAgent.types').WorkspaceKind;
          sidebarBucket: 'project' | 'dialogue';
          projectDir: string | null;
        }>;
        rejected: {
          codex: number;
          claude: number;
          existing: number;
        };
        currentProjectDirs: string[];
      }>;
      importSelected: (
        items: Array<{ source: 'codex' | 'claude'; id: string }>,
      ) => Promise<{ inserted: number; updated: number; scanned: number }>;
      linkCodexProject: (
        workingDir: string,
      ) => Promise<{ matched: number; inserted: number; updated: number; scanned: number }>;
    };
    sessionShare: {
      export: (request: {
        sessionId: string;
        password?: string;
        excludeMedia?: boolean;
      }) => Promise<
        | {
            status: 'ok';
            filePath: string;
            fidelity: 'full' | 'partial' | 'db-only';
            missingTranscripts: string[];
            mediaMissing: number;
            /** 随包携带的协同 Worker 会话数(非协同包为 0)。 */
            orcaWorkers: number;
          }
        | { status: 'canceled' }
        | { status: 'oversize'; totalBytes: number; mediaBytes: number; limitBytes: number }
      >;
      inspect: (request?: {
        filePath?: string;
      }) => Promise<
        | { status: 'canceled' }
        | { draftId: string; encrypted: true }
        | { draftId: string; encrypted: false; preview: SessionSharePreview }
      >;
      unlock: (request: { draftId: string; password: string }) => Promise<SessionSharePreview>;
      commit: (request: {
        draftId: string;
        workingDir?: string;
        /** 导入端 New Maker 草稿默认值(导入语义 = 用草稿新建会话,agent 跟随分享包)。 */
        draftPrefs?: {
          model?: string;
          effort?: string;
          permissionMode?: string;
          planMode?: boolean;
          fastMode?: boolean;
          providerId?: string | null;
        };
        /** 冲突弹窗确认后覆盖导入:软删同 resume id 的旧会话,替换而非叠加。 */
        overwrite?: boolean;
        /** 在 worktree 中创建(仅 project 会话):main 编排建 worktree 后 workingDir 指向它。 */
        useWorktree?: boolean;
      }) => Promise<{
        sessionId: string;
        fidelity: 'full' | 'partial' | 'db-only';
        notes: string[];
        /** 随协同包一并导入的 Worker 会话数;普通包为 0。 */
        orcaWorkers: number;
      }>;
      cancel: (request: { draftId: string }) => Promise<{ ok: boolean }>;
      classifyPath: (request: {
        path: string;
      }) => Promise<{ kind: 'share' | 'directory' | 'other' }>;
    };
    orcaWorkflows: {
      getByLeadSession: (leadSessionId: string) => Promise<OrcaTeamRecord | null>;
      getByWorkerSession: (workerSessionId: string) => Promise<OrcaTeamRecord | null>;
      listWorkersByLead: (leadSessionId: string) => Promise<OrcaWorkerRecord[]>;
      listWorkersByLeads?: (
        leadSessionIds: string[],
      ) => Promise<Record<string, OrcaWorkerRecord[]>>;
      updateWorkerStatus: (
        workerId: string,
        status: 'idle' | 'running' | 'done' | 'error',
      ) => Promise<void>;
      onOrcaWorkerChanged: (cb: (payload: unknown) => void) => () => void;
      createWorker: (input: Record<string, unknown>) => Promise<unknown>;
      switchFocus: (input: Record<string, unknown>) => Promise<unknown>;
      idleWorker: (
        leadSessionId: string,
        workerId: string,
        expectedStatus?: 'done',
      ) => Promise<unknown>;
      archiveWorker: (leadSessionId: string, workerId: string) => Promise<unknown>;
      endTeam: (leadSessionId: string) => Promise<unknown>;
      getCollaborationSettings: () => Promise<unknown>;
      setCollaborationSetting: (key: string, value: number) => Promise<unknown>;
      resetCollaborationSettings: () => Promise<unknown>;
    };
    messages: {
      list: (
        sessionId: string,
        opts?: { limit?: number; before?: string; beforeTs?: number },
      ) => Promise<import('@/lib/ccAgent.types').Message[]>;
      estimatedSessionValue: (sessionId: string) => Promise<{
        totalValueMoney?: import('../shared/regionalMoney').RegionalMoney | null;
        totalValueUsd?: number;
        entries: Array<{
          clientId: string;
          money?: import('../shared/regionalMoney').RegionalMoney;
          costUsd?: number;
          turnUsageDetails?: unknown;
        }>;
      }>;
      around: (
        sessionId: string,
        messageId: string,
        opts?: { radius?: number },
      ) => Promise<import('@/lib/ccAgent.types').Message[]>;
      aroundClientId: (
        sessionId: string,
        clientId: string,
        opts?: { radius?: number },
      ) => Promise<import('@/lib/ccAgent.types').Message[]>;
      create: (
        sessionId: string,
        body: {
          clientId: string;
          role: import('@/lib/ccAgent.types').MessageRole;
          content: unknown;
          toolUseId?: string;
          createdAt?: string;
          /** SDK 元信息，按 session.agentKind 解析。 */
          agentMeta?: import('@/lib/ccAgent.types').AgentMeta | null;
        },
      ) => Promise<import('@/lib/ccAgent.types').Message>;
      updateContent: (
        sessionId: string,
        clientId: string,
        content: unknown,
      ) => Promise<import('@/lib/ccAgent.types').Message>;
      /** error-tail-banner:忽略错误行(main 侧 merge dismissed:true,保留原字段)。 */
      dismissError: (
        sessionId: string,
        clientId: string,
      ) => Promise<import('@/lib/ccAgent.types').Message>;
      onCreated: (
        callback: (
          payload: {
            sessionId: string;
            message: import('@/lib/ccAgent.types').Message;
          },
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
      onDeleted: (
        callback: (
          payload: { sessionId: string; clientId: string },
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
      onErrorPersisted: (
        callback: (
          payload: { sessionId: string },
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    sessionsPush: {
      onCreated: (
        callback: (
          payload: { sessionId: string },
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
      onPatched: (
        callback: (
          payload: {
            sessionId: string;
            patch: Partial<import('@/lib/ccAgent.types').Session>;
          },
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    /** V0.4 (C10): one-shot toast trigger when ensureReady ran two-level fallback. */
    onCorruptionRestored: (cb: (info: CorruptionRestoredPayload) => void) => () => void;
    /** #37: release 端检测到 schema drift 时的一次性 toast 事件。 */
    onSchemaDriftWarning: (cb: (info: SchemaDriftWarningPayload) => void) => () => void;
  };

  // ── RSB browser bridge (Phase 2) ───────────────────────────────────────────
  /**
   * Renderer ↔ main 桥,把 RSB `<webview>` 注册到 main 端 TabRegistry,Phase 3
   * 自动化 backend 据此取 webContents。channel 不归 localDb 管(不是持久化),所以
   * 跟 localDb 平级放在 ElectronAPI 顶层。
   */
  rsbBrowserBridge: {
    /** webview dom-ready 后调,上报 (sessionId, tabId, webContentsId)。 */
    report: (input: {
      sessionId: string;
      tabId: string;
      webContentsId: number;
    }) => Promise<{ ok: true }>;
    /** 通知 main 端释放 tab 的注册条目(pool 释放时触发)。 */
    release: (input: { tabId: string }) => Promise<{ ok: true }>;
    /**
     * RSB mount 时校对当前活的 tabId 列表,清除 HMR / crash 残留;同时回传 main
     * 端的 pinnedTabIds 让 renderer pool 重新 mirror 自动化 pin 状态(reload 防丢)。
     */
    snapshot: (input: { liveTabIds: string[] }) => Promise<{
      ok: true;
      dropped: string[];
      kept: number;
      pinnedTabIds: string[];
    }>;
    /** 工具栏截图按钮:main 端 capturePage 后写入系统剪贴板。失败抛 IPC error。 */
    captureScreenshot: (input: { tabId: string }) => Promise<{ ok: true }>;
    /** 页面评论:main 端 capturePage 后返回 PNG 字节(不写剪贴板)。失败抛 IPC error。 */
    captureScreenshotData: (input: { tabId: string }) => Promise<{ ok: true; data: Uint8Array }>;
    /** main → renderer:把 tabId 标记为 automation pinned(LRU 跳过)。 */
    onPin: (cb: (payload: { tabId: string }) => void) => () => void;
    /** main → renderer:取消 automation pin。 */
    onUnpin: (cb: (payload: { tabId: string }) => void) => () => void;
    /**
     * main → renderer:Phase 3 backend 让 renderer 代调 store 的 tab-op
     * 请求(probe / open / focus / close)。payload 是带 reqId 的 union;renderer 处理
     * 完后通过 `tabOpResult` 回报。
     */
    onTabOpRequest: (
      cb: (req: import('../shared/rsbBrowserBridge').RsbBrowserBridgeTabOpRequest) => void,
    ) => () => void;
    /** renderer → main:tab-op-request 的结果,按 reqId 关联。 */
    tabOpResult: (
      result: import('../shared/rsbBrowserBridge').RsbBrowserBridgeTabOpResult,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** 推送 renderer 当前 focused 的 RSB sessionId(Phase 5)。 */
    setActiveSession: (input: { sessionId: string | null }) => Promise<{ ok: true }>;
    /** 资源看门狗:上报本 renderer 当前展示的浏览器 tab(null = 无)。 */
    setForeground: (input: { tabId: string | null }) => Promise<{ ok: true }>;
    /** 用户主动强杀 guest 进程(unresponsive banner / cpu 提示条按钮);
     *  webContentsId 供 registry 未命中(attach 后、首个 dom-ready 前)兜底。 */
    forceKill: (input: { tabId: string; webContentsId?: number }) => Promise<{ ok: true }>;
    /** main → renderer:资源看门狗事件(evict-request / kill-notice / cpu-alert)。 */
    onResourceEvent: (
      cb: (event: import('../shared/rsbBrowserBridge').RsbBrowserBridgeResourceEvent) => void,
    ) => () => void;
  };

  /**
   * 资源用量面板(process-monitor):订阅期间 main 才采样;terminate 只对
   * 本产品 spawn 的 agent 根进程有效,归属由 main 重新校验。
   */
  processMonitor: {
    subscribe: () => Promise<void>;
    unsubscribe: () => Promise<void>;
    terminate: (
      request: import('../shared/processMonitor').TerminateAgentProcessRequest,
    ) => Promise<import('../shared/processMonitor').TerminateAgentProcessResult>;
    onSample: (
      cb: (sample: import('../shared/processMonitor').ProcessMonitorSample) => void,
    ) => () => void;
  };

  /**
   * Browser backend toggle: 切换 MCP `browser` 工具实际控制的浏览器。
   * - `external`: vendored Playwright + 独立 Chrome(**系统默认**)
   * - `rsb-webview`: 右侧栏内置 webview tab
   * 默认值口径与两次翻转的 override 语义见 main/browser-backend-settings-store.ts。
   */
  browserBackend: {
    getState: () => Promise<{
      active: 'external' | 'rsb-webview';
      systemDefault: 'external' | 'rsb-webview';
      isOverride: boolean;
      useRealProfile: boolean;
    }>;
    setKind: (kind: 'external' | 'rsb-webview') => Promise<{
      ok: true;
      active: 'external' | 'rsb-webview';
    }>;
    reset: () => Promise<{ ok: true; active: 'external' | 'rsb-webview' }>;
    getHealth: () => Promise<BrowserBackendHealth>;
    recover: () => Promise<BrowserBackendRecoveryResult>;
    setUseRealProfile: (enabled: boolean) => Promise<{ ok: true; enabled: boolean }>;
    probeSourceRead: () => Promise<BrowserBackendSourceReadAccess>;
  };

  // ── Dialog（v0.6 新增） ────────────────────────────────────────────────────
  dialog: {
    /** 打开系统目录选择对话框，返回用户选中的目录路径（取消时 path=null）。 */
    showOpenDirectory: (params?: {
      defaultPath?: string;
      writableGrantScope?: string;
    }) => Promise<{
      success: boolean;
      path: string | null;
    }>;
    /** 打开系统文件选择对话框，返回用户选中的文件路径（取消时 path=null）。 */
    showOpenFile: (params?: {
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<{
      success: boolean;
      path: string | null;
    }>;
    /** 打开 @ 资源系统选择器；macOS 可选文件或目录，Windows/Linux 选择文件。 */
    showOpenResource: (params?: { defaultPath?: string }) => Promise<{
      success: true;
      path: string | null;
      kind: 'file' | 'directory' | null;
    }>;
  };

  // electronAPI.codex 已退役 —— auth / binary status / usage / OAuth 登录进度 全部
  // 走 electronAPI.maker.* (agentKind 参数化), session 事件走 maker:event。详见下方 maker 块。

  /* ── Maker Core (stage 2: chat 切到 maker-core) ──
   * 替代 cc-agent:* / codex:* 老 IPC 链路。preload.ts/maker.* 对应 main 进程
   * apps/desktop/src/main/maker-ipc/ 的 handlers + apps/desktop/src/main/maker-host/。
   */
  maker: {
    listAvailableAgents: () => Promise<Array<'claude-code' | 'codex' | 'pi'>>;
    onAgentsChanged: (cb: () => void) => () => void;
    getCapabilities: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<unknown>;
    /** workflow 逐 agent 进度树(只读);读不到 / 解析失败返回 null → 回退 workflow 级卡片。 */
    getWorkflowProgress: (
      sessionId: string,
      taskId: string,
    ) => Promise<import('../shared/workflow-progress').WorkflowProgress | null>;

    // 模型供应商目录（只读）—— 内置目录元数据 + 各供应商实时连接状态。
    listProviders: () => Promise<{
      dataOwnerId: string | null;
      ownerGeneration: number;
      providers: import('@cindy/model-providers').ProviderView[];
      providerOrder: string[];
    }>;
    /** 复用各内置供应商既有真源刷新模型清单。 */
    refreshBuiltinProviderModels: (
      providerId: import('../shared/providerModelRefresh').BuiltinRefreshableProviderId,
    ) => Promise<import('../shared/providerModelRefresh').ProviderModelRefreshResult>;
    /** 静默请求 Main 在冷却允许时刷新已连接内置供应商。 */
    requestProviderModelsAutoRefresh: (
      trigger: import('../shared/providerModelRefresh').ProviderModelAutoRefreshRendererTrigger,
    ) => Promise<import('../shared/providerModelRefresh').ProviderModelAutoRefreshResult>;

    // 自定义供应商配置 CRUD（配置与 runtime 密钥均由 main 原子排队）。
    createCustomProvider: (
      config: import('@cindy/model-providers').CustomProviderConfig,
      keys: Partial<Record<'claude-code' | 'codex' | 'pi', string>>,
    ) => Promise<{ ok: true }>;
    updateCustomProvider: (
      config: import('@cindy/model-providers').CustomProviderConfig,
      keys: Partial<Record<'claude-code' | 'codex' | 'pi', string>>,
    ) => Promise<{ ok: true }>;
    deleteCustomProvider: (providerId: string) => Promise<{ ok: true }>;
    localModelStatus: () => Promise<import('../shared/localModelRuntime').LocalRuntimeStatus>;
    localModelStart: () => Promise<import('../shared/localModelRuntime').LocalRuntimeStatus>;
    localModelList: () => Promise<{
      status: import('../shared/localModelRuntime').LocalRuntimeStatus;
      models: import('../shared/localModelRuntime').LocalInstalledModel[];
      recommended: import('../shared/localModelRuntime').RecommendedLocalModel | null;
      catalog: import('../shared/localModelRuntime').CuratedOllamaModel[];
      featured: import('../shared/localModelRuntime').CuratedOllamaModel[];
      memoryGb: number;
      recommendReason: import('../shared/localModelRuntime').LocalRecommendReason;
      appleSilicon: boolean;
      pull: import('../shared/localModelRuntime').LocalModelPullProgress | null;
      pulls: import('../shared/localModelRuntime').LocalModelPullProgress[];
      pausedPull: import('../shared/localModelRuntime').LocalModelPullProgress | null;
      detectedLocalPresetIds: string[];
      catalogDirty?: boolean;
    }>;
    localModelPull: (name: string) => Promise<{ ok: true; stopped?: 'pause' | 'cancel' }>;
    localModelAbort: (reason: 'pause' | 'cancel', name: string) => Promise<{ ok: true }>;
    localModelEnsure: () => Promise<{ ok: true; created: boolean }>;
    localModelSetInPicker: (
      name: string,
      enabled: boolean,
    ) => Promise<{ ok: true; created: boolean }>;
    localModelDelete: (name: string) => Promise<{ ok: true; created: boolean }>;
    localModelDiscardPaused: (name: string) => Promise<{ ok: true }>;
    localModelInstall: (input: {
      consent: true;
    }) => Promise<{
      ok: true;
      status?: import('../shared/localModelRuntime').LocalRuntimeStatus;
      created?: boolean;
      stopped?: 'cancel';
    }>;
    localModelInstallAbort: () => Promise<{ ok: true }>;
    onLocalModelStatus: (
      callback: (status: import('../shared/localModelRuntime').LocalRuntimeStatus) => void,
    ) => () => void;
    onLocalModelPullProgress: (
      callback: (progress: import('../shared/localModelRuntime').LocalModelPullProgress) => void,
    ) => () => void;
    onLocalModelInstallProgress: (
      callback: (progress: import('../shared/localModelRuntime').LocalRuntimeInstallProgress) => void,
    ) => () => void;
    /** 自定义供应商创建模板（目录 presets 段，纯 UI 模板数据）。 */
    listProviderPresets: () => Promise<{
      presets: import('@cindy/model-providers').ProviderPreset[];
    }>;
    /** 供应商「测试连接」—— 与真实会话同路由口径的最小探测请求（结构化结果，code 走 providerError.* i18n）。 */
    testProviderConnection: (
      input:
        | { kind: 'saved'; providerId: string; agent: 'claude-code' | 'codex' | 'pi' }
        | {
            kind: 'adhoc';
            spec: {
              agent: 'claude-code' | 'codex' | 'pi';
              baseUrl: string;
              modelId: string;
              authMethod: 'apiKey' | 'oauth' | 'none';
              wireProtocol?: import('@cindy/model-providers').ProviderWireProtocol;
              requestPath?: string;
              apiKey?: string | null;
              headers?: Record<string, string>;
            };
          },
    ) => Promise<{
      ok: boolean;
      code?: import('../shared/providerErrors').ProviderErrorCode;
      status?: number;
      latencyMs: number;
      detail?: string;
    }>;
    /** 供应商「获取模型列表」—— 表单值透传，结构化结果（code 走 providerError.* i18n）。 */
    fetchProviderModels: (input: {
      agent: 'claude-code' | 'codex' | 'pi';
      baseUrl: string;
      authMethod: 'apiKey' | 'oauth' | 'none';
      wireProtocol?: import('@cindy/model-providers').ProviderWireProtocol;
      modelsUrl?: string | null;
      apiKey?: string | null;
      headers?: Record<string, string>;
      /** 已保存供应商 id:main 侧据此并入 main-only 鉴权请求头(renderer 不回读明文头)。 */
      savedProviderId?: string;
    }) => Promise<{
      ok: boolean;
      models?: { id: string; name: string; contextWindow?: number }[];
      code?: import('../shared/providerErrors').ProviderErrorCode;
      status?: number;
      detail?: string;
    }>;
    /**
     * 本机 agent CLI 安装 / 登录态扫描（设置「检测建议」用）。只 stat 不读凭证内容;
     * 失败降级空数组。
     */
    scanLocalCli: () => Promise<{
      detections: import('../shared/localCliDetect').LocalCliDetection[];
    }>;
    /**
     * 立即重新发现动态清单（当前只有 anthropic 订阅）。host 只对暂时性失败做有限次退避
     * 重试、确定性拒绝不重试，所以这是用户在失败态下「立刻再试一次」的入口（同时重开
     * 一轮退避）；失败归因随结果回传，供 UI 渲染分类文案。
     */
    rediscoverModels: (providerId: string) => Promise<{
      ok: boolean;
      failure?: import('@cindy/model-providers').ProviderModelDiscoveryFailureView;
    }>;
    /** 自定义供应商变更广播订阅（返回 off）。 */
    onProvidersChanged: (cb: () => void) => () => void;

    // 自定义 MCP 服务器配置 CRUD（可选 bearer token 另走通用 safeStorage IPC，不经这里）。
    listCustomMcpServers: () => Promise<{
      servers: import('../shared/customMcp').CustomMcpConfig[];
    }>;
    createCustomMcpServer: (
      config: import('../shared/customMcp').CustomMcpConfig,
    ) => Promise<{ ok: true }>;
    updateCustomMcpServer: (
      config: import('../shared/customMcp').CustomMcpConfig,
    ) => Promise<{ ok: true }>;
    deleteCustomMcpServer: (mcpId: string) => Promise<{ ok: true }>;
    /** token-only 后置刷新：safeStorage write/remove 完成后调用，消除竞态窗口。 */
    refreshCustomMcpCodex: () => Promise<{ ok: true }>;
    /** 自定义 MCP 变更广播订阅（返回 off）。 */
    onMcpChanged: (cb: () => void) => () => void;
    /** 通用 OAuth 供应商（目录 auth.oauth 描述符驱动）登录 / 登出 / 取消。 */
    providerOAuthLogin: (
      providerId: string,
      options?: { ownerId?: string },
    ) => Promise<{ ok: boolean; reason?: string }>;
    providerOAuthLogout: (providerId: string) => Promise<{ ok: true }>;
    providerOAuthCancel: (
      providerId: string,
      options?: { releaseOwner?: boolean; ownerId?: string },
    ) => Promise<{ ok: true }>;
    onProviderOAuthProgress: (
      cb: (progress: {
        providerId: string;
        phase: 'device-code';
        verificationUrl: string;
        userCode: string;
        expiresAt: number;
      }) => void,
    ) => () => void;
    /** 自定义供应商上游错误订阅（返回 off）；code 走 providerError.* i18n。 */
    onProviderUpstreamError: (
      cb: (event: {
        agent: 'claude-code' | 'codex' | 'pi';
        providerId: string;
        providerName?: string;
        code: import('../shared/providerErrors').ProviderErrorCode;
        retryable: boolean;
        status: number;
        detail?: string;
        errorType?: string;
        reqId?: number;
      }) => void,
    ) => () => void;
    /** Claude Auto classifier 失败后降级到 ask 的会话级通知。 */
    onAutoPermissionFallback: (
      cb: (event: {
        sessionId: string;
        from: 'auto';
        to: 'ask';
        reason: 'classifier_unavailable';
        status: number;
      }) => void,
    ) => () => void;
    /** 会话后台活动只读快照(turn 已结束但 CC 子进程仍在调模型)。 */
    getSessionBackgroundActivity: (sessionId: string) => Promise<{ active: boolean }>;
    /** 后台活动活跃会话全量列表(全局 store 挂载时的初始快照,增量走 push 订阅)。 */
    listSessionBackgroundActivity: () => Promise<{ sessionIds: string[] }>;
    /** 一键停止会话后台任务(关闭常驻 CC 子进程,会话可续);turn 在跑时抛 [SESSION_RUNNING]。 */
    stopSessionBackgroundTasks: (sessionId: string) => Promise<{ ok: true }>;
    /** 会话后台活动翻转订阅(payload = { sessionId, active },返回 off)。 */
    onSessionBackgroundActivityChanged: (
      cb: (payload: { sessionId: string; active: boolean }) => void,
    ) => () => void;
    /** 精确停止会话内单个后台任务(不中断当前 turn;任务已结束幂等成功)。 */
    stopAgentTask: (sessionId: string, taskId: string) => Promise<{ ok: true }>;
    controlPiSubagent: (input: {
      sessionId: string;
      taskId: string;
      action: 'stop' | 'steer' | 'follow_up' | 'resume';
      message?: string;
      childId?: string;
    }) => Promise<{ ok: boolean; controlled: number }>;
    /** 会话仍在运行的后台任务快照(挂载 / 重载后补回存量;实时增量走事件流)。 */
    listSessionBackgroundTasks: (sessionId: string) => Promise<{
      tasks: Array<{
        taskId: string;
        taskType?: string;
        toolUseId?: string;
        title?: string;
        provider?: 'pi' | 'claude-code';
      }>;
      /** 「任务已终态、wake turn 尚未启动或仍在跑」的 continuation claim 数(桥接对账收口权威依据)。 */
      pendingContinuations?: number;
    }>;
    /**
     * renderer → main 单向镜像「模型显示/隐藏」override 整张快照(modelVisibilityPrefs)。
     * 让 IM /model 在 main 侧复用同一套可见性过滤,与应用内模型列表逐模型一致；owner stamp
     * 用于拒绝账号切换期间的迟到快照。fire-and-forget。
     */
    syncModelVisibility: (
      dataOwnerId: string | null,
      ownerGeneration: number,
      map: Record<string, boolean>,
    ) => Promise<void>;
    /** Resolve the stable local/cloud owner allowed to import the pre-account preference key. */
    claimLegacyModelVisibilityOwner: () => import('../shared/modelVisibility').ModelVisibilityLegacyOwnerClaim;
    /**
     * 「模型 / 供应商停用」override 写入(main 侧 model-disable-store);成功后 main 广播
     * PROVIDER_CHANGED,useProviders 快照刷新后 UI 拿到新的 suspended / disabled 标志。
     */
    setModelDisable: (
      input:
        | { kind: 'model'; providerId: string; modelIds: string[]; disabled: boolean }
        | { kind: 'provider'; providerId: string; disabled: boolean }
        // reset = 恢复默认:删除该供应商整组停用 override(含指向已下架模型的陈旧条目)。
        | { kind: 'reset'; providerId: string },
    ) => Promise<{ ok: true }>;
    /** Persist the visible provider order only if the active owner still matches. */
    setProviderOrder: (
      dataOwnerId: string | null,
      ownerGeneration: number,
      providerIds: string[],
    ) => Promise<{ ok: true }>;
    getModelPriceOverride: (
      target: import('../shared/modelPriceOverride').ModelPriceOverrideTarget,
    ) => Promise<import('../shared/modelPriceOverride').ModelPriceOverrideView>;
    setModelPriceOverride: (
      target: import('../shared/modelPriceOverride').ModelPriceOverrideTarget,
      desired: import('../shared/modelPriceOverride').ModelPriceOverrideDesiredQuote,
    ) => Promise<import('../shared/modelPriceOverride').ModelPriceOverrideView>;
    resetModelPriceOverride: (
      target: import('../shared/modelPriceOverride').ModelPriceOverrideTarget,
    ) => Promise<import('../shared/modelPriceOverride').ModelPriceOverrideView>;

    // 「在新窗口打开」会话多开
    openSessionInNewWindow: (sessionId: string, deviceId?: string | null) => Promise<void>;
    openSessionInNewWindowIfDroppedOutside: (
      sessionId: string,
      deviceId?: string | null,
    ) => Promise<boolean>;
    beginSessionDragPreview: (
      label: string,
      sessionId: string,
      deviceId: string | null | undefined,
      palette: import('../shared/sessionDragPreview').SessionDragPreviewPalette,
    ) => Promise<void>;
    endSessionDragPreview: (dragEndAtMs?: number) => void;

    // ── Palette `/` 命令三源 (palette refactor) ───────────────────────
    listDesktopCommands: () => Promise<{
      success: boolean;
      error?: string;
      commands?: Array<{ kind: 'desktop'; name: string; description: string }>;
    }>;

    executeDesktopCommand: (
      name: string,
      ctx: { sessionId?: string; workingDir?: string; args?: string; deviceId?: string },
    ) => Promise<{ success: boolean; error?: string }>;

    startReview: (input: {
      sourceSessionId: string;
      focus?: string;
      attachments?: import('./lib/fileTypes').SerializedAttachedFile[];
    }) => Promise<{ ok: true; runId: string; reviewerSessionId: string }>;
    listAgentCommands: (
      agentKind: 'claude-code' | 'codex' | 'pi',
      params?: { sessionId?: string; allowManagedPiPackagePreview?: boolean },
    ) => Promise<{
      success: boolean;
      error?: string;
      commands?: Array<{ kind: 'agent-builtin'; name: string; description: string }>;
      runtimeStatus?: import('../shared/piPackages').PiPackageCommandRuntimeStatus;
    }>;

    listAgentSkills: (
      agentKind: 'claude-code' | 'codex' | 'pi',
      params: { workingDir?: string; forceReload?: boolean; sessionId?: string },
    ) => Promise<{
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
        runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';
        runtimeCommandName?: string;
      }>;
    }>;

    listPiPackages: () => Promise<import('../shared/piPackages').PiPackageListResult>;

    mutatePiPackage: (
      request: import('../shared/piPackages').PiPackageMutationRequest,
    ) => Promise<import('../shared/piPackages').PiPackageMutationResult>;

    onPiPackagesChanged: (handler: () => void) => () => void;

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
        /** /goal、/learn 共用:错误码(goal-usage / goal-no-session / goal-failed;
         *  learn-usage / learn-busy / learn-failed)。 */
        error?: string;
        /** /goal 专用:动作('set'/'cleared'/'open-dialog'=打开新建目标弹窗)。 */
        goalAction?: 'set' | 'cleared' | 'open-dialog';
        /** /learn 专用:启动成功时的 runId(关联 learn:event 状态流)。 */
        learnRunId?: string;
      }) => void,
    ) => () => void;

    // ── 会话内 /goal 自主续跑 ───────────────────────────────────────────────
    setGoal: (input: {
      sessionId: string;
      objective: string;
      limits?: {
        maxTurns: number | null;
        budgetTokens: number | null;
        noProgressLimit: number | null;
      };
    }) => Promise<{ ok: boolean }>;
    clearGoal: (sessionId: string) => Promise<{ ok: boolean }>;
    pauseGoal: (sessionId: string) => Promise<{ ok: boolean }>;
    resumeGoal: (sessionId: string) => Promise<{ ok: boolean }>;
    updateGoal: (
      sessionId: string,
      patch: {
        objective?: string;
        maxTurns?: number | null;
        budgetTokens?: number | null;
        noProgressLimit?: number | null;
      },
    ) => Promise<{ ok: boolean }>;
    getGoalStatus: (sessionId: string) => Promise<GoalStatusPayload | null>;
    onGoalStatusChanged: (
      handler: (payload: { sessionId: string; goal: GoalStatusPayload | null }) => void,
    ) => () => void;

    scanAtResources: (
      agentKind: 'claude-code' | 'codex' | 'pi',
      params: { workingDir: string; cap?: number; query?: string },
    ) => Promise<{
      success: boolean;
      error?: string;
      items?: Array<
        | { type: 'file'; name: string; relPath: string; description?: string }
        | { type: 'dir'; name: string; relPath: string; description?: string }
        | { type: 'agent'; name: string; relPath: string; description?: string }
      >;
      truncated?: boolean;
    }>;
    listAtContext: (params: {
      sessionId?: string;
      workingDir?: string;
      query?: string;
      limit?: number;
    }) => Promise<{
      success: true;
      browserTabs: Array<{ tabId: string; title: string; url: string }>;
      desktopWindows: Array<{
        windowId: number;
        pid: number;
        appName: string;
        title: string;
      }>;
      unavailable: Array<'browser-tabs' | 'desktop-windows'>;
    }>;

    createSession: (opts: {
      /** 可选: 复用外部 sessionId(本端 chat 用 local-db:sessions:create 拿到的 id) */
      id?: string;
      agentKind: 'claude-code' | 'codex' | 'pi';
      workingDir: string;
      model: string;
      title?: string;
      parentSessionId?: string;
      orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;
      effort?: string;
      fastMode?: boolean;
      permissionMode?: string;
      /** 计划模式一级开关(与 permissionMode 正交)。 */
      planMode?: boolean;
      systemPrompt?: string;
      /** 用户级 system prompt 末段 (lib/userPromptStore 来源, 不持久化到 DB)。 */
      userPrompt?: string;
      /** Maker Memory 启用 flag (lib/memorySettingsStore 来源, mode==='maker' 时透传 true)。 */
      makerMemoryEnabled?: boolean;
      /** 附加只读引用目录列表 (绝对路径)。Codex agent 收到会忽略 (capability=false)。 */
      extraDirs?: string[];
      writableDirs?: string[];
      displayReasoning?: 'off' | 'summarized' | 'full';
      /** 远端 host alias (Codex only) — codex agent 跑在远端机器上, workingDir 是远端路径。 */
      remoteHostId?: string;
      vendorOptions?: Record<string, unknown>;
    }) => Promise<{
      sessionId: string;
      agentKind: string;
      workDir: string;
      capabilities: unknown;
      usedProjectContext?: boolean;
    }>;

    markOrcaRole: (
      sessionId: string,
      role: import('@/lib/ccAgent.types').OrcaRole,
    ) => Promise<void>;

    /**
     * F-COLLAB: 在已存在的 lead session 上开启协同模式。
     * 创建新 workflow + Worker session,并在 lead 在线时调 setVendorOptions
     * 让下一 turn 拿到协同 MCP。renderer 拿到 workerSessionId 后通常立即
     * navigate 到 split-pane 路由展示 Lead + Worker。
     */
    enableOrca: (
      leadSessionId: string,
      opts: {
        workerAgent: 'claude-code' | 'codex' | 'pi';
        delegateTask?: string;
        role?: string;
        label?: string;
        model?: string;
        effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        fast?: boolean;
        /** 显式选定的模型来源(标准面板 per-worker 选择);缺省 = 跟随默认路由解析。 */
        providerId?: string | null;
        /** Worker 创建默认权限；缺省沿用当前偏好，显式值会更新偏好。 */
        workerPermissionMode?: 'auto' | 'bypassPermissions';
        /** 新建 Lead 专用：等首条输入 accepted 且可查询后再派任务。 */
        deferDelegateTask?: boolean;
      },
    ) => Promise<{
      teamId: string;
      workerSessionId: string;
      workerId: string;
      dispatched: boolean;
      workerPermissionMode: 'auto' | 'bypassPermissions';
      uiAssignmentSnapshotBeforeMs: number;
    }>;

    dispatchOrcaUiAssignment: (
      leadSessionId: string,
      workerSessionId: string,
      initialTask: string,
      snapshotBeforeMs: number,
      waitForLeadHistory: boolean,
    ) => Promise<unknown>;

    /**
     * F-COLLAB: 关闭 lead session 当前的协同 workflow。
     * 销毁所有 Worker session 的 SDK 进程,DB 标 workflow completed +
     * sessions.status='archived' 让 sidebar 自动隐藏 Worker。
     */
    disableOrca: (leadSessionId: string) => Promise<{ ok: true }>;

    /**
     * Send message; lazy-create session if not yet started.
     * 当 server 端 session 不存在时, createOpts 必传(agentKind/model/workingDir 等),
     * IPC handler 会 lazy createSession + send。createOpts.id 会被强制设为 sessionId。
     */
    send: (
      sessionId: string,
      message:
        string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> },
      createOpts?: {
        agentKind: 'claude-code' | 'codex' | 'pi';
        workingDir: string;
        model: string;
        orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;
        effort?: string;
        fastMode?: boolean;
        permissionMode?: string;
        /** 计划模式一级开关(与 permissionMode 正交)。 */
        planMode?: boolean;
        /** 用户级 system prompt 末段; 仅 lazy-create 那一次生效, 已 spawn 的 session 忽略。 */
        userPrompt?: string;
        /** Maker Memory 启用 flag; 仅 lazy-create 那一次生效。 */
        makerMemoryEnabled?: boolean;
        /** 附加只读引用目录列表; 仅 lazy-create 那一次生效, 已 spawn 的 session 走 setExtraDirs。 */
        extraDirs?: string[];
        writableDirs?: string[];
        displayReasoning?: 'off' | 'summarized' | 'full';
        vendorOptions?: Record<string, unknown>;
        resumeSessionId?: string;
      },
      sendOpts?: {
        /** 这条 user 消息的 SDK uuid (renderer 与 messages.agent_meta.uuid 同源, rewind 锚点)。 */
        messageUuid?: string;
        /** 当前用户的展示名 (个人化 turn-start status: "<name> Just Wait ...")。 */
        userName?: string;
        /** Codex renderer 队列路径需要“已接受或已拒绝”的语义,再决定是否落库。 */
        throwOnStartFailure?: boolean;
        /** Direct Continue fallback:执行端在 dispatch 成功后确认旧中断。 */
        ackInterruptedTurnOnDispatch?: boolean;
      },
    ) => Promise<{ accepted: true } | { accepted: false; reason?: string }>;

    steer: (
      sessionId: string,
      message:
        string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> },
      sendOpts?: {
        /** 这条 user 消息的 SDK uuid (renderer 与 messages.agent_meta.uuid 同源, rewind 锚点)。 */
        messageUuid?: string;
        /** 当前用户的展示名 (个人化 turn-start status: "<name> Just Wait ...")。 */
        userName?: string;
      },
    ) => Promise<void>;

    getContextUsage: (
      sessionId: string,
      createOpts?: {
        agentKind: 'claude-code' | 'codex' | 'pi';
        workingDir: string;
        model: string;
        orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;
        effort?: string;
        fastMode?: boolean;
        permissionMode?: string;
        /** 计划模式一级开关(与 permissionMode 正交)。 */
        planMode?: boolean;
        userPrompt?: string;
        makerMemoryEnabled?: boolean;
        extraDirs?: string[];
        writableDirs?: string[];
        displayReasoning?: 'off' | 'summarized' | 'full';
        vendorOptions?: Record<string, unknown>;
        remoteHostId?: string;
        resumeSessionId?: string;
      },
    ) => Promise<import('@cindy/maker-core').ContextUsageData>;

    abortSession: (sessionId: string) => Promise<void>;
    closeSession: (sessionId: string, opts?: { preserveWorkspace?: boolean }) => Promise<void>;
    /** 删除单条消息并让下一次发送从剩余本地历史重建 Agent 上下文。 */
    deleteMessage: (
      sessionId: string,
      clientId: string,
    ) => Promise<{ sessionId: string; clientId: string; clientIds: string[] }>;
    listActive: () => Promise<
      Array<{
        sessionId: string;
        agentKind: 'claude-code' | 'codex' | 'pi';
        workDir: string;
        capabilities: unknown;
        isTurnRunning: boolean;
      }>
    >;
    onInputProjection: (
      cb: (payload: import('../shared/agentInputQueue').AgentInputProjection) => void,
    ) => () => void;
    input: {
      getProjection: (
        sessionId: string,
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      enqueue: (
        sessionId: string,
        item: import('../shared/agentInputQueue').AgentInputQueuedMessage,
        opts?: { sendAtMs?: number; expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      compact: (
        sessionId: string,
        createOpts: import('../shared/agentInputQueue').AgentInputCreateOpts,
        opts?: { userName?: string; expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      steer: (
        sessionId: string,
        item: import('../shared/agentInputQueue').AgentInputQueuedMessage,
        opts?: {
          removeFromQueue?: boolean;
          touchUserSend?: boolean;
          expectedClearBoundaryMs?: number | null;
        },
      ) => Promise<boolean>;
      stop: (
        sessionId: string,
        opts?: {
          keepQueue?: boolean;
          pauseQueue?: boolean;
          expectedClearBoundaryMs?: number | null;
        },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      resume: (
        sessionId: string,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      retryLastError: (
        sessionId: string,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      clearError: (
        sessionId: string,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      persistTurnErrorDeferred: (
        sessionId: string,
        errData: Record<string, unknown> | null,
        agentMeta?: import('@/lib/ccAgent.types').AgentMeta | null,
      ) => Promise<string | undefined>;
      remove: (
        sessionId: string,
        clientId: string,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      updateText: (
        sessionId: string,
        clientId: string,
        newText: string,
        sessionRefs?: import('../shared/agentInputQueue').AgentInputSessionRef[],
        trustedContexts?: import('../shared/agentInputQueue').AgentInputSessionReferenceContext[],
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      move: (
        sessionId: string,
        clientId: string,
        targetIndex: number,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      setExpanded: (
        sessionId: string,
        expanded: boolean,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      setInteractionLock: (
        sessionId: string,
        lockId: string,
        locked: boolean,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      setEditLock: (
        sessionId: string,
        clientId: string,
        locked: boolean,
        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      clearSession: (
        sessionId: string,
        clearedAt?: string,
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
    };

    /** Resolve a pending interaction (permission / ask_user_question / plan_review). */
    resolveInteraction: (
      requestId: string,
      decision: Record<string, unknown>,
    ) => Promise<{ accepted: boolean }>;

    /** Submit one inline plugin Secret through the local trusted-frame-only IPC. */
    submitPluginSetupInline: (request: {
      requestId: string;
      actionId: string;
      expectedRevision: number;
      value: string;
    }) => Promise<void>;

    /** 快照:某会话当前挂起交互(permission/ask/plan),打开/重连/刷新会话时拉一次重建面板。 */
    getPendingInteractions: (sessionId: string) => Promise<
      Array<{
        request: { kind: string; requestId: string; [k: string]: unknown };
        persistId?: string;
      }>
    >;

    // ── 运行时切换 (Stage 2 B) ─────────────────────────────────────────────
    // session 不存在(没 send 过/已 close)时 main 侧 no-op,renderer 可乐观调用。
    /** 返回 deferred=true 表示会话在跑,凭证切换已登记 pending、turn 结束自动生效;undefined = 旧端点。 */
    setModel: (
      sessionId: string,
      model: string,
      providerId?: string | null,
      expectedAgentSwitchRevision?: number,
      selection?: { effort: string; fastMode: boolean },
    ) => Promise<{ deferred: boolean; superseded?: boolean } | undefined>;
    /**
     * session-agent-switch:同一会话切换 agent 引擎(claude-code ↔ codex)。
     * 同引擎换模型走 setModel;跨引擎必须走本方法。意图制:本调用只登记切换
     * 意图(deferred=true 为常态返回),真切换在下一条消息发送时刻执行;
     * effort/fastMode 为目标引擎下应生效的值,apply 时一并落库。
     * switched=false 且无 deferred = 同引擎 no-op(意图已清)。
     */
    switchSessionAgent: (
      sessionId: string,
      targetAgentKind: 'claude-code' | 'codex' | 'pi',
      model: string,
      providerId?: string | null,
      effort?: string,
      fastMode?: boolean,
    ) => Promise<{
      switched: boolean;
      agentKind: 'claude-code' | 'codex' | 'pi';
      model: string;
      engineReady: boolean;
      deferred?: boolean;
      sameEngineRevision?: number;
      sameEngineSuperseded?: boolean;
    }>;
    /**
     * 读 main 权威的 pending 切换意图(内存态,不落库;无意图 → null)。
     * 重开视图 / device-link 远程会话重连后恢复乐观显示用。
     */
    getSessionAgentSwitchIntent: (sessionId: string) => Promise<{
      targetAgentKind: 'claude-code' | 'codex' | 'pi';
      model: string;
      providerId: string | null;
      effort?: string;
      fastMode?: boolean;
    } | null>;
    // effort/mode 透传 string —— 合法值由 maker capabilities 决定, vite-env 不重复枚举
    setEffort: (sessionId: string, effort: string) => Promise<void>;
    setPermissionMode: (sessionId: string, mode: string) => Promise<void>;
    setFastMode: (sessionId: string, enabled: boolean) => Promise<void>;
    setThinkingEnabled: (sessionId: string, enabled: boolean) => Promise<void>;
    /** 计划模式一级开关(与 permissionMode 正交); DB 持久化由调用方另调 sessionService.update({ planModeEnabled }) */
    setPlanMode: (sessionId: string, enabled: boolean) => Promise<void>;
    /** 会话导出 HTML(pi 原生); 主进程弹保存对话框 + 导出 + 在文件管理器显示; 返回路径或 null(取消/不支持) */
    exportSessionHtml: (sessionId: string) => Promise<string | null>;
    /** 手动压缩会话上下文(pi 原生, 可带聚焦指令); 返回压缩前后 token 数 / {noop} / null(会话不在/不支持) */
    compactSession: (
      sessionId: string,
      instructions?: string,
    ) => Promise<{ tokensBefore?: number; estimatedTokensAfter?: number; noop?: boolean } | null>;
    /** 同会话原生分支树；旧 Pi 会话会在 main 侧按持久化元数据懒恢复。 */
    getSessionTree: (sessionId: string) => Promise<MakerSessionTreeSnapshot | null>;
    /** 切换原生分支并同步 Cindy 可见时间线。 */
    navigateSessionTree: (
      sessionId: string,
      entryId: string,
      options?: { summarize?: boolean; customInstructions?: string },
    ) => Promise<{
      tree: MakerSessionTreeSnapshot;
      draftText?: string;
      cancelled?: boolean;
    } | null>;
    /** 返回主进程校验、冲突过滤后真正应用的只读目录子集；no-op 时为 undefined。 */
    setExtraDirs: (sessionId: string, dirs: string[]) => Promise<string[] | undefined>;
    /** 用户明确授予的附加可读写目录；持久化由调用方另调 sessions:update。 */
    setWritableDirs: (sessionId: string, dirs: string[]) => Promise<string[] | undefined>;

    // Memory 控制 (Settings → Personalization → Memory section)
    memoryGet: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
      enabled: boolean;
      source: 'agent-default' | 'host-runtime' | 'user-config';
      stats?: { entryCount?: number; sizeBytes?: number; storagePath?: string };
    }>;
    memorySet: (
      agentKind: 'claude-code' | 'codex' | 'pi',
      enabled: boolean,
    ) => Promise<{
      effective: 'immediate' | 'next-session';
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };
    }>;
    memoryReset: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
      removedEntries?: number;
      removedBytes?: number;
    }>;

    /**
     * 立即开启/关闭 Maker Memory — main 立即调 manager.enable()/disable(),
     * enable 时联动关 native (setMemory(false)); disable 不动 native。
     */
    makerMemorySetEnabled: (enabled: boolean) => Promise<{
      effective: 'next-session';
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };
      /** true = Codex 正忙, 存活会话的软重启在任务结束后自动补做 (设置已生效) */
      codexRestartDeferred: boolean;
    }>;

    /** Maker Memory 整库重置: 删 <userData>/maker-memory/ 全部 workdir 目录 */
    makerMemoryReset: () => Promise<{ removedCount: number }>;

    /** 启动期拉 main 持久化的三个 memory 开关 — 见 preload memoryGetSettings 注释 */
    memoryGetSettings: () => Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
      pi: boolean;
    }>;
    memoryGetSettingsState: () => Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
      pi: boolean;
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };
    }>;
    /** 启动期迁移旧版 renderer/native memory opt-out；null 表示 renderer marker 缺失。 */
    memoryPreserveLegacyMakerDisabled: (legacyRendererValue: boolean | null) => Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
      pi: boolean;
    }>;
    memoryResetSettings: () => Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
      pi: boolean;
      isCustomized: boolean;
      customizedKeys: string[];
      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };
      /** true = Codex 正忙, 存活会话的软重启在任务结束后自动补做 (设置已生效) */
      codexRestartDeferred: boolean;
    }>;

    /** IM 新会话默认 agent/model/effort/provider。传 channel 时按渠道独立读写。 */
    imDefaultSettingsGet: (channel?: ImDefaultSettingsChannel) => Promise<ImDefaultSettingsState>;
    imDefaultSettingsSet: (
      patch: ImDefaultSettingsPatch,
      channel?: ImDefaultSettingsChannel,
    ) => Promise<ImDefaultSettingsState>;
    imDefaultSettingsReset: (channel?: ImDefaultSettingsChannel) => Promise<ImDefaultSettingsState>;

    /** 子代理模型覆盖。null 表示不注入覆盖，仅对新建 agent 会话生效。 */
    subagentModelSettingsGet: () => Promise<SubagentModelSettingsState>;
    subagentModelSettingsSet: (
      patch: SubagentModelSettingsPatch,
    ) => Promise<SubagentModelSettingsWriteResult>;
    subagentModelSettingsReset: () => Promise<SubagentModelSettingsWriteResult>;
    auxiliaryModelSettingsGet: () => Promise<AuxiliaryModelSettingsState>;
    auxiliaryModelSettingsSet: (
      patch: AuxiliaryModelSettingsPatch,
    ) => Promise<AuxiliaryModelSettingsState>;

    /** 视觉桥设置（目标模型勾选 + 视觉后端主/备选）。 */
    visionBridgeSettingsGet: () => Promise<VisionBridgeSettingsState>;
    visionBridgeSettingsSet: (patch: VisionBridgeSettingsPatch) => Promise<VisionBridgeSettingsState>;
    visionBridgeSettingsReset: () => Promise<VisionBridgeSettingsState>;

    /** Agent 资源占用治理(命令并发上限/进程优先级/工具链限核)。 */
    agentResourceSettingsGet: () => Promise<AgentResourceSettingsWire>;
    agentResourceSettingsSet: (
      key: 'maxConcurrentCommands' | 'processPriority' | 'capToolchainThreads',
      value: number | string | boolean,
    ) => Promise<AgentResourceSettingsWire>;
    agentResourceSettingsReset: () => Promise<AgentResourceSettingsWire>;

    /** Silent invalid_encrypted_content recovery setting. */
    silentEncryptedRetryGet: () => Promise<{
      enabled: boolean;
      isCustomized?: boolean;
      defaultEnabled?: boolean;
    }>;
    /** Takes effect immediately for proxy recovery. */
    silentEncryptedRetrySet: (enabled: boolean) => Promise<{
      enabled: boolean;
      isCustomized: boolean;
      defaultEnabled: boolean;
      effective: 'immediate';
    }>;
    silentEncryptedRetryReset: () => Promise<{
      enabled: boolean;
      isCustomized: boolean;
      defaultEnabled: boolean;
      effective: 'immediate';
    }>;
    sessionRuntimeFallbackGet: () => Promise<{
      enabled: boolean;
      isCustomized?: boolean;
      defaultEnabled?: boolean;
    }>;
    sessionRuntimeFallbackSet: (enabled: boolean) => Promise<{
      enabled: boolean;
      isCustomized: boolean;
      defaultEnabled: boolean;
      effective: 'immediate';
    }>;
    sessionRuntimeFallbackReset: () => Promise<{
      enabled: boolean;
      isCustomized: boolean;
      defaultEnabled: boolean;
      effective: 'immediate';
    }>;

    /** Claude Code 自动上下文压缩触发百分比。仅对新建会话生效 */
    compactionGetPct: () => Promise<number>;
    compactionGetState: () => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    /** 写入后返回 main 端 clamp 后的最终百分比 */
    compactionSetPct: (
      pct: number,
      owner: { dataOwnerId: string | null; ownerGeneration: number },
    ) => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    compactionResetPct: (
      owner: { dataOwnerId: string | null; ownerGeneration: number },
    ) => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;

    /** Pi 原生自动上下文压缩触发百分比。下次启动或恢复 Pi 任务时生效 */
    piCompactionGetPct: () => Promise<number>;
    piCompactionGetState: () => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    piCompactionSetPct: (
      pct: number,
      owner: { dataOwnerId: string | null; ownerGeneration: number },
    ) => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    piCompactionResetPct: (
      owner: { dataOwnerId: string | null; ownerGeneration: number },
    ) => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;

    /** LSP Beta 开关 — 控制 mcp providers 是否注入 lsp_* 工具 (默认 false) */
    lspModeGet: () => Promise<{ enabled: boolean }>;
    /** 仅对新 session 生效; 已开 session 的 mcp providers 已固化 */
    lspModeSet: (enabled: boolean) => Promise<{ effective: 'next-session' }>;

    /** 对话语义索引开关 — owner-scoped；企业组织账号默认开，其余默认关 */
    chatEmbeddingGet: () => Promise<{
      enabled: boolean;
      isCustomized?: boolean;
      defaultEnabled?: boolean;
    }>;
    onChatEmbeddingChanged: (
      cb: (stamp: { dataOwnerId: string | null; ownerGeneration: number }) => void,
    ) => () => void;
    /** 立即生效; 第一次开启时 main 会在 embedding_meta 表写入 cutoff 时间戳 */
    chatEmbeddingSet: (
      enabled: boolean,
      owner: { dataOwnerId: string | null; ownerGeneration: number },
    ) => Promise<{ enabled: boolean; isCustomized: boolean; defaultEnabled: boolean }>;
    chatEmbeddingReset: (owner: {
      dataOwnerId: string | null;
      ownerGeneration: number;
    }) => Promise<{
      enabled: boolean;
      isCustomized: boolean;
      defaultEnabled: boolean;
    }>;

    /** Git 安全保存点开关 — 控制 agent turn 后是否自动创建 XDT savepoint commit */
    gitSafetyGet: () => Promise<{
      autoSnapshotEnabled: boolean;
      isCustomized: boolean;
      defaultAutoSnapshotEnabled: boolean;
    }>;
    /** 立即生效; Codex rewind 入口跟随此开关显示 */
    gitSafetySet: (enabled: boolean) => Promise<{
      autoSnapshotEnabled: boolean;
      isCustomized: boolean;
      defaultAutoSnapshotEnabled: boolean;
    }>;
    gitSafetyReset: () => Promise<{
      autoSnapshotEnabled: boolean;
      isCustomized: boolean;
      defaultAutoSnapshotEnabled: boolean;
    }>;

    /**
     * 智能通讯录(maker-contacts)— 设置页管理 UI 数据通道。
     * DTO 用 unknown 透传, renderer 在 lib/contactsService.ts 收敛为
     * @cindy/maker-core 的 contacts 类型(type-only import)。
     */
    contacts: {
      settingsGet: () => Promise<{ enabled: boolean; isCustomized: boolean }>;
      settingsSet: (enabled: boolean) => Promise<{ enabled: boolean; codexMcpRefreshed?: boolean }>;
      syncStatusGet: () => Promise<unknown>;
      syncEnabledSet: (enabled: boolean) => Promise<unknown>;
      syncNow: () => Promise<unknown>;
      list: (opts?: unknown) => Promise<unknown[]>;
      get: (id: string) => Promise<unknown>;
      create: (input: unknown) => Promise<unknown>;
      update: (id: string, patch: unknown) => Promise<unknown>;
      delete: (id: string) => Promise<{ deleted: boolean }>;
      merge: (targetId: string, sourceId: string) => Promise<unknown>;
      resolve: (value: string, opts?: unknown) => Promise<unknown[]>;
      search: (query: string, opts?: unknown) => Promise<unknown[]>;
      stats: () => Promise<{ people: number; orgs: number; pending: number; groups: number }>;
      addIdentity: (contactId: string, input: unknown) => Promise<unknown>;
      removeIdentity: (identityId: string) => Promise<{ removed: boolean }>;
      appendEvent: (contactId: string, input: unknown) => Promise<unknown>;
      deleteEvent: (eventId: string) => Promise<{ deleted: boolean }>;
      addRelation: (fromId: string, input: unknown) => Promise<unknown>;
      removeRelation: (relationId: string) => Promise<{ removed: boolean }>;
      groupsList: () => Promise<unknown[]>;
      groupsCreate: (name: string, description?: string) => Promise<unknown>;
      groupsUpdate: (groupId: string, patch: unknown) => Promise<unknown>;
      groupsDelete: (groupId: string) => Promise<{ deleted: boolean }>;
      groupsSetMembers: (
        groupId: string,
        payload: { add?: string[]; remove?: string[] },
      ) => Promise<{ added: number; removed: number }>;
      resetAll: () => Promise<{ removedCount: number }>;
      systemRead: () => Promise<unknown[]>;
      parseVcf: (text: string) => Promise<unknown[]>;
      import: (records: unknown[], opts?: { groupId?: string }) => Promise<unknown>;
      onChanged: (cb: () => void) => () => void;
      onSyncStatusChanged: (cb: (status: unknown) => void) => () => void;
    };

    /** Codex app-server 当前进程启动冻结的鉴权注入方式(oauth-bearer = 走订阅 / env-key = 走网关 / provider-oauth = proxy 注入供应商 OAuth) */
    codexRuntimeRouteGet: () => Promise<{
      authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth';
    }>;
    onCodexRuntimeRouteChanged: (
      cb: (payload: { authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth' }) => void,
    ) => () => void;

    /** 延迟凭证切换在 turn 结束兑现(见 setModel 返回的 deferred) */
    onSessionCredentialSwitchApplied: (
      cb: (payload: { sessionId: string; model: string; providerId: string | null }) => void,
    ) => () => void;

    /** cc 默认路由会话的生效计费路由(proxy 按请求观察);null = 会话尚未发过请求 */
    claudeSessionRouteGet: (sessionId: string) => Promise<'gateway' | 'subscription' | null>;
    onClaudeSessionRouteChanged: (
      cb: (payload: { sessionId: string; route: 'gateway' | 'subscription' }) => void,
    ) => () => void;

    /** Claude.ai 订阅 OAuth 登录状态(系统 ~/.claude 凭证库是否有 OAuth 登录) */
    claudeOAuthStatus: () => Promise<{ authorized: boolean }>;
    /** 拉起浏览器 OAuth 登录 Claude.ai 订阅;成功写凭证。reason 在失败时给出(cancelled/timeout/...) */
    claudeOAuthLogin: () => Promise<{ ok: boolean; authorized: boolean; reason?: string }>;
    /** 登出 Claude.ai 订阅(⚠️ 同时清本地 claude 的登录凭证) */
    claudeOAuthLogout: () => Promise<{ authorized: boolean }>;
    /** 取消进行中的浏览器 OAuth 登录流 */
    claudeOAuthCancel: () => Promise<{ authorized: boolean }>;
    /** 拉起浏览器 OAuth 登录 xAI(SuperGrok 订阅);成功写 safeStorage。reason 在失败时给出 */
    xaiOAuthLogin: () => Promise<{ ok: boolean; authorized: boolean; reason?: string }>;
    /** 登出 xAI(清本机 safeStorage 的 xai 凭证) */
    xaiOAuthLogout: () => Promise<{ authorized: boolean }>;
    /** 取消进行中的 xAI 浏览器 OAuth 登录流 */
    xaiOAuthCancel: () => Promise<{ authorized: boolean }>;

    // Push channels
    listTurnChangeSets: (
      sessionId: string,
    ) => Promise<import('../shared/turnChangeSet').TurnChangeSetSummary[]>;
    getTurnChangeSets: (
      sessionId: string,
      ids: string[],
    ) => Promise<import('../shared/turnChangeSet').TurnChangeSetDetail[]>;
    applyTurnChangeSet: (
      sessionId: string,
      id: string,
      action: import('../shared/turnChangeSet').TurnChangeAction,
    ) => Promise<import('../shared/turnChangeSet').TurnChangeActionResult>;
    onTurnChangeSetUpdated: (cb: (data: unknown, ownerStamp?: unknown) => void) => () => void;
    onEvent: (cb: (data: unknown) => void) => () => void;
    onStatusChanged: (cb: (data: unknown) => void) => () => void;
    onInteractionRequest: (cb: (data: unknown) => void) => () => void;
    onInteractionDismissed: (cb: (data: unknown) => void) => () => void;

    // dev-only HMR escape hatch — 详见 preload.ts 同名实现注释。
    __resetMakerFanOuts: () => void;

    // Stage 2 C1: chat utility (前身 cc-agent:generate-title / cc-agent:plan-file-write)
    generateTitle: (
      message: string,
      agentKind: 'claude-code' | 'codex' | 'pi',
      sessionId?: string,
    ) => Promise<{ title: string | null }>;
    /** 重命名输入框 Magic 按钮:按会话最新对话内容重新生成标题(失败返 title: null)。 */
    regenerateSessionTitle: (sessionId: string) => Promise<{ title: string | null }>;
    /**
     * 会话自动起名(权威实现在 main):立即占位 + 智能标题覆盖,条件写保证
     * user rename wins。`done=true` 表示该会话已不需要再起名(已起过名或用户
     * 手动改过名);瞬时失败返回 false,调用方应在下一条带文字的消息上重试。
     */
    autoTitle: (request: {
      sessionId: string;
      text: string;
      agentKind: 'claude-code' | 'codex' | 'pi';
      isUserText?: boolean;
    }) => Promise<{ applied: boolean; done: boolean }>;
    /** 输入框推荐提示词:turn 结束后预测用户下一步输入。 */
    predictNextPrompt: (request: {
      sessionId: string;
      agentKind: 'claude-code' | 'codex' | 'pi';
      messages: Array<{ role: string; content: string }>;
      workingDir?: string;
      turnGen: number;
      completionRevision: number;
    }) => Promise<{ prompt: string | null }>;
    helpAsk: (
      request: import('../shared/helpTypes').HelpAskRequest,
    ) => Promise<import('../shared/helpTypes').HelpAnswerResult>;
    helpFeedbackCreate: (
      input: import('../shared/helpTypes').HelpFeedbackDraftInput,
    ) => Promise<import('../shared/helpTypes').HelpFeedbackDraft>;
    /** /issues 页面的「我的 Issue」列表;force=true 绕过 main 侧 60s TTL(手动刷新)。 */
    /**
     * /issues 首屏快照(上次查询成功时落盘的列表镜像)。进页面先渲染它,避免空等远端;
     * fresh 一到即整体接管。**非权威**:里面没有本次查询的健康状况,它的空列表也不构成
     * 「查证过的空」(详见 main/github-issue/myIssuesSnapshotStore.ts)。
     */
    getMyIssuesSnapshot: () => Promise<import('../shared/myIssues').MyIssuesSnapshot | null>;
    listMyIssues: (options?: { force?: boolean }) => Promise<
      | ({ success: true } & import('../shared/myIssues').MyIssuesResult)
      | {
          success: false;
          /** 稳定脱敏码,不是原始错误文本。 */
          error: import('../shared/myIssues').MyIssuesErrorCode;
          items: [];
          githubEnhancement: null;
          githubEnhancementFailed: false;
          degraded: null;
          truncated: false;
        }
    >;
    writePlanFile: (params: {
      requestId: string;
      planFilePath: string;
      content: string;
    }) => Promise<{ success: boolean; error?: string }>;

    // Stage 2 C2: rewind / fork (前身 cc-agent:rewind:* + local-db:sessions:fork)
    /**
     * dryRun: 计算 rewind 会动哪些文件。canRewind=false 走 Error/Empty 态。
     * 错误码: SESSION_NOT_FOUND / MESSAGE_NOT_FOUND / NOT_USER_MESSAGE /
     *        NO_PRIOR_ASSISTANT / SESSION_RUNNING / NO_LIVE_QUERY
     */
    rewindPreview: (sessionId: string, clientId: string) => Promise<RewindFilesResultPayload>;
    /**
     * 真执行 rewind: SDK 文件回滚 + 关 query + 设 pendingRewindTo + DB 软删 messages。
     * 三件套 (resume + resumeSessionAt + forkSession) 重启在用户下一次 send 时由
     * ClaudeCodeAgent 内部自动触发, 对调用方完全透明。
     */
    rewindCommit: (
      sessionId: string,
      clientId: string,
      opts?: { requireLatestUser?: boolean; stopIfRunning?: boolean },
    ) => Promise<import('@/lib/ccAgent.types').Session>;
    forkStripEncrypted: (sourceSessionId: string) => Promise<import('@/lib/ccAgent.types').Session>;
    /**
     * fork: 把 source session 在 messageClientId 处 fork 成新 session。
     * fork 点支持 user 消息(复制提问之前内容)与 assistant 消息(复制含该回复
     * 所在 turn 的全部内容)。
     * 走 maker.forkSdkSession (SDK forkSession + getSessionMessages 建 uuidMap) +
     * SQLite 镜像 + agentMeta uuid remap。错误码:
     *   NOT_FOUND / INVALID_PARAMS / SOURCE_NEVER_RAN / NO_PRIOR_ASSISTANT
     */
    fork: (
      sourceSessionId: string,
      messageClientId: string,
    ) => Promise<import('@/lib/ccAgent.types').Session>;

    /* ── Agent 鉴权 (取代老 codex.auth.*) ── */
    auth: {
      getState: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<CodexAuthState>;
      triggerLogin: (
        agentKind: 'claude-code' | 'codex' | 'pi',
        options?: { mode?: 'browser' | 'device-code'; ownerId?: string },
      ) => Promise<CodexAuthState>;
      cancelLogin: (
        agentKind: 'claude-code' | 'codex' | 'pi',
        options?: { releaseOwner?: boolean; ownerId?: string },
      ) => Promise<void>;
      logout: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<void>;
      onStateChanged: (
        cb: (s: { agentKind: 'claude-code' | 'codex' | 'pi' } & CodexAuthState) => void,
      ) => () => void;
      onLoginProgress: (
        cb: (p: {
          agentKind: 'claude-code' | 'codex' | 'pi';
          phase: string;
          mode?: 'browser' | 'device-code';
          detail?: string;
          verificationUrl?: string;
          userCode?: string;
        }) => void,
      ) => () => void;
    };

    /* ── Agent 联合状态 (binary + auth, 取代老 codex.binary.getStatus) ── */
    agent: {
      getStatus: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
        binaryReady: boolean;
        binaryPath: string;
        authReady: boolean;
        identity?: string;
      }>;
      /** spawn 当前应用使用的 binary `--version`, 进程内缓存。About 面板用。 */
      getBinaryVersion: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
        kind: 'claude-code' | 'codex' | 'pi';
        binaryPath: string | null;
        version: string | null;
        error?: string;
      }>;
    };

    /* ── Agent 今日累计 (取代老 codex.usage.* + onUsageTodaySpendChanged) ── */
    usage: {
      getToday: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
        day: string;
        money?: import('../shared/regionalMoney').RegionalMoney;
        costUsd?: number;
        totalTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        cachedTokens?: number;
      }>;
      getAccount: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<unknown | null>;
      /** Codex app-server authoritative windows and banked reset-credit metadata. */
      getCodexRateLimits: () => Promise<
        import('@cindy/maker-shared/device-link-contract').MobileCodexRateLimitsResult
      >;
      /** Cindy AI /models 下发的 XD 原生报价。 */
      getModelPricing: () => Promise<import('../shared/regionalMoney').ModelPricingCatalog | null>;
      onModelPricingChanged: (
        cb: (pricing: import('../shared/regionalMoney').ModelPricingCatalog | null) => void,
      ) => () => void;
      /** 非 XD Provider 的 Catalog 参考价与用户覆盖。 */
      getReferenceModelPricing: () => Promise<
        import('../shared/regionalMoney').ModelPricingCatalog
      >;
      onReferenceModelPricingChanged: (
        cb: (pricing: import('../shared/regionalMoney').ModelPricingCatalog) => void,
      ) => () => void;
      /** 用量历史聚合 (首页仪表盘)。wire 形态与 main/usage/usageHistory.ts 的 UsageHistoryPayload 同形。 */
      getHistory: (opts?: {
        days?: number;
        forceRefresh?: boolean;
      }) => Promise<import('../main/usage/usageHistory').UsageHistoryPayload>;
      onTodaySpendChanged: (
        cb: (p: {
          day: string;
          money: import('../shared/regionalMoney').RegionalMoney;
          costUsd?: number;
        }) => void,
      ) => () => void;
      onTodayTokensChanged: (cb: (p: CodexUsageSnapshot) => void) => () => void;
      onClaudeAccountChanged: (
        cb: (p: {
          spend: number;
          maxBudget: number;
          currency: import('../shared/regionalMoney').MoneyCurrency;
          budgetResetAt?: string | null;
          todaySpend: number | null;
          fetchedAt: number;
        }) => void,
      ) => () => void;
      onCodexAccountChanged: (
        cb: (p: {
          limitId?: string | null;
          limitName?: string | null;
          primary?: {
            usedPercent: number;
            windowMinutes?: number | null;
            resetsAt?: number | null;
          } | null;
          secondary?: {
            usedPercent: number;
            windowMinutes?: number | null;
            resetsAt?: number | null;
          } | null;
          credits?: {
            hasCredits: boolean;
            unlimited: boolean;
            balance?: string | null;
          } | null;
          planType?: string | null;
          rateLimitReachedType?: string | null;
          source?: 'openai-web' | 'codex-app-server' | string | null;
          updatedAt?: number | null;
          accountId?: string | null;
        }) => void,
      ) => () => void;
      /** xAI(SuperGrok bridge)限流快照推送;字段与 main usageBroadcaster XaiRateLimitSnapshot 对齐。
       *  null = main 主动清空(xAI 登出 / 换账号,clearXaiRateLimitSnapshot)。 */
      onXaiRateLimitChanged: (
        cb: (
          p: {
            limitRequests?: number;
            remainingRequests?: number;
            limitTokens?: number;
            remainingTokens?: number;
            updatedAt: number;
          } | null,
        ) => void,
      ) => () => void;
      getXaiSubscription: () => Promise<unknown | null>;
      onXaiSubscriptionChanged: (cb: (payload: unknown) => void) => () => void;
    };

    /* ── 跨 Agent 工作区互转（双向，5 项独立判断；进度 step 通过 push 流转）── */
    crossAgent: {
      detect: (
        workingDir: string,
        agentKind: 'claude-code' | 'codex' | 'pi',
      ) => Promise<{ items: CrossAgentMigrationItem[] }>;
      convert: (items: CrossAgentMigrationItem[]) => Promise<{
        total: number;
        successCount: number;
        skippedCount: number;
        failedCount: number;
      }>;
      onStep: (cb: (ev: CrossAgentStepEvent) => void) => () => void;
    };

    /* ── Scheduler (Phase 4 IPC, Phase 6 UI) ──
     * payload 同 @cindy/maker-scheduler 的 Schedule / ScheduleRun / SchedulerEvent
     * （为防 vite-env.d.ts 引入 import 副作用导致循环类型解析，这里用 unknown 兜底，
     * renderer 侧由 features/scheduler/lib 重新 narrow 成强类型）。
     */
    schedule: {
      list: (filter?: { status?: 'active' | 'paused' | 'expired' }) => Promise<unknown[]>;
      listTemplates: () => Promise<unknown[]>;
      createFromTemplate: (params: {
        templateId: string;
        paramValues?: Record<string, string>;
        overrides?: unknown;
      }) => Promise<unknown>;
      get: (id: string) => Promise<unknown | null>;
      create: (input: unknown) => Promise<unknown>;
      update: (id: string, patch: unknown) => Promise<unknown>;
      delete: (id: string) => Promise<void>;
      pause: (id: string) => Promise<unknown>;
      resume: (id: string) => Promise<unknown>;
      runNow: (id: string) => Promise<{ runId: string }>;
      /** script 任务能力选择器:各能力的运行时可用性(依赖意识的装入/唤醒态)。 */
      scriptCapabilityStatus: () => Promise<{
        statuses: Array<{
          capability: string;
          state: 'ok' | 'ghost-missing' | 'ghost-asleep';
          ghostName?: string;
        }>;
      }>;
      /** 表单「测试运行」:立即执行一次前置检查脚本,返回判定 / exit code / 输出 / 耗时。 */
      testPreRunHook: (params: {
        command: string;
        timeoutMs?: number;
        workingDir?: string;
        /** 绑定会话任务:workingDir 空时 main 按会话 meta.workDir 解析测试 cwd(与生产一致)。 */
        targetSessionId?: string;
        scheduleName?: string;
      }) => Promise<{
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
      }>;
      /** 表单「AI 生成」:生成前置检查脚本并落盘(落盘即自测),返回可填入的命令 + 自测结果。 */
      generatePreRunHook: (params: {
        description: string;
        scheduleName?: string;
        workingDir?: string;
        providerId?: string;
        agentKind?: 'claude-code' | 'codex' | 'pi';
        model?: string;
        /** 绑定会话任务:workingDir 空时 main 按会话 meta.workDir 解析落盘/自测目录。 */
        targetSessionId?: string;
        /** 绑定任务的缺省模型/来源维度由 targetSessionId 的会话路由补齐。 */
        resolveBoundSessionRoute?: boolean;
        currentCommand?: string;
      }) => Promise<
        | {
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
          }
        | UtilityTextFailure
      >;
      listRuns: (id: string, limit?: number) => Promise<unknown[]>;
      /** { runs, inflightRunIds } —— 形态见 features/scheduler/lib/scheduleSidebarIndexRuns。 */
      listSidebarIndexRuns: () => Promise<unknown>;
      deleteRun: (runId: string) => Promise<void>;
      getInflightCount: (id: string) => Promise<number>;
      getRuntimeState: () => Promise<unknown>;
      getUnreadRunCount: () => Promise<number>;
      markRunRead: (runId: string) => Promise<void>;
      markAllRunsRead: () => Promise<number>;
      markScheduleRunsRead: (scheduleId: string) => Promise<number>;
      onEvent: (
        cb: (
          ev: unknown,
          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };

    projectAutomation: {
      reconcile: (params: { workingDir: string }) => Promise<ProjectAutomationReconcileResult>;
      listConsents: () => Promise<ProjectAutomationConsent[]>;
      revokeConsent: (workingDir: string) => Promise<{ deleted: number }>;
      upsertSchedule: (params: {
        workingDir: string;
        config: unknown;
      }) => Promise<ProjectAutomationReconcileResult>;
      removeSchedule: (params: {
        workingDir: string;
        id: string;
      }) => Promise<ProjectAutomationReconcileResult>;
      onEvent: (cb: (ev: ProjectAutomationEvent) => void) => () => void;
    };

    plugins: {
      list: (workingDir?: string) => Promise<PluginListItem[]>;
      getState: (
        id: string,
        workingDir?: string,
        workspaceKind?: string | null,
      ) => Promise<PluginEnableState>;
      setEnabled: (id: string, enabled: boolean) => Promise<PluginEnableUpdateResult>;
      clearEnabled: (id: string) => Promise<PluginEnableUpdateResult>;
      setProjectEnabled: (workingDir: string, id: string, enabled: boolean) => Promise<void>;
      clearProjectEnabled: (workingDir: string, id: string) => Promise<void>;
    };
    browser: {
      status: () => Promise<BrowserAvailability>;
      openForLogin: () => Promise<{ launched: boolean }>;
    };
    android: {
      status: () => Promise<AndroidStatusSummary>;
      getConfig: () => Promise<AndroidAutomationConfigState>;
      setDefaultDevice: (
        defaultDeviceSerial: string | null,
      ) => Promise<AndroidAutomationConfigState>;
      setAdbPath: (adbPathOverride: string | null) => Promise<AndroidAutomationConfigState>;
      prepareAdb: () => Promise<AndroidAdbPreparationState>;
    };
    iosSimulator: {
      requestAccess: (
        request: IOSSimulatorAccessRequest,
      ) => Promise<IOSSimulatorAccessRequestResult>;
      status: (request: IOSSimulatorStatusRequest) => Promise<IOSSimulatorSessionStatus>;
      call: (request: IOSSimulatorToolRequest) => Promise<IOSSimulatorToolResponse>;
      setAgentControl: (
        request: IOSSimulatorAgentControlRequest,
      ) => Promise<IOSSimulatorToolResponse>;
      setMutationControl: (
        request: IOSSimulatorMutationControlRequest,
      ) => Promise<IOSSimulatorToolResponse>;
      setViewerVisibility: (
        request: IOSSimulatorViewerVisibilityRequest,
      ) => Promise<IOSSimulatorToolResponse>;
      retryNativeRoute: (
        request: IOSSimulatorRetryNativeRouteRequest,
      ) => Promise<IOSSimulatorToolResponse>;
      latestFrame: (request: IOSSimulatorViewerRouteRequest) => Promise<IOSSimulatorToolResponse>;
      setStreamProfile: (
        request: IOSSimulatorStreamProfileRequest,
      ) => Promise<IOSSimulatorToolResponse>;
      liveTouch: (request: IOSSimulatorLiveTouchRequest) => Promise<IOSSimulatorToolResponse>;
      onH264Frame: (callback: (payload: IOSSimulatorH264FramePush) => void) => () => void;
      onRouteStatus: (callback: (payload: IOSSimulatorRouteStatusPush) => void) => () => void;
      onFocusRequest: (callback: (request: IOSSimulatorFocusRequest) => void) => () => void;
    };
    computer: {
      status: (options?: ComputerDriverStatusOptions) => Promise<ComputerDriverStatus>;
      installDriver: () => Promise<ComputerDriverInstallResult>;
      grantPermissions: (options?: {
        showGuide?: boolean;
        openedPaneUrl?: string;
      }) => Promise<ComputerDriverPermissionGrantResult>;
      driverIcon: () => Promise<{ iconDataUrl: string | null }>;
      permissionGuideStatus: () => Promise<ComputerDriverStatus>;
      startPermissionAppDrag: (iconDataUrl: string) => void;
      finishPermissionAppDrag: (didCopy: boolean) => Promise<boolean>;
      cancelPermissionGrant: () => Promise<{ cancelled: boolean }>;
      onPermissionGuideCancelled: (callback: () => void) => () => void;
      onPermissionGuideStatusChanged: (
        callback: (status: ComputerDriverStatus) => void,
      ) => () => void;
      checkUpdate: () => Promise<ComputerDriverUpdateCheck>;
      updateDriver: (opts?: { joinOnly?: boolean }) => Promise<ComputerDriverInstallResult>;
      onUpdateProgress: (callback: (progress: ComputerDriverUpdateProgress) => void) => () => void;
    };
  };
}

/* ── SkillHub Registry types (v0.6) ──
 * Mirror of `src/main/skillhub/registry/types.ts`. Renderer uses these
 * for reading registryEntry on SkillhubSkill; no runtime import needed. */

interface StoredInstall {
  /** 市场版本号字符串。与 server latestVersion 类型对齐(string,非 number)。 */
  version: string;
  /** 该 skill 在 server 上记录的作者 userId。 */
  authorId: string;
  /** sha256 hex(64 字符,无前缀)。 */
  folderHash: string;
  /** unix seconds(非毫秒)。 */
  installedAt: number;
  /** unix seconds。update / publish 同步时刷新。 */
  updatedAt: number;
  /** 本地来源：installed=从市场安装，published=本地创建后发布，learned=/learn 蒸馏产物，imported=本地 zip/SKILL.md 导入。历史数据无此字段。 */
  origin?: 'installed' | 'published' | 'learned' | 'imported';
  /** 是否由产品自动同步流程安装。用于区分普通市场安装与用户可 opt-out 的自动同步安装。 */
  autoSynced?: boolean;
  /** /learn 蒸馏产物的溯源(仅 origin='learned')。personal=true ⇒ publish 拦截。 */
  provenance?: import('../shared/learnTypes').LearnProvenance;
}

interface StoredManifest {
  schemaVersion: 1;
  skillName: string;
  installs: Record<string, StoredInstall>;
}

/* ── SkillHub (xdt-maker-技能中心 v0.5) ──
 * Mirror of the canonical types in `src/main/skillhub/scanner.ts`. Kept inline
 * here so the renderer doesn't have to import across process boundaries —
 * vite-env.d.ts is the single declaration surface for `window.electronAPI`.
 *
 * v0.5: scope expanded from skills only to all three native Claude Code
 * customization kinds (skill / command / agent). The `kind` field replaces
 * the older `type` field (which was always 'claude-code' in v0.4). */
type SkillhubKind = 'skill' | 'command' | 'agent';
type SkillhubScope = 'global' | 'project';

interface SkillhubFileEntry {
  name: string;
  kind: 'file' | 'dir';
}

interface SkillhubSkill {
  id: string;
  /** URL 匹配键 — 不含 engine，和路由格式一致，用于侧栏选中高亮。 */
  urlKey: string;
  /** Pi customization 的 canonical physical source hash；Pi 条目始终提供。 */
  sourceKey?: string;
  /** 同一 URL 基键存在多个来源时，详情路由必须携带 sourceKey。 */
  requiresSourceKey?: boolean;
  /** 来自哪个 agent 引擎。 */
  engine: 'claude-code' | 'codex' | 'pi';
  /** 发现该 skill 的所有引擎专属路径（去重后）。 */
  linkedEngines: Array<{
    engine: 'claude-code' | 'codex' | 'pi';
    label: string;
    runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';
  }>;
  kind: SkillhubKind;
  scope: SkillhubScope;
  name: string;
  description?: string;
  absolutePath: string;
  /** Lexical path reported by discovery before canonical realpath deduplication. */
  discoveredPath?: string;
  mdPath: string;
  files: SkillhubFileEntry[];
  frontmatter?: Record<string, unknown>;
  parseError?: string;
  /** 仅 project scope：项目资产归属根目录。 */
  projectRoot?: string;
  /** 仅 project scope：来自 projectHash.ts 的项目 URL hash。 */
  projectHash?: string;
  /**
   * Registry entry for this skill (v0.6). Non-null when this skill directory
   * has a registry record (installed from Market or published). Null means
   * this is a user-authored local skill with no market interaction.
   * Only set for kind=skill; command/agent always null.
   */
  registryEntry: StoredInstall | null;
}

type SkillhubSourceStatus =
  { state: 'ok'; count: number } | { state: 'missing' } | { state: 'error'; message: string };

interface SkillhubSourceReport {
  kind: SkillhubKind;
  scope: SkillhubScope;
  /** 仅 project scope source report 会填。 */
  projectRoot?: string;
  path: string;
  status: SkillhubSourceStatus;
}

interface SkillhubProjectInput {
  /** 项目资产归属根目录，来自会话分组后的 project root。 */
  projectRoot: string;
  /** 来自 `features/skillhub/lib/projectHash.ts` 的稳定 URL hash。 */
  hash: string;
}

interface SkillUsageSourceBreakdown {
  strongActive: number;
  semiActive: number;
  passive: number;
}

interface SkillUsageAgentBreakdown {
  claude: number;
  codex: number;
}

interface SkillUsageReadObservation {
  fileReadCount: number;
  sessionsWithFileRead: number;
  averageFileReadsPerSession: number;
  extraFileReadCount: number;
  shortWindowRereadSessionCount: number;
  shortWindowRereadRate: number | null;
}

interface SkillUsageDocumentSize {
  characterCount: number;
  byteCount: number;
  estimatedTokenCount: number;
}

interface SkillUsageDocumentVersionSummary {
  skillDocumentHash: string;
  useCount: number;
  firstSeenAt: number;
  latestSeenAt: number;
  agentBreakdown: SkillUsageAgentBreakdown;
  sourceBreakdown: SkillUsageSourceBreakdown;
  readObservation: SkillUsageReadObservation;
  toolCallCount: number;
  repeatedToolCallCount: number;
  toolErrorCount: number;
  commandCallCount: number;
  commandFailureCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

interface SkillUsageTrendPoint {
  day: string;
  useCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

interface SkillUsageSummary {
  skillName: string;
  currentDocumentHash: string | null;
  totalUseCount: number;
  currentDocumentVersionUseCount: number;
  unversionedUseCount: number;
  documentVersionCoverageRate: number | null;
  latestSeenAt: number | null;
  agentBreakdown: SkillUsageAgentBreakdown;
  sourceBreakdown: SkillUsageSourceBreakdown;
  readObservation: SkillUsageReadObservation;
  currentDocumentSize: SkillUsageDocumentSize | null;
  documentVersions: SkillUsageDocumentVersionSummary[];
  currentDocumentVersion: SkillUsageDocumentVersionSummary | null;
  trend: SkillUsageTrendPoint[];
}

type SkillUsageEvidenceBucket = 'tool_failed' | 'command_failed' | 'repeated_calls' | 'recent';

interface SkillUsageEvidenceIndex {
  id: string;
  bucket: SkillUsageEvidenceBucket;
  rawFilePath: string;
  rawLineNo: number;
  sessionId: string;
  sdkSessionId: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  skillName: string;
  skillPath: string | null;
  skillDocumentHash: string | null;
  exposureContentHash: string;
  documentHashSource: 'transcript_skill_content' | 'transcript_file_read' | 'unavailable' | string;
  source: string;
  toolUseId: string | null;
  seenAt: number;
  observation: {
    toolCallCount: number;
    repeatedToolCallCount: number;
    toolErrorCount: number;
    commandCallCount: number;
    commandFailureCount: number;
  };
}

interface SkillUsageDiagnosisContext {
  skillName: string;
  skillPath: string | null;
  currentDocumentHash: string | null;
  summary: SkillUsageSummary;
  evidence: SkillUsageEvidenceIndex[];
  prompt: string;
}

/* ── SkillHub v0.2.1 publish types ── */

type SkillhubSyncResult =
  | { name: string; exists: false }
  | {
      name: string;
      exists: true;
      isMine: boolean;
      /** server 权威 authorId,用于本地 registry 回填及离线归属判定。 */
      authorId?: string;
      authorName?: string;
      latestVersion: string;
      folderHash: string;
      visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
      marketVersion?: string;
      pendingVersion?: {
        version: string;
        status?: string;
      };
      publishedAt: string;
      downloads: number;
      /** 跨设备识别：null = pre-feature 历史版本 */
      latestPublishedFromDeviceId: string | null;
    };

interface SkillhubInfoResult {
  name: string;
  displayName: string;
  description: string;
  authorId: string;
  authorName: string;
  isMine: boolean;
  latestVersion: string;
  folderHash: string;
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
  visibleDeptNames?: string[];
  categories?: string[];
  changelog?: string;
  publishedAt: string;
  downloads: number;
  currentUserDeptIds?: string[];
  currentUserDeptNames?: string[];
  /** 跨设备识别：null = pre-feature 历史版本 */
  latestPublishedFromDeviceId: string | null;
}

interface SkillhubPublishParams {
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
  /** 发布者为部门时的部门归属(od- 开头的飞书部门 ID,Hub 端自动转部门团队) */
  deptTeamSlug?: string;
  /** 发布者为普通团队时的团队归属 slug */
  teamSlug?: string;
  changelog?: string;
}

type SkillhubPublishErrorCode =
  | 'NAME_TAKEN'
  | 'INVALID_DEPT'
  | 'INVALID_NAME'
  | 'CATEGORY_REQUIRED'
  | 'MANIFEST_INVALID'
  | 'VERSION_RACE'
  | 'CHECKSUM_MISMATCH'
  | 'NOT_AUTHOR'
  | 'PACK_FAILED'
  | 'OSS_PUT_FAILED'
  | 'OSS_PUT_EXPIRED'
  | 'OSS_OBJECT_NOT_FOUND'
  | 'API_KEY_MISSING'
  | 'CANCELLED'
  | 'INTERNAL';

type SkillhubPublishProgressEvent =
  | { phase: 'packing' }
  | { phase: 'init' }
  | { phase: 'uploading' }
  | { phase: 'commit' }
  | { phase: 'done'; name: string; version: string }
  | {
      phase: 'scan-status';
      name: string;
      version: string;
      status: string;
      gates?: Array<{
        name: string;
        label?: Record<string, string>;
        status: string;
        issues?: unknown[];
      }>;
    }
  | {
      phase: 'scan-result';
      name: string;
      version: string;
      status: string;
      gates?: Array<{
        name: string;
        label?: Record<string, string>;
        status: string;
        issues?: unknown[];
      }>;
    }
  | { phase: 'failed'; name?: string; errorCode: SkillhubPublishErrorCode; message: string };

interface Window {
  electronAPI: ElectronAPI;
}
