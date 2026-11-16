import { HostConnectionNotice } from '@/components/HostConnectionNotice';
import { AppPreferenceControl } from './components/AppPreferenceControl';
import { AppWindowSync } from './components/layout/AppWindowSync';
import { readLocalWorkerCreationSelection } from './state/workerCreationPrefs';
import { useModelFavoritesHost } from './state/useModelFavoritesHost';
import { getDataOwnerGeneration } from './contexts/dataOwnerGeneration';
import { RouterProvider } from 'react-router-dom';

import { lazy, Suspense, useEffect } from 'react';
import { RemoteDesktopHost } from '@/features/remote-desktop/RemoteDesktopHost';

import { useCloseWindowFallbackShortcut } from '@/hooks/useCloseWindowShortcut';
import { useNewMakerPrefsOwnerResync } from '@/hooks/useNewMakerPrefsOwnerResync';
import { useDisableContextMenu } from '@/hooks/useDisableContextMenu';
import { ThemeProvider } from '@/hooks/useTheme';
import { WallpaperSettingsProvider } from '@/hooks/useWallpaperSettings';
import { FontSettingsProvider } from '@/hooks/useFontSettings';
import { LocaleProvider } from '@/hooks/useLocale';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { PluginReviewUpdatesProvider } from '@/contexts/PluginReviewUpdatesContext';
import { AppShellCoverProvider, useAppShellCover } from '@/contexts/AppShellCoverContext';
import { LoginHandoffProvider } from '@/contexts/LoginHandoffContext';
import { EnvCheckProvider, EnvCheckGuard } from '@/contexts/EnvCheckContext';
import { WorktreeProvider } from '@/contexts/WorktreeContext';
import { PrRefsProvider } from '@/contexts/PrRefsContext';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { SplashScreen } from '@/components/splash/SplashScreen';
import { LoginFirstLaunchLightGateBridge } from '@/components/login/LoginFirstLaunchLightGateBridge';
import { LoginBrandStage } from '@/components/login/LoginBrandStage';
import { StartupLogSupport } from '@/components/log-support/StartupLogSupport';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { installGithubStarPrompt } from '@/lib/githubStarPrompt';
import { createGithubStarPromptEnvironment } from '@/lib/githubStarPromptHost';
import { ToastContainer } from '@/components/ui/toast';
import { LegacyMigrationDialog } from '@/components/auth/LegacyMigrationDialog';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { FindInPageBar } from '@/components/find-in-page/FindInPageBar';
import { ProjectAutomationNotifyBridge } from '@/features/scheduler/components/ProjectAutomationNotifyBridge';
import { GhostConfirmDialogHost } from '@/cindy-brain/GhostConfirmDialogHost';
import { PluginModelPickerHost } from '@/cindy-brain/PluginModelPickerHost';
import { LocalAgentConfirmationHost } from '@/components/LocalAgentConfirmationHost';
import { ForgeOidcInstallConfirmHost } from '@/cindy-brain/ForgeOidcInstallConfirmHost';
import { GhostInstallConsentHost } from '@/cindy-brain/GhostInstallConsentHost';
const PluginUiHost = lazy(() => import('@/cindy-brain/PluginUiHost').then(module => ({ default: module.PluginUiHost })));
import { PluginUiProvider } from '@/cindy-brain/PluginUiContributions';
import { SetupMigrationHost } from '@/features/setup-migration/SetupMigrationHost';
import { PluginPublisherConfirmHost } from '@/features/plugin/PluginPublisherConfirmHost';
import { GithubSetupRequestHost } from '@/features/cc-agent/GithubSetupRequestHost';
import { makerChatStore } from '@/lib/makerChatStore';
import { schedulePreviewLightboxPreload } from '@/components/chat/lazyPreviewLightboxes';
import {
  initializePromptRecommendationStore,
  setPromptRecommendationOwner,
} from '@/lib/promptRecommendationStore';
import { installSystemNetworkErrorToastListener } from '@/lib/systemNetworkErrorToast';
import { installSilentInstallToastListener } from '@/lib/silentInstallToast';
import { installProviderUpstreamErrorToastListener } from '@/lib/providerUpstreamErrorToast';
import { installAutoPermissionFallbackToastListener } from '@/lib/autoPermissionFallbackToast';
import { agentKindToVendor } from '@/components/sidebar/VendorIcon';
import { installCcMgrUpgradeListener } from '@/state/ccMgrUpgradeStore';
import {
  preloadLocalCatalogSnapshot,
  refreshLocalCatalogSnapshot,
  startLocalCatalogRecovery,
} from '@/lib/localCatalogSnapshot';
import { useResyncAgentIslandSettingsAfterLogin } from '@/hooks/useAgentIslandSettings';
import {
  getDraft,
  getDraftForOwnerPreferenceSync,
  applyAppDefaultModelSelection,
  subscribeDraft,
  setEffortForModel,
  setFastModeForModel,
  setWorktreePreference,
  patchVendorPrefs,
  patchVendorPrefsFromTaskModelSwitch,
  patchVendorPrefsPreservingModelChoice,
} from '@/state/newMakerDraft';
import { getCachedProvidersSnapshot } from '@/lib/providersSnapshotStore';
import { resolveDraftEffectiveProviderId } from '@/lib/draftModelCalibration';
import { isModelEnabled } from '@/state/modelVisibilityPrefs';
import {
  snapshotForSeed,
  setProviderModelChoice,
  setProviderModelEffort,
  setProviderModelFast,
  setProviderModelThinking,
  subscribeProviderModelMemory,
} from '@/state/providerModelMemory';
import {
  applyWorkerRolesMutation,
  readWorkerCreationPrefs,
  setWorkerPermissionModePreference,
  subscribeWorkerCreationPrefs,
  toRemoteWorkerRoles,
  writeWorkerCreationPrefs,
} from '@/state/workerCreationPrefs';
import type { OrcaWorkerRolesMutation } from '@cindy/device-link';
import type { Effort } from '@/lib/userPreferences.types';

