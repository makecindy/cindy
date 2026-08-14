/**
 * SidebarWindowLayout —— 右侧栏独立子窗口的根组件(路由 `/sidebar-window`)。
 *
 * 窗口由 main/right-sidebar-window/window.ts 打开(`?sidebarWindow=1`),本组件:
 *   - 画 46px 自绘 chrome:整条 drag region;mac 左端为红绿灯让位、win 右端复用
 *     WindowControls(close 语义在 main 按 sender 区分,子窗口 = 只关本窗);
 *     右端「合并回主窗口」按钮 → setDetached(false)(main 落盘偏好 + 关本窗,
 *     主窗收广播后恢复内嵌侧栏)。
 *   - 挂 RightSidebarShell(零改动复用:Shell 自带 store 订阅 / rsbBrowserBridge
 *     init / setActiveSession / popup 订阅)。
 *   - 渲染上下文(sessionId / workdir / remoteHostId / deviceLinkDeviceId)不自查 —— 主窗 MainLayout
 *     是唯一真相(草稿会话 / remote 会话语义只有主窗路由视图知道),经 main 中转:
 *     mount 时 invoke getContext 拉一次,此后订阅 context-changed 推送跟随主窗切换。
 *   - mount 后 invoke ready() 握手:main 的 ensureOpenForAutomation(agent tab-op
 *     先开窗)等这个信号才 dispatch。
 *   - 订阅 sidebarCommands 的 visibility 请求:本窗口内 rsbBrowserBridge 执行
 *     tab-op 后触发。'close'(agent 关掉最后一个 tab)→ 关窗;'open' → no-op
 *     (窗口本来就开着)。
 *   - 订阅 main 命令推送(open-terminal:主窗终端快捷键转发)。
 *
 * 注:device-link 远程会话镜像是每个 renderer 进程一份,本窗口必须和主窗一样
 * 挂 useDeviceLinkRemoteProjects。这样 right-sidebar store 可识别远程 session
 * 走 memory-only,Orca worker 列表 / end team / close decision 也能按 sessionId
 * 来源路由到被控端。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight } from 'lucide-react';

import { RightSidebarShell } from '@/features/right-sidebar/RightSidebarShell';
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';
import { onRequestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { executeSidebarCommand } from '@/features/right-sidebar/lib/executeSidebarCommand';
import {
  closeTab,
  getBucket,
  getTabSnapshot,
  importTabSnapshot,
} from '@/features/right-sidebar/store';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import { useLocale } from '@/hooks/useLocale';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { GhostMediaLightboxHost } from '@/cindy-brain/GhostMediaLightboxHost';
import {
  ensureGhostPanelsRegistered,
  useGhostPanelsSync,
} from '@/cindy-brain/ghostPanels';

const log = createLogger('SidebarWindowLayout');

const SIDEBAR_CONTEXT_REFRESH_RETRY_DELAYS_MS = [250, 750] as const;

interface SidebarWindowContext {
  sessionId: string | null;
  workdir: string | null;
  remoteHostId: string | null;
  deviceLinkDeviceId?: string | null;
  available: boolean;
}

export function SidebarWindowLayout() {
  const { t } = useTranslation();
  const { effectiveLocale, setLocale } = useLocale();
  useDeviceLinkRemoteProjects();
  // 意识面板注册:子窗口没有 LayoutRoot,必须自行初始化 ghost 面板注册表
  // 并订阅 ghosts:changed(停靠形态所需;历史持久化的 ghost 页签也靠它识别 kind)。
  ensureGhostPanelsRegistered();
  useGhostPanelsSync();
  useEffect(() => {
    // 子窗口需要实时事件来维护面板内容，但认证失败后的凭证读取、会话重启与消息重发
    // 必须只由主 renderer 执行，避免多个 renderer 对同一远程任务并发重试。
    makerChatStore.initGlobalListeners({ ownsRemoteAuthRetry: false });
  }, []);
  const isMac = window.electronAPI?.platform === 'darwin';
  const [ctx, setCtx] = useState<SidebarWindowContext | null>(null);
  // 预热窗口初始隐藏；由 main 的 visibility push 驱动 Shell 内各子面板暂停/恢复。
  const [windowVisible, setWindowVisible] = useState(false);
  const visibilityRevisionRef = useRef(0);
  const contextRevisionRef = useRef(0);
  const presentationReadySentRef = useRef(false);
  // 复用隐藏窗口时，Chromium 可能保留上一次关闭按钮的 focus / :hover 状态。
  // 与资源用量窗口一致，隐藏时重挂载 chrome，确保再次显示从干净状态开始。
  const [windowChromeRevision, setWindowChromeRevision] = useState(0);

  // mount:拉一次 context + 订阅跟随推送 + renderer-ready 握手。
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.rightSidebarWindow
      .getContext()
      .then((initial) => {
        if (!cancelled) setCtx((prev) => prev ?? initial);
      })
      .catch((err) => log.warn('getContext failed', err));
    const offCtx = window.electronAPI.rightSidebarWindow.onContextChanged((next) => {
      contextRevisionRef.current += 1;
      setCtx(next);
    });
    // 必须早于 presentationReady() 注册：冷分离窗的主窗快照由 main 在
    // presentation-ready 回调中投递，晚注册会丢掉这条一次性 handoff。
    const offTabHandoff = window.electronAPI.rightSidebarWindow.onTabHandoff((handoff) => {
      for (const snapshot of handoff.snapshots) importTabSnapshot(snapshot);
    });
    // renderer-ready:Shell 已挂载,controller 可知 React 组件树就绪。
    void window.electronAPI.rightSidebarWindow.rendererReady().catch((err) => {
      log.warn('renderer-ready handshake failed', err);
    });
    return () => {
      cancelled = true;
      offCtx();
      offTabHandoff();
    };
  }, []);

  useEffect(() => {
    return window.electronAPI.onLocaleChanged?.((locale) => {
      if (locale !== effectiveLocale) setLocale(locale);
    }) ?? undefined;
  }, [effectiveLocale, setLocale]);

  // presentation-ready 只代表轻量壳已经提交首帧。不能等待主窗 context:
  // 隐藏预热阶段 Chromium 可能节流 renderer，而 context 又由主窗异步上推；
  // 把二者绑定会形成「等 context 才 ready、等 ready 才显示」的循环，最终只能
  // 命中 controller 的 5s fallback。真实任务上下文继续由 getContext / 推送恢复。
  useEffect(() => {
    if (presentationReadySentRef.current) return;
    presentationReadySentRef.current = true;
    void window.electronAPI.rightSidebarWindow.presentationReady().catch((err) => {
      log.warn('presentation-ready handshake failed', err);
    });
  }, []);

  // 隐藏/显示时刷新 context(主窗 session 可能已切换)并重置瞬时交互态。
  // 重新显示不能先恢复交互再异步收 context：否则媒体预览等宿主能力会在短暂窗口内
  // 沿用隐藏前的 session。这里先保持 Shell 不可交互并撤销旧 context，拿到 main 的
  // 当前快照后才恢复；revision 防止快速 hide/show 时迟到的请求重新激活窗口。
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };

    const refreshForRevision = (revision: number, contextRevision: number, attempt: number) => {
      void window.electronAPI.rightSidebarWindow
        .getContext()
        .then((next) => {
          if (cancelled || visibilityRevisionRef.current !== revision) return;
          // 请求期间若已有更新的 context-changed 推送，以推送为准，避免迟到的
          // invoke 快照把新会话覆盖回旧会话。
          if (contextRevisionRef.current === contextRevision) setCtx(next);
          setWindowVisible(true);
        })
        .catch((err) => {
          if (cancelled || visibilityRevisionRef.current !== revision) return;
          log.warn('refresh context on show failed', { err, attempt });
          if (contextRevisionRef.current !== contextRevision) {
            // A newer push won the race, so its context is safe to reveal.
            setWindowVisible(true);
            return;
          }
          const delay = SIDEBAR_CONTEXT_REFRESH_RETRY_DELAYS_MS[attempt];
          if (delay === undefined) {
            // Keep the shell visible as a safe placeholder for recovery, but
            // never expose the previous session after all refresh attempts
            // fail. A later context-changed push can populate the shell
            // without requiring another native visibility transition.
            setCtx(null);
            setWindowVisible(true);
            return;
          }
          retryTimer = setTimeout(() => {
            retryTimer = null;
            refreshForRevision(revision, contextRevision, attempt + 1);
          }, delay);
        });
    };

    const offVisibility = window.electronAPI.rightSidebarWindow.onVisibilityChanged((payload) => {
      const revision = ++visibilityRevisionRef.current;
      if (!payload.visible) {
        clearRetryTimer();
        setWindowVisible(false);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setWindowChromeRevision((revision) => revision + 1);
      } else {
        clearRetryTimer();
        setWindowVisible(false);
        const contextRevision = contextRevisionRef.current;
        // controller 在发送 visible:true 前已经切换为可见态，getContext 此时返回
        // main 缓存的最新快照；与单向 refresh push 相比，可明确等待本轮刷新完成。
        refreshForRevision(revision, contextRevision, 0);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    });

    return () => {
      cancelled = true;
      clearRetryTimer();
      offVisibility();
    };
  }, []);

  // ctx 同时是 keep-alive 宿主：隐藏期间保留旧 session，让 webview / terminal / review
  // 等标签主体继续挂载，只通过 shellVisible 暂停其工作。涉及用户操作的宿主能力
  // 必须另行受 windowVisible 门控，不能把挂载上下文当成交互授权。
  const sessionId = ctx?.available ? ctx.sessionId : null;
  const interactiveSessionId = windowVisible ? sessionId : null;

  // agent tab-op 触发的可见性请求(本窗口内 rsbBrowserBridge 派发):
  //  - 'close'(最后一个 tab 被关)且目标是当前会话 → 收起 = 关本窗口
  //  - 'open' → no-op(窗口已开);异会话请求忽略(tab 已入库,切过去自然可见)
  useEffect(() => {
    return onRequestRightSidebarVisibility((visibility, opts) => {
      const target = opts.sessionId ?? interactiveSessionId;
      if (!target || target !== interactiveSessionId) return;
      if (visibility === 'close') {
        void window.electronAPI.rightSidebarWindow.close().catch((err) => {
          log.warn('close via visibility request failed', err);
        });
      }
    });
  }, [interactiveSessionId]);

  // 主窗命令转发:
  // - open-terminal 快捷键:必须先 hydrate 再 add/focus,语义对齐 MainLayout。
  // - open-file-browser:detached 模式下聊天流仍在主窗,但真实 file-browser
  //   host 在本子窗口;定位请求必须在本 renderer 的 store 中消费。
  // - ensure/close-orca-workers-tab:协同 tab 在 detached 模式下也必须由本
  //   renderer 的 store 消费;远程会话走 memory-only,不能靠主窗 store/SQLite 同步。
  useEffect(() => {
    return window.electronAPI.rightSidebarWindow.onCommand((cmd) => {
      void executeSidebarCommand(cmd).catch((err) => log.warn('sidebar command failed', err));
    });
  }, []);

  // ⌘W / Ctrl+W ('close-tab-or-window'): 本窗口整个就是右侧栏, 不需要 MainLayout
  // 那样的焦点包含判定 —— 有激活 tab 就关它 (terminal 走 onBeforeClose dispose
  // PTY); 没有 tab 时关本窗口 (走 rightSidebarWindow.close, 与「合并回主窗」的
  // visibility 'close' 同一条 main 端收口路径)。webview guest 内的 ⌘W 由 main
  // 端 webview-security 拦截转发 'close-tab', 不经过本监听。
  // 声明壳层所有权 —— App 根的 useCloseWindowFallbackShortcut 让路给本消费点。
  useCloseShortcutShellOwner();
  useAppShortcut('close-tab-or-window', () => {
    if (interactiveSessionId) {
      const bucket = getBucket(interactiveSessionId);
      if (bucket.activeTabId) {
        void closeTab(interactiveSessionId, bucket.activeTabId).catch((err) => {
          log.warn('close tab via shortcut failed', err);
        });
        return true;
      }
    }
    void window.electronAPI.rightSidebarWindow.close().catch((err) => {
      log.warn('close window via shortcut failed', err);
    });
    return true;
  });

  return (
    <div className="flex h-screen flex-col bg-content-area text-foreground">
      {/* 46px 自绘 chrome(与主窗 ContentHeader 行高一致,红绿灯心 y=23 同轴):
          整条 drag region。mac 左端 pl-20 给红绿灯让位
          (trafficLightPosition x:12,与主窗一致);win 右端 WindowControls
          (close 按 sender 解析 = 只关本窗)。中部标题文案提示窗口归属。 */}
      <div
        className="relative flex h-[46px] shrink-0 items-center border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={isMac ? 'w-20 shrink-0' : 'w-3 shrink-0'} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PanelRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate text-13 text-[var(--text-secondary)]">
            {t('rightSidebar.window.title')}
          </span>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 pr-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 合并回主窗口:关偏好 + 关本窗,主窗恢复内嵌展开 */}
          <ChromeIconButton
            onClick={() => {
              const snapshot = getTabSnapshot(interactiveSessionId);
              const handoff = snapshot ? { snapshots: [snapshot] } : undefined;
              void window.electronAPI.rightSidebarWindow.setDetached(false, handoff).catch((err) => {
                log.warn('merge back failed', err);
              });
            }}
            title={t('rightSidebar.window.mergeBack')}
            aria-label={t('rightSidebar.window.mergeBack')}
          >
            <PanelRight size={14} />
          </ChromeIconButton>
        </div>
        {!isMac && (
          <div
            className="flex h-full shrink-0 items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls
              key={windowChromeRevision}
              onClose={() =>
                window.electronAPI.rightSidebarWindow.close().catch((err) => {
                  log.warn('close window via title bar failed', err);
                })
              }
            />
          </div>
        )}
      </div>

      {/* 内容区:Shell 零改动复用。sessionId=null(主窗不在会话视图 / 尚无上报)
          时 Shell 自渲染空白,叠一层"跟随主窗口会话"占位文案;窗口不自动关
          (避免主窗路由抖动导致窗口闪没)。 */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <RightSidebarShell
          sessionId={sessionId}
          workdir={ctx?.workdir ?? ''}
          remoteHostId={ctx?.remoteHostId ?? null}
          deviceLinkDeviceId={ctx?.deviceLinkDeviceId}
          shellVisible={windowVisible}
          isMac={isMac}
        />
        {(!windowVisible || !sessionId) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--panel-bg)]">
            <span className="text-13 text-[var(--text-tertiary)]">
              {t('rightSidebar.window.followPlaceholder')}
            </span>
          </div>
        )}
      </div>
      <GhostMediaLightboxHost
        key={interactiveSessionId ?? 'hidden'}
        sessionId={interactiveSessionId ?? undefined}
      />
    </div>
  );
}
