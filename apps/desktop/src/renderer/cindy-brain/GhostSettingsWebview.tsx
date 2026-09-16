import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, LayoutGrid, MoonStar } from 'lucide-react';
import type { WebviewTag } from 'electron';

import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { GHOST_SCHEME, ghostPartition, type InstalledGhost } from '../../shared/ghost';
import {
  buildGhostPluginSettingsThemeCss,
  buildGhostSettingsThemeCss,
  createGhostThemeInjector,
  observeHostTheme,
} from './ghostPanelTheme';
import {
  GHOST_SETTINGS_HEIGHT_MIN,
  GHOST_SETTINGS_HEIGHT_MAX,
  loadGhostSettingsHeight,
  saveGhostSettingsHeight,
} from './ghostSettingsHeight';

/**
 * 意识「自定义设置区」卡片(settingsHtml 渲染通道):设置页详情里
 * 一块沙箱 webview 装载意识自绘的 settingsHtml——与面板同一套机制:
 * 分区/地址由 main 侧 webview 附加闸验明正身(resolveGhostWebviewAttach 的
 * 入口白名单),主题 token 在 dom-ready 注入、主机换肤时重灌(注入基线用
 * 设置卡片色 buildGhostSettingsThemeCss,guest 与宿主卡片无缝同色),
 * webview 崩溃 = 卡片内错误接管(重载 = 原地重挂载,不经主机)。
 *
 * 高度:缺省**随内容自适应**——dom-ready 后宿主 executeJavaScript 量 guest
 * 的 body 内容高(不受信数值,clamp 48–800 收口;量到前占位 160),延迟补量
 * 两次兜后到的布局/字体;声明了 settingsHeight 则固定该值,并保持作者布局
 * 完全不受宿主响应式规则干预。
 *
 * 重开时仅缓存高度留位,不保存或重放 guest 画面:昵称、账号状态、菜单等
 * 都可能在尺寸不变时更新,旧截图不能冒充当前界面。每次挂载创建新 guest,
 * 主题与布局注入完成后展示真实页面,卸载时销毁 guest 与所有宿主监听。
 * 凭证输入不在这里:input:'host' 凭证仍宿主渲染;input:'ghost' 凭证由本区
 * 收单后经 /secrets 只写通道入库,意识读不回明文。
 */

/** 量到内容高之前的占位高(透明期的留位,不是内容下限)。 */
const AUTO_HEIGHT_PLACEHOLDER = 160;
/** 量高结果的 clamp 区间:矮内容真收下去(48 兜非法/塌零),高内容 800 封顶。 */
const AUTO_HEIGHT_MIN = GHOST_SETTINGS_HEIGHT_MIN;
const AUTO_HEIGHT_MAX = GHOST_SETTINGS_HEIGHT_MAX;

/**
 * 自适应高度设置 guest 的结构 CSS(dom-ready 注入,id 守卫幂等):
 * - 把文档和子元素宽度收在宿主卡片内,让插件作者的固定宽控件在极窄内容区
 *   也能收缩,而不是顶出卡片;
 * - html/body 高度钉 auto:意识页写 height:100%/100vh 会让 body 高恒等于
 *   当前视口高,量出来的值永远追着容器现值走(只涨不缩的棘轮,内容变矮后
 *   底部空白收不回去),钉 auto 后 body 高回归内容本身;
 * - overflow-x 裁掉:设置卡片里横滚动条永远不是想要的,且它会吃掉十几像素
 *   视口高、连带勾出纵滚动条(量高不知道横滚动条的存在)。
 * 纵向滚动开关不在这里——由量高脚本按"内容是否超 clamp 上限"逐次决定。
 * 固定高度模式不注入这些规则,遵守 settingsHeight 的作者布局契约。
 */
const RESPONSIVE_GUEST_CSS =
  'html,body{width:100%!important;max-width:100%!important;overflow-x:hidden!important;}*,*::before,*::after{box-sizing:border-box!important;min-width:0!important;max-width:100%!important;}';
