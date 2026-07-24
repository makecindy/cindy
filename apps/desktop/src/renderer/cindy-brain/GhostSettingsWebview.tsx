import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, LayoutGrid, MoonStar } from 'lucide-react';
import type { WebviewTag } from 'electron';

import { cn } from '@/lib/utils';
import { GHOST_SCHEME, ghostPartition, type InstalledGhost } from '../../shared/ghost';
import {
  buildGhostPluginSettingsThemeCss,
  buildGhostSettingsThemeCss,
  createGhostThemeInjector,
  observeHostTheme,
} from './ghostPanelTheme';
import {
  loadGhostSettingsSnapshot,
  saveGhostSettingsSnapshot,
  snapshotMatchesContext,
  snapshotMatchesWidth,
  type GhostSettingsSnapshot,
} from './ghostSettingsSnapshot';

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
 * 两次兜后到的布局/字体;声明了 settingsHeight 则固定该值(作者对动态内容
 * 的显式选择)。
 *
 * 视觉连续性(规则 7):guest 首帧不可能与宿主同帧(独立渲染进程,
 * attach→装载→绘制天然晚数帧)——追不平就贴快照:渲染稳定后把 guest 画面
 * capturePage 存起来(ghostSettingsSnapshot,跨 app 重启可用),下次进入
 * 首帧直接显示这张位图(高度也用它留位),webview 在图底下透明装载,主题
 * CSS 落地后撤图换真身——像素一致,肉眼无感。快照失配(首开 / 版本 / 主题 /
 * 宽度 / DPR 变化)时退回老路径:透明占位 + 一次性淡入,没有半成品帧。
 * 凭证输入不在这里:input:'host' 凭证仍宿主渲染;input:'ghost' 凭证由本区
 * 收单后经 /secrets 只写通道入库,意识读不回明文。
 */

/** 量到内容高之前的占位高(透明期的留位,不是内容下限)。 */
const AUTO_HEIGHT_PLACEHOLDER = 160;
/** 量高结果的 clamp 区间:矮内容真收下去(48 兜非法/塌零),高内容 800 封顶。 */
const AUTO_HEIGHT_MIN = 48;
const AUTO_HEIGHT_MAX = 800;

/**
 * 自适应模式的结构 CSS(dom-ready 注入,id 守卫幂等):
 * - html/body 高度钉 auto:意识页写 height:100%/100vh 会让 body 高恒等于
 *   当前视口高,量出来的值永远追着容器现值走(只涨不缩的棘轮,内容变矮后
 *   底部空白收不回去),钉 auto 后 body 高回归内容本身;
 * - overflow-x 裁掉:设置卡片里横滚动条永远不是想要的,且它会吃掉十几像素
 *   视口高、连带勾出纵滚动条(量高不知道横滚动条的存在)。
 * 纵向滚动开关不在这里——由量高脚本按"内容是否超 clamp 上限"逐次决定。
 * 仅自适应模式注入;settingsHeight 固定高度是作者显式选择,布局不干预。
 */
const AUTO_HEIGHT_GUEST_CSS =
  'html,body{height:auto !important;min-height:0 !important;}html{overflow-x:hidden;}';
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

/** 揭示(webview opacity 1)到撤快照图的间隔:盖过 0.12s 淡入 + 一帧余量。 */
const SNAPSHOT_SWAP_DELAY_MS = 180;
/** 渲染稳定后到拍快照的静默期(等 measure / 字体 / 主题注入全部尘埃落定)。 */
const SNAPSHOT_CAPTURE_DEBOUNCE_MS = 800;
/**
 * 快照兜底撤图时限:贴图后 guest 迟迟到不了揭示点(装载失败 / attach 被拒 /
 * guest 挂起)就撤图退回透明占位——旧世界的这类失败是诚实的空白,绝不能让
 * 一张位图冒充活界面无限期骗人。
 */
const SNAPSHOT_FAILSAFE_MS = 5000;

/**
 * 自适应模式下各意识上次量得的高度(渲染进程会话级缓存):重开详情页时
 * 先按上次高度留位,首帧即终态,不再每次都从最小高再长一截。
 * 冷启动(本会话没量过)时退到持久化快照里的高度,再退占位高。
 */
