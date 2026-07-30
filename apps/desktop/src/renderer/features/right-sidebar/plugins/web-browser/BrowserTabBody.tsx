/**
 * BrowserTabBody —— web-browser tab 的 TabBody。
 *
 * 布局:
 *   ┌────────────────────────────────────────────┐
 *   │ BrowserChrome (40px)                       │
 *   ├────────────────────────────────────────────┤
 *   │                                            │
 *   │           webview slot (flex-1)            │
 *   │                                            │
 *   └────────────────────────────────────────────┘
 *
 * webview slot 是一个 `<div ref>` —— useBrowserWebview 给我们 wrapper(模块级
 * pool 持有的同一个 DOM 节点),useLayoutEffect 里用 vanilla `appendChild` 把
 * wrapper 搬过来。TabBody 卸载时 cleanup 把 wrapper 挪回 pool container(
 * off-screen),保证 webContents 不被销毁。
 *
 * webview 事件 → 同步 plugin state:
 *   - did-navigate / did-navigate-in-page → state.url
 *   - page-title-updated → state.title
 *   - page-favicon-updated → state.favicon
 * 同步走 ctx.patchState,由 RightSidebarShell store debounce 持久化到 IPC + DB,
 * 重启后 tab pill 标题 / favicon / URL 都能恢复。
 *
 * 首次 mount(用户刚创建 tab / 重启后第一次激活)→ 用 state.url 主动 navigate,
 * 让 webview 进到正确页面。已经在加载 state.url 的话(state 和 webview 同步)
 * 跳过避免双重 load。
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AlertTriangle, Gauge, RotateCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAppShortcut } from '@/hooks/useAppShortcut';
import { createLogger } from '@/lib/logger';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { browserWebviewPool } from '../../lib/browserWebviewPool';
import {
  forceKillBrowserTab,
  setForegroundBrowserTab,
} from '../../lib/rsbBrowserBridge';
import { closeTab } from '../../store';
import { useBrowserWebview } from '../../hooks/useBrowserWebview';
import type { TabKindHostContext } from '../../types';

import { BrowserChrome, type BrowserChromeHandle } from './BrowserChrome';
import { BrowserCommentPopover } from './BrowserCommentPopover';
import { useBrowserComment } from './useBrowserComment';
import type { WebBrowserState } from './index';

const log = createLogger('rightSidebar.browserTabBody');

interface BrowserTabBodyProps {
  state: WebBrowserState;
  ctx: TabKindHostContext;
  /** 顶层 active tab 才响应来自 main 的 webview-内 Cmd+L 信号 + 后续 mute /
   *  暂停媒体等行为。Shell 注入。 */
  active?: boolean;
  /** 整个右侧栏是否展开可见。Shell 注入;真实可见性 = active && shellVisible ——
   *  侧栏收起时 active tab 依旧 mount 且 active=true,资源看门狗的前台判定
   *  必须用组合值,否则收起的 tab 永远享受前台豁免(review P1)。 */
  shellVisible?: boolean;
}

function normalizeNavigationUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function isSameNavigationUrl(a: string, b: string): boolean {
  return normalizeNavigationUrl(a) === normalizeNavigationUrl(b);
}

