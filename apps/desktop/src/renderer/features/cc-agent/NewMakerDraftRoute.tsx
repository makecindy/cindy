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
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { themeService } from '@/themes/theme-service';
import type { Theme as ColorTheme } from '@/themes/types';
import { ThemeBrandLockup } from '@/components/branding/ThemeBrandLockup';
import { ChatInput } from '@/components/new-chat/ChatInput';
import { WorktreeChipsRow } from '@/components/new-chat/WorktreeChipsRow';
import {
  FolderPickerPopover,
  type FolderPickerDeviceScope,
  type FolderPickerSelectSource,
} from '@/components/new-chat/FolderPickerPopover';
import { DeviceSwitcherPill } from '@/components/new-chat/DeviceSwitcherPill';
import {
  AddRemoteProjectDialog,
  type RemoteProjectTarget,
} from '@/components/new-chat/AddRemoteProjectDialog';
import { useHasAnyRemoteTarget } from '@/hooks/useHasAnyReadyRemoteHost';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { useProviderOnboarding } from '@/hooks/useProviderOnboarding';
import { ConnectProviderCard } from '@/components/onboarding/ConnectProviderCard';
import { InheritedSubscriptionNotice } from '@/components/onboarding/InheritedSubscriptionNotice';
import { PromotionalGrantNotice } from '@/components/onboarding/PromotionalGrantNotice';
import { resolveDeviceLinkSubmission } from './deviceLinkCreateArgs';
import { commitRemoteSessionHandoff } from './remoteSessionHandoff';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  dbToMakerAgentKind,
  normalizeDbAgentKind,
  type MakerAgentKindWire,
} from '../../../shared/agentKindConversion';
import { getBranchName } from '../../../shared/managedWorktreeBranches';
import { AgentSelect } from '@/components/new-chat/AgentSelect';
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
  patchVendorPrefs,
  resetDraftWorkspaceTargets,
  getFastModeForModel,
  setFastModeForModel,
  setEffortForModel,
  setWorktreePreference,
  type VendorPrefs,
  type CollabDraft,
} from '@/state/newMakerDraft';
import {
  setDraftFavoriteAnchor,
  setSessionFavoriteAnchor,
  useDraftFavoriteAnchor,
  type DraftFavoriteAnchor,
} from '@/state/favoriteAnchorMemory';
import {
  getProviderModelEffort,
  getProviderModelFast,
  setProviderModelFast,
  useProviderModelMemoryVersion,
} from '@/state/providerModelMemory';
import { useModelPickerLayout } from '@/state/modelPickerLayout';
import {
  rememberRecoverableHandoff,
  setPending,
  setPendingGoal,
} from '@/state/pendingFirstMessage';
import {
  clearDraftAndNotify as clearComposerDraftAndNotify,
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  quickStartTextToTiptapDoc,
  saveDraft as saveComposerDraft,
} from '@/lib/composerDraftStore';
import type { JSONContent } from '@tiptap/core';
import { base64ToUint8Array } from '@/lib/fileTypeInference';
import {
  calibrateDraftModel,
  resolveDraftSessionProviderId,
  type DraftModelCalibrationResult,
} from '@/lib/draftModelCalibration';
import { showWorktreeError } from '@/lib/worktreeToast';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';
import { emitAutoTitlePreview, emitAutoTitlePreviewCleared } from '@/lib/sessionsBus';
import { NewGoalDialog } from '@/components/new-chat/NewGoalDialog';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';
import type { GoalLimitValues } from '@/components/new-chat/GoalAdvancedLimits';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  rebaseInlineRangesAfterSlashCommandRewrite,
  rewritePiSkillMessageForSend,
} from '@/lib/slashCommands';
import { worktreeCreationStore } from '@/lib/worktreeCreationStore';
import { useRefreshWorktrees } from '@/contexts/WorktreeContext';
import { crossAgentConvertService } from '@/lib/crossAgentConvertService';
import {
  consumeNewMakerDialogueTargetRequest,
  consumeNewMakerFolderPickerRequest,
  readNewMakerDialogueTargetRequest,
  readNewMakerFolderPickerRequest,
} from './lib/newMakerRouteState';
import { useCrossAgentMigrationDialog } from '@/hooks/useCrossAgentConvertPrompt';
import { getCollaborationStartErrorMessage } from './collaborationErrors';
import { resolveCollabEntryPolicy } from './collabEntryPolicy';
import { useCollabProjectPolicy } from './hooks/useCollabProjectPolicy';
import {
  createDeferredUiAssignment,
  dispatchDeferredUiAssignment,
  rememberDeferredUiAssignment,
  type DeferredUiAssignment,
} from './deferredUiAssignment';
import { CrossAgentConvertDialog } from '@/components/ui/cross-agent-convert-dialog';
import type { MakerVendor } from '@/lib/ccAgent.types';
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
import {
  categorizeByFilename,
  categorizeFile,
  extractExt,
  type AttachedFile,
  type MentionedResource,
} from '@/lib/fileTypes';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';
import {
  DEFAULT_DRAFT_SESSION_TITLE,
  deriveOptimisticSessionTitle,
  normalizeAutoTitle,
} from '@cindy/maker-shared/session-title';
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
import {
  createRemoteSessionWithPrecreatedWorktree,
  forgetPendingRemotePrecreatedWorktree,
  isRemotePrecreatedWorktreeCleanupPendingError,
  isRemotePrecreatedWorktreeOwnerChangedError,
  parseRemoteWorktreeCreateResult,
  registerPendingRemotePrecreatedWorktree,
  recoverPendingRemotePrecreatedWorktrees,
  RemotePrecreatedWorktreeCleanupPendingError,
  RemotePrecreatedWorktreeOwnerChangedError,
  type RemoteWorktreeCreateRequest,
} from './remotePrecreatedWorktree';
import {
  isLocalGoalWorktreeCleanupPendingError,
  prepareLocalGoalWorktree,
} from './localGoalWorktree';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import { extractIpcError } from '@/utils/ipcError';
import { matchNavigationCommandName, tryHandleNavigationCommand } from '@/lib/navigationCommands';
import {
  useAgentCapabilities,
  evictDeviceCapabilities,
  prefetchDeviceCapabilities,
  type AgentCapabilities,
} from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import {
  useDeviceProviders,
  evictDeviceProviders,
  prefetchDeviceProviders,
} from '@/hooks/useDeviceProviders';
import {
  evictDeviceGitSafetySettings,
  prefetchDeviceGitSafetySettings,
} from '@/hooks/useGitSafetySettings';
import {
  getProjectPickerDisplayName,
  useProjectPickerOptions,
} from '@/hooks/useProjectPickerOptions';
import { useDeviceLinkProjects } from '@/hooks/useDeviceLinkProjects';
import {
  resolveFastSupported,
  deriveModelsFromProviders,
  filterChatBridgedCodexProviders,
} from '@/lib/providerModels';
import {
  effectiveSourceIdForModel,
  getModel,
  isModelSelectableForNewRoute,
  providerOffersModel,
  sessionModelSupportsFastMode,
  connectedProvidersForAgent,
  type ProviderView,
} from '@cindy/model-providers';
import { isSubscriptionDirectModel } from '../../../shared/subscriptionModels';
import {
  resolveDeviceLinkDraftDefaults,
  shouldReseedDeviceLinkDraftDefaults,
  type DeviceLinkDraftSelection,
  type RemoteDraftDefaults,
} from './deviceLinkDraftDefaults';
import { makeMirrorAccessors, replaceScope, clearScope } from '@/state/deviceLinkModelMirror';
import type { ModelMemoryAccessors } from '@/components/new-chat/ModelSelector';
import { resolveNewMakerDraftRightSidebar } from './newMakerDraftRightSidebar';
import { resolveNewMakerDraftEffort } from './newMakerDraftModelPrefs';
import { closeAllTabs as closeRightSidebarTabs } from '@/features/right-sidebar/store';
import { revealOrcaWorkersTab } from '@/features/right-sidebar/plugins/orca-workers/actions';
import { normalizeProjectKey } from './lib/projectGrouping';
import { requestSidebarProjectRestore } from './lib/sidebarProjectRestore';

const log = createLogger('NewMakerDraftRoute');
const IS_MAC_PLATFORM = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

interface DraftWorktreeBranchTarget {
  /** null = 当前电脑；string = device-link 被控工作端。 */
  deviceId: string | null;
  baseRepo: string | null;
}

interface DraftWorktreeBranchSync {
  deviceId: string | null;
  baseRepo: string;
  /** 工作端为该 canonical repo 维护的单调递增 revision；-1 表示 GET 未命中/不可用。 */
  revision: number;
  /** GET 未命中时是旧端兼容降级；loading 只存在于一次读取事务期间。 */
  status: 'ready' | 'unsupported' | 'loading';
  /** Present for an accepted host snapshot; used to fence render-commit races. */
  sourceBranch?: string;
}

function sameDraftWorktreeBranchTarget(
  left: DraftWorktreeBranchTarget,
  right: DraftWorktreeBranchTarget,
): boolean {
  return left.deviceId === right.deviceId && left.baseRepo === right.baseRepo;
}

function parseDraftWorktreeBranchSnapshot(
  value: unknown,
): NewMakerWorktreeBranchPreferenceSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NewMakerWorktreeBranchPreferenceSnapshot>;
  if (
    typeof candidate.baseRepo !== 'string'
    || candidate.baseRepo.length === 0
    || typeof candidate.sourceBranch !== 'string'
    || candidate.sourceBranch.length === 0
    || typeof candidate.revision !== 'number'
    || !Number.isSafeInteger(candidate.revision)
    || candidate.revision < 0
  ) return null;
  return candidate as NewMakerWorktreeBranchPreferenceSnapshot;
}

