import { RouterProvider } from 'react-router-dom';

import { useEffect } from 'react';

import { useCloseWindowFallbackShortcut } from '@/hooks/useCloseWindowShortcut';
import { useDisableContextMenu } from '@/hooks/useDisableContextMenu';
import { useDisableTab } from '@/hooks/useDisableTab';
import { ThemeProvider } from '@/hooks/useTheme';
import { FontSettingsProvider } from '@/hooks/useFontSettings';
import { LocaleProvider } from '@/hooks/useLocale';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { LoginHandoffProvider } from '@/contexts/LoginHandoffContext';
import { EnvCheckProvider, EnvCheckGuard } from '@/contexts/EnvCheckContext';
import { WorktreeProvider } from '@/contexts/WorktreeContext';
import { PrRefsProvider } from '@/contexts/PrRefsContext';
import { SplashScreen } from '@/components/splash/SplashScreen';
import { LoginFirstLaunchLightGateBridge } from '@/components/login/LoginFirstLaunchLightGateBridge';
import { LoginBrandStage } from '@/components/login/LoginBrandStage';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { isGhostPanelWindow } from '@/lib/ghostPanelWindow';
import { ToastContainer } from '@/components/ui/toast';
import { LegacyMigrationDialog } from '@/components/auth/LegacyMigrationDialog';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { FindInPageBar } from '@/components/find-in-page/FindInPageBar';
import { ProjectAutomationNotifyBridge } from '@/features/scheduler/components/ProjectAutomationNotifyBridge';
import { GhostConfirmDialogHost } from '@/cindy-brain/GhostConfirmDialogHost';
import { PluginMarketPermissionReviewHost } from '@/features/plugin/PluginMarketPermissionReviewHost';
import { makerChatStore } from '@/lib/makerChatStore';
import { installSystemNetworkErrorToastListener } from '@/lib/systemNetworkErrorToast';
import { installSilentInstallToastListener } from '@/lib/silentInstallToast';
import { installProviderUpstreamErrorToastListener } from '@/lib/providerUpstreamErrorToast';
import { installAutoPermissionFallbackToastListener } from '@/lib/autoPermissionFallbackToast';
import { agentKindToVendor } from '@/components/sidebar/VendorIcon';
import { installCcMgrUpgradeListener } from '@/state/ccMgrUpgradeStore';
import {
  preloadLocalCatalogSnapshot,
  refreshLocalCatalogSnapshot,
} from '@/lib/localCatalogSnapshot';
import { useResyncAgentIslandSettingsAfterLogin } from '@/hooks/useAgentIslandSettings';
import {
  getDraftForPreferenceSync,
  subscribeDraft,
  setEffortForModel,
  setFastModeForModel,
  setWorktreePreference,
  patchVendorPrefs,
  patchVendorPrefsPreservingModelChoice,
} from '@/state/newMakerDraft';
import {
  snapshotForSeed,
  setProviderModelChoice,
  setProviderModelEffort,
  setProviderModelFast,
  subscribeProviderModelMemory,
} from '@/state/providerModelMemory';
import {
  readWorkerCreationPrefs,
  setWorkerPermissionModePreference,
  subscribeWorkerCreationPrefs,
} from '@/state/workerCreationPrefs';
import type { Effort } from '@/lib/userPreferences.types';

import { router } from './router';

/**
 * LoginHandoffProvider 的 auth 接线壳:LoginHandoffContext 模块本身不 import
 * AuthContext(避免传递性引入重依赖),推进锚里的「auth 初始化完成」由本壳从
 * useAuth 取值下传(Step 3b WHAT2 宿主契约)。
 */