import { router } from './router';

/**
 * 动画消费 AppShellCover 派生的当前目标；AuthContext 仍拥有认证和账号边界。
 */
function LoginHandoffHost({ children }: { children: React.ReactNode }) {
  const { isInitializing, canEnterApp } = useAuth();
  const { startupTarget } = useAppShellCover();
  return (
    <LoginHandoffProvider target={startupTarget}>
      {/* 认证恢复后已登录(直进受保护路由、LoginPage 不挂载)时结束首启亮色门,
          避免 renderer localStorage 被清空但主进程仍持有会话时整个已登录会话
          被永久锁亮色;未登录场景仍由 LoginPage 卸载结束门(见组件头注释)。 */}
      <LoginFirstLaunchLightGateBridge authResolved={!isInitializing} canEnterApp={canEnterApp} />
      {children}
    </LoginHandoffProvider>
  );
}

function syncWorkerPrefs() {
  const owner = getDataOwnerGeneration();
  window.electronAPI.syncWorkerCreationPrefs({
    workerPermissionMode: readWorkerCreationPrefs().workerPermissionMode,
    selection: readLocalWorkerCreationSelection(owner.dataOwnerId),
    // 角色清单与每个角色的记忆：手机与远程控制的电脑读的就是这份镜像。
    roles: toRemoteWorkerRoles(readWorkerCreationPrefs(), owner.dataOwnerId),
    ownerStamp: { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation },
  });
}

/** 手机或远程控制的电脑改了这台电脑的角色清单：只在仍是同一个账号时写回真源。 */
function applyRemoteWorkerRolesMutation(payload: {
  mutation: OrcaWorkerRolesMutation;
  ownerStamp: { dataOwnerId: string | null; ownerGeneration: number };
}) {
  const owner = getDataOwnerGeneration();
  if (
    payload.ownerStamp.dataOwnerId !== owner.dataOwnerId
    || payload.ownerStamp.ownerGeneration !== owner.generation
  ) return;
  writeWorkerCreationPrefs(
    applyWorkerRolesMutation(readWorkerCreationPrefs(), owner.dataOwnerId, payload.mutation),
  );
}

