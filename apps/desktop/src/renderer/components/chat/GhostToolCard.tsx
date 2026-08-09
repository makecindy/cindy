/**
 * GhostToolCard — 消息流「意识卡片」(卡槽③海报模式)。
 *
 * 结构 = 归属 chip(意识摸不到)+ 意识画布(沙箱 iframe)+ 衍生卡堆叠:
 * - chip:幽灵印记 + 意识名 + 运行/完成状态点 + 展开箭头(点开看调用参数,
 *   审计透明层),全 token 上色(规则 16)——这是"这块内容是第三方意识画的"
 *   的统一信任签名,卡体再怎么自定义也冒充不了系统输出。
 * - 画布:`<iframe sandbox="allow-same-origin" srcDoc>` 装主机净化后的静态
 *   HTML+CSS。**绝不带 allow-scripts**——即使 sanitizer 有漏,规范层面脚本
 *   也不执行(纵深第二道);srcdoc 脚手架头部再注 meta CSP 锁子资源
 *   (第三道:图片只放行 cindy-media:)。头部还注一段主机主题变量块
 *   (`:root{--token:value}`,白名单同面板),意识用 var(--xxx) 即可跟主题、
 *   不用则不受影响;主题切换重建 srcDoc 原地重载。高度由供片声明(主机已
 *   clamp),换海报 = React 更新 srcDoc 原地替换,容器高度过渡缓动,不跳版。
 * - 点击桥:iframe 与宿主同源(allow-same-origin 的目的),onLoad 后进
 *   contentDocument 给 cindy-media 图片挂 click → 弹标准 ImageLightbox;
 *   data-ghost-action 元素挂 click → card-action 回传意识(交互卡 v2);
 *   data-ghost-prompt 类动作先弹宿主输入框收文字;data-ghost-link 元素挂
 *   click → 宿主确认框(真实域名 + 全串链接)→ openExternal(外链 v3)。
 *   组件不向 iframe 注入脚本。
 * - 衍生卡(spawnCallId,`<根>::sp<序>`):card-action 触发的新结果卡,
 *   渲染在母卡下方——母卡(如 MJ 四宫格+按钮)原封不动,抽卡式反复点。
 *   每张衍生卡是**视觉独立的新卡片**:自带一枚精简归属 chip(印记 + 名字 +
 *   运行/完成状态点,无参数展开——参数审计在母卡)+ 独立画布实例(同一套
 *   点击桥/量高/输入面板/右键菜单);意识声明 state:'working' 的过程态
 *   衍生卡挂主机扫光,让"还在生成"肉眼可见。
 *
 * 规则 7:running 动画挂 HTML wrapper 的 compositor-only spin,settle 即卸;
 * 历史卡片纯静态(净化器已剥 CSS 动画之外的一切动源,iframe 无脚本)。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Copy, FolderOpen, Ghost, Loader2 } from 'lucide-react';

import { ImageLightbox } from './ImageLightbox';
import { ModelLightbox } from './ModelLightbox';
import { toast } from '@/lib/toast';
import { registerMedia } from '@/lib/mediaPlaybackBus';
import { ListComposerTextarea } from '@/components/new-chat/ListComposerTextarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import {
  getGhostCardSnapshot,
  listSpawnCards,
  noteCardMeasuredHeight,
  subscribeGhostCards,
} from '@/cindy-brain/ghostCardStore';
import { useGhostCardThemeVars } from '@/cindy-brain/useGhostCardThemeVars';
import { alignFrameWithGate } from '@/lib/hiddenAnimationGate';
import {
  extractGhostCardGallerySrcs,
  ghostCardGalleryId,
} from '@/cindy-brain/ghostCardGallery';
import {
  GHOST_CARD_ACTION_INFLIGHT_MS,
  GHOST_CARD_ACTION_PROMPT_MAX_LEN,
  GHOST_CARD_HEIGHT_MAX,
  GHOST_CARD_HEIGHT_MIN,
  isGhostCardLinkAllowed,
} from '@/../shared/ghost';

/** 卡片画布宽度上限(与 tool-output 图卡同规格,设计稿按 460 出的)。 */
const CARD_MAX_WIDTH = 460;

/* ── data-ghost-audio 卡内播放器(宿主托管插槽)──────────────────────────
 * 意识在卡里声明 <div data-ghost-audio="cindy-media://…">,宿主受信桥清空其
 * 子树、注入与基座 ChatAudioCard **同款**的播放器行(播放/暂停 + 进度 scrub +
 * 时间标签,同尺寸同 token);<audio> 实体活在宿主文档(卡内 CSP 不放行
 * media,也无需放行),经 registerMedia 全局互斥总线管理——与基座播放器
 * 互斥、切会话 stopAllMedia 一并兜底。卡内零脚本不变:意识只声明插槽,
 * 播放行为全部由宿主在父上下文驱动。 */

/** lucide Play(填充三角,右移 1px 视觉居中)/ Pause,与 ChatAudioCard 同形。 */
const AUDIO_PLAY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-left:1px" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const AUDIO_PAUSE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

/** `175.96` → `2:55`(与 ChatAudioCard.formatDuration 同规则)。 */
function formatAudioClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 播放器行注入模板(1:1 ChatAudioCard 播放器行:28px 圆钮 + 11px 时间 +
 *  4px 进度条 + 10px 圆点;token 同源,fallback 取默认亮色主题实际值)。 */
