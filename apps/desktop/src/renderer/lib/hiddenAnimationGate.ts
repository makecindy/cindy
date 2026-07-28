/**
 * 隐藏期装饰动画闸门 —— 窗口对用户不可见时冻结常驻 infinite 装饰动画。
 *
 * 背景:主窗 `backgroundThrottling` 默认开着,但 bootstrap-electron 的
 * `setMainWindowBackgroundThrottlingForActiveTurn` 在有 running turn 时会主动
 * 关掉它(保证 agent 流式输出与 IPC 不被后台降频)。副作用是:挂着一批 agent 跑、
 * 人切去别的应用时,隐藏窗口里的无限循环装饰动画仍在全速推进并持续触发样式重算。
 *
 * 实测(2026-07-27,ABAB 四轮配对,低负载环境):10 个常驻动画令样式重算 29.8/s,
 * 暂停后降到 5.7/s(-81%),该 renderer 进程 CPU 12.4% → 6.0%。动画数随运行中的
 * 会话数线性增长(22 个动画时实测差值 40.2/s),会话越多代价越高。
 *
 * ## 为什么要两路信号
 *
 * 单靠 `document.visibilityState` 不行:Electron 规定 `backgroundThrottling` 关闭时
 * visibilityState 会一直停在 `'visible'`,即便窗口已最小化或 hide()。而本模块要救的
 * 正是「有 running turn(节流被关) + 人切走」这个场景,只认 visibilityState 等于永远
 * 不触发。已在 Electron 41.2.0 / macOS 实测复现:
 *
 *   backgroundThrottling=true   minimize()/hide() → visibilityState 转 'hidden'  ✅
 *   backgroundThrottling=false  minimize()/hide() → visibilityState 仍 'visible' ❌
 *
 * 所以再接一路 main 侧广播(`onWindowHiddenChange`,基于 BrowserWindow 的
 * hide/show/minimize/restore 事件),两路取「或」:
 *
 *   - main 广播:不受节流影响,覆盖最小化与 hide;
 *   - visibilityState:覆盖 macOS 的窗口遮挡(occlusion)——那个没有对应的 Electron
 *     事件,只能靠它。
 *
 * 已知局限:Windows 的窗口遮挡两路都盖不到(Electron 文档写明 occlusion 只在 macOS
 * 影响可见性)。此时表现为「不冻结」,即退回改动前的行为,不会误冻可见窗口。
 *
 * 只认可见性,不认 focus —— 副屏场景下窗口失焦但仍然可见,按失焦暂停会被用户直接
 * 看到。
 *
 * ## 两种暂停手段
 *
 * - **宿主文档**:翻 `documentElement` 上的 `data-app-hidden`,由 globals.css 的冻结
 *   清单接管。声明式覆盖,隐藏期间新挂载的元素自动纳入;清单只列 infinite 装饰动画,
 *   一次性动画刻意不进,免得被冻在中途帧。
 * - **Ghost 卡片 srcDoc iframe**:CSS 跨不进子文档,且卡内动画是意识现画的、没有可枚举
 *   清单,只能走 Web Animations API 逐个判 `iterations === Infinity`(见
 *   `syncFrameAnimations`)。用 JS 而非往 srcDoc 注一条通配 CSS,正是为了保住上面那条
 *   「不冻一次性动画」的性质。
 */
/**
 * 冻结标记的属性名。单一来源:CSS(globals.css 的冻结清单、GhostToolCard 注入进 srcDoc 的
 * 规则)与 JS(本模块、iframe 传播、卡片 onLoad 对齐)必须用同一个名字,分散写字面量迟早
 * 漏改。CSS 侧没法 import 常量,由 hiddenAnimationGate.test.ts 断言两边一致。
 */
export const HIDDEN_ANIMATION_ATTR = 'data-app-hidden';

const HIDDEN_ATTR = HIDDEN_ANIMATION_ATTR;

