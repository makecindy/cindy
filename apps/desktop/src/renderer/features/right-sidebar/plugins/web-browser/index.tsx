/**
 * web-browser plugin —— RSB 内嵌浏览器(对标设计稿 F3,**不做** F4 newtab 卡片)。
 *
 * 设计要点:
 *   - **state 最小化**:`{ url, title, favicon }` —— 重启 / 切 session 后能完整恢复
 *     "用户上次看的页面 + tab pill 标题 + 图标"。webview 内部的 cookie / history /
 *     sessionStorage 等由 BROWSER_PARTITION 自带持久化,跟 plugin state 完全独立。
 *   - **默认 about:blank** —— 跟 Codex 一致(plan 顶部 "用户确认")。F4 newtab 卡片
 *     设计稿暂搁置,空标签就是空白页 + URL bar 提示。
 *   - **plugin state ↔ webview 状态双向同步**:
 *       * 首次 mount:plugin state.url → webview.loadURL(从持久化恢复)
 *       * 运行时:webview did-navigate / page-title-updated / page-favicon-updated
 *                 → ctx.patchState 写回 plugin state,触发持久化
 *
 * 注册:模块顶层 import-side-effect,plugins/index.ts 把它 import 进来。
 */

import { Globe, Volume2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { normalizePersistableFavicon } from '../../../../../shared/faviconPersistence';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const BrowserTabBody = lazy(() =>
  import('./BrowserTabBody').then((module) => ({ default: module.BrowserTabBody })),
);

/** plugin state shape —— 反序列化口径:JSON identity 即可恢复。 */
export interface WebBrowserState {
  /** 当前页面 URL;默认 about:blank,从未导航过的新 tab 一直是它。 */
  url: string;
  /** 当前页面 title(用作 tab pill 文案)。空串 / 未拿到时 pill 走"新标签"占位。 */
  title: string;
  /** 当前页面 favicon URL(用作 tab pill icon)。null = 没拿到 / 拿到但不可
   * 持久化(blob: / 超大 / 非白名单协议),都走 Globe fallback。 */
  favicon: string | null;
  /** guest 正在发声(`audio-state-changed`)。tab pill 据此叠喇叭图标,跟 Chrome
   *  行为对齐 + Codex `main-cC-d0ezP.js:48434` 等价。后台 tab 不持久化(切走重启
   *  应当回到静默态,因为 webview 会重新加载),但运行时仍然写进 state 走 patchState
   *  统一通道,UI 通过 state 拿。 */
  isAudible: boolean;
  /** Runtime-only id of a Chromium-created popup adopted by main. Hydration
   * intentionally drops it because native surfaces do not survive restart. */
  nativePopupSurfaceId?: string;
}

const DEFAULT_STATE: WebBrowserState = {
  url: 'about:blank',
  title: '',
  favicon: null,
  isAudible: false,
};

/**
 * Tab pill 标题:有 title → 显示 title;否则 → "新标签" i18n 占位。
 * title 可能很长(网页 `<title>`),pill 自身 truncate 处理截断。
 */
function WebBrowserTabPillTitle({
  state,
  t,
}: {
  state: WebBrowserState;
  t: TFunction;
}) {
  if (state.title) return <>{state.title}</>;
  return <>{t('rightSidebar.browser.newTab')}</>;
}

/**
 * Tab pill 图标:favicon 有 → <img>,否则 Globe fallback。
 * isAudible 为 true 时:**右下角叠一个小 Volume2 喇叭图标**(跟 Chrome / Codex
 * tab pill 行为一致 —— 用户能从图标一眼看出哪个 tab 在发声)。
 * favicon onError(404 / 取不到)→ 也走 fallback,不让破图占位。
 */
export function WebBrowserTabPillIcon({ state }: { state: WebBrowserState }) {
  const { t } = useTranslation();
  const base = state.favicon ? (
    <FaviconImage
      key={state.favicon}
      src={state.favicon}
    />
  ) : (
    <Globe size={13} />
  );
  if (!state.isAudible) return base;
  // wrap 一层 relative,Volume2 叠在右下方。喇叭比 13px favicon 小一号(9px),
  // 用主题 accent 色保证 light/dark 两边都看得清。
  return (
    <span className={cn('relative inline-flex')}>
      {base}
      <Volume2
        size={9}
        strokeWidth={2.5}
        className="pointer-events-none absolute -bottom-0.5 -right-1 text-[var(--accent-cta-bg)]"
        aria-label={t('rightSidebar.browser.audible')}
      />
    </span>
  );
}

/**
 * favicon URL 可能来自独立 webview partition、临时 blob 或需要登录态的资源。
 * host renderer 加载失败时保留稳定的 Globe fallback；src 变化通过 key 重建本组件，
 * 让新站点图标拥有独立的错误状态。
 */
function FaviconImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Globe size={13} />;
  return (
    <img
      src={src}
      alt=""
      width={13}
      height={13}
      draggable={false}
      onError={() => setFailed(true)}
      style={{ objectFit: 'contain' }}
    />
  );
}

const plugin: TabKindPlugin<WebBrowserState> = {
  kind: 'web-browser',
  menu: {
    kind: 'web-browser',
    labelKey: 'rightSidebar.tabs.kinds.browser',
    icon: Globe,
    order: 20,
    enabled: true,
  },
  TabPillTitle: WebBrowserTabPillTitle,
  TabPillIcon: WebBrowserTabPillIcon,
  TabBody: BrowserTabBody,
  defaultState: () => ({ ...DEFAULT_STATE }),
  // hydrate:容忍持久化 schema 演进。Phase 2 时期空 state(`null`)→ default。
  // isAudible 不从持久化恢复(重启后 webview 重新加载,默认静默才合理)。
  // favicon 再消毒一次:存量坏数据(超大 / blob: / 非白名单)在显示层也不放行。
  hydrateState: (raw): WebBrowserState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const obj = raw as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? obj.url : DEFAULT_STATE.url;
    const title = typeof obj.title === 'string' ? obj.title : DEFAULT_STATE.title;
    const favicon =
      typeof obj.favicon === 'string'
        ? normalizePersistableFavicon(obj.favicon)
        : obj.favicon === null
        ? null
        : DEFAULT_STATE.favicon;
    return { url, title, favicon, isAudible: false };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