function buildAudioRowHtml(durationLabel: string): string {
  const timeStyle =
    'flex-shrink:0;font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--msg-tool-card-chevron,#525252)';
  return (
    '<div data-x-row style="display:flex;align-items:center;gap:12px;user-select:none">' +
    '<button type="button" data-x-play aria-label="Play" style="display:flex;width:28px;height:28px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:9999px;border:0;padding:0;cursor:pointer;background:var(--msg-tool-card-text,#262626);color:var(--msg-tool-card-bg,#ffffff)">' +
    AUDIO_PLAY_SVG +
    '</button>' +
    `<span data-x-cur style="${timeStyle}">0:00</span>` +
    '<div data-x-track style="position:relative;height:4px;flex:1;cursor:pointer;border-radius:9999px;background:var(--msg-tool-card-border,#d7d7d4);touch-action:none">' +
    '<div data-x-fill style="position:absolute;left:0;top:0;height:100%;width:0%;border-radius:9999px;background:var(--msg-tool-card-text,#262626)"></div>' +
    '<div data-x-dot style="position:absolute;top:50%;left:-5px;width:10px;height:10px;transform:translateY(-50%);border-radius:9999px;background:var(--msg-tool-card-text,#262626)"></div>' +
    '</div>' +
    `<span data-x-dur style="${timeStyle}">${durationLabel}</span>` +
    '</div>'
  );
}

/** srcdoc 脚手架:meta CSP 锁子资源 + 主题变量块 + 最小 reset;正文为主机
 *  净化产物。文字保持可选中(海报里的说明文案用户要能复制);图片禁拖拽保住
 *  海报手感。
 *  themeVars:主机主题的 `:root{color-scheme:…;--token:value}` 白名单变量块(见
 *  useGhostCardThemeVars),纯加法下发——意识引用 var(--xxx) 就跟主题,写死
 *  配色的意识不引用即无感知。其中 color-scheme 是**透明画布契约的前提**:
 *  它不跨文档继承,不声明时 Chromium 按 light 给 iframe 一张不透明白 canvas,
 *  于是不铺底色的全出血卡在暗色主题下整张变白(且切主题不变——白来自 UA)。
 *  取值与守卫见 ghostPanelTheme.readHostColorScheme。
 *  style-src 'unsafe-inline' 已放行本段内联样式。 */
function buildCardSrcDoc(sanitizedHtml: string, themeVars: string): string {
  return [
    '<!doctype html><html><head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src cindy-media:; style-src \'unsafe-inline\'">',
    // 主题变量块放在基线 reset 之前:意识正文的净化后内联样式仍可覆盖,
    // var(--xxx) 供其按需取用;themeVars 为空(极端:store 未就绪)时不注空标签
    // ——正常路径下它恒含 color-scheme 声明,不会为空。
    themeVars ? `<style>${themeVars}</style>` : '',
    // reduced-motion 门控是宿主强制(规则 7),不靠意识作者自觉:系统开了
    // 减弱动效时,动画版卡片的意识自绘动画一律停播(srcdoc 内 media query
    // 正常继承系统偏好)。背景仍由意识正文自己决定:透明画布是现行卡片
    // 作者契约,宿主不能强铺 surface 改变其它 Ghost 的视觉。
    // 窗口不可见时卡内动画的冻结不在这里做:CSS 选不出「只暂停无限循环动画」,通配
    // 规则会把 cardSanitizer 允许的有限动画(如 animation:f 1s)一并冻在中途帧,恢复可见
    // 时突兀。改由宿主用 Web Animations API 逐个判 iterations,见 hiddenAnimationGate 的
    // syncFrameAnimations 与下面 onLoad 的对齐。
    '<style>html,body{margin:0;padding:0;overflow:hidden;font-family:system-ui,-apple-system,sans-serif}img{max-width:100%;-webkit-user-drag:none;-webkit-user-select:none;user-select:none}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>',
    '</head><body>',
    sanitizedHtml,
    '</body></html>',
  ].join('');
}

/** 卡片内用户主动展开/收起时向消息流冒泡的事件名:消息流据此在短窗口内
 *  跳过贴底自动跟随,让展开区向下铺开,而不是被 pin-to-bottom 把头部顶上去。 */
export const CARD_EXPAND_TOGGLE_EVENT = 'xdt-card-expand-toggle';

/**
 * 单块意识画布(母卡与衍生卡共用):沙箱 iframe + 点击桥(lightbox /
 * card-action / data-ghost-prompt 输入面板)+ 权威量高与写回。自带一层
 * 非裁切 relative 容器承载输入面板(画布壳 overflow-hidden 会裁面板)。
 */
