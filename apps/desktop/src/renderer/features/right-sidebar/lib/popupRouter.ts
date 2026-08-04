/**
 * popupRouter —— main 端 webview popup 推送的**窗口级常驻**订阅与路由。
 *
 * 为什么常驻而不是挂在 RightSidebarShell 上:popup 的产生方是 guest 页面
 * (window.open / target=_blank / 跨 host location 写入),它不关心用户此刻在
 * 哪个 route。订阅若随 Shell 生命周期,两类窗口必丢事件(preload 扇出不缓存,
 * "没人订阅"=丢):
 *   - 用户离开聊天视图(设置页等)期间,后台 agent 的 eager-spawn webview 触发
 *     popup —— OAuth 授权 URL 被丢弃,登录流程原地卡死;
 *   - main 端归属等待(事件驱动 report 等待 / deferred URL 捕获)期间用户切走,
 *     等待结束后消息到达时 Shell 已卸载。
 *
 * 本模块与 rsbBrowserBridge 同款生命周期:首个 Shell mount 时 init,之后 Shell
 * 卸载**不解绑**;进程内常驻。Shell 只负责把"用户正在看的 session"喂给
 * `setPopupFallbackSession`(payload 无 opener 归属时的回落目标,保留最后已知值
 * ——Shell 卸载期间到达的无归属 popup 落进用户最后看过的 session,优于直接丢弃)。
 *
 * 路由逻辑本体(水合 → 乐观插入同 tick 登记 popup 标记 → 离屏物化 → 可见性
 * 请求)与原 Shell 内实现逐字一致,注释随迁。
 */

import { createLogger } from '@/lib/logger';

import { addTab, closeTab, ensureHydrated, getBucket } from '../store';
import { eagerSpawnAndReport } from './rsbBrowserBridge';
import { markPopupSpawnedTab } from './popupTabs';
import { findNativePopupTabBySurface, registerNativePopupTab } from './nativePopupTabs';
import { requestRightSidebarVisibility } from './sidebarCommands';

const log = createLogger('rightSidebar.popupRouter');

let initialized = false;
let teardown: (() => void) | null = null;

/** payload 无 opener 归属时的回落 session:用户最后看过的 RSB session。 */
let fallbackSessionId: string | null = null;

/**
 * Shell 在 sessionId 变化时喂进来。传 null(切到无 session 路由)**不清空**——
 * 保留最后已知值,让 Shell 卸载期间的无归属 popup 仍有处可去。
 */
export function setPopupFallbackSession(sessionId: string | null): void {
  if (sessionId) fallbackSessionId = sessionId;
}

/**
 * 绑定 popup 订阅。幂等:重复调用 no-op。与 initRsbBrowserBridge 并列由 Shell
 * mount 时调用;teardown 仅供测试。
 */