const RESPONSIVE_STYLE_SCRIPT = `(function(){if(document.getElementById('__xdt_settings_w'))return;var s=document.createElement('style');s.id='__xdt_settings_w';s.textContent=${JSON.stringify(RESPONSIVE_GUEST_CSS)};(document.head||document.documentElement).appendChild(s)})()`;
const AUTO_HEIGHT_GUEST_CSS = 'html,body{height:auto !important;min-height:0 !important;}';
const AUTO_HEIGHT_STYLE_SCRIPT = `(function(){if(document.getElementById('__xdt_auto_h'))return;var s=document.createElement('style');s.id='__xdt_auto_h';s.textContent=${JSON.stringify(AUTO_HEIGHT_GUEST_CSS)};(document.head||document.documentElement).appendChild(s)})()`;

/**
 * 量高脚本:文档顶(0)到最低内容底边的距离,外加真实的底部外边距——
 * 旧公式「body 盒高 + 2×顶部偏移」假设上下留白对称,最后一个子元素的
 * margin-bottom 会塌出 body 盒子被漏量(滚动条常驻),顶部留白大于底部时
 * 又会高估(底部一截空白)。现在按实际几何算:body 盒底 + body margin-bottom
 * 与各顶层子元素「盒底 + margin-bottom」取最大(塌陷取 max 正是折叠语义),
 * 加 scrollY 折回文档坐标。顺手按结果切换纵向滚动条:内容没超 clamp 上限时
 * 容器终将追平,滚动条只是追赶窗口期的闪烁,关掉;真超上限才放开滚动。
 * 返回值不受信,宿主侧仍 clamp 收口。
 */
const AUTO_HEIGHT_MEASURE_SCRIPT = `(function(){var de=document.documentElement,b=document.body;if(!b)return de?de.scrollHeight:0;var sy=window.scrollY||(de?de.scrollTop:0)||0;var r=b.getBoundingClientRect();var bottom=r.bottom+(parseFloat(getComputedStyle(b).marginBottom)||0);var kids=b.children;for(var i=0;i<kids.length;i++){var kr=kids[i].getBoundingClientRect();if(kr.height<=0)continue;var kb=kr.bottom+(parseFloat(getComputedStyle(kids[i]).marginBottom)||0);if(kb>bottom)bottom=kb}var h=sy+bottom;if(de)de.style.overflowY=h>${AUTO_HEIGHT_MAX}?'auto':'hidden';return h})()`;

/**
 * guest 内容尺寸变化的哨兵串(ResizeObserver → console.log,宿主命中即重量)。
 * 只是"来量一下"的信号,不携带任何数据;高度永远由宿主自己 executeJavaScript 读。
 */
const GHOST_SETTINGS_RESIZE_PING = '__xdt_ghost_settings_resize__';

/** 沉睡态提示(attach 闸只放行唤醒的意识,沉睡时不建 webview,否则必被拒成白屏)。 */
function AsleepHint({ appearance }: { appearance: 'settings' | 'plugin' }): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-9">
      <MoonStar size={20} className="text-[var(--text-tertiary)] opacity-60" />
      <p
        className={cn(
          'text-center text-[var(--text-tertiary)] opacity-70',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
        )}
      >
        {t('settings.ghosts.detail.customSlotAsleep')}
      </p>
    </div>
  );
}

/** 崩溃接管(卡片内嵌小态;设置页本来就有沉睡开关,不再放"关闭意识"按钮)。 */
function CrashedHint({
  onReload,
  appearance,
}: {
  onReload: () => void;
  appearance: 'settings' | 'plugin';
}): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-9">
      <CircleAlert size={20} className="text-[var(--error-fg)]" />
      <p
        className={cn(
          'text-center text-[var(--text-secondary)]',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12 leading-relaxed',
        )}
      >
        {t('settings.ghosts.panelError.crashed')}
      </p>
      <button
        type="button"
        onClick={onReload}
        className={cn(
          'rounded-full border border-[var(--border-default)] px-3.5 py-1.5 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-chip)]',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
        )}
      >
        {t('settings.ghosts.panelError.reload')}
      </button>
    </div>
  );
}