function GhostCardCanvas({
  callId,
  html,
  animatedHtml,
  height,
  running,
  themeVars,
  ariaTitle,
  sessionId,
  allowExternalLinks,
}: {
  /** 本画布的卡片键(母卡 = 调用 callId;衍生卡 = spawnCallId)。 */
  callId: string;
  html: string;
  animatedHtml?: string;
  height: number;
  running: boolean;
  themeVars: string;
  ariaTitle: string;
  sessionId?: string;
  /** 插件是否声明了 card.externalLinks;未声明则卡内 data-ghost-link 不激活。 */
  allowExternalLinks?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; galleryId: string } | null>(null);
  // data-ghost-model 声明的 3D 预览:点击开应用内 3D 查看器(GLB 已在媒体
  // 总仓,blob 来源直读,预览图作 poster)。
  const [modelView, setModelView] = useState<{ url: string; poster: string } | null>(null);
  // data-ghost-prompt 类动作的宿主输入面板(与老基座 ChatImageActions 的
  // imgPrompt popover 同体验:点按钮 → 弹输入框 → 回车/发送)。卡内零脚本,
  // 输入框是宿主交互面(同 lightbox 一层),文字随 card-action 的 prompt 回传。
  const [promptAsk, setPromptAsk] = useState<{
    actionId: string;
    placeholder: string;
    top: number;
    left: number;
  } | null>(null);
  const [promptText, setPromptText] = useState('');
  // 弹面板那颗按钮的引用:发送时对它上锁(防连点),与普通按钮同一套锁。
  const promptSourceElRef = useRef<HTMLElement | null>(null);
  // data-ghost-link 外链确认框(卡片交互 v3):卡内声明式外链点击后先弹宿主
  // 确认框(展示真实域名 + 完整链接,防"文案写 A 链到 B"),用户确认才
  // openExternal。链接文案归意识,跳转链路由宿主独占——与 action/prompt 同一
  // 信任模型。值 = 待确认的 URL。
  const [linkAsk, setLinkAsk] = useState<string | null>(null);
  // 卡内图片右键菜单(复制图片 / 打开所在目录):与 ChatImageView 同款交互。
  // 图片在沙箱 iframe 里,宿主的 React onContextMenu 收不到,由点击桥代挂
  // contextmenu 监听后把 iframe 坐标换算成宿主视口坐标弹这里的菜单。
  const [imgMenu, setImgMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  // 卡内音频插槽右键菜单(打开音频所在目录,与 ChatAudioCard 同交互)。
  const [audioMenu, setAudioMenu] = useState<{ x: number; y: number; url: string } | null>(null);
  // data-ghost-audio 插槽的 <audio> 实体(宿主文档,按 url 去重复用——srcDoc
  // 重载/主题切换重建 UI 时同一实体接续播放,进度不断);binds = 每个 url 当前
  // 这版文档的事件解绑器(重注入前先解旧绑,防僵尸监听刷已死 DOM);
  // unregs = 互斥总线注销器。全部在组件卸载时统一收口。
  const audioMapRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioBindsRef = useRef<Map<string, () => void>>(new Map());
  const audioUnregsRef = useRef<(() => void)[]>([]);
  // 实测内容高:height 只当首帧初始值,图片全部加载后按 scrollHeight 权威
  // 实测覆盖(clamp 同一对常量),并写回卡片库——历史回放直接用准确高度
  // 挂载,零动画(规则 7)。图未到齐期间绝不下调(避免"缩一下再涨"两跳)。
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  // 过渡只给"活卡换海报"用:首帧/历史回放的高度收敛必须瞬时贴合,不做
  // 可见动画;权威实测发生过一次之后的更新(换版)才允许缓动。
  // 两段式置位:权威实测那次 commit 里 settledOnce 必须还是 false(否则
  // transition 与新高度同帧生效,首次收敛就成了 200ms 缓动),所以实测时
  // 只立 pending 标记,等 commit 落地后的 effect 再放开缓动开关。
  const settledOnceRef = useRef(false);
  const pendingSettleRef = useRef(false);
  const renderedCardHtml = running && animatedHtml ? animatedHtml : html;
  const gallerySrcs = useMemo(
    () => extractGhostCardGallerySrcs(renderedCardHtml),
    [renderedCardHtml],
  );

  const measureHeight = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    const body = doc?.body;
    if (!doc || !body) return;
    const h = Math.ceil(body.scrollHeight);
    if (h <= 0) return;
    const clamped = Math.min(GHOST_CARD_HEIGHT_MAX, Math.max(GHOST_CARD_HEIGHT_MIN, h));
    const imagesPending = Array.from(doc.images).some((img) => !img.complete);
    if (imagesPending) {
      // 图未到齐只涨不缩(相对当前生效高度,含声明值):文档刚换时只有文字,
      // 矮测量会把卡压扁再弹回。
      setMeasuredHeight((prev) => (clamped > (prev ?? height) ? clamped : prev));
      return;
    }
    setMeasuredHeight(clamped);
    pendingSettleRef.current = true;
    // 权威实测双写回(fire-and-forget):内存卡片库(本次运行内重挂载即
    // 准确首帧)+ 磁盘(重启后的历史回放)。下次渲染不再经历
    // "声明值 → 实测值"的可见收敛。
    if (Math.abs(clamped - height) > 2) {
      noteCardMeasuredHeight(callId, clamped);
      window.electronAPI?.ghosts?.reportCardHeight?.(callId, clamped)?.catch(() => {});
    }
  }, [callId, height]);

  /** data-ghost-audio 插槽装配:注入标准播放器行 + 双向接线(UI → audio 控制,
   *  audio 事件 → UI 刷新)。同 url 复用同一 <audio>(跨文档重载接续播放)。 */
  const bindAudioSlot = useCallback(
    (slot: HTMLElement, url: string) => {
      let audio = audioMapRef.current.get(url);
      if (!audio) {
        audio = new Audio();
        audio.preload = 'metadata';
        audio.src = url;
        audioMapRef.current.set(url, audio);
        audioUnregsRef.current.push(registerMedia(audio));
      }
      const a = audio;
      // 换文档重绑:先解上一版文档的 audio 监听(旧 render 闭包握着已死 DOM)。
      audioBindsRef.current.get(url)?.();

      const declared = Number(slot.dataset.ghostAudioDuration ?? '');
      const initialDur = Number.isFinite(a.duration) && a.duration > 0
        ? a.duration
        : Number.isFinite(declared) && declared > 0 ? declared : 0;
      slot.innerHTML = buildAudioRowHtml(formatAudioClock(initialDur));
      const btn = slot.querySelector<HTMLButtonElement>('[data-x-play]');
      const curEl = slot.querySelector<HTMLElement>('[data-x-cur]');
      const durEl = slot.querySelector<HTMLElement>('[data-x-dur]');
      const trackEl = slot.querySelector<HTMLElement>('[data-x-track]');
      const fillEl = slot.querySelector<HTMLElement>('[data-x-fill]');
      const dotEl = slot.querySelector<HTMLElement>('[data-x-dot]');
      if (!btn || !curEl || !durEl || !trackEl || !fillEl || !dotEl) return;

      const getDur = (): number =>
        Number.isFinite(a.duration) && a.duration > 0
          ? a.duration
          : Number.isFinite(declared) && declared > 0 ? declared : 0;
      const render = (): void => {
        const d = getDur();
        const pct = d > 0 ? Math.min(100, Math.max(0, (a.currentTime / d) * 100)) : 0;
        fillEl.style.width = `${pct}%`;
        dotEl.style.left = `calc(${pct}% - 5px)`;
        curEl.textContent = formatAudioClock(a.currentTime);
        durEl.textContent = formatAudioClock(d);
        btn.innerHTML = a.paused ? AUDIO_PLAY_SVG : AUDIO_PAUSE_SVG;
        btn.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
      };
      const onEnded = (): void => {
        // 与 ChatAudioCard 同观感:播完回 0:00 待重播。
        a.currentTime = 0;
        render();
      };
      const evs = ['timeupdate', 'loadedmetadata', 'play', 'pause'] as const;
      for (const ev of evs) a.addEventListener(ev, render);
      a.addEventListener('ended', onEnded);
      audioBindsRef.current.set(url, () => {
        for (const ev of evs) a.removeEventListener(ev, render);
        a.removeEventListener('ended', onEnded);
      });

      btn.addEventListener('click', () => {
        // 同 ChatAudioCard:play() 偶发 rejected(多 audio 抢播),吞掉由事件校正。
        if (a.paused) void a.play().catch(() => undefined);
        else a.pause();
      });
      // scrub:click + pointer drag 复用;capture 让拖出插槽仍收 move/up。
      let dragging = false;
      const seekTo = (clientX: number): void => {
        const d = getDur();
        if (!d) return;
        const rect = trackEl.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        a.currentTime = ratio * d;
        render();
      };
      trackEl.addEventListener('pointerdown', (e) => {
        if (!getDur()) return;
        trackEl.setPointerCapture(e.pointerId);
        dragging = true;
        seekTo(e.clientX);
      });
      trackEl.addEventListener('pointermove', (e) => {
        if (dragging) seekTo(e.clientX);
      });
      const endDrag = (e: PointerEvent): void => {
        if (!dragging) return;
        dragging = false;
        if (trackEl.hasPointerCapture(e.pointerId)) trackEl.releasePointerCapture(e.pointerId);
      };
      trackEl.addEventListener('pointerup', endDrag);
      trackEl.addEventListener('pointercancel', endDrag);
      // 右键 → 宿主菜单(打开音频所在目录);坐标换算同图片菜单。
      slot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const f = iframeRef.current?.getBoundingClientRect();
        if (!f) return;
        iframeRef.current?.blur();
        setAudioMenu({ x: f.left + e.clientX, y: f.top + e.clientY, url });
      });
      render();
    },
    [],
  );

  // 组件卸载:解绑 audio 监听、注销互斥总线、停播并释放媒体资源。
  useEffect(
    () => () => {
      audioBindsRef.current.forEach((unbind) => unbind());
      audioBindsRef.current.clear();
      audioUnregsRef.current.forEach((unreg) => unreg());
      audioUnregsRef.current = [];
      audioMapRef.current.forEach((a) => {
        a.pause();
        a.removeAttribute('src');
        a.load();
      });
      audioMapRef.current.clear();
    },
    [],
  );

  // 动作元素上锁(防连点):锁到意识 card-update 换新卡(新文档),或 INFLIGHT
  // 窗口自动解禁(意识没换卡也不卡死)。普通按钮点击与输入面板发送共用。
  const lockActionEl = useCallback((el: HTMLElement) => {
    el.setAttribute('aria-disabled', 'true');
    el.style.opacity = '0.5';
    el.style.pointerEvents = 'none';
    window.setTimeout(() => {
      el.removeAttribute('aria-disabled');
      el.style.opacity = '';
      el.style.pointerEvents = '';
    }, GHOST_CARD_ACTION_INFLIGHT_MS);
  }, []);

  // 点击桥 + 量高:同源 iframe 加载完成后给卡内 cindy-media 图片挂 click,
  // 并在文档就绪/每张图加载后实测内容高。srcDoc 每次变更都触发新 load,
  // 监听器随文档重建,无需清理。
  const attachClickBridge = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    // 与宿主的装饰动画闸门对齐一次:窗口可能在本卡挂载之前就已隐藏,那时闸门的遍历
    // 还看不到这个 iframe。走闸门自己的入口,由它登记进共享的恢复集合 —— 自行 pause
    // 而不登记的话,窗口切回来时统一恢复路径不会 play 它们,这张卡的动画会永久停住。
    alignFrameWithGate(doc);
    const imgs = doc.querySelectorAll<HTMLImageElement>('img[src^="cindy-media://"]');
    let galleryImageIndex = 0;
    imgs.forEach((img) => {
      // 量高写回会让 height prop 变化 → effect 重跑,对同一份未重载的文档
      // 再走到这里;dataset 标记去重,避免重复挂监听(srcDoc 换新文档时
      // 标记随旧文档消亡,自然重挂)。
      if (img.dataset.xdtBridged === '1') return;
      img.dataset.xdtBridged = '1';
      // 生成图整图淡入:未加载完的图先隐藏,等整张解码完成后 250ms 淡入——
      // 大图边解码边绘制会呈现"从上到下刷出来"的打印机观感,这里统一换成
      // "图纸落定"。已加载完的(历史回放/缓存命中)直接显示不做动画,避免
      // 翻历史闪烁;decode 失败(坏图/加载错误)兜底直接显示。一次性过渡、
      // 仅 opacity,非常驻动画(规则 7);减弱动效偏好下跳过过渡瞬时显示。
      if (!img.complete) {
        img.style.opacity = '0';
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          img.style.transition = 'opacity 250ms ease';
        }
        img.decode().catch(() => {}).then(() => {
          img.style.opacity = '1';
        });
      }
      // 图片点击的四级路由:data-ghost-action(动作按钮)> data-ghost-link
      // (外链,均由下面的循环挂)> data-ghost-model(3D 预览 → 应用内 3D
      // 查看器)> 普通看大图 lightbox。
      if (!img.closest('[data-ghost-action], [data-ghost-link]')) {
        img.style.cursor = 'pointer';
        const modelUrl = img.dataset.ghostModel;
        const galleryId = modelUrl
          ? null
          : ghostCardGalleryId(callId, galleryImageIndex++);
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          // 点击发生在 iframe 里,焦点会留在 guest 文档——keydown 不跨文档冒泡,
          // 不挪回宿主的话 Esc/方向键/缩放键都进不了 lightbox(与
          // GhostMediaLightboxHost 同坑同解:blur 掉 iframe,键盘立即归位)。
          iframeRef.current?.blur();
          if (modelUrl) setModelView({ url: modelUrl, poster: img.src });
          else if (galleryId) setLightbox({ src: img.src, galleryId });
        });
      }
      // 右键 → 宿主图片菜单(复制图片 / 打开所在目录,与基座 ChatImageView 同
      // 交互;动作图也给——右键不该触发动作)。事件坐标是 iframe 文档视口系,
      // 加 iframe 自身视口偏移换算成宿主视口坐标(菜单 fixed 定位)。
      img.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const f = iframeRef.current?.getBoundingClientRect();
        if (!f) return;
        iframeRef.current?.blur();
        setImgMenu({ x: f.left + e.clientX, y: f.top + e.clientY, src: img.src });
      });
      // 图片尺寸决定内容高:加载完成(或失败塌陷)都重测一次。
      img.addEventListener('load', measureHeight);
      img.addEventListener('error', measureHeight);
    });
    // data-ghost-audio 播放器插槽:宿主接管渲染与播放(见 bindAudioSlot 顶注)。
    const audioSlots = doc.querySelectorAll<HTMLElement>('div[data-ghost-audio]');
    const presentAudioUrls = new Set<string>();
    audioSlots.forEach((slot) => {
      const url = slot.dataset.ghostAudio ?? '';
      // sanitizer 已白名单校验;此处再验协议一次作纵深(桥只吃 cindy-media)。
      if (!url.startsWith('cindy-media://')) return;
      presentAudioUrls.add(url);
      if (slot.dataset.xdtAudioBridged === '1') return;
      slot.dataset.xdtAudioBridged = '1';
      bindAudioSlot(slot, url);
    });
    // 换稿孤儿收口:意识 card-update 换新文档后,不再有插槽的音频若正在播放,
    // 界面上已无任何控制件——立即暂停(保留实体与进度,url 回归可接续)。
    audioMapRef.current.forEach((a, url) => {
      if (!presentAudioUrls.has(url) && !a.paused) a.pause();
    });
    // 交互卡(v2):data-ghost-action 元素点击 → 宿主受信桥回传 card-action。
    // 卡内零脚本、点击委托全在这里(父层可信上下文,同源 iframe 无 allow-scripts)。
    const actionEls = doc.querySelectorAll<HTMLElement>('[data-ghost-action]');
    actionEls.forEach((el) => {
      if (el.dataset.xdtActionBridged === '1') return;
      el.dataset.xdtActionBridged = '1';
      const actionId = el.dataset.ghostAction ?? '';
      if (!actionId) return;
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // 已锁(点过、等新卡)则忽略连点。
        if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled) return;
        // data-ghost-prompt 类动作:先弹宿主输入框收集文字,发送时才派发
        // (与老基座 imgPrompt popover 同体验;零输入直发会被上游拒)。
        if (el.dataset.ghostPrompt !== undefined) {
          const anchor = anchorRef.current;
          const iframeEl = iframeRef.current;
          if (!anchor || !iframeEl) return;
          // 面板锚在按钮下方:iframe 内坐标 + iframe 相对锚容器偏移;左缘
          // clamp 保证 288px 面板不出卡。焦点先离开 guest 文档(同 lightbox 坑)。
          iframeEl.blur();
          const o = anchor.getBoundingClientRect();
          const f = iframeEl.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          promptSourceElRef.current = el;
          setPromptText('');
          setPromptAsk({
            actionId,
            placeholder: el.dataset.ghostPrompt || '',
            top: f.top - o.top + r.bottom + 6,
            left: Math.max(0, Math.min(f.left - o.left + r.left, Math.max(0, o.width - 292))),
          });
          return;
        }
        lockActionEl(el);
        void window.electronAPI?.ghosts?.dispatchCardAction?.(callId, actionId)?.catch(() => {});
      });
    });
    // 卡内外链(v3):data-ghost-link 元素点击 → 宿主确认框 → openExternal。
    // 净化器已白名单校验(整串 http/https);此处再验协议一次作纵深,并让
    // 动作声明优先(净化器已互斥,同为纵深)。
    // 须声明 card.externalLinks 才激活(未声明的插件属性保留但不挂桥)。
    if (allowExternalLinks) doc.querySelectorAll<HTMLElement>('[data-ghost-link]').forEach((el) => {
      if (el.dataset.xdtLinkBridged === '1') return;
      el.dataset.xdtLinkBridged = '1';
      if (el.dataset.ghostAction) return;
      const url = el.dataset.ghostLink ?? '';
      if (!isGhostCardLinkAllowed(url)) return;
      el.style.cursor = 'pointer';
      if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'link');
      const activateLink = (): void => {
        iframeRef.current?.blur();
        setLinkAsk(url);
      };
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        activateLink();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          activateLink();
        }
      });
    });
    measureHeight();
  }, [measureHeight, callId, lockActionEl, bindAudioSlot, allowExternalLinks]);

  useEffect(() => {
    // srcDoc 更新后 load 事件可能在 effect 前已触发(同进程同步解析),补挂一次。
    // 依赖含 running/animatedHtml:settle 时动画版 → 静态版的换装同样要补挂;
    // 含 themeVars:主题切换重建 srcDoc 后同样要重挂点击桥并重测。
    attachClickBridge();
  }, [html, animatedHtml, running, themeVars, attachClickBridge]);

  // 权威实测的高度提交落地后才放开缓动开关:依赖 measuredHeight = 只在
  // 新高度**已渲染提交**的那次 commit 之后翻闸——若挂在"每次渲染后跑",
  // attachClickBridge effect 内同步实测的路径(文档同步就绪时)会让立标
  // 与翻闸落在同一批 effect 里,首次收敛那帧就带上缓动了。
  useEffect(() => {
    if (pendingSettleRef.current) {
      pendingSettleRef.current = false;
      settledOnceRef.current = true;
    }
  }, [measuredHeight]);

  // 卡片换稿(意识 card-update 新文档)后旧面板的锚点/按钮都失效,直接收起。
  useEffect(() => {
    setPromptAsk(null);
    setImgMenu(null);
    setAudioMenu(null);
    setLinkAsk(null);
  }, [html]);

  /** 图片右键菜单动作(与 ChatImageView 同一对 IPC;cindy-media 地址直用)。 */
  const copyMenuImage = async (): Promise<void> => {
    const src = imgMenu?.src;
    setImgMenu(null);
    if (!src) return;
    const res = await window.electronAPI.copyMediaToClipboard({ url: src });
    if (res.success) toast.success(t('chat.media.imageCopied'));
    else toast.error(res.error ?? t('chat.media.copyFailed'));
  };
  const revealMenuImage = async (): Promise<void> => {
    const src = imgMenu?.src;
    setImgMenu(null);
    if (!src) return;
    const res = await window.electronAPI.showItemInFolder({ url: src });
    if (!res.success) toast.error(res.error ?? t('chat.media.openFolderFailed'));
  };

  /** 外链确认框的醒目域名(URL 已过净化器白名单;解析失败显示空,正文仍有全串)。 */
  const linkAskHost = useMemo(() => {
    if (!linkAsk) return '';
    try {
      return new URL(linkAsk).host;
    } catch {
      return '';
    }
  }, [linkAsk]);

  /** 外链确认:用户点了「打开」→ 经既有受信通道 openExternal(main 再验协议)。 */
  const confirmOpenLink = (): void => {
    const url = linkAsk;
    setLinkAsk(null);
    if (!url) return;
    void window.electronAPI.openExternal(url).then((res) => {
      if (!res.success) toast.error(t('chat.ghostCall.linkOpenFailed'));
    });
  };

  /** 输入面板发送:非空文字 → 锁源按钮 + 派发带 prompt 的 card-action。 */
  const submitPrompt = (): void => {
    const text = promptText.trim();
    if (!text || !promptAsk) return;
    const el = promptSourceElRef.current;
    if (el) lockActionEl(el);
    void window.electronAPI?.ghosts?.dispatchCardAction?.(callId, promptAsk.actionId, text)?.catch(() => {});
    setPromptAsk(null);
    setPromptText('');
  };

  return (
    // 非裁切 relative 锚容器:输入面板 absolute 于此(画布壳 overflow-hidden
    // 会裁面板,面板必须挂在裁切层之外)。
    <div ref={anchorRef} className="relative">
      {/* 画布外壳:只留圆角裁切(全出血海报靠它裁边),无边框/底色/内边距——
          归属由 chip 表达,画布全量归意识,主机不再叠任何主观描边。 */}
      <div className="relative overflow-hidden rounded-[10px]">
        <iframe
          ref={iframeRef}
          sandbox="allow-same-origin"
          srcDoc={buildCardSrcDoc(renderedCardHtml, themeVars)}
          onLoad={attachClickBridge}
          title={ariaTitle}
          className="block w-full border-0"
          style={{
            height: measuredHeight ?? height,
            // iframe 是 replaced element,UA frame chrome 不能指望子文档 reset
            // 覆盖;宿主侧显式清空,避免在圆角裁切处露出白边。
            border: 'none',
            outline: 'none',
            boxShadow: 'none',
            // 首帧/历史回放收敛瞬时贴合;只有活卡换海报(已有过权威实测)才缓动。
            transition: settledOnceRef.current ? 'height 200ms ease' : 'none',
          }}
        />
        {running && !animatedHtml ? (
          // 主机兜底扫光:意识没供动画版(或校验不过)时的统一"确实在动"
          // 信号。斜向光带 transform 平移,alpha 灰双主题通用;
          // pointer-events 穿透,不挡卡内图片点击。
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              className="ghost-card-sweep absolute inset-y-0 left-0 w-2/5"
              style={{
                background:
                  'linear-gradient(100deg, rgba(127,127,127,0) 0%, rgba(160,160,160,0.16) 50%, rgba(127,127,127,0) 100%)',
              }}
            />
          </div>
        ) : null}
      </div>
      {/* iframe 子文档不在宿主 querySelector 范围内。镜像零尺寸标记让既有
          DOM 位置映射仍看到完整顺序，避免相同 URL 的普通附件被错定位到
          插件图片；真正的图片和点击处理仍留在沙箱 iframe 内。 */}
      {gallerySrcs.map((src, imageIndex) => (
        <span
          key={ghostCardGalleryId(callId, imageIndex)}
          hidden
          aria-hidden
          data-gallery-src={src}
        />
      ))}

      {/* ── data-ghost-prompt 输入面板(宿主交互面,与 lightbox 同层;体验与
          老基座 ChatImageActions 的 imgPrompt popover 一致:textarea + 回车
          发送/Esc 取消/点外关闭)。锚在被点按钮下方。 */}
      {promptAsk ? (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setPromptAsk(null)} />
          <div
            className="absolute z-50 w-72 rounded-md border p-2"
            style={{
              top: promptAsk.top,
              left: promptAsk.left,
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-default)',
              boxShadow: 'var(--shadow-menu)',
            }}
          >
            <ListComposerTextarea
              autoFocus
              rows={3}
              value={promptText}
              maxLength={GHOST_CARD_ACTION_PROMPT_MAX_LEN}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                // 中文输入法组词中的 Enter 不能触发发送(同老基座)。
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitPrompt();
                } else if (e.key === 'Escape') {
                  setPromptAsk(null);
                }
              }}
              placeholder={promptAsk.placeholder || t('chat.mivoAction.promptPlaceholder')}
              className="w-full resize-none rounded-md border px-2 py-1.5 text-xs outline-none placeholder:text-[var(--text-tertiary)]"
              style={{
                backgroundColor: 'var(--msg-tool-card-bg)',
                borderColor: 'var(--msg-tool-card-border)',
                color: 'var(--msg-tool-card-text)',
              }}
            />
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setPromptAsk(null)}
                className="h-6 cursor-pointer rounded-md px-2 text-xs transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('chat.mivoAction.promptCancel')}
              </button>
              <button
                type="button"
                onClick={submitPrompt}
                disabled={!promptText.trim()}
                className={
                  'h-6 rounded-md border px-2.5 text-xs font-medium transition-colors ' +
                  (promptText.trim() ? 'cursor-pointer hover:bg-[var(--msg-table-header-bg)]' : 'cursor-not-allowed opacity-40')
                }
                style={{
                  backgroundColor: 'var(--msg-tool-card-bg)',
                  borderColor: 'var(--msg-tool-card-border)',
                  color: 'var(--msg-tool-card-text)',
                }}
              >
                {t('chat.mivoAction.promptSend')}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* ── data-ghost-link 外链确认框(宿主交互面,与输入面板同层级模式:
          遮罩点击/Esc 取消)。域名醒目 + 完整链接全量展示——卡内文案归意识,
          真实去向由宿主如实亮给用户,确认才 openExternal。 */}
      {linkAsk ? (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setLinkAsk(null)} />
          <div
            className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border p-3.5"
            role="alertdialog"
            aria-label={t('chat.ghostCall.linkConfirmTitle')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setLinkAsk(null);
            }}
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-default)',
              boxShadow: 'var(--shadow-menu)',
            }}
          >
            <div className="text-13 font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('chat.ghostCall.linkConfirmTitle')}
            </div>
            <div className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('chat.ghostCall.linkConfirmHint')}
            </div>
            {linkAskHost ? (
              <div
                className="mt-1.5 break-all text-13 font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                {linkAskHost}
              </div>
            ) : null}
            <div
              className="mt-1 max-h-24 overflow-y-auto break-all font-mono text-11 leading-relaxed"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {linkAsk}
            </div>
            <div className="mt-2.5 flex items-center justify-end gap-1.5">
              <button
                type="button"
                autoFocus
                onClick={() => setLinkAsk(null)}
                className="h-6 cursor-pointer rounded-md px-2 text-xs transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('chat.ghostCall.linkConfirmCancel')}
              </button>
              <button
                type="button"
                onClick={confirmOpenLink}
                className="h-6 cursor-pointer rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-[var(--msg-table-header-bg)]"
                style={{
                  backgroundColor: 'var(--msg-tool-card-bg)',
                  borderColor: 'var(--msg-tool-card-border)',
                  color: 'var(--msg-tool-card-text)',
                }}
              >
                {t('chat.ghostCall.linkConfirmOpen')}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* ── 卡内图片右键菜单(宿主交互面;fixed 定位到换算后的视口坐标)── */}
      {imgMenu ? (
        <DropdownMenu open onOpenChange={(open) => { if (!open) setImgMenu(null); }}>
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              data-fixed-menu-anchor
              style={{
                position: 'fixed',
                left: imgMenu.x,
                top: imgMenu.y,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2}>
            <DropdownMenuItem onClick={() => void copyMenuImage()}>
              <Copy className="mr-2 h-4 w-4" />
              {t('chat.media.copyImage')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void revealMenuImage()}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('chat.media.revealImage')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* ── 卡内音频插槽右键菜单(打开音频所在目录;cindy-media 地址直用)── */}
      {audioMenu ? (
        <DropdownMenu open onOpenChange={(open) => { if (!open) setAudioMenu(null); }}>
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              data-fixed-menu-anchor
              style={{
                position: 'fixed',
                left: audioMenu.x,
                top: audioMenu.y,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2}>
            <DropdownMenuItem
              onClick={() => {
                const url = audioMenu.url;
                setAudioMenu(null);
                void window.electronAPI.showItemInFolder({ url }).then((res) => {
                  if (!res.success) toast.error(res.error ?? t('chat.media.openFolderFailed'));
                });
              }}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('chat.media.revealAudio')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {lightbox ? (
        <ImageLightbox
          src={lightbox.src}
          galleryId={lightbox.galleryId}
          enableGallery
          onClose={() => setLightbox(null)}
          sessionId={sessionId}
        />
      ) : null}
      {modelView ? (
        <ModelLightbox
          source={{ kind: 'blob', url: modelView.url, poster: modelView.poster }}
          onClose={() => setModelView(null)}
        />
      ) : null}
    </div>
  );
}

export function GhostToolCard({
  callId,
  ghostId,
  toolName,
  toolInput,
  html,
  animatedHtml,
  height,
  running,
  sessionId,
}: {
  /** 卡片键(管子 callId;权威实测高写回卡片库用)。 */
  callId: string;
  ghostId: string;
  /** 该次 ghost_call 的意识侧工具名(toolInput.tool;仅展示)。 */
  toolName: string;
  /** 原始调用参数(头带展开区展示;工具行并入卡片后审计层在此)。 */
  toolInput: unknown;
  /** 主机净化后的卡片正文(静态版)。 */
  html: string;
  /** 意识自绘动画版(keyframes 已过白名单校验;仅 running 时装进画布)。 */
  animatedHtml?: string;
  /** 渲染高度(供片声明或历史权威实测;主机已 clamp)。 */
  height: number;
  running: boolean;
  sessionId?: string;
}): ReactNode {
  const { t } = useTranslation();
  const installedGhosts = useInstalledGhosts();
  const ghost = installedGhosts.find((g) => g.manifest.id === ghostId);
  const name = ghost?.manifest.name ?? ghostId;
  const icon = ghost?.iconDataUrl ?? null;
  // 主机主题变量块(白名单 token → :root):注进 srcDoc 头部,意识可选用
  // var(--xxx) 跟主题。主题切换时该串变化 → srcDoc 变化 → iframe 重载。
  const themeVars = useGhostCardThemeVars();
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const paramsJson = useMemo(() => {
    try {
      return JSON.stringify(toolInput ?? {}, null, 2);
    } catch {
      return String(toolInput);
    }
  }, [toolInput]);

  // 衍生卡(card-action spawn 的新卡位,`<根>::sp<序>`):按前缀归组,堆叠
  // 渲染在母画布下方——母卡原封不动,MJ 抽卡式反复点。store bump 即重算。
  const cardSnapshot = useSyncExternalStore(subscribeGhostCards, getGhostCardSnapshot);
  const spawnCards = useMemo(
    () => listSpawnCards(callId),
    // version 是 store 的变更计数,充当重算信号。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [callId, cardSnapshot.version],
  );
  // 意识声明 state:'working' 的常驻过程卡(生成类跨调用刷进度):即使调用已
  // settle(running prop 已灭)也保持运行观感——动画继续播、chip 转圈。
  // 终版推送(state done / 未声明)会整卡换新,自然回归静态。
  const ownEntry = cardSnapshot.byCallId.get(callId);
  const ownWorking = ownEntry?.status === 'ready' && ownEntry.state === 'working';
  const effectiveRunning = running || ownWorking;

  const ariaTitle = t('chat.ghostCall.cardAria', { name, tool: toolName });

  return (
    <div
      className="flex flex-col"
      style={{ maxWidth: CARD_MAX_WIDTH }}
      aria-label={ariaTitle}
    >
      {/* ── 归属小 chip(主机唯一主观渲染;意识不可触)──────────────────
          收敛自旧整宽身份 bar:只留"这块内容由某意识渲染"的信任签名——幽灵
          印记 + 意识名 + 运行/完成小状态点 + 展开箭头。点 chip 展开原始调用
          参数(审计透明层,与旧 bar 同一承诺)。chip 以下整块交给意识画布。 */}
      <button
        type="button"
        className="mb-2 flex max-w-full cursor-pointer items-center gap-1.5 self-start rounded-full border px-2 py-0.5 text-left"
        style={{ backgroundColor: 'var(--surface-chip)', borderColor: 'var(--border-default)' }}
        onClick={(e) => {
          // 展开是"就地看详情":先通知消息流跳过本次高度变化的贴底跟随
          // (否则贴底时 pin-to-bottom 会把头部顶上去,看起来像往上展开)。
          e.currentTarget.dispatchEvent(new CustomEvent(CARD_EXPAND_TOGGLE_EVENT, { bubbles: true }));
          setParamsExpanded((v) => !v);
        }}
        aria-expanded={paramsExpanded}
        aria-label={t('chat.ghostCall.cardParams')}
      >
        <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center overflow-hidden rounded-full">
          {icon ? (
            <img src={icon} alt="" className="h-full w-full object-cover" />
          ) : (
            <Ghost size={11} style={{ color: 'var(--text-secondary)' }} />
          )}
        </span>
        <span className="min-w-0 truncate text-11 font-medium" style={{ color: 'var(--text-secondary)' }}>
          {name}
        </span>
        <span className="flex h-3.5 w-3.5 items-center justify-center">
          {effectiveRunning ? (
            // 规则 7:常驻动画挂 HTML wrapper 的 transform,仅 running/working 挂载。
            <span
              className="inline-flex animate-spin motion-reduce:animate-none"
              title={t('chat.ghostCall.cardRunning')}
            >
              <Loader2 size={11} style={{ color: 'var(--text-tertiary)' }} />
            </span>
          ) : (
            <Check size={11} style={{ color: 'var(--text-tertiary)' }} aria-label={t('chat.ghostCall.cardDone')} />
          )}
        </span>
        <ChevronDown
          size={11}
          style={{
            color: 'var(--text-tertiary)',
            transform: paramsExpanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        />
      </button>

      {/* ── 调用参数展开区(主机绘制;audit 层,意识摸不到)──────────── */}
      {paramsExpanded ? (
        <div
          className="mb-1 rounded-[8px] border px-3 py-2"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-default)' }}
        >
          {toolName ? (
            <div
              className="mb-1 inline-block rounded px-1.5 py-px font-mono text-10"
              style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
            >
              {toolName}
            </div>
          ) : null}
          <div
            className="mb-1 text-10 font-medium tracking-[0.5px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {t('chat.ghostCall.cardParams')}
          </div>
          <pre
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {paramsJson}
          </pre>
        </div>
      ) : null}

      {/* ── 母卡画布 ─────────────────────────────────────────────────── */}
      <GhostCardCanvas
        callId={callId}
        html={html}
        animatedHtml={animatedHtml}
        height={height}
        running={effectiveRunning}
        themeVars={themeVars}
        ariaTitle={ariaTitle}
        sessionId={sessionId}
        allowExternalLinks={ghost?.manifest.card?.externalLinks}
      />

      {/* ── 衍生卡(card-action 触发的新结果;母卡保留,可反复抽卡)────────
          每张是视觉独立的新卡片:间距拉开 + 精简归属 chip(无参数展开),
          state:'working' 的过程态卡带运行状态点 + 画布扫光。 */}
      {spawnCards.map((s) => {
        const spawnRunning = s.entry.state === 'working';
        return (
          <div key={s.callId} className="mt-2.5 flex flex-col">
            <div
              className="mb-2 flex max-w-full items-center gap-1.5 self-start rounded-full border px-2 py-0.5"
              style={{ backgroundColor: 'var(--surface-chip)', borderColor: 'var(--border-default)' }}
            >
              <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center overflow-hidden rounded-full">
                {icon ? (
                  <img src={icon} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Ghost size={11} style={{ color: 'var(--text-secondary)' }} />
                )}
              </span>
              <span className="min-w-0 truncate text-11 font-medium" style={{ color: 'var(--text-secondary)' }}>
                {name}
              </span>
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {spawnRunning ? (
                  // 规则 7:常驻动画挂 HTML wrapper 的 transform,仅 working 挂载。
                  <span
                    className="inline-flex animate-spin motion-reduce:animate-none"
                    title={t('chat.ghostCall.cardRunning')}
                  >
                    <Loader2 size={11} style={{ color: 'var(--text-tertiary)' }} />
                  </span>
                ) : (
                  <Check size={11} style={{ color: 'var(--text-tertiary)' }} aria-label={t('chat.ghostCall.cardDone')} />
                )}
              </span>
            </div>
            <GhostCardCanvas
              callId={s.callId}
              html={s.entry.html}
              animatedHtml={s.entry.animatedHtml}
              height={s.entry.height}
              running={spawnRunning}
              themeVars={themeVars}
              ariaTitle={ariaTitle}
              sessionId={sessionId}
              allowExternalLinks={ghost?.manifest.card?.externalLinks}
            />
          </div>
        );
      })}
    </div>
  );
}
