/**
 * NewMakerDraftRoute —— "/cc-agent/new" 路由组件:transient draft,无后端 session。
 * ---------------------------------------------------------------------------
 * 职责:
 *   1. 从 newMakerDraft store 读取 vendor / workingDir / lastByVendor
 *   2. 渲染 CREATE AGENT 主区:lockup + ChatInput(sessionId=undefined) + 快速开始
 *   3. 用户切 vendor → switchVendor() 把当前 prefs 落地 lastByVendor[oldVendor]
 *      + 切到新 vendor 后 ChatInput 的 initialModel/Effort/PermissionMode 自动
 *      由 lastByVendor[newVendor] 提供
 *   4. 用户改 model/effort/permissionMode → patchCurrentVendorPrefs(局部更新)
 *   5. 用户改 workingDir → patchDraft({ workingDir })
 *
 * workspace 选择:
 *   - workingDir=null 表示"对话",仍在同一个创建界面内
 *   - 项目/远程/device-link 上下文由应用外壳或进入路由前的 draft 状态提供,
 *     本路由不再内绘全局侧栏或项目选择器
 *   6. 用户按 Send:
 *        a. vendorAuthGate.checkAndConfirm(vendor)
 *           - 未就绪 → 弹通用 confirmDialog → 跳 settings → 中止
 *        b. 普通路径: createSession → setPending → navigate → SessionView 自动发送
 *        c. Worktree 路径: 先 createSession + 插入状态卡 + navigate,再后台
 *           createWorktree；成功后更新 workingDir 并发送首条消息，失败则把原消息
 *           存回该 session 的 composer draft 供用户重试
 *
 * 文本/附件持久化:
 *   - vendor / workingDir / lastByVendor → localStorage 跨重启保留
 *   - 输入文本/附件 → 走 composerDraftStore,以 NEW_MAKER_DRAFT_KEY 为键,
 *     "侧边栏切走再切回"内容仍在;应用重启则丢(store 是内存 Map)
 *   - send 成功 navigate 之前主动 clearComposerDraftAndNotify(不是裸 clear):
 *     onSend 返回 false 让 ChatInput 没清自己的编辑器,必须通知它同步清空,否则
 *     navigate 卸载时 ChatInput 兜底 effect 会把残留文本写回,下次回到
 *     /cc-agent/new 还会看到上一次的草稿
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NEW_MAKER_DRAFT_KEY } from './newMakerDraftKeys';
import { CreateWorkerPopover, type CreateWorkerForm } from './CreateWorkerPopover';
import { createWorkerLabel } from './workerLabel';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { themeService } from '@/themes/theme-service';
import type { Theme as ColorTheme } from '@/themes/types';
import { ThemeBrandLockup } from '@/components/branding/ThemeBrandLockup';
import { ChatInput } from '@/components/new-chat/ChatInput';
import { WorktreeChipsRow } from '@/components/new-chat/WorktreeChipsRow';
import {
  FolderPickerPopover,
  type FolderPickerSelectSource,
} from '@/components/new-chat/FolderPickerPopover';
import { RightSidebarToggle } from '@/components/layout/RightSidebarToggle';
import {
  AddRemoteProjectDialog,
  type RemoteProjectTarget,
} from '@/components/new-chat/AddRemoteProjectDialog';
import { useHasAnyRemoteTarget } from '@/hooks/useHasAnyReadyRemoteHost';
import { useProviderOnboarding } from '@/hooks/useProviderOnboarding';
import { ConnectProviderCard } from '@/components/onboarding/ConnectProviderCard';
import { buildDeviceLinkCreateArgs } from './deviceLinkCreateArgs';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import { TopRightChipStack, TopRightChipStackProvider } from '@/components/chat/TopRightChipStack';
import { useProportionalWidth } from '@/hooks/useProportionalWidth';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useVendorAuthGate } from '@/hooks/useVendorAuthGate';
import { useAttachments } from '@/hooks/useAttachments';
import {
  useNewMakerDraft,
  switchVendor,
  getDraft,
  patchDraft,
  patchCollab,
  patchCurrentVendorPrefs,
  getFastModeForModel,
  setFastModeForModel,
  setEffortForModel,
  type VendorPrefs,
  type CollabDraft,
} from '@/state/newMakerDraft';
import {
  getProviderModelEffort,
  getProviderModelFast,
  setProviderModelFast,
  useProviderModelMemoryVersion,
} from '@/state/providerModelMemory';
import { setPending, setPendingGoal } from '@/state/pendingFirstMessage';
import {
  clearDraftAndNotify as clearComposerDraftAndNotify,
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
} from '@/lib/composerDraftStore';
import type { JSONContent } from '@tiptap/core';
import { base64ToUint8Array } from '@/lib/fileTypeInference';
import { calibrateDraftModel } from '@/lib/draftModelCalibration';
import { showWorktreeError } from '@/lib/worktreeToast';
import type { CreateWorktreeResp } from '@/lib/worktree.types';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';
import { NewGoalDialog } from '@/components/new-chat/NewGoalDialog';
import type { GoalLimitValues } from '@/components/new-chat/GoalAdvancedLimits';
import { makerChatStore } from '@/lib/makerChatStore';
import { worktreeCreationStore } from '@/lib/worktreeCreationStore';
import { useRefreshWorktrees } from '@/contexts/WorktreeContext';
import { crossAgentConvertService } from '@/lib/crossAgentConvertService';
import { useCrossAgentMigrationDialog } from '@/hooks/useCrossAgentConvertPrompt';
import { getCollaborationStartErrorMessage } from './collaborationErrors';
import { useCollabProjectPolicy } from './hooks/useCollabProjectPolicy';
import { CrossAgentConvertDialog } from '@/components/ui/cross-agent-convert-dialog';
import type { MakerVendor, Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  ChevronDown,
  Code2,
  Hammer,
  MessageSquare,
  MessageSquareCode,
  MonitorSmartphone,
  SearchCode,
} from 'lucide-react';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { InvisibleWindowDragStrip } from '@/components/layout/windowDrag';
import {
  attachGhostMediaToSession,
  getGhostMediaUriFromDataTransfer,
} from '@/cindy-brain/ghostMediaHandover';
import { isGlobalDropIntercepted } from '@/lib/globalDropIntercept';
import { classifyUnclassifiedDroppedItems, getDroppedFileItems } from '@/lib/fileDrop';
import { createLogger } from '@/lib/logger';
import { getRemoteWorkingDirErrorMessage } from './remoteWorkingDirErrors';
import { matchNavigationCommandName, tryHandleNavigationCommand } from '@/lib/navigationCommands';
import {
  useAgentCapabilities,
  evictDeviceCapabilities,
  prefetchDeviceCapabilities,
  type AgentCapabilities,
} from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import {
  useDeviceProviders,
  evictDeviceProviders,
  prefetchDeviceProviders,
} from '@/hooks/useDeviceProviders';
import { evictDeviceGitSafetySettings } from '@/hooks/useGitSafetySettings';
import {
  getProjectPickerDisplayName,
  useProjectPickerOptions,
} from '@/hooks/useProjectPickerOptions';
import {
  resolveFastSupported,
  deriveModelsFromProviders,
  filterChatBridgedCodexProviders,
} from '@/lib/providerModels';
import { effectiveSourceIdForModel, getModel, providerOffersModel, sessionModelSupportsFastMode, connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';
import { isSubscriptionDirectModel } from '../../../shared/subscriptionModels';
import {
  resolveDeviceLinkDraftDefaults,
  type DeviceLinkDraftSelection,
  type RemoteDraftDefaults,
} from './deviceLinkDraftDefaults';
import { makeMirrorAccessors, replaceScope, clearScope } from '@/state/deviceLinkModelMirror';
import type { ModelMemoryAccessors } from '@/components/new-chat/ModelSelector';
import {
  DRAFT_RIGHT_SIDEBAR_TOGGLE_DRAG_STYLE,
  resolveNewMakerDraftRightSidebar,
} from './newMakerDraftRightSidebar';
import { resolveNewMakerDraftEffort } from './newMakerDraftModelPrefs';
import { closeAllTabs as closeRightSidebarTabs } from '@/features/right-sidebar/store';
import { revealOrcaWorkersTab } from '@/features/right-sidebar/plugins/orca-workers/actions';

const log = createLogger('NewMakerDraftRoute');
const IS_MAC_PLATFORM = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
// F-COLLAB (2026-05): 老的 vendor='orca' 入口已退役,OrcaHeaderStrip 组件随之
// 删除(它是给 isOrca 分支的 ChatInput.topSlot 用的)。Lead/Worker 协作组合现在
// 由 ChatInput 底部 CollaborationModeToggle 控制,Lead 是当前 vendor 本身,
// Worker 通过 toggle popover 选 cc / codex。

function makeDraftSessionId(): string {
  return crypto.randomUUID();
}

function stripLocalMentionChips(node: JSONContent | null): JSONContent | null {
  if (!node) return null;
  if (node.type === 'mentionChip') {
    const kind = (node.attrs as { kind?: string } | undefined)?.kind;
    if (kind === 'file' || kind === 'dir' || kind === 'agent') return null;
  }
  if (!node.content) return node;
  const filtered = node.content
    .map((child) => stripLocalMentionChips(child))
    .filter((c): c is JSONContent => c !== null);
  return { ...node, content: filtered };
}

/**
 * 草稿态(还没建会话)使用的 composerDraftStore 键。让 ChatInput 的
 * 文本和 useAttachments 的附件都能在"切走再切回"时存活。
 */
/** export 给外部入口(如 skillhub「学习此技能」)预填 New Maker 草稿用。
 *  常量本体在 newMakerDraftKeys.ts(web-browser 插件也要引用,抽出避免模块环),
 *  这里 re-export 保持既有 import 路径不变。 */
export { NEW_MAKER_DRAFT_KEY };

/** 草稿命名空间图片缓存 URL 前缀(浏览器页面评论截图等草稿期缓存落这里)。 */
const DRAFT_IMAGE_URL_PREFIX = `xdt-image://${NEW_MAKER_DRAFT_KEY}/`;

/**
 * 由 draft.collab 拼出 createSession 后 enableOrca 的入参:与会话内 requestEnableCollab 同口径。
 * 有 workerConfig(用户在「开启协同」弹窗配过 role/model/…)则透传全量;否则只带 workerAgent 回退默认。
 */
function draftEnableOrcaOptions(
  collab: CollabDraft,
  providers: ProviderView[],
  providersReady: boolean,
) {
  const workerAgent: 'claude-code' | 'codex' = collab.worker === 'codex' ? 'codex' : 'claude-code';
  const cfg = collab.workerConfig;
  if (!cfg) return { workerAgent };
  // 草稿里持久化的来源在发送时按 live 目录重新收窄(已连接 + 提供该模型 + 未被可见性
  // 隐藏,与 CreateWorkerPopover.narrowProviderSource 同规则):草稿可跨重启存活,来源
  // 可能已断开/掉模型 —— 直接透传会撞 main 的 PROVIDER_ROUTE_UNAVAILABLE 精确 preflight,
  // 让协同退化成单会话(codex review)。收窄为 undefined = 交回默认路由解析。
  // 仅在目录快照就绪时收窄:loading 中把空/滞后快照当权威会误清有效来源(静默降级,
  // 用户无感);未就绪透传原值,真失效由 main 精确 preflight 报可操作错误(codex review)。
  const providerId = (() => {
    if (!cfg.providerId) return undefined;
    if (!providersReady) return cfg.providerId;
    const provider = connectedProvidersForAgent(providers, workerAgent).find(
      (p) => p.id === cfg.providerId,
    );
    if (!provider || !providerOffersModel(provider, cfg.model, workerAgent)) return undefined;
    const catalogModel = getModel(provider, cfg.model, workerAgent);
    return catalogModel && isModelEnabled(workerAgent, cfg.providerId, catalogModel)
      ? cfg.providerId
      : undefined;
  })();
  return {
    workerAgent,
    role: cfg.role,
    label: createWorkerLabel(cfg.role, []),
    model: cfg.model,
    effort: cfg.effort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
    fast: cfg.fast,
    providerId,
    delegateTask: cfg.initialTask || undefined,
  };
}

const createAgentQuickStarts = [
  {
    key: 'explore',
    labelKey: 'newChat.createAgent.quickStarts.explore',
    icon: SearchCode,
  },
  {
    key: 'build',
    labelKey: 'newChat.createAgent.quickStarts.build',
    icon: Code2,
  },
  {
    key: 'review',
    labelKey: 'newChat.createAgent.quickStarts.review',
    icon: MessageSquareCode,
  },
  {
    key: 'fix',
    labelKey: 'newChat.createAgent.quickStarts.fix',
    icon: Hammer,
  },
] as const;

/**
 * 草稿态没有 sessionId,附件有两种"寄居"形态,lazy-create 出 sessionId 之后
 * 都要迁回真实会话:
 *  1. base64 fallback(useAttachments 落盘失败路径):回填到 image cache,
 *     拿回 xdt-image:// URL 替换掉 base64 字段。这样首条消息里的图片也具备
 *     右键"复制 / 打开目录"能力,且 DB 里不会留下大段 base64。
 *  2. 草稿命名空间缓存(`xdt-image://__new_maker_draft__/...`,浏览器页面
 *     评论截图走这里):复制成真实会话的一份新缓存并改写 URL —— 否则已发
 *     消息会永久指向草稿命名空间,删会话时 `removeSession(realSessionId)`
 *     清不到它们,截图在磁盘上无主累积(Codex review P2)。复制成功后
 *     best-effort 删除草稿原件(此刻旧 URL 仅剩即将被清空的草稿引用)。
 *
 * fail-soft:单张迁移失败保留原字段,不阻塞发送(base64 保持原样;草稿
 * 命名空间 URL 保持可显示,仅回到修复前的残留行为)。
 */
async function rehomeDraftAttachments(
  files: AttachedFile[] | undefined,
  sessionId: string,
): Promise<AttachedFile[] | undefined> {
  if (!files || files.length === 0) return files;
  const migratedDraftUrls: string[] = [];
  const rehomed = await Promise.all(
    files.map(async (f) => {
      if (f.category !== 'image') return f;
      if (!f.url && f.base64) {
        try {
          const buffer = base64ToUint8Array(f.base64);
          const cached = await window.electronAPI.cacheImageFromBuffer({
            sessionId,
            buffer,
            mimeType: f.mimeType,
            suggestedName: f.name,
          });
          return { ...f, url: cached.url, base64: undefined };
        } catch (err) {
          log.warn('rehomeDraftAttachments: base64 rehydrate failed, keep base64', err);
          return f;
        }
      }
      if (f.url?.startsWith(DRAFT_IMAGE_URL_PREFIX)) {
        try {
          const meta = await window.electronAPI.cacheMediaForSession({
            url: f.url,
            sessionId,
          });
          migratedDraftUrls.push(f.url);
          return { ...f, url: meta.url };
        } catch (err) {
          log.warn('rehomeDraftAttachments: draft-cache rehome failed, keep url', err);
          return f;
        }
      }
      return f;
    }),
  );
  if (migratedDraftUrls.length > 0) {
    // 草稿原件清理是收尾优化,失败无害(下次同名草稿覆盖或人工清理)。
    void window.electronAPI.cleanupCachedImages(migratedDraftUrls).catch(() => undefined);
  }
  return rehomed;
}