function syncNewMakerPrefs(appDefaultModelRequestId?: string) {
  syncWorkerPrefs();
  // 多 renderer 的模块内存彼此独立；跨窗口通知必须从共享持久快照同步，避免旧窗口把
  // 自己的 model / workingDir 等完整旧草稿覆盖进 main 缓存。
  const owner = getDataOwnerGeneration();
  const draft = getDraftForOwnerPreferenceSync(owner.dataOwnerId);
  if (!draft) return;
  const providerModelMemory = snapshotForSeed(owner.dataOwnerId);
  if (!providerModelMemory) return;
  const cc = draft.lastByVendor.cc;
  window.electronAPI.syncDesktopCcPrefs({
    model: cc.model,
    effort: cc.effort,
    permissionMode: cc.permissionMode,
    fastMode: (draft.fastModeByModel[cc.model] ?? false),
    // /ctr 新建会话需要与模型配套的供应商路由；缺省会走隐式路由落到官方网关，
    // 用户供应商专有的模型（如 deepseek-v4-pro）会被网关 400 拒绝。
    providerId: cc.providerId ?? null,
  });
  // main 缓存两用途:① collab worker spawn 读 model/effort/fastMode;② device-link 远程
  // 草稿镜像读全量(model/effort/fast/permission/source)+「是否显式选过模型」。故
  // lastByVendor 覆盖 cc/codex/pi，并带上 permissionMode + providerId(worker spawn
  // 不消费这两项,远程草稿镜像才用)。fire-and-forget。
  const selected = draft.lastByVendor[draft.vendor];
  window.electronAPI.syncNewMakerDraft({
    ...(appDefaultModelRequestId ? { appDefaultModelRequestId } : {}),
    ownerStamp: { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation },
    selectedRoute: {
      ...(draft.agentDeviceId ? { agentDeviceId: draft.agentDeviceId } : {}),
      harness: draft.vendor === 'cc' || draft.vendor === 'orca' ? 'claude' : draft.vendor,
      providerId: selected.providerId ?? null,
      model: selected.model,
      effort: selected.effort ?? '',
      fastMode: (draft.fastModeByModel[selected.model] ?? false),
    },
    lastByVendor: {
      cc: {
        model: draft.lastByVendor.cc.model,
        effort: draft.lastByVendor.cc.effort,
        permissionMode: draft.lastByVendor.cc.permissionMode,
        providerId: draft.lastByVendor.cc.providerId ?? null,
      },
      codex: {
        model: draft.lastByVendor.codex.model,
        effort: draft.lastByVendor.codex.effort,
        permissionMode: draft.lastByVendor.codex.permissionMode,
        providerId: draft.lastByVendor.codex.providerId ?? null,
      },
      pi: {
        model: draft.lastByVendor.pi.model,
        effort: draft.lastByVendor.pi.effort,
        permissionMode: draft.lastByVendor.pi.permissionMode,
        providerId: draft.lastByVendor.pi.providerId ?? null,
      },
    },
    modelChosenByVendor: {
      cc: draft.modelChosenByVendor.cc === true,
      codex: draft.modelChosenByVendor.codex === true,
      pi: draft.modelChosenByVendor.pi === true,
    },
    fastModeByModel: draft.fastModeByModel,
    effortByModel: draft.effortByModel,
    providerModelMemory,
    // worktree 勾选记忆(vendor 无关根字段):远程草稿(手机 / 桌面控制端)播种用。
    worktreeEnabled: draft.worktreeEnabled,
  });
}