/** 存放 disposer 的槽位:本模块自有的私有约定,不在 lib.dom 的 Window 声明里。 */
interface GateWindow {
  __xdtHiddenAnimationGateDisposer?: () => void;
  /**
   * 最近一次 main 广播的窗口隐藏态。必须跨重装存活:preload 的 createIpcFanOut 不会向
   * 新订阅者回放最后一次 payload,而 HMR 重装时页面没有重新加载、也就不会触发 main 侧
   * did-finish-load 的补发。不缓存的话,「窗口已隐藏 + 节流关闭(visibilityState 恒为
   * visible)」时重装,闸门会一直等不到下一次 hide/minimize 而静默失效。
   */
  __xdtHiddenAnimationGateLastHidden?: boolean;
  /**
   * 本闸门暂停过的子文档动画。挂在 window 上而非闭包里,因为隐藏期间新挂载的卡片要在
   * 自己的 onLoad 里登记进来(见 alignFrameWithGate)——不登记的话恢复路径不会 play 它们,
   * 卡片动画会永久停住。同时跨重装存活,理由同 LastHidden。
   */
  __xdtHiddenAnimationGatePausedAnims?: Set<GateAnimation>;
  /** main 侧窗口可见性广播;非 Electron 宿主(单测 / 纯浏览器)下缺省。 */
  electronAPI?: {
    onWindowHiddenChange?: (callback: (hidden: boolean) => void) => () => void;
  };
}

/** 注入面,让单测能用假 document/visibilityState/IPC 驱动。 */
export interface HiddenAnimationGateTarget {
  document: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    readonly visibilityState: DocumentVisibilityState;
    readonly documentElement: Pick<Element, 'setAttribute' | 'removeAttribute'>;
    /** 用于把冻结标记传播进同源子文档(Ghost 卡片的 srcDoc iframe)。 */
    querySelectorAll?: (selectors: string) => ArrayLike<HiddenAnimationGateFrame>;
  };
  window: GateWindow;
}

/** 子文档里一个动画的最小面(Web Animations API 的子集)。 */
export interface GateAnimation {
  readonly playState?: string;
  effect?: { getTiming?: () => { iterations?: number } } | null;
  pause?: () => void;
  play?: () => void;
}

/** iframe 的最小面:同源子文档 + 其动画清单。 */
export interface HiddenAnimationGateFrame {
  readonly contentDocument?: {
    getAnimations?: () => ArrayLike<GateAnimation>;
  } | null;
}

/** 判断一个动画是不是无限循环。 */
export function isLoopingAnimation(anim: GateAnimation): boolean {
  return anim.effect?.getTiming?.()?.iterations === Infinity;
}

/** 子文档的最小面:只需要能列出自己的动画。 */
export interface GateFrameDocument {
  getAnimations?: () => ArrayLike<GateAnimation>;
}

/**
 * 让一个刚加载完的子文档跟上当前闸门状态 —— 供 Ghost 卡片在 iframe onLoad 时调用。
 *
 * 窗口可能在这张卡挂载之前就已隐藏,那时闸门的遍历还看不到这个 iframe。**关键是必须把
 * 暂停的动画登记进闸门的共享集合**:恢复路径只 play 集合里的,漏登记 = 这张卡的动画永久
 * 停住(窗口切回来也不动)。所以这里不自己维护记账,直接复用 window 上那份。
 *
 * 只停无限循环的;有限动画照播 —— 冻在中途帧、恢复时才接着播才是突兀的那种。
 */
export function alignFrameWithGate(
  frameDoc: GateFrameDocument,
  hostDocument: Pick<Document, 'documentElement'> = document,
  hostWindow: GateWindow = window as Window & GateWindow,
): void {
  if (!hostDocument.documentElement.hasAttribute(HIDDEN_ATTR)) return;
  const paused = (hostWindow.__xdtHiddenAnimationGatePausedAnims ??= new Set<GateAnimation>());
  for (const anim of Array.from(frameDoc.getAnimations?.() ?? [])) {
    if (anim.playState !== 'running' || !isLoopingAnimation(anim)) continue;
    anim.pause?.();
    paused.add(anim);
  }
}

/**
 * 把冻结同步进同源子文档(Ghost 卡片的 srcDoc iframe)。
 *
 * Ghost 卡片是 `sandbox="allow-same-origin"` 的 srcDoc iframe,CSS 选择器跨不进去,而
 * cardSanitizer 明确保留意识作者写的动画,所以隐藏期间这些卡片会继续吃渲染。
 *
 * 这里走 Web Animations API 而不是像宿主侧那样注一条 CSS 规则:CSS 选不出「只暂停无限
 * 循环动画」——`animation-play-state` 加在通配选择器上会把有限动画一并冻住,而
 * cardSanitizer 是允许 `animation:f 1s` 这类有限声明的。被冻在中途的有限动画会在窗口
 * 恢复可见时突然从暂停帧接着播,正是宿主侧 allowlist 刻意规避的那种突兀感。
 * `getAnimations()` 能逐个读 timing,精确只停 `iterations === Infinity` 的。
 *
 * 恢复时只 play 本闸门暂停过的那些,不动意识自己 pause 的动画 —— 调用方传入 paused 集合
 * 承担这份记账。跨源 iframe 读 contentDocument 会抛,逐个吞掉即可。
 */