/** webview 体:与 GhostChipPanelBody 同款装载/主题/崩溃模板(无媒体右键分支)。 */
function SettingsWebviewBody({
  ghost,
  appearance,
  dataOwnerId,
}: {
  ghost: InstalledGhost;
  appearance: 'settings' | 'plugin';
  dataOwnerId: string | null;
}): ReactNode {
  const [crashed, setCrashed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { manifest } = ghost;
  const partitionClaim = ghostPartition(manifest.id);
  const settingsHtml = manifest.settingsHtml;
  const fixedHeight = manifest.settingsHeight;
  const buildSettingsThemeCss =
    appearance === 'plugin' ? buildGhostPluginSettingsThemeCss : buildGhostSettingsThemeCss;
  // 仅复用同 owner、同插件版本的高度;账号文字和菜单由新 guest 实时渲染。
  const [autoHeight, setAutoHeight] = useState(
    () =>
      loadGhostSettingsHeight(dataOwnerId, manifest.id, manifest.version) ??
      AUTO_HEIGHT_PLACEHOLDER,
  );

  useEffect(() => {
    if (crashed || !settingsHtml) return;
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement('webview') as WebviewTag;
    webview.setAttribute('partition', partitionClaim);
    webview.setAttribute('src', `${GHOST_SCHEME}://${manifest.id}/${settingsHtml}`);
    // 先透明留位,主题与布局注入完成后直接展示真实页面,不覆盖历史画面。
    webview.setAttribute('style', 'display:flex;flex:1 1 auto;width:100%;height:100%;opacity:0;');
    let disposed = false;
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    const measureTimers: Array<ReturnType<typeof setTimeout>> = [];
    // 状态机见 createGhostThemeInjector:换肤误触发去重、dom-ready 无条件重灌。
    // 基线用设置卡片色(buildGhostSettingsThemeCss),与宿主卡片无缝。
    const injector = createGhostThemeInjector(webview, buildSettingsThemeCss);
    const scheduleInjectTheme = () => {
      if (themeTimer !== null) return;
      themeTimer = setTimeout(() => {
        themeTimer = null;
        if (disposed) return;
        injector.inject();
      }, 50);
    };
    // 揭示(幂等):挂在 dom-ready 后首个 executeJavaScript 回程上——
    // 同一 webContents 的 IPC 有序,该回程返回时 onDomReady 里先发的
    // insertCSS 必已作用于 guest,首个可见帧就是成品样式。
    const reveal = () => {
      if (disposed) return;
      webview.style.opacity = '1';
    };
    // 自适应量高:宿主主动 executeJavaScript 读 guest 文档高度(零桥模型
    // 不破——是嵌入方读,不是 guest 上行);返回值不受信,非数字丢弃、
    // clamp 收口。dom-ready 即量 + 两次延迟补量(字体/图片等后到布局)。
    // 量法与滚动条开关见 AUTO_HEIGHT_MEASURE_SCRIPT 顶注。
    const measure = () => {
      if (disposed || fixedHeight !== undefined) return;
      void webview
        .executeJavaScript(AUTO_HEIGHT_MEASURE_SCRIPT)
        .then((h: unknown) => {
          if (disposed || typeof h !== 'number' || !Number.isFinite(h)) return;
          const clamped = Math.max(AUTO_HEIGHT_MIN, Math.min(AUTO_HEIGHT_MAX, Math.ceil(h)));
          saveGhostSettingsHeight(dataOwnerId, manifest.id, manifest.version, clamped);
          setAutoHeight((cur) => (cur === clamped ? cur : clamped));
        })
        .catch(() => {})
        .then(reveal);
    };
    // 动态重量(2026-07-13,filo-google 账号列表实撞:内容加载后加行,
    // 三次定点量高已过、新行被裁):dom-ready 后往 guest 注一段 ResizeObserver,
    // 内容尺寸变化时 console.log 一个哨兵串;宿主听 console-message 命中哨兵
    // 就 debounce 重量。零桥模型不破——guest 只能"喊一声让宿主自己来量",
    // 高度值仍由宿主 executeJavaScript 读取(不受信侧无法注入假高度);
    // 恶意刷哨兵最多让宿主多量几次,有 debounce + clamp 收口。
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    const onConsoleMessage = (event: Electron.ConsoleMessageEvent) => {
      if (disposed || fixedHeight !== undefined) return;
      if (event.message !== GHOST_SETTINGS_RESIZE_PING) return;
      if (resizeDebounce !== null) return;
      resizeDebounce = setTimeout(() => {
        resizeDebounce = null;
        measure();
      }, 80);
    };
    const onDomReady = () => {
      injector.onDomReady();
      if (fixedHeight !== undefined) {
        // settingsHeight 契约要求宿主不干预 guest 布局。只用空脚本往返作为
        // 主题 insertCSS 后的有序揭示屏障,不注入宽度/overflow 规则。
        void webview.executeJavaScript('void 0').then(reveal, reveal);
        return;
      }
      const prepareResponsiveLayout = webview
        .executeJavaScript(RESPONSIVE_STYLE_SCRIPT)
        .catch(() => {});
      // 结构 CSS 先落地再量(html/body 钉 auto 会改变 body 高,顺序反了首量
      // 就是错值);脚本自带 id 守卫,dom-ready 因 guest 内跳转重入时幂等。
      void prepareResponsiveLayout
        .then(() => webview.executeJavaScript(AUTO_HEIGHT_STYLE_SCRIPT))
        .catch(() => {})
        .then(measure);
      measureTimers.push(setTimeout(measure, 250), setTimeout(measure, 1000));
      // 幂等注入(dom-ready 可能因 guest 内跳转再来一次)。
      void webview
        .executeJavaScript(
          `(function(){if(window.__xdtGhostResizeObserver)return;try{var o=new ResizeObserver(function(){console.log(${JSON.stringify(GHOST_SETTINGS_RESIZE_PING)})});o.observe(document.body);window.__xdtGhostResizeObserver=o}catch(e){}})()`,
        )
        .catch(() => {});
    };
    const onGone = () => {
      if (!disposed) setCrashed(true);
    };
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('console-message', onConsoleMessage);
    webview.addEventListener('render-process-gone', onGone);
    const unobserveTheme = observeHostTheme(scheduleInjectTheme);
    host.appendChild(webview);
    return () => {
      disposed = true;
      injector.dispose();
      if (themeTimer !== null) clearTimeout(themeTimer);
      for (const timer of measureTimers) clearTimeout(timer);
      unobserveTheme();
      if (resizeDebounce !== null) clearTimeout(resizeDebounce);
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('console-message', onConsoleMessage);
      webview.removeEventListener('render-process-gone', onGone);
      webview.remove();
    };
    // version 入依赖:原位更新换版后 webview 重挂载,设置区立刻跑新代码。
  }, [
    crashed,
    generation,
    manifest.id,
    manifest.version,
    manifest.resolvedLocale,
    settingsHtml,
    fixedHeight,
    dataOwnerId,
    partitionClaim,
  ]);

  if (crashed) {
    return (
      <CrashedHint
        appearance={appearance}
        onReload={() => {
          setGeneration((g) => g + 1);
          setCrashed(false);
        }}
      />
    );
  }
  return (
    <div
      ref={hostRef}
      data-ghost-webview
      className={cn(
        'relative flex w-full min-w-0 max-w-full',
        fixedHeight === undefined && 'overflow-hidden',
      )}
      style={{ height: fixedHeight ?? autoHeight }}
    />
  );
}

/** 卡片宿主:标题行 + 按启用态分派(沉睡提示 / 沙箱 webview)。 */
export function GhostSettingsWebview({
  ghost,
  title,
  appearance = 'settings',
}: {
  ghost: InstalledGhost;
  /** Product-facing section title; settings keeps the legacy fallback. */
  title?: string;
  /** Plugin detail uses the same shared surface as Tool and Permission cards. */
  appearance?: 'settings' | 'plugin';
}): ReactNode {
  const { t } = useTranslation();
  const { mode, dataOwnerId } = useAuth();
  const ownerKey = `${mode}:${dataOwnerId ?? ''}`;
  const { manifest } = ghost;
  if (!manifest.settingsHtml) return null;
  return (
    <div
      className={cn(
        'flex min-w-0 max-w-full flex-col gap-3 rounded-xl border px-5 py-4',
        appearance === 'plugin'
          ? 'border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]'
          : 'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-center gap-2">
        <LayoutGrid size={14} className="text-[var(--text-tertiary)]" />
        <p
          className={cn(
            'font-medium text-[var(--text-primary)]',
            appearance === 'plugin' ? 'text-14 leading-[1.571]' : 'text-13',
          )}
        >
          {title ?? t('settings.ghosts.detail.customSlotTitle')}
        </p>
      </div>
      {ghost.enabled ? (
        <SettingsWebviewBody
          key={JSON.stringify([ownerKey, manifest.id, manifest.version])}
          ghost={ghost}
          appearance={appearance}
          dataOwnerId={dataOwnerId}
        />
      ) : (
        <AsleepHint appearance={appearance} />
      )}
    </div>
  );
}