function MakerBootstrap() {
  const { isAuthenticated, dataOwnerId, dataOwnerRecoveryEpoch } = useAuth();

  useResyncAgentIslandSettingsAfterLogin(isAuthenticated);

  // Remote SSH handlers register during the environment check. Read the
  // snapshot only after that gate passes, then keep receiving live pushes.
  useEffect(() => installCcMgrUpgradeListener(), []);

  useEffect(() => {
    if (!isAuthenticated || isSecondaryWindow() || isSidebarWindow()) return;
    return installGithubStarPrompt(createGithubStarPromptEnvironment(router));
  }, [isAuthenticated, dataOwnerId, dataOwnerRecoveryEpoch]);

  useEffect(() => {
    setPromptRecommendationOwner(`${dataOwnerId ?? 'signed-out'}:${dataOwnerRecoveryEpoch}`);
    initializePromptRecommendationStore();
  }, [dataOwnerId, dataOwnerRecoveryEpoch]);

  useEffect(() => {
    const stopCatalogRecovery = startLocalCatalogRecovery();
    makerChatStore.syncActiveTurnsFromMain();
    // main 先提交 active catalog + capabilities 再广播；renderer 收到任一目录/鉴权变化后
    // 联合重拉 providers 与两份 capabilities，整组成功且代际最新时才切换。
    const refresh = () => {
      void refreshLocalCatalogSnapshot();
    };
    const offAuth = window.electronAPI.maker.auth.onStateChanged(refresh);
    const offProviders = window.electronAPI.maker.onProvidersChanged(refresh);
    return () => {
      stopCatalogRecovery();
      offAuth?.();
      offProviders?.();
    };
  }, []);

  // Auth 广播的多个 listener 没有顺序契约；等 AuthContext 提交新 owner 后再预热一次，
  // 保证 provider 快照与 capabilities 不会沿用或提交前一个 owner 的在途结果。
  useEffect(() => {
    void preloadLocalCatalogSnapshot();
  }, [dataOwnerId, dataOwnerRecoveryEpoch]);
  // Early fire-and-forget sends can precede maker IPC registration. Repeat after
  // the ready/owner boundary and after every owner generation change (same-owner
  // repairs included, #4469), using the same persisted preference snapshot.
  useNewMakerPrefsOwnerResync(syncNewMakerPrefs);
  return null;
}

function OwnerScopedRouter() {
  const { dataOwnerId, dataOwnerRecoveryEpoch, canEnterApp } = useAuth();
  const ownerKey = `${dataOwnerId ?? 'signed-out'}:${dataOwnerRecoveryEpoch}`;
  return (
    <PluginUiProvider enabled={canEnterApp} host={<Suspense fallback={null}><PluginUiHost /></Suspense>}>
    <MainViewHistoryProvider ownerKey={ownerKey} locationKey={router.state.location.key}>
      <RouterProvider key={ownerKey} router={router} />
    </MainViewHistoryProvider>
    </PluginUiProvider>
  );
}