export function BrowserTabBody({ state, ctx, active, shellVisible }: BrowserTabBodyProps) {
  const { t } = useTranslation();
  // tabId 从 ctx 拿(Shell 注入,每个 tab 实例稳定),用作 BrowserWebviewPool 的
  // entry key — pool 据此把同一个 webview DOM 节点跟 tab 绑定一辈子。
  // sessionId 跟 tabId 一起喂给 hook,用于 dom-ready 后给 main 端 TabRegistry
  // 上报 (sessionId, tabId, webContentsId) 三元组(Phase 2 browser bridge)。
  const { tabId, sessionId } = ctx;
  // 真实可见性:顶层 active tab 且整个侧栏展开。shellVisible 缺省(旧宿主 /
  // 测试)按可见处理,与 active 的既有缺省语义一致。
  const tabVisible = active === true && shellVisible !== false;
  // BrowserChrome 的 imperative ref —— Cmd/Ctrl+L 快捷键调它的 focusUrlBar()。
  const chromeRef = useRef<BrowserChromeHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const browser = useBrowserWebview(tabId, sessionId, tabVisible);
  const lastNavigatedWrapperRef = useRef<HTMLDivElement | null>(null);
  const stateUrlRef = useRef(state.url);
  const browserUrlRef = useRef(browser.url);
  const suppressStaleUrlRef = useRef<{ targetUrl: string; staleUrl: string } | null>(null);
  const navigateRef = useRef(browser.navigate);
  stateUrlRef.current = state.url;
  browserUrlRef.current = browser.url;
  navigateRef.current = browser.navigate;

  // 把 pool 的 wrapper 挂进 slot —— useLayoutEffect(在 paint 前移 DOM,避免闪)。
  // 卸载时把 wrapper 挪回 pool 的 off-screen container 保活 webContents。
  // 切到不同 tabId 时:wrapper 引用变,effect 重跑,旧 wrapper 自动回 parking 区。
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const wrapper = browser.wrapper;
    if (!tabVisible || !slot || !wrapper) return;
    slot.appendChild(wrapper);
    return () => {
      // release / LRU 淘汰后的旧 wrapper 已不再属于 Pool，不能因 React effect
      // cleanup 被重新接回 DOM；只有当前代际仍归 Pool 持有时才停回停车区。
      if (browserWebviewPool.peek(tabId)?.wrapper !== wrapper) {
        wrapper.remove();
        return;
      }
      const parking = document.getElementById('browser-webview-pool');
      if (parking) {
        parking.appendChild(wrapper);
      } else {
        wrapper.remove();
      }
    };
  }, [browser.wrapper, tabId, tabVisible]);

  // hook 事件 → patchState。注意 onPatchState 引用稳定,这里只在 url / title /
  // favicon 真实改变(由 webview 推上来)时才写回,不会无限循环。
  useEffect(() => {
    // 只有当 hook state 与 plugin state 不一致时才 patch(初次 mount 时 hook 先
    // 是空串,主动 navigate state.url 后才推回来,中间不要把 plugin.url 写空)。
    if (!browser.url) return;
    const suppress = suppressStaleUrlRef.current;
    if (suppress) {
      if (
        isSameNavigationUrl(browser.url, suppress.staleUrl) &&
        !isSameNavigationUrl(browser.url, suppress.targetUrl) &&
        isSameNavigationUrl(state.url || 'about:blank', suppress.targetUrl)
      ) {
        // 刚发起导航后,webview 可能还会回报一次旧地址。只忽略这一个 stale URL,
        // 不阻止真实目标 URL / 重定向 URL / 页面内导航回写。
        suppressStaleUrlRef.current = null;
        return;
      }
      suppressStaleUrlRef.current = null;
    }
    if (browser.url === state.url) return;
    ctx.patchState({ url: browser.url });
  }, [browser.url, ctx, state.url]);

  useEffect(() => {
    if (browser.title === state.title) return;
    // 空 title 时不写回,让 UI 走 "新标签" 占位文案。
    if (!browser.title) return;
    ctx.patchState({ title: browser.title });
  }, [browser.title, ctx, state.title]);

  useEffect(() => {
    // null 表示当前 webview 代际尚未观测到 favicon，不能据此清掉持久化图标；
    // 空串才是 page-favicon-updated 明确报告 "无图标"。
    if (browser.favicon === null) return;
    const nextFavicon = browser.favicon || null;
    if (nextFavicon === state.favicon) return;
    ctx.patchState({ favicon: nextFavicon });
  }, [browser.favicon, ctx, state.favicon]);

  // isAudible 同步:webview audio-state-changed → patchState({isAudible}),
  // TabPillIcon 跟着叠喇叭图标(对齐 Chrome / Codex tab pill 行为)。
  useEffect(() => {
    if (browser.isAudible === state.isAudible) return;
    ctx.patchState({ isAudible: browser.isAudible });
  }, [browser.isAudible, ctx, state.isAudible]);

  // 持久化 URL 只用于 tab 首次物化 / 重启恢复。后续 state.url 是 webview 导航
  // 的观测结果,绝不能再反向驱动 loadURL:跨 origin 重定向时 React state 可能
  // 落后一帧,双向 reconcile 会把 authorize / callback 互相覆盖成死循环。
  // 用户地址栏与 agent 导航都有各自明确的命令入口,不依赖 state 反向触发。
  //
  // 按 wrapper **代际**(而不是 tabId)判定"首次":资源看门狗 / LRU 淘汰销毁
  // entry 后,重新可见时 hook 会 acquire 出一个全新 wrapper —— 新代际的 webview
  // 是空的,必须重新用持久化 URL 驱动一次加载(review P1:淘汰后空壳)。
  useEffect(() => {
    const wrapper = browser.wrapper;
    if (!tabVisible || !wrapper || lastNavigatedWrapperRef.current === wrapper) return;
    lastNavigatedWrapperRef.current = wrapper;
    const nextUrl = stateUrlRef.current || 'about:blank';
    const currentUrl = browserUrlRef.current;
    if (currentUrl && isSameNavigationUrl(currentUrl, nextUrl)) return;
    // about:blank 默认状态下也要 navigate,确保 webview 真的处于 about:blank,
    // 不会停留在 pool 创建时未 setAttribute('src') 的"未初始化"状态。
    navigateRef.current(nextUrl);
  }, [tabId, browser.wrapper, tabVisible]);

  const reloadRef = useRef(browser.reload);
  const goBackRef = useRef(browser.goBack);
  const goForwardRef = useRef(browser.goForward);
  const canGoBackRef = useRef(browser.canGoBack);
  const canGoForwardRef = useRef(browser.canGoForward);
  reloadRef.current = browser.reload;
  goBackRef.current = browser.goBack;
  goForwardRef.current = browser.goForward;
  canGoBackRef.current = browser.canGoBack;
  canGoForwardRef.current = browser.canGoForward;

  const handleNavigate = useCallback(
    (nextUrl: string) => {
      if (browser.url && !isSameNavigationUrl(browser.url, nextUrl)) {
        suppressStaleUrlRef.current = {
          targetUrl: nextUrl,
          staleUrl: browser.url,
        };
      }
      navigateRef.current(nextUrl);
      ctx.patchState({
        url: nextUrl,
        title: '',
        favicon: null,
        isAudible: false,
      });
    },
    [browser.url, ctx],
  );

  // 浏览器级快捷键 (focus URL bar / 前进后退 / 刷新) —— 组合键定义在
  // shared/appShortcuts registry (browser-* 系列, 用户可改绑), 与 main 端
  // webview-security 的 guest 拦截共用同一份 registry, 改绑后两端行为一致。
  //
  // 两条触发路径:
  //   1) host renderer 内按键 → 本组件的 useAppShortcut 监听拦下(URL bar 没
  //      焦点 / 用户在 chrome / RSB 别处时)
  //   2) webview guest 内按键 → host 拿不到 keydown(webview 是独立 webContents),
  //      main 端 webview-security 的 before-input-event 拦截后推 IPC,这里订阅。
  //      只有 active tab 响应 —— 多个 web-browser tab 都 mount 着监听同一个
  //      channel,不过滤会让所有 tab 都进编辑态。
  //
  // 注:host 路径下输入框 / contenteditable 让路(其它编辑器的 ctrl+L 不该被抢),
  // 且仅 rootRef 域内的按键响应 —— guard 留在调用点。
  const browserShortcutGuard = (e: KeyboardEvent): boolean => {
    const target = e.target as HTMLElement | null;
    if (target && !rootRef.current?.contains(target)) return false;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.closest?.('[contenteditable="true"]')
    ) {
      return false;
    }
    return true;
  };
  useAppShortcut(
    'browser-focus-url',
    (e) => {
      if (!browserShortcutGuard(e)) return false;
      chromeRef.current?.focusUrlBar();
      return true;
    },
    { enabled: active },
  );
  useAppShortcut(
    'browser-back',
    (e) => {
      if (!browserShortcutGuard(e) || !canGoBackRef.current) return false;
      goBackRef.current();
      return true;
    },
    { enabled: active },
  );
  useAppShortcut(
    'browser-forward',
    (e) => {
      if (!browserShortcutGuard(e) || !canGoForwardRef.current) return false;
      goForwardRef.current();
      return true;
    },
    { enabled: active },
  );
  useAppShortcut(
    'browser-reload',
    (e) => {
      if (!browserShortcutGuard(e)) return false;
      reloadRef.current();
      return true;
    },
    { enabled: active },
  );

  // 前台上报:资源看门狗据此区分前台 / 后台 guest(前台只在内存超硬阈值时才
  // 强杀,后台可激进淘汰)。用 tabVisible(active && shellVisible)而不是裸
  // active:侧栏收起时 active tab 依旧 mount,不算前台。可见性翻转 / tab 切换 /
  // 组件卸载都要同步。
  useEffect(() => {
    setForegroundBrowserTab(tabId, tabVisible);
    return () => {
      setForegroundBrowserTab(tabId, false);
    };
  }, [tabVisible, tabId]);

  // webview guest 内 Cmd/Ctrl+L:main 推送过来,只有 active tab 响应。
  useEffect(() => {
    if (!active) return;
    const off = window.electronAPI.onRsbBrowserFocusUrlBar(() => {
      chromeRef.current?.focusUrlBar();
    });
    return off;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const off = window.electronAPI.onRsbBrowserCommand(({ command }) => {
      if (command === 'go-back') {
        if (canGoBackRef.current) goBackRef.current();
      } else if (command === 'go-forward') {
        if (canGoForwardRef.current) goForwardRef.current();
      } else if (command === 'close-tab') {
        // guest 内 ⌘W / Ctrl+W:关掉本 tab,与焦点在 host 侧右侧栏内按 ⌘W 的
        // 行为对齐(store.closeTab 同路径,BrowserTabBody unmount 时 effect
        // cleanup 释放 pool entry)。
        void closeTab(sessionId, tabId).catch((err) => {
          log.warn('close tab via guest shortcut failed', err);
        });
      } else if (command === 'reload') {
        reloadRef.current();
      }
    });
    return off;
  }, [active, sessionId, tabId]);

  // tab 关闭 / 整个 plugin 卸载时,显式释放 pool entry。
  // 注意:tabId 切换不应释放(切只是 hook 重新 acquire 别的 entry,旧 entry 保活)。
  // 这里只在 BrowserTabBody 真正 unmount(tab 被关闭)时 cleanup —— 用 effect
  // 空 deps,React 会在组件 unmount 时跑 cleanup。但如果 tabId 是 prop,React
  // 不知道"换 tabId == 换 tab",得手动同步当前 tabId 给 cleanup 闭包。
  const releaseTabIdRef = useRef(tabId);
  releaseTabIdRef.current = tabId;
  useEffect(() => {
    return () => {
      browserWebviewPool.release(releaseTabIdRef.current);
    };
  }, []);

  // 截图:main 端对当前 tab 的 webview capturePage → 系统剪贴板。
  // 反馈只用 toast(成功 / 失败各一条),不做视觉动画。
  const handleCaptureScreenshot = useCallback(async () => {
    try {
      await window.electronAPI.rsbBrowserBridge.captureScreenshot({ tabId });
      toast.success(t('rightSidebar.browser.screenshotCopied'));
    } catch {
      toast.error(t('rightSidebar.browser.screenshotFailed'));
    }
  }, [tabId, t]);

  // 页面评论(browser comment):状态机 + guest 通信 + 提交流程全在 hook 里,
  // TabBody 只负责按钮接线与气泡渲染(锚点 = guest viewport 坐标 = slot 内坐标)。
  // pageUrl 走 getter(immediate「立即添加」由 hook 自触发提交,经 ref 取最新值)。
  const pageUrlRef = useRef(browser.url || state.url || 'about:blank');
  pageUrlRef.current = browser.url || state.url || 'about:blank';
  const getPageUrl = useCallback(() => pageUrlRef.current, []);
  const comment = useBrowserComment(tabId, sessionId, browser.webview, getPageUrl);
  // 页面评论的落点是主窗 composer 的「N 条注释」胶囊。detached 独立子窗口
  // (SidebarWindowLayout)只挂 RightSidebarShell、不挂 ChatInput,评论写进
  // 子窗口自己的 composerDraftStore 无处可发(还会误报成功 toast),故子窗口里
  // 不提供评论入口。内嵌侧栏(主窗)与副窗口(MainLayout,自带 composer)不受影响。
  const commentSupported = !isSidebarWindow() && Boolean(sessionId) && Boolean(browser.webview);

  // 崩溃恢复 —— banner 上的 "重新加载" 按钮:对 unresponsive 走 reload(让 guest
  // 主线程被打断重启),对 crashed/killed/oom 走 navigate(等价于 reload,但能
  // 容忍 webContents 已经死掉的情况)。两种都会触发 did-start-loading → 清 crash。
  const handleRecover = useCallback(() => {
    if (
      browser.crash?.reason === 'unresponsive' ||
      browser.crash?.reason === 'navigation-loop'
    ) {
      browser.reload();
    } else {
      browser.navigate(state.url || 'about:blank');
    }
  }, [browser, state.url]);

  // 「更多」菜单动作对象 = 地址栏当前显示的链接(state.url)—— 与 BrowserChrome 的
  // 地址显示、hasValidLink 禁用判据同源,三者永远一致。不用 pageUrlRef(live-first,
  // 服务页面评论):显式导航后 browser.url 在 did-navigate 前仍是旧页,live-first 会
  // 让「复制链接」拿到旧地址;而 in-page 导航的 state.url 同步间隙仅一个 effect 周期,
  // 人手点菜单时早已同步完,取 state.url 无感知差异。
  const menuUrlRef = useRef(state.url || 'about:blank');
  menuUrlRef.current = state.url || 'about:blank';

  // 「更多」菜单 —— 用系统默认浏览器打开当前页。
  // 菜单项在无有效链接时已 disabled,这里再兜一层空 / about:blank 保护。
  // openExternal 在被控端(远程控制场景)本机打开,语义正确(见规则 26)。
  const handleOpenInSystemBrowser = useCallback(() => {
    const url = menuUrlRef.current;
    if (!url || url === 'about:blank') return;
    void window.electronAPI
      .openExternal(url)
      .then((res) => {
        if (!res?.success) {
          toast.error(t('chat.markdownRenderer.openInBrowserFailed'));
        }
      })
      .catch(() => {
        toast.error(t('chat.markdownRenderer.openInBrowserFailed'));
      });
  }, [t]);

  // 「更多」菜单 —— 复制当前页链接到剪贴板(renderer clipboard,项目惯例)。
  const handleCopyLink = useCallback(async () => {
    const url = menuUrlRef.current;
    if (!url || url === 'about:blank') return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('rightSidebar.browser.linkCopied'));
    } catch {
      toast.error(t('rightSidebar.browser.copyLinkFailed'));
    }
  }, [t]);

  return (
    <div ref={rootRef} className="flex h-full w-full flex-col bg-content-area">
      <BrowserChrome
        ref={chromeRef}
        url={state.url || 'about:blank'}
        isLoading={browser.isLoading}
        canGoBack={browser.canGoBack}
        canGoForward={browser.canGoForward}
        onNavigate={handleNavigate}
        onReload={browser.reload}
        onStop={browser.stop}
        onGoBack={browser.goBack}
        onGoForward={browser.goForward}
        onCaptureScreenshot={handleCaptureScreenshot}
        commentActive={comment.mode !== 'off'}
        onToggleComment={comment.toggle}
        commentSupported={commentSupported}
        onOpenInSystemBrowser={handleOpenInSystemBrowser}
        onCopyLink={handleCopyLink}
      />
      {/* webview slot:flex-1 占满剩余空间。pool 的 wrapper 用 100% width/height
          填满,所以这里不需要再设尺寸。
          注:slot 自身 overflow-hidden 防 webview 内容溢出抖动 chrome。
          crash 时 slot 上叠一个绝对定位 banner 覆盖 webview 区(webview 自己已经
          一片灰白,banner 给用户"出了什么 + 怎么恢复"反馈)。 */}
      <div
        ref={slotRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-browser-tab-slot={tabId}
      >
        {browser.crash && (
          <BrowserCrashBanner
            reason={browser.crash.reason}
            cause={browser.crash.cause}
            onRecover={handleRecover}
            onForceKill={
              browser.crash.reason === 'unresponsive'
                ? () => void forceKillBrowserTab(tabId)
                : undefined
            }
          />
        )}
        {/* 资源看门狗 cpu-alert 提示条:非阻断,固定在 slot 顶部居中。用户可
            「强制终止」失控页面,或「忽略」继续(可能是正经的重页面)。 */}
        {!browser.crash && browser.resourceAlert && (
          <div
            className={cn(
              'absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-2',
              'rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]',
              'py-1 pl-3 pr-1 text-[11px] text-[var(--text-secondary)] shadow-sm',
            )}
          >
            <Gauge size={12} strokeWidth={2} className="shrink-0 text-[var(--warning-fg)]" />
            <span>{t('rightSidebar.browser.resourceAlert.cpuHint')}</span>
            <button
              type="button"
              onClick={() => {
                browser.dismissResourceAlert();
                void forceKillBrowserTab(tabId);
              }}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--error-fg)] hover:bg-[var(--surface-hover)]"
            >
              {t('rightSidebar.browser.resourceAlert.terminate')}
            </button>
            <button
              type="button"
              aria-label={t('rightSidebar.browser.resourceAlert.dismiss')}
              onClick={browser.dismissResourceAlert}
              className="flex size-5 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {/* 评论模式提示条:点选中显示操作说明,固定在 slot 顶部居中,不挡 chrome。 */}
        {comment.mode === 'selecting' && (
          <div
            className={cn(
              'pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2',
              'rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]',
              'px-3 py-1 text-[11px] text-[var(--text-secondary)]',
            )}
          >
            {t('rightSidebar.browser.commentModeHint')}
          </div>
        )}
        {/* 评论输入气泡:锚在 guest 上报的点选坐标。 */}
        {(comment.mode === 'pending' ||
          comment.mode === 'cancelling' ||
          comment.mode === 'submitting') &&
          comment.pendingTarget && (
            <BrowserCommentPopover
              anchor={comment.pendingTarget.point}
              submitting={comment.mode !== 'pending'}
              designBaseline={comment.pendingTarget.designBaseline}
              editorDraft={comment.editorDraft}
              onEditorDraftChange={comment.updateEditorDraft}
              onSubmit={comment.submit}
              onCancel={comment.cancelPending}
              onPreviewDesign={comment.previewDesign}
              onResetDesign={comment.resetDesign}
            />
          )}
      </div>
    </div>
  );
}

