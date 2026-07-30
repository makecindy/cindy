/**
 * useBrowserWebview —— web-browser plugin 的 webview API hook。
 *
 * 给定 tabId,从模块级 BrowserWebviewPool 取 / 创建对应的 wrapper + webview 实例,
 * 返回:
 *   - `wrapper`: webview 外层 DOM 节点;caller 应在自己的 body slot 里用
 *     `useLayoutEffect` + `slot.appendChild(wrapper)` 挂上,return cleanup 时
 *     把 wrapper 挪回 pool 的停车区(`pool.acquire().wrapper.parentNode = pool.container`)。
 *   - 命令式 actions:`navigate / reload / goBack / goForward / stop`
 *   - 反应式 state:`url / title / favicon / isLoading / canGoBack / canGoForward`,
 *     变更触发 React re-render
 *
 * webview 事件监听是 hook 内部挂的(对齐 Codex desktop `main-cC-d0ezP.js:48823-48848`
 * IAB webview 在主进程监听的事件子集):
 *   - `page-title-updated` / `page-favicon-updated` —— 标题 / 图标
 *   - `did-navigate` / `did-navigate-in-page` —— URL 同步
 *   - `did-redirect-navigation` —— 不写入 state;中间态不是已提交导航
 *   - `did-start-loading` / `did-stop-loading` —— loading 状态
 *   - `did-fail-load` —— 404 / 网络错误 / SSL 错误,UI 停 loading
 *   - `dom-ready` —— attach 后 nav 状态刷新点
 *   - `audio-state-changed` —— guest 播放音频时翻 isAudible(用于 tab pill 喇叭图标)
 *   - `render-process-gone` / `unresponsive` —— guest 崩溃 / 卡死,UI 显示崩溃 banner
 *
 * 切 tab 时(useBrowserWebview 在另一个 tabId 重新调用):pool.acquire 返回不同
 * entry,本 hook 的内部 ref 自动指向新 entry,旧 entry 的 listener 在 effect
 * cleanup 时取消(不释放 entry —— 那是用户关 tab 时 plugin 显式 pool.release 的事)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewTag } from 'electron';

import { browserWebviewPool } from '../lib/browserWebviewPool';
import {
  consumePendingKillCause,
  reportRsbBrowserTab,
  subscribeTabResourceEvent,
} from '../lib/rsbBrowserBridge';

/** 2 秒内最多允许 12 次 renderer 主动导航;网页自身导航不计入。 */
export const BROWSER_NAVIGATION_FUSE_LIMIT = 12;
export const BROWSER_NAVIGATION_FUSE_WINDOW_MS = 2_000;

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

export interface UseBrowserWebviewResult {
  /** webview 外层 wrapper DOM;caller appendChild 到自己的 body slot。 */
  wrapper: HTMLDivElement | null;
  /** 当前页面 URL(`did-navigate` / `did-navigate-in-page` 同步)。 */
  url: string;
  /** 当前页面 title(`page-title-updated`)。 */
  title: string;
  /**
   * 当前页面 favicon URL。null = 当前 webview 代际尚未观测到 favicon；
   * 空串 = 已明确观测到页面没有 favicon。
   */
  favicon: string | null;
  /** 正在加载中(`did-start-loading` 翻 true,`did-stop-loading` 翻 false)。 */
  isLoading: boolean;
  /** webview 导航历史里有"上一页"。 */
  canGoBack: boolean;
  /** webview 导航历史里有"下一页"。 */
  canGoForward: boolean;
  /** 当前 guest 是否在发声(`audio-state-changed`)。tab pill 据此画喇叭图标,
   *  对齐 Codex `main-cC-d0ezP.js:48434`。 */
  isAudible: boolean;
  /** guest renderer 进程已崩溃 / 卡死(`render-process-gone` / `unresponsive`),
   *  BrowserTabBody 据此渲染 crash banner。null = 正常,非 null 是崩溃原因码。
   *  `cause === 'resource-memory'` 表示是资源看门狗因内存超限主动终止的,banner
   *  显示资源文案而不是笼统的"页面崩溃"。reload 后清回 null(did-start-loading)。 */
  crash: { reason: string; cause?: 'resource-memory' } | null;
  /** 资源看门狗 cpu-alert:前台页面持续高 CPU。BrowserTabBody 显示非阻断提示条
   *  (带「强制终止」按钮),null = 无告警。导航 / reload / 用户关闭时清除。 */
  resourceAlert: { cpuPercent: number } | null;