export function initPopupRouter(): () => void {
  if (initialized) {
    return teardown ?? (() => undefined);
  }
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.onRsbBrowserPopup) {
    // SSR / 测试 / preload 未就绪 —— 静默 no-op。
    initialized = true;
    teardown = () => undefined;
    return teardown;
  }
  initialized = true;

  const offPopup = api.onRsbBrowserPopup(({ url, openerSessionId, nativePopupSurfaceId }) => {
    const targetSessionId = openerSessionId ?? fallbackSessionId;
    if (!targetSessionId) {
      // 既无 opener 归属也无任何已知 session(冷启动即触发)——丢弃优于瞎猜。
      log.warn('popup dropped: no opener attribution and no known session', { url });
      if (nativePopupSurfaceId) {
        void api.rsbNativePopup.close({ surfaceId: nativePopupSurfaceId }).catch(() => undefined);
      }
      return;
    }
    // 给新 tab 一份完整 default state,只把 url 替换成 popup URL;hydrateState
    // 会把缺字段补回默认。background-tab disposition 暂不区分,统一前台打开;
    // 日后要支持后台 tab 时再按 disposition 分支选 setActive。
    const initialState = {
      url,
      title: '',
      favicon: null,
      isAudible: false,
      ...(nativePopupSurfaceId ? { nativePopupSurfaceId } : {}),
    };
    void (async () => {
      // 写 bucket 前一律先水合(含当前 session):store 契约要求先 hydrated 再写 ——
      // 未水合就写,`setBucket` 会以 hydrated:true 为 merge base(store.ts 的 cache
      // miss 分支),`ensureHydrated` 之后就早退,DB 里既有的 tab 被永久挡在本
      // renderer 外(丢 tab)。Shell 刚 mount、list IPC 还在途时 popup 就可能到达,
      // 所以当前 session 也不能省。ensureHydrated 幂等且并发去重,命中缓存即返回。
      await ensureHydrated(targetSessionId);
      // popup 来源标记必须在乐观插入的同一 tick 登记(onOptimisticAdd),不能等
      // addTab resolve:持久化 IPC 在途期间 React 已可能 mount webview 并加载完
      // callback 页,快速 window.close 会赶在登记前到达且 close 事件不重发。
      const newTab = await addTab(targetSessionId, 'web-browser', initialState, {
        onOptimisticAdd: (tabId) => {
          markPopupSpawnedTab(tabId);
          if (nativePopupSurfaceId) {
            registerNativePopupTab(tabId, targetSessionId, nativePopupSurfaceId);
          }
        },
      });
      // addTab IPC(upsert/setActive)在途期间用户可能已关闭该 tab —— closeTab
      // 乐观移除 + ipc.close 落库后,tab 已不在 bucket 里。若此时仍 eagerSpawn,
      // 会在 pool/Main registry 里留下孤立入口并重新加载 OAuth URL(Codex P1)。
      if (!getBucket(targetSessionId).tabs.some((t) => t.id === newTab.id)) return;
      if (nativePopupSurfaceId) {
        // Claim immediately so main can register the exact popup WebContents,
        // deliver self-close, and pin both popup + ordinary webview opener.
        const claimed = await api.rsbNativePopup.claim({
          surfaceId: nativePopupSurfaceId,
          sessionId: targetSessionId,
          tabId: newTab.id,
        });
        if (!claimed.alive) {
          await closeTab(targetSessionId, newTab.id);
          return;
        }
      } else {
        // Legacy/non-native payloads still materialize an ordinary webview.
        await eagerSpawnAndReport(targetSessionId, newTab.id, url);
      }
      // 一律离屏物化,不区分目标 session 是否当前:
      // - 跨 session / Shell 已卸载:没有 BrowserTabBody 去出生 webview;
      // - 同 session 但侧栏折叠:Shell 挂着但 shellVisible=false,#700 之后隐藏
      //   tab 不再首次物化 —— popup URL 同样永远不开始加载,OAuth 卡死。
      // 各形态都没有别的物化路径(与 main 端 open tab-op 的 eagerSpawnAndReport
      // 同理);侧栏可见时 TabBody 会 acquire 同一个 pool entry,eagerSpawn 幂等
      // 复用,无副作用。
      // 物化期间 tab 可能已经没了:OAuth callback 页在 dom-ready 前就
      // window.close()(guest 自关路径会把最后一个 tab 关掉并请求收起侧栏),
      // 或用户手动关了它。此时再无条件请求 'open' 会把刚写的"收起"存档翻回
      // "展开",用户切回该 session 只看到一个空侧栏。
      if (!getBucket(targetSessionId).tabs.some((t) => t.id === newTab.id)) return;
      // 当前 session:折叠时展开侧栏让用户看到 popup;已展开则 no-op。
      // 跨 session / Shell 卸载:只写目标 session 的折叠存档,用户切回去时侧栏
      // 已展开。userInitiated:false —— popup 由 guest 页面脚本催生,不是用户
      // 当次手势;detached 形态下不得 show+focus 抢走用户前台。
      requestRightSidebarVisibility('open', {
        sessionId: targetSessionId,
        userInitiated: false,
      });
    })().catch((err) => {
      log.error('rsb popup → addTab failed', { sessionId: targetSessionId, url, err });
      if (nativePopupSurfaceId) {
        void api.rsbNativePopup.close({ surfaceId: nativePopupSurfaceId }).catch(() => undefined);
      }
    });
  });

  const offNative = api.rsbNativePopup
    ? api.rsbNativePopup.onEvent((event) => {
        if (event.type !== 'closed') return;
        const tab = findNativePopupTabBySurface(event.surfaceId);
        if (!tab) return;
        void closeTab(tab.sessionId, tab.tabId).catch((err) => {
          log.warn('native popup self-close → closeTab failed', { ...tab, err });
        });
      })
    : () => undefined;

  teardown = () => {
    offPopup();
    offNative();
  };
  return teardown;
}

/** Test-only reset. */
export function _resetPopupRouterForTests(): void {
  if (teardown) teardown();
  initialized = false;
  teardown = null;
  fallbackSessionId = null;
}