function LoginHandoffHost({ children }: { children: React.ReactNode }) {
  const { isInitializing, isAuthenticated, canEnterApp } = useAuth();
  return (
    <LoginHandoffProvider
      authResolved={!isInitializing}
      authenticated={isAuthenticated || canEnterApp}
    >
      {/* 认证恢复后已登录(直进受保护路由、LoginPage 不挂载)时结束首启亮色门,
          避免 renderer localStorage 被清空但主进程仍持有会话时整个已登录会话
          被永久锁亮色;未登录场景仍由 LoginPage 卸载结束门(见组件头注释)。 */}
      <LoginFirstLaunchLightGateBridge authResolved={!isInitializing} canEnterApp={canEnterApp} />
      {children}
    </LoginHandoffProvider>
  );
}

function MakerBootstrap() {
  const { isAuthenticated, dataOwnerId } = useAuth();

  useResyncAgentIslandSettingsAfterLogin(isAuthenticated);

  useEffect(() => {
    makerChatStore.syncActiveTurnsFromMain();
    // main 先提交 active catalog + capabilities 再广播；renderer 收到任一目录/鉴权变化后
    // 联合重拉 providers 与两份 capabilities，整组成功且代际最新时才切换。
    const refresh = () => {
      void refreshLocalCatalogSnapshot();
    };
    const offAuth = window.electronAPI.maker.auth.onStateChanged(refresh);
    const offProviders = window.electronAPI.maker.onProvidersChanged(refresh);
    return () => {
      offAuth?.();
      offProviders?.();
    };
  }, []);

  // Auth 广播的多个 listener 没有顺序契约；等 AuthContext 提交新 owner 后再预热一次，
  // 保证 provider 快照与 capabilities 不会沿用或提交前一个 owner 的在途结果。
  useEffect(() => {
    void preloadLocalCatalogSnapshot();
  }, [dataOwnerId]);
  return null;
}

function OwnerScopedRouter() {
  const { dataOwnerId, dataOwnerRecoveryEpoch } = useAuth();
  const ownerKey = `${dataOwnerId ?? 'signed-out'}:${dataOwnerRecoveryEpoch}`;
  return <RouterProvider key={ownerKey} router={router} />;
}