export function syncFrameAnimations(
  doc: HiddenAnimationGateTarget['document'],
  hidden: boolean,
  pausedByGate: Set<GateAnimation>,
): void {
  const frames = doc.querySelectorAll?.('iframe');
  if (!frames) return;
  for (let i = 0; i < frames.length; i++) {
    try {
      const anims = frames[i]?.contentDocument?.getAnimations?.();
      if (!anims) continue;
      for (let j = 0; j < anims.length; j++) {
        const anim = anims[j];
        if (!anim) continue;
        if (hidden) {
          if (anim.playState !== 'running' || !isLoopingAnimation(anim)) continue;
          anim.pause?.();
          pausedByGate.add(anim);
        } else if (pausedByGate.has(anim)) {
          anim.play?.();
          pausedByGate.delete(anim);
        }
      }
    } catch {
      // 跨源 / 已卸载的 frame:跳过
    }
  }
  // 解冻时清账:已卸载的卡片对应的动画对象不会再出现在任何 frame 里。
  if (!hidden) pausedByGate.clear();
}

function defaultTarget(): HiddenAnimationGateTarget {
  return { document, window: window as Window & GateWindow };
}

export function installHiddenAnimationGate(
  target: HiddenAnimationGateTarget = defaultTarget(),
): () => void {
  // 重复安装时先拆旧的,避免同一 document 上挂多份监听。
  target.window.__xdtHiddenAnimationGateDisposer?.();

  // main 广播的窗口态。优先复用上一轮缓存(HMR 重装时窗口可能已经是隐藏的,
  // 见 GateWindow 上该字段的注释);首次安装则按「未隐藏」起步 —— 窗口刚建出来就是
  // 可见的,真隐藏了 main 侧 did-finish-load 的补发会立刻纠正。
  let windowHidden = target.window.__xdtHiddenAnimationGateLastHidden ?? false;
  // 本闸门暂停过的子文档动画,解冻时只 play 这些,不动意识自己 pause 的。挂在 window 上
  // 共享:隐藏期间新挂载的卡片走 alignFrameWithGate 往同一份集合里登记。
  const pausedFrameAnimations = (target.window.__xdtHiddenAnimationGatePausedAnims ??=
    new Set<GateAnimation>());

  const apply = (): void => {
    const hidden = windowHidden || target.document.visibilityState === 'hidden';
    if (hidden) {
      target.document.documentElement.setAttribute(HIDDEN_ATTR, 'true');
    } else {
      target.document.documentElement.removeAttribute(HIDDEN_ATTR);
    }
    // 已挂载的同源子文档跟着翻。隐藏期间新建的 iframe 由挂载方(GhostToolCard 的
    // onLoad)自己对齐一次,那条路径不经过这里。
    syncFrameAnimations(target.document, hidden, pausedFrameAnimations);
  };

  // 安装时先对齐一次:窗口可能已经处于隐藏态(例如启动后立刻切走)。
  apply();
  target.document.addEventListener('visibilitychange', apply);

  const unsubscribeWindowHidden = target.window.electronAPI?.onWindowHiddenChange?.((hidden) => {
    windowHidden = hidden;
    target.window.__xdtHiddenAnimationGateLastHidden = hidden;
    apply();
  });

  const dispose = (): void => {
    target.document.removeEventListener('visibilitychange', apply);
    unsubscribeWindowHidden?.();
    // 拆闸门时一律恢复动画,不把页面(及子文档)留在冻结态。
    target.document.documentElement.removeAttribute(HIDDEN_ATTR);
    syncFrameAnimations(target.document, false, pausedFrameAnimations);
    if (target.window.__xdtHiddenAnimationGateDisposer === dispose) {
      delete target.window.__xdtHiddenAnimationGateDisposer;
    }
  };

  target.window.__xdtHiddenAnimationGateDisposer = dispose;
  return dispose;
}