function getCurrentRoutePath(): string {
  const raw =
    window.location.hash.startsWith('#') && window.location.hash.length > 1
      ? window.location.hash.slice(1)
      : window.location.pathname;
  const pathOnly = raw.split(/[?#]/)[0] || '/';
  return pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
}

/**
 * 发送 / 建目标成功后调用:把草稿 store 的工作区选择复位到默认(对话态、无额外目录)。
 * workingDir=null 会通过 patchDraft 的兜底级联清掉 remoteHostId / deviceLink / collab.enabled,
 * 所以这里只需显式清 workingDir + extraDirs 两个字段。vendor / lastByVendor / fastModeByModel
 * 等模型/agent 层偏好保持不变(那是"我常用哪个"的记忆,和"这次要跑在哪"的工作区选择正交)。
 */
function resetDraftWorkspaceAfterSend(): void {
  patchDraft({ workingDir: null, extraDirs: [] });
}

export function NewMakerDraftRoute() {
  const { t } = useTranslation();
  const draft = useNewMakerDraft();
  const navigate = useNavigate();
  // 首参 914=内容封顶宽(→ inputWidth 封顶 934):大屏留出左右呼吸空间,不再顶满全宽;
  // 与进行中对话页(CCAgentSessionView 同传 914)一致,发送首条消息时输入框宽度不跳变。
  // minWidth=640:小屏兜一个体面下限(与对话页对称);窄于下限时 hook 自动回落成
  // "填满容器",不溢出。
  const { containerRef, inputWidth } = useProportionalWidth(914, { minWidth: 640 });
  // The available rail can shrink when either sidebar opens while the
  // viewport itself remains wide. Keep the draft layout responsive to that
  // actual content width rather than relying on viewport breakpoints.
  const draftContentWidth = inputWidth ?? 800;
  const isDraftNarrow = draftContentWidth < 560;
  const isDraftMedium = draftContentWidth < 700;
  // Keep the full vendor switcher while the composer still has room for it.
  // Icon-only mode is reserved for the tighter toolbar state, not merely a
  // moderately narrow content rail (for example, when attachments are present).
  const isDraftToolbarNarrow = draftContentWidth < 600;
  const { createSession } = useCCSessions();
  const vendorAuthGate = useVendorAuthGate();
  const refreshWorktrees = useRefreshWorktrees();

  // 「添加远程项目」入口:gate = 至少一台 ready SSH 主机 或 一台可控 device-link 设备。
  // 入口渲染在 mode pill 的 FolderPickerPopover 里(Globe 项),点开下面这个弹窗。
  const hasAnyRemoteTarget = useHasAnyRemoteTarget();
  const [addRemoteProjectOpen, setAddRemoteProjectOpen] = useState(false);
  const outletContext = useOutletContext<{
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (sessionId: string | null) => void;
    setRightSidebarWorkdir?: (workdir: string, remoteHostId?: string | null) => void;
  } | null>();
  const rightSidebarCollapsed = outletContext?.rightSidebarCollapsed ?? true;
  const onToggleRightSidebar = outletContext?.onToggleRightSidebar;
  // B2b:面板所在侧 —— 展开入口留守面板消失的那一侧(缺省经典右侧)。
  const rightSidebarSide = outletContext?.rightSidebarSide ?? 'right';
  const setRightSidebarAvailable = outletContext?.setRightSidebarAvailable;
  const setRightSidebarSessionId = outletContext?.setRightSidebarSessionId;
  const setRightSidebarWorkdir = outletContext?.setRightSidebarWorkdir;
  // 用户终裁(2026-07-17):Figma 185:2724 CREATE AGENT 没有首页用量仪表盘,
  // 新建页彻底解除挂载,不迁移、不新增入口。
  // 当前 vendor 对应的 prefs(切 vendor 后这里自动重算 → 透传到 ChatInput initial*)
  const currentPrefs = draft.lastByVendor[draft.vendor];
  const chatPrefs = currentPrefs;
  const persistedAgentKind: 'cc' | 'codex' = draft.vendor === 'codex' ? 'codex' : 'cc';
  const authVendor: 'cc' | 'codex' = persistedAgentKind;
  const capabilityAgentKind = persistedAgentKind === 'codex' ? 'codex' : 'claude-code';

  // 品牌区跟随当前主题；icon / logo 的固定布局统一由 ThemeBrandLockup 负责。
  const [activeColorTheme, setActiveColorTheme] = useState<ColorTheme | null>(() =>
    themeService.getCurrentTheme(),
  );
  useEffect(() => {
    return themeService.onDidChangeTheme((theme) => {
      setActiveColorTheme(theme);
    });
  }, []);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  // 整页拖入的视觉反馈(与 CCAgentSessionView 聊天区同款):enter/leave 计数
  // 配对驱动 isDragOver,亮全区虚线遮罩 + 透传 ChatInput 卡内提示文案。
  const pageDragCounterRef = useRef(0);
  const [pageDragOver, setPageDragOver] = useState(false);
  const [wtCreating, setWtCreating] = useState(false);
  // 首页「+」→「新建目标」弹窗开关 + 打开时输入框已有文字(作默认目标内容)。
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalInitialObjective, setNewGoalInitialObjective] = useState('');
  // 「开启协同」富弹窗(CreateWorkerPopover):与会话内同一控件,收集 role/agent/model/初始任务。
  const [createWorkerOpen, setCreateWorkerOpen] = useState(false);
  const [wtEnabled, setWtEnabled] = useState(false);
  const [wtName, setWtName] = useState('');
  const [wtSourceBranch, setWtSourceBranch] = useState('');
  const [wtBaseRepo, setWtBaseRepo] = useState<string | null>(null);
  // F-COLLAB: 协同模式状态(enabled + worker 类型)直接读自 draft store,
  // 和 workingDir 走同一份 localStorage,重启 / 切走再回都能恢复。
  // 互斥约束(本组件 enforce):
  //   - draft.workingDir == null (对话模式) → 不向 ChatInput 传 collaboration prop,
  //     CollaborationModeToggle 不渲染
  //   - draft.collab.enabled = true → 工作区选择入口隐藏
  //     "对话(不在项目中)"入口,workdir 不可能切到 null
  // 兜底见 patchDraft: 任何把 workingDir 设回 null 的路径会自动关 collab。
  const collab = draft.collab;
  // ChatInput 现在要求显式拥有 attachmentState。这条 transient 路由没有
  // sessionId(还没建会话),sessionId 仍传 undefined(图片本地缓存走 base64
  // fallback——草稿态没真实会话目录可写),但 draftKey 用 NEW_MAKER_DRAFT_KEY
  // 让附件能在"切走再切回"时存活。
  const attachmentState = useAttachments(undefined, NEW_MAKER_DRAFT_KEY);
  const effectiveWorkingDir = draft.workingDir;
  const effectiveRemoteHostId = draft.remoteHostId;
  const isRemoteProjectDraft = effectiveWorkingDir != null && effectiveRemoteHostId != null;
  // device-link:为远程设备项目新建对话(草稿带 deviceId)。与 SSH remoteHostId 互斥。
  // 归一成 string | undefined(能力 hook / getModelById / ChatInput prop 都按此签名;
  // 下面 isDeviceLinkDraft 与 create 分支的真值收窄对 undefined 同样成立)。
  const effectiveDeviceLinkDeviceId = draft.deviceLinkDeviceId ?? undefined;
  const effectiveDeviceLinkDeviceName = draft.deviceLinkDeviceName;
  const isDeviceLinkDraft = effectiveWorkingDir != null && effectiveDeviceLinkDeviceId != null;
  // 零可用模型引导卡:device-link 草稿不出(连接态在被控端,本机替它连不上)。
  const providerOnboarding = useProviderOnboarding();
  const showProviderOnboardingCard = providerOnboarding.visible && !isDeviceLinkDraft;
  const effectiveExtraDirs = draft.extraDirs;
  const effectiveCollab = collab;
  const collabPolicyEligible =
    effectiveWorkingDir != null &&
    effectiveRemoteHostId == null &&
    effectiveDeviceLinkDeviceId == null;
  const collabPolicy = useCollabProjectPolicy(effectiveWorkingDir, collabPolicyEligible);
  const projectPickerOptions = useProjectPickerOptions();
  const createAgentModeLabel =
    getProjectPickerDisplayName(effectiveWorkingDir, projectPickerOptions) ??
    t('newChat.folderPicker.dialogue');
  const draftRightSidebar = useMemo(
    () =>
      resolveNewMakerDraftRightSidebar({
        workingDir: effectiveWorkingDir,
        remoteHostId: effectiveRemoteHostId,
        deviceLinkDeviceId: effectiveDeviceLinkDeviceId,
      }),
    [effectiveWorkingDir, effectiveRemoteHostId, effectiveDeviceLinkDeviceId],
  );

  useLayoutEffect(() => {
    setRightSidebarAvailable?.(draftRightSidebar.available);
    return () => setRightSidebarAvailable?.(false);
  }, [draftRightSidebar.available, setRightSidebarAvailable]);

  useLayoutEffect(() => {
    setRightSidebarSessionId?.(draftRightSidebar.sessionId);
    return () => setRightSidebarSessionId?.(null);
  }, [draftRightSidebar.sessionId, setRightSidebarSessionId]);

  useEffect(() => {
    if (
      effectiveCollab.enabled &&
      !collabPolicy.loading &&
      !collabPolicy.unavailable &&
      !collabPolicy.enabled
    ) {
      patchCollab({ enabled: false });
    }
  }, [
    collabPolicy.enabled,
    collabPolicy.loading,
    collabPolicy.unavailable,
    effectiveCollab.enabled,
  ]);

  useEffect(() => {
    const draftSessionId = draftRightSidebar.sessionId;
    if (!draftSessionId) return;
    return () => {
      void closeRightSidebarTabs(draftSessionId).catch((err) => {
        log.warn('cleanup draft right sidebar tabs failed', { draftSessionId, err });
      });
    };
  }, [draftRightSidebar.sessionId]);

  useLayoutEffect(() => {
    if (draftRightSidebar.workdir) {
      setRightSidebarWorkdir?.(draftRightSidebar.workdir, draftRightSidebar.remoteHostId);
    } else {
      setRightSidebarWorkdir?.('');
    }
    return () => setRightSidebarWorkdir?.('');
  }, [draftRightSidebar.workdir, draftRightSidebar.remoteHostId, setRightSidebarWorkdir]);

  // 跨 Agent 工作区迁移弹窗：detect → ask → run → 等关闭 → 才创建会话
  const crossAgentDialog = useCrossAgentMigrationDialog();

  // device-link:在远程设备上新建会话时,能力 / 模型必须来自该被控端(草稿带 deviceLinkDeviceId);
  // 本地草稿 effectiveDeviceLinkDeviceId 为 undefined → 走本地能力(行为不变)。
  const { capabilities, loading: capabilitiesLoading } = useAgentCapabilities(capabilityAgentKind, effectiveDeviceLinkDeviceId);
  // device-link「以被控端为准」:远程草稿用被控端经隧道带来的 providers(per-provider,含 fast 能力);
  // 本地草稿用本机 providers。fast 判定统一交给 resolveFastSupported(不在控制端另写远程逻辑)。
  const { providers: localProviders, loading: localProvidersLoading } = useProviders();
  const { providers: deviceProviders, loading: deviceProvidersLoading } = useDeviceProviders(effectiveDeviceLinkDeviceId);
  const providers = effectiveDeviceLinkDeviceId ? deviceProviders : localProviders;

  // 草稿当前**生效来源 id**(= ModelSelector 高亮 / ChatInput effectiveSourceId 同口径):显式选中且
  // 仍可连、并提供当前模型 → 它;否则只在当前模型的可用来源中取原生默认。fast/effort 的
  // 模型级全局预设不靠它隔离,但仍用它校验来源 capability、保留旧 v2 兼容副本并路由
  // device-link 写穿。仅本地草稿用;device-link 走 dlSel 镜像、不读本机记忆
  // (下方 resolveDraftFast 只在本地分支调用)。
  /**
   * 草稿实际生效的模型 id —— 种子默认在这里被校准到「确有已连接来源」的模型。
   *
   * 必须算在 effectiveSourceId / effort / fast 之前:它们全部按这个模型推导。若只把校准
   * 结果用在 draftInitialModel 上,会拿新模型配上按旧模型算出来的 effort / fastMode,
   * 提交一份目标模型根本不支持的组合(PR #548 review)。
   *
   * 候选与 ChatInput 的 SSH 可见性同口径 —— 那里由 `!!remoteHostId` 同时驱动两道排除,
   * 少一道就会把远端根本路由不出去的模型选成默认:
   *   · 供应商级 `excludeChatBridgedCodex`:Responses→Chat 桥只挂本地 codex-proxy;
   *   · 模型级 `excludeSubscriptionDirect`:订阅直连(chatgpt/ 、xai/)的 bridge 只挂本地
   *     compat-proxy。必须逐模型判,同一供应商可能既有可路由模型又有订阅直连模型。
   * device-link 草稿以被控端镜像为准,整段不校准(被控端跑完整 app,两道排除都不适用)。
   */
  // 可见性 override 变更要重算校准候选(与 ModelSelector 同一份订阅源)。
  const modelVisibilityVersion = useModelVisibilityVersion();
  const calibrationProviders = useMemo(() => {
    const base = filterChatBridgedCodexProviders(
      localProviders,
      capabilityAgentKind,
      !!effectiveRemoteHostId,
    );
    // 逐模型过滤要落在**候选本身**，而不是只落在「挑哪个模型」那一步：来源解析
    // (effectiveSourceIdForModel) 吃的是同一份候选，若这里不剔除，被隐藏的条目仍会让它
    // 选中那个来源 —— 于是 providerId 落 null、main 解析到同一个被用户排除的默认来源，
    // effort / fast 也从错误的条目推导(PR #548 review)。
    return base
      .map((p) => {
        const models = p.models[capabilityAgentKind] ?? [];
        const kept = models.filter(
          (m) =>
            isModelEnabled(capabilityAgentKind, p.id, m) &&
            !(effectiveRemoteHostId && isSubscriptionDirectModel(m.id)),
        );
        if (kept.length === models.length) return p;
        return { ...p, models: { ...p.models, [capabilityAgentKind]: kept } };
      })
      .filter((p) => (p.models[capabilityAgentKind] ?? []).length > 0);
  }, [
    localProviders,
    capabilityAgentKind,
    effectiveRemoteHostId,
    modelVisibilityVersion,
  ]);
  /**
   * **自动**选择用的候选:再剔掉清单发现失败的供应商。
   *
   * 失败时我们刻意保留上次成功的清单(设置页也已改口径,明说那是上次获取的结果),但那份
   * 清单只适合「用户自己点进去选」,不适合当成默认值送人:unauthorized / regionBlocked 这
   * 类确定性失败下,把从没选过模型的用户自动落到这个来源,首条消息必然失败 —— 正是这套
   * 校准要消灭的状态(PR #548 review)。
   *
   * 用户显式表达过(选过模型、或存了显式来源)时不做这层剔除:他选的就该生效,而且来源解析
   * 也必须还能指到那个供应商。全部供应商都在失败态时同样退回完整候选 —— 那时没有更好的
   * 选择,给个陈旧清单也好过一个都挑不出来。
   */
  const draftModelChosenByUser = draft.modelChosenByVendor[draft.vendor] === true;
  const autoCalibrationProviders = useMemo(() => {
    if (draftModelChosenByUser || chatPrefs.providerId) return calibrationProviders;
    const healthy = calibrationProviders.filter((p) => !p.modelDiscoveryFailure);
    return healthy.length > 0 ? healthy : calibrationProviders;
  }, [calibrationProviders, draftModelChosenByUser, chatPrefs.providerId]);
  const calibratedDraftModel = useMemo(() => {
    if (isDeviceLinkDraft) return chatPrefs.model;
    return calibrateDraftModel({
      providers: autoCalibrationProviders,
      agent: capabilityAgentKind,
      model: chatPrefs.model,
      chosenByUser: draftModelChosenByUser,
      providersLoading: localProvidersLoading,
    });
  }, [
    isDeviceLinkDraft,
    autoCalibrationProviders,
    capabilityAgentKind,
    chatPrefs.model,
    draftModelChosenByUser,
    localProvidersLoading,
  ]);

  const effectiveSourceId = useMemo<string | null>(() => {
    // 本地草稿用**过滤后**的候选解析来源:SSH 场景下同一个 model id 可能既被允许的来源
    // 提供、又被排除掉的 openai-chat 来源提供,拿未过滤的 providers 解析会指到后者 ——
    // 于是 providerId 落 null、main 挑到被排除的原生默认,而 ChatInput 看到的是允许的
    // 那个来源、Send 照常放行,最后在远端失败(PR #548 review)。
    // device-link 草稿以被控端目录为准,不参与本地过滤。
    //
    // 用与挑模型同一份候选:自动路径已剔除失败态供应商,来源解析若还看得见它们,就会把刚
    // 挑好的健康模型重新指回那个已知失败的原生默认来源(PR #548 review)。用户显式表达过时
    // autoCalibrationProviders 本身就等于完整候选,不受影响。
    const source = isDeviceLinkDraft ? providers : autoCalibrationProviders;
    return effectiveSourceIdForModel(
      source,
      chatPrefs.providerId ?? null,
      calibratedDraftModel,
      capabilityAgentKind,
    );
  }, [
    isDeviceLinkDraft,
    providers,
    autoCalibrationProviders,
    capabilityAgentKind,
    chatPrefs.providerId,
    calibratedDraftModel,
  ]);

  // 首页是“下一次创建会话”的配置草稿,没有正在运行的当前模型需要保护。其它对话更新同一模型
  // 的全局预设后,即使该模型正显示在首页 trigger 上,也应立即采用新 effort / fast。真实会话仍
  // 由 CCAgentSessionView 的 live DB/runtime props 保护,不会走这里。
  const modelPresetVersion = useProviderModelMemoryVersion();
  const localDraftEffort = useMemo<Effort>(() => {
    if (isDeviceLinkDraft || !effectiveSourceId) return chatPrefs.effort;
    const provider = providers.find((item) => item.id === effectiveSourceId);
    // 按**校准后**的模型推导:effort 必须和最终提交的模型属于同一个能力集合。
    const model = provider
      ? getModel(provider, calibratedDraftModel, capabilityAgentKind)
      : undefined;
    return resolveNewMakerDraftEffort({
      currentEffort: chatPrefs.effort,
      presetEffort: getProviderModelEffort(
        capabilityAgentKind,
        effectiveSourceId,
        calibratedDraftModel,
      ),
      efforts: model?.efforts ?? [],
      defaultEffort: model?.defaultEffort ?? null,
    });
  }, [
    isDeviceLinkDraft,
    effectiveSourceId,
    providers,
    capabilityAgentKind,
    calibratedDraftModel,
    chatPrefs.effort,
    modelPresetVersion,
  ]);

  // 草稿 live fast 读 per-(agent, 来源, 模型) 记忆(与下拉行 fastOnOf / 会话 resolveFast 同口径,
  // 多供应商同名模型不串);该三元组无记录时回退 per-model 旧库 getFastModeForModel —— 仅兜底,
  // 不再是权威读源(retire 计划单列)。device-link 草稿不调本函数(以被控端镜像为准)。
  const resolveDraftFast = useCallback(
    (modelId: string): boolean => {
      if (effectiveSourceId) {
        const v = getProviderModelFast(capabilityAgentKind, effectiveSourceId, modelId);
        if (v !== undefined) return v;
      }
      return getFastModeForModel(modelId);
    },
    [effectiveSourceId, capabilityAgentKind],
  );

  // ── device-link 远程草稿:全量镜像被控端「当前 New Maker 草稿」 ──────────────────
  // 选中模型的 model/effort/fast/permission/source 不取控制端本地(chatPrefs),改经隧道拉被控端
  // 当前草稿值(maker:get-new-maker-defaults),按被控端 capabilities 校准后 seed 进一个**临时
  // holder(dlSel)**;用户在远程草稿里的修改只写 dlSel,既不污染本地 newMakerDraft、也不回写被控端。
  // 旧版被控端无此 channel / 拉取失败 → remoteDraft=null → 回落被控端 capabilities 默认(绝不回落本地)。
  // 本地草稿(无 deviceId)整段跳过,走下方 chatPrefs 路径(逐字节不变)。
  const [remoteDraftState, setRemoteDraftState] = useState<{
    loaded: boolean;
    value: RemoteDraftDefaults | null;
  }>({ loaded: false, value: null });
  const [dlSel, setDlSel] = useState<DeviceLinkDraftSelection | null>(null);
  const dlSeedKeyRef = useRef<string | null>(null);
  const skipDefaultsRefetchRef = useRef(false);

  // 拉被控端当前草稿值(每次 deviceId / vendor 变化重拉;失败 / 旧版 → value=null 触发 fallback)。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) {
      setRemoteDraftState({ loaded: false, value: null });
      return;
    }
    // handoff 路径已 inline 拉取并 set 了 remoteDraftState,跳过本次 effect 重拉。
    if (skipDefaultsRefetchRef.current) {
      skipDefaultsRefetchRef.current = false;
      return;
    }
    let cancelled = false;
    setRemoteDraftState({ loaded: false, value: null });
    window.electronAPI.deviceLink
      .invoke(effectiveDeviceLinkDeviceId, 'maker:get-new-maker-defaults', [capabilityAgentKind])
      .then((v) => {
        if (!cancelled) {
          setRemoteDraftState({ loaded: true, value: (v as RemoteDraftDefaults | null) ?? null });
        }
      })
      .catch(() => {
        // 旧版被控端无此 channel(CHANNEL_NOT_ALLOWED)/ 拉取失败 → 回落 capabilities 默认。
        if (!cancelled) setRemoteDraftState({ loaded: true, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [isDeviceLinkDraft, effectiveDeviceLinkDeviceId, capabilityAgentKind]);

  // seed dlSel:等被控端 capabilities + 草稿值都就绪后种一次;按 (deviceId, vendor) 记 seedKey,
  // 同一设备 / vendor 内不重种(用户编辑只改 dlSel、不动 seedKey,故不被覆盖),切设备 / vendor 才重种。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) {
      dlSeedKeyRef.current = null;
      setDlSel(null);
      return;
    }
    if (!capabilities || !remoteDraftState.loaded) return;
    const key = `${effectiveDeviceLinkDeviceId}:${capabilityAgentKind}`;
    if (dlSeedKeyRef.current === key) return;
    dlSeedKeyRef.current = key;
    setDlSel(
      resolveDeviceLinkDraftDefaults(
        capabilities,
        remoteDraftState.value,
        undefined,
        capabilityAgentKind,
      ),
    );
  }, [
    isDeviceLinkDraft,
    effectiveDeviceLinkDeviceId,
    capabilityAgentKind,
    capabilities,
    remoteDraftState,
  ]);

  // 远程草稿展示用:已 seed 用 dlSel;seed 完成前(等隧道 / 能力)先用 capabilities 默认占位,
  // 绝不回落控制端本地(仅 capabilities 未就绪的极早期暂为 null,此时与改造前行为一致)。
  const deviceLinkInitial = useMemo<DeviceLinkDraftSelection | null>(() => {
    if (!isDeviceLinkDraft) return null;
    if (dlSel) return dlSel;
    if (capabilities) {
      return resolveDeviceLinkDraftDefaults(capabilities, null, undefined, capabilityAgentKind);
    }
    return null;
  }, [isDeviceLinkDraft, dlSel, capabilities, capabilityAgentKind]);

  // ── device-link 草稿列表「纯显示镜像」(非选中行的 effort/fast) ──────────────────
  // scopeKey 按设备隔离。镜像 = 被控端 providerModelMemory 全量快照(草稿列表行的真实读源),
  // 由 remoteDraftState(pull + push 回流)喂;ModelSelector 经 modelMemoryOverride 读它显示每个供应商
  // 每个模型的 effort/fast(req1),改动经隧道写穿被控端(req2),绝不碰控制端本地 providerModelMemory。
  const mirrorScopeKey =
    isDeviceLinkDraft && effectiveDeviceLinkDeviceId
      ? `draft:${effectiveDeviceLinkDeviceId}`
      : null;

  // 用被控端快照刷新镜像(初始 pull + 后续 push 都经 remoteDraftState.value 流入)。
  // 仅在 loaded 时刷:重拉期间(loaded=false, value 暂为 null)**保留旧镜像**,避免非选中行闪默认再收敛
  // (镜像 scope 按设备、跨 agent 存全量,切 vendor 重拉无需清;真切设备由下方 clearScope effect 处理)。
  useEffect(() => {
    if (!mirrorScopeKey || !remoteDraftState.loaded) return;
    replaceScope(mirrorScopeKey, remoteDraftState.value?.providerModelMemory);
  }, [mirrorScopeKey, remoteDraftState.loaded, remoteDraftState.value]);

  // 离开 / 切设备时清掉该 scope 的镜像(避免泄漏);仅随 scopeKey 变化触发,不在每次 push 时清。
  useEffect(() => {
    if (!mirrorScopeKey) return;
    return () => clearScope(mirrorScopeKey);
  }, [mirrorScopeKey]);

  // 订阅被控端草稿全量变更 push:被控端本地改 / 应用控制端写穿后回流 → 刷新 remoteDraftState
  // (驱动镜像 effect + 选中行还原)。控制端是纯显示,这里只更新显示态、不回写被控端。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) return;
    const vendorSlot = capabilityAgentKind === 'codex' ? 'codex' : 'claudeCode';
    return window.electronAPI.deviceLink.onRemotePush((push) => {
      if (push.deviceId !== effectiveDeviceLinkDeviceId) return;
      if (push.channel !== 'maker:new-maker-draft:changed') return;
      const payload = push.payload as Record<string, RemoteDraftDefaults | undefined> | null;
      const next = payload?.[vendorSlot] ?? null;
      setRemoteDraftState({ loaded: true, value: next });
      // 选中行(dlSel)的 effort/fast 也跟被控端走:按当前 dlSel.model 重解析,但保留控制端的
      // permission/source/model 选择(非按模型记 / 控制端 launch 意图)。被控端改选中模型 effort 即时反映。
      if (capabilities) {
        setDlSel((prev) => {
          if (!prev) return prev;
          const re = resolveDeviceLinkDraftDefaults(
            capabilities,
            next,
            prev.model,
            capabilityAgentKind,
          );
          return { ...prev, effort: re.effort, fastMode: re.fastMode };
        });
      }
    });
  }, [isDeviceLinkDraft, effectiveDeviceLinkDeviceId, capabilityAgentKind, capabilities]);

  // modelMemoryOverride:非选中行读镜像、改动经隧道写穿被控端(active=false)。providerId 由
  // ModelSelector 按行传入(每行各自的供应商)。写失败(旧版被控端 / 离线)静默吞 —— 乐观本地镜像
  // 已更新,只是不传播,即优雅降级。
  const deviceLinkDraftMemory = useMemo<ModelMemoryAccessors | undefined>(() => {
    if (!mirrorScopeKey || !effectiveDeviceLinkDeviceId) return undefined;
    const deviceId = effectiveDeviceLinkDeviceId;
    return makeMirrorAccessors(mirrorScopeKey, (agent, providerId, model, patch) => {
      window.electronAPI.deviceLink
        .invoke(deviceId, 'maker:apply-new-maker-draft-pref', [
          {
            agent,
            providerId,
            modelId: model,
            active: false,
            ...(patch.markModelChoice !== undefined
              ? { markModelChoice: patch.markModelChoice }
              : {}),
            ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
            ...(patch.fast !== undefined ? { fast: patch.fast } : {}),
          },
        ])
        .catch(() => {
          // CHANNEL_NOT_ALLOWED(旧版被控端)/ 离线 → 吞掉,保留控制端乐观镜像(优雅降级)。
        });
    });
  }, [mirrorScopeKey, effectiveDeviceLinkDeviceId]);

  // 选中模型(trigger)的 effort/fast 改动写穿被控端(active=true):被控端额外 patchVendorPrefs
  // 更新 trigger 激活 effort。providerId 取控制端当前选中来源(null → 空串,被控端 provider 层 no-op,
  // trigger 仍经 lastByVendor / 旧层 fallback 反映)。失败静默吞(优雅降级)。
  //
  // ⚠️ 与 deviceLinkDraftMemory(active=false)是**互补**而非重复,勿当"双写"清理掉其一:
  //   - 本路径(active=true,providerId 可能为空)→ 被控端 patchVendorPrefs 更 trigger 激活档(provider 无关)。
  //   - mirror 路径(active=false,providerId=ChatInput 解析出的真实来源)→ 非选中编辑只改模型预设;
  //     真正选择模型时额外带 markModelChoice=true 更新该来源 lastModel。
  // 选中模型编辑时两路都会触发(effort 经 ChatInput.rememberProviderChoice + onEffortDidChange;
  // fast 经 ModelSelector.handleEditFast + onFastModeChange),各司其职,缺一会丢 trigger 或 provider 记忆。
  const pushActiveDraftPref = useCallback(
    (patch: { effort?: Effort; fast?: boolean }) => {
      if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) return;
      const model = dlSel?.model ?? deviceLinkInitial?.model;
      if (!model) return;
      const activeEffort =
        patch.effort ??
        (patch.fast !== undefined ? (dlSel?.effort ?? deviceLinkInitial?.effort) : undefined);
      window.electronAPI.deviceLink
        .invoke(effectiveDeviceLinkDeviceId, 'maker:apply-new-maker-draft-pref', [
          {
            agent: capabilityAgentKind,
            providerId: dlSel?.providerId ?? deviceLinkInitial?.providerId ?? '',
            modelId: model,
            active: true,
            markModelChoice: false,
            ...(activeEffort !== undefined ? { effort: activeEffort } : {}),
            ...(patch.fast !== undefined ? { fast: patch.fast } : {}),
          },
        ])
        .catch(() => {});
    },
    [isDeviceLinkDraft, effectiveDeviceLinkDeviceId, capabilityAgentKind, dlSel, deviceLinkInitial],
  );

  // Fast 可用判定:本地 + device-link 统一走 resolveFastSupported(共享 per-provider 逻辑,
  // 控制端不另写远程判断;旧被控端回退拍平 caps 见 helper)。device-link 的来源/模型取被控端镜像
  // (dlSel live > deviceLinkInitial seed),本地取**校准后的生效来源** —— 即会话实际会路由
  // 到的那个来源。
  const supportsFastMode = useMemo(() => {
    // 本地不能用 chatPrefs.providerId:它常是 null,而 fast 是 per-provider 能力。默认来源
    // 被隐藏 / SSH 排除、模型由另一个来源提供时,这里会去查那个被排除的来源 —— 要么藏掉本
    // 该有的 Fast 开关,要么把 Fast 开在不支持它的来源上。effort / fast 记忆 / 写回都已按
    // effectiveSourceId 推导,只剩这处没跟上(PR #548 review)。
    const providerId = isDeviceLinkDraft
      ? (dlSel?.providerId ?? deviceLinkInitial?.providerId ?? null)
      : effectiveSourceId;
    // 本地取**校准后**的模型:fast 能力必须按最终提交的那个模型判定。
    const modelId = isDeviceLinkDraft
      ? (dlSel?.model ?? deviceLinkInitial?.model ?? chatPrefs.model)
      : calibratedDraftModel;
    return resolveFastSupported({
      deviceId: effectiveDeviceLinkDeviceId,
      deviceProviders,
      localProviders,
      capabilities,
      providerId,
      modelId,
      agentKind: capabilityAgentKind,
    });
  }, [
    isDeviceLinkDraft,
    dlSel,
    deviceLinkInitial,
    effectiveSourceId,
    chatPrefs.model,
    calibratedDraftModel,
    effectiveDeviceLinkDeviceId,
    deviceProviders,
    localProviders,
    capabilities,
    capabilityAgentKind,
  ]);
  // device-link:fast 取镜像值(deviceLinkInitial.fastMode,seed 时已按被控端拍平能力校准),但再叠
  // 一道 per-provider 的 supportsFastMode gate —— 让 per-provider 判定对"显示+发送"都权威,堵住 seed
  // 拍平值在未来分叉下泄漏(seed 函数 deviceLinkDraftDefaults 保持纯/不依赖 ProviderView)。本地走原逻辑。
  const effectiveFastMode = isDeviceLinkDraft
    ? supportsFastMode
      ? (deviceLinkInitial?.fastMode ?? false)
      : false
    : supportsFastMode
      ? resolveDraftFast(calibratedDraftModel)
      : false;
  // 计划模式草稿态:仅本地草稿支持(device-link 远程草稿 v1 不透传,入口也不显示;
  // 创建后进会话仍可经运行时隧道切换)。
  const effectivePlanMode = isDeviceLinkDraft ? false : chatPrefs.planMode === true;

  // 选中模型 + effort:device-link 用镜像 holder(deviceLinkInitial,被控端草稿值已按 capabilities
  // 校准);本地草稿用 chatPrefs(逐字节不变)。device-link 在 holder seed 完成前(等隧道 / 能力)
  // 极早期暂用 chatPrefs,随后被 deviceLinkInitial 取代。
  const { model: draftInitialModel, effort: draftInitialEffort } = useMemo(() => {
    if (isDeviceLinkDraft && deviceLinkInitial) {
      return { model: deviceLinkInitial.model, effort: deviceLinkInitial.effort };
    }
    // 校准在 calibratedDraftModel 一处完成,effort / fast / 来源都已按它推导 —— 这里
    // 直接用,不再单独算一次(否则又会出现模型与能力参数不同源的分叉)。
    return { model: calibratedDraftModel, effort: localDraftEffort };
  }, [isDeviceLinkDraft, deviceLinkInitial, calibratedDraftModel, localDraftEffort]);

  // 远程草稿的权限档 / 来源同样取镜像 holder;本地走 chatPrefs。
  const chatInitialPermissionMode = isDeviceLinkDraft
    ? (deviceLinkInitial?.permissionMode ?? chatPrefs.permissionMode)
    : chatPrefs.permissionMode;
  // 显式来源只在**仍是当前生效来源**时才带进建会话。
  //
  // 只比对「模型有没有被校准换掉」不够:存储的来源断开 / 不再提供该模型、而另一个已连接
  // 来源恰好提供同一个 model id 时,校准会原样保留模型 id(它确实可用),相等条件因此成立,
  // 却把已经失效的来源一起带了下去 —— 而 effectiveSourceId 早已解析到另一个来源。送出去
  // 就是一对 model / provider 错配,首条请求会打到不服务该模型的上游(PR #548 review)。
  //
  // 但「置 null = 交回默认路由」只在两边会解析到同一个来源时才成立:main 的默认解析吃的是
  // **未过滤**的目录,被用户隐藏、被 SSH 订阅直连排除、被 chat-bridge 排除掉的来源在那边
  // 依然是候选。此时 UI 高亮 B、main 却路由到 A,会话就从一个用户看不见的来源发出去。所以
  // 只在默认路由确实落回 effectiveSourceId 时才省略它,不一致时显式带上(PR #548 review)。
  const localProviderIdForDraft = useMemo<string | null>(() => {
    if (chatPrefs.providerId && chatPrefs.providerId === effectiveSourceId) {
      return chatPrefs.providerId;
    }
    if (!effectiveSourceId) return null;
    // 用与 main 同源的解析函数 + 未过滤目录复算一次默认路由,比较的是同一口径。
    const defaultRouted = effectiveSourceIdForModel(
      localProviders,
      null,
      calibratedDraftModel,
      capabilityAgentKind,
    );
    return defaultRouted === effectiveSourceId ? null : effectiveSourceId;
  }, [
    chatPrefs.providerId,
    effectiveSourceId,
    localProviders,
    calibratedDraftModel,
    capabilityAgentKind,
  ]);
  const chatInitialProviderId = isDeviceLinkDraft
    ? (deviceLinkInitial?.providerId ?? null)
    : localProviderIdForDraft;

  // 弹窗确认添加后的落点:SSH 立即建会话 + navigate;device-link 把当前草稿指向被控端项目,
  // 首条消息发出时走既有 create-on-send 链路(见下方 isDeviceLinkDraft 分支)。
  const handleRemoteProjectAdded = useCallback(
    async (target: RemoteProjectTarget) => {
      // vendor 由外层 VendorSegmentedSwitcher (draft.vendor) 单一决策 —— dialog 不再让用户选。
      const draftVendor: 'cc' | 'codex' = draft.vendor === 'codex' ? 'codex' : 'cc';

      if (target.kind === 'device-link') {
        // device-link:**不**像 SSH 立即建会话(会在被控端留空会话)。改为把当前草稿指向该被控
        // 设备项目,用户发首条消息时走既有 device-link create-on-send 链路(与侧边栏「+新建」同款,
        // 见本文件下方 isDeviceLinkDraft 分支)。我们已在 /cc-agent/new,无需 navigate。
        //
        // 打开远程草稿前先驱逐该设备的能力 / 供应商 / Git safety 缓存:这些是「订阅时拉一次、
        // 无 TTL、只在设备下线才 evict」的快照,被控端在线期间改了模型目录或 Rewind safety
        // 设置控制端不会自动刷新。evict 后显式 prefetch:若选的是同一 deviceId,hook 的
        // useEffect 不会因 deps 不变重跑 fetch,只有 subscriber 通知路径能送达新数据。
        // 验证设备可达:直接 invoke 能力 + 供应商(不走 swallow 的 prefetch)。
        // 失败 throw → dialog 留 open,不破坏当前草稿状态。
        const [freshCaps] = await Promise.all([
          window.electronAPI.deviceLink.invoke(target.deviceId, 'maker:get-capabilities', [capabilityAgentKind]) as Promise<AgentCapabilities>,
          window.electronAPI.deviceLink.invoke(target.deviceId, 'maker:provider:list', []),
        ]);
        // defaults 允许失败(旧版被控端无此 channel → capabilities 默认 fallback)。
        const freshDefaults = await window.electronAPI.deviceLink
          .invoke(target.deviceId, 'maker:get-new-maker-defaults', [capabilityAgentKind])
          .then((v) => (v as RemoteDraftDefaults | null) ?? null)
          .catch(() => null);
        // 设备验证通过(direct invoke 成功)。在所有能 throw 的路径之后才 evict,
        // 避免失败时破坏当前草稿的 hook 快照。evict + prefetch 刷新 hook 缓存;
        // 即使 prefetch 内部 swallow error,send/goal 的 capabilitiesLoading/deviceProvidersLoading
        // gate 会阻止在 hook 尚未就绪时发送。
        evictDeviceCapabilities(target.deviceId);
        evictDeviceProviders(target.deviceId);
        evictDeviceGitSafetySettings(target.deviceId);
        await Promise.all([
          prefetchDeviceCapabilities(target.deviceId),
          prefetchDeviceProviders(target.deviceId),
        ]);
        dlSeedKeyRef.current = `${target.deviceId}:${capabilityAgentKind}`;
        setDlSel(resolveDeviceLinkDraftDefaults(freshCaps, freshDefaults, undefined, capabilityAgentKind));
        setRemoteDraftState({ loaded: true, value: freshDefaults });
        setWtEnabled(false);
        setWtBaseRepo(null);
        setWtSourceBranch('');
        // patchDraft 会改 effectiveDeviceLinkDeviceId → 触发 defaults effect 重拉;
        // 我们已 inline 拉取了 freshDefaults,跳过那次重拉避免覆盖。
        // 清除草稿中基于本地/前设备文件系统的 @file/@dir mention chips。
        const dlDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY);
        if (dlDraft?.text) {
          saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
            ...dlDraft,
            text: stripLocalMentionChips(dlDraft.text),
          });
        }
        // 只有 deviceId 真正变化时 effect 才会重跑并消费 skip flag;同设备不设。
        if (target.deviceId !== effectiveDeviceLinkDeviceId) {
          skipDefaultsRefetchRef.current = true;
        }
        patchDraft({
          workingDir: target.path,
          remoteHostId: null,
          deviceLinkDeviceId: target.deviceId,
          deviceLinkDeviceName: target.deviceName,
          extraDirs: [],
        });
        return;
      }

      // SSH:lazy-create(workspaceKind='project',第一条消息发出时 agent 进程才真正起),
      // 立即建会话记录并 navigate 过去。建会话约定与本文件其它 createSession 路径一致
      // (createSession + makerChatStore.setSessionRuntime + navigate)。
      //
      // SSH 始终取本地(controller)的 provider/fast/effort 上下文,不复用 device-link 派生值。
      // providerId 只保留用户显式选中且仍有效的来源,否则 null(默认路由,不固化默认来源)。
      // 使用 draftInitialModel(用户在 composer 里看到的模型),而不是 chatPrefs.model
      // (当 device-link 草稿活跃时 chatPrefs.model 是旧的 controller-local 值)。
      // bridge 模型(chatgpt/ / xai/)在远程模式不可用(不经本地 compat-proxy),需降级。
      // 非 bridge 模型也必须在已连接的本地来源中存在,否则 SSH 会话首消息会被阻塞。
      const sshConnected = connectedProvidersForAgent(localProviders, capabilityAgentKind);
      const sshVisibleModels = deriveModelsFromProviders(sshConnected, capabilityAgentKind)
        .filter((m) => !isSubscriptionDirectModel(m.id));
      let sshModel = draftInitialModel;
      if (isSubscriptionDirectModel(sshModel) || !sshVisibleModels.some((m) => m.id === sshModel)) {
        if (!sshVisibleModels.length) {
          throw new Error(t('ccAgent.draft.createSessionFailed'));
        }
        sshModel = sshVisibleModels[0].id;
      }
      // 使用 chatInitialProviderId(显示给用户的来源,device-link 活跃时取镜像值)而非
      // chatPrefs.providerId(可能是旧的 controller-local 值)。
      const rawProviderId = chatInitialProviderId ?? null;
      const sshLocalSourceId = effectiveSourceIdForModel(
        localProviders, rawProviderId, sshModel, capabilityAgentKind,
      );
      // 只有用户显式选中的来源在本地仍可用时才保留;否则 null = 走默认路由。
      const sshProviderId = (rawProviderId && sshLocalSourceId === rawProviderId) ? rawProviderId : null;
      // fast mode:来源不支持就关闭;支持时保留用户在 composer 里看到的 effectiveFastMode
      // (device-link 草稿活跃时来自 dlSel/deviceLinkInitial,本地草稿来自 per-model 记忆)。
      const sshSourceSupportsFast = sessionModelSupportsFastMode(localProviders, sshProviderId, sshModel, capabilityAgentKind);
      const sshFastMode = sshSourceSupportsFast ? effectiveFastMode : false;
      // effort: 用 draftInitialEffort(用户在 composer 里看到的值)作 currentEffort,
      // 再由 resolveNewMakerDraftEffort 按本地 SSH model 支持的 levels 做 clamp。
      const sshLocalProvider = sshLocalSourceId ? localProviders.find((p) => p.id === sshLocalSourceId) : undefined;
      const sshLocalModelDesc = sshLocalProvider ? getModel(sshLocalProvider, sshModel, capabilityAgentKind) : undefined;
      const sshEffort = resolveNewMakerDraftEffort({
        currentEffort: draftInitialEffort,
        presetEffort: sshLocalSourceId ? getProviderModelEffort(capabilityAgentKind, sshLocalSourceId, sshModel) : undefined,
        efforts: sshLocalModelDesc?.efforts ?? [],
        defaultEffort: sshLocalModelDesc?.defaultEffort ?? null,
      });
      try {
        const newSession = await createSession({
          agentKind: draftVendor,
          workingDir: target.path,
          workspaceKind: 'project',
          permissionMode: chatInitialPermissionMode,
          model: sshModel,
          effort: sshEffort,
          fastMode: sshFastMode,
          planModeEnabled: effectivePlanMode,
          remoteHostId: target.hostId,
          providerId: sshProviderId,
          extraDirs: [],
        });
        if (!newSession) {
          throw new Error('createSession returned null');
        }
        if (effectivePlanMode) patchCurrentVendorPrefs({ planMode: false });
        makerChatStore.setSessionRuntime(newSession.id, {
          agentKind: draftVendor === 'codex' ? 'codex' : 'claude-code',
          fastMode: sshFastMode,
          planModeEnabled: effectivePlanMode,
        });
        // 把草稿页已输入的文本/附件移交到新会话,避免 navigate 后丢失。
        // rehomeDraftAttachments 把 base64 和 xdt-image://__new_maker_draft__/ 迁移到
        // 新 session 的 image cache,避免持久化孤立引用。browserComments 的 screenshot
        // 也是 AttachedFile,同样需要 rehome。
        const existingDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY);
        if (existingDraft) {
          // SSH agent 无法读取控制端本地文件;只保留 image 类附件(可 rehome 到 cache URL),
          // 丢弃 path-based 非 image 附件(PDF / text 等)。
          const imageOnly = existingDraft.attachments.filter((f) => f.category === 'image');
          const rehomedAttachments = await rehomeDraftAttachments(imageOnly, newSession.id);
          let rehomedComments = existingDraft.browserComments;
          if (rehomedComments && rehomedComments.length > 0) {
            rehomedComments = await Promise.all(
              rehomedComments.map(async (c) => {
                const rehomed = await rehomeDraftAttachments([c.screenshot], newSession.id);
                return rehomed?.[0] ? { ...c, screenshot: rehomed[0] } : c;
              }),
            );
          }
          // SSH 环境下本地 @file/@dir mention 无效,从 Tiptap 文档中剥离。
          const strippedText = existingDraft.text
            ? stripLocalMentionChips(existingDraft.text)
            : existingDraft.text;
          saveComposerDraft(newSession.id, {
            ...existingDraft,
            text: strippedText,
            attachments: rehomedAttachments ?? [],
            browserComments: rehomedComments,
          });
          clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
          attachmentState.clearFiles();
        }
        resetDraftWorkspaceAfterSend();
        navigate(`/cc-agent/${newSession.id}`, { replace: true });
      } catch (err) {
        log.error('[add remote project]', err);
        throw err;
      }
    },
    [draft.vendor, chatPrefs, chatInitialPermissionMode, chatInitialProviderId, draftInitialModel, draftInitialEffort, effectiveFastMode, effectiveDeviceLinkDeviceId, localProviders, capabilityAgentKind, effectivePlanMode, attachmentState, createSession, navigate, t],
  );

  // ─── 切 vendor ──────────────────────────────────────────────────────
  // 把"当前 vendor 的最新 prefs"落进 lastByVendor[oldVendor],然后切到新 vendor。
  // ChatInput 的 initial* 由父级传入,vendor 切换后 ChatInput 重新 mount(key 变化)
  // 自动 pickup 新 vendor 的 lastByVendor 值。
  const handleVendorChange = useCallback(
    (next: MakerVendor) => {
      switchVendor(next, currentPrefs);
    },
    [currentPrefs],
  );

  // ─── 用户在 ChatInput 改 model/effort/permission 后,落进当前 vendor 的 prefs ──
  const patchActivePrefs = useCallback((patch: Partial<VendorPrefs>) => {
    patchCurrentVendorPrefs(patch);
  }, []);

  const handleModelDidChange = useCallback(
    (newModelId: string) => {
      if (isDeviceLinkDraft) {
        // 远程草稿:只改 dlSel,绝不写本地 newMakerDraft。capabilities 未就绪时退化为仅换 model。
        if (!capabilities) {
          setDlSel((prev) => (prev ? { ...prev, model: newModelId } : prev));
          return;
        }
        // 切到 newModelId:从被控端整张草稿(含 per-model 记忆 effort/fastModeByModel)按目标模型解析,
        // 即「还原被控端为该模型记的 effort/fast」,而非沿用上一个模型 / capabilities 默认。
        // permission/source 非按模型记 → 保留草稿里的当前选择(prev),不被切模型重置。
        const resolved = resolveDeviceLinkDraftDefaults(
          capabilities,
          remoteDraftState.value,
          newModelId,
          capabilityAgentKind,
        );
        setDlSel((prev) => ({
          ...resolved,
          permissionMode: prev?.permissionMode,
          providerId: prev?.providerId ?? null,
        }));
        return;
      }
      patchActivePrefs({ model: newModelId });
      // 本地草稿的 Fast 直接由「新 model + 全局预设 + 来源能力」派生,patch 后同步收敛,
      // 不再维护一份可能与其它对话更新脱节的本地 state。
    },
    [isDeviceLinkDraft, capabilities, remoteDraftState, patchActivePrefs, capabilityAgentKind],
  );
  const handleFastModeChange = useCallback(
    (enabled: boolean) => {
      if (isDeviceLinkDraft) {
        setDlSel((prev) => (prev ? { ...prev, fastMode: enabled } : prev));
        pushActiveDraftPref({ fast: enabled }); // 选中模型 fast 写穿被控端
        return;
      }
      if (!supportsFastMode) {
        return;
      }
      // 权威库:per-(agent, 来源, 模型),与 resolveDraftFast 的读源对齐(ModelSelector 的 Edit 面板
      // 对选中模型也会写这一份;此处显式写一遍,使 onFastModeChange 走任何路径都自洽、不依赖选择器侧写)。
      // 写入键必须与 effectiveFastMode 的读取键同源:两者都用**校准后**的模型。若这里仍写
      // chatPrefs.model,种子默认被校准后用户切 fast 会写到一个当前根本没在用的模型上 ——
      // 开关看着没生效,旧模型却被静默改了偏好(PR #548 review)。
      if (effectiveSourceId) {
        setProviderModelFast(capabilityAgentKind, effectiveSourceId, calibratedDraftModel, enabled);
      }
      // per-model 旧库:保留为兜底(retire 计划单列),写入维持向后兼容。
      setFastModeForModel(calibratedDraftModel, enabled);
    },
    [
      isDeviceLinkDraft,
      calibratedDraftModel,
      supportsFastMode,
      effectiveSourceId,
      capabilityAgentKind,
      pushActiveDraftPref,
    ],
  );
  const handleEffortDidChange = useCallback(
    (newEffort: Effort) => {
      if (isDeviceLinkDraft) {
        setDlSel((prev) => (prev ? { ...prev, effort: newEffort } : prev));
        pushActiveDraftPref({ effort: newEffort }); // 选中模型 effort 写穿被控端
        return;
      }
      patchActivePrefs({ effort: newEffort });
    },
    [isDeviceLinkDraft, patchActivePrefs, pushActiveDraftPref],
  );
  // ChatInput 内部决策完 newEffort 时回写这里, 让"每个 modelId 上次的 effort"
  // 跨 ChatInput 实例 / 跨重启保留 (修复: New Maker 先选 Haiku 发完, 再 New Maker
  // 切回 Opus 4.7 默认 Effort 退化成 Low 的问题)。device-link 不写本地 per-model 记忆。
  const handleRememberedEffortChange = useCallback(
    (modelId: string, effort: Effort) => {
      if (isDeviceLinkDraft) return;
      setEffortForModel(modelId, effort);
    },
    [isDeviceLinkDraft],
  );
  const handlePermissionModeDidChange = useCallback(
    (newMode: PermissionMode) => {
      if (isDeviceLinkDraft) {
        setDlSel((prev) => (prev ? { ...prev, permissionMode: newMode } : prev));
        return;
      }
      patchActivePrefs({ permissionMode: newMode });
    },
    [isDeviceLinkDraft, patchActivePrefs],
  );
  // 计划模式草稿开关:写当前 vendor prefs(发送建会话时经 planModeEnabled 落库)。
  // device-link 远程草稿不显示入口(onPlanModeChange 不下发),这里只处理本地。
  const handlePlanModeChange = useCallback(
    (enabled: boolean) => {
      if (isDeviceLinkDraft) return;
      patchActivePrefs({ planMode: enabled });
    },
    [isDeviceLinkDraft, patchActivePrefs],
  );
  // 用户在草稿里切来源 → 记进当前 vendor 的 prefs(切 vendor / 重启后由 initialProviderId 回填,
  // 发送时也以此为准)。null = 清除显式选择,回落默认路由。与 model/effort 同口径。
  // device-link 远程草稿:只改 dlSel(临时),不写本地 prefs。
  const handleProviderDidChange = useCallback(
    (newProviderId: string | null) => {
      if (isDeviceLinkDraft) {
        setDlSel((prev) => (prev ? { ...prev, providerId: newProviderId } : prev));
        return;
      }
      patchActivePrefs({ providerId: newProviderId });
    },
    [isDeviceLinkDraft, patchActivePrefs],
  );

  // ─── 用户改 workingDir(FolderPicker)→ 写回 draft ─────────────────────
  // picker 选 "对话(不在项目中)" 时 dir=null,此时一并清掉 extraDirs,行为对齐
  // 侧边栏 DialogueSection 的 handleCreateDialogue —— 进入对话草稿不应保留
  // 上一个项目的 extra 目录上下文。
  const handleWorkingDirChange = useCallback((dir: string | null) => {
    if (dir == null) {
      patchDraft({ workingDir: null, remoteHostId: null, extraDirs: [] });
      return;
    }
    patchDraft({ workingDir: dir, remoteHostId: null });
  }, []);

  // ─── 新草稿入场:引用目录清零 ──────────────────────────────────────────
  // 引用目录是"这次给 agent 额外看哪"的单次授权,不是"我常用哪个"的偏好记忆:
  // 上一个未发送草稿留下的目录若静默带进新草稿,用户会无感知地扩大 agent 可见
  // 范围(2026-07-25 用户定稿)。每次进入草稿页一律从空开始;store 侧 sanitize
  // 也不跨重启还原,双保险。workingDir / 文本 / 模型等便利性记忆不受影响。
  // StrictMode 双 mount 安全:清空幂等;guard 避免空转 emit。
  useEffect(() => {
    if (getDraft().extraDirs.length > 0) patchDraft({ extraDirs: [] });
  }, []);

  // ─── 用户增删 extraDirs → 写回 draft ────────────────────────────────────
  // 草稿期 (还没建 session) 没有 IPC 可调; 内存态 + 走 createSession
  // 时一次性透传到 DB / agent 即可(sanitize 不跨重启还原,见 store 注释)。
  const handleExtraDirsChange = useCallback((next: string[]) => {
    patchDraft({ extraDirs: next });
  }, []);

  const handleFolderPickerOpenChange = useCallback((open: boolean) => {
    setFolderPickerOpen(open);
  }, []);
  const handleModePickerSelect = useCallback(
    (path: string, source: FolderPickerSelectSource) => {
      handleWorkingDirChange(source === 'dialogue' ? null : path);
    },
    [handleWorkingDirChange],
  );

  const handleWtEnabledChange = useCallback((enabled: boolean) => {
    setWtEnabled(enabled);
  }, []);
  const handleWtSourceBranchChange = useCallback((sourceBranch: string) => {
    setWtSourceBranch(sourceBranch);
  }, []);
  const handleWtBaseRepoChange = useCallback((baseRepo: string | null) => {
    setWtBaseRepo(baseRepo);
  }, []);
  const handleWtNameChange = useCallback((name: string) => {
    setWtName(name);
  }, []);

  // 防止用户在 send 流程中再次按下 send(异步 createSession 期间)。
  const sendInFlightRef = useRef(false);
  const wtRef = useRef({
    enabled: wtEnabled,
    name: wtName,
    sourceBranch: wtSourceBranch,
    baseRepo: wtBaseRepo,
  });
  wtRef.current = {
    enabled: wtEnabled,
    name: wtName,
    sourceBranch: wtSourceBranch,
    baseRepo: wtBaseRepo,
  };

  // ─── Send 拦截:vendorAuthGate → createSession → send / background worktree ──
  // 异步流程未接受发送时 resolve false，让 ChatInput 保留当前草稿。
  const handleSend = useCallback(
    async (
      message: string,
      model: string,
      effort: Effort,
      permissionMode: PermissionMode,
      files?: AttachedFile[],
      mentions?: MentionedResource[],
      opts?: {
        providerId?: string | null;
        quotesEncoded?: boolean;
        agentReferences?: AgentInputReference[];
        pastedTextRanges?: PastedTextRange[];
        slashCommandRanges?: SlashCommandRange[];
        onAccepted?: () => void;
      },
    ): Promise<boolean | undefined> => {
      if (sendInFlightRef.current) return false;
      if (effectiveCollab.enabled && collabPolicy.loading) {
        toast.warning(t('newChat.collaboration.loadingHint'));
        return false;
      }
      let policyEnabled = collabPolicy.enabled;
      let policyUnavailable = collabPolicy.unavailable;
      if (effectiveCollab.enabled && policyUnavailable) {
        const refreshed = await collabPolicy.refresh();
        policyEnabled = refreshed.enabled;
        policyUnavailable = refreshed.unavailable;
      }
      if (effectiveCollab.enabled && (policyUnavailable || !policyEnabled)) {
        toast.warning(
          t(
            policyUnavailable
              ? 'newChat.collaboration.unavailableHint'
              : 'newChat.collaboration.disabledHint',
          ),
        );
        return false;
      }
      const shouldEnableCollab =
        effectiveCollab.enabled && collabPolicyEligible && policyEnabled;
      // device-link 切设备后,capabilities/providers hook 可能还没 re-render 到新设备快照;
      // 此时 effectiveFastMode / supportsFastMode / sendProviderId 仍基于旧设备。
      if (isDeviceLinkDraft && (capabilitiesLoading || deviceProvidersLoading)) return false;
      // 草稿里选定的来源(供应商):ChatInput 在发送时把"仍连接的显式选择"经 opts 传上来
      // (未选 / 已断开 → null = 跟随默认路由)。透传给 createSession 落盘 sessions.provider_id,
      // 让新会话首个请求就走对来源,与"会话内切来源"行为一致。device-link 远程会话不支持(下方分支跳过)。
      const providerId = opts?.providerId ?? null;

      // 本地导航命令(/jump-session)在进入 createSession 前同步短路:命中即直接
      // 跳转,新建界面不会先创建 session。这正是它和 /issue 的关键区别。
      if (matchNavigationCommandName(message)) {
        sendInFlightRef.current = true;
        void (async () => {
          try {
            await tryHandleNavigationCommand(message, { navigate, t });
          } finally {
            sendInFlightRef.current = false;
          }
        })();
        return false;
      }

      // workingDir 为空就是 standalone dialogue;main 端按 workspaceKind='dialogue'
      // 自动分配运行目录。项目不是必填项,只是同一创建页里的可切换上下文。
      const selectedWorkingDir = effectiveWorkingDir?.trim() || undefined;

      sendInFlightRef.current = true;
      void (async () => {
        try {
          // device-link:远程草稿就绪态以被控端为准(传 deviceId 走隧道查被控端 maker:agent:status);
          // 本地草稿 effectiveDeviceLinkDeviceId 为 undefined → 仍走控制端本机就绪检查(行为不变)。
          const { proceed } = await vendorAuthGate.checkAndConfirm(authVendor, {
            deviceId: effectiveDeviceLinkDeviceId,
          });
          if (!proceed) return;

          // device-link 远程项目:在被控端走校验过的 maker:create-session 建会话(写被控 DB,
          // allowlist 内、非裸写),首条消息经 setPending 交给 SessionView 发送(与本地
          // delayed-create 同一交接机制)。跳过跨 agent 迁移 / 本地 createSession —— 那些是
          // 本机 FS 语义,对远程目录不适用。agentKind 用 maker-core 形态。
          // worktree 经隧道在被控端执行(git/fs 全在被控端):与本地"先建会话、后台建
          // worktree、再改会话 workingDir"不同,远程没有改已建会话 workingDir 的通道,
          // 所以顺序反过来 —— 先同步等被控端建好 worktree 拿到路径,再以该路径 + 预生成
          // sessionId 建会话;sessionId 两步共用,被控端 close-session 时才能按
          // worktreeStore 绑定回收 worktree。
          if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId && effectiveWorkingDir) {
            const deviceId = effectiveDeviceLinkDeviceId;
            const deviceName = effectiveDeviceLinkDeviceName ?? deviceId;
            const wt = wtRef.current;
            let remoteWorkingDir = effectiveWorkingDir;
            let presetSessionId: string | undefined;
            if (wt.enabled) {
              // baseRepo 来自被控端 worktree:detect-cwd 的 repoRoot(hooks 已按 deviceId 路由)。
              const baseRepo = wt.baseRepo;
              if (!baseRepo) {
                showWorktreeError({
                  kind: 'unknown',
                  message: t('ccAgent.draft.worktreeMissingRepo'),
                  hint: t('ccAgent.draft.worktreeRepoHint'),
                });
                return;
              }
              let name = wt.name.trim();
              if (!name) name = `auto-${Date.now().toString(36).slice(-6)}`;
              presetSessionId = makeDraftSessionId();
              setWtCreating(true);
              try {
                const resp = (await window.electronAPI.deviceLink.invoke(
                  deviceId,
                  'worktree:create',
                  [
                    {
                      sessionId: presetSessionId,
                      baseRepo,
                      name,
                      sourceBranch: wt.sourceBranch.trim() || 'main',
                    },
                  ],
                )) as CreateWorktreeResp | null;
                if (!resp || !resp.ok) {
                  showWorktreeError(
                    resp && !resp.ok
                      ? resp.error
                      : { kind: 'unknown', message: t('ccAgent.draft.createSessionFailed') },
                  );
                  return;
                }
                remoteWorkingDir = resp.meta.path;
              } catch (err) {
                const remoteWorkdirMessage = getRemoteWorkingDirErrorMessage(err, t);
                if (remoteWorkdirMessage) {
                  toast.error(remoteWorkdirMessage);
                } else {
                  // 隧道失败(含老被控端 CHANNEL_NOT_ALLOWED)仍沿用 worktree 通用错误提示。
                  showWorktreeError({
                    kind: 'unknown',
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
                return;
              } finally {
                setWtCreating(false);
              }
            }
            const createResult = await window.electronAPI.deviceLink.invoke(
              deviceId,
              'maker:create-session',
              [
                // workspaceKind 恒 'project'(归属一致)+ agentKind 归一,见 buildDeviceLinkCreateArgs。
                // extraDirs 一并透传(与本地 create 对齐):被控端 bootstrapSession 按 set-extra-dirs
                // 同款 validateExtraDirs 校验后只存通过的子集,控制端镜像随被控端真相回流。
                buildDeviceLinkCreateArgs({
                  agentKind: persistedAgentKind,
                  // 远程 worktree:workingDir 换成刚建好的 worktree 路径(真实存在,被控端
                  // remote-workdir-guard 按"存在的目录"放行);id 与 worktree 绑定同值。
                  // 非 worktree 流程两者保持原值 / 缺省。
                  id: presetSessionId,
                  workingDir: remoteWorkingDir,
                  model,
                  effort,
                  permissionMode,
                  fastMode: effectiveFastMode,
                  extraDirs: effectiveExtraDirs,
                  // 草稿选定的来源(被控端供应商;null=跟随默认路由)。被控端 create 时落 sessions.provider_id,
                  // 使新远程会话首个请求即按所选来源路由(P2)。
                  providerId,
                }),
              ],
            );
            const remoteSessionId = (createResult as { sessionId?: string } | null)?.sessionId;
            if (!remoteSessionId) {
              toast.error(t('ccAgent.draft.createSessionFailed'));
              return;
            }
            // 重拉该设备会话列表(含字段完整的新会话)→ 注册 origin + 出现在项目下。
            const list = await window.electronAPI.deviceLink.invoke(
              deviceId,
              'local-db:sessions:list',
              [200, 'active', { includePinned: true }],
            );
            if (Array.isArray(list)) {
              remoteProjectsStore.setDeviceSessions(deviceId, deviceName, list as Session[]);
            }
            const rehydratedFiles = await rehomeDraftAttachments(files, remoteSessionId);
            setPending(remoteSessionId, {
              text: message,
              files: rehydratedFiles,
              mentions,
              ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
              ...(opts?.agentReferences?.length ? { agentReferences: opts.agentReferences } : {}),
              ...(opts?.pastedTextRanges?.length
                ? { pastedTextRanges: opts.pastedTextRanges }
                : {}),
              ...(opts?.slashCommandRanges !== undefined
                ? { slashCommandRanges: opts.slashCommandRanges }
                : {}),
            });
            opts?.onAccepted?.();
            clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
            attachmentState.clearFiles();
            resetDraftWorkspaceAfterSend();
            navigate(`/cc-agent/${remoteSessionId}`, { replace: true });
            return;
          }

          // 跨 Agent 工作区检测 + 迁移：必须在 createSession 之前完成，
          // agent 启动时看到的工作区已是迁移后的状态。fail-soft：检测错误只 warn，不阻塞 send。
          try {
            const wd = effectiveWorkingDir;
            if (wd && !isRemoteProjectDraft) {
              const r = await crossAgentConvertService.detect(
                wd,
                persistedAgentKind === 'codex' ? 'codex' : 'claude-code',
              );
              if (r.items.length > 0) {
                // 阻塞等弹窗关闭（用户点不要 / 完成转换 / 失败）—— 都视为流程结束
                await crossAgentDialog.runMigrationFlow(r.items);
              }
            }
          } catch (err) {
            log.warn('[cross-agent migration] non-fatal', err);
          }

          // F-COLLAB (2026-05): 老的 vendor='orca' 创建分支已删除。协同模式现在
          // 走 ChatInput 底部 toggle (CollaborationModeToggle):用户开了 toggle 后
          // Send 流程会先 createSession (本段下方) 创建 Lead,然后立刻调 enableOrca
          // 拉起 Worker (见下方 "F-COLLAB: draft 阶段开了协同 toggle" 段)。

          const sessionId = makeDraftSessionId();
          const workingDir = selectedWorkingDir;
          const wt = wtRef.current;
          if (!isRemoteProjectDraft && wt.enabled) {
            const baseRepo = wt.baseRepo;
            if (!baseRepo) {
              showWorktreeError({
                kind: 'unknown',
                message: t('ccAgent.draft.worktreeMissingRepo'),
                hint: t('ccAgent.draft.worktreeRepoHint'),
              });
              return;
            }

            let name = wt.name.trim();
            if (!name) {
              const suggestResp = await window.electronAPI.worktreeSuggestName({ baseRepo });
              name = (suggestResp.name ?? '').trim();
            }
            if (!name) name = `auto-${Date.now().toString(36).slice(-6)}`;

            const branchName = `xdt/${name}`;
            const newSession = await createSession({
              id: sessionId,
              agentKind: persistedAgentKind,
              model,
              effort,
              permissionMode,
              fastMode: effectiveFastMode,
              planModeEnabled: effectivePlanMode,
              workingDir: baseRepo,
              workspaceKind: 'project',
              extraDirs: effectiveExtraDirs,
              remoteHostId: effectiveRemoteHostId ?? undefined,
              providerId,
            });
            if (!newSession) {
              toast.error(t('ccAgent.draft.createSessionFailed'));
              return;
            }
            // 计划模式是一次性选择:随本次发送被消耗,草稿勾选同步熄灭,
            // 下一次 New Maker 不延续。
            if (effectivePlanMode) patchActivePrefs({ planMode: false });

            // 先把真实 session 收进项目列表，让用户可以切走、再开 New Maker。
            const sendAt = new Date();
            sessionsStore.patchLocal(newSession.id, {
              userSendAt: sendAt.toISOString(),
              updatedAt: sendAt.toISOString(),
            });
            sessionService.touchUserSend(newSession.id, sendAt.getTime()).catch((err) => {
              log.warn('[draft worktree send] touchUserSend failed', err);
            });
            makerChatStore.setSessionRuntime(newSession.id, {
              agentKind: persistedAgentKind === 'codex' ? 'codex' : 'claude-code',
              fastMode: effectiveFastMode,
              planModeEnabled: effectivePlanMode,
            });
            worktreeCreationStore.set(newSession.id, {
              status: 'creating',
              name: branchName,
            });

            // navigate FIRST, 然后再清 draft store —— 避免用户看到 "draft 输入框清空
            // 但还没跳走" 的中间帧。React 18 会把这一段 sync 调用 batch 到一次 commit
            // 里, route change 在那次 commit 同时发生,旧的 draft route 直接被 unmount,
            // 不会暴露 cleared 后的视觉状态。clearFiles 仍然在 React 提交 unmount cleanup
            // 之前同步执行,所以 useAttachments 的 cleanup 不会把刚送出去的附件回写到 store。
            navigate(`/cc-agent/${newSession.id}`, { replace: true });
            // clearDraftAndNotify (not bare clear): onSend returned false above
            // so ChatInput never cleared its editor — without notifying it, the
            // unmount cleanup would snapshot the stale text back under this key.
            clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
            attachmentState.clearFiles();
            resetDraftWorkspaceAfterSend();

            void (async () => {
              // rehome 必须先于 worktreeCreate:失败分支的 restoreFirstMessageDraft
              // 会把附件存进新会话草稿,若此时仍是草稿命名空间 URL,用户从恢复的
              // composer 重试发送就会把 `xdt-image://__new_maker_draft__/` 持久化进
              // 真实会话消息(删会话清不到)。初始值取原 files:rehome 自身抛错时
              // 走 catch 恢复原附件,行为与迁移前一致(fail-soft)。
              let rehomedFiles = files;
              const restoreFirstMessageDraft = () => {
                saveComposerDraft(newSession.id, {
                  text: plainTextToTiptapDoc(message),
                  attachments: rehomedFiles ?? [],
                });
              };
              try {
                rehomedFiles = await rehomeDraftAttachments(files, newSession.id);
                const resp = await window.electronAPI.worktreeCreate({
                  sessionId: newSession.id,
                  baseRepo,
                  name,
                  sourceBranch: wt.sourceBranch.trim() || 'main',
                });
                if (!resp.ok) {
                  worktreeCreationStore.set(newSession.id, {
                    status: 'failed',
                    name: branchName,
                    error: resp.error.message ?? resp.error.kind,
                  });
                  restoreFirstMessageDraft();
                  return;
                }

                const newDir = resp.meta.path;
                const latestSession = await sessionService.get(newSession.id).catch((err) => {
                  log.warn('[draft worktree send] get latest session failed', err);
                  return null;
                });
                if (latestSession?.status !== 'active') {
                  worktreeCreationStore.set(newSession.id, {
                    status: 'failed',
                    name: branchName,
                    error: t('ccAgent.draft.sessionInactive'),
                  });
                  restoreFirstMessageDraft();
                  return;
                }
                try {
                  await sessionService.update(newSession.id, { workingDir: newDir });
                  sessionsStore.patchLocal(newSession.id, { workingDir: newDir });
                } catch (err) {
                  log.error('[draft worktree send] update session workingDir failed', err);
                  worktreeCreationStore.set(newSession.id, {
                    status: 'failed',
                    name: branchName,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  restoreFirstMessageDraft();
                  return;
                }
                await refreshWorktrees();
                // 注意:成功后不立刻 clear worktreeCreationStore —— 移到 sendMessage
                // 触发之后再 clear, 让 CCAgentSessionView 里 worktreePreparing 一直
                // true 到 sendMessage 已经 push 第一条 user message + isStreaming=true
                // 才进入 1.6s 平滑期, overlay 从 "空 ChatView" 自然过渡到 "已在
                // streaming 的 ChatView", 不暴露中间空窗。clear 时机见本 async 块末尾。

                if (shouldEnableCollab) {
                  try {
                    const result = await window.electronAPI.maker.enableOrca(
                      newSession.id,
                      draftEnableOrcaOptions(effectiveCollab, localProviders, !localProvidersLoading),
                    );
                    // worktree 创建在后台完成,组件可能已经切走;这里读取当前 URL,
                    // 避免用 render 时捕获的旧路由误判。
                    if (getCurrentRoutePath() === `/cc-agent/${newSession.id}`) {
                      await revealOrcaWorkersTab(newSession.id, {
                        focusWorkerSessionId: result.workerSessionId,
                      });
                      navigate(`/cc-agent/${newSession.id}`, { replace: true });
                    }
                  } catch (err) {
                    log.error(
                      '[draft worktree send] enableOrca failed (continuing as single session)',
                      err,
                    );
                    toast.error(
                      getCollaborationStartErrorMessage(err, t, { continueAsSingleSession: true }),
                    );
                  }
                }

                const accepted = await makerChatStore.sendMessage(
                  newSession.id,
                  message,
                  model,
                  effort,
                  permissionMode,
                  newDir,
                  rehomedFiles,
                  mentions,
                  {
                    ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
                    ...(opts?.agentReferences?.length
                      ? { agentReferences: opts.agentReferences }
                      : {}),
                    ...(opts?.pastedTextRanges?.length
                      ? { pastedTextRanges: opts.pastedTextRanges }
                      : {}),
                    ...(opts?.slashCommandRanges !== undefined
                      ? { slashCommandRanges: opts.slashCommandRanges }
                      : {}),
                  },
                );
                if (accepted) opts?.onAccepted?.();
                // sendMessage 会先同步 push user message,再异步返回 enqueue 是否接受。
                // await 完成时 messages 已经有 user bubble + isStreaming=true,
                // 此时 clear 让 worktreePreparing 进入 1.6s 平滑期 (overlay 自然
                // 渐渐让位给已经在串的 chat view)。
                worktreeCreationStore.clear(newSession.id);
              } catch (err) {
                log.error('[draft worktree send]', err);
                worktreeCreationStore.set(newSession.id, {
                  status: 'failed',
                  name: branchName,
                  error: err instanceof Error ? err.message : String(err),
                });
                restoreFirstMessageDraft();
              }
            })();

            return;
          }

          const newSession = await createSession({
            id: sessionId,
            agentKind: persistedAgentKind,
            model,
            effort,
            permissionMode,
            fastMode: effectiveFastMode,
            planModeEnabled: effectivePlanMode,
            workingDir: workingDir ?? undefined,
            // 没选项目目录 = 创建 standalone dialogue;main 端会按 workspaceKind='dialogue'
            // 自动分配 <userData>/dialogues/<date>/<sid>/ 作为运行目录,不进入项目段。
            workspaceKind: workingDir ? 'project' : 'dialogue',
            remoteHostId: workingDir ? (effectiveRemoteHostId ?? undefined) : undefined,
            // extraDirs 是 vendor 无关字段；Claude 与 Codex 都按只读引用目录透传。
            extraDirs: effectiveExtraDirs,
            providerId,
          });
          if (!newSession) {
            toast.error(t('ccAgent.draft.createSessionFailed'));
            return;
          }
          // 计划模式是一次性选择:随本次发送被消耗,草稿勾选同步熄灭。
          if (effectivePlanMode) patchActivePrefs({ planMode: false });
          // 首条消息经 setPending → SessionView 自动发送,createOpts 读 chat store 的
          // planModeEnabled —— ensureInitialMessages 的行水合是异步的,必须先确定性
          // seed store,否则勾了计划模式的首条消息可能以 planMode:false 发出
          // (worktree 路径同款 seed;bot review P2)。
          makerChatStore.setSessionRuntime(newSession.id, {
            agentKind: persistedAgentKind === 'codex' ? 'codex' : 'claude-code',
            fastMode: effectiveFastMode,
            planModeEnabled: effectivePlanMode,
          });

          // "创建即发送"路径:乐观回写 userSendAt 跳过 projectGrouping 的草稿兜底
          // (userSendAt==null && messages==0 → unclassified),否则新会话会先在
          // Projects 顶层闪一帧再跳到 workdir 分组下。真实 userSendAt 会通过
          // sendMessage 链路里的 emitPatch 再覆盖一次,值差几百 ms 无所谓。
          {
            const iso = new Date().toISOString();
            sessionsStore.patchLocal(newSession.id, { userSendAt: iso, updatedAt: iso });
          }

          // F-COLLAB: draft 阶段开了协同 toggle → createSession 之后立刻 enableOrca
          // 拉起 Worker。失败 toast 但保留 Lead session(用户可以继续单 session 聊),
          // 不阻断 send 流程。worker 类型由 popover 选择,失败回退到单 session 路由。
          let orcaNavTarget: string | null = null;
          let orcaWorkersRevealState: { focusWorkerSessionId: string } | null = null;
          if (shouldEnableCollab) {
            try {
              const result = await window.electronAPI.maker.enableOrca(
                newSession.id,
                draftEnableOrcaOptions(effectiveCollab, localProviders, !localProvidersLoading),
              );
              orcaNavTarget = `/cc-agent/${newSession.id}`;
              orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };
            } catch (err) {
              log.error('[draft send] enableOrca failed (continuing as single session)', err);
              toast.error(
                getCollaborationStartErrorMessage(err, t, { continueAsSingleSession: true }),
              );
            }
          }

          // 草稿态 base64 图片回填到新 session 的 image cache,换成 xdt-image://
          // URL。必须在 setPending 之前,否则 SessionView 拿到的还是 base64。
          const rehydratedFiles = await rehomeDraftAttachments(files, newSession.id);
          setPending(newSession.id, {
            text: message,
            files: rehydratedFiles,
            mentions,
            ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
            ...(opts?.agentReferences?.length ? { agentReferences: opts.agentReferences } : {}),
            ...(opts?.pastedTextRanges?.length ? { pastedTextRanges: opts.pastedTextRanges } : {}),
            ...(opts?.slashCommandRanges !== undefined
              ? { slashCommandRanges: opts.slashCommandRanges }
              : {}),
          });
          opts?.onAccepted?.();
          // 草稿已经成功移交给新会话(setPending),清掉 NEW_MAKER_DRAFT_KEY
          // 下的 store 条目,防止下次回到 /cc-agent/new 还看到本次刚发送的内容。
          // 用 clearDraftAndNotify:上面 onSend return false,ChatInput 没清自己的
          // 编辑器,这里必须通知它同步清空,否则 navigate 卸载时 ChatInput 的兜底
          // effect 会把残留文本又写回 NEW_MAKER_DRAFT_KEY,撤销这次 clear。
          clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
          // 同步清空 attachmentsRef,否则 navigate 触发 unmount 时
          // useAttachments 的 cleanup effect 会把旧附件重新写回 store。
          attachmentState.clearFiles();
          resetDraftWorkspaceAfterSend();
          // 让 SessionView 接管:它 mount 时 consumePending 自动发送首条。
          navigate(orcaNavTarget ?? `/cc-agent/${newSession.id}`, {
            replace: true,
            state: orcaWorkersRevealState
              ? { orcaWorkersReveal: orcaWorkersRevealState }
              : undefined,
          });
        } catch (err) {
          log.error('[draft send]', err);
          toast.error(
            getRemoteWorkingDirErrorMessage(err, t) ?? t('ccAgent.draft.createSessionFailed'),
          );
        } finally {
          setWtCreating(false);
          sendInFlightRef.current = false;
        }
      })();

      // 返回 false:ChatInput 不清空文本/附件,让异步路径自己决定;
      // navigate 触发后组件 unmount,文本/附件随之丢失(符合 transient 语义)。
      return false;
    },
    [
      effectiveWorkingDir,
      effectiveRemoteHostId,
      isRemoteProjectDraft,
      isDeviceLinkDraft,
      capabilitiesLoading,
      deviceProvidersLoading,
      effectiveDeviceLinkDeviceId,
      effectiveDeviceLinkDeviceName,
      effectiveExtraDirs,
      authVendor,
      persistedAgentKind,
      effectiveFastMode,
      // 计划模式一次性开关: handleSend 内读取 + 消耗(patchActivePrefs 清勾选),
      // 漏在依赖里会让"切换后立即发送"用到旧值(bot review P2)。
      effectivePlanMode,
      patchActivePrefs,
      effectiveCollab.enabled,
      collabPolicyEligible,
      collabPolicy.enabled,
      collabPolicy.loading,
      collabPolicy.refresh,
      collabPolicy.unavailable,
      effectiveCollab.worker,
      // workerConfig 也要进依赖:只改角色/模型/effort/初始任务(worker 类型不变)时,
      // 少了它 handleSend 会闭包吃旧的 effectiveCollab,起 Worker 用错配置(codex P2)。
      effectiveCollab.workerConfig,
      // draftEnableOrcaOptions 现按 live 目录收窄草稿来源:快照与 loading 都要进
      // 依赖,否则闭包吃旧快照,来源连/断后仍按陈旧目录收窄(codex review)。
      localProviders,
      localProvidersLoading,
      vendorAuthGate,
      createSession,
      navigate,
      crossAgentDialog.runMigrationFlow,
      attachmentState,
      refreshWorktrees,
      t,
    ],
  );

  // 首页「新建目标」:精简本地 create 路径(不含 worktree / 协同)→ maker.setGoal 启动目标 → 跳转。
  // 复用与 handleSend 同一套草稿派生值(vendor/model/effort/permission/workingDir/extraDirs/provider)。
  // device-link 远程草稿:与 handleSend 的远程分支同套积木 —— 被控端 maker:create-session 建会话
  // → 重拉列表注册 origin → maker:goal:set 启动目标(goal-host 在被控端自主续跑)→ 跳转。
  // 失败抛错 → NewGoalDialog 内联报错并保持打开。
  const handleCreateGoal = useCallback(
    async (objective: string, limits: GoalLimitValues): Promise<void> => {
      let policyEnabled = collabPolicy.enabled;
      if (effectiveCollab.enabled && collabPolicyEligible) {
        if (collabPolicy.loading) {
          throw new Error(t('newChat.collaboration.loadingHint'));
        }
        if (collabPolicy.unavailable) {
          const refreshed = await collabPolicy.refresh();
          if (refreshed.unavailable) {
            throw new Error(t('newChat.collaboration.unavailableHint'));
          }
          policyEnabled = refreshed.enabled;
        }
        if (!policyEnabled) {
          patchCollab({ enabled: false });
          throw new Error(t('newChat.collaboration.disabledHint'));
        }
      }
      const shouldEnableCollab =
        effectiveCollab.enabled && collabPolicyEligible && policyEnabled;
      if (isDeviceLinkDraft && (capabilitiesLoading || deviceProvidersLoading)) {
        throw new Error(t('ccAgent.draft.deviceStillLoading'));
      }
      const { proceed } = await vendorAuthGate.checkAndConfirm(authVendor, {
        deviceId: effectiveDeviceLinkDeviceId,
      });
      if (!proceed) return; // 用户取消授权:弹窗关闭即可,不算错误。
      if (isDeviceLinkDraft) {
        // partial state 防御:device-link 草稿按不变量必带 deviceId+workingDir;
        // 万一缺失,显式报错而不是静默落到「本地建会话 + 本地 setGoal」(目标会建错机器)。
        if (!effectiveDeviceLinkDeviceId || !effectiveWorkingDir) {
          throw new Error(t('ccAgent.draft.createSessionFailed'));
        }
        const deviceId = effectiveDeviceLinkDeviceId;
        const deviceName = effectiveDeviceLinkDeviceName ?? deviceId;
        const createResult = await window.electronAPI.deviceLink.invoke(
          deviceId,
          'maker:create-session',
          [
            buildDeviceLinkCreateArgs({
              agentKind: persistedAgentKind,
              workingDir: effectiveWorkingDir,
              model: draftInitialModel,
              effort: draftInitialEffort,
              permissionMode: chatInitialPermissionMode,
              fastMode: effectiveFastMode,
              extraDirs: effectiveExtraDirs,
              providerId: chatInitialProviderId ?? null,
            }),
          ],
        ).catch((err) => {
          const remoteWorkdirMessage = getRemoteWorkingDirErrorMessage(err, t);
          if (remoteWorkdirMessage) throw new Error(remoteWorkdirMessage);
          throw err;
        });
        const remoteSessionId = (createResult as { sessionId?: string } | null)?.sessionId;
        if (!remoteSessionId) {
          throw new Error(t('ccAgent.draft.createSessionFailed'));
        }
        // 重拉该设备会话列表 → 注册 origin(后续 goalApiFor / useGoalStatus 依赖它路由)。
        const list = await window.electronAPI.deviceLink.invoke(
          deviceId,
          'local-db:sessions:list',
          [200, 'active', { includePinned: true }],
        );
        if (Array.isArray(list)) {
          remoteProjectsStore.setDeviceSessions(deviceId, deviceName, list as Session[]);
        }
        // setGoal 不在这里发:重 topic session:<id> 订阅要等 CCAgentSessionView
        // mount 才建立,在 /cc-agent/new 就起 goal 首轮会让 maker:event/status 推送
        // 掉在订阅建立前的窗口里(Codex review #548)。与首条消息同款交接 ——
        // setPendingGoal → navigate → SessionView 消费时订阅已就绪再 setGoal。
        setPendingGoal(remoteSessionId, { objective, limits });
        // 自动起名:goal 首轮走 GoalController 的 session.send、不经 maker:input:enqueue,
        // 被控端 deviceLinkAutoTitle 不会触发(Codex review #548)—— 与本地分支的
        // autoNameSession 对位:先立即用目标文案截断占位(Codex 式,侧边栏不停留在
        // 'New Maker'),再经隧道生成智能标题窄口径覆盖。fire-and-forget;
        // 覆盖前 re-read,仅在标题仍是占位/默认时落盘(用户手动改名 wins)。
        const titleAgentKind = persistedAgentKind === 'codex' ? 'codex' : 'claude-code';
        // 先折叠空白并 trim 再截断,避免前导空白吃满 40 字符得到空占位(PR #296 review)。
        const placeholderTitle = objective.replace(/\s+/g, ' ').trim().slice(0, 40).trimEnd();
        void (async () => {
          try {
            // 无文本目标(理论不可达,goal 对话框必填)不起名:被控端旧版本的
            // maker:generate-title 没有空消息防线,LLM 会把"请提供内容"当标题。
            if (!placeholderTitle) return;
            // 覆写守卫:仅当远端标题仍是默认占位时才自动起名(user rename wins,
            // PR #296 review)。刚 create-session 建出的会话标题必为 'New Maker',
            // 此检查防御极端 race;读取失败时按默认占位继续,不中断起名。
            try {
              const preCheck = (await window.electronAPI.deviceLink.invoke(
                deviceId,
                'local-db:sessions:get',
                [remoteSessionId],
              )) as { title?: string | null } | null;
              const preTitle = preCheck?.title?.trim();
              if (preTitle && preTitle !== 'New Maker') return;
            } catch {
              // 读不到当前标题时按"仍是默认占位"继续。
            }
            // 占位写入失败(旧被控端无此窄口径 / 瞬时通道错误)单独吞掉,不中断
            // 后续智能起名——生成与写回不依赖占位成功(PR #296 review P1)。
            try {
              await window.electronAPI.deviceLink.invoke(
                deviceId,
                'local-db:sessions:patch-meta',
                [remoteSessionId, { title: placeholderTitle }],
              );
            } catch {
              // 占位失败仅暂留默认名,智能标题仍会尝试生成并写回。
            }
            const gen = (await window.electronAPI.deviceLink.invoke(
              deviceId,
              'maker:generate-title',
              [{ message: objective, agentKind: titleAgentKind, sessionId: remoteSessionId }],
            )) as { title: string | null } | null;
            const title = gen?.title?.trim();
            // 智能标题与占位相同也照走写回:占位写入允许失败(上方 catch),
            // 此时远端仍是 'New Maker',跳过会让标题永久停在默认名(PR #296
            // review P1);占位已成功时重写同值幂等无害。
            if (!title) return;
            const current = (await window.electronAPI.deviceLink.invoke(
              deviceId,
              'local-db:sessions:get',
              [remoteSessionId],
            )) as { title?: string | null } | null;
            const existingTitle = current?.title?.trim();
            // 占位标题与 'New Maker'(maker:create-session 的默认占位符)都允许覆写;
            // 用户已手动改过的真实标题则保留(user rename wins)。
            if (
              existingTitle &&
              existingTitle !== 'New Maker' &&
              existingTitle !== placeholderTitle
            ) {
              return;
            }
            await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:patch-meta', [
              remoteSessionId,
              { title },
            ]);
          } catch {
            // 起名失败不影响目标流程,侧边栏保留占位/默认名。
          }
        })();
        clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
        resetDraftWorkspaceAfterSend();
        navigate(`/cc-agent/${remoteSessionId}`, { replace: true });
        return;
      }
      const selectedWorkingDir = effectiveWorkingDir?.trim() || undefined;
      const newSession = await createSession({
        id: makeDraftSessionId(),
        agentKind: persistedAgentKind,
        model: draftInitialModel,
        effort: draftInitialEffort,
        permissionMode: chatInitialPermissionMode,
        fastMode: effectiveFastMode,
        workingDir: selectedWorkingDir,
        workspaceKind: selectedWorkingDir ? 'project' : 'dialogue',
        remoteHostId: selectedWorkingDir ? (effectiveRemoteHostId ?? undefined) : undefined,
        extraDirs: effectiveExtraDirs,
        providerId: chatInitialProviderId ?? null,
      });
      if (!newSession) {
        throw new Error(t('ccAgent.draft.createSessionFailed'));
      }
      {
        const iso = new Date().toISOString();
        sessionsStore.patchLocal(newSession.id, { userSendAt: iso, updatedAt: iso });
      }
      // 草稿开了协同 → 新建目标路径也要拉起 Worker(与 Send 路径同口径);否则用户开了协同
      // 却走「新建目标」会得到一个没有 Worker 的 lead session(codex P2)。失败 toast + 降级
      // 单会话,不阻断目标创建。仅本地项目 draft 可达(device-link 分支上面已 return)。
      // reveal 不在此处直接 dispatch:当前路由还在 /cc-agent/new,分离侧栏控制器会因
      // session 不匹配返回 stale-context(codex P2)——与 Send 路径同口径,把 reveal
      // 塞进 navigate state,由 CCAgentSessionView mount 后消费。
      let orcaWorkersRevealState: { focusWorkerSessionId: string } | null = null;
      if (shouldEnableCollab) {
        try {
          const result = await window.electronAPI.maker.enableOrca(
            newSession.id,
            draftEnableOrcaOptions(effectiveCollab, localProviders, !localProvidersLoading),
          );
          orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };
        } catch (err) {
          log.error('[draft goal] enableOrca failed (continuing as single session)', err);
          toast.error(getCollaborationStartErrorMessage(err, t, { continueAsSingleSession: true }));
        }
      }
      // setGoal 内部 ensureSession(拉起 agent)+ 发首轮(带目标指令)。
      await window.electronAPI.maker.setGoal({ sessionId: newSession.id, objective, limits });
      // 自动起名:/goal 新建的会话不经普通发送路径,scheduleAutoName 漏触发 → 标题会停在默认。
      // 这里用目标文案补一次,与普通会话同款(立即占位 + 智能标题后台覆盖 + 不覆盖手动改名)。
      makerChatStore.autoNameSession(newSession.id, objective, capabilityAgentKind);
      clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
      resetDraftWorkspaceAfterSend();
      navigate(`/cc-agent/${newSession.id}`, {
        replace: true,
        state: orcaWorkersRevealState
          ? { orcaWorkersReveal: orcaWorkersRevealState }
          : undefined,
      });
    },
    [
      isDeviceLinkDraft,
      capabilitiesLoading,
      deviceProvidersLoading,
      vendorAuthGate,
      authVendor,
      effectiveDeviceLinkDeviceId,
      effectiveDeviceLinkDeviceName,
      effectiveWorkingDir,
      createSession,
      persistedAgentKind,
      draftInitialModel,
      draftInitialEffort,
      chatInitialPermissionMode,
      effectiveFastMode,
      effectiveRemoteHostId,
      effectiveExtraDirs,
      chatInitialProviderId,
      effectiveCollab,
      collabPolicyEligible,
      collabPolicy.loading,
      collabPolicy.refresh,
      collabPolicy.unavailable,
      collabPolicy.enabled,
      // 同 handleSend:草稿来源收窄依赖 live 目录快照。
      localProviders,
      localProvidersLoading,
      patchCollab,
      navigate,
      t,
    ],
  );

  const handleBeforeVoiceInputStart = useCallback(async () => {
    const { proceed } = await vendorAuthGate.checkAndConfirm('codex', { purpose: 'voice-input' });
    return proceed;
  }, [vendorAuthGate]);

  const handleQuickStart = useCallback(
    (labelKey: (typeof createAgentQuickStarts)[number]['labelKey']) => {
      const text = t(labelKey);
      const currentDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY);
      saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
        text: plainTextToTiptapDoc(text),
        attachments: currentDraft?.attachments ?? attachmentState.attachments,
        quotes: currentDraft?.quotes,
        browserComments: currentDraft?.browserComments,
      });
    },
    [attachmentState.attachments, t],
  );

  // 注意:不要给 ChatInput 加 key 强制 remount。ChatInput 内部 activeModel /
  // activeEffort / activePermissionMode 都是每次 render 直接从 props 派生
  // (见 ChatInput.tsx 第 459 行注释 "derive directly from props every render"),
  // initial* 改了就自动生效,无需重建。强行 remount 会导致 Tiptap editor 重建、
  // contenteditable 卸载-重挂载,带来焦点闪烁。

  return (
    <TopRightChipStackProvider>
      <div
        ref={containerRef}
        className="h-full w-full"
        // 整页 drop(与 CCAgentSessionView 的聊天区同语义):拖到草稿页任意位置
        // 都算数,不必精准落在输入框上。dragover 必须自己 preventDefault——
        // 链接型拖拽(意识媒体是 text/uri-list)不阻止默认行为时光标是"禁止
        // 落下"、drop 压根不触发,不能指望窗口级兜底的时序。消费规则:
        // - 意识面板媒体(cindy-ghost:// 地址)→ 引渡链路,键用 NEW_MAKER_DRAFT_KEY
        //   (草稿命名空间,发送时 rehomeDraftAttachments 迁移进真实会话);
        // - 普通文件 → 落附件托盘;
        // - 纯文件夹**不消费**,留给窗口级兜底(拖文件夹 = 设为工作目录的既有行为)。
        // ChatInput 自己的 onDrop 有 stopPropagation,落在输入框上不会到这里。
        onDragEnter={(e) => {
          e.preventDefault();
          pageDragCounterRef.current += 1;
          if (pageDragCounterRef.current === 1) setPageDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (pageDragCounterRef.current > 0) pageDragCounterRef.current -= 1;
          if (pageDragCounterRef.current === 0) setPageDragOver(false);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          pageDragCounterRef.current = 0;
          setPageDragOver(false);
          // .cindy / .cshare 已被窗口级 capture 接管(装入 / 导入链路),不当附件消费。
          if (isGlobalDropIntercepted(e.nativeEvent)) return;
          const ghostMediaUri = getGhostMediaUriFromDataTransfer(e.dataTransfer);
          if (ghostMediaUri) {
            e.preventDefault();
            e.stopPropagation();
            void attachGhostMediaToSession(ghostMediaUri, NEW_MAKER_DRAFT_KEY, t);
            return;
          }
          const droppedItems = getDroppedFileItems(e.dataTransfer);
          if (droppedItems.files.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            attachmentState.addFiles(droppedItems.files);
          }
          if (droppedItems.unclassified.length > 0) {
            // Do not synchronously consume item-less entries: a single
            // directory must keep bubbling to GlobalDropImportListener so it
            // can become the new session's working directory.
            void classifyUnclassifiedDroppedItems(droppedItems.unclassified, {
              getFilePath: (file) => window.electronAPI.getFilePath(file),
              classifyPath: (path) =>
                window.electronAPI.localDb.sessionShare.classifyPath({ path }),
            }).then(({ files }) => {
              if (files.length > 0) attachmentState.addFiles(files);
            });
          }
        }}
      >
        <div
          data-testid="create-agent-shell"
          className={cn(
            'relative flex h-full w-full items-center justify-center overflow-hidden bg-[var(--surface)] px-3 py-8', // px-3:外壳12+main32=44,与技能页(32+12滚动条槽)对齐(实测定稿 2026-07-19)
          )}
        >
          {/* 整页拖入遮罩(与 CCAgentSessionView 聊天区同款 token):提示文案由
            ChatInput 卡内渲染(externalDragOver),遮罩只描边界。 */}
          {pageDragOver && (
            <div
              className="pointer-events-none absolute inset-0 z-50"
              style={{
                backgroundColor: 'var(--drop-overlay-bg)',
                border: '2px dashed var(--drop-overlay-border)',
              }}
            />
          )}
          {/* mac 上本页不渲染通用 ContentHeader 且顶部无交互元素,垫一条透明
          窗口拖拽条(windowDrag.tsx 约定) */}
          <InvisibleWindowDragStrip />
          {/* Windows 折叠态显示展开入口,面板贴右在右上、贴左镜像左上,
            与 CCAgentSessionView 同规则。展开态的折叠按钮归属右栏 TabBar。
            mac 不渲染(2026-07-09 Lizi 口径):
            折叠 toggle 无论面板贴哪侧都恒钉窗口右上角(MainLayout 浮层)。 */}
          {!IS_MAC_PLATFORM &&
            rightSidebarCollapsed &&
            draftRightSidebar.available &&
            onToggleRightSidebar &&
            (rightSidebarSide === 'right' ? (
              <TopRightChipStack>
                <div style={DRAFT_RIGHT_SIDEBAR_TOGGLE_DRAG_STYLE}>
                  <RightSidebarToggle
                    collapsed={rightSidebarCollapsed}
                    onToggle={onToggleRightSidebar}
                    side="right"
                  />
                </div>
              </TopRightChipStack>
            ) : (
              <div className="pointer-events-none absolute left-3 top-3 z-20">
                <div style={DRAFT_RIGHT_SIDEBAR_TOGGLE_DRAG_STYLE}>
                  <RightSidebarToggle
                    collapsed={rightSidebarCollapsed}
                    onToggle={onToggleRightSidebar}
                    side="left"
                  />
                </div>
              </div>
            ))}
          <main
            data-testid="create-agent-main"
            className={cn(
              'relative flex h-full min-w-0 w-full flex-col items-center justify-start',
              // 引导卡比快速开始高一截:收紧顶部留白并允许纵向滚动,否则外壳
              // overflow-hidden 会把卡片下半截裁在视口外(2026-07-24 用户实测)。
              showProviderOnboardingCard && 'overflow-y-auto pb-8',
              isDraftNarrow
                ? 'px-4 pt-[calc(max(64px,18vh)_+_32px_-_var(--content-header-h,46px))]'
                : showProviderOnboardingCard
                  ? 'px-8 pt-[calc(max(56px,10vh)_+_46px_-_var(--content-header-h,46px))]'
                  : 'px-8 pt-[calc(max(96px,28vh)_+_46px_-_var(--content-header-h,46px))]',
            )}
          >
            <div
              className="relative flex w-full flex-col items-start"
              // 与进行中对话页同源:内容列宽度跟随 useProportionalWidth 算出的
              // inputWidth(封顶 914+20=934px,见 hook 首参),不再死锁 800——大屏留出
              // 左右呼吸空间、窄屏自适应收窄,且发送后同一个 ChatInput 无宽度跳变。
              // inputWidth 由 useLayoutEffect 同步量出
              // (paint 前已就绪);极端未量到(0)时回落旧默认 800,不放大到全宽。
              style={{ maxWidth: inputWidth || 800 }}
            >
              {/* mode pill + worktree 高级入口同排(齿轮在 pill 右侧,对齐旧 F1-E 布局)。
                  2026-07-19 修复:488cb33 对齐 Figma 重排时把 WorktreeChipsRow 注入删丢,
                  branch/worktree 入口消失(wt* 状态与 send 管线一直健在),以 advancedOnly
                  变体接回。 */}
              <div
                className={cn(
                  'inline-flex items-center gap-2',
                  isDraftNarrow
                    ? 'static order-2 mb-3 w-full flex-wrap justify-start'
                    : 'absolute right-0 top-[22px] z-10',
                )}
              >
                <FolderPickerPopover
                  open={folderPickerOpen}
                  onOpenChange={handleFolderPickerOpenChange}
                  onSelect={handleModePickerSelect}
                  projectOptions={projectPickerOptions}
                  // 仅在有可用远程目标时暴露「添加远程项目」入口(SSH ready 主机 / device-link 可控设备)。
                  onAddRemoteProject={hasAnyRemoteTarget ? () => setAddRemoteProjectOpen(true) : undefined}
                  side="bottom"
                  align="end"
                  sideOffset={6}
                >
                  <button
                    type="button"
                    data-testid="create-agent-mode-pill"
                    className="inline-flex h-[30px] min-w-20 max-w-[220px] items-center justify-center gap-1.5 rounded-full border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] px-3 text-[12px] font-medium leading-[14px] text-[var(--create-agent-control-text)] transition-colors hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]"
                    aria-label={t('newChat.collaboration.modeLabel')}
                  >
                    <MessageSquare
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--create-agent-control-icon)]"
                    />
                    <span className="min-w-0 truncate">
                      {createAgentModeLabel}
                    </span>
                    <ChevronDown
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--create-agent-control-icon)]"
                    />
                  </button>
                </FolderPickerPopover>
                <WorktreeChipsRow
                  variant="advancedOnly"
                  compact
                  cwd={effectiveWorkingDir ?? null}
                  folderPickerMode="project"
                  projectOptions={projectPickerOptions}
                  enabled={wtEnabled}
                  onEnabledChange={handleWtEnabledChange}
                  sourceBranch={wtSourceBranch}
                  onSourceBranchChange={handleWtSourceBranchChange}
                  onBaseRepoChange={handleWtBaseRepoChange}
                  onSuggestedNameChange={handleWtNameChange}
                  // SSH 远程仍禁用 worktree(远端 git 探测未落地);device-link 远程可用:
                  // 探测/建议名/创建全部经隧道在被控端执行(与 488cb33 前口径一致)。
                  worktreeDisabled={isRemoteProjectDraft}
                  deviceLinkDeviceId={effectiveDeviceLinkDeviceId ?? null}
                  disabled={wtCreating}
                />
              </div>
              <ThemeBrandLockup
                theme={activeColorTheme}
                testId="create-agent-brand-lockup"
                className={cn('mb-[15px]', isDraftNarrow && 'order-1')}
              />

              <div className={cn('flex w-full flex-col items-start gap-0', isDraftNarrow && 'order-3')}>
                <div className="w-full">
                  <ChatInput
                    onSend={handleSend}
                    onBeforeVoiceInputStart={handleBeforeVoiceInputStart}
                    externalDragOver={pageDragOver}
                    visualVariant="create-agent"
                    compactToolbar
                    // denseToolbar 去除(2026-07-22):hero 输入框够宽,协同 toggle 应显示「协同」文字
                    // 与会话内主视图一致;窄窗口仍由 autoDenseToolbar 自动收成 icon-only。
                    placeholder="Hi Cindy!"
                    sessionId={undefined}
                    initialWorkingDir={effectiveWorkingDir}
                    remoteHostId={draft.remoteHostId ?? null}
                    deviceLinkDeviceId={effectiveDeviceLinkDeviceId}
                    modelMemoryOverride={deviceLinkDraftMemory}
                    initialModel={draftInitialModel}
                    initialEffort={draftInitialEffort}
                    initialPermissionMode={chatInitialPermissionMode}
                    initialProviderId={chatInitialProviderId}
                    planModeEnabled={effectivePlanMode}
                    onPlanModeChange={isDeviceLinkDraft ? undefined : handlePlanModeChange}
                    fastMode={effectiveFastMode}
                    onFastModeChange={handleFastModeChange}
                    onWorkingDirChange={handleWorkingDirChange}
                    onModelDidChange={handleModelDidChange}
                    onEffortDidChange={handleEffortDidChange}
                    onPermissionModeDidChange={handlePermissionModeDidChange}
                    onProviderDidChange={handleProviderDidChange}
                    vendorKey={draft.vendor === 'codex' ? 'codex' : 'cc'}
                    folderPickerOpen={folderPickerOpen}
                    onFolderPickerOpenChange={handleFolderPickerOpenChange}
                    showFolderPicker={false}
                    middleToolbarSlot={
                      <VendorSegmentedSwitcher
                        value={draft.vendor}
                        onChange={handleVendorChange}
                        width={150}
                        dense
                        visualVariant="create-agent"
                        className="shrink-0"
                        disabled={wtCreating}
                      />
                    }
                    // 协同 toggle(与对话界面同一控件):仅本地项目 draft 可用 —— 对话模式(无
                    // workingDir)/ 远程 SSH / device-link 均不支持起 worker(state 层 normalize
                    // + patchDraft 已强制 collab.enabled=false,这里同口径 gate 渲染)。Lead = 当前
                    // vendor(上方 VendorSegmentedSwitcher)。onOpenDetails 打开「开启协同」富弹窗
                    // (CreateWorkerPopover:role/agent/model/初始任务),与会话内完全一致;OFF 态点击
                    // 走它而非简单 worker popover。ON 态点击 onChange(enabled:false) 关闭协同。
                    // createSession 后按本次策略校验结果用 workerConfig 拉起 Worker。
                    collaboration={
                      collabPolicyEligible
                        ? {
                            enabled: effectiveCollab.enabled,
                            worker: effectiveCollab.worker,
                            onChange: (next) => patchCollab(next),
                            onOpenDetails: () => setCreateWorkerOpen(true),
                            onDisabledActivate: collabPolicy.unavailable
                              ? () => {
                                  void collabPolicy.refresh().then((policy) => {
                                    if (policy.enabled && !policy.unavailable) {
                                      setCreateWorkerOpen(true);
                                    }
                                  });
                                }
                              : undefined,
                            disabled:
                              !effectiveCollab.enabled &&
                              (collabPolicy.loading ||
                                collabPolicy.unavailable ||
                                !collabPolicy.enabled),
                            disabledReason:
                              collabPolicy.loading
                                ? t('newChat.collaboration.loadingHint')
                                : collabPolicy.unavailable
                                  ? t('newChat.collaboration.unavailableHint')
                                  : !collabPolicy.enabled
                                    ? t('newChat.collaboration.disabledHint')
                                    : undefined,
                          }
                        : undefined
                    }
                    compactMiddleToolbarSlot={
                      <VendorSegmentedSwitcher
                        value={draft.vendor}
                        onChange={handleVendorChange}
                        width={72}
                        dense
                        iconOnly
                        visualVariant="create-agent"
                        className="shrink-0"
                        disabled={wtCreating}
                      />
                    }
                    narrowToolbar={isDraftToolbarNarrow}
                    paletteMaxHeight={240}
                    attachmentState={attachmentState}
                    draftKey={NEW_MAKER_DRAFT_KEY}
                    focusOnStorageKeyChange
                    // 「+」始终显示(与对话界面一致):无项目裸态也可加引用目录,作为本次对话的上下文。
                    // createSession 各路径都会带上 extraDirs;workingDir=null 时 ExtraDirsButton 跳过重叠校验。
                    extraDirs={effectiveExtraDirs}
                    onExtraDirsChange={handleExtraDirsChange}
                    // 首页「新建目标」入口:草稿态没有 sessionId,由本组件 createSession→setGoal。
                    // ChatInput 把输入框当前文字传上来作默认目标内容。
                    onNewGoal={(text) => {
                      setNewGoalInitialObjective(text);
                      setNewGoalOpen(true);
                    }}
                    rememberedEffortByModel={isDeviceLinkDraft ? undefined : draft.effortByModel}
                    onRememberedEffortChange={
                      isDeviceLinkDraft ? undefined : handleRememberedEffortChange
                    }
                  />
                </div>
                {/* device-link:为远程设备项目新建对话时的明显标识。让用户清楚这条对话会建在
                    被控设备上、属于那台机器的项目,而不是本机。放输入框正下方并与其水平居中
                    (父列 items-start,靠 self-center 相对 w-full 的输入框居中)。 */}
                {isDeviceLinkDraft && (
                  <div className="mt-3 flex max-w-full items-center gap-2 self-center rounded-full border border-[var(--border-default)] bg-[var(--surface-chip)] px-3 py-1 text-[12px] text-[var(--text-secondary)]">
                    <MonitorSmartphone
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--folder-item-icon)]"
                    />
                    <span className="min-w-0 truncate">
                      {t('ccAgent.draft.remoteProjectBanner', {
                        device: effectiveDeviceLinkDeviceName ?? effectiveDeviceLinkDeviceId ?? '',
                        project:
                          effectiveWorkingDir?.split(/[\\/]/).filter(Boolean).pop() ??
                          effectiveWorkingDir ??
                          '',
                      })}
                    </span>
                  </div>
                )}
                {/* 零可用模型 → 快速开始换成「连接供应商」引导卡(互斥:此时快捷入口
                    只会把 prompt 填进发不出去的输入框;device-link 草稿由上方 chip 负责,
                    引导卡自身有 !isDeviceLinkDraft gate)。dismiss / 连上后恢复快捷入口。 */}
                {showProviderOnboardingCard && (
                  <div className="mt-8 w-full" style={{ maxWidth: 800 }}>
                    <ConnectProviderCard />
                  </div>
                )}
                {/* 快捷入口与输入框同宽:左右两缘都与上方 ChatInput 对齐(父列已封顶
                    inputWidth)。此前封顶 800px 会在宽窗口下右缘短一截,视觉上没对齐
                    (2026-07-24 用户反馈)。 */}
                {!showProviderOnboardingCard && (
                  <div data-testid="create-agent-quick-starts" className="mt-[42px] w-full">
                    {/* 标题字号 12→14px(DESIGN §3 Caption),与卡片间距 16→10px 收近
                        (DESIGN §5 间距档)——用户改稿 2026-07-22。 */}
                    <div className="mb-2.5 px-0.5">
                      <div className="text-[14px] font-medium leading-[18px] text-[var(--text-secondary)]">
                        {t('newChat.createAgent.quickStart')}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'grid w-full gap-3',
                        isDraftNarrow ? 'grid-cols-1' : isDraftMedium ? 'grid-cols-2' : 'grid-cols-4',
                      )}
                    >
                      {createAgentQuickStarts.map(({ key, labelKey, icon: Icon }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => handleQuickStart(labelKey)}
                          // 圆角与输入框统一为 12px(DESIGN §5 容器档,rounded-xl)。
                          // 用户改稿 2026-07-25:两档统一竖排——icon 固定卡片左上(距顶/
                          // 距左均等于 p-3/p-4 内边距),文字挪到卡片中下方、与 icon 左对齐
                          // (flex-col + justify-between,icon 顶、文字底;gap-1 兜底竖向
                          // 最小间距),取代原窄态横排 / 常态竖排自适应(#562)。
                          // 卡片高度不变(narrow 84 / 常态 112)。
                          className={cn(
                            'group flex flex-col items-start justify-between gap-1 rounded-xl border border-[var(--create-agent-quick-card-border)] bg-[var(--create-agent-quick-card-bg)] text-left text-[var(--create-agent-quick-card-text)] transition-colors hover:bg-[var(--create-agent-quick-card-bg-hover)]',
                            isDraftNarrow ? 'min-h-[84px] p-3' : 'min-h-[112px] p-4',
                          )}
                        >
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--create-agent-quick-card-icon-bg)]">
                            <Icon
                              size={16}
                              strokeWidth={2}
                              className="text-[var(--create-agent-quick-card-icon)]"
                            />
                          </span>
                          {/* 字号 13px 与左侧会话列表(text-13)一致——用户改稿 2026-07-22。
                              竖排下占满卡片宽度、左对齐 icon,靠父列 justify-between 贴底。 */}
                          <span className="w-full min-w-0 text-13 font-semibold leading-[16px]">
                            {t(labelKey)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 首页「新建目标」弹窗:无 sessionId → onCreate 建会话并 setGoal(见 handleCreateGoal)。
                initialObjective = 点「新建目标」时输入框里已有的文字。 */}
                <NewGoalDialog
                  open={newGoalOpen}
                  onOpenChange={setNewGoalOpen}
                  onCreate={handleCreateGoal}
                  initialObjective={newGoalInitialObjective}
                />
              </div>
            </div>
          </main>
        </div>

        {/* 跨 Agent 工作区互转 (5 项独立判断 + 步骤式进度) —— send 流程会 await 等它关闭 */}
        <CrossAgentConvertDialog
          open={crossAgentDialog.open}
          phase={crossAgentDialog.phase}
          items={crossAgentDialog.items}
          stepMap={crossAgentDialog.stepMap}
          onOpenChange={crossAgentDialog.onOpenChange}
          onConfirm={crossAgentDialog.onConfirm}
          onCancel={crossAgentDialog.onCancel}
        />

        {/* 「开启协同」富弹窗:与会话内 CCAgentSessionView 同一组件/标题。草稿态没有 sessionId,
            不立刻 enableOrca —— onCreate 把 Worker 富配置写进 draft.collab,createSession 后由
            draftEnableOrcaOptions 透传给 enableOrca(见本文件 F-COLLAB 段)。deviceId 省略(协同仅本地)。 */}
        <CreateWorkerPopover
          open={createWorkerOpen}
          onClose={() => setCreateWorkerOpen(false)}
          onCreate={(form: CreateWorkerForm) => {
            patchCollab({
              enabled: true,
              worker: form.agent === 'codex' ? 'codex' : 'cc',
              workerConfig: {
                role: form.role,
                model: form.model,
                effort: form.effort,
                fast: form.fast,
                providerId: form.providerId,
                initialTask: form.initialTask || undefined,
              },
            });
            setCreateWorkerOpen(false);
          }}
          title={t('orca.createWorker.enableCollabTitle')}
          submitLabel={t('orca.createWorker.enableCollabSubmit')}
        />

        {/* 添加远程项目弹窗 (入口在 mode pill 的 FolderPickerPopover 里, gate 走 hasAnyRemoteTarget =
            SSH ready 主机 或 device-link 可控设备)。onProjectAdded 带 kind:SSH 立即建会话 + navigate;
            device-link 把当前草稿指向被控设备项目,发首条消息时 create-on-send。 */}
        <AddRemoteProjectDialog
          open={addRemoteProjectOpen}
          onOpenChange={setAddRemoteProjectOpen}
          onProjectAdded={handleRemoteProjectAdded}
        />
      </div>
    </TopRightChipStackProvider>
  );
}