const lastMeasuredHeights = new Map<string, number>();

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
}: {
  ghost: InstalledGhost;
  appearance: 'settings' | 'plugin';
}): ReactNode {
  const [crashed, setCrashed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { manifest } = ghost;
  const settingsHtml = manifest.settingsHtml;
  const fixedHeight = manifest.settingsHeight;
  const buildSettingsThemeCss =
    appearance === 'plugin' ? buildGhostPluginSettingsThemeCss : buildGhostSettingsThemeCss;
  // 首帧贴的快照(仅 mount 时决定一次;版本/主题/DPR 现场比对,宽度等布局后
  // 由下方 layout effect 补验)。失配 = null,走透明占位 + 淡入的老路径。
  const [snapshot, setSnapshot] = useState<GhostSettingsSnapshot | null>(() => {
    const snap = loadGhostSettingsSnapshot(manifest.id);
    if (!snap) return null;
    const ctx = {
      version: manifest.version,
      themeCss: buildSettingsThemeCss(),
      dpr: window.devicePixelRatio,
    };
    return snapshotMatchesContext(snap, ctx) ? snap : null;
  });
  // 自适应模式的量高结果;初值:本会话量高缓存 → 持久化快照高度(只认同
  // 版本——换版后界面可能全变,旧高度不可信;主题/DPR 不影响布局高,不卡)
  // → 占位高。前两级命中时首帧即终态,零跳变。固定高度声明时本状态不参与。
  const [autoHeight, setAutoHeight] = useState(() => {
    const cached = lastMeasuredHeights.get(manifest.id);
    if (cached !== undefined) return cached;
    const snap = loadGhostSettingsSnapshot(manifest.id);
    return snap && snap.version === manifest.version ? snap.height : AUTO_HEIGHT_PLACEHOLDER;
  });

  // 快照宽度校验只能等容器布局后做——放 layout effect(首次 paint 前同步跑),
  // 失配在第一帧画出来之前就撤图,不会闪一张错位图。
  useLayoutEffect(() => {
    if (!snapshot) return;
    const host = hostRef.current;
    if (!host) return;
    if (!snapshotMatchesWidth(snapshot, host.getBoundingClientRect().width)) {
      setSnapshot(null);
    }
    // 仅首帧校验:后续容器宽度变化(拖窗口)时快照多半已撤;没撤也只是
    // 位图被拉伸 180ms,随换真身消失,不值得挂 ResizeObserver。
  }, []);

  useEffect(() => {
    if (crashed || !settingsHtml) return;
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement('webview') as WebviewTag;
    webview.setAttribute('partition', ghostPartition(manifest.id));
    webview.setAttribute('src', `${GHOST_SCHEME}://${manifest.id}/${settingsHtml}`);
    // 先透明占位:guest 装载与主题注入完成前不露面(一次性淡入,非常驻动画)。
    // 有快照时快照图盖在上层,这段透明期用户看到的就是"成品画面"。
    webview.setAttribute(
      'style',
      'display:flex;flex:1 1 auto;width:100%;height:100%;opacity:0;transition:opacity 0.12s ease;',
    );
    let disposed = false;
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotSwapTimer: ReturnType<typeof setTimeout> | null = null;
    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    // 兜底撤图:超时未揭示(装载失败/挂起)就把快照图撤掉退回透明占位,
    // 不让位图冒充活界面;正常揭示路径先行撤图后,这里触发是幂等 no-op。
    const snapshotFailsafeTimer = setTimeout(() => {
      if (!disposed) setSnapshot(null);
    }, SNAPSHOT_FAILSAFE_MS);
    const measureTimers: Array<ReturnType<typeof setTimeout>> = [];
    // 状态机见 createGhostThemeInjector:换肤误触发去重、dom-ready 无条件重灌。
    // 基线用设置卡片色(buildGhostSettingsThemeCss),与宿主卡片无缝。
    const injector = createGhostThemeInjector(webview, buildSettingsThemeCss);
    // 拍快照(debounce):等渲染尘埃落定后把 guest 画面存进快照缓存,给下次
    // 进入贴首帧用。guest 内部滚动过(内容超 800 clamp)时跳过——快照永远
    // 存"从头开始"的画面,与下次装载的初始滚动位一致。失败静默:快照只是
    // 体验增强,拍不成不影响任何功能。
    const scheduleCapture = () => {
      if (captureTimer !== null) clearTimeout(captureTimer);
      captureTimer = setTimeout(() => {
        captureTimer = null;
        void (async () => {
          if (disposed) return;
          try {
            // 三道拍摄前置检查(一次往返,任一命中即跳过本次拍摄):
            // ① guest 内部滚动过——快照永远存"从头开始"的画面(见上);
            // ② 任一文本类输入框有未保存内容;③ 焦点落在可编辑元素上
            // (input / textarea / contenteditable,正在输入中)。②③ 是凭证
            // 泄漏防线:设置区就是意识收 API key 的地方,输入中的明文绝不能
            // 以位图形式落进快照(localStorage 未加密)。宁可这次不拍(下次
            // 进入退回淡入路径),不冒泄漏面。守卫跑在不受信 guest 里只防
            // 意外不防恶意——恶意意识本来就能读到用户输进它页面的一切,
            // 快照不为它新增任何能力。
            const state: unknown = await webview.executeJavaScript(
              '(function(){var s=window.scrollY||document.documentElement.scrollTop||0;var d=false;var els=document.querySelectorAll("input,textarea");for(var i=0;i<els.length;i++){var e=els[i];var t=(e.type||"").toLowerCase();if(t==="checkbox"||t==="radio"||t==="button"||t==="submit"||t==="range")continue;if(e.value){d=true;break}}var a=document.activeElement;if(a&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.isContentEditable))d=true;return{scrolled:s>0,dirty:d}})()',
            );
            if (disposed) return;
            const flags = state as { scrolled?: unknown; dirty?: unknown } | null;
            if (!flags || flags.scrolled !== false || flags.dirty !== false) return;
            const image = await webview.capturePage();
            if (disposed) return;
            const rect = host.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            saveGhostSettingsSnapshot(manifest.id, {
              dataUrl: image.toDataURL(),
              width: rect.width,
              height: rect.height,
              dpr: window.devicePixelRatio,
              themeCss: buildSettingsThemeCss(),
              version: manifest.version,
              capturedAt: Date.now(),
            });
          } catch {
            // capturePage / executeJavaScript 在 guest 半途销毁等场景会抛,忽略。
          }
        })();
      }, SNAPSHOT_CAPTURE_DEBOUNCE_MS);
    };
    const scheduleInjectTheme = () => {
      if (themeTimer !== null) return;
      themeTimer = setTimeout(() => {
        themeTimer = null;
        if (disposed) return;
        injector.inject();
        // 换肤后的画面是新配色,旧快照已失配——重新拍一张。
        scheduleCapture();
      }, 50);
    };
    // 淡入揭示(幂等):挂在 dom-ready 后首个 executeJavaScript 回程上——
    // 同一 webContents 的 IPC 有序,该回程返回时 onDomReady 里先发的
    // insertCSS 必已作用于 guest,首个可见帧就是成品样式。贴着快照时再等
    // 一拍撤图(guest 与位图像素一致,交换无感);随后择机拍新快照。
    const reveal = () => {
      if (disposed) return;
      webview.style.opacity = '1';
      if (snapshotSwapTimer === null) {
        snapshotSwapTimer = setTimeout(() => {
          snapshotSwapTimer = null;
          if (!disposed) setSnapshot(null);
        }, SNAPSHOT_SWAP_DELAY_MS);
      }
      scheduleCapture();
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
          lastMeasuredHeights.set(manifest.id, clamped);
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
        // 内容尺寸变了 = 画面变了,快照跟着刷新。
        scheduleCapture();
      }, 80);
    };
    const onDomReady = () => {
      injector.onDomReady();
      if (fixedHeight !== undefined) {
        // 固定高度不量高,补一次空执行,只为把淡入排到主题 CSS 之后。
        void webview.executeJavaScript('0').then(reveal, reveal);
        return;
      }
      // 结构 CSS 先落地再量(html/body 钉 auto 会改变 body 高,顺序反了首量
      // 就是错值);脚本自带 id 守卫,dom-ready 因 guest 内跳转重入时幂等。
      void webview
        .executeJavaScript(AUTO_HEIGHT_STYLE_SCRIPT)
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
    // 装载失败(资源缺失 / 供片闸拒绝等):立刻撤快照图,失败就诚实地空白,
    // 与旧世界同款表现(errorCode -3 = ABORTED,导航中断不算失败;子资源
    // 失败不撤——主文档还活着,交给 5s 兜底判生死)。
    const onFailLoad = (event: Electron.DidFailLoadEvent) => {
      if (disposed || event.errorCode === -3 || !event.isMainFrame) return;
      setSnapshot(null);
    };
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('console-message', onConsoleMessage);
    webview.addEventListener('render-process-gone', onGone);
    webview.addEventListener('did-fail-load', onFailLoad);
    const unobserveTheme = observeHostTheme(scheduleInjectTheme);
    host.appendChild(webview);
    return () => {
      disposed = true;
      injector.dispose();
      if (themeTimer !== null) clearTimeout(themeTimer);
      if (snapshotSwapTimer !== null) clearTimeout(snapshotSwapTimer);
      if (captureTimer !== null) clearTimeout(captureTimer);
      clearTimeout(snapshotFailsafeTimer);
      for (const timer of measureTimers) clearTimeout(timer);
      unobserveTheme();
      if (resizeDebounce !== null) clearTimeout(resizeDebounce);
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('console-message', onConsoleMessage);
      webview.removeEventListener('render-process-gone', onGone);
      webview.removeEventListener('did-fail-load', onFailLoad);
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
      className="relative flex"
      style={{ height: fixedHeight ?? autoHeight }}
    >
      {/* 首帧快照(上层盖住透明装载期的 webview;pointer-events 穿透,撤图前
          的点击落到底下已就绪的真身上)。webview 由 effect 手动 appendChild
          进同一容器,React 只管理这张 img 的增删,互不干扰。 */}
      {snapshot ? (
        <img
          src={snapshot.dataUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        />
      ) : null}
    </div>
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
  const { manifest } = ghost;
  if (!manifest.settingsHtml) return null;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border px-5 py-4',
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
            appearance === 'plugin' ? 'text-14 leading-[22px]' : 'text-13',
          )}
        >
          {title ?? t('settings.ghosts.detail.customSlotTitle')}
        </p>
      </div>
      {ghost.enabled ? (
        <SettingsWebviewBody ghost={ghost} appearance={appearance} />
      ) : (
        <AsleepHint appearance={appearance} />
      )}
    </div>
  );
}