export function App() {
  useDisableContextMenu();
  useDisableTab();
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
    const syncPrefs = () => {
      // 多 renderer 的模块内存彼此独立；跨窗口通知必须从共享持久快照同步，避免旧窗口把
      // 自己的 model / workingDir 等完整旧草稿覆盖进 main 缓存。
      const draft = getDraftForPreferenceSync();
      const cc = draft.lastByVendor.cc;
      window.electronAPI.syncDesktopCcPrefs({
        model: cc.model,
        effort: cc.effort,
        permissionMode: cc.permissionMode,
        fastMode: draft.fastModeByModel[cc.model] === true,
      });
      // main 缓存两用途:① collab worker spawn 读 model/effort/fastMode;② device-link 远程
      // 草稿镜像读全量(model/effort/fast/permission/source)+「是否显式选过模型」。故
      // lastByVendor 覆盖 cc/codex/pi，并带上 permissionMode + providerId(worker spawn
      // 不消费这两项,远程草稿镜像才用)。fire-and-forget。
      window.electronAPI.syncNewMakerDraft({
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
        // worktree 勾选记忆(vendor 无关根字段):远程草稿(手机 / 桌面控制端)播种用。
        worktreeEnabled: draft.worktreeEnabled,
      });
    };
    syncPrefs();
    return subscribeDraft(syncPrefs);
  }, []);

  // Worker 创建偏好的真源是 renderer localStorage；main 只缓存权限默认值供
  // Orca UI / agent tool 的创建路径读取。tool 显式改默认时再经 apply push 回写真源。
  useEffect(() => {
    const sync = () => {
      const prefs = readWorkerCreationPrefs();
      window.electronAPI.syncWorkerCreationPrefs({
        workerPermissionMode: prefs.workerPermissionMode,
      });
    };
    sync();
    const unsubscribe = subscribeWorkerCreationPrefs(sync);
    const offApply = window.electronAPI.onWorkerCreationPrefsApply(({ workerPermissionMode }) => {
      setWorkerPermissionModePreference(workerPermissionMode);
    });
    return () => {
      unsubscribe();
      offApply();
    };
  }, []);

  // device-link 被控端单一真相:把 providerModelMemory(草稿模型列表行的真实读源)全量镜像给 main,
  // 让控制端经 maker:get-new-maker-defaults / NEW_MAKER_DRAFT_CHANGED 完整看到被控端每个模型的
  // 全局 effort/fast 预设(旧 newMakerDraft.effortByModel 已不再写非选中行,故必须单独镜像这一层)。
  // 启动推一次 + 变化增量推,fire-and-forget;无控制者订阅时 main 端转发近似 no-op。
  useEffect(() => {
    const sync = () => window.electronAPI.syncProviderModelMemory(snapshotForSeed());
    sync();
    return subscribeProviderModelMemory(sync);
  }, []);

  // device-link 被控端:接收控制端写穿的「模型 effort/fast」pref,写被控端自己的全局模型预设。
  // 当前正在使用该模型的会话仍由各自 live DB/runtime 值保护;其它对话的非选中行和之后的切换
  // 通过 providerModelMemory 同步。写入触发上面的镜像 effect → NEW_MAKER_DRAFT_CHANGED 回流控制端。
  useEffect(() => {
    const offDraft = window.electronAPI.onMakerDraftPrefApply(
      ({ agent, providerId, modelId, active, effort, fast, markModelChoice }) => {
        const vendor = agentKindToVendor(agent);
        if (active) {
          const patch =
            markModelChoice === false ? patchVendorPrefsPreservingModelChoice : patchVendorPrefs;
          const shouldPatchActiveModel = markModelChoice !== false || effort !== undefined;
          if (shouldPatchActiveModel) {
            patch(vendor, {
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

  // cc-mgr 版本不匹配的 UpgradeBanner: 订阅 main 的 CC_MGR_UPGRADE_AVAILABLE push +
  // 启动时拉一次 pending snapshot, 写进 ccMgrUpgradeStore。没挂这个 listener 的话
  // main 探到版本差异 broadcast 了也没人接, banner 永不显示。详见 ccMgrUpgradeStore.ts。
  useEffect(() => {
    return installCcMgrUpgradeListener();
  }, []);

  return (
    <ThemeProvider>
      <FontSettingsProvider>
        <LocaleProvider>
          <ConfirmDialogProvider>
            <EnvCheckProvider>
              <AuthProvider>
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
                        {!isSecondaryWindow() && !isSidebarWindow() && !isGhostPanelWindow() && (
                          <LoginBrandStage />
                        )}
                        {!isSecondaryWindow() && !isSidebarWindow() && !isGhostPanelWindow() && (
                          <SplashScreen />
                        )}
                        <EnvCheckGuard>
                          <MakerBootstrap />
                          <ProjectAutomationNotifyBridge />
                          {/* confirm 槽:插件请主机弹确认框。必须在 ConfirmDialogProvider
                              内(要 useConfirmDialog);main 只投单个窗口,所以每个窗口
                              都挂、谁收到谁弹,不按窗口类型 gate。 */}
                          <GhostConfirmDialogHost />
                          <PluginMarketPermissionReviewHost />
                          <OwnerScopedRouter />
                        </EnvCheckGuard>
                      </LoginHandoffHost>
                      <FindInPageBar />
                      <ToastContainer />
                      {/* 首登轻量数据迁移弹窗:只挂主窗(副窗/侧栏窗不重复弹) */}
                      {!isSecondaryWindow() && !isSidebarWindow() && !isGhostPanelWindow() && (
                        <LegacyMigrationDialog />
                      )}
                    </Tooltip.Provider>
                  </PrRefsProvider>
                </WorktreeProvider>
              </AuthProvider>
            </EnvCheckProvider>
          </ConfirmDialogProvider>
        </LocaleProvider>
      </FontSettingsProvider>
    </ThemeProvider>
  );
}