/**
 * 崩溃 banner —— absolute 覆盖整个 webview slot,半透明黑底 + 中心一个卡片。
 * Codex 也对崩溃做 UI 反馈(`render-process-gone` 事件链),Chrome 在 tab 内显示
 * "Aw, Snap!" 页。我们做精简版:图标 + 原因 + 重载按钮。
 *
 * `cause === 'resource-memory'`:资源看门狗因内存超限主动终止(不是页面自己崩),
 * 换专属文案让用户明白"是保护机制在工作"。`onForceKill` 只在 unresponsive 时传:
 * 卡死的 guest 进程还在烧 CPU,「强制终止」给用户一个立即止损的出口(终止后
 * 走 render-process-gone → 本 banner 切到 crashed 文案 → 重新加载恢复)。
 */
function BrowserCrashBanner({
  reason,
  cause,
  onRecover,
  onForceKill,
}: {
  reason: string;
  cause?: 'resource-memory';
  onRecover: () => void;
  onForceKill?: () => void;
}) {
  const { t } = useTranslation();
  // 区分资源终止、导航熔断、unresponsive 与进程崩溃。沿用同一个克制的恢复
  // banner,不新增布局或视觉分支。
  const titleKey =
    cause === 'resource-memory'
      ? 'rightSidebar.browser.crash.resourceKilledTitle'
      : reason === 'navigation-loop'
      ? 'rightSidebar.browser.crash.navigationLoopTitle'
      : reason === 'unresponsive'
      ? 'rightSidebar.browser.crash.unresponsiveTitle'
      : 'rightSidebar.browser.crash.crashedTitle';
  const descKey =
    cause === 'resource-memory'
      ? 'rightSidebar.browser.crash.resourceKilledDesc'
      : reason === 'navigation-loop'
      ? 'rightSidebar.browser.crash.navigationLoopDesc'
      : reason === 'unresponsive'
      ? 'rightSidebar.browser.crash.unresponsiveDesc'
      : 'rightSidebar.browser.crash.crashedDesc';
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[var(--overlay-modal)] backdrop-blur-sm">
      <div className="flex max-w-xs flex-col items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-6 py-5 text-center">
        <AlertTriangle size={28} strokeWidth={1.5} className="text-[var(--error-fg)]" />
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{t(titleKey)}</div>
        <div className="text-[12px] text-[var(--text-secondary)]">{t(descKey)}</div>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={onRecover}
            className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent-cta-bg)] px-3 text-[12px] font-medium text-[var(--accent-pure-cta-fg)] hover:bg-[var(--accent-hover)]"
          >
            <RotateCw size={12} strokeWidth={2.5} />
            {t('rightSidebar.browser.crash.reload')}
          </button>
          {onForceKill && (
            <button
              type="button"
              onClick={onForceKill}
              className="flex h-7 items-center rounded-md border border-[var(--border-default)] px-3 text-[12px] font-medium text-[var(--error-fg)] hover:bg-[var(--surface-hover)]"
            >
              {t('rightSidebar.browser.crash.forceKill')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