  /** 加载新 URL(URL bar 输入或外部跳转入口)。 */
  navigate: (url: string) => void;
  /** 重新加载当前页。 */
  reload: () => void;
  /** 上一页。 */
  goBack: () => void;
  /** 下一页。 */
  goForward: () => void;
  /** 停止当前加载(loading 时给 abort 按钮用)。 */
  stop: () => void;
  /** 关闭资源提示条(用户点「忽略」)。 */
  dismissResourceAlert: () => void;
}

/**
 * @param visible 本 tab 当前是否真的展示给用户(active && shellVisible)。
 *   用于"淘汰后重建":资源看门狗 / LRU 淘汰会销毁 pool entry。可见 tab 被
 *   release 时由通知重跑 acquire；后台 tab 切回可见时由 visible 变化自然重跑。
 *   不可见期间保持懒惰,不为看不见的 tab 重建 webview。
 */
export function useBrowserWebview(
  tabId: string,
  sessionId?: string,
  visible?: boolean,
): UseBrowserWebviewResult {
  // pool entry 引用 + 反应式 state。entry 本身在 pool 模块管;hook 只观察。
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [favicon, setFavicon] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isAudible, setIsAudible] = useState(false);
  const [crash, setCrash] = useState<{ reason: string; cause?: 'resource-memory' } | null>(
    null,
  );
  const [resourceAlert, setResourceAlert] = useState<{ cpuPercent: number } | null>(null);
  // webview ref —— actions 用,避免 stale closure。
  const webviewRef = useRef<WebviewTag | null>(null);
  const urlRef = useRef('');
  const suppressStaleUrlRef = useRef<{ targetUrl: string; staleUrl: string } | null>(null);
  const navigationAttemptsRef = useRef<number[]>([]);
  const navigationFuseTrippedRef = useRef(false);
  // crash 的渲染期镜像 —— kill-notice 晚于 render-process-gone 到达时,订阅回调
  // 需要读当前 crash 值来决定升级 / 挂起,useState 闭包会 stale,走 ref。
  const crashRef = useRef(crash);
  crashRef.current = crash;
  // Pool 生命周期通知触发 effect 重跑：可见 entry 被释放，或隐藏 hook 需要
  // 观察 Agent 后续显式创建的 entry。
  const [entryEpoch, setEntryEpoch] = useState(0);
  const visibleRef = useRef(visible === true);
  visibleRef.current = visible === true;

  useEffect(() => {
    const unsubRelease = browserWebviewPool.onRelease((releasedTabId) => {
      if (releasedTabId !== tabId) return;
      // 已释放的 wrapper 不再属于 Pool，先撤销发布，避免下一次渲染把旧代际
      // 重新接回 DOM。webviewRef 保留到新 entry 到来，用于识别代际并复位状态。
      setWrapper(null);
      // 可见中被 release(理论上只有用户关 tab —— 此时本组件即将 unmount,
      // bump 一次也无害);不可见的淘汰恢复推迟到重新可见。
      if (visibleRef.current) {
        setEntryEpoch((e) => e + 1);
      }
    });
    const unsubEntryCreated = browserWebviewPool.onEntryCreated((createdTabId) => {
      if (createdTabId !== tabId || visibleRef.current) return;
      // Agent open / ensure 可显式为隐藏 tab 创建 entry。当前 effect 之前因 entry
      // 不存在而没有监听 webview；通知后只绑定观察，不改变可见性或主动导航。
      setEntryEpoch((e) => e + 1);
    });
    return () => {
      unsubRelease();
      unsubEntryCreated();
    };
  }, [tabId]);

  const setObservedUrl = useCallback((nextUrl: string) => {
    const suppress = suppressStaleUrlRef.current;
    if (suppress) {
      if (
        isSameNavigationUrl(nextUrl, suppress.staleUrl) &&
        !isSameNavigationUrl(nextUrl, suppress.targetUrl)
      ) {
        suppressStaleUrlRef.current = null;
        return false;
      }
      suppressStaleUrlRef.current = null;
    }
    urlRef.current = nextUrl;
    setUrl(nextUrl);
    return true;
  }, []);

  useEffect(() => {
    // Shell 会常驻挂载所有 TabBody；没有明确可见时，只复用已有 entry，不首次
    // 物化 webview，避免恢复会话就在后台加载持久化 URL。
    const existing = browserWebviewPool.peek(tabId);
    if (!existing && visible !== true) return;
    // 可见意味着一次真实访问，必须走 acquire() 更新 LRU；隐藏时只 peek，避免
    // Agent 显式创建的后台 entry 因 hook 观察而被误算成用户访问。
    const entry = visible === true ? browserWebviewPool.acquire(tabId) : existing;
    if (!entry) return;
    const observingNewWebview = webviewRef.current !== entry.webview;
    if (observingNewWebview) {
      navigationAttemptsRef.current = [];
      navigationFuseTrippedRef.current = false;
    }
    if (webviewRef.current && observingNewWebview) {
      // 重新物化(淘汰后再激活):上一代 webview 的观测 state 全部失效。复位为
      // 空值,让 BrowserTabBody 的"按 wrapper 代际"首次导航重新驱动加载,否则
      // stale url 会让导航判定"已在目标页"而跳过。
      urlRef.current = '';
      suppressStaleUrlRef.current = null;
      setUrl('');
      setTitle('');
      setFavicon(null);
      setIsLoading(false);
      setCanGoBack(false);
      setCanGoForward(false);
      setIsAudible(false);
      crashRef.current = null;
      setCrash(null);
      setResourceAlert(null);
    }
    webviewRef.current = entry.webview;
    setWrapper(entry.wrapper);

    if (observingNewWebview && entry.guestFailure) {
      const cause = entry.guestFailure.kind === 'render-process-gone'
        ? consumePendingKillCause(tabId)
        : null;
      const restored = {
        reason: entry.guestFailure.reason,
        ...(cause === 'memory' ? { cause: 'resource-memory' as const } : {}),
      };
      crashRef.current = restored;
      setCrash(restored);
    }

    // canGoBack/Forward 不是 event 字段,得在每次导航后主动查 —— webview API
    // 提供 `canGoBack()` / `canGoForward()` 同步方法。
    const refreshNav = () => {
      try {
        setCanGoBack(entry.webview.canGoBack());
        setCanGoForward(entry.webview.canGoForward());
      } catch {
        // webContents 未 attach 时调用会抛,忽略。
      }
    };

    const onTitle = (e: Electron.PageTitleUpdatedEvent) => setTitle(e.title);
    const onFavicon = (e: Electron.PageFaviconUpdatedEvent) => {
      setFavicon(e.favicons.find((candidate) => candidate.trim().length > 0) ?? '');
    };
    const onDidNavigate = (e: Electron.DidNavigateEvent) => {
      const previousUrl = urlRef.current;
      const accepted = setObservedUrl(e.url);
      // 网页自身发起的跨页导航没有走 navigate(),必须在提交新 URL 时清掉旧站图标；
      // 初次 attach / 被抑制的旧 URL 回报都保持 "尚未观测" 语义,避免抹掉持久化 favicon。
      if (accepted && previousUrl && !isSameNavigationUrl(previousUrl, e.url)) {
        setFavicon('');
      }
      refreshNav();
    };
    const onDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      setObservedUrl(e.url);
      refreshNav();
    };
    const onStartLoading = () => {
      setIsLoading(true);
      // 任何主动导航 / reload 都视为崩溃后的恢复 — 清掉 crash banner。
      // navigation-loop 是主动熔断,必须等用户点 banner 的重新加载才解除。
      setCrash((prev) => (prev?.reason === 'navigation-loop' ? prev : null));
      // 换页 / reload 后旧页面的高 CPU 告警不再成立。
      setResourceAlert(null);
    };
    const onStopLoading = () => {
      setIsLoading(false);
      refreshNav();
    };
    // dom-ready:guest 页 DOM 已 attach,此时 webContents 可调用 API。我们:
    //   1. 刷新 nav state(canGoBack/Forward 拿到首次 attach 后的准值)。
    //   2. **上报 webContentsId 给 main 端 TabRegistry**(规则 1 解耦:business
    //      在 main 侧,这里只搬运)。`getWebContentsId()` 只在 attach 之后才
    //      valid —— 在 dom-ready 之前调返回无效 id。
    //      sessionId 没传(老 callsite 兼容)时跳过上报,降级到"只能用 RSB UI、
    //      不接 backend"。Phase 3 backend 上线前所有 callsite 都会补上。
    //   对齐 Codex `main-cC-d0ezP.js:48842` 监听点(他们也用 dom-ready 做 attach 后初始化)。
    const onDomReady = () => {
      refreshNav();
      if (!sessionId) return;
      try {
        const webContentsId = entry.webview.getWebContentsId();
        void reportRsbBrowserTab({ sessionId, tabId, webContentsId });
      } catch {
        // pre-attach edge case (getWebContentsId throws before attach completes);
        // a subsequent did-navigate will not re-fire dom-ready, so we lose this
        // attach window. The next pool acquire / mount will retry. Don't block
        // the hook on a webContentsId we can't get.
      }
    };
    // did-fail-load:404 / 网络错误 / SSL 错误,Electron 不会自动停 loading 态;
    // 显式翻 isLoading=false,UI 才能从"加载中"复位。errorCode -3 = ABORTED。
    // 如果 ABORTED 发生在还没收到真实导航事件时,要把 URL 从乐观 target
    // 回滚到 webview 实际 URL,否则 beforeunload 选择留在原页会把地址栏和持久化
    // 状态留在未真正加载的目标地址。
    const onFailLoad = (e: Electron.DidFailLoadEvent) => {
      if (e.errorCode === -3) {
        const suppress = suppressStaleUrlRef.current;
        if (suppress) {
          suppressStaleUrlRef.current = null;
          try {
            const currentUrl = entry.webview.getURL?.();
            if (currentUrl) setObservedUrl(currentUrl);
          } catch {
            setObservedUrl(suppress.staleUrl);
          }
        }
        setIsLoading(false);
        refreshNav();
        return;
      }
      setIsLoading(false);
      refreshNav();
    };
    // did-redirect-navigation 只代表尚未提交的中间态。不能把它写入持久化 URL:
    // BrowserTabBody 会把持久化 state 当成重启恢复目标,若 React render 落后一帧,
    // authorize ↔ callback 这类跨 origin 重定向会被旧 state 反向 loadURL,
    // 形成 ERR_ABORTED 导航反馈环。最终 URL 统一等 did-navigate。
    const onRedirect = () => undefined;
    // audio-state-changed:guest 开始 / 停止发声(`<video>` / `<audio>` 播放)。
    // event.audible 是布尔。对齐 Codex `main-cC-d0ezP.js:48434` 的 isAudible 同步。
    // Electron WebviewTag typing 没声明此 DOM event 的具名 interface(只 webContents 端
    // 有 `WebContentsAudioStateChangedEventParams`),所以用 unknown + 字段读出。
    const onAudioState = (e: Event) => {
      const audible = (e as unknown as { audible?: boolean }).audible;
      setIsAudible(audible === true);
    };
    // render-process-gone:guest renderer 进程崩 / 杀掉。details.reason 给原因码
    // (crashed / killed / oom / launch-failed 等)。UI 据此显示 crash banner。
    // 资源看门狗强杀前会先发 kill-notice(cause 记在 bridge 模块),这里取走
    // 并挂到 crash state 上,banner 显示"内存过高被终止"。
    const onRenderProcessGone = (e: Electron.RenderProcessGoneEvent) => {
      setIsLoading(false);
      setIsAudible(false);
      setResourceAlert(null);
      const cause = consumePendingKillCause(tabId);
      const next = {
        reason: e.details.reason,
        ...(cause === 'memory' ? { cause: 'resource-memory' as const } : {}),
      };
      // 同步写 ref:kill-notice 可能与本事件同一批到达(React 还没 commit),
      // 订阅回调靠 crashRef 判断"crash 是否已发生",不能等渲染期镜像。
      crashRef.current = next;
      setCrash(next);
    };
    // unresponsive:guest renderer 卡死(主线程长时间不响应)。当成软崩处理 ——
    // 也显示 crash banner,但 reason='unresponsive'(UI 可分支显示"卡死"vs"崩溃")。
    // 反向 responsive 事件 → 自动恢复(清 crash)。
    // 这两个 webview tag 事件 Electron typings 没声明,用通用 Event。
    const onUnresponsive = () => setCrash({ reason: 'unresponsive' });
    const onResponsive = () => {
      setCrash((prev) => (prev?.reason === 'unresponsive' ? null : prev));
    };

    entry.webview.addEventListener('page-title-updated', onTitle);
    entry.webview.addEventListener('page-favicon-updated', onFavicon);
    entry.webview.addEventListener('did-navigate', onDidNavigate);
    entry.webview.addEventListener('did-navigate-in-page', onDidNavigateInPage);
    entry.webview.addEventListener('did-redirect-navigation', onRedirect);
    entry.webview.addEventListener('did-start-loading', onStartLoading);
    entry.webview.addEventListener('did-stop-loading', onStopLoading);
    entry.webview.addEventListener('dom-ready', onDomReady);
    entry.webview.addEventListener('did-fail-load', onFailLoad);
    entry.webview.addEventListener('audio-state-changed', onAudioState);
    entry.webview.addEventListener('render-process-gone', onRenderProcessGone);
    entry.webview.addEventListener('unresponsive', onUnresponsive);
    entry.webview.addEventListener('responsive', onResponsive);

    // 资源看门狗事件(bridge 转发):cpu-alert → 提示条;kill-notice → 若 crash
    // 事件先到、notice 后到,把已有 crash state 升级成资源原因(反序兜底)。
    // 升级路径必须同时消费掉 pending cause —— 否则残留的 'memory' 会错标该 tab
    // 下一次无关崩溃(review P1)。notice 先到的正序路径 pending 保留,由随后的
    // render-process-gone handler 消费。
    const unsubResourceEvent = subscribeTabResourceEvent(tabId, (event) => {
      if (event.kind === 'cpu-alert') {
        setResourceAlert({ cpuPercent: event.cpuPercent });
      } else if (event.kind === 'kill-notice' && crashRef.current) {
        consumePendingKillCause(tabId);
        const upgraded = { ...crashRef.current, cause: 'resource-memory' as const };
        crashRef.current = upgraded;
        setCrash(upgraded);
      }
    });

    // 初次挂上来 —— 如果 webview 已经载过(切回旧 tab),把当前 URL 同步进 state。
    try {
      const currentUrl = entry.webview.getURL?.();
      if (currentUrl) setObservedUrl(currentUrl);
    } catch {
      // 还没 attach,getURL 抛,忽略。
    }
    refreshNav();

    return () => {
      entry.webview.removeEventListener('page-title-updated', onTitle);
      entry.webview.removeEventListener('page-favicon-updated', onFavicon);
      entry.webview.removeEventListener('did-navigate', onDidNavigate);
      entry.webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage);
      entry.webview.removeEventListener('did-redirect-navigation', onRedirect);
      entry.webview.removeEventListener('did-start-loading', onStartLoading);
      entry.webview.removeEventListener('did-stop-loading', onStopLoading);
      entry.webview.removeEventListener('dom-ready', onDomReady);
      entry.webview.removeEventListener('did-fail-load', onFailLoad);
      entry.webview.removeEventListener('audio-state-changed', onAudioState);
      entry.webview.removeEventListener('render-process-gone', onRenderProcessGone);
      entry.webview.removeEventListener('unresponsive', onUnresponsive);
      entry.webview.removeEventListener('responsive', onResponsive);
      unsubResourceEvent();
      // **不**释放 pool entry —— webview DOM 节点继续保活,切回该 tab 时可直接
      // 复用。释放是 plugin 在用户主动关闭 tab 时显式调 pool.release(tabId)。
    };
  }, [tabId, sessionId, setObservedUrl, entryEpoch, visible]);

  const navigate = useCallback((nextUrl: string) => {
    const wv = webviewRef.current;
    if (navigationFuseTrippedRef.current) return;
    const now = Date.now();
    const attempts = navigationAttemptsRef.current.filter(
      (at) => now - at < BROWSER_NAVIGATION_FUSE_WINDOW_MS,
    );
    if (attempts.length >= BROWSER_NAVIGATION_FUSE_LIMIT) {
      // 熔断立即拒绝本次 navigate,不再把被拒绝调用计入 attempts。
      navigationAttemptsRef.current = [];
      navigationFuseTrippedRef.current = true;
      suppressStaleUrlRef.current = null;
      try {
        wv?.stop();
      } catch {
        // guest 可能正处于 detach / crash,熔断本身仍然成立。
      }
      setIsLoading(false);
      setCrash({ reason: 'navigation-loop' });
      return;
    }
    attempts.push(now);
    navigationAttemptsRef.current = attempts;
    let staleUrl = urlRef.current || 'about:blank';
    try {
      staleUrl = wv?.getURL?.() || staleUrl;
    } catch {
      // getURL can throw before attach; fall back to the last observed URL.
    }
    if (!isSameNavigationUrl(staleUrl, nextUrl)) {
      suppressStaleUrlRef.current = { targetUrl: nextUrl, staleUrl };
    }
    urlRef.current = nextUrl;
    setUrl(nextUrl);
    // 主动导航后旧页 favicon 已不再可信，但这里用 null 表示 "等待新页观测"；
    // BrowserTabBody 会保留持久化 fallback，显式用户导航则由调用方同步清空。
    setFavicon(null);
    setIsLoading(true);
    if (!wv) return;
    try {
      wv.loadURL(nextUrl);
    } catch {
      // loadURL 在 webContents 未 attach 时抛;Electron webview 的 attach 在
      // wrapper 进入 visible DOM 后才完成 —— 这种情况下退回 setAttribute('src')
      // 让 webview 自己 attach 后加载。
      wv.setAttribute('src', nextUrl);
    }
  }, []);
  const reload = useCallback(() => {
    navigationAttemptsRef.current = [];
    navigationFuseTrippedRef.current = false;
    setCrash(null);
    setResourceAlert(null);
    const wv = webviewRef.current;
    if (!wv) return;
    // 不等 did-start-loading 才反馈；Electron 事件有异步间隙，用户点击后应立即看到
    // BrowserChrome 的 loading 动画。调用失败时回滚，避免 UI 永久卡住。
    setIsLoading(true);
    try {
      wv.reload();
    } catch {
      setIsLoading(false);
    }
  }, []);
  const goBack = useCallback(() => webviewRef.current?.goBack(), []);
  const goForward = useCallback(() => webviewRef.current?.goForward(), []);
  const stop = useCallback(() => {
    try {
      webviewRef.current?.stop();
    } catch {
      // detach / crash 窗口内 stop 可能抛；UI 仍应退出 loading，等待后续事件恢复。
    } finally {
      // stop 也是用户发起的即时动作；不必再等 did-stop-loading 才恢复刷新按钮。
      setIsLoading(false);
    }
  }, []);
  const dismissResourceAlert = useCallback(() => setResourceAlert(null), []);

  return {
    // 隐藏时仍观察已有 entry 的 guest 生命周期，但不把 wrapper 交给 caller，
    // 避免隐藏 Body 把它移出停车区并触发首次导航。
    wrapper: visible === true ? wrapper : null,
    url,
    title,
    favicon,
    isLoading,
    canGoBack,
    canGoForward,
    isAudible,
    crash,
    resourceAlert,
    navigate,
    reload,
    goBack,
    goForward,
    stop,
    dismissResourceAlert,
  };
}