function isWorktreeBranchPreferenceChannelUnsupported(error: unknown): boolean {
  if (extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return true;
  return error instanceof Error
    && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(error.message);
}
// F-COLLAB (2026-05): 老的 vendor='orca' 入口已退役,OrcaHeaderStrip 组件随之
// 删除(它是给 isOrca 分支的 ChatInput.topSlot 用的)。Lead/Worker 协作组合现在
// 由 ChatInput「+」菜单里的协同模式项控制,Lead 是当前 vendor 本身,
// Worker 通过完整配置弹窗选择 cc / codex / pi。

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
 * 「创建即发送」路径的乐观标题 —— 让侧边栏 / 会话头 / tab 从第一帧就显示用户刚写下的
 * 那句话,而不是先亮一下建会话时的默认占位。
 *
 * 背景:权威标题在发送链路的**后段**才写(createSession → navigate → SessionView
 * mount → sendMessage → `maker:auto-title` IPC → 写库 → 广播回 renderer)。这中间会话
 * 行已经出现在侧边栏上,标题却还是建会话时的默认值,用户明明已经按下回车却看着一个
 * 占位。device-link 远程路径早就为此做了即时预览
 * (`remoteProjectsStore.setPendingTitlePreview`,免得干等一次隧道往返),本机路径缺的
 * 是对称的这一半。
 *
 * 预览必须在 `createSession` **之前**登记:main 一插入就广播 `sessions:created`,
 * renderer 立刻 `forceRefreshAll`,那次重拉仍带哨兵。预览晚一步,用户就会先看到
 * 「未命名任务」。sessionsStore.prependCreated 也会叠同一层,第一帧才不会露哨兵。
 *
 * 有字用字;没字再用附件名 / 类别词。带 @mention / 编码引用时权威占位由
 * `deriveAutoTitleSeed` 另行剔除 wire token,这里算不出同一个串,仍不预览。
 */
function optimisticFirstMessageTitle(
  message: string,
  files: AttachedFile[] | undefined,
  mentions: MentionedResource[] | undefined,
  opts: { quotesEncoded?: boolean; agentReferences?: AgentInputReference[] } | undefined,
  labels: { image: string; file: string },
): string | null {
  if (mentions?.length || opts?.agentReferences?.length || opts?.quotesEncoded) return null;
  const first = files?.[0];
  const title = deriveOptimisticSessionTitle({
    text: message,
    fileNames: (files ?? [])
      .filter((file) => !file.path?.startsWith('clipboard://'))
      .map((file) => file.originalName || file.name)
      .filter(Boolean),
    imageLabel: labels.image,
    fileLabel: labels.file,
    firstFileIsImage: first?.category === 'image',
  });
  return title || null;
}

/**
 * 由 draft.collab 拼出 createSession 后 enableOrca 的入参:与会话内 requestEnableCollab 同口径。
 * 有 workerConfig(用户在「开启协同」弹窗配过 role/model/…)则透传全量;否则只带 workerAgent 回退默认。
 */
function draftEnableOrcaOptions(
  collab: CollabDraft,
  providers: ProviderView[],
  providersReady: boolean,
  deferDelegateTask = false,
) {
  const preferredAgent: 'claude-code' | 'codex' | 'pi' =
    collab.worker === 'codex' ? 'codex' : collab.worker === 'pi' ? 'pi' : 'claude-code';
  // Worker 类型也是**设备作用域**的(codex review P2):在只连了 Codex 的设备 A 选了 Codex
  // Worker,切到只连 Claude 的设备 B 时,workerConfig 虽然被清了,collab.worker 仍是 codex,
  // 透传过去必撞被控端的 NO_PROVIDER_FOR_AGENT 预检,协同又静默降级成单会话。
  // 与 providerId 同一条思路:按**目标设备**的 live 目录收窄 —— 首选 agent 在那台机器上
  // 没有已连接供应商、而另一个有,就改用另一个;两个都没有则原样透传,由 main 的精确
  // preflight 报可操作错误(不在这里编一个同样跑不起来的值)。
  // 仅在目录就绪时收窄,理由同下方 providerId:未就绪的空快照会误判成"都没有"。
  const workerAgent: 'claude-code' | 'codex' | 'pi' = (() => {
    if (!providersReady) return preferredAgent;
    if (connectedProvidersForAgent(providers, preferredAgent).length > 0) return preferredAgent;
    const fallback = (['claude-code', 'codex', 'pi'] as const).find(
      (agent) =>
        agent !== preferredAgent && connectedProvidersForAgent(providers, agent).length > 0,
    );
    return fallback ?? preferredAgent;
  })();
  const cfg = collab.workerConfig;
  if (!cfg) return { workerAgent };
  // 首选 agent 被目标设备目录换掉时,配置里的 model / providerId 属于旧 agent,一并丢弃 ——
  // 留着只会撞 INVALID_PARAMS。让被控端按新 agent 的默认值起 Worker。
  if (workerAgent !== preferredAgent) {
    return {
      workerAgent,
      role: cfg.role,
      label: createWorkerLabel(cfg.role, []),
      delegateTask: cfg.initialTask,
      ...(deferDelegateTask ? { deferDelegateTask: true } : {}),
      workerPermissionMode: cfg.workerPermissionMode,
    };
  }
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
    // 准入按「停用」轴判(model.disabled,buildRegistry 烘焙):停用的 (来源, 模型) 不能
    // 显式路由过去。「隐藏」不再收窄 —— 隐藏只是陈列过滤,记忆来源被隐藏仍然合法可用
    // (2026-07 启用/显示双轴拆分)。suspended 供应商已被 connectedProvidersForAgent 剔除。
    const catalogModel = getModel(provider, cfg.model, workerAgent);
    // 非聊天模型不该被当成持久化草稿的有效来源(issue #882 第 3 点,2026-07 review),
    // 与 CreateWorkerPopover.narrowProviderSource 同规则同理由。
    return catalogModel &&
      isModelSelectableForNewRoute(catalogModel, { userProvider: provider.source === 'user' })
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
    delegateTask: cfg.initialTask,
    ...(deferDelegateTask ? { deferDelegateTask: true } : {}),
    workerPermissionMode: cfg.workerPermissionMode,
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
 * 具体清哪些字段、为什么只需两个,见 state/newMakerDraft 的 resetDraftWorkspaceTargets ——
 * 该语义已提到 store 侧共享,其它「另起一段干净对话」的入口也走同一个函数。
 */
function resetDraftWorkspaceAfterSend(): void {
  resetDraftWorkspaceTargets();
}

/**
 * 「这份草稿要跑在哪」的目标描述 —— 见组件内 applyDraftTarget。
 *
 * 刻意把 deviceId 与 workingDir 放在一起要求调用方**同时**给出:草稿的运行目标本来就是这个二元组,
 * 而所有需要连带更新的状态(mention chip、路径型附件、能力/供应商快照、远程运行配置、worktree
 * 三态、extraDirs)都能从「这个二元组的哪一半变了」推导出来。分开传就又回到了「某条路径记得改
 * 设备、忘了清项目」那类缺陷。
 */
interface DraftTargetRequest {
  /** 目标设备;null = 本机。 */
  deviceId: string | null;
  deviceName: string | null;
  /** 目标工作区;null = 该设备上的「对话」(不绑项目)。 */
  workingDir: string | null;
  /**
   * 已经 inline 拉到的被控端快照。只有「添加远程项目」那条路径有 —— 它为了验证设备可达,本来就
   * 直接 invoke 过 capabilities / defaults,于是能立刻 seed,不必等 effect 再跑一轮隧道往返。
   * 不给就把远程运行配置打回未加载,交给 seed effect 自己拉。
   */
  remoteSnapshot?: {
    capabilities: AgentCapabilities;
    defaults: RemoteDraftDefaults | null;
  };
}

export function NewMakerDraftRoute() {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const draft = useNewMakerDraft();
  const location = useLocation();
  const navigate = useNavigate();
  const dialogueTargetRequest = useMemo(
    () => readNewMakerDialogueTargetRequest(location.state),
    [location.state],
  );
  const folderPickerRequest = useMemo(
    () => readNewMakerFolderPickerRequest(location.state),
    [location.state],
  );
  const handledDialogueTargetRequestRef = useRef<string | null>(null);
  const modePickerSelectionSeqRef = useRef(0);
  const handledFolderPickerRequestRef = useRef<string | null>(null);
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
  const { createSession, error: createSessionError } = useCCSessions();
  const vendorAuthGate = useVendorAuthGate();
  const refreshWorktrees = useRefreshWorktrees();

  /** createSession 失败 toast:远端路由错误按 code 给可操作文案,其余回退通用文案。 */
  const toastCreateSessionFailed = (err?: unknown) => {
    const code =
      (err as { code?: string } | null | undefined)?.code ??
      (createSessionError as { code?: string } | null)?.code;
    const key =
      code === 'REMOTE_PROVIDER_UPDATING'
        ? 'ccAgent.draft.remoteProviderUpdating'
        : code === 'REMOTE_PROVIDER_UNSUPPORTED'
          ? 'ccAgent.draft.remoteProviderUnsupported'
          : code === 'REMOTE_NATIVE_OAUTH_UNAVAILABLE'
            ? 'ccAgent.draft.remoteNativeOauthUnavailable'
            // 轮 40-w4-t3 HIGH:远端 Pi 会话启动时 Cindy AI gateway endpoint
            // 未就绪 —— main 侧已映射同名 IPC code, 这里走已存在 5 语言的
            // logic.errors.remoteError.REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE
            // (引导去 Settings → Model Providers), 不再显示 raw 英文。
            : code === 'REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE'
              ? 'logic.errors.remoteError.REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE'
              // 轮 42 P2(codex-connector):远端 Pi + loopback-only BYOM 被 main
              // 映射成 REMOTE_LOCAL_ONLY_PROVIDER —— 这里不映射会落通用失败
              // toast, 隐藏「换网关/远端可达 BYOM」的行动指引。
              : code === 'REMOTE_LOCAL_ONLY_PROVIDER'
                ? 'logic.errors.remoteError.REMOTE_LOCAL_ONLY_PROVIDER'
                : code === 'LOCAL_OLLAMA_NOT_READY'
                  ? 'logic.errors.remoteError.LOCAL_OLLAMA_NOT_READY'
                  : 'ccAgent.draft.createSessionFailed';
    toast.error(t(key));
  };

  // 「添加远程项目」入口:gate = 至少一台 ready SSH 主机 或 一台可控 device-link 设备。
  // 入口渲染在 mode pill 的 FolderPickerPopover 里(Globe 项),点开下面这个弹窗。
  const hasAnyRemoteTarget = useHasAnyRemoteTarget();
  // 设备切换器的数据源(含离线设备);空数组时 DeviceSwitcherPill 整个不渲染。
  // loaded 用来区分「还没拉到」和「拉到了确实没有」—— 见下方失效回落 effect。
  const { devices: selectableDevices, loaded: selectableDevicesLoaded } = useSelectableDevices();
  const [addRemoteProjectOpen, setAddRemoteProjectOpen] = useState(false);
  const [addRemoteProjectDeviceId, setAddRemoteProjectDeviceId] = useState<string | null>(null);
  const outletContext = useOutletContext<{
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (sessionId: string | null) => void;
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  const rightSidebarCollapsed = outletContext?.rightSidebarCollapsed ?? true;
  const rightSidebarSide = outletContext?.rightSidebarSide ?? 'right';
  const setRightSidebarAvailable = outletContext?.setRightSidebarAvailable;
  const setRightSidebarSessionId = outletContext?.setRightSidebarSessionId;
  const setRightSidebarWorkdir = outletContext?.setRightSidebarWorkdir;
  // 用户终裁(2026-07-17):Figma 185:2724 CREATE AGENT 没有首页用量仪表盘,
  // 新建页彻底解除挂载,不迁移、不新增入口。
  // 当前 vendor 对应的 prefs(切 vendor 后这里自动重算 → 透传到 ChatInput initial*)
  const currentPrefs = draft.lastByVendor[draft.vendor];
  const chatPrefs = currentPrefs;
  /**
   * 统一模型选择器里选中的收藏锚点(规格 §1.5)。
   *
   * 它曾经是**组件态**(随路由卸载即忘),理由是「只是这次草稿选中哪一条副本,不属于要跨
   * 重启保留的偏好」。Chris 2026-08-19 实测推翻:收藏区置顶、模型行在下面,锚点一忘,面板
   * 就回落到模型行打勾并把列表滚到那一行 ——「我明明选了收藏第 3 个,打开选单,默认焦点
   * 永远在下面不在收藏」。现在按**引擎**分槽持久化到 `favoriteAnchorMemory`(renderer
   * localStorage,按 owner 分区),与草稿模型选择本身的 `lastByVendor` 同一个分槽维度:
   * 切引擎再切回来,勾的还是那一条。
   *
   * 槽里存的是**选中那一刻的快照**(uid + 当时写进草稿的 wire model id),不是只存 uid 再
   * 回头查收藏表。数据层把行合并成「归一化 id + 每引擎 wireModelId」之后,收藏条目按**归一化
   * id** 存(那是行的稳定身份),而草稿里放的是 **wire id**(那才是发得出去的那个)——直接拿
   * favorite.modelId 去比 draftInitialModel,像 `chatgpt/gpt-5.6-luna` 这类两者本就不相等的
   * 模型会**每次都判成失配**,刚点上的收藏立刻掉勾。快照比的是「草稿现在还是不是我当初写下的
   * 那一份」,两边都是 wire id,与收藏表用哪套 id 无关。
   *
   * 「vendor 也要对得上」这一维不再由快照字段承担:槽本身就按引擎分,读的永远是当前引擎那
   * 一格。改动前把 vendor 塞进快照再在失效效应里比,切走引擎会把**上一个引擎**的锚点判失效
   * 并清掉 —— 持久化之后那等于一切引擎只能记住最后一次选择。
   */
  const draftFavoriteAnchor = useDraftFavoriteAnchor(normalizeDbAgentKind(draft.vendor));
  const persistedAgentKind: 'cc' | 'codex' | 'pi' = normalizeDbAgentKind(draft.vendor);
  const authVendor: 'cc' | 'codex' | 'pi' = persistedAgentKind;
  const capabilityAgentKind = dbToMakerAgentKind(persistedAgentKind);

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
  // 设备切换器(#807)。与项目 picker 互斥打开 —— 两个 popover 同时浮着会互相遮挡。
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
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
  const [wtSupportsRecoveryKeyDiscard, setWtSupportsRecoveryKeyDiscard] = useState<boolean | null>(
    null,
  );
  // 探测成功且确认目录不具备 worktree 资格(非 git / 无 git / 已在 worktree 内)= true:
  // 发送门放行普通会话(2026-08-07 裁决,勾选记忆只对合格目录生效)。null = 探测中或
  // 失败,维持 fail closed——「确认不是 git」和「探测不出来」不是一回事。
  const [wtConfirmedIneligible, setWtConfirmedIneligible] = useState<boolean | null>(null);
  // repo-scoped 分支偏好以工作端 main 为权威。target ref 在换设备 / repo 的同步动作里先行
  // 改写，挡住 React commit 前一瞬间到达的旧 GET / APPLY / push；seq 另挡异步 GET 晚到。
  const wtBranchTargetRef = useRef<DraftWorktreeBranchTarget>({
    deviceId: null,
    baseRepo: null,
  });
  const wtBranchReadSeqRef = useRef(0);
  const wtBranchSyncRef = useRef<DraftWorktreeBranchSync | null>(null);
  const [wtBranchSync, setWtBranchSync] = useState<DraftWorktreeBranchSync | null>(null);
  // Host-first preference writes are transactions, not fire-and-forget UI
  // updates.  A send/goal started while one is in flight must not consume the
  // previous branch/checkbox value.  The sequence + serial promise chain also
  // makes the last branch click win when two IPC calls resolve out of order.
  const wtBranchWriteSeqRef = useRef(0);
  const wtBranchWriteChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const wtBranchPreferenceSavingRef = useRef(false);
  const [wtBranchPreferenceSaving, setWtBranchPreferenceSaving] = useState(false);
  const wtBranchCommittedValueRef = useRef<string | null>(null);
  // Unlike React state, this ref only advances from a layout effect, so it
  // represents a value that has reached wtRef in a committed render. A newer
  // host push may render before the matching APPLY settles; the write fence can
  // then be released immediately instead of waiting for a render that will not
  // happen again.
  const wtBranchRenderedValueRef = useRef(wtSourceBranch);
  const armWtBranchCommittedValue = useCallback((sourceBranch: string) => {
    wtBranchCommittedValueRef.current = sourceBranch;
    if (wtBranchRenderedValueRef.current !== sourceBranch) return;
    wtBranchCommittedValueRef.current = null;
    wtBranchPreferenceSavingRef.current = false;
    setWtBranchPreferenceSaving(false);
  }, []);
  const wtBranchPreferenceErrorRef = useRef(false);
  const [wtBranchPreferenceError, setWtBranchPreferenceError] = useState(false);
  const wtPreferenceWriteSeqRef = useRef(0);
  const wtPreferenceWriteChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const wtPreferenceSavingRef = useRef(false);
  const [wtPreferenceSaving, setWtPreferenceSaving] = useState(false);
  const wtPreferenceCommittedValueRef = useRef<boolean | null>(null);
  // A timed-out/disconnected APPLY can no longer be called "saving", but its
  // authority is still unknown. Keep create fail-closed while leaving the
  // checkbox itself enabled so the user can explicitly retry either value.
  const wtPreferenceAuthorityUnknownRef = useRef(false);
  const wtPreferenceTransactionRef = useRef<{
    seq: number;
    deviceId: string;
    enabled: boolean;
    status: 'writing' | 'reconciling-success' | 'reconciling-unknown' | 'committed';
  } | null>(null);
  // F-COLLAB: 协同模式状态(enabled + worker 类型)直接读自 draft store,
  // 和 workingDir 走同一份 localStorage,重启 / 切走再回都能恢复。
  // 协同与项目/对话形态正交:两种草稿都向 ChatInput 提供入口;项目读项目级策略,
  // 对话只读用户级/全局级策略。发送成功后 resetDraftWorkspaceTargets 显式消费本次选择。
  const collab = draft.collab;
  // ChatInput 现在要求显式拥有 attachmentState。这条 transient 路由没有
  // sessionId(还没建会话),sessionId 仍传 undefined(图片本地缓存走 base64
  // fallback——草稿态没真实会话目录可写),但 draftKey 用 NEW_MAKER_DRAFT_KEY
  // 让附件能在"切走再切回"时存活。
  const attachmentState = useAttachments(undefined, NEW_MAKER_DRAFT_KEY);
  /**
   * 剥掉 @file / @dir / @agent mention chip —— 触发条件是**项目变了**,不只是设备变了。
   *
   * 关键事实(Codex review 第 29 轮给出的新证据):ChatInput 把这些 chip 的 `path` 存成**项目相对**
   * 路径(`attrs.path = item.relPath`,源码注释原文「for files/dirs we stash the relative path
   * as-is」;agent chip 是 `.claude/agents/<name>.md`,同样相对)。于是解析基准是 **workingDir**,
   * 而不是文件系统 —— 同一台机器上从项目 X 换到项目 Y,`@src/foo.ts` 会解析到 Y 里的同名文件。
   * 这比换设备更隐蔽:`src/index.ts`、`.claude/agents/reviewer.md` 这类路径在同机两个项目间
   * **恰好都存在**的概率相当高,于是 agent 读到一个毫不相关的文件而没有任何报错。
   *
   * 我前几轮判断「同机换项目文件系统没变,剥 chip 是功能退化」—— 那个判断建立在「chip 存绝对路径」
   * 这个错误前提上。对绝对路径成立,对相对路径不成立。
   */
  const stripProjectRelativeMentions = useCallback(() => {
    const composerDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY);
    if (!composerDraft?.text) return;
    saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
      ...composerDraft,
      text: stripLocalMentionChips(composerDraft.text),
    });
  }, []);
  /**
   * 丢掉路径型(非图片)附件 —— 触发条件是**文件系统变了**,即换设备。
   *
   * 与 chip 相反,附件存的是**绝对**路径(useAttachments 落 `raw.path`)。所以同一台机器上换项目
   * 它们仍然有效,不该丢;只有跨设备(远程→远程、远程→本机,方向无关)那条绝对路径才会失效 ——
   * attachment-path-passthrough 之后非图片附件只把 path 透传给模型(agent 自己用 Read 读),
   * 而 rehomeDraftAttachments 只重整图片、非图片原样返回,于是要么读不到,要么读到同路径下一个
   * 毫不相关的文件(后者更糟,用户不会发现)。图片走 xdt-image:// 缓存、不依赖对端文件系统,不受影响。
   *
   * 这两件事原先合在一个 cleanupCrossFilesystemDraftContext 里、由同一个条件驱动,于是必然有一边
   * 是错的:按设备触发就漏掉同机换项目的 chip(上面那条 P1),按项目触发又会在同机换项目时误丢
   * 用户的附件。拆开之后各自绑住自己真正的解析基准。
   */
  const dropPathBackedAttachments = useCallback(() => {
    const stranded = attachmentState.attachments.filter((f) => f.category !== 'image');
    if (stranded.length === 0) return;
    for (const f of stranded) attachmentState.removeFile(f.id);
    // 只有附件给 toast:chip 是可见的文字、重打一次就有,附件从托盘里无声消失只会被当成 bug。
    toast.info(t('newChat.deviceSwitcher.attachmentsDropped', { count: stranded.length }));
  }, [attachmentState, t]);
  const effectiveWorkingDir = draft.workingDir;
  const effectiveRemoteHostId = draft.remoteHostId;
  const isRemoteProjectDraft = effectiveWorkingDir != null && effectiveRemoteHostId != null;
  // device-link:为远程设备项目新建对话(草稿带 deviceId)。与 SSH remoteHostId 互斥。
  // 归一成 string | undefined(能力 hook / getModelById / ChatInput prop 都按此签名;
  // 下面 isDeviceLinkDraft 与 create 分支的真值收窄对 undefined 同样成立)。
  const effectiveDeviceLinkDeviceId = draft.deviceLinkDeviceId ?? undefined;
  const effectiveDeviceLinkDeviceName = draft.deviceLinkDeviceName;
  // 入口门控:只在 runtime 已注册的 agent 上开放创建入口(Pi 二进制缺失时 buildPiAgent 返回
  // null,agent map 无 pi,但模型目录仍投影 Pi → 需按 maker:list-available-agents 过滤,
  // 否则一路创建到 requireAgent 的 not-registered 报错,codex review P2)。远程草稿以被控端
  // 的注册结果为准(hook 传 deviceId 走隧道)。未加载完成时不隐藏任何入口(fail-open)。
  const { availableVendors, loaded: availableAgentsLoaded } = useAvailableAgents(
    effectiveDeviceLinkDeviceId,
  );
  const hiddenSwitcherVendors = useMemo<MakerVendor[]>(() => {
    if (!availableAgentsLoaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((vendor) => !availableVendors.has(vendor));
  }, [availableAgentsLoaded, availableVendors]);
  /**
   * 「这份草稿要建到对端设备上」—— 只看 deviceId,**不再要求 workingDir**(#807)。
   *
   * 改前是 `workingDir != null && deviceId != null`,于是「在对端设备上开个不绑项目的对话」
   * 永远判不成 device-link 草稿,必然掉到本机分支创建;更糟的是下面的能力 / provider 只看
   * effectiveDeviceLinkDeviceId(不看本旗标),所以那种状态下**模型列表来自对端、会话却建在本机**。
   * 现在三处口径统一到同一个字段:选了设备就整套走对端(能力、provider、创建),
   * 有没有项目只决定 workspaceKind 是 'project' 还是 'dialogue'。
   */
  const isDeviceLinkDraft = effectiveDeviceLinkDeviceId != null;
  const wtBranchTarget: DraftWorktreeBranchTarget = {
    deviceId: effectiveDeviceLinkDeviceId ?? null,
    baseRepo: wtBaseRepo,
  };
  wtBranchTargetRef.current = wtBranchTarget;
  const wtBranchPreferenceReady = wtBaseRepo != null
    && wtBranchSync?.deviceId === wtBranchTarget.deviceId
    && wtBranchSync.baseRepo === wtBaseRepo
    && wtBranchSync.status !== 'loading'
    && !wtBranchPreferenceError;
  const wtBranchPreferenceLoading = wtBaseRepo != null
    && !wtBranchPreferenceError
    && (
      wtBranchSync == null
      || (wtBranchSync.deviceId === wtBranchTarget.deviceId
        && wtBranchSync.baseRepo === wtBaseRepo
        && wtBranchSync.status === 'loading')
    );
  const wtBranchPreferenceLoadingRef = useRef(false);
  wtBranchPreferenceLoadingRef.current = wtBranchPreferenceLoading;

  /**
   * 权威 snapshot 的统一落点。GET、APPLY response、本地 push、远端 push 全走这一道：
   * 设备/repo 必须仍是当前 target；同 target 只接受不小于已接收 host revision 的值。
   * APPLY response 与它的 push echo revision 相等是合法的幂等重复。
   */
  const acceptWtBranchSnapshot = useCallback((
    requestTarget: DraftWorktreeBranchTarget,
    rawSnapshot: unknown,
  ): boolean => {
    const snapshot = parseDraftWorktreeBranchSnapshot(rawSnapshot);
    if (!snapshot || !requestTarget.baseRepo) return false;
    const currentTarget = wtBranchTargetRef.current;
    if (!sameDraftWorktreeBranchTarget(requestTarget, currentTarget)) return false;
    if (snapshot.baseRepo !== currentTarget.baseRepo) return false;

    const previous = wtBranchSyncRef.current;
    if (
      previous
      && previous.deviceId === currentTarget.deviceId
      && previous.baseRepo === snapshot.baseRepo
      && snapshot.revision < previous.revision
    ) return false;

    const next: DraftWorktreeBranchSync = {
      deviceId: currentTarget.deviceId,
      baseRepo: snapshot.baseRepo,
      revision: snapshot.revision,
      status: 'ready',
      sourceBranch: snapshot.sourceBranch,
    };
    wtBranchSyncRef.current = next;
    setWtBranchSync(next);
    wtBranchPreferenceErrorRef.current = false;
    setWtBranchPreferenceError(false);
    setWtSourceBranch(snapshot.sourceBranch);
    return true;
  }, []);

  /** GET 返回 null / 明确的旧工作端不支持 channel 时才允许兼容降级。 */
  const markWtBranchTargetReady = useCallback((target: DraftWorktreeBranchTarget) => {
    if (!target.baseRepo) return;
    if (!sameDraftWorktreeBranchTarget(target, wtBranchTargetRef.current)) return;
    const previous = wtBranchSyncRef.current;
    if (
      previous
      && previous.deviceId === target.deviceId
      && previous.baseRepo === target.baseRepo
      && previous.status !== 'loading'
    ) return;
    const next: DraftWorktreeBranchSync = {
      deviceId: target.deviceId,
      baseRepo: target.baseRepo,
      revision: -1,
      status: 'unsupported',
    };
    wtBranchSyncRef.current = next;
    setWtBranchSync(next);
    wtBranchPreferenceErrorRef.current = false;
    setWtBranchPreferenceError(false);
  }, []);
  /**
   * 远程草稿的附件闸门:**先选设备、之后再拖进来的**路径型附件同样进不了对端(Codex review P1)。
   *
   * 换设备时的 cleanupCrossFilesystemDraftContext 只能清掉「切换那一刻已经在托盘里」的,管不到
   * 之后新加的;而 rehomeDraftAttachments 只重整图片、非图片原样返回,于是那条**控制端**绝对路径
   * 会随首条消息发到对端 —— 要么读不到,要么读到同路径下一个毫不相关的文件。两者一起才构成
   * 「远程草稿绝不携带控制端路径附件」这条不变量,少一半就等于留着一条口子。
   *
   * 为什么是拒绝而不是「传上去」:把文件送到对端需要一个能在对端写字节的通道,而 device-link
   * 的 invoke allowlist 里没有、也不该为此加一个写通道 —— 那是权限边界变更,不属于本 PR。
   * 所以在用户动作发生的那一刻就明确拒绝并说明,而不是等发送时静默丢掉(那才像 bug)。
   * 图片不受影响:它们走 xdt-image:// 缓存,由 rehomeDraftAttachments 正常搬运。
   *
   * 包一层而不是改 useAttachments:这条限制只属于「创建页 + 远程草稿」这个语境,
   * 会话中途与本机草稿都不该被它影响。ChatInput 与本路由自己的拖拽 / 粘贴入口共用这一份,
   * 免得又出现「只堵了一半」。
   */
  const guardedAttachmentState = useMemo(() => {
    if (!isDeviceLinkDraft) return attachmentState;
    return {
      ...attachmentState,
      addFiles: async (fileList: FileList | readonly File[]) => {
        const incoming = Array.from(fileList);
        // 判据必须与下游**同口径**(Codex review 第 29 轮 P1)。原来这里用 `f.type.startsWith('image/')`,
        // 而 useAttachments 的分类**完全不看 MIME** —— 它先 extractExt(name) → categorizeFile,
        // 扩展名认不出来才 peekFileHeader 按魔数推断。于是 Electron 给空 / 通用 `File.type` 时
        // (某些平台与拖拽源就是如此,重命名过的图片更是必然),一张 useAttachments 明明能正确识别的
        // 图片会被这道闸门拦掉,而且**只在远程草稿下**如此:用户切回本机就能加,现象极难理解。
        //
        // 所以改成「只拒绝**明确**是非图片的」:
        //   · 分类为 image → 放行;
        //   · 扩展名 / 文件名认不出类别(category 为 null)→ 也放行 —— 交给 useAttachments 的文件头
        //     推断,推断出非图片会被下方的收敛式不变量 effect 移除并 toast;
        //   · 分类为明确的非图片(pdf / text / …)→ 就地拒绝并说明。
        //
        // 这也让两道防线的分工彻底清楚:闸门是 **best-effort 的即时反馈**(用户动作那一刻就知道为什么),
        // 收敛器才是**权威不变量**(不论从哪条路进来,远程草稿里绝不留下路径型附件)。闸门宁可放过、
        // 绝不误拒;真正的兜底不靠它。
        const definitelyNonImage = (f: File): boolean => {
          const ext = extractExt(f.name);
          const category = ext ? categorizeFile(ext) : categorizeByFilename(f.name);
          if (!category) return false; // 未知 → 不在这里下结论
          return category !== 'image';
        };
        const rejected = incoming.filter(definitelyNonImage);
        const passed = incoming.filter((f) => !definitelyNonImage(f));
        if (rejected.length > 0) {
          toast.warning(
            t('newChat.deviceSwitcher.attachmentsRemoteUnsupported', { count: rejected.length }),
          );
        }
        if (passed.length > 0) await attachmentState.addFiles(passed);
      },
    };
  }, [isDeviceLinkDraft, attachmentState, t]);
  /**
   * 「远程草稿绝不携带控制端路径附件」的**收敛器** —— 兜住所有按路径逐个堵会漏掉的入口。
   *
   * 为什么单靠上面那个 addFiles 闸门不够(Codex review P1):`useAttachments.addFiles` 对未知扩展名
   * 的文件要先 await `peekFileHeader` 猜类型,附件是在那次 IPC 回来之后才进 state 的。于是存在这条
   * 时序 —— 本机草稿下拖入一个未知扩展名文件 → 在 IPC 往返期间切到远程设备 → 切换时的清理找不到它
   * (还没进 state)→ IPC 回来后它被追加进去,而那次调用握的是**切换前**取到的真 addFiles,绕过了
   * 闸门。下一次发送就把控制端绝对路径发给对端。
   *
   * 这个 hook 在本 PR 的 review 里已经按「入口」被抓漏三次(切换时清理 → 加时闸门 → 这条在途摄入),
   * 所以这次不再补第四个入口,改成维护**不变量**:只要远程草稿里出现了非图片附件,不论它从哪条路
   * 进来的,都移除并说明。之后任何新入口都自动被覆盖。
   *
   * 与另两处的关系(别当成重复删掉任何一个):闸门让用户在动作发生那一刻就得到明确拒绝、文件根本
   * 不进 state;切换时的同步清理让附件在下一帧之前就消失、且顺带处理 mention chip;这条是最后一道
   * 网,只在前两者都没拦住时才动。
   */
  useEffect(() => {
    if (!isDeviceLinkDraft) return;
    const stranded = attachmentState.attachments.filter((f) => f.category !== 'image');
    if (stranded.length === 0) return;
    for (const f of stranded) attachmentState.removeFile(f.id);
    toast.info(t('newChat.deviceSwitcher.attachmentsDropped', { count: stranded.length }));
  }, [isDeviceLinkDraft, attachmentState.attachments, attachmentState.removeFile, t]);
  // 零可用模型引导卡:device-link 草稿不出(连接态在被控端,本机替它连不上)。
  const providerOnboarding = useProviderOnboarding();
  const showProviderOnboardingCard = providerOnboarding.visible && !isDeviceLinkDraft;
  const effectiveExtraDirs = draft.extraDirs;
  const effectiveCollab = collab;
  // 协同入口判定与会话视图共用同一个 helper(issue #1170:两处各写一份判据,于是同一个
  // device-link 项目在草稿里没入口、进会话页又有)。草稿的 workspaceKind 显式按
  // "有没有选项目目录" 给出 —— 与它提交给 createSession 的值同源,不让 helper 反推。
  const collabWorkspaceKind = effectiveWorkingDir ? 'project' : 'dialogue';
  const collabEntry = resolveCollabEntryPolicy({
    workspaceKind: collabWorkspaceKind,
    workingDir: effectiveWorkingDir,
    remoteHostId: effectiveRemoteHostId,
    deviceLinkDeviceId: effectiveDeviceLinkDeviceId,
  });
  const collabPolicyEligible = collabEntry.eligible;
  const collabPolicy = useCollabProjectPolicy(effectiveWorkingDir, collabPolicyEligible, {
    workspaceKind: collabWorkspaceKind,
    // dialogue 没有用户项目,SSH 远端 draft 的 workingDir 又是远端主机路径;两者都跳过
    // 本机项目级查询,但用户级/全局级 collab 开关仍生效。
    skipQuery: collabEntry.skipProjectQuery,
    // device-link draft:项目级开关的真相在被控端, 隧道过去查(控制端本机查那条远端
    // 路径只会读到自己的用户级开关, 可能与被控端 main 的授权相反)。
    deviceId: collabEntry.policyDeviceId ?? null,
  });
  const projectPickerOptions = useProjectPickerOptions();
  /**
   * 项目 picker 的数据源随**当前设备**切换(#807 方案 B):本机 → 本机最近项目;
   * 对端 → 经隧道拉那台设备的 recent_workdirs。两者不并列显示,列表长度因此恒定。
   */
  const {
    projects: deviceLinkProjects,
    status: deviceLinkProjectsStatus,
    error: deviceLinkProjectsError,
    retry: retryDeviceLinkProjects,
    removeProject: removeRemoteProject,
  } = useDeviceLinkProjects(
    effectiveDeviceLinkDeviceId ?? null,
    effectiveDeviceLinkDeviceName ?? null,
    folderPickerOpen,
  );
  const activeProjectOptions = effectiveDeviceLinkDeviceId
    ? deviceLinkProjects
    : projectPickerOptions;
  const folderPickerDeviceScope = useMemo<FolderPickerDeviceScope | undefined>(
    () =>
      effectiveDeviceLinkDeviceId
        ? {
            deviceId: effectiveDeviceLinkDeviceId,
            deviceName: effectiveDeviceLinkDeviceName ?? effectiveDeviceLinkDeviceId,
            status:
              deviceLinkProjectsStatus === 'error'
                ? 'error'
                : deviceLinkProjectsStatus === 'ready'
                  ? 'ready'
                  : 'loading',
            error: deviceLinkProjectsError,
            retry: retryDeviceLinkProjects,
          }
        : undefined,
    [
      effectiveDeviceLinkDeviceId,
      effectiveDeviceLinkDeviceName,
      deviceLinkProjectsStatus,
      deviceLinkProjectsError,
      retryDeviceLinkProjects,
    ],
  );
  const createAgentModeLabel =
    getProjectPickerDisplayName(
      effectiveWorkingDir,
      activeProjectOptions,
      effectiveDeviceLinkDeviceId,
    ) ?? t('newChat.folderPicker.dialogue');
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
      setRightSidebarWorkdir?.(
        draftRightSidebar.workdir,
        draftRightSidebar.remoteHostId,
        draftRightSidebar.deviceLinkDeviceId,
      );
    } else {
      setRightSidebarWorkdir?.('', null, undefined);
    }
    return () => setRightSidebarWorkdir?.('', null, undefined);
  }, [
    draftRightSidebar.deviceLinkDeviceId,
    draftRightSidebar.remoteHostId,
    draftRightSidebar.workdir,
    setRightSidebarWorkdir,
  ]);

  // 跨 Agent 工作区迁移弹窗：detect → ask → run → 等关闭 → 才创建会话
  const crossAgentDialog = useCrossAgentMigrationDialog();

  // device-link:在远程设备上新建会话时,能力 / 模型必须来自该被控端(草稿带 deviceLinkDeviceId);
  // 本地草稿 effectiveDeviceLinkDeviceId 为 undefined → 走本地能力(行为不变)。
  const {
    capabilities,
    loading: capabilitiesLoading,
    error: capabilitiesError,
  } = useAgentCapabilities(capabilityAgentKind, effectiveDeviceLinkDeviceId);
  // device-link「以被控端为准」:远程草稿用被控端经隧道带来的 providers(per-provider,含 fast 能力);
  // 本地草稿用本机 providers。fast 判定统一交给 resolveFastSupported(不在控制端另写远程逻辑)。
  const { providers: localProviders, loading: localProvidersLoading } = useProviders();
  const {
    providers: deviceProviders,
    loading: deviceProvidersLoading,
    error: deviceProvidersError,
    unsupported: deviceProvidersUnsupported,
  } = useDeviceProviders(effectiveDeviceLinkDeviceId);
  const providers = effectiveDeviceLinkDeviceId ? deviceProviders : localProviders;
  // 统一面板的启用判据是**两级**,与 ChatInput 的 unifiedPanelCapable / unifiedPanelActive
  // 一一对应,工具条的引擎下拉必须按后者(active)决定去留:
  //   · capable(本变量)—— 联合列表只认供应商目录,老被控端(不支持 provider:list)只有
  //     一份拍平 capabilities → 开了就是空列表,composer 那边会降级回旧面板;
  //   · active —— 再叠上形态偏好(modelPickerLayout,默认 'original' = 最原始选择器)。
  // 旧面板是「先选引擎再选模型」,所以只要没真正启用统一面板,就必须把工具条上的引擎下拉
  // 还回来 —— 否则那条链路上根本换不了引擎(只按 capable 撤掉时,默认形态下的新建草稿
  // 就彻底没有换引擎入口)。统一面板真启用时不注入(引擎跟着模型走)。
  const unifiedModelPanelEnabled =
    !effectiveDeviceLinkDeviceId || !deviceProvidersUnsupported;
  const modelPickerLayoutPref = useModelPickerLayout();
  const unifiedModelPanelActive =
    unifiedModelPanelEnabled && modelPickerLayoutPref !== 'original';
  const remoteModelListStatus = !isDeviceLinkDraft
    ? 'idle'
    : capabilitiesError || (deviceProvidersError && !deviceProvidersUnsupported)
      ? 'error'
      : capabilitiesLoading || deviceProvidersLoading || !capabilities
        ? 'loading'
        : 'ready';

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
  const calibrationProviders = useMemo(() => {
    const base = filterChatBridgedCodexProviders(
      localProviders,
      capabilityAgentKind,
      !!effectiveRemoteHostId,
    );
    // 逐模型过滤要落在**候选本身**，而不是只落在「挑哪个模型」那一步：来源解析
    // (effectiveSourceIdForModel) 吃的是同一份候选，若这里不剔除，被排除的条目仍会让它
    // 选中那个来源 —— 于是 providerId 落 null、main 解析到同一个被用户排除的默认来源，
    // effort / fast 也从错误的条目推导(PR #548 review)。
    // 排除口径按「停用」轴(m.disabled)+ 非 agent 分组的能力模型;「隐藏」不排除 ——
    // 隐藏只是陈列过滤,兜底路由仍可选中(2026-07 启用/显示双轴拆分,用户裁决)。
    return base
      .map((p) => {
        const models = p.models[capabilityAgentKind] ?? [];
        const kept = models.filter(
          (m) =>
            isModelSelectableForNewRoute(m, { userProvider: p.source === 'user' }) &&
            !(effectiveRemoteHostId && isSubscriptionDirectModel(m.id)),
        );
        if (kept.length === models.length) return p;
        return { ...p, models: { ...p.models, [capabilityAgentKind]: kept } };
      })
      .filter((p) => (p.models[capabilityAgentKind] ?? []).length > 0);
  }, [localProviders, capabilityAgentKind, effectiveRemoteHostId]);
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
  const draftCalibration = useMemo<DraftModelCalibrationResult>(() => {
    if (isDeviceLinkDraft) return { model: chatPrefs.model, providerId: null };
    return calibrateDraftModel({
      providers: autoCalibrationProviders,
      agent: capabilityAgentKind,
      model: chatPrefs.model,
      chosenByUser: draftModelChosenByUser,
      preferredProviderId: chatPrefs.providerId,
      providersLoading: localProvidersLoading,
    });
  }, [
    isDeviceLinkDraft,
    autoCalibrationProviders,
    capabilityAgentKind,
    chatPrefs.model,
    chatPrefs.providerId,
    draftModelChosenByUser,
    localProvidersLoading,
  ]);
  const calibratedDraftModel = draftCalibration.model;

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
    // 来源优先级:用户显式选的 > 校准挑中的 > 原生默认(nativeDefaultSourceId)。
    // 中间那一档不能省:nativeDefaultSourceId 对 claude-code 无条件优先 XD 网关,校准好的
    // 「anthropic 订阅提供的 claude-opus-5」交出去只剩模型 id 时会被重新指回网关 ——
    // 计费落网关而不是用户已付费的订阅额度,「订阅优先」在最后一步被推翻(PR #1076 review)。
    return effectiveSourceIdForModel(
      source,
      chatPrefs.providerId ?? draftCalibration.providerId ?? null,
      calibratedDraftModel,
      capabilityAgentKind,
    );
  }, [
    isDeviceLinkDraft,
    providers,
    autoCalibrationProviders,
    capabilityAgentKind,
    chatPrefs.providerId,
    draftCalibration.providerId,
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
  // 只有旧版被控端明确不支持此 channel 时才回落 capabilities 默认；超时 / 断链必须保留为
  // error，不能伪装成「已读取但没有远程偏好」后放行发送。
  // 本地草稿(无 deviceId)整段跳过,走下方 chatPrefs 路径(逐字节不变)。
  const [remoteDraftState, setRemoteDraftState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    value: RemoteDraftDefaults | null;
  }>({ status: 'idle', value: null });
  const [remoteDraftRetryEpoch, setRemoteDraftRetryEpoch] = useState(0);
  const [dlSel, setDlSel] = useState<DeviceLinkDraftSelection | null>(null);
  const dlSeedKeyRef = useRef<string | null>(null);
  const dlSeedCapabilitiesRef = useRef<AgentCapabilities | null>(null);
  /** 控制端是否编辑过当前设备 / Agent 的远程运行配置；能力刷新不得覆盖这类显式意图。 */
  const dlRuntimeTouchedRef = useRef(false);
  const skipDefaultsRefetchRef = useRef(false);
  const remoteDraftIdentityRef = useRef<string | null>(null);
  const remoteDraftRevisionRef = useRef(0);
  const remoteDraftRefreshEpoch = useDeviceLinkReconnectEpoch(
    isDeviceLinkDraft ? effectiveDeviceLinkDeviceId : undefined,
  );

  // 拉被控端当前草稿值。切 device/vendor 时清旧镜像；同一目标重连时后台重拉，
  // 但保留已知值直到新结果落下，避免一次瞬态失败把工作端拥有的 true 压成 false。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) {
      remoteDraftIdentityRef.current = null;
      setRemoteDraftState({ status: 'idle', value: null });
      return;
    }
    const identity = `${effectiveDeviceLinkDeviceId}:${capabilityAgentKind}`;
    const sameIdentity = remoteDraftIdentityRef.current === identity;
    remoteDraftIdentityRef.current = identity;
    // handoff 路径已 inline 拉取并 set 了 remoteDraftState,跳过本次 effect 重拉。
    if (skipDefaultsRefetchRef.current) {
      skipDefaultsRefetchRef.current = false;
      return;
    }
    let cancelled = false;
    const requestRevision = remoteDraftRevisionRef.current;
    setRemoteDraftState((previous) => ({
      status: 'loading',
      value: sameIdentity ? previous.value : null,
    }));
    window.electronAPI.deviceLink
      .invoke(effectiveDeviceLinkDeviceId, 'maker:get-new-maker-defaults', [capabilityAgentKind])
      .then((v) => {
        if (!cancelled && remoteDraftRevisionRef.current === requestRevision) {
          setRemoteDraftState({
            status: 'ready',
            value: (v as RemoteDraftDefaults | null) ?? null,
          });
        }
      })
      .catch((error) => {
        if (cancelled || remoteDraftRevisionRef.current !== requestRevision) return;
        const unsupported = extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
        // 只有确认旧端不支持时回落 capabilities 默认。超时/断链保留同目标旧镜像供展示，
        // 但状态必须是 error，发送 / 新建目标会阻止提交并触发一次显式重试。
        setRemoteDraftState((previous) => ({
          status: unsupported ? 'ready' : 'error',
          value: unsupported ? null : previous.value,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [
    isDeviceLinkDraft,
    effectiveDeviceLinkDeviceId,
    capabilityAgentKind,
    remoteDraftRefreshEpoch,
    remoteDraftRetryEpoch,
  ]);

  // seed dlSel:等被控端 capabilities + 草稿值都就绪后播种。切设备 / vendor 必须重种；同一目标
  // 在被控端明确未选过模型且控制端未编辑时，允许 capabilities 刷新重新校准区域默认。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) {
      dlSeedKeyRef.current = null;
      dlSeedCapabilitiesRef.current = null;
      dlRuntimeTouchedRef.current = false;
      setDlSel(null);
      return;
    }
    // provider revision 驱逐时 hook 会保留旧快照但标 loading；必须等新代际 ready，不能用 stale
    // capabilities 把 inline handoff 或用户当前选择校准回旧目录。
    if (!capabilities || capabilitiesLoading || remoteDraftState.status !== 'ready') return;
    const key = `${effectiveDeviceLinkDeviceId}:${capabilityAgentKind}`;
    const newTarget = dlSeedKeyRef.current !== key;
    const capabilitiesChanged = dlSeedCapabilitiesRef.current !== capabilities;
    if (
      !shouldReseedDeviceLinkDraftDefaults({
        currentSeedKey: dlSeedKeyRef.current,
        nextSeedKey: key,
        capabilitiesChanged,
        controllerTouched: dlRuntimeTouchedRef.current,
        remoteModelChosenByUser: remoteDraftState.value?.modelChosenByUser,
      })
    ) {
      if (capabilitiesChanged) {
        dlSeedCapabilitiesRef.current = capabilities;
        // 显式意图只禁止“换成区域默认”，不能把已从新能力清单消失的 model / effort /
        // permission 留在草稿里。用当前控制端选择合成 active draft，只做合法性夹紧。
        setDlSel((current) =>
          current
            ? resolveDeviceLinkDraftDefaults(
                capabilities,
                {
                  model: current.model,
                  modelChosenByUser: true,
                  effort: current.effort,
                  fastMode: current.fastMode,
                  permissionMode: current.permissionMode,
                  providerId: current.providerId,
                },
                current.model,
              )
            : current,
        );
      }
      return;
    }
    dlSeedKeyRef.current = key;
    dlSeedCapabilitiesRef.current = capabilities;
    if (newTarget) dlRuntimeTouchedRef.current = false;
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
    capabilitiesLoading,
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
  // 仅在 ready 时刷:重拉 / 失败期间保留旧镜像，避免非选中行闪默认再收敛
  // (镜像 scope 按设备、跨 agent 存全量,切 vendor 重拉无需清;真切设备由下方 clearScope effect 处理)。
  useEffect(() => {
    if (!mirrorScopeKey || remoteDraftState.status !== 'ready') return;
    replaceScope(mirrorScopeKey, remoteDraftState.value?.providerModelMemory);
  }, [mirrorScopeKey, remoteDraftState.status, remoteDraftState.value]);

  // 离开 / 切设备时清掉该 scope 的镜像(避免泄漏);仅随 scopeKey 变化触发,不在每次 push 时清。
  useEffect(() => {
    if (!mirrorScopeKey) return;
    return () => clearScope(mirrorScopeKey);
  }, [mirrorScopeKey]);

  // 订阅被控端草稿全量变更 push:被控端本地改 / 应用控制端写穿后回流 → 刷新 remoteDraftState
  // (驱动镜像 effect + 选中行还原)。控制端是纯显示,这里只更新显示态、不回写被控端。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) return;
    const vendorSlot = capabilityAgentKind === 'claude-code' ? 'claudeCode' : capabilityAgentKind;
    return window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (push.deviceId !== effectiveDeviceLinkDeviceId) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      if (push.channel !== 'maker:new-maker-draft:changed') return;
      const payload = push.payload as Record<string, RemoteDraftDefaults | undefined> | null;
      const next = payload?.[vendorSlot] ?? null;
      remoteDraftRevisionRef.current += 1;
      setRemoteDraftState({ status: 'ready', value: next });
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

  // ── worktree 勾选 = 工作端记忆的镜像(2026-07-29 用户裁决:状态只属于用户) ────
  // 本地草稿读本地 draft.worktreeEnabled;device-link 远程草稿只接受被控端明确返回的
  // boolean(remoteDraftState.value.worktreeEnabled,vendor 无关根字段)。同一设备重连时
  // 缺字段 / 拉取失败保留最后镜像;切到新设备时先回到默认未勾选。checkbox **原样直出**
  // 记忆——不做 baseRepo/资格点亮门槛、没有任何自动开关。环境合格性只影响
  // checkbox 禁用态；用户已勾选且当前项目尚不能创建 worktree 时，handleSend
  // 必须保留草稿并提示，不能静默创建普通 session，也不能改写用户记忆。
  useEffect(() => {
    if (!isDeviceLinkDraft) {
      setWtEnabled(draft.worktreeEnabled);
      return;
    }
    if (remoteDraftState.status !== 'ready') return;
    const remotePreference = remoteDraftState.value?.worktreeEnabled;
    if (typeof remotePreference === 'boolean') setWtEnabled(remotePreference);
  }, [isDeviceLinkDraft, draft.worktreeEnabled, remoteDraftState]);
  // 放在同步 effect 后面:切设备的首帧 remoteDraftState 可能仍属于上一台设备，
  // 先处理旧快照再重置，保证它不能把新设备的默认 false 覆盖回去。
  useEffect(() => {
    if (isDeviceLinkDraft) setWtEnabled(false);
  }, [isDeviceLinkDraft, effectiveDeviceLinkDeviceId]);

  // A device-link checkbox write remains a create gate until the controlled
  // endpoint's defaults mirror confirms the requested boolean. A mismatching
  // post-write snapshot does not make the old value safe: mark authority
  // unknown, keep Send/Goal fail-closed, but re-enable the checkbox for retry.
  useEffect(() => {
    const transaction = wtPreferenceTransactionRef.current;
    if (
      !transaction
      || !isDeviceLinkDraft
      || transaction.deviceId !== effectiveDeviceLinkDeviceId
      || remoteDraftState.status !== 'ready'
    ) return;
    const authoritative = remoteDraftState.value?.worktreeEnabled;
    if (typeof authoritative !== 'boolean') return;
    if (authoritative === transaction.enabled) {
      transaction.status = 'committed';
      wtPreferenceAuthorityUnknownRef.current = false;
      wtPreferenceCommittedValueRef.current = authoritative;
      setWtEnabled(authoritative);
      return;
    }
    if (transaction.status === 'writing') return;
    wtPreferenceAuthorityUnknownRef.current = true;
    wtPreferenceSavingRef.current = false;
    setWtPreferenceSaving(false);
  }, [
    isDeviceLinkDraft,
    effectiveDeviceLinkDeviceId,
    remoteDraftState,
  ]);

  // Do not release the synchronous create fence until React has committed the
  // authoritative checkbox value into wtRef. This closes the APPLY-resolved →
  // next-render gap for both local and device-link writes.
  useLayoutEffect(() => {
    const committed = wtPreferenceCommittedValueRef.current;
    if (committed === null || wtEnabled !== committed) return;
    wtPreferenceCommittedValueRef.current = null;
    wtPreferenceTransactionRef.current = null;
    wtPreferenceSavingRef.current = false;
    setWtPreferenceSaving(false);
  }, [wtEnabled]);

  // ── worktree 源分支 = 工作端 repo-scoped 偏好镜像 ─────────────────────
  // detect-cwd 给出 canonical baseRepo 后再读；本地走 preload，device-link 草稿走
  // 被控端同名 invoke。seq + target ref 保证切设备/项目后的旧回包不能复活旧分支。
  // 连接代次变化后先清掉读取 fence 再发 GET。新版 host 会持久化 revision，旧版
  // host 可能从 1 重来；控制端都不能只相信上一条连接留下的 snapshot。
  useLayoutEffect(() => {
    wtBranchReadSeqRef.current += 1;
    wtBranchSyncRef.current = null;
    setWtBranchSync(null);
    wtBranchPreferenceErrorRef.current = false;
    setWtBranchPreferenceError(false);
    setWtSourceBranch('');
  }, [effectiveDeviceLinkDeviceId, remoteDraftRefreshEpoch]);

  // 换设备才作废旧设备的 host write。仅同设备重连时不能提前解除 saving：
  // 旧 promise 仍可能在新链路落地，Send/Goal 必须一直等到它 settle。
  useLayoutEffect(() => {
    wtBranchWriteSeqRef.current += 1;
    wtBranchCommittedValueRef.current = null;
    wtBranchPreferenceSavingRef.current = false;
    setWtBranchPreferenceSaving(false);
    wtPreferenceWriteSeqRef.current += 1;
    wtPreferenceTransactionRef.current = null;
    wtPreferenceCommittedValueRef.current = null;
    wtPreferenceAuthorityUnknownRef.current = false;
    wtPreferenceSavingRef.current = false;
    setWtPreferenceSaving(false);
  }, [effectiveDeviceLinkDeviceId]);

  useEffect(() => {
    if (!wtBaseRepo) return;
    const target: DraftWorktreeBranchTarget = {
      deviceId: effectiveDeviceLinkDeviceId ?? null,
      baseRepo: wtBaseRepo,
    };
    const seq = ++wtBranchReadSeqRef.current;
    let cancelled = false;
    const loadingSnapshot: DraftWorktreeBranchSync = {
      deviceId: target.deviceId,
      baseRepo: wtBaseRepo,
      revision: -1,
      status: 'loading',
    };
    wtBranchSyncRef.current = loadingSnapshot;
    setWtBranchSync(loadingSnapshot);
    wtBranchPreferenceErrorRef.current = false;
    setWtBranchPreferenceError(false);
    const read = target.deviceId
      ? window.electronAPI.deviceLink.invoke(
          target.deviceId,
          'maker:get-new-maker-worktree-branch-pref',
          [{ baseRepo: wtBaseRepo }],
        )
      : window.electronAPI.getNewMakerWorktreeBranchPreference(wtBaseRepo);
    void read
      .then((snapshot) => {
        if (cancelled || seq !== wtBranchReadSeqRef.current) return;
        if (snapshot === null) {
          markWtBranchTargetReady(target);
          return;
        }
        if (acceptWtBranchSnapshot(target, snapshot)) return;
        // A push can land after GET starts and carry a newer host revision.
        // If so, a stale/malformed late GET has no authority to erase that
        // already-accepted snapshot or turn the target back into an error.
        const current = wtBranchSyncRef.current;
        if (
          current?.status === 'ready'
          && current.deviceId === target.deviceId
          && current.baseRepo === target.baseRepo
        ) return;
        // A non-null response that cannot be parsed/accepted is not the same
        // as "no saved preference". Treat malformed, wrong-repo or stale
        // snapshots as an unavailable authority and keep Worktree ON closed.
        wtBranchSyncRef.current = null;
        setWtBranchSync(null);
        wtBranchPreferenceErrorRef.current = true;
        setWtBranchPreferenceError(true);
      })
      .catch((error) => {
        if (cancelled || seq !== wtBranchReadSeqRef.current) return;
        const current = wtBranchSyncRef.current;
        if (
          current?.status === 'ready'
          && current.deviceId === target.deviceId
          && current.baseRepo === target.baseRepo
        ) return;
        // 只有被控端明确声明 channel 不存在时才走旧端兼容；超时、断链、
        // malformed response 等其它错误都保持未就绪，Worktree ON 创建必须阻塞。
        // 这条边界不能用「catch 全部都 ready」表达，否则一次瞬时断链就会
        // 静默拿当前 checkout 分支创建到错误的 worktree。
        if (isWorktreeBranchPreferenceChannelUnsupported(error)) {
          markWtBranchTargetReady(target);
          return;
        }
        wtBranchSyncRef.current = null;
        setWtBranchSync(null);
        wtBranchPreferenceErrorRef.current = true;
        setWtBranchPreferenceError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    wtBaseRepo,
    effectiveDeviceLinkDeviceId,
    remoteDraftRefreshEpoch,
    acceptWtBranchSnapshot,
    markWtBranchTargetReady,
  ]);

  // 当前电脑其它窗口 / mobile 控制端改分支后，本地 main 广播权威 snapshot。
  useEffect(() => window.electronAPI.onNewMakerWorktreeBranchChanged((snapshot) => {
    const target = wtBranchTargetRef.current;
    if (target.deviceId !== null || !target.baseRepo) return;
    acceptWtBranchSnapshot(target, snapshot);
  }), [acceptWtBranchSnapshot]);

  // device-link 草稿只接收当前目标设备转发的同名广播；payload 内 baseRepo + host
  // revision 仍交统一接受器校验，不能只凭 channel 就覆盖当前 UI。
  useEffect(() => window.electronAPI.deviceLink.onRemotePush((push) => {
    const target = wtBranchTargetRef.current;
    if (!target.deviceId || !target.baseRepo) return;
    if (push.deviceId !== target.deviceId) return;
    if (push.channel !== 'maker:new-maker-worktree-branch:changed') return;
    acceptWtBranchSnapshot(target, push.payload);
  }), [acceptWtBranchSnapshot]);

  // Keep the branch transaction fence until the accepted host source has
  // actually reached wtRef through a committed render.
  useLayoutEffect(() => {
    wtBranchRenderedValueRef.current = wtSourceBranch;
    const committed = wtBranchCommittedValueRef.current;
    if (committed === null || wtSourceBranch !== committed) return;
    wtBranchCommittedValueRef.current = null;
    wtBranchPreferenceSavingRef.current = false;
    setWtBranchPreferenceSaving(false);
  }, [wtSourceBranch]);

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
            ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
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
  //
  // ⚠️ **`target` 是给「这一次选择顺带写穿」用的**(2026-08-17 review):缺省分支从闭包读
  // `dlSel` / `capabilityAgentKind`,那是**上一次**渲染看到的运行配置。选中一行时
  // `setDlSel` 还没提交、跨引擎时 `switchVendor` 还在途,此刻读闭包会把**新模型**的
  // effort / Fast 以 active:true 写到**旧模型**(甚至旧引擎)的偏好上 —— 被控端那边看到的
  // 是「A 模型被改了档」。所以选中路径必须把本次 selection 的目标值显式传进来。
  const pushActiveDraftPref = useCallback(
    (
      patch: { effort?: Effort; fast?: boolean },
      /**
       * 本次写穿的显式目标(选中一行时 = 这次 selection 的目标配置);不传 = 沿用当前状态,
       * 既有调用点(handleEffortDidChange / handleFastModeChange)行为不变。
       */
      target?: {
        agent: MakerAgentKindWire;
        providerId: string | null;
        modelId: string;
        effort?: Effort;
      },
    ) => {
      if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) return;
      const model = target?.modelId ?? dlSel?.model ?? deviceLinkInitial?.model;
      if (!model) return;
      // 只改 Fast 时也要带上激活档(被控端 trigger 要更新激活 effort)。给了显式目标就**只**
      // 认目标自己的档:此刻 dlSel 里还是上一个模型的档,拿它顶上等于把 A 的档写到 B 头上;
      // 目标没档就整个不下发 effort,让被控端保留它为该模型记的那份。
      const activeEffort =
        patch.effort ??
        (patch.fast !== undefined
          ? target
            ? target.effort
            : (dlSel?.effort ?? deviceLinkInitial?.effort)
          : undefined);
      window.electronAPI.deviceLink
        .invoke(effectiveDeviceLinkDeviceId, 'maker:apply-new-maker-draft-pref', [
          {
            agent: target?.agent ?? capabilityAgentKind,
            // 显式目标里 providerId 可以是 null(跟随默认路由)—— 与「没给目标」区分开:
            // 前者落成空串(被控端 provider 层 no-op),后者才回落当前状态。
            providerId: target
              ? (target.providerId ?? '')
              : (dlSel?.providerId ?? deviceLinkInitial?.providerId ?? ''),
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
  // 这里的「默认」还必须覆盖 main 的 spawn-aware 语义:Claude OAuth 会话收到 providerId=null
  // 且存在 Gateway key 时会按 agent 默认走 XD,即使 XD 的动态目录并不提供当前模型。只比较
  // effectiveSourceIdForModel 的模型级默认会把这种分叉误判成「可安全省略」(issue #1196)。
  const localProviderIdForDraft = useMemo<string | null>(() => {
    return resolveDraftSessionProviderId({
      providers: localProviders,
      agent: capabilityAgentKind,
      model: calibratedDraftModel,
      explicitProviderId: chatPrefs.providerId,
      effectiveProviderId: effectiveSourceId,
    });
  }, [
    chatPrefs.providerId,
    effectiveSourceId,
    localProviders,
    calibratedDraftModel,
    capabilityAgentKind,
  ]);
  /**
   * 传给 ChatInput 的初始来源 / 「新建目标」实际提交的来源。
   *
   * 本机分支已经用 effectiveSourceIdForModel 校准过(见 localProviderIdForDraft);**device-link
   * 分支原来是原样透传** dlSel.providerId —— 那是个漏洞(Codex review P1):被控端把该来源断开 /
   * 移除、或它不再提供当前模型之后,这个值仍留在草稿里。普通发送不受影响(ChatInput 内部会用
   * effectiveSourceId 重算,失效即回落),但**「新建目标」是直接拿这个值提交给 maker:create-session**
   * 的 —— 于是会把一个未认证的来源写进 sessions.provider_id,新目标起不来。
   *
   * 所以在**派生处**统一校准,而不是在某个消费点补一次:用与 main 同源、且注释明确要求「新会话 /
   * 切模型 / worker / schedule 一律用」的 effectiveSourceIdForModel,按**被控端**目录 + 草稿当前
   * 模型复算。仍有效则原样保留;失效则落到被控端对该模型的原生默认来源 —— 这也正是 ChatInput 高亮
   * 给用户看的那一个,提交值与界面所见因此一致(比一律置 null 更贴合「所见即所得」)。
   * 目录尚未加载完时可能解析为 null,无害:发送 / 建目标都被 deviceProvidersLoading 三重 gate 挡着。
   */
  const chatInitialProviderId = useMemo<string | null>(() => {
    if (!isDeviceLinkDraft) return localProviderIdForDraft;
    return effectiveSourceIdForModel(
      deviceProviders,
      deviceLinkInitial?.providerId ?? null,
      draftInitialModel,
      capabilityAgentKind,
    );
  }, [
    isDeviceLinkDraft,
    localProviderIdForDraft,
    deviceProviders,
    deviceLinkInitial?.providerId,
    draftInitialModel,
    capabilityAgentKind,
  ]);

  // 收藏锚点的失效兜底:选中一条收藏后,如果草稿的 (模型, 来源) 又被别的路径改掉(引擎
  // 不可用 coerce、模型校准、浮层里换来源…),这个锚点就不再描述当前选择了 —— 靠**派生**让
  // 它不亮:比的是快照里的 (wire id, providerId) 与草稿当前值。wire id 不查收藏条目(它按
  // 归一化行 id 存,与草稿的 wire id 天生可能不等,见 draftFavoriteAnchor 的说明);
  // **来源必须比**(2026-08-19 review P1):同一 wire model 可来自多家供应商,只比 wire id,
  // device-link seed / 另一窗口把草稿从来源 A 切到同 wire model 的来源 B 后,旧锚点会继续
  // 勾着 A 的收藏并抑制 B 模型行的勾,之后编辑 / 删除的也是错误副本。引擎维度不必比:槽按
  // 引擎分,读到的本来就是当前引擎那一格。锚点指向的收藏被删 / 换账号后查无此条的情形,
  // 由面板侧 activeFavoriteUid 兜底。
  //
  // ★ 刻意**不做**「不符就把槽删掉」的清理 effect(2026-08-19 预审 P2-7):槽是持久化数据,
  // 而 draftInitialModel / chatInitialProviderId 存在瞬态窗口 —— device-link 草稿在被控端
  // seed 到达前暂用本地 chatPrefs 值,那一帧的失配会把用户真实的锚点**永久**删掉;两个窗口
  // (本地草稿 × 远程草稿)共用同一引擎槽时也会互删。派生「不符不亮」已保证不会勾错;
  // 显式选择(选普通模型行 → handleUnifiedDraftSelect 写 null)仍会清槽。留下的休眠锚点
  // 只在 (模型, 来源) 改回那一刻重新亮起 —— 那本来就是用户对该配置最后一次显式选中的副本。
  // 收藏是独立选中项(Chris 2026-08-20):勾选身份就是 uid,不拿草稿当前模型/来源去对
  // 快照 —— 对不上就不勾,等于让下面同名模型行把焦点抢走。草稿模型被 coerce / seed
  // 改走时收藏行仍是用户点过的那一条;显式点普通模型行才会经 handleUnifiedDraftSelect
  // 把槽写成 null。条目被删 / 换账号由面板 activeFavoriteUid 兜底。
  const selectedFavoriteUid = draftFavoriteAnchor?.uid ?? null;

  /**
   * 草稿锚点 → 会话锚点的**延续**(Chris 2026-08-19):草稿里选了收藏第 3 条、发出去建会话,
   * 会话侧的面板必须还勾在那一条上,否则「刚发完第一条消息,打开选单焦点又跑回模型行」——
   * 与本次要修的草稿侧症状是同一个,只是换了个时刻发生。
   *
   * 只在**有显式来源**时延续:会话侧的锚点校验拿
   * `sessionFavoriteAnchor.providerId === activeProviderId` 比,而跟随默认路由的会话
   * activeProviderId 为 null,与任何显式来源都不相等 —— 那种锚点存下去永远打不上勾,不如不存。
   * 模型也必须与本次真正提交的那一个逐字相等(各建会话路径提交的 model 未必等于
   * draftInitialModel,如 SSH 分支会另行解析)。
   */
  const draftFavoriteAnchorRef = useRef<DraftFavoriteAnchor | null>(null);
  draftFavoriteAnchorRef.current = selectedFavoriteUid ? draftFavoriteAnchor : null;
  const carryDraftFavoriteAnchorToSession = useCallback(
    (
      newSessionId: string,
      engine: 'cc' | 'codex' | 'pi',
      model: string,
      providerId: string | null,
    ): void => {
      const anchor = draftFavoriteAnchorRef.current;
      if (!anchor || !providerId) return;
      // (wire id, 来源) 都必须与**本次实际提交值**逐字相等(2026-08-19 review P1:来源也是
      // 锚点身份 —— 提交前的校准 / 重路由把来源换掉时,收藏副本描述的已不是提交出去的那份)。
      if (anchor.wireModelId !== model || anchor.providerId !== providerId) return;
      setSessionFavoriteAnchor(newSessionId, {
        uid: anchor.uid,
        wireModelId: anchor.wireModelId,
        engine,
        providerId,
      });
    },
    [],
  );

  /**
   * 把草稿转移到一个新的运行目标(设备 + 工作区)——**四条路径唯一的转移动作**。
   *
   * ## 为什么必须收成一个动作
   *
   * 「当前目标设备」这一个语义原先摊在 9 处平行状态里:draft store 的两个字段、dlSel、
   * remoteDraftState、dlSeedKeyRef、skipDefaultsRefetchRef、三个无 TTL 的设备快照缓存、
   * mirror scope、worktree 三态、以及草稿正文里那些绑着路径的 chip 与附件。而「换设备」这件事
   * 被实现了四遍:设备 pill、设备域浏览器选项目、工作区 picker、所选设备失效后的自动回落。
   *
   * 4 条路径 × 9 处状态 = 一张需要人工两两对齐的矩阵。#807 的 review 里有约十轮就是在补这张矩阵里
   * 的某一格:切设备漏清 worktree 三态、同机换项目误把运行配置打回默认、指向被控设备前忘了作废
   * 它的能力快照、回落到本机时两样清理都漏、picker 换项目不作废 worktree……每次都是同一件事只做了
   * 一部分,而且**漏掉一格不会有任何编译或测试信号**。
   *
   * 所以这里把副作用从「走了哪条路径」的函数改写成「**什么变了**」的函数:调用方只声明目标,
   * 每一处连带状态各自绑住它真正依赖的那一半。矩阵因此消失 —— 新增第五条路径时不需要重新对齐 9 格,
   * 它自动就是对的。
   *
   * ## 每处状态绑在哪一半上(这就是全部规则)
   *
   *   · mention chip —— 绑 **workingDir**(存项目相对路径),设备或项目任一变化都剥;
   *   · 路径型附件 —— 绑 **设备**(存绝对路径),同机换项目仍有效,不动;
   *   · 能力 / 供应商 / Git safety 快照 —— 绑**目标设备**,指过去之前一律作废(无 TTL,只在设备
   *     下线才 evict,那台机器在线期间装了新模型 / 断了供应商,控制端不会知道);
   *   · 远程运行配置(dlSel + remoteDraftState + seedKey)—— 绑**设备**;换机重种,同机保留但要按
   *     新能力重校(被控端可能刚删掉用户选中的模型);
   *   · worktree 三态 —— 绑 **(设备, 项目)** 二元组,等于绑 repo,任一变化都作废;
   *   · extraDirs —— 换设备失效(路径属于上一台),或进入「对话」时清零(那是单次授权、不是偏好)。
   *
   * ## 与收敛前的两处行为差异(都是修正,不是回归)
   *
   *   ① 同机从项目 X 换到项目 Y 现在**会**剥 mention chip。chip 存的是项目相对路径,换项目就是换
   *      解析基准(Codex review 第 29 轮)。
   *   ② 在浏览器里重选**当前正在用的同一个项目**不再关掉 worktree 开关。「只在真的变了时才重置」
   *      这条早先只补进了工作区 picker,浏览器那条路径漏了;统一之后两条都对。
   */
  const applyDraftTarget = useCallback(
    (req: DraftTargetRequest) => {
      const prevDeviceId = effectiveDeviceLinkDeviceId ?? null;
      const deviceChanged = req.deviceId !== prevDeviceId;
      const workingDirChanged = req.workingDir !== draft.workingDir;

      // chip 绑 workingDir;附件绑设备。两者条件不同,见各自函数的注释。
      if (deviceChanged || workingDirChanged) stripProjectRelativeMentions();
      if (deviceChanged) dropPathBackedAttachments();

      // 作废那三个无 TTL 快照 —— 但**不是**「指向设备就做」(Codex review 第 30 轮 P1,我上一轮
      // 收敛时写错的条件)。evict 不是幂等清理,而是一次**有副作用的状态转移**:它 notify
      // `{ status: 'loading' }` 让已挂载的 hook 立刻进入加载态,必须有配对的 fetch 才能收敛。
      // 而 useAgentCapabilities / useDeviceProviders 的 effect deps 是 `[agentKind, deviceId]`,
      // **不含项目** —— 于是同一台设备上换个项目时 evict 之后没有任何东西会去重拉:
      // capabilitiesLoading 永久为真,send / goal 的三重 gate 永久拒绝创建,用户必须切设备或
      // 重进路由才能恢复。这是功能完全阻塞。
      //
      // 正确的触发条件是「指向一台**新**设备」,或「用户主动重新验证了这台设备」——
      // 后者恰好等价于 remoteSnapshot 存在:只有设备域浏览器那条路径会带它,而它为了验证可达
      // 本来就 inline 拉过新的 capabilities / defaults,并在本动作之后紧接着 prefetch 补回 hook 缓存。
      // 换项目本身不改变那台设备的能力目录,所以工作区 picker 这条路径不该 evict。
      if (req.deviceId && (deviceChanged || req.remoteSnapshot)) {
        evictDeviceCapabilities(req.deviceId);
        evictDeviceProviders(req.deviceId);
        evictDeviceGitSafetySettings(req.deviceId);
      }

      // 远程运行配置。给了 snapshot 就当场定;没给且换了设备就打回未加载,由 seed effect 接手 ——
      // 不打回的话 seed effect 会拿**上一台**的 capabilities + defaults 种下 dlSel 并把新设备记成
      // 「已 seed」,等新设备真正的值到达时 seedKey 又把重种挡掉,于是向新设备提交上一台的配置。
      if (req.remoteSnapshot) {
        const { capabilities: freshCaps, defaults: freshDefaults } = req.remoteSnapshot;
        dlSeedKeyRef.current = req.deviceId ? `${req.deviceId}:${capabilityAgentKind}` : null;
        dlSeedCapabilitiesRef.current = freshCaps;
        if (deviceChanged) {
          setDlSel(
            resolveDeviceLinkDraftDefaults(
              freshCaps,
              freshDefaults,
              undefined,
              capabilityAgentKind,
            ),
          );
          dlRuntimeTouchedRef.current = false;
          // deviceId 变化会让 defaults effect 重跑;我们已经 inline 拉过了,跳过那一次避免覆盖。
          skipDefaultsRefetchRef.current = true;
        } else {
          // 同机:保留用户已选的 model / provider / effort / permission,但必须拿 freshCaps 重校一遍 ——
          // 上面刚把 seedKey 记成「已 seed」,后续 capabilities 更新不会再重种,失效值会一直留着:
          // 发送被 gate 拦住变成「点了没反应」,建目标更糟,会把失效值直接提交给被控端。
          // 复用 resolveDeviceLinkDraftDefaults(不另写 clamp):把用户当前选择塞进 remoteDraft 槽,
          // 它本就是「按 caps 校准一组值」,仍合法的原样保留、失效的按目标模型能力回落。
          setDlSel((prev) =>
            prev
              ? resolveDeviceLinkDraftDefaults(
                  freshCaps,
                  {
                    model: prev.model,
                    effort: prev.effort,
                    fastMode: prev.fastMode,
                    permissionMode: prev.permissionMode,
                    providerId: prev.providerId,
                  },
                  undefined,
                  capabilityAgentKind,
                )
              : resolveDeviceLinkDraftDefaults(
                  freshCaps,
                  freshDefaults,
                  undefined,
                  capabilityAgentKind,
                ),
          );
        }
        setRemoteDraftState({ status: 'ready', value: freshDefaults });
      } else if (deviceChanged) {
        setDlSel(null);
        dlSeedKeyRef.current = null;
        dlSeedCapabilitiesRef.current = null;
        dlRuntimeTouchedRef.current = false;
        setRemoteDraftState({ status: 'loading', value: null });
      }

      // worktree 三态 = 上一个 repo 的描述:baseRepo 由 detect-cwd 异步回填(远程还要走隧道往返),
      // 这个窗口内发送会把 worktree 建到上一个 repo 里;sourceBranch 只在为空时才自动填充,用户在
      // X 上显式选过的分支会一直跟到 Y —— Y 上不存在就报错,恰好存在就在一条毫不相关的分支上开工。
      if (deviceChanged || workingDirChanged) {
        // worktreeEnabled is the user's working-device preference, not repo metadata.
        // Keep it across target changes; only invalidate the probed repository/branch.
        wtBranchReadSeqRef.current += 1;
        wtBranchWriteSeqRef.current += 1;
        wtBranchPreferenceSavingRef.current = false;
        setWtBranchPreferenceSaving(false);
        wtBranchTargetRef.current = { deviceId: req.deviceId, baseRepo: null };
        wtBranchSyncRef.current = null;
        setWtBranchSync(null);
        wtBranchPreferenceErrorRef.current = false;
        setWtBranchPreferenceError(false);
        setWtBaseRepo(null);
        setWtSourceBranch('');
        setWtSupportsRecoveryKeyDiscard(null);
        setWtConfirmedIneligible(null);
      }
      if (deviceChanged) {
        // A checkbox write belongs to the previous work device. Invalidate its
        // renderer completion before the next device's mirror is seeded.
        wtPreferenceWriteSeqRef.current += 1;
        wtPreferenceSavingRef.current = false;
        setWtPreferenceSaving(false);
      }

      patchDraft({
        // 设备字段**必须显式带上**:store 的不变量是「改 workingDir 又不带设备字段就清设备」
        // (防本地项目被误当远程),不带就会在换项目时把设备悄悄清回本机。
        deviceLinkDeviceId: req.deviceId,
        deviceLinkDeviceName: req.deviceName,
        workingDir: req.workingDir,
        // device-link 与 SSH 互斥。
        remoteHostId: null,
        // 换设备 → 上一台的路径全失效;进「对话」→ 单次授权不该跨上下文延续。
        // 同机换项目时不传(store 保持原值):那些目录在这台机器上仍然有效。
        ...(deviceChanged || req.workingDir == null ? { extraDirs: [] } : {}),
      });
    },
    [
      effectiveDeviceLinkDeviceId,
      draft.workingDir,
      capabilityAgentKind,
      stripProjectRelativeMentions,
      dropPathBackedAttachments,
    ],
  );

  // “对话”分组可能在 /cc-agent/new 已经打开时再次导航到同一路由，组件不会 remount。
  // 目标因此随 location.state 交给本页消费，而不是让侧栏直接 patch device 字段；无论首次进入
  // 还是重复导航，local ↔ remote / remote A ↔ B / 项目 → 对话都统一经过 applyDraftTarget，
  // mention、路径型附件、远程运行配置和 worktree 三态才不会绕过集中迁移。
  useLayoutEffect(() => {
    if (
      !dialogueTargetRequest ||
      handledDialogueTargetRequestRef.current === dialogueTargetRequest.requestId
    ) {
      return;
    }
    handledDialogueTargetRequestRef.current = dialogueTargetRequest.requestId;
    // 同路由的对话目标是比在途目录恢复更新的用户选择。先推进同一 sequence owner，
    // 让旧 restore completion 只能释放锁，不能把目录重新写回草稿。
    modePickerSelectionSeqRef.current += 1;
    patchCollab({ enabled: false });
    applyDraftTarget({
      deviceId: dialogueTargetRequest.deviceId,
      deviceName: dialogueTargetRequest.deviceName,
      workingDir: null,
    });
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: consumeNewMakerDialogueTargetRequest(location.state),
    });
  }, [applyDraftTarget, dialogueTargetRequest, location, navigate]);

  // 弹窗确认添加后的落点:SSH 立即建会话 + navigate;device-link 把当前草稿指向被控端项目,
  // 首条消息发出时走既有 create-on-send 链路(见下方 isDeviceLinkDraft 分支)。
  const handleRemoteProjectAdded = useCallback(
    async (target: RemoteProjectTarget) => {
      // vendor 由外层 VendorSegmentedSwitcher (draft.vendor) 单一决策 —— dialog 不再让用户选。
      const draftVendor: 'cc' | 'codex' | 'pi' = normalizeDbAgentKind(draft.vendor);

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
          window.electronAPI.deviceLink.invoke(target.deviceId, 'maker:get-capabilities', [
            capabilityAgentKind,
          ]) as Promise<AgentCapabilities>,
          window.electronAPI.deviceLink.invoke(target.deviceId, 'maker:provider:list', []),
        ]);
        // 只有旧版被控端明确不支持 defaults channel 时才回落 capabilities 默认；网络失败
        // 仍然是连接失败，必须让 dialog 保持打开，不能把 null 当成权威空配置。
        const freshDefaults = await window.electronAPI.deviceLink
          .invoke(target.deviceId, 'maker:get-new-maker-defaults', [capabilityAgentKind])
          .then((v) => (v as RemoteDraftDefaults | null) ?? null)
          .catch((error) => {
            if (extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return null;
            throw error;
          });
        // 设备验证通过(direct invoke 成功)。转移只声明目标 —— 该清什么、该保留什么由
        // applyDraftTarget 按「设备变了还是项目变了」推导(它也负责作废该设备的三个无 TTL 快照,
        // 所以这一步必须排在下面的 prefetch 之前,否则刚 prefetch 的数据又被 evict 掉)。
        // 设备域的浏览器会预选当前设备,所以这条路径同时承担「换机器」与「同机换项目」两件事,
        // 而两者的差异现在完全由那个动作内部处理,这里不再各自判断。
        applyDraftTarget({
          deviceId: target.deviceId,
          deviceName: target.deviceName,
          workingDir: target.path,
          // 上面为验证可达已经 inline 拉过 capabilities 与 defaults,直接交给转移动作当场 seed /
          // 重校,省掉一次隧道往返;它同时会置 skip flag,避免 effect 再拉一次把值覆盖回去。
          remoteSnapshot: { capabilities: freshCaps, defaults: freshDefaults },
        });
        // prefetch 补回 hook 缓存:选的是**同一** deviceId 时 hook 的 effect 不会因 deps 变化重跑,
        // 只有 subscriber 通知路径能送达新数据。即使 prefetch 内部 swallow error,send / goal 的
        // capabilitiesLoading / deviceProvidersLoading gate 也会阻止在 hook 尚未就绪时发送。
        // gitSafety 一并补(第 32 轮):它的 evict 不 notify loading、不会卡住发送,但 effect deps
        // 同样是 `[deviceId]`,同设备不会自动重拉 —— 少这一个会让 Codex Rewind 入口一直隐藏。
        await Promise.all([
          prefetchDeviceCapabilities(target.deviceId),
          prefetchDeviceProviders(target.deviceId),
          prefetchDeviceGitSafetySettings(target.deviceId),
        ]);
        return;
      }

      // 轮 35 CRITICAL 移除:Pi 已支持 SSH 远端(pi-manager daemon + SshPiTransport,
      // startSession 全量支持 remoteHostId)。此前的「Pi 本地专属」fail-closed
      // 守卫与 dialog 的 SSH 过滤是过时逻辑 —— 后端早已装配 getRemotePiTransport
      // 等全套钩子, 守卫只会阻止用户创建远端 Pi 会话。远端不支持的子能力
      // (如 fork) 由各自入口 fail-closed, 不在会话创建层面整体拦截。

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
      // admissionFiltered:SSH 候选是「挑一个可路由模型」的清单,停用条目与能力模型
      // 不参与(降级兜底也不能落到停用模型上,PR #744 review)。
      const sshVisibleModels = deriveModelsFromProviders(sshConnected, capabilityAgentKind, {
        admissionFiltered: true,
      }).filter((m) => !isSubscriptionDirectModel(m.id));
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
        localProviders,
        rawProviderId,
        sshModel,
        capabilityAgentKind,
      );
      // 只有用户显式选中的来源在本地仍可用时才保留;否则 null = 走默认路由。
      const sshProviderId =
        rawProviderId && sshLocalSourceId === rawProviderId ? rawProviderId : null;
      // fast mode:来源不支持就关闭;支持时保留用户在 composer 里看到的 effectiveFastMode
      // (device-link 草稿活跃时来自 dlSel/deviceLinkInitial,本地草稿来自 per-model 记忆)。
      const sshSourceSupportsFast = sessionModelSupportsFastMode(
        localProviders,
        sshProviderId,
        sshModel,
        capabilityAgentKind,
      );
      const sshFastMode = sshSourceSupportsFast ? effectiveFastMode : false;
      // effort: 用 draftInitialEffort(用户在 composer 里看到的值)作 currentEffort,
      // 再由 resolveNewMakerDraftEffort 按本地 SSH model 支持的 levels 做 clamp。
      const sshLocalProvider = sshLocalSourceId
        ? localProviders.find((p) => p.id === sshLocalSourceId)
        : undefined;
      const sshLocalModelDesc = sshLocalProvider
        ? getModel(sshLocalProvider, sshModel, capabilityAgentKind)
        : undefined;
      const sshEffort = resolveNewMakerDraftEffort({
        currentEffort: draftInitialEffort,
        presetEffort: sshLocalSourceId
          ? getProviderModelEffort(capabilityAgentKind, sshLocalSourceId, sshModel)
          : undefined,
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
        // 草稿里选中的那条收藏跟着会话走(见 carryDraftFavoriteAnchorToSession)。
        carryDraftFavoriteAnchorToSession(newSession.id, draftVendor, sshModel, sshProviderId);
        if (effectivePlanMode) patchCurrentVendorPrefs({ planMode: false });
        makerChatStore.setSessionRuntime(newSession.id, {
          agentKind: dbToMakerAgentKind(draftVendor),
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
          cleanupStagedChatAttachmentFiles(
            existingDraft.attachments.filter((attachment) => attachment.category !== 'image'),
          );
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
        // F-COLLAB: draft 阶段开了协同模式 → 与 send/goal 路径同口径,
        // createSession 后立刻 enableOrca 拉起 Worker;失败 toast 但保留
        // Lead 会话继续 navigate (用户可继续单 session, 不阻断)。
        let orcaWorkersRevealState: { focusWorkerSessionId: string } | null = null;
        if (effectiveCollab.enabled) {
          try {
            const result = await window.electronAPI.maker.enableOrca(
              newSession.id,
              draftEnableOrcaOptions(effectiveCollab, localProviders, !localProvidersLoading),
            );
            orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };
          } catch (err) {
            log.error('[add remote project] enableOrca failed (continuing as single session)', err);
            toast.error(
              getCollaborationStartErrorMessage(err, t, { continueAsSingleSession: true }),
            );
          }
        }
        navigate(`/cc-agent/${newSession.id}`, {
          replace: true,
          state: orcaWorkersRevealState ? { orcaWorkersReveal: orcaWorkersRevealState } : undefined,
        });
      } catch (err) {
        log.error('[add remote project]', err);
        throw err;
      }
    },
    [
      draft.vendor,
      chatPrefs,
      chatInitialPermissionMode,
      chatInitialProviderId,
      draftInitialModel,
      draftInitialEffort,
      effectiveFastMode,
      effectiveDeviceLinkDeviceId,
      localProviders,
      localProvidersLoading,
      effectiveCollab,
      capabilityAgentKind,
      effectivePlanMode,
      attachmentState,
      applyDraftTarget,
      createSession,
      carryDraftFavoriteAnchorToSession,
      navigate,
      t,
    ],
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

  // 当前草稿选中的 vendor 变为不可用(如 Pi 未注册 / 被控端无 Pi)时,coerce 到首个可用来源
  // (优先 cc),避免 tablist 卡在被隐藏段、且防止创建出注定 requireAgent 报错的会话。
  // 只在已加载可用性后收敛;fallback 一定可见,收敛一次即稳定(switchVendor 同值早返,不成环)。
  useEffect(() => {
    if (!availableAgentsLoaded) return;
    if (!hiddenSwitcherVendors.includes(draft.vendor)) return;
    const fallback = (['cc', 'codex', 'pi'] as const).find((vendor) =>
      availableVendors.has(vendor),
    );
    if (fallback && fallback !== draft.vendor) handleVendorChange(fallback);
  }, [
    availableAgentsLoaded,
    hiddenSwitcherVendors,
    availableVendors,
    draft.vendor,
    handleVendorChange,
  ]);

  // ─── 用户在 ChatInput 改 model/effort/permission 后,落进当前 vendor 的 prefs ──
  const patchActivePrefs = useCallback((patch: Partial<VendorPrefs>) => {
    patchCurrentVendorPrefs(patch);
  }, []);

  const handleModelDidChange = useCallback(
    (newModelId: string) => {
      if (isDeviceLinkDraft) {
        dlRuntimeTouchedRef.current = true;
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
        dlRuntimeTouchedRef.current = true;
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
        dlRuntimeTouchedRef.current = true;
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
        dlRuntimeTouchedRef.current = true;
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
        dlRuntimeTouchedRef.current = true;
        setDlSel((prev) => (prev ? { ...prev, providerId: newProviderId } : prev));
        return;
      }
      patchActivePrefs({ providerId: newProviderId });
    },
    [isDeviceLinkDraft, patchActivePrefs],
  );

  // ─── 统一模型选择器:一次选中 = 一次完整写入 ─────────────────────────────
  // (model-selector-unified §2.4 / M5)
  //
  // 面板里的一行自带引擎(推荐 ⊕ 用户 override ⊕ 收藏副本),所以选中要连引擎一起落。
  // 顺序是硬要求:**先 switchVendor,再写 pref** —— patchVendorPrefs 按 vendor 分槽,
  // 反过来会把目标行写进上一个引擎的槽里,切回去时才发现模型串了。
  //
  // 深度 / Fast 的每模型记忆已由 ChatInput 按目标引擎槽写过(见 onUnifiedDraftSelect
  // 的 prop 说明);这里只负责草稿自身的四元组 (vendor, model, effort, providerId)。
  //
  // **id 口径**:`selection.modelId` 已经是选中引擎的 **wire model id**(上游 ModelSelector
  // 统一分支按 `capabilities[engine].wireModelId` 交出来的)。草稿里存的、createSession 发出去
  // 的、providerModelMemory 里当键的,全是它。行的归一化 id 只是面板内部的行身份,**一律不进
  // 草稿** —— 写错这一格的后果不是显示难看,是首条请求路由到一个不存在的 model id。
  const handleUnifiedDraftSelect = useCallback(
    (selection: {
      vendor: MakerVendor;
      providerId: string;
      /** 选中引擎的 **wire model id**(不是行的归一化 id)。 */
      modelId: string;
      effort?: Effort;
      fast: boolean;
      favoriteUid: string | null;
    }) => {
      // 收藏锚点写进**目标引擎的槽**(Chris 2026-08-19 起持久化,见 draftFavoriteAnchor 的
      // 说明):记的是 uid + **本次写进草稿的 wire id**,失效判定才有可比的同类值。
      // 换账号 / 换设备不必在这里补清理 —— 槽本身按 dataOwnerId 分区,面板侧另有一道兜底:
      // uid 在当前 owner 的收藏里查不到就自动回落模型行(UnifiedModelPanel.activeFavoriteUid)。
      // 选普通模型行(favoriteUid 为 null)= 清掉该引擎的槽。
      setDraftFavoriteAnchor(
        normalizeDbAgentKind(selection.vendor),
        selection.favoriteUid
          ? {
              uid: selection.favoriteUid,
              wireModelId: selection.modelId,
              // 来源也是锚点身份(2026-08-19 review P1):同 wire model 换来源后旧锚点不得再亮。
              providerId: selection.providerId,
            }
          : null,
      );
      if (selection.vendor !== draft.vendor) switchVendor(selection.vendor, currentPrefs);
      if (isDeviceLinkDraft) {
        dlRuntimeTouchedRef.current = true;
        // ★ 跨引擎选择必须**前置**把 seed key 推到目标引擎(2026-08-17 review 第三轮 G1)。
        //
        // 病根:上面的 switchVendor 改了 draft.vendor → 下一次渲染 capabilityAgentKind 跟着变 →
        // 播种 effect 看到 `${deviceId}:${capabilityAgentKind}` 这个 key 与 dlSeedKeyRef 不等,
        // 按 shouldReseedDeviceLinkDraftDefaults 的第一条(新目标一律重种)**无条件**拿目标引擎的
        // 被控端远程默认值重播种 —— 用户刚点选的 selection.modelId 当场被覆盖,建出来的远程任务
        // 用的不是他选的模型。
        //
        // 修法是让「这次显式选择」本身成为新引擎的 seed:key 按播种 effect 的构造**逐字一致**地
        // 前置写进 ref,于是那次 effect 走的是「同一目标」分支;dlRuntimeTouchedRef 已置 true,
        // 目标引擎 capabilities 到达时只做合法性夹紧(保留 current.model),不再换成区域默认。
        // 重复渲染 / 重复播种窗口一并覆盖:key 一旦被显式选择占住,后续每一帧都判成同一目标。
        // 同引擎分支 key 不变,本就不会进入重播种(同样由 controllerTouched 挡住能力刷新重校)。
        if (effectiveDeviceLinkDeviceId) {
          dlSeedKeyRef.current = `${effectiveDeviceLinkDeviceId}:${dbToMakerAgentKind(
            normalizeDbAgentKind(selection.vendor),
          )}`;
        }
        setDlSel((prev) => {
          const previous = prev ?? deviceLinkInitial;
          // 与 handleModelDidChange 的远程分支同一条口径:换模型必须按**目标模型**重新解析
          // 被控端记的 effort / fast(per-model 记忆 + `${agent}:*` 全局预设 + 目标模型的
          // efforts 校验),不能沿用上一个模型的档 —— 沿用会把 A 模型的 high 原样带到只
          // 支持 low 的 B 模型上,再被兜底成一个用户没选过的字面量。面板显式给出的
          // effort / fast 是这次选择的一部分,叠在基线之上。
          const baseline = capabilities
            ? resolveDeviceLinkDraftDefaults(
                capabilities,
                remoteDraftState.value ?? previous,
                selection.modelId,
                capabilityAgentKind,
              )
            : previous;
          // 能力与镜像都还没到:推不出任何一档,保持原状而不是编一个默认值。
          if (!baseline) return previous;
          return {
            ...baseline,
            // 用户在面板里点的就是这一行:即便它不在被控端拍平 availableModels 里(基线会
            // clamp 到 models[0]),也不替他改选。
            model: selection.modelId,
            ...(selection.effort ? { effort: selection.effort } : {}),
            fastMode: selection.fast,
            // permissionMode 不按模型记:控制端已有的显式选择优先于基线重算。
            ...(previous?.permissionMode !== undefined
              ? { permissionMode: previous.permissionMode }
              : {}),
            providerId: selection.providerId,
          };
        });
        // 选中模型的 effort/fast 写穿被控端(active=true):与既有 handleEffortDidChange /
        // handleFastModeChange 同一条通道,缺了它被控端 trigger 的激活档不会跟着变。
        //
        // ★ 目标必须**显式**给(2026-08-17 review):上面的 setDlSel 还没提交,此刻
        // pushActiveDraftPref 从闭包读到的 dlSel / capabilityAgentKind 都还是**上一次**的
        // 运行配置 —— 同引擎 A 切 B 会把 B 的 effort / Fast 以 active:true 写到 **A** 的偏好上;
        // 跨引擎连 agent 都是旧的(switchVendor 在途,capabilityAgentKind 下一帧才跟上)。
        // 口径与 handleModelDidChange 的远程分支一致:换模型一律按**目标模型 / 目标引擎**走。
        pushActiveDraftPref(
          {
            ...(selection.effort ? { effort: selection.effort } : {}),
            fast: selection.fast,
          },
          {
            agent: dbToMakerAgentKind(normalizeDbAgentKind(selection.vendor)),
            providerId: selection.providerId,
            modelId: selection.modelId,
            ...(selection.effort ? { effort: selection.effort } : {}),
          },
        );
        return;
      }
      // 本地草稿:一次写进目标 vendor 的槽。走 patchVendorPrefs(不是 Preserving 版)——
      // 这是用户在 New Maker picker 里的**显式**模型选择,modelChosenByVendor 必须打标
      // (scheduler 的成本兜底默认模型依赖它)。
      patchVendorPrefs(selection.vendor, {
        model: selection.modelId,
        providerId: selection.providerId,
        ...(selection.effort ? { effort: selection.effort } : {}),
      });
    },
    [
      draft.vendor,
      currentPrefs,
      isDeviceLinkDraft,
      effectiveDeviceLinkDeviceId,
      deviceLinkInitial,
      capabilities,
      remoteDraftState,
      capabilityAgentKind,
      pushActiveDraftPref,
    ],
  );

  // ─── 用户改 workingDir(FolderPicker)→ 写回 draft ─────────────────────
  // picker 选 "对话(不在项目中)" 时 dir=null,此时一并清掉 extraDirs,行为对齐
  // 侧边栏 DialogueSection 的 handleCreateDialogue —— 进入对话草稿不应保留
  // 上一个项目的 extra 目录上下文。
  //
  // 刻意**不动** deviceLinkDeviceId(#807):设备是独立的一级维度,由设备 pill 掌管;
  // 这里只在「当前设备」的语境内换工作区。所以选「对话」= 在当前设备上开不绑项目的对话,
  // 而不是退回本机 —— 后者由设备 pill 选「本机」来表达。picker 现在只列当前设备的项目,
  // 传进来的 path 必然属于当前设备,语义自洽。
  const handleWorkingDirChange = useCallback(
    (dir: string | null) => {
      // 设备维度不动:原样回传当前设备,于是 applyDraftTarget 判出 deviceChanged=false,只处理
      // 「换项目」该连带的部分(剥项目相对的 mention chip、作废 worktree 三态、进「对话」时清
      // extraDirs),不会去动运行配置、附件和设备快照。picker 列的项目本就属于当前设备,语义自洽。
      applyDraftTarget({
        deviceId: draft.deviceLinkDeviceId,
        deviceName: draft.deviceLinkDeviceName,
        workingDir: dir,
      });
    },
    [applyDraftTarget, draft.deviceLinkDeviceId, draft.deviceLinkDeviceName],
  );

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
    // 打开项目 picker 时收掉设备 picker(两个 popover 都是 absolute 浮层,会互相遮挡)。
    if (open) setDevicePickerOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (
      !folderPickerRequest ||
      handledFolderPickerRequestRef.current === folderPickerRequest.requestId
    ) {
      return;
    }
    handledFolderPickerRequestRef.current = folderPickerRequest.requestId;
    setFolderPickerOpen(true);
    setDevicePickerOpen(false);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: consumeNewMakerFolderPickerRequest(location.state),
    });
  }, [folderPickerRequest, location, navigate]);
  const handleDevicePickerOpenChange = useCallback((open: boolean) => {
    setDevicePickerOpen(open);
    if (open) setFolderPickerOpen(false);
  }, []);
  useEffect(
    () => () => {
      modePickerSelectionSeqRef.current += 1;
    },
    [],
  );
  /**
   * 选中的设备真正从可选列表里消失时(对方撤销「允许被控」/ 本机关掉对它的控制 / 解除配对),
   * 把草稿收敛回本机。
   *
   * 不这么做的后果:pill 上显示的是一个已经不可用的目标,而草稿里还留着那个 deviceId 并会据此
   * 走远程 create-session —— 要么失败,要么在旧设备上建出会话,和界面显示完全不符。
   *
   * 判据是 `loaded`(拉到过权威快照)而**不是**「列表非空」:
   *   - 唯一配对的对端被解除配对 / 关掉被控时,列表会合法地变成空。若按「非空」gate,这条回落
   *     永远不触发 —— pill 因为没设备而消失,草稿却还指着那台机器,每次发送都发去它,
   *     用户在 UI 上再也切不回本机(codex review 抓到的);
   *   - 反过来,首帧未就绪或 device-link 不可用(listDevices 抛错)时的空不置 loaded,不作数,
   *     避免一次抖动就把用户刚选好的设备抹掉;
   *   - 离线设备仍留在列表里(见 isSelectableDevice),所以单纯掉线不会误触发这条。
   */
  useEffect(() => {
    if (!effectiveDeviceLinkDeviceId) return;
    if (!selectableDevicesLoaded) return;
    if (selectableDevices.some((d) => d.deviceId === effectiveDeviceLinkDeviceId)) return;
    log.warn('[new-maker] selected device is no longer selectable, falling back to local');
    // 回落 = 转移到「本机 + 对话」。这条路径原先要自己重复一遍所有清理,而且历史上正是它漏得最多
    // (chip、附件、worktree 三态都各漏过一次),还隐式依赖 seed effect 的 !isDeviceLinkDraft 分支
    // 去清远程运行配置 —— 能跑,但没人能一眼看出为什么。现在与另三条路径走同一个动作。
    applyDraftTarget({ deviceId: null, deviceName: null, workingDir: null });
  }, [effectiveDeviceLinkDeviceId, selectableDevices, selectableDevicesLoaded, applyDraftTarget]);

  // 创建目标正在异步提交时，发送、建目标以及设备／工作区切换必须共用同一把锁。
  // ref 负责同步 guard，state 只负责驱动 UI 禁用；所有写入都经 markSendInFlight，
  // 避免其中一半提前释放后让旧草稿目标被消费。
  const sendInFlightRef = useRef(false);
  const [sendInFlight, setSendInFlight] = useState(false);
  const markSendInFlight = useCallback((value: boolean) => {
    sendInFlightRef.current = value;
    setSendInFlight(value);
  }, []);

  /**
   * 换设备(#807)。**一并清掉 workingDir 与 extraDirs** —— 上一台机器的路径在新机器上
   * 基本不存在,留着会让用户以为项目跟过来了,发送时才在被控端 path guard 上失败。
   * 换完停在这台设备的「对话」,与 mobile 切设备后工作区回落的行为一致。
   */
  const handleDeviceChange = useCallback(
    (deviceId: string | null, deviceName: string | null) => {
      // 发送已经在途时拒绝换设备:那次调用的闭包持有旧设备,而 draft 会可见地切到新设备 ——
      // 结果会话建在旧设备上、导航过去,同时把用户刚选的新设备上下文重置掉。ref 在这里是必需的
      // (它即时可读,不像 state 要等下一次渲染);pill 也会用同步的 sendInFlight 禁用,双保险。
      if (sendInFlightRef.current) return;
      // 点已选中的那一行(包括本机时点「本机」)只是确认当前选择,不该有任何副作用。
      // 下面会剥 mention chip、丢路径型附件并清 workingDir / extraDirs —— 重选同一设备时执行这些,
      // 等于用户点一下就静默丢掉已选的项目、附件和部分已写好的消息。必须先早返回。
      if (deviceId === (effectiveDeviceLinkDeviceId ?? null)) return;
      // 换完停在这台设备的「对话」(workingDir=null):上一台的项目路径在新机器上基本不存在,
      // 留着会让用户以为项目跟过来了、发送时才在被控端 path guard 上失败。与 mobile 切设备后
      // 工作区回落的行为一致。其余连带清理全部由 applyDraftTarget 按「设备变了」推导。
      //
      // 与「添加远程项目」那条路径的一点刻意差异:这里**不做**阻塞式 direct invoke 验证 ——
      // pill 只让在线设备可选,而它是同步回调,为验证改成异步会让点击后一段时间毫无反馈。
      // 快照未就绪期间由 send / goal 的 capabilitiesLoading / deviceProvidersLoading /
      // remoteDraftState.status 三重 gate 兜住。也因此不必 prefetch:上面已把「重选同一设备」
      // 早返回掉,deviceId 必然变化 → hook effect 必然重跑 → evict 后必然 cache miss 并自行 fetch。
      applyDraftTarget({ deviceId, deviceName, workingDir: null });
    },
    [effectiveDeviceLinkDeviceId, applyDraftTarget],
  );
  const handleOpenRemoteProject = useCallback((deviceId?: string) => {
    setAddRemoteProjectDeviceId(deviceId ?? null);
    setAddRemoteProjectOpen(true);
  }, []);
  /**
   * 选工作区。设备维度已经由设备 pill 定好(#807 方案 B),所以这里**只换 workingDir** ——
   * 不再需要「选中远程行 → 异步切设备」那套隧道往返,也因此不再需要期间禁用输入框。
   * picker 里列的项目必然属于当前设备,path 直接写进 draft 即可。
   */
  const handleModePickerSelect = useCallback(
    async (path: string, source: FolderPickerSelectSource) => {
      // 与设备 pill 同款保护:发送已在途时那次调用的闭包持有旧工作区,draft 却会可见地切到
      // 新的 —— 会话建在旧工作区里,而用户刚选的那个又被 create 后的重置清掉。
      if (sendInFlightRef.current) return;
      // 只有真正接受的选择才能作废上一轮。若锁已占用却先递增，第二次点击会同时被拒绝、
      // 又让第一轮完成后命中 sequence fence，最终两个选择都不生效。
      const selectionSeq = ++modePickerSelectionSeqRef.current;
      // 本机项目可能曾被用户「从侧栏移除」:任务和 workingDir 仍在,但 hidden overlay
      // 会把它们投影到「对话」。旧段头「新建项目」按钮会在重选目录时解除隐藏；按钮移除后
      // 创建页必须接过这条恢复路径。远程项目由各自设备维护可见性,纯对话也没有项目可恢复。
      if (source !== 'dialogue' && !effectiveDeviceLinkDeviceId) {
        const localProjectKey = normalizeProjectKey(path);
        if (localProjectKey?.startsWith('local:')) {
          // 恢复和草稿目标应用是一笔提交：期间复用创建锁，阻止 Send / Goal 或其它目标切换
          // 消费旧 workingDir。锁保持到新目标同步写入完成，reject / fence 早退也由 finally 释放。
          markSendInFlight(true);
          try {
            // Selecting a folder commits its project restoration. The fence below only prevents
            // an older async completion from overwriting a newer draft target; rolling shared
            // visibility back could re-hide a project restored by another window.
            await requestSidebarProjectRestore(localProjectKey);
            // 恢复在途期间手动发送和目标切换都被同一把锁挡住；这里仍保留 sequence / device
            // fence，覆盖卸载与权威设备状态变化等不经过交互 handler 的路径。
            if (
              selectionSeq !== modePickerSelectionSeqRef.current ||
              (getDraft().deviceLinkDeviceId ?? null) !== null
            ) {
              return;
            }
            handleWorkingDirChange(path);
          } catch (err) {
            log.warn('[new-maker] restore selected project failed', err);
            toast.error(t('ccAgent.sidebar.createProjectFailed'));
          } finally {
            markSendInFlight(false);
          }
          return;
        }
      }
      handleWorkingDirChange(source === 'dialogue' ? null : path);
    },
    [effectiveDeviceLinkDeviceId, handleWorkingDirChange, markSendInFlight, t],
  );

  // 用户点击 checkbox 是唯一改动路径。本地草稿直接写工作端偏好;
  // device-link 草稿先把操作交给被控端,只有被控端接受后才更新控制端
  // 显示镜像。分支、项目和资格变化都不能调用此回调。
  const handleWtEnabledChange = useCallback((enabled: boolean) => {
    if (sendInFlightRef.current) return;
    const writeSeq = ++wtPreferenceWriteSeqRef.current;
    wtPreferenceAuthorityUnknownRef.current = false;
    wtPreferenceCommittedValueRef.current = null;
    wtPreferenceSavingRef.current = true;
    setWtPreferenceSaving(true);
    if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {
      remoteDraftRevisionRef.current += 1;
      wtPreferenceTransactionRef.current = {
        seq: writeSeq,
        deviceId: effectiveDeviceLinkDeviceId,
        enabled,
        status: 'writing',
      };
      // Serialize host writes so A → B clicks cannot arrive at the host in the
      // opposite order. The sequence fence then ignores an old completion that
      // races a newer remote push.
      const invoke = () => window.electronAPI.deviceLink.invoke(
        effectiveDeviceLinkDeviceId,
        'maker:apply-new-maker-worktree-pref',
        [{ worktreeEnabled: enabled }],
      );
      const write = wtPreferenceWriteChainRef.current
        .catch(() => undefined)
        .then(invoke);
      wtPreferenceWriteChainRef.current = write.catch(() => undefined);
      void write
        .then(() => {
          const transaction = wtPreferenceTransactionRef.current;
          if (
            wtPreferenceWriteSeqRef.current !== writeSeq
            || transaction?.seq !== writeSeq
          ) return;
          // Main accepted the invoke, but the controlled renderer persists the
          // preference after receiving a broadcast. Invalidate overlapping
          // defaults GETs and keep the bidirectional create gate until a push
          // or a fresh GET observes the requested boolean.
          transaction.status = 'reconciling-success';
          remoteDraftRevisionRef.current += 1;
          setRemoteDraftState((previous) => ({
            status: 'loading',
            value: previous.value,
          }));
          setRemoteDraftRetryEpoch((value) => value + 1);
        })
        .catch((error) => {
          const transaction = wtPreferenceTransactionRef.current;
          if (
            wtPreferenceWriteSeqRef.current !== writeSeq
            || transaction?.seq !== writeSeq
          ) return;
          if (isWorktreeBranchPreferenceChannelUnsupported(error)) {
            // Old endpoints cannot persist this preference. Preserve the old
            // value for ON, but still provide an explicit OFF escape from a
            // remembered ON mirror (same compatibility boundary as mobile).
            if (!enabled) {
              transaction.status = 'committed';
              wtPreferenceCommittedValueRef.current = false;
              setWtEnabled(false);
            } else {
              wtPreferenceTransactionRef.current = null;
              wtPreferenceSavingRef.current = false;
              setWtPreferenceSaving(false);
            }
            return;
          }
          // Timeout/disconnect may have committed remotely. Re-read host
          // authority after the invoke settles; until then both ON→OFF and
          // OFF→ON remain blocked from Send/Goal.
          transaction.status = 'reconciling-unknown';
          wtPreferenceAuthorityUnknownRef.current = true;
          wtPreferenceSavingRef.current = false;
          setWtPreferenceSaving(false);
          remoteDraftRevisionRef.current += 1;
          setRemoteDraftState((previous) => ({
            status: 'loading',
            value: previous.value,
          }));
          setRemoteDraftRetryEpoch((value) => value + 1);
        });
      return;
    }
    wtPreferenceCommittedValueRef.current = enabled;
    setWtEnabled(enabled);
    setWorktreePreference(enabled);
  }, [isDeviceLinkDraft, effectiveDeviceLinkDeviceId]);
  const handleWtSourceBranchChange = useCallback((sourceBranch: string) => {
    if (sendInFlightRef.current) return;
    const normalized = sourceBranch.trim();
    const target = wtBranchTargetRef.current;
    // GET 尚未完成时分支区会被禁用，但 React 提交 disabled 前的同一 tick 仍可能送达旧事件；
    // 同步忽略，避免它抢在权威 repo 偏好返回前覆盖已保存的选择。
    if (!normalized || !target.baseRepo || wtBranchPreferenceLoadingRef.current) {
      return;
    }
    wtBranchCommittedValueRef.current = null;
    const branchSyncAtStart = wtBranchSyncRef.current;
    const revisionAtStart = branchSyncAtStart
      && branchSyncAtStart.deviceId === target.deviceId
      && branchSyncAtStart.baseRepo === target.baseRepo
      ? branchSyncAtStart.revision
      : -1;

    const writeSeq = ++wtBranchWriteSeqRef.current;
    wtBranchPreferenceSavingRef.current = true;
    setWtBranchPreferenceSaving(true);
    wtBranchPreferenceErrorRef.current = false;
    setWtBranchPreferenceError(false);

    const invoke = () => target.deviceId
      ? window.electronAPI.deviceLink.invoke(
        target.deviceId,
        'maker:apply-new-maker-worktree-branch-pref',
        [{ baseRepo: target.baseRepo, sourceBranch: normalized }],
      )
      : window.electronAPI.applyNewMakerWorktreeBranchPreference(
        target.baseRepo!,
        normalized,
      );
    const apply = wtBranchWriteChainRef.current
      .catch(() => undefined)
      .then(invoke);
    wtBranchWriteChainRef.current = apply.catch(() => undefined);
    void apply
      .then((snapshot) => {
        if (writeSeq !== wtBranchWriteSeqRef.current) return;
        const parsedSnapshot = parseDraftWorktreeBranchSnapshot(snapshot);
        const accepted = acceptWtBranchSnapshot(target, snapshot);
        if (
          accepted
          && parsedSnapshot!.sourceBranch === normalized
          && parsedSnapshot!.revision > revisionAtStart
        ) {
          armWtBranchCommittedValue(normalized);
          return;
        }
        const current = wtBranchSyncRef.current;
        if (
          current?.status === 'ready'
          && current.deviceId === target.deviceId
          && current.baseRepo === target.baseRepo
          && current.revision > revisionAtStart
          && current.sourceBranch === normalized
        ) {
          armWtBranchCommittedValue(normalized);
          return;
        }
        // A newer snapshot for another branch is still useful as the next
        // retry's revision floor, but it cannot confirm this write. Keep the
        // requested value visible and Worktree ON fail-closed until the user
        // explicitly retries and host authority observes this exact branch.
        setWtSourceBranch(normalized);
        wtBranchPreferenceErrorRef.current = true;
        setWtBranchPreferenceError(true);
      })
      .catch((error) => {
        if (writeSeq !== wtBranchWriteSeqRef.current) return;
        const current = wtBranchSyncRef.current;
        if (
          current?.status === 'ready'
          && current.deviceId === target.deviceId
          && current.baseRepo === target.baseRepo
          && current.revision > revisionAtStart
          && current.sourceBranch === normalized
        ) {
          armWtBranchCommittedValue(normalized);
          return;
        }
        // 只有结构化 CHANNEL_NOT_ALLOWED 才允许旧端兼容：本次选择留在
        // 当前草稿内存中，不冒充 host 已持久化。其它错误保持 fail-closed,
        // Worktree ON 的 Send/Goal 会继续阻塞并允许用户重试。
        if (isWorktreeBranchPreferenceChannelUnsupported(error)) {
          if (sameDraftWorktreeBranchTarget(target, wtBranchTargetRef.current)) {
            setWtSourceBranch(normalized);
            markWtBranchTargetReady(target);
            armWtBranchCommittedValue(normalized);
          }
          return;
        }
        setWtSourceBranch(normalized);
        wtBranchPreferenceErrorRef.current = true;
        setWtBranchPreferenceError(true);
      })
      .finally(() => {
        if (writeSeq !== wtBranchWriteSeqRef.current) return;
        if (wtBranchCommittedValueRef.current !== null) return;
        wtBranchPreferenceSavingRef.current = false;
        setWtBranchPreferenceSaving(false);
      });
  }, [acceptWtBranchSnapshot, armWtBranchCommittedValue, markWtBranchTargetReady]);
  const handleWtBaseRepoChange = useCallback((baseRepo: string | null) => {
    const nextTarget: DraftWorktreeBranchTarget = {
      deviceId: effectiveDeviceLinkDeviceId ?? null,
      baseRepo,
    };
    if (
      wtBaseRepo === baseRepo
      && sameDraftWorktreeBranchTarget(nextTarget, wtBranchTargetRef.current)
    ) return;
    wtBranchReadSeqRef.current += 1;
    wtBranchWriteSeqRef.current += 1;
    wtBranchCommittedValueRef.current = null;
    wtBranchPreferenceSavingRef.current = false;
    setWtBranchPreferenceSaving(false);
    wtBranchTargetRef.current = nextTarget;
    wtBranchSyncRef.current = null;
    setWtBranchSync(null);
    wtBranchPreferenceErrorRef.current = false;
    setWtBranchPreferenceError(false);
    setWtSourceBranch('');
    setWtBaseRepo(baseRepo);
  }, [effectiveDeviceLinkDeviceId, wtBaseRepo]);
  const handleWtRecoveryKeyDiscardSupportChange = useCallback((supported: boolean | null) => {
    setWtSupportsRecoveryKeyDiscard(supported);
  }, []);
  const handleWtConfirmedIneligibleChange = useCallback((confirmed: boolean | null) => {
    setWtConfirmedIneligible(confirmed);
  }, []);
  const handleWtNameChange = useCallback((name: string) => {
    setWtName(name);
  }, []);

  const wtRef = useRef({
    enabled: wtEnabled,
    name: wtName,
    sourceBranch: wtSourceBranch,
    baseRepo: wtBaseRepo,
    supportsRecoveryKeyDiscard: wtSupportsRecoveryKeyDiscard,
    confirmedIneligible: wtConfirmedIneligible,
    branchPreferenceReady: wtBranchPreferenceReady,
    branchPreferenceSaving: wtBranchPreferenceSaving,
    preferenceSaving: wtPreferenceSaving,
  });
  wtRef.current = {
    enabled: wtEnabled,
    name: wtName,
    sourceBranch: wtSourceBranch,
    baseRepo: wtBaseRepo,
    supportsRecoveryKeyDiscard: wtSupportsRecoveryKeyDiscard,
    confirmedIneligible: wtConfirmedIneligible,
    branchPreferenceReady: wtBranchPreferenceReady,
    branchPreferenceSaving: wtBranchPreferenceSaving,
    preferenceSaving: wtPreferenceSaving,
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
      // 被控端版本过旧 → 确定性不支持,重取毫无意义(下面的 refresh 只对 unavailable 触发)。
      let policyUnsupported = collabPolicy.unsupported;
      if (effectiveCollab.enabled && policyUnavailable) {
        // 这是 handleSend 里**第一个** await,必须先上在途锁(Codex review P1):不上锁的话,协同策略
        // 重取期间设备 pill / 工作区 pill 仍可点,而本次调用的闭包持有的是旧设备与旧工作区 ——
        // 会话建在旧目标上,随后 resetDraftWorkspaceAfterSend 又把用户刚选的新目标清掉。
        // markSendInFlight 同步写 ref(两个 pill 的 handler 据此立即拒绝)并驱动 disabled 渲染。
        //
        // 用完即释放是安全的:从这里到下方真正的 markSendInFlight(true) 之间**没有任何 await**,
        // 同步代码期间不会有用户交互插进来。这样早退路径(策略仍不可用 / 远程草稿未就绪)也不必
        // 各自记得解锁,少一类漏解锁把发送按钮永久锁死的风险。
        markSendInFlight(true);
        try {
          const refreshed = await collabPolicy.refresh();
          policyEnabled = refreshed.enabled;
          policyUnavailable = refreshed.unavailable;
          policyUnsupported = refreshed.unsupported;
        } finally {
          markSendInFlight(false);
        }
      }
      if (effectiveCollab.enabled && (policyUnavailable || policyUnsupported || !policyEnabled)) {
        toast.warning(
          t(
            policyUnsupported
              ? 'newChat.collaboration.unsupportedRemoteHint'
              : policyUnavailable
                ? 'newChat.collaboration.unavailableHint'
                : 'newChat.collaboration.disabledHint',
          ),
        );
        return false;
      }
      const shouldEnableCollab = effectiveCollab.enabled && collabPolicyEligible && policyEnabled;
      // device-link 切设备后,capabilities/providers hook 可能还没 re-render 到新设备快照;
      // 此时 effectiveFastMode / supportsFastMode / sendProviderId 仍基于旧设备。
      // remoteDraftState 必须一起看:换设备时我们会把它打回 loading(防上一台的默认值串台),
      // 而 capabilities / providers 若已缓存则这两个 loading 立刻就是 false —— 只看它们会在
      // maker:get-new-maker-defaults 还没回来时放行,于是提交的是 deviceLinkInitial 的 capability
      // 兜底值(model / effort / permission / provider),而不是那台设备自己保存的草稿值;
      // 会话一旦建出来,晚到的响应也修不回去了。
      if (isDeviceLinkDraft && remoteModelListStatus !== 'ready') {
        if (remoteModelListStatus === 'error') {
          toast.error(t('newChat.modelSelector.remoteLoadFailed'));
        } else {
          toast.warning(t('ccAgent.draft.deviceStillLoading'));
        }
        return false;
      }
      if (isDeviceLinkDraft && remoteDraftState.status === 'error') {
        setRemoteDraftRetryEpoch((value) => value + 1);
        toast.error(t('ccAgent.draft.remoteDefaultsLoadFailed'));
        return false;
      }
      if (isDeviceLinkDraft && remoteDraftState.status !== 'ready') {
        toast.warning(t('ccAgent.draft.deviceStillLoading'));
        return false;
      }
      // 草稿里选定的来源(供应商):ChatInput 在发送时把"仍连接的显式选择"经 opts 传上来
      // (未选 / 已断开 → null = 跟随默认路由)。透传给 createSession 落盘 sessions.provider_id,
      // 让新会话首个请求就走对来源,与"会话内切来源"行为一致。device-link 远程会话不支持(下方分支跳过)。
      const providerId = opts?.providerId ?? null;

      // 本地导航命令(/jump-session)在进入 createSession 前同步短路:命中即直接
      // 跳转,新建界面不会先创建 session。这正是它和 /issue 的关键区别。
      if (matchNavigationCommandName(message)) {
        markSendInFlight(true);
        void (async () => {
          try {
            await tryHandleNavigationCommand(message, { navigate, t });
          } finally {
            markSendInFlight(false);
          }
        })();
        return false;
      }

      // workingDir 为空就是 standalone dialogue;main 端按 workspaceKind='dialogue'
      // 自动分配运行目录。项目不是必填项,只是同一创建页里的可切换上下文。
      const selectedWorkingDir = effectiveWorkingDir?.trim() || undefined;
      // 发送语义以用户按下 Send 的那一帧为准。鉴权检查期间项目/分支仍可能被 UI
      // 改动；若异步块稍后再读 live ref，会把旧 workingDir 与新 baseRepo 拼成一次
      // 混合目标创建。这里与 selectedWorkingDir 同步快照，保证整笔创建目标一致。
      const selectedWorktree = { ...wtRef.current };
      // worktree 是用户对本次 project session 的明确选择。探测、分支偏好或远端
      // recovery 能力尚未就绪时保留输入并提示；绝不能把勾选静默降级成普通 session。
      // Checkbox APPLY 是双向门：无论 ON→OFF 还是 OFF→ON，创建都必须等
      // 工作端确认，否则会把旧状态误当成这次用户意图。分支 APPLY 则只在
      // Worktree ON 时阻塞；OFF 仍可直接创建普通 session，保持两条轴独立。
      // 确认不合格(2026-08-07 裁决)时控件隐藏、勾选不生效，偏好写入在途不应
      // 卡住普通会话创建——确认不合格目录永远不会创建 worktree。
      if (
        selectedWorktree.confirmedIneligible !== true
        && (
          wtPreferenceSavingRef.current
          || wtPreferenceAuthorityUnknownRef.current
          || (selectedWorktree.enabled && wtBranchPreferenceSavingRef.current)
        )
      ) {
        toast.warning(t('ccAgent.draft.deviceStillLoading'));
        return false;
      }
      // 确认不合格(探测成功、目录无 worktree 资格)时勾选记忆不生效:整段 ON 门跳过,
      // 按普通会话创建(2026-08-07 裁决)。confirmedIneligible === null(探测中/失败)
      // 仍走 fail-closed —— 探测不出来不等于确认不是 git。
      if (
        selectedWorkingDir
        && !isRemoteProjectDraft
        && selectedWorktree.enabled
        && selectedWorktree.confirmedIneligible !== true
      ) {
        if (!selectedWorktree.baseRepo) {
          toast.error(t('ccAgent.draft.worktreeMissingRepo'));
          return false;
        }
        if (
          !selectedWorktree.branchPreferenceReady
          || (isDeviceLinkDraft && selectedWorktree.supportsRecoveryKeyDiscard !== true)
        ) {
          toast.error(t('ccAgent.draft.deviceStillLoading'));
          return false;
        }
      }
      const dataOwnerAtSend = getDataOwnerGeneration();
      const isCurrentDataOwner = () =>
        dataOwnerAtSend.dataOwnerId === dataOwnerId &&
        isDataOwnerGenerationCurrent(dataOwnerAtSend);

      markSendInFlight(true);
      // 已登记乐观标题预览的会话 id。交接链路(rehomeDraftAttachments / setPending /
      // navigate)在登记之后抛错时,消息没被交出去、权威标题永不回流,预览必须在下面的
      // catch 里撤回,否则空会话会跨列表刷新一直显示一句**没发出去**的话
      // (PR #1031 review P1;worktree 与 goal 两条路径各有自己的撤回点)。
      let optimisticTitleSessionId: string | null = null;
      let remoteOptimisticTitleSessionId: string | null = null;
      const autoTitleLabels = {
        image: t('ccAgent.autoTitle.image'),
        file: t('ccAgent.autoTitle.file'),
      };
      void (async () => {
        try {
          if (isDeviceLinkDraft && !isCurrentDataOwner()) return;
          // device-link:远程草稿就绪态以被控端为准(传 deviceId 走隧道查被控端 maker:agent:status);
          // 本地草稿 effectiveDeviceLinkDeviceId 为 undefined → 仍走控制端本机就绪检查(行为不变)。
          const { proceed } = await vendorAuthGate.checkAndConfirm(authVendor, {
            deviceId: effectiveDeviceLinkDeviceId,
          });
          if (isDeviceLinkDraft && !isCurrentDataOwner()) return;
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
          // #807:不再要求 effectiveWorkingDir —— 选了设备就走对端建会话。没有项目目录时
          // resolveDeviceLinkSubmission 会把 workspaceKind 派生成 'dialogue',被控端自行分配
          // 运行目录(隧道侧 path guard 对「缺 workingDir」本来就是放行的,不放宽任何边界)。
          if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {
            const deviceId = effectiveDeviceLinkDeviceId;
            const deviceName = effectiveDeviceLinkDeviceName ?? deviceId;
            const invokeRemote = async (channel: string, args: unknown[]) => {
              if (!isCurrentDataOwner()) {
                throw new RemotePrecreatedWorktreeOwnerChangedError();
              }
              const result = await window.electronAPI.deviceLink.invoke(deviceId, channel, args);
              if (!isCurrentDataOwner()) {
                throw new RemotePrecreatedWorktreeOwnerChangedError();
              }
              return result;
            };
            const wt = selectedWorktree;
            const ownerAtSend = dataOwnerAtSend.dataOwnerId;
            let remoteWorkingDir = effectiveWorkingDir?.trim() || undefined;
            let presetSessionId: string | undefined;
            let precreatedWorktree:
              | {
                  path: string;
                  recoveryKey: string;
                  createdAt: number;
                }
              | undefined;
            // 生效条件 = 勾选 && baseRepo 已就绪 && 被控端明确支持 recoveryKey discard。
            // 上面的发送门已阻止不完整状态；这里仍保留完整条件作副作用前的防御。
            // 旧 Desktop 可能接受未知 recoveryKey 却不持久化，不能把它当成支持端发起预创建。
            if (
              effectiveWorkingDir &&
              wt.enabled &&
              wt.confirmedIneligible !== true &&
              wt.baseRepo &&
              wt.supportsRecoveryKeyDiscard === true
            ) {
              // 账本必须绑定发起时的账号/本地数据 owner。账号在后续 await
              // 期间切换时，Main 会拒绝把这笔义务落入新 owner 的命名空间。
              if (!ownerAtSend) {
                throw new RemotePrecreatedWorktreeCleanupPendingError();
              }
              // 上次两步创建若在 create / probe / discard 都断线后失败，本地账本仍
              // 承担 cleanup obligation。新建下一份前先恢复；无法确认回收/认领时
              // 硬挡本次 worktree:create，避免每次重试生成一个新的受管目录。
              const recovery = await recoverPendingRemotePrecreatedWorktrees({
                deviceId,
                dataOwnerId: ownerAtSend,
                invoke: invokeRemote,
                isCurrent: isCurrentDataOwner,
              });
              if (!isCurrentDataOwner()) {
                throw new RemotePrecreatedWorktreeOwnerChangedError();
              }
              // 账本不可读时磁盘上是否还有旧 obligation 未知，也必须 fail
              // closed；否则一次暂时的 localStorage 故障会绕过同设备串行回收。
              if (!recovery.storageReadable || recovery.retained > 0) {
                throw new RemotePrecreatedWorktreeCleanupPendingError();
              }
              const baseRepo = wt.baseRepo;
              let name = wt.name.trim();
              if (!name) name = `auto-${Date.now().toString(36).slice(-6)}`;
              presetSessionId = makeDraftSessionId();
              const recoveryKey = makeDraftSessionId();
              const createdAt = Date.now();
              const reservation = {
                deviceId,
                sessionId: presetSessionId,
                dataOwnerId: ownerAtSend,
                recoveryKey,
                createdAt,
                phase: 'reserved' as const,
              };
              // 远端副作用之前先持久化 recoveryKey reservation。首次写盘失败时
              // 绝不调用 worktree:create；内存镜像不能冒充跨进程恢复保证。
              if (!isCurrentDataOwner()) {
                throw new RemotePrecreatedWorktreeOwnerChangedError();
              }
              const reservationRecorded = await registerPendingRemotePrecreatedWorktree(
                reservation,
                isCurrentDataOwner,
              );
              if (!isCurrentDataOwner()) {
                throw new RemotePrecreatedWorktreeOwnerChangedError();
              }
              if (!reservationRecorded) {
                await forgetPendingRemotePrecreatedWorktree(reservation, isCurrentDataOwner);
                throw new RemotePrecreatedWorktreeCleanupPendingError();
              }
              setWtCreating(true);
              try {
                const createRequest: RemoteWorktreeCreateRequest = {
                  sessionId: presetSessionId,
                  baseRepo,
                  name,
                  sourceBranch: wt.sourceBranch.trim() || 'HEAD',
                  recoveryKey,
                };
                const resp = parseRemoteWorktreeCreateResult(
                  await invokeRemote('worktree:create', [createRequest]),
                  createRequest,
                );
                if (!resp) {
                  throw new RemotePrecreatedWorktreeCleanupPendingError();
                }
                if (!resp.ok) {
                  if (!isCurrentDataOwner()) {
                    throw new RemotePrecreatedWorktreeOwnerChangedError();
                  }
                  await forgetPendingRemotePrecreatedWorktree(reservation, isCurrentDataOwner);
                  if (!isCurrentDataOwner()) {
                    throw new RemotePrecreatedWorktreeOwnerChangedError();
                  }
                  showWorktreeError(resp.error);
                  return;
                }
                remoteWorkingDir = resp.meta.path;
                precreatedWorktree = {
                  path: resp.meta.path,
                  recoveryKey,
                  createdAt,
                };
                // 回包后尽力补 path；即使更新失败，首次已确认落盘的 recoveryKey
                // reservation 仍足够让重启后的控制端精确恢复。
                if (!isCurrentDataOwner()) {
                  throw new RemotePrecreatedWorktreeOwnerChangedError();
                }
                await registerPendingRemotePrecreatedWorktree(
                  {
                    ...reservation,
                    path: resp.meta.path,
                    phase: 'precreated',
                  },
                  isCurrentDataOwner,
                );
                if (!isCurrentDataOwner()) {
                  throw new RemotePrecreatedWorktreeOwnerChangedError();
                }
              } catch (err) {
                if (isRemotePrecreatedWorktreeOwnerChangedError(err)) throw err;
                if (isRemotePrecreatedWorktreeCleanupPendingError(err)) throw err;
                log.warn(
                  '[remote worktree:create] response not confirmed; retaining recovery reservation',
                  err,
                );
                // invoke 抛错时无法判断被控端是否已完成创建，保留 reservation，
                // 交给重连/重启恢复；不能把“不知道”展示成普通创建失败后允许重试。
                throw new RemotePrecreatedWorktreeCleanupPendingError({ cause: err });
              } finally {
                setWtCreating(false);
              }
            }
            // 提出来存一份:交接收尾要按**实际提交的** model / effort / permission / workspaceKind
            // 组装临时会话行(见 commitRemoteSessionHandoff),不能再各自推一遍。
            const createArgs = resolveDeviceLinkSubmission({
              agentKind: persistedAgentKind,
              // 远程 worktree:workingDir 换成刚建好的 worktree 路径(真实存在,被控端
              // remote-workdir-guard 按"存在的目录"放行);id 与 worktree 绑定同值。
              // 非 worktree 流程两者保持原值 / 缺省。
              id: presetSessionId,
              workingDir: remoteWorkingDir,
              extraDirs: effectiveExtraDirs,
              // 候选值 = ChatInput 回传的实时值(用户此刻在界面上看到的那一组)。来源校准与 args
              // 组装都在 resolveDeviceLinkSubmission 里,与「新建目标」共用同一份规则 —— 那两条
              // 路径各自推导曾长出过只在其中一条上复现的缺陷(见该函数注释)。
              candidate: {
                model,
                effort,
                permissionMode,
                fastMode: effectiveFastMode,
                providerId,
              },
              deviceProviders,
              capabilityAgentKind,
            });
            let created: { sessionId?: string; workDir?: string } | null = null;
            const remoteSessionId =
              presetSessionId && precreatedWorktree
                ? await createRemoteSessionWithPrecreatedWorktree({
                    deviceId,
                    sessionId: presetSessionId,
                    path: precreatedWorktree.path,
                    recoveryKey: precreatedWorktree.recoveryKey,
                    ...(ownerAtSend ? { dataOwnerId: ownerAtSend } : {}),
                    createdAt: precreatedWorktree.createdAt,
                    createArgs: createArgs,
                    invoke: invokeRemote,
                    isCurrent: isCurrentDataOwner,
                  })
                : (created = (await invokeRemote('maker:create-session', [createArgs])) as {
                    sessionId?: string;
                    workDir?: string;
                  } | null)?.sessionId;
            if (presetSessionId && precreatedWorktree) {
              created = { sessionId: remoteSessionId, workDir: remoteWorkingDir };
            }
            if (!remoteSessionId) {
              // device-link 创建失败:错误来自被控端 RPC,与 useCCSessions().error 无关,
              // 不应读 state 里的 REMOTE_* code(copilot review #1035)。
              toast.error(t('ccAgent.draft.createSessionFailed'));
              return;
            }
            if (!isCurrentDataOwner()) {
              throw new RemotePrecreatedWorktreeOwnerChangedError();
            }
            {
              const optimisticTitle = optimisticFirstMessageTitle(
                message,
                files,
                mentions,
                opts,
                autoTitleLabels,
              );
              if (optimisticTitle) {
                remoteProjectsStore.setPendingTitlePreview(
                  remoteSessionId,
                  optimisticTitle,
                  Boolean(normalizeAutoTitle(message)),
                );
                remoteOptimisticTitleSessionId = remoteSessionId;
              }
            }
            // remoteSessionId 到手就是**提交点**:对端会话已经建出来了。此后任何一步都不许再把它
            // 退化成「创建失败」—— 用户会照着提示重试,于是对端多出第二个会话,第一个空着永久滞留。
            // 钉归属 → 补临时行 → 触发回流这三条不变量、以及各自被 review 抓出来的理由,都在
            // commitRemoteSessionHandoff 里;它同步返回且不抛,所以这里既不 await 也不需要 try ——
            // **回流不能挡在 setPending 前面**:那段退避重试最长约 6.75 秒,应用在窗口内被关掉就会
            // 丢掉用户的首条消息,而对端会话已经建好了(第 33 轮 P1)。
            commitRemoteSessionHandoff({
              deviceId,
              deviceName,
              remoteSessionId,
              workDir: created?.workDir,
              createArgs,
              nowIso: new Date().toISOString(),
              logTag: 'draft send',
            });
            // 草稿里选中的那条收藏跟着会话走(见 carryDraftFavoriteAnchorToSession)。锚点是
            // **控制端的 UI 态**,与被控端无关:按对端会话 id 记在本机即可,不进任何 payload。
            // 用 createArgs 里**实际提交**的 model / providerId(远程分支会按被控端目录校准)。
            carryDraftFavoriteAnchorToSession(
              remoteSessionId,
              persistedAgentKind,
              createArgs.model,
              createArgs.providerId ?? null,
            );
            // 可恢复副本紧贴提交点落下,**排在下面的附件迁移 await 之前**(codex P2 第五轮)。
            // 提交点之后每多一次 await,「对端会话已建好、正文却还没有第二份」的窗口就长一分;
            // rehomeDraftAttachments 是本机 IPC,但含 base64 / 草稿缓存图片时并不快,期间
            // 应用退出或崩溃,正文就没了。副本只存正文、不依赖附件迁移结果,所以可以先落。
            rememberRecoverableHandoff(remoteSessionId, 'message', message);
            // F-COLLAB / device-link:草稿开了协同 → **不在这里 await**,把「开协同」连同
            // 首条消息一起交接给 SessionView(见 pendingFirstMessage.PendingRemoteCollab)。
            //
            // 两条约束只能这样同时满足(greptile P1 + codex P1/P2 三轮收敛的结论):
            //  · 首轮必须排在协同之后 —— 否则用户开了协同,首轮 Lead 却没有 cindy_orca 工具;
            //  · 提交点之后不得插入远程等待 —— 被控端起 Worker 是一次隧道往返,可能一路走到
            //    invoke 默认 30s 超时。挡在 navigate 前面,既让新建页凭空卡住半分钟,又把
            //    「对端会话已建好、用户输入还只在内存 pending Map 里」的窗口拉到同样长度,
            //    窗口内应用被关掉就永久丢消息、对端留下空会话。
            // 交接出去之后,等待发生在**已经导航到的**会话视图里:UI 不卡,输入已在视图手里,
            // 而首轮仍然由同一个 await 串在协同之后。
            const rehydratedFiles = await rehomeDraftAttachments(files, remoteSessionId);
            if (!isCurrentDataOwner()) {
              throw new RemotePrecreatedWorktreeOwnerChangedError();
            }
            setPending(remoteSessionId, {
              text: message,
              files: rehydratedFiles,
              mentions,
              ...(shouldEnableCollab
                ? {
                    remoteCollab: {
                      deviceId,
                      pendingLeadInput: message,
                      options: draftEnableOrcaOptions(
                        effectiveCollab,
                        deviceProviders,
                        !deviceProvidersLoading,
                        true,
                      ),
                    },
                  }
                : {}),
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
            // 立刻导航:开协同的等待与协同 tab 的展开都由 SessionView 在消费 pending 时处理。
            navigate(`/cc-agent/${remoteSessionId}`, { replace: true });
            return;
          }

          // 跨 Agent 工作区检测 + 迁移：必须在 createSession 之前完成，
          // agent 启动时看到的工作区已是迁移后的状态。fail-soft：检测错误只 warn，不阻塞 send。
          try {
            const wd = effectiveWorkingDir;
            if (wd && !isRemoteProjectDraft && persistedAgentKind !== 'pi') {
              const r = await crossAgentConvertService.detect(
                wd,
                persistedAgentKind === 'cc' ? 'claude-code' : persistedAgentKind,
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
          // 走 ChatInput「+」菜单:用户开启后
          // Send 流程会先 createSession (本段下方) 创建 Lead,然后立刻调 enableOrca
          // 拉起 Worker (见下方 "F-COLLAB: draft 阶段开了协同模式" 段)。

          const sessionId = makeDraftSessionId();
          const optimisticTitle = optimisticFirstMessageTitle(
            message,
            files,
            mentions,
            opts,
            autoTitleLabels,
          );
          if (optimisticTitle) {
            emitAutoTitlePreview(sessionId, optimisticTitle);
            optimisticTitleSessionId = sessionId;
          }
          const workingDir = selectedWorkingDir;
          const wt = selectedWorktree;
          // 生效条件 = 勾选 && baseRepo 已就绪。上面的发送门已阻止不完整状态；
          // 这里保留完整条件作创建副作用前的防御，且始终不改写勾选记忆。
          if (!isRemoteProjectDraft && wt.enabled && wt.baseRepo) {
            const baseRepo = wt.baseRepo;

            let name = wt.name.trim();
            if (!name) {
              const suggestResp = await window.electronAPI.worktreeSuggestName({ baseRepo });
              name = (suggestResp.name ?? '').trim();
            }
            if (!name) name = `auto-${Date.now().toString(36).slice(-6)}`;

            let branchName = getBranchName(name);
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
              if (optimisticTitleSessionId) emitAutoTitlePreviewCleared(optimisticTitleSessionId);
              toastCreateSessionFailed();
              return;
            }
            // 草稿里选中的那条收藏跟着会话走(见 carryDraftFavoriteAnchorToSession)。
            carryDraftFavoriteAnchorToSession(newSession.id, persistedAgentKind, model, providerId);
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
              agentKind: persistedAgentKind === 'cc' ? 'claude-code' : persistedAgentKind,
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
            // 保存原始 doc JSON(含 quickStartPill 等 mark),供 worktree 失败恢复时原样还原。
            const preNavDraftDoc = getComposerDraft(NEW_MAKER_DRAFT_KEY)?.text ?? null;
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
                  text: preNavDraftDoc ?? plainTextToTiptapDoc(message),
                  attachments: rehomedFiles ?? [],
                });
                // 第一条消息退回草稿 = 它没被交出去,也就永远不会有权威标题回流。
                // 不撤回的话标题预览会一直盖着 DB 里的哨兵(每次全量刷新后重新盖上),
                // 会话永久显示一句**没发出去**的话(PR #1031 review P1)。
                // 放在这里而不是各 return 前:所有「交接失败 → 还原草稿」的分支都过这一处。
                emitAutoTitlePreviewCleared(newSession.id);
              };
              try {
                rehomedFiles = await rehomeDraftAttachments(files, newSession.id);
                const resp = await window.electronAPI.worktreeCreate({
                  sessionId: newSession.id,
                  baseRepo,
                  name,
                  sourceBranch: wt.sourceBranch.trim() || 'HEAD',
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

                // Main 会在创建时再做一次分支/路径冲突避让，因此回包里的
                // meta.branch 才是权威名字。立即替换预估值，避免 UI 继续显示未实际创建的分支。
                branchName = resp.meta.branch;
                worktreeCreationStore.set(newSession.id, {
                  status: 'creating',
                  name: branchName,
                });
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

                let deferredUiAssignment: DeferredUiAssignment | undefined;
                if (shouldEnableCollab) {
                  try {
                    const orcaOptions = draftEnableOrcaOptions(
                      effectiveCollab,
                      localProviders,
                      !localProvidersLoading,
                      true,
                    );
                    const result = await window.electronAPI.maker.enableOrca(
                      newSession.id,
                      orcaOptions,
                    );
                    deferredUiAssignment = createDeferredUiAssignment({
                      options: orcaOptions,
                      workerSessionId: result.workerSessionId,
                      snapshotBeforeMs: result.uiAssignmentSnapshotBeforeMs,
                    });
                    rememberDeferredUiAssignment(newSession.id, deferredUiAssignment);
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

                const dispatchedMessage = await rewritePiSkillMessageForSend({
                  agentKind: persistedAgentKind === 'cc' ? 'claude-code' : persistedAgentKind,
                  message,
                  workingDir: newDir,
                  sessionId: newSession.id,
                });
                const rebaseRanges = <T extends { start: number; end: number }>(
                  ranges: readonly T[] | undefined,
                ): T[] | undefined => {
                  if (!ranges) return undefined;
                  return rebaseInlineRangesAfterSlashCommandRewrite(ranges, message, dispatchedMessage);
                };
                const accepted = await makerChatStore.sendMessage(
                  newSession.id,
                  dispatchedMessage,
                  model,
                  effort,
                  permissionMode,
                  newDir,
                  rehomedFiles,
                  mentions,
                  {
                    ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
                    ...(opts?.agentReferences?.length
                      ? { agentReferences: rebaseRanges(opts.agentReferences) }
                      : {}),
                    ...(opts?.pastedTextRanges?.length
                      ? { pastedTextRanges: rebaseRanges(opts.pastedTextRanges) }
                      : {}),
                    ...(opts?.slashCommandRanges !== undefined
                      ? { slashCommandRanges: rebaseRanges(opts.slashCommandRanges) }
                      : {}),
                  },
                );
                if (accepted) {
                  opts?.onAccepted?.();
                  void dispatchDeferredUiAssignment(newSession.id, deferredUiAssignment).catch(
                    (err) => {
                      log.error('[draft worktree send] deferred Worker assignment failed', err);
                      toast.error(t('newChat.collaboration.assignmentFailed'));
                    },
                  );
                } else if (deferredUiAssignment) {
                  toast.error(t('newChat.collaboration.assignmentFailed'));
                }
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
            if (optimisticTitleSessionId) emitAutoTitlePreviewCleared(optimisticTitleSessionId);
            toastCreateSessionFailed();
            return;
          }
          // 草稿里选中的那条收藏跟着会话走(见 carryDraftFavoriteAnchorToSession)。
          carryDraftFavoriteAnchorToSession(newSession.id, persistedAgentKind, model, providerId);
          // 计划模式是一次性选择:随本次发送被消耗,草稿勾选同步熄灭。
          if (effectivePlanMode) patchActivePrefs({ planMode: false });
          // 首条消息经 setPending → SessionView 自动发送,createOpts 读 chat store 的
          // planModeEnabled —— ensureInitialMessages 的行水合是异步的,必须先确定性
          // seed store,否则勾了计划模式的首条消息可能以 planMode:false 发出
          // (worktree 路径同款 seed;bot review P2)。
          makerChatStore.setSessionRuntime(newSession.id, {
            agentKind: capabilityAgentKind,
            fastMode: effectiveFastMode,
            planModeEnabled: effectivePlanMode,
          });

          // "创建即发送"路径:乐观回写 userSendAt 跳过 projectGrouping 的草稿兜底
          // (userSendAt==null && messages==0 → unclassified),否则新会话会先在
          // Projects 顶层闪一帧再跳到 workdir 分组下。真实 userSendAt 会通过
          // sendMessage 链路里的 emitPatch 再覆盖一次,值差几百 ms 无所谓。
          //
          // 标题同理需要即时预览(见 optimisticFirstMessageTitle):否则侧边栏 / 会话头会
          // 在整个发送链路走完前一直显示建会话时的默认占位。
          {
            const iso = new Date().toISOString();
            sessionsStore.patchLocal(newSession.id, { userSendAt: iso, updatedAt: iso });
          }

          // F-COLLAB: draft 阶段开了协同模式 → createSession 之后立刻 enableOrca
          // 拉起 Worker。失败 toast 但保留 Lead session(用户可以继续单 session 聊),
          // 不阻断 send 流程。worker 类型由 popover 选择,失败回退到单 session 路由。
          let orcaNavTarget: string | null = null;
          let orcaWorkersRevealState: { focusWorkerSessionId: string } | null = null;
          let deferredUiAssignment: DeferredUiAssignment | undefined;
          if (shouldEnableCollab) {
            try {
              const orcaOptions = draftEnableOrcaOptions(
                effectiveCollab,
                localProviders,
                !localProvidersLoading,
                true,
              );
              const result = await window.electronAPI.maker.enableOrca(
                newSession.id,
                orcaOptions,
              );
              deferredUiAssignment = createDeferredUiAssignment({
                options: orcaOptions,
                workerSessionId: result.workerSessionId,
                snapshotBeforeMs: result.uiAssignmentSnapshotBeforeMs,
              });
              rememberDeferredUiAssignment(newSession.id, deferredUiAssignment);
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
            ...(deferredUiAssignment ? { deferredUiAssignment } : {}),
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
          // 交接失败 → 撤回乐观标题预览(理由见上面 optimisticTitleSessionId 的注释)。
          // 归属切换也会提前 return,必须先撤;否则已建、未发出首条的空会话会一直顶着原文。
          if (optimisticTitleSessionId) emitAutoTitlePreviewCleared(optimisticTitleSessionId);
          if (remoteOptimisticTitleSessionId) {
            remoteProjectsStore.clearPendingTitlePreview(remoteOptimisticTitleSessionId);
          }
          if (isRemotePrecreatedWorktreeOwnerChangedError(err)) return;
          log.error('[draft send]', err);
          toast.error(
            isRemotePrecreatedWorktreeCleanupPendingError(err)
              ? t('ccAgent.draft.remoteWorktreeCleanupPending')
              : (getRemoteWorkingDirErrorMessage(err, t) ?? t('ccAgent.draft.createSessionFailed')),
          );
        } finally {
          setWtCreating(false);
          markSendInFlight(false);
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
      remoteModelListStatus,
      remoteDraftState.status,
      deviceProviders,
      deviceProvidersLoading,
      effectiveDeviceLinkDeviceId,
      effectiveDeviceLinkDeviceName,
      dataOwnerId,
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
      collabPolicy.unsupported,
      effectiveCollab.worker,
      // workerConfig 也要进依赖:只改角色/模型/effort/初始任务(worker 类型不变)时,
      // 少了它 handleSend 会闭包吃旧的 effectiveCollab,起 Worker 用错配置(codex P2)。
      effectiveCollab.workerConfig,
      // draftEnableOrcaOptions 现按 live 目录收窄草稿来源:快照与 loading 都要进
      // 依赖,否则闭包吃旧快照,来源连/断后仍按陈旧目录收窄(codex review)。
      // device-link 分支按**被控端**目录收窄,同理两项都要进。
      localProviders,
      localProvidersLoading,
      vendorAuthGate,
      createSession,
      carryDraftFavoriteAnchorToSession,
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
      // 整段持在途锁(Codex review P1)。我上一轮判断「弹窗是模态遮罩、pill 点不到,所以不需要锁」
      // ——**只考虑了指针输入**:AlertDialog 默认拦外部点击,但 Esc 照样能关。用户在「策略重取 →
      // 授权 → 建会话 → 回流」这段异步里按 Esc 关掉弹窗,就能去改设备 / 工作区,而这次调用的闭包
      // 持有的还是旧目标 —— 会话建在旧设备上、导航过去,同时把刚选的新目标重置掉。
      // 锁写 ref(两个 pill 的 handler 即时拒绝)并驱动 disabled 渲染,与 handleSend 同一机制;
      // 因此无论弹窗怎么消失都拦得住(NewGoalDialog 另外禁掉了 saving 期间的 Esc,那只是别让 UI
      // 假装取消了)。finally 释放,覆盖所有 throw / 早退路径。
      //
      // 锁被占用时必须 **throw 而不是 return**(Codex review 第 31 轮 P1):NewGoalDialog.save()
      // 把 `await onCreate(...)` 正常 resolve 一律当成成功 —— 紧接着就 onCreated?.() 清空 composer
      // 并 onOpenChange(false) 关掉弹窗。于是「发送在途时打开新建目标并点开始」会静默丢掉用户刚写
      // 的目标文案,连错误都不显示;更糟的是它还会盖掉那次仍在跑的操作后续可能报出的失败。
      // 抛出去则走 save() 的 catch:弹窗保持打开、内联显示原因、objective 原样留在输入框。
      if (sendInFlightRef.current) {
        throw new Error(t('goal.newGoalDialog.busy'));
      }
      markSendInFlight(true);
      let goalSessionId: string | null = null;
      let optimisticGoalTitle: string | null = null;
      try {
        const selectedWorkingDir = effectiveWorkingDir?.trim() || undefined;
        const selectedWorktree = { ...wtRef.current };
        // Keep Goal on the exact same worktree contract as Send.  In
        // particular, an in-flight checkbox write blocks both directions,
        // while an in-flight branch write only blocks a Worktree-enabled
        // project.  OFF remains an ordinary base-repo create even if the
        // independent branch preference transaction is still settling.
        // 确认不合格(2026-08-07 裁决)时跳过偏好写入守卫,与 Send 同口径。
        if (
          selectedWorktree.confirmedIneligible !== true
          && (
            wtPreferenceSavingRef.current
            || wtPreferenceAuthorityUnknownRef.current
            || (selectedWorktree.enabled && wtBranchPreferenceSavingRef.current)
          )
        ) {
          throw new Error(t('ccAgent.draft.deviceStillLoading'));
        }
        // 与 handleSend 同口径:确认不合格时勾选记忆不生效,整段 ON 门跳过、按普通
        // 会话创建;null(探测中/失败)仍 fail closed(2026-08-07 裁决)。
        if (
          selectedWorkingDir
          && !isRemoteProjectDraft
          && selectedWorktree.enabled
          && selectedWorktree.confirmedIneligible !== true
        ) {
          if (!selectedWorktree.baseRepo) {
            throw new Error(t('ccAgent.draft.worktreeMissingRepo'));
          }
          if (
            !selectedWorktree.branchPreferenceReady
            || wtBranchPreferenceErrorRef.current
            || (isDeviceLinkDraft && selectedWorktree.supportsRecoveryKeyDiscard !== true)
          ) {
            throw new Error(t('ccAgent.draft.deviceStillLoading'));
          }
        }
        const dataOwnerAtGoal = getDataOwnerGeneration();
        const isCurrentDataOwner = () =>
          dataOwnerAtGoal.dataOwnerId === dataOwnerId
          && isDataOwnerGenerationCurrent(dataOwnerAtGoal);
        let policyEnabled = collabPolicy.enabled;
        if (effectiveCollab.enabled && collabPolicyEligible) {
          if (collabPolicy.loading) {
            throw new Error(t('newChat.collaboration.loadingHint'));
          }
          // 被控端版本过旧:确定性不支持,不走重取(与 handleSend 同口径)。
          if (collabPolicy.unsupported) {
            throw new Error(t('newChat.collaboration.unsupportedRemoteHint'));
          }
          if (collabPolicy.unavailable) {
            const refreshed = await collabPolicy.refresh();
            if (refreshed.unsupported) {
              throw new Error(t('newChat.collaboration.unsupportedRemoteHint'));
            }
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
        const shouldEnableCollab = effectiveCollab.enabled && collabPolicyEligible && policyEnabled;
        // 同 handleSend:remoteDraftState 未就绪时不得放行,否则提交 capability 兜底值而非该设备的
        // 草稿值(缓存已热时另两个 loading 会立刻为 false,拦不住)。
        if (isDeviceLinkDraft && remoteModelListStatus === 'error') {
          throw new Error(t('newChat.modelSelector.remoteLoadFailed'));
        }
        if (isDeviceLinkDraft && remoteDraftState.status === 'error') {
          setRemoteDraftRetryEpoch((value) => value + 1);
          throw new Error(t('ccAgent.draft.remoteDefaultsLoadFailed'));
        }
        if (
          isDeviceLinkDraft &&
          (remoteModelListStatus !== 'ready' || remoteDraftState.status !== 'ready')
        ) {
          throw new Error(t('ccAgent.draft.deviceStillLoading'));
        }
        const { proceed } = await vendorAuthGate.checkAndConfirm(authVendor, {
          deviceId: effectiveDeviceLinkDeviceId,
        });
        if (!proceed) return; // 用户取消授权:弹窗关闭即可,不算错误。
        if (isDeviceLinkDraft) {
          // partial state 防御:只要 deviceId 就够 —— #807 起「选了设备但没选项目」是合法状态
          // (在对端建 standalone dialogue),不能再要求 workingDir,否则新建目标在远程纯对话下
          // 直接抛 createSessionFailed,而同一状态的普通发送是走得通的(两条路必须同口径)。
          // 仍然保留 deviceId 缺失的报错:那才是真正的 partial state,静默落到本地会把目标建错机器。
          if (!effectiveDeviceLinkDeviceId) {
            throw new Error(t('ccAgent.draft.createSessionFailed'));
          }
          const deviceId = effectiveDeviceLinkDeviceId;
          const deviceName = effectiveDeviceLinkDeviceName ?? deviceId;
          const ownerAtGoal = dataOwnerAtGoal.dataOwnerId;
          const invokeRemote = async (channel: string, args: unknown[]) => {
            if (!isCurrentDataOwner()) {
              throw new RemotePrecreatedWorktreeOwnerChangedError();
            }
            const result = await window.electronAPI.deviceLink.invoke(deviceId, channel, args);
            if (!isCurrentDataOwner()) {
              throw new RemotePrecreatedWorktreeOwnerChangedError();
            }
            return result;
          };
          let remoteWorkingDir = selectedWorkingDir;
          let presetSessionId: string | undefined;
          let precreatedWorktree:
            | { path: string; recoveryKey: string; createdAt: number }
            | undefined;
          if (
            selectedWorkingDir
            && selectedWorktree.enabled
            && selectedWorktree.confirmedIneligible !== true
            && selectedWorktree.baseRepo
            && selectedWorktree.supportsRecoveryKeyDiscard === true
          ) {
            if (!ownerAtGoal) {
              throw new RemotePrecreatedWorktreeCleanupPendingError();
            }
            const recovery = await recoverPendingRemotePrecreatedWorktrees({
              deviceId,
              dataOwnerId: ownerAtGoal,
              invoke: invokeRemote,
              isCurrent: isCurrentDataOwner,
            });
            if (!recovery.storageReadable || recovery.retained > 0) {
              throw new RemotePrecreatedWorktreeCleanupPendingError();
            }
            let name = selectedWorktree.name.trim();
            if (!name) name = `auto-${Date.now().toString(36).slice(-6)}`;
            presetSessionId = makeDraftSessionId();
            const recoveryKey = makeDraftSessionId();
            const createdAt = Date.now();
            const reservation = {
              deviceId,
              sessionId: presetSessionId,
              dataOwnerId: ownerAtGoal,
              recoveryKey,
              createdAt,
              phase: 'reserved' as const,
            };
            const reservationRecorded = await registerPendingRemotePrecreatedWorktree(
              reservation,
              isCurrentDataOwner,
            );
            if (!reservationRecorded) {
              await forgetPendingRemotePrecreatedWorktree(reservation, isCurrentDataOwner);
              throw new RemotePrecreatedWorktreeCleanupPendingError();
            }
            setWtCreating(true);
            try {
              let resp: ReturnType<typeof parseRemoteWorktreeCreateResult>;
              try {
                const createRequest: RemoteWorktreeCreateRequest = {
                  sessionId: presetSessionId,
                  baseRepo: selectedWorktree.baseRepo,
                  name,
                  sourceBranch: selectedWorktree.sourceBranch.trim() || 'HEAD',
                  recoveryKey,
                };
                resp = parseRemoteWorktreeCreateResult(
                  await invokeRemote('worktree:create', [createRequest]),
                  createRequest,
                );
              } catch (error) {
                if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
                if (isRemotePrecreatedWorktreeCleanupPendingError(error)) throw error;
                // No response means the host may already have created it.
                // Retain the reservation and force reconciliation before retry.
                throw new RemotePrecreatedWorktreeCleanupPendingError({ cause: error });
              }
              if (!resp) {
                throw new RemotePrecreatedWorktreeCleanupPendingError();
              }
              if (!resp.ok) {
                await forgetPendingRemotePrecreatedWorktree(reservation, isCurrentDataOwner);
                throw new Error(resp.error.message ?? resp.error.kind);
              }
              remoteWorkingDir = resp.meta.path;
              precreatedWorktree = { path: resp.meta.path, recoveryKey, createdAt };
              await registerPendingRemotePrecreatedWorktree(
                { ...reservation, path: resp.meta.path, phase: 'precreated' },
                isCurrentDataOwner,
              );
            } finally {
              setWtCreating(false);
            }
          }
          // 与 handleSend 同口径先存一份 args:临时行要按实际提交的值组装(见 commitRemoteSessionHandoff)。
          const createArgs = resolveDeviceLinkSubmission({
            agentKind: persistedAgentKind,
            // 无项目 → 不传,由 workingDir 派生 workspaceKind:'dialogue'。
            id: presetSessionId,
            workingDir: remoteWorkingDir,
            extraDirs: effectiveExtraDirs,
            // 候选值 = 组件级派生值(弹窗独立于 ChatInput,拿不到它的回传)。与发送路径过同一道
            // 校准 —— 这两条路径曾各自推导,于是「只在新建目标上复现」的缺陷出过三次。
            candidate: {
              model: draftInitialModel,
              effort: draftInitialEffort,
              permissionMode: chatInitialPermissionMode,
              fastMode: effectiveFastMode,
              providerId: chatInitialProviderId,
            },
            deviceProviders,
            capabilityAgentKind,
          });
          let created: { sessionId?: string; workDir?: string } | null = null;
          const remoteSessionId = await (presetSessionId && precreatedWorktree
            ? createRemoteSessionWithPrecreatedWorktree({
                deviceId,
                sessionId: presetSessionId,
                path: precreatedWorktree.path,
                recoveryKey: precreatedWorktree.recoveryKey,
                ...(ownerAtGoal ? { dataOwnerId: ownerAtGoal } : {}),
                createdAt: precreatedWorktree.createdAt,
                createArgs,
                invoke: invokeRemote,
                isCurrent: isCurrentDataOwner,
              })
            : invokeRemote('maker:create-session', [createArgs]).then((result) => {
                created = result as { sessionId?: string; workDir?: string } | null;
                return created?.sessionId;
              }))
            .catch((err) => {
              const remoteWorkdirMessage = getRemoteWorkingDirErrorMessage(err, t);
              if (remoteWorkdirMessage) throw new Error(remoteWorkdirMessage);
              throw err;
            });
          if (presetSessionId && precreatedWorktree) {
            created = { sessionId: remoteSessionId, workDir: remoteWorkingDir };
          }
          if (!remoteSessionId) {
            throw new Error(t('ccAgent.draft.createSessionFailed'));
          }
          {
            const optimisticGoalTitle = normalizeAutoTitle(objective);
            if (optimisticGoalTitle) {
              remoteProjectsStore.setPendingTitlePreview(remoteSessionId, optimisticGoalTitle, true);
            }
          }
          // 与发送路径共用同一段交接收尾(钉归属 → 补临时行 → 触发回流)。三条不变量对目标路径
          // 同样成立,只是后果换了个形状:goalApiFor 也按归属路由,漏了钉子它就把 setGoal 发给本机
          // maker、对端刚建好的会话永远拿不到目标;而它不抛这条在这里更要紧 —— 抛出去 NewGoalDialog
          // 会内联报错并保持打开,用户再点一次「创建」就在对端建出第二个目标会话。
          // 同样不 await 回流:目标路径的损失更大 —— 那段窗口里应用被关掉,除了对端多出一个空会话,
          // 用户在弹窗里刚写好的目标文案也只存在于内存里,一起丢(第 33 轮 P1)。
          commitRemoteSessionHandoff({
            deviceId,
            deviceName,
            remoteSessionId,
            workDir: created?.workDir,
            createArgs,
            nowIso: new Date().toISOString(),
            logTag: 'draft goal',
          });
          // 草稿里选中的那条收藏跟着会话走(见 carryDraftFavoriteAnchorToSession)。远端 Goal
          // 与远端普通发送同口径:锚点是**控制端的 UI 态**,按对端会话 id 记在本机 renderer
          // localStorage,不进任何 payload;model / providerId 用 createArgs 里**实际提交**的值
          // (经被控端目录校准,与 draftInitialModel 可能不同)。
          carryDraftFavoriteAnchorToSession(
            remoteSessionId,
            persistedAgentKind,
            createArgs.model,
            createArgs.providerId ?? null,
          );
          // setGoal 不在这里发:重 topic session:<id> 订阅要等 CCAgentSessionView
          // mount 才建立,在 /cc-agent/new 就起 goal 首轮会让 maker:event/status 推送
          // 掉在订阅建立前的窗口里(Codex review #548)。与首条消息同款交接 ——
          // setPendingGoal → navigate → SessionView 消费时订阅已就绪再 setGoal。
          // 协同同样随交接一起交出去(与发送分支同口径,理由见那段注释):在这里 await
          // 开协同会把目标文案压在内存里等一次可能 30s 的隧道往返。
          setPendingGoal(remoteSessionId, {
            objective,
            limits,
            ...(shouldEnableCollab
              ? {
                  remoteCollab: {
                    deviceId,
                    pendingLeadInput: objective,
                    options: draftEnableOrcaOptions(
                      effectiveCollab,
                      deviceProviders,
                      !deviceProvidersLoading,
                      true,
                    ),
                  },
                }
              : {}),
          });
          // 与发送分支同口径:副本紧贴提交点落下,不等消费(理由见那段注释)。
          // 这条分支的提交点与 setPendingGoal 之间没有 await,所以落在这里即等价于贴着提交点。
          rememberRecoverableHandoff(remoteSessionId, 'goal', objective);
          // 自动起名:goal 首轮走 GoalController 的 session.send、不经 maker:input:enqueue,
          // 被控端 deviceLinkAutoTitle 不会触发(Codex review #548)—— 与本地分支的
          // autoNameSession 对位:先立即用目标文案截断占位(Codex 式,侧边栏不停留在
          // 'New Maker'),再经隧道生成智能标题窄口径覆盖。fire-and-forget;
          // 覆盖前 re-read,仅在标题仍是占位/默认时落盘(用户手动改名 wins)。
          const titleAgentKind = persistedAgentKind === 'cc' ? 'claude-code' : persistedAgentKind;
          // 先折叠空白并 trim 再截断,避免前导空白吃满 40 字符得到空占位(PR #296 review)。
          const placeholderTitle = objective.replace(/\s+/g, ' ').trim().slice(0, 40).trimEnd();
          void (async () => {
            try {
              // 无文本目标(理论不可达,goal 对话框必填)不起名:被控端旧版本的
              // maker:generate-title 没有空消息防线,LLM 会把"请提供内容"当标题。
              if (!placeholderTitle) return;
              // 覆写守卫:仅当远端标题仍是默认占位时才自动起名(user rename wins,
              // PR #296 review)。刚 create-session 建出的会话标题必为默认哨兵,
              // 此检查防御极端 race;读取失败时按默认占位继续,不中断起名。
              //
              // 比对用跨端共享常量:这串由**被控端**(可能是另一个版本的客户端)写入,
              // 必须逐字一致,不能本地化。
              try {
                const preCheck = (await window.electronAPI.deviceLink.invoke(
                  deviceId,
                  'local-db:sessions:get',
                  [remoteSessionId],
                )) as { title?: string | null } | null;
                const preTitle = preCheck?.title?.trim();
                if (preTitle && preTitle !== DEFAULT_DRAFT_SESSION_TITLE) return;
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
              // 占位标题与默认哨兵(maker:create-session 的默认占位符)都允许覆写;
              // 用户已手动改过的真实标题则保留(user rename wins)。
              if (
                existingTitle &&
                existingTitle !== DEFAULT_DRAFT_SESSION_TITLE &&
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
          // 立刻导航:开协同的等待与协同 tab 的展开都由 SessionView 在消费 pendingGoal 时处理。
          navigate(`/cc-agent/${remoteSessionId}`, { replace: true });
          return;
        }
        // 确认不合格时按普通会话走(上方 ON 门已放行,这里必须一起排除,否则
        // baseRepo 为 null 会命中下方的非空断言)。
        const useLocalGoalWorktree = Boolean(
          selectedWorkingDir
          && !isRemoteProjectDraft
          && selectedWorktree.enabled
          && selectedWorktree.confirmedIneligible !== true,
        );
        goalSessionId = makeDraftSessionId();
        optimisticGoalTitle = normalizeAutoTitle(objective);
        if (optimisticGoalTitle) emitAutoTitlePreview(goalSessionId, optimisticGoalTitle);
        let goalWorkingDir = selectedWorkingDir;
        let goalWorktreeName = '';
        let goalWorktreeBranchName = '';
        if (useLocalGoalWorktree) {
          const baseRepo = selectedWorktree.baseRepo!;
          goalWorktreeName = selectedWorktree.name.trim();
          if (!goalWorktreeName) {
            const suggestResp = await window.electronAPI.worktreeSuggestName({ baseRepo });
            goalWorktreeName = (suggestResp.name ?? '').trim();
          }
          if (!goalWorktreeName) goalWorktreeName = `auto-${Date.now().toString(36).slice(-6)}`;
          goalWorktreeBranchName = getBranchName(goalWorktreeName);
          // The local API needs a session id, so this is a compensated saga:
          // create an empty base-repo session, then create the worktree and move
          // workingDir. Any setup failure soft-deletes that empty session before
          // retry; Goal never starts against the base repository.
          goalWorkingDir = baseRepo;
          setWtCreating(true);
        }
        const newSession = await createSession({
          id: goalSessionId,
          agentKind: persistedAgentKind,
          model: draftInitialModel,
          effort: draftInitialEffort,
          permissionMode: chatInitialPermissionMode,
          fastMode: effectiveFastMode,
          workingDir: goalWorkingDir,
          workspaceKind: goalWorkingDir ? 'project' : 'dialogue',
          remoteHostId: goalWorkingDir ? (effectiveRemoteHostId ?? undefined) : undefined,
          extraDirs: effectiveExtraDirs,
          providerId: chatInitialProviderId ?? null,
        });
        if (!newSession) {
          if (optimisticGoalTitle) emitAutoTitlePreviewCleared(goalSessionId);
          throw new Error(t('ccAgent.draft.createSessionFailed'));
        }
        // 草稿里选中的那条收藏跟着会话走(见 carryDraftFavoriteAnchorToSession)。
        carryDraftFavoriteAnchorToSession(
          newSession.id,
          persistedAgentKind,
          draftInitialModel,
          chatInitialProviderId ?? null,
        );
        if (useLocalGoalWorktree) {
          const baseRepo = selectedWorktree.baseRepo!;
          await prepareLocalGoalWorktree({
            sessionId: newSession.id,
            baseRepo,
            name: goalWorktreeName,
            initialBranchName: goalWorktreeBranchName,
            sourceBranch: selectedWorktree.sourceBranch.trim() || 'HEAD',
            createWorktree: (request) => window.electronAPI.worktreeCreate(request),
            updateWorkingDir: (managedDir) => (
              sessionService.update(newSession.id, { workingDir: managedDir }).then(() => undefined)
            ),
            patchWorkingDir: (managedDir) => {
              sessionsStore.patchLocal(newSession.id, { workingDir: managedDir });
            },
            rollbackSession: () => (
              sessionService.setStatus(newSession.id, 'deleted').then(() => undefined)
            ),
            patchDeleted: () => {
              sessionsStore.patchLocal(newSession.id, { status: 'deleted' });
            },
            setProgress: (progress) => worktreeCreationStore.set(newSession.id, progress),
            clearProgress: () => worktreeCreationStore.clear(newSession.id),
          });
          await refreshWorktrees();
        }
        {
          const iso = new Date().toISOString();
          sessionsStore.patchLocal(newSession.id, { userSendAt: iso, updatedAt: iso });
        }
        // 草稿开了协同 → 新建目标路径也要拉起 Worker(与 Send 路径同口径);否则用户开了协同
        // 却走「新建目标」会得到一个没有 Worker 的 lead session(codex P2)。失败 toast + 降级
        // 单会话,不阻断目标创建。本机 / SSH 项目 draft 走这里;device-link 在上面的分支里用
        // 同口径隧道到被控端 enableOrca 后已 return。
        // reveal 不在此处直接 dispatch:当前路由还在 /cc-agent/new,分离侧栏控制器会因
        // session 不匹配返回 stale-context(codex P2)——与 Send 路径同口径,把 reveal
        // 塞进 navigate state,由 CCAgentSessionView mount 后消费。
        let orcaWorkersRevealState: { focusWorkerSessionId: string } | null = null;
        let deferredUiAssignment: DeferredUiAssignment | undefined;
        if (shouldEnableCollab) {
          try {
            const orcaOptions = draftEnableOrcaOptions(
              effectiveCollab,
              localProviders,
              !localProvidersLoading,
              true,
            );
            const result = await window.electronAPI.maker.enableOrca(
              newSession.id,
              orcaOptions,
            );
            deferredUiAssignment = createDeferredUiAssignment({
              options: orcaOptions,
              workerSessionId: result.workerSessionId,
              snapshotBeforeMs: result.uiAssignmentSnapshotBeforeMs,
            });
            rememberDeferredUiAssignment(newSession.id, deferredUiAssignment);
            orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };
          } catch (err) {
            log.error('[draft goal] enableOrca failed (continuing as single session)', err);
            toast.error(
              getCollaborationStartErrorMessage(err, t, { continueAsSingleSession: true }),
            );
          }
        }
        // setGoal 内部 ensureSession(拉起 agent)+ 发首轮(带目标指令)。
        try {
          await window.electronAPI.maker.setGoal({ sessionId: newSession.id, objective, limits });
          void dispatchDeferredUiAssignment(newSession.id, deferredUiAssignment).catch((err) => {
            log.error('[draft goal] deferred Worker assignment failed', err);
            toast.error(t('newChat.collaboration.assignmentFailed'));
          });
        } catch (err) {
          // 首轮没发出去 → 下面的 autoNameSession 也不会跑,权威标题永不回流。
          // 不撤回的话标题预览会永久盖着 DB 里的哨兵(理由同 worktree 分支的
          // restoreFirstMessageDraft)。异常照旧抛给调用方展示。
          if (optimisticGoalTitle) emitAutoTitlePreviewCleared(newSession.id);
          if (deferredUiAssignment) {
            toast.error(t('newChat.collaboration.assignmentFailed'));
          }
          throw err;
        }
        // 自动起名:/goal 新建的会话不经普通发送路径,scheduleAutoName 漏触发 → 标题会停在默认。
        // 这里用目标文案补一次,与普通会话同款(立即占位 + 智能标题后台覆盖 + 不覆盖手动改名)。
        makerChatStore.autoNameSession(newSession.id, objective, capabilityAgentKind);
        clearComposerDraftAndNotify(NEW_MAKER_DRAFT_KEY);
        resetDraftWorkspaceAfterSend();
        navigate(`/cc-agent/${newSession.id}`, {
          replace: true,
          state: orcaWorkersRevealState ? { orcaWorkersReveal: orcaWorkersRevealState } : undefined,
        });
      } catch (error) {
        // 预览在 createSession 之前登记。worktree 建议名 / 建树 / 回滚失败都走这里,
        // 不撤回会让空会话或未建成的 goalSessionId 一直顶着目标原文。
        if (goalSessionId && optimisticGoalTitle) emitAutoTitlePreviewCleared(goalSessionId);
        if (isLocalGoalWorktreeCleanupPendingError(error)) {
          log.error('[draft goal] incomplete local worktree session cleanup failed', {
            setupError: error.setupError,
            cleanupError: error.cleanupError,
          });
          throw new Error(t('ccAgent.draft.localWorktreeCleanupPending'));
        }
        if (isRemotePrecreatedWorktreeCleanupPendingError(error)) {
          throw new Error(t('ccAgent.draft.remoteWorktreeCleanupPending'));
        }
        if (isRemotePrecreatedWorktreeOwnerChangedError(error)) {
          throw new Error(t('ccAgent.draft.createSessionFailed'));
        }
        throw error;
      } finally {
        setWtCreating(false);
        markSendInFlight(false);
      }
    },
    [
      markSendInFlight,
      isDeviceLinkDraft,
      isRemoteProjectDraft,
      remoteModelListStatus,
      remoteDraftState.status,
      deviceProviders,
      deviceProvidersLoading,
      vendorAuthGate,
      authVendor,
      effectiveDeviceLinkDeviceId,
      effectiveDeviceLinkDeviceName,
      effectiveWorkingDir,
      dataOwnerId,
      createSession,
      carryDraftFavoriteAnchorToSession,
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
      collabPolicy.unsupported,
      collabPolicy.enabled,
      // 同 handleSend:草稿来源收窄依赖 live 目录快照。
      localProviders,
      localProvidersLoading,
      patchCollab,
      refreshWorktrees,
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
        text: quickStartTextToTiptapDoc(text),
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
            guardedAttachmentState.addFiles(droppedItems.files);
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
              if (files.length > 0) guardedAttachmentState.addFiles(files);
            });
          }
        }}
      >
        <div
          data-testid="create-agent-shell"
          className={cn(
            'relative flex h-full w-full items-center justify-center overflow-x-hidden overflow-y-auto bg-[var(--surface)] px-3 py-8', // px-3:外壳12+main32=44,与技能页(32+12滚动条槽)对齐(实测定稿 2026-07-19)
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
          {/* 固定入口由 MainLayout 承载；入口在右侧且未内嵌时保留第一行位置，
            避免其它 chip 与它重叠。 */}
          {!IS_MAC_PLATFORM &&
            draftRightSidebar.available &&
            rightSidebarCollapsed &&
            rightSidebarSide === 'right' && (
              <TopRightChipStack>
                <div aria-hidden className="h-7 w-7 shrink-0" />
              </TopRightChipStack>
            )}
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
                {/* 设备切换器(#807):设备是一级维度,排在 mode pill 左边;没有对端设备时
                    组件自己返回 null —— 只有本机的用户看不到任何新增控件。 */}
                <DeviceSwitcherPill
                  devices={selectableDevices}
                  value={effectiveDeviceLinkDeviceId ?? null}
                  onChange={handleDeviceChange}
                  open={devicePickerOpen}
                  onOpenChange={handleDevicePickerOpenChange}
                  // 窄屏 pill 排会进正常流并 flex-wrap;多台时收成图标 + 状态点少占一行。
                  compact={isDraftNarrow && selectableDevices.length > 1}
                  disabled={wtCreating || sendInFlight}
                />
                <FolderPickerPopover
                  open={folderPickerOpen}
                  onOpenChange={handleFolderPickerOpenChange}
                  onSelect={handleModePickerSelect}
                  projectOptions={activeProjectOptions}
                  deviceScope={folderPickerDeviceScope}
                  onRemoveRemoteProject={removeRemoteProject}
                  // 仅在有可用远程目标时暴露「添加远程项目」入口(SSH ready 主机 / device-link 可控设备)。
                  // 已经选定对端设备时无条件下发:此时浏览目标是明确的那台机器,不该再受
                  // hasAnyRemoteTarget 影响 —— 它会在该设备离线时变 false,把「浏览文件夹」推回
                  // 本机原生对话框(见 FolderPickerPopover.handleChooseDifferent 的同款防护)。
                  onAddRemoteProject={
                    hasAnyRemoteTarget || folderPickerDeviceScope
                      ? handleOpenRemoteProject
                      : undefined
                  }
                  side="bottom"
                  align="end"
                  sideOffset={6}
                >
                  <button
                    type="button"
                    data-testid="create-agent-mode-pill"
                    disabled={wtCreating || sendInFlight}
                    className="inline-flex h-[30px] min-w-20 max-w-[220px] items-center justify-center gap-1.5 rounded-full border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] px-3 text-12 font-medium leading-[1.167] text-[var(--create-agent-control-text)] transition-colors hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                    aria-label={t('newChat.collaboration.modeLabel')}
                  >
                    <MessageSquare
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--create-agent-control-icon)]"
                    />
                    <span className="min-w-0 truncate">{createAgentModeLabel}</span>
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
                  onRecoveryKeyDiscardSupportChange={handleWtRecoveryKeyDiscardSupportChange}
                  onConfirmedIneligibleChange={handleWtConfirmedIneligibleChange}
                  onSuggestedNameChange={handleWtNameChange}
                  // SSH 远程仍禁用 worktree(远端 git 探测未落地);device-link 远程可用:
                  // 探测/建议名/创建全部经隧道在被控端执行(与 488cb33 前口径一致)。
                  worktreeDisabled={isRemoteProjectDraft}
                  deviceLinkDeviceId={effectiveDeviceLinkDeviceId ?? null}
                  deviceLinkReconnectEpoch={remoteDraftRefreshEpoch}
                  disabled={wtCreating || sendInFlight}
                  branchDisabled={wtBranchPreferenceLoading || wtBranchPreferenceSaving}
                  checkboxDisabled={wtPreferenceSaving}
                />
              </div>
              <ThemeBrandLockup
                theme={activeColorTheme}
                testId="create-agent-brand-lockup"
                className={cn('mb-[15px]', isDraftNarrow && 'order-1')}
              />

              <div
                className={cn('flex w-full flex-col items-start gap-0', isDraftNarrow && 'order-3')}
              >
                <div className="w-full">
                  <ChatInput
                    onSend={handleSend}
                    onBeforeVoiceInputStart={handleBeforeVoiceInputStart}
                    externalDragOver={pageDragOver}
                    visualVariant="create-agent"
                    compactToolbar
                    placeholder="Hi Cindy!"
                    sessionId={undefined}
                    initialWorkingDir={effectiveWorkingDir}
                    remoteHostId={draft.remoteHostId ?? null}
                    deviceLinkDeviceId={effectiveDeviceLinkDeviceId ?? null}
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
                    vendorKey={normalizeDbAgentKind(draft.vendor)}
                    folderPickerOpen={folderPickerOpen}
                    onFolderPickerOpenChange={handleFolderPickerOpenChange}
                    showFolderPicker={false}
                    // 统一模型选择器(model-selector-unified §1.1):引擎不再是工具条上的
                    // 独立控件 —— 它跟着模型走(推荐映射自动配好,并在模型 pill 与每一行
                    // 右侧常驻显示),高级调整收进行配置浮层。两条例外都由
                    // unifiedModelPanelActive 表达:device-link 老被控端的 capabilities-only
                    // 降级、以及形态偏好停在 'original'(默认档)—— 那两路 composer 都回落
                    // 旧面板,引擎下拉必须一起回来。
                    middleToolbarSlot={
                      unifiedModelPanelActive ? undefined : (
                        <AgentSelect
                          value={draft.vendor}
                          onChange={handleVendorChange}
                          visualVariant="create-agent"
                          className="shrink-0"
                          disabled={wtCreating}
                          hiddenVendors={hiddenSwitcherVendors}
                        />
                      )
                    }
                    onUnifiedDraftSelect={handleUnifiedDraftSelect}
                    selectedFavoriteUid={selectedFavoriteUid}
                    // 「+」菜单协同模式项:普通 Lead 的项目/对话 draft 都可用 —— eligible 由
                    // resolveCollabEntryPolicy 单点判定,与会话视图同一份(issue #1170)。Lead = 当前
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
                            // unsupported(被控端版本过旧、没有 maker:plugins:get-state)排在
                            // unavailable 之前:它是确定性的不支持,给「稍后重试」是误导,
                            // 上面的 onDisabledActivate 也只挂在 unavailable 上。
                            disabledReason: collabPolicy.loading
                              ? t('newChat.collaboration.loadingHint')
                              : collabPolicy.unsupported
                                ? t('newChat.collaboration.unsupportedRemoteHint')
                                : collabPolicy.unavailable
                                  ? t('newChat.collaboration.unavailableHint')
                                  : !collabPolicy.enabled
                                    ? t('newChat.collaboration.disabledHint')
                                    : undefined,
                          }
                        : undefined
                    }
                    compactMiddleToolbarSlot={
                      unifiedModelPanelActive ? undefined : (
                        <AgentSelect
                          value={draft.vendor}
                          onChange={handleVendorChange}
                          iconOnly
                          visualVariant="create-agent"
                          className="shrink-0"
                          disabled={wtCreating}
                          hiddenVendors={hiddenSwitcherVendors}
                        />
                      )
                    }
                    narrowToolbar={isDraftToolbarNarrow}
                    paletteMaxHeight={240}
                    attachmentState={guardedAttachmentState}
                    draftKey={NEW_MAKER_DRAFT_KEY}
                    focusOnStorageKeyChange
                    // 「+」始终显示(与对话界面一致):无项目裸态也可加引用目录,作为本次对话的上下文。
                    // createSession 各路径都会带上 extraDirs;workingDir=null 时 ExtraDirsButton 跳过重叠校验。
                    extraDirs={effectiveExtraDirs}
                    // 远程草稿不给引用目录入口(Codex review P1):ExtraDirsButton 开的是**控制端**
                    // 原生目录对话框,选出来的本机路径发到对端后要么被 validateExtraDirs 静默丢掉、
                    // 要么撞上对端同名的无关目录 —— 界面上那几个 chip 于是并不描述真实授予的上下文。
                    // 不传 onChange 时 ExtraDirsButton 直接不渲染引用目录段(「新建目标」/ 计划模式 /
                    // Plugin 入口不受影响)。进入远程设备时 extraDirs 已被清空,不会留下无法删除的残留。
                    // 恢复这个能力要把 picker 路由到对端(设备域浏览器已有 fs:list-dir),见 follow-up。
                    onExtraDirsChange={isDeviceLinkDraft ? undefined : handleExtraDirsChange}
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
                  <div className="mt-3 flex max-w-full items-center gap-2 self-center rounded-full border border-[var(--border-default)] bg-[var(--surface-chip)] px-3 py-1 text-12 text-[var(--text-secondary)]">
                    <MonitorSmartphone
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--folder-item-icon)]"
                    />
                    <span className="min-w-0 truncate">
                      {/* 有项目走原文案;跨设备纯对话没有 project 可填(#807),原句写死了
                          「的 {{project}} 中」会留个空洞,所以走另一条无项目文案。 */}
                      {effectiveWorkingDir
                        ? t('ccAgent.draft.remoteProjectBanner', {
                            device:
                              effectiveDeviceLinkDeviceName ?? effectiveDeviceLinkDeviceId ?? '',
                            project:
                              effectiveWorkingDir.split(/[\\/]/).filter(Boolean).pop() ??
                              effectiveWorkingDir,
                          })
                        : t('ccAgent.draft.remoteDialogueBanner', {
                            device:
                              effectiveDeviceLinkDeviceName ?? effectiveDeviceLinkDeviceId ?? '',
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
                {/* 「已沿用本机订阅」一次性告知。与上面的引导卡条件互斥(它要求零已连接
                    来源,而继承成功后该供应商已连接),所以不与快捷入口互斥 —— 告知不是
                    待办,不该把快速开始顶掉。device-link 草稿不出:连接态在被控端。
                    间距挂在组件自身:外层包一层 div 会在它不可见时留下一段空白 margin。 */}
                <InheritedSubscriptionNotice
                  enabled={!isDeviceLinkDraft}
                  className="mt-6 self-stretch"
                />
                {/* 「赠送余额已到账」一次性告知。与上面那条**不互斥**:两者都是告知,同时成立
                    时按发生顺序竖排(先讲用的是哪个账号,再讲账上有多少钱),都不与快速开始
                    互斥。device-link 草稿不出:那条对话跑在被控端,本机账号的赠送与它无关。
                    间距同样挂在组件自身,免得它不可见时留下一段空白 margin。 */}
                <PromotionalGrantNotice
                  enabled={!isDeviceLinkDraft}
                  className="mt-6 self-stretch"
                />
                {/* 快捷入口与输入框同宽:左右两缘都与上方 ChatInput 对齐(父列已封顶
                    inputWidth)。此前封顶 800px 会在宽窗口下右缘短一截,视觉上没对齐
                    (2026-07-24 用户反馈)。 */}
                {!showProviderOnboardingCard && (
                  <div data-testid="create-agent-quick-starts" className="mt-[42px] w-full">
                    {/* 标题字号 12→14px(DESIGN §3 Caption),与卡片间距 16→10px 收近
                        (DESIGN §5 间距档)——用户改稿 2026-07-22。 */}
                    <div className="mb-2.5 px-0.5">
                      <div className="text-14 font-medium leading-[1.286] text-[var(--text-secondary)]">
                        {t('newChat.createAgent.quickStart')}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'grid w-full gap-3',
                        isDraftNarrow
                          ? 'grid-cols-1'
                          : isDraftMedium
                            ? 'grid-cols-2'
                            : 'grid-cols-4',
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
                          <span className="w-full min-w-0 text-13 font-semibold leading-[1.231]">
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
            draftEnableOrcaOptions 透传给 enableOrca(见本文件 F-COLLAB 段)。
            device-link 草稿传 deviceId:Worker 在**被控端** spawn,模型 / 来源清单必须来自那台
            设备,拿控制端的目录配出来的模型在被控端多半不存在(issue #1170)。 */}
        <CreateWorkerPopover
          open={createWorkerOpen}
          onClose={() => setCreateWorkerOpen(false)}
          onCreate={(form: CreateWorkerForm) => {
            patchCollab({
              enabled: true,
              worker: form.agent === 'codex' ? 'codex' : form.agent === 'pi' ? 'pi' : 'cc',
              workerConfig: {
                role: form.role,
                model: form.model,
                effort: form.effort,
                fast: form.fast,
                providerId: form.providerId,
                initialTask: form.initialTask || undefined,
                workerPermissionMode: form.workerPermissionMode,
              },
            });
            setCreateWorkerOpen(false);
          }}
          title={t('orca.createWorker.enableCollabTitle')}
          submitLabel={t('orca.createWorker.enableCollabSubmit')}
          requireWorkerPermissionModeSupport
          deviceId={effectiveDeviceLinkDeviceId ?? undefined}
          // SSH 远程草稿(draft.remoteHostId):worker 在远端 spawn,模型清单按 SSH
          // 口径过滤,与本路由 ChatInput 候选及 main 侧 remote-worker guard 同口径。
          sshRemote={!!effectiveRemoteHostId}
        />

        {/* 添加远程项目弹窗 (入口在 mode pill 的 FolderPickerPopover 里, gate 走 hasAnyRemoteTarget =
            SSH ready 主机 或 device-link 可控设备)。onProjectAdded 带 kind:SSH 立即建会话 + navigate;
            device-link 把当前草稿指向被控设备项目,发首条消息时 create-on-send。 */}
        <AddRemoteProjectDialog
          open={addRemoteProjectOpen}
          onOpenChange={setAddRemoteProjectOpen}
          initialDeviceId={addRemoteProjectDeviceId}
          // 选中 Pi 时 dialog 过滤掉 SSH 主机(Pi 不支持 remoteHostId);handleRemoteProjectAdded
          // 里还有一道 fail-closed 兜底,防非 UI 路径漏进 Pi+SSH。
          agentVendor={draft.vendor}
          onProjectAdded={handleRemoteProjectAdded}
        />
      </div>
    </TopRightChipStackProvider>
  );
}