export function App() {
  useDisableContextMenu();
  // mac ⌘W 根级兜底: splash / env check / 登录 / 迁移等壳外阶段关(隐藏)本窗口;
  // MainLayout / SidebarWindowLayout 挂载期间声明所有权, 本兜底让路给壳层的
  // 焦点分派消费点 (右侧栏 tab 优先)。见 useCloseWindowShortcut.ts。
  useCloseWindowFallbackShortcut();

  // F-PSI-4: install the single global CC Agent IPC listener exactly once,
  // regardless of which session view mounts first. The store itself is
  // idempotent, so StrictMode / HMR re-mounts don't double-subscribe.
  // NOTE: initGlobalListeners registers push-channel listeners only (ipcRenderer.on);
  // invoke-dependent calls (syncActiveTurnsFromMain, preloadAllCapabilities) are deferred
  // to <MakerBootstrap /> inside EnvCheckGuard to avoid the startup race where maker:*
  // IPC handlers aren't registered yet. syncPrefs below uses fire-and-forget send.
  useEffect(() => {
    makerChatStore.initGlobalListeners();

    // 启动时立刻推送一次 cc vendor 偏好 + 完整 newMakerDraft 快照给 main:
    //  - syncDesktopCcPrefs: 给飞书接管新建 session 用 (仅 cc vendor)
    //  - syncNewMakerDraft: 给 collab mode spawn worker 用 (双 vendor + 按模型记忆)
    // 都是 ipcRenderer.send fire-and-forget; handler 在 createWindow 前已注册。
    syncNewMakerPrefs();
    return subscribeDraft(syncNewMakerPrefs);
  }, []);

  // 文本／Mermaid 预览弹窗不进首屏;窗口可见、首帧稳定后空闲预取,首次点开不必等加载。
  useEffect(() => schedulePreviewLightboxPreload(), []);

  useModelFavoritesHost();

  // Worker 创建偏好的真源是 renderer localStorage；main 缓存权限与当前账号本机路线供
  // Orca UI / agent tool 的创建路径读取。tool 显式改默认时再经 apply push 回写真源。
  useEffect(() => {
    syncWorkerPrefs();
    const unsubscribe = subscribeWorkerCreationPrefs(syncWorkerPrefs);
    const offApply = window.electronAPI.onWorkerCreationPrefsApply(({ workerPermissionMode }) => {
      setWorkerPermissionModePreference(workerPermissionMode);
    });
    // 写回后 subscribeWorkerCreationPrefs 会把新的角色清单再镜像给 main。
    const offRoles = window.electronAPI.onWorkerRolesApplyRequest(applyRemoteWorkerRolesMutation);
    return () => {
      unsubscribe();
      offApply();
      offRoles();
    };
  }, []);

  // device-link 被控端单一真相:把 providerModelMemory(草稿模型列表行的真实读源)全量镜像给 main,
  // 让控制端经 maker:get-new-maker-defaults / NEW_MAKER_DRAFT_CHANGED 完整看到被控端每个模型的
  // 全局 effort/fast 预设(旧 newMakerDraft.effortByModel 已不再写非选中行,故必须单独镜像这一层)。
  // 启动推一次 + 变化增量推,fire-and-forget;无控制者订阅时 main 端转发近似 no-op。
  useEffect(() => {
    const sync = () => {
      window.electronAPI.syncProviderModelMemory(snapshotForSeed());
      syncNewMakerPrefs();
    };
    sync();
    return subscribeProviderModelMemory(sync);
  }, []);

  // device-link 被控端:接收控制端写穿的「模型 effort/fast」pref,写被控端自己的全局模型预设。
  // 当前正在使用该模型的会话仍由各自 live DB/runtime 值保护;其它对话的非选中行和之后的切换
  // 通过 providerModelMemory 同步。写入触发上面的镜像 effect → NEW_MAKER_DRAFT_CHANGED 回流控制端。
  useEffect(() => {
    const offDraft = window.electronAPI.onMakerDraftPrefApply(
      ({
        agent,
        providerId,
        modelId,
        active,
        effort,
        fast,
        thinking,
        markModelChoice,
        taskProviderId,
        appDefaultSelection,
      }) => {
        if (appDefaultSelection) {
          if (applyAppDefaultModelSelection(appDefaultSelection)) {
            const route = appDefaultSelection.route;
            setProviderModelChoice(
              agent,
              route.providerId ?? '',
              route.model,
              route.effort as Effort,
            );
            setProviderModelFast(agent, route.providerId ?? '', route.model, route.fastMode);
            syncNewMakerPrefs(appDefaultSelection.requestId);
          }
          return;
        }
        const vendor = agentKindToVendor(agent);
        if (active && taskProviderId && markModelChoice !== false) {
          // 控制端在本机任务里只换了模型:按本机自己的新建默认判断是否写回(同本机换模)。
          patchVendorPrefsFromTaskModelSwitch(
            vendor,
            {
              model: modelId,
              providerId: providerId || null,
              ...(effort !== undefined ? { effort: effort as Effort } : {}),
            },
            taskProviderId,
            (prefs) =>
              resolveDraftEffectiveProviderId({
                providers: getCachedProvidersSnapshot()?.providers ?? [],
                agent,
                model: prefs.model,
                providerId: prefs.providerId,
                chosenByUser: getDraft().modelChosenByVendor[vendor] === true,
                isModelEnabled,
              }),
          );
        } else if (active) {
          const patch =
            markModelChoice === false ? patchVendorPrefsPreservingModelChoice : patchVendorPrefs;
          const shouldPatchActiveModel = markModelChoice !== false || effort !== undefined;
          if (shouldPatchActiveModel) {
            patch(vendor, {
              // markModelChoice=false 仍要写回当前活动模型:远程新建草稿
              // pushActiveDraftPref、以及旧控制端换模都走这条 wire。丢掉 model
              // 会让被控端 lastByVendor 停在旧模型。选模标记由 store 的
              // preserving 路径单独守住,这里只负责同步当前活动值。
              model: modelId,
              providerId: providerId || null,
              ...(effort !== undefined ? { effort: effort as Effort } : {}),
            });
          }
        }
        if (effort !== undefined) {
          if (markModelChoice === true || (active && markModelChoice !== false)) {
            setProviderModelChoice(agent, providerId, modelId, effort as Effort);
          } else {
            setProviderModelEffort(agent, providerId, modelId, effort as Effort);
          }
          if (active) setEffortForModel(modelId, effort as Effort); // 旧层兜底保持一致
        }
        if (fast !== undefined) {
          setProviderModelFast(agent, providerId, modelId, fast);
          if (active) setFastModeForModel(modelId, fast); // 旧层兜底保持一致
        }
        if (thinking !== undefined) {
          setProviderModelThinking(agent, providerId, modelId, thinking);
        }
      },
    );
    const offSession = window.electronAPI.onMakerSessionPrefApply(
      ({ sessionId, agent, providerId, model, effort, fast }) => {
        if (effort !== undefined) {
          setProviderModelEffort(agent, providerId, model, effort as Effort);
        }
        if (fast !== undefined) setProviderModelFast(agent, providerId, model, fast);
        // 兼容旧控制端仍按 session scope 监听的回流;新控制端同时会从 providerModelMemory 的
        // NEW_MAKER_DRAFT_CHANGED 全量镜像收敛。两条都是同值幂等,不会反向 invoke。
        window.electronAPI.syncSessionModelPref({
          sessionId,
          agent,
          providerId,
          model,
          ...(effort !== undefined ? { effort } : {}),
          ...(fast !== undefined ? { fast } : {}),
        });
      },
    );
    // 控制端写穿的「新建会话默认启用 worktree」:按共享 localStorage 的最新对象只合并
    // 该字段;写入触发 subscribeDraft → SYNC_NEW_MAKER_DRAFT re-mirror → 广播回流。
    const offWorktree = window.electronAPI.onMakerWorktreePrefApply(({ worktreeEnabled }) => {
      setWorktreePreference(worktreeEnabled === true);
    });
    return () => {
      offDraft();
      offSession();
      offWorktree();
    };
  }, []);

  // Lifecycle 在 main 进程兜底 catch 到瞬时网络错误 (VPN 抖动等) 时会推一次,
  // renderer 弹一条带节流的 warning toast 让用户感知到; 详见 systemNetworkErrorToast.ts。
  useEffect(() => {
    return installSystemNetworkErrorToastListener();
  }, []);

  // Phase D — maker:send 触发的远端 agent 静默安装 (codex 没装就自动跑 install)
  // 状态推到 renderer, 用一条 toast 反馈阶段性进度 + 失败提示。详见 silentInstallToast.ts。
  useEffect(() => {
    return installSilentInstallToastListener();
  }, []);

  // 自定义供应商上游错误 (proxy 观察器分类广播, main 侧已节流) → 分类人话 toast +
  // 修复引导。详见 providerUpstreamErrorToast.ts。
  useEffect(() => {
    return installProviderUpstreamErrorToastListener();
  }, []);

  // Claude Auto classifier 429/5xx 后, main 已把该会话切到 ask; 本机或
  // device-link 控制端都显示一次可操作的人话提示, 不再让用户盲目重试。
  useEffect(() => {
    return installAutoPermissionFallbackToastListener();
  }, []);

  return (
    <ThemeProvider>
      <FontSettingsProvider>
        <WallpaperSettingsProvider>
          <LocaleProvider>
            <AppPreferenceControl />
            <ConfirmDialogProvider>
              <EnvCheckProvider>
                <AuthProvider>
                  <HostConnectionNotice />
                  <PluginReviewUpdatesProvider>
                  <AppShellCoverProvider>
                    <WorktreeProvider>
                      <PrRefsProvider>
                        <Tooltip.Provider>
                          {/* LoginHandoffProvider 包 SplashScreen + RouterProvider(Step 3b
                          WHAT2 宿主契约):Splash→登录/主界面衔接动画状态机。
                          LoginBrandStage = 品牌视觉唯一渲染者(白底体系背景 + 立绘/
                          字标/Slogan),overlay pointer-events:none,仅主窗挂载(与
                          Splash gating 同源;副窗/sidebar 窗不挂)。 */}
                          <LoginHandoffHost>
                            {/* 副窗口(「在新窗口打开」)/ 右侧栏子窗口跳过 splash:env/热更检查
                            由主窗启动时完成,附属窗 EnvCheckProvider 初始即 'passed',
                            不需要也不应再走 splash 流程。 */}
                            {!isSecondaryWindow() && !isSidebarWindow() && <LoginBrandStage />}
                            {!isSecondaryWindow() && !isSidebarWindow() && <SplashScreen />}
                            <EnvCheckGuard>
                              <MakerBootstrap />
                              <AppWindowSync />
                              {!isSecondaryWindow() && !isSidebarWindow() && <RemoteDesktopHost />}
                              <ProjectAutomationNotifyBridge />
                              {/* confirm 槽:插件请主机弹确认框。必须在 ConfirmDialogProvider
                              内(要 useConfirmDialog);main 只投单个窗口,所以每个窗口
                              都挂、谁收到谁弹,不按窗口类型 gate。 */}
                              <GhostConfirmDialogHost />
                              <PluginModelPickerHost />
                              <LocalAgentConfirmationHost />
                              <ForgeOidcInstallConfirmHost />
                              <GhostInstallConsentHost />
                              {/* 迁移助理与开始引导:只挂主窗(应答界面偏好读取、首次登录后按需显示引导、迁移弹窗)。 */}
                              {!isSecondaryWindow() && !isSidebarWindow() && <SetupMigrationHost />}
                              <PluginPublisherConfirmHost />
                              <GithubSetupRequestHost />
                              <OwnerScopedRouter />
                            </EnvCheckGuard>
                            {!isSecondaryWindow() && !isSidebarWindow() && <StartupLogSupport />}
                          </LoginHandoffHost>
                          <FindInPageBar />
                          <ToastContainer />
                          {/* 首登轻量数据迁移弹窗:只挂主窗(副窗/侧栏窗不重复弹) */}
                          {!isSecondaryWindow() && !isSidebarWindow() && <LegacyMigrationDialog />}
                        </Tooltip.Provider>
                      </PrRefsProvider>
                    </WorktreeProvider>
                  </AppShellCoverProvider>
                  </PluginReviewUpdatesProvider>
                </AuthProvider>
              </EnvCheckProvider>
            </ConfirmDialogProvider>
          </LocaleProvider>
        </WallpaperSettingsProvider>
      </FontSettingsProvider>
    </ThemeProvider>
  );
}
