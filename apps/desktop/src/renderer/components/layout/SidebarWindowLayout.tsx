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
 *   - 渲染上下文(sessionId / workdir / remoteHostId)不自查 —— 主窗 MainLayout
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

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight } from 'lucide-react';

import { RightSidebarShell } from '@/features/right-sidebar/RightSidebarShell';
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';
import { onRequestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { executeSidebarCommand } from '@/features/right-sidebar/lib/executeSidebarCommand';
import {
  closeTab,
  getBucket,
} from '@/features/right-sidebar/store';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import { createLogger } from '@/lib/logger';
import {
  ensureGhostPanelsRegistered,
  useGhostPanelsSync,
} from '@/cindy-brain/ghostPanels';

const log = createLogger('SidebarWindowLayout');

interface SidebarWindowContext {
  sessionId: string | null;
  workdir: string | null;
  remoteHostId: string | null;
  available: boolean;
}

export function SidebarWindowLayout() {
  const { t } = useTranslation();
  useDeviceLinkRemoteProjects();
  // 意识面板注册:子窗口没有 LayoutRoot,必须自行初始化 ghost 面板注册表
  // 并订阅 ghosts:changed(停靠形态所需;历史持久化的 ghost 页签也靠它识别 kind)。
  ensureGhostPanelsRegistered();
  useGhostPanelsSync();
  const isMac = window.electronAPI?.platform === 'darwin';
  const [ctx, setCtx] = useState<SidebarWindowContext | null>(null);

  // mount:拉一次 context + 订阅跟随推送 + ready 握手。
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.rightSidebarWindow
      .getContext()
      .then((initial) => {
        // 订阅推送里可能先到更新 —— 已有值时不用 stale 的 getContext 结果覆盖
        if (!cancelled) setCtx((prev) => prev ?? initial);
      })
      .catch((err) => log.warn('getContext failed', err));
    const offCtx = window.electronAPI.rightSidebarWindow.onContextChanged((next) => {
      setCtx(next);
    });
    void window.electronAPI.rightSidebarWindow.ready().catch((err) => {
      log.warn('ready handshake failed', err);
    });
    return () => {
      cancelled = true;
      offCtx();
    };
  }, []);

  const sessionId = ctx?.available ? ctx.sessionId : null;

  // agent tab-op 触发的可见性请求(本窗口内 rsbBrowserBridge 派发):
  //  - 'close'(最后一个 tab 被关)且目标是当前会话 → 收起 = 关本窗口
  //  - 'open' → no-op(窗口已开);异会话请求忽略(tab 已入库,切过去自然可见)
  useEffect(() => {
    return onRequestRightSidebarVisibility((visibility, opts) => {
      const target = opts.sessionId ?? sessionId;
      if (!target || target !== sessionId) return;
      if (visibility === 'close') {
        void window.electronAPI.rightSidebarWindow.close().catch((err) => {
          log.warn('close via visibility request failed', err);
        });
      }
    });
  }, [sessionId]);

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
    if (sessionId) {
      const bucket = getBucket(sessionId);
      if (bucket.activeTabId) {
        void closeTab(sessionId, bucket.activeTabId).catch((err) => {
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
          <span className="truncate text-[13px] text-[var(--text-secondary)]">
            {t('rightSidebar.window.title')}
          </span>
        </div>
        <div
          className="flex shrink-0 items-center gap-1 pr-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 合并回主窗口:关偏好 + 关本窗,主窗恢复内嵌展开 */}
          <button
            type="button"
            onClick={() => {
              void window.electronAPI.rightSidebarWindow.setDetached(false).catch((err) => {
                log.warn('merge back failed', err);
              });
            }}
            title={t('rightSidebar.window.mergeBack')}
            aria-label={t('rightSidebar.window.mergeBack')}
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-[var(--titlebar-icon)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <PanelRight size={14} />
            <span>{t('rightSidebar.window.mergeBack')}</span>
          </button>
        </div>
        {!isMac && (
          <div
            className="flex h-full shrink-0 items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls />
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
          isMac={isMac}
        />
        {!sessionId && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-[13px] text-[var(--text-tertiary)]">
              {t('rightSidebar.window.followPlaceholder')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
