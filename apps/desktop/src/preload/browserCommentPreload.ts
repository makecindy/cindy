/**
 * browserCommentPreload —— RSB 内置浏览器 `<webview>` 的 guest 注入层(页面评论)。
 *
 * 由 main 的 webview hardener 在 `will-attach-webview` 时强制注入(renderer 传什么
 * 都不信,见 webview-security.ts),随每个 guest 页面加载。设计约束:
 *
 *  1. **默认完全休眠**:加载时只注册 ipcRenderer 监听,不碰 DOM、不加事件监听,
 *     对任意第三方页面零开销、零副作用。只有 host 发 enter-mode 才挂交互层。
 *  2. **零依赖**:只用 `electron` 的 ipcRenderer 与 DOM API。不 import 任何
 *     带依赖的模块(打包为 CJS 单文件随 app.asar 分发,拉进原生依赖会炸 unpack)。
 *  3. **样式隔离**:overlay 挂在 Shadow DOM(closed root)里,第三方页面的 CSS
 *     影响不到我们、我们也不污染页面;宿主容器只有定位属性 + 最大 z-index。
 *  4. **对话方向**:host → guest 走 `webview.send()`(ipcRenderer.on 接收),
 *     guest → host 走 `ipcRenderer.sendToHost()`(host 侧 webview `ipc-message`)。
 *
 * 交互模型(对齐 Codex "Comment on the page",Phase 2 全量):
 *  - 点击 = 选元素;Shift + 拖拽 = 框选区域;进入模式时页面已有文本选区 = 文本评论。
 *  - Cmd(mac)/ Ctrl(win)+ 点击 / 释放 = 「立即添加」(host 跳过输入气泡)。
 *  - 提交成功后 host 发 commit-pending:pending marker 转常驻、编号推进,可连续
 *    标注多条;marker / 区域框 / 文本高亮都锚定**文档坐标**,随页面滚动。
 *  - prepare-screenshot 隐藏交互 UI 只留标注 → host 截图 → commit / cancel。
 *
 * 采集的所有信息都来自不可信网页,host 序列化时负责加 untrusted 标记。
 */

import { ipcRenderer } from 'electron';

import {
  BROWSER_COMMENT_CANCEL_PENDING_CHANNEL,
  BROWSER_COMMENT_COMMAND_RESULT_CHANNEL,
  BROWSER_COMMENT_COMMIT_PENDING_CHANNEL,
  BROWSER_COMMENT_DESIGN_PREVIEW_CHANNEL,
  BROWSER_COMMENT_DESIGN_PROPS,
  BROWSER_COMMENT_DESIGN_RESET_CHANNEL,
  BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
  BROWSER_COMMENT_ENTER_MODE_CHANNEL,
  BROWSER_COMMENT_EXIT_MODE_CHANNEL,
  BROWSER_COMMENT_MODE_EXITED_CHANNEL,
  BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
  type BrowserCommentCommandChannel,
  type BrowserCommentCommandEnvelope,
  type BrowserCommentCommandResult,
  type BrowserCommentCommitPendingPayload,
  type BrowserCommentDesignBaseline,
  type BrowserCommentDesignPreviewPayload,
  type BrowserCommentEnterModePayload,
  type BrowserCommentKind,
  type BrowserCommentPrepareScreenshotPayload,
  type BrowserCommentTargetInfo,
} from '../shared/browserComment';

/** marker / 高亮用的蓝 —— 语义豁免色(与 app 的 --focus-ring 同族),guest 页面
 *  拿不到宿主 CSS 变量,只能字面量。 */
const ACCENT = '#3b82f6';
/** 覆盖第三方页面所有内容的 z-index(int32 上限,Codex overlay 同款量级)。 */
const Z_MAX = '2147483647';
/** 框选拖拽小于该边长(px)视为误触,当次拖拽作废。 */
const MIN_REGION_SIZE = 8;
/** 文本选区上报的最大长度。 */
const MAX_SELECTED_TEXT = 600;

/** pending 选择的可视元素集合(commit 时只留 marker,cancel 时整组撤)。 */
interface PendingVisual {
  kind: BrowserCommentKind;
  /** 本条选择的 marker 编号(establishPending 时从 state.markerNumber 冻结)。 */
  number: number;
  /** 编号圆点(文档坐标层)。 */
  marker: HTMLDivElement;
  /** 区域框 / 文本高亮块(文档坐标层),commit 后移除。 */
  extras: HTMLDivElement[];
  /** 点选的页面元素(kind=element 时非 null),样式预览的应用目标。 */
  el: HTMLElement | null;
}

// ── 样式预览簿记(Phase 3 styling feedback)────────────────────────────────
// 预览以 inline !important 写在页面元素上;这里记录原 inline 值用于还原。
// pending 组随 cancel / design-reset 还原;commit 后转入 committed 组(预览
// 保留在页面上,与截图所见一致);exit-mode 时全部还原,页面回到原样。

interface AppliedStyleRecord {
  el: HTMLElement;
  property: string;
  originalValue: string;
  originalPriority: string;
  /** 归属的评论 marker 编号;commit 时打上,pending 期为空。截图前对账剪除用。 */
  markerNumber?: number;
}
interface AppliedTextRecord {
  el: HTMLElement;
  originalText: string;
  /** 同 AppliedStyleRecord.markerNumber。 */
  markerNumber?: number;
}

let pendingStyleRecords: AppliedStyleRecord[] = [];
let pendingTextRecord: AppliedTextRecord | null = null;
let committedStyleRecords: AppliedStyleRecord[] = [];
let committedTextRecords: AppliedTextRecord[] = [];

function revertStyleRecord(r: AppliedStyleRecord): void {
  try {
    if (r.originalValue) {
      r.el.style.setProperty(r.property, r.originalValue, r.originalPriority);
    } else {
      r.el.style.removeProperty(r.property);
    }
  } catch {
    // 元素可能已被页面脚本移除,还原失败无害。
  }
}

function revertPendingDesign(): void {
  for (const r of pendingStyleRecords) revertStyleRecord(r);
  pendingStyleRecords = [];
  if (pendingTextRecord) {
    try {
      pendingTextRecord.el.textContent = pendingTextRecord.originalText;
    } catch {
      // see revertStyleRecord
    }
    pendingTextRecord = null;
  }
}

function revertAllDesign(): void {
  revertPendingDesign();
  // 逆序还原:同一 el+property 被跨条评论多次预览时,后一条 commit 读到的
  // originalValue 已是前一条的中间预览值(committed 预览一直留在页面上),只有
  // 最早那条记录持有真实基线。逆序回放让最早记录最后写回,最终落在真基线上;
  // 顺序回放会先写真基线、再被中间预览覆盖,导致退出评论模式后页面残留改动。
  // 不重叠的记录逆序回放结果不变,安全。
  for (let i = committedStyleRecords.length - 1; i >= 0; i--) {
    revertStyleRecord(committedStyleRecords[i]);
  }
  committedStyleRecords = [];
  for (let i = committedTextRecords.length - 1; i >= 0; i--) {
    const t = committedTextRecords[i];
    try {
      t.el.textContent = t.originalText;
    } catch {
      // see revertStyleRecord
    }
  }
  committedTextRecords = [];
}

/**
 * 截图前对账的设计预览侧(与常驻 marker 剪除同刻):归属已删除评论(编号不在
 * 白名单)的 committed 样式 / 文本预览必须一并处理,否则截图会展示一个 prompt
 * 里已无对应块的 requested annotation 效果。
 *
 * 同一 el+property 被多条评论先后预览时不能直接回退视觉 —— 当前页面值归最新
 * 存活的那条所有;此时做**原值链拼接**:把被剪记录的 originalValue 转交给
 * 后继(下一条存活的 committed 记录,或当前 pending 记录),保证最终 exit /
 * 后继被剪时仍能一路还原到真实基线。无后继才真正回退视觉。
 */
function pruneCommittedDesignForInvalidMarkers(valid: Set<number>): void {
  // ── 样式:按 (el, property) 分组,组内沿原值链 oldest → newest 单次遍历 ──
  // 链不变量:后一条记录的 originalValue == 前一条的应用值,只有组内最老记录
  // 持有真实基线。多条失效记录必须以"失效连续段"为单位处理:carry 只取段内
  // **最老一条**的 original(段内其余记录的 original 是中间预览值,直接丢),
  // 转交给段后的第一条存活记录;链尾无人接(组内其后全失效且无 pending)才
  // 以 carry 回退视觉。逐条转交 / 逐条回退都会破链(多条失效时后者覆盖前者
  // 转交的基线,或把中间预览值写回页面)。
  const styleGroups = new Map<HTMLElement, Map<string, AppliedStyleRecord[]>>();
  for (const r of committedStyleRecords) {
    let byProp = styleGroups.get(r.el);
    if (!byProp) {
      byProp = new Map();
      styleGroups.set(r.el, byProp);
    }
    const group = byProp.get(r.property) ?? [];
    group.push(r);
    byProp.set(r.property, group);
  }
  for (const [el, byProp] of styleGroups) {
    for (const [property, group] of byProp) {
      let carry: { value: string; priority: string } | null = null;
      for (const r of group) {
        const invalid = r.markerNumber !== undefined && !valid.has(r.markerNumber);
        if (!invalid) {
          if (carry) {
            r.originalValue = carry.value;
            r.originalPriority = carry.priority;
            carry = null;
          }
          continue;
        }
        if (!carry) carry = { value: r.originalValue, priority: r.originalPriority };
      }
      if (carry) {
        const pending = pendingStyleRecords.find(
          (s) => s.el === el && s.property === property,
        );
        if (pending) {
          pending.originalValue = carry.value;
          pending.originalPriority = carry.priority;
        } else {
          revertStyleRecord({
            el,
            property,
            originalValue: carry.value,
            originalPriority: carry.priority,
          });
        }
      }
    }
  }
  committedStyleRecords = committedStyleRecords.filter(
    (r) => r.markerNumber === undefined || valid.has(r.markerNumber),
  );

  // ── 文本:同法,按 el 分组(每元素同刻至多一条 pending)──
  const textGroups = new Map<HTMLElement, AppliedTextRecord[]>();
  for (const t of committedTextRecords) {
    const group = textGroups.get(t.el) ?? [];
    group.push(t);
    textGroups.set(t.el, group);
  }
  for (const [el, group] of textGroups) {
    let carry: string | null = null;
    for (const t of group) {
      const invalid = t.markerNumber !== undefined && !valid.has(t.markerNumber);
      if (!invalid) {
        if (carry !== null) {
          t.originalText = carry;
          carry = null;
        }
        continue;
      }
      if (carry === null) carry = t.originalText;
    }
    if (carry !== null) {
      if (pendingTextRecord && pendingTextRecord.el === el) {
        pendingTextRecord.originalText = carry;
      } else {
        try {
          el.textContent = carry;
        } catch {
          // see revertStyleRecord
        }
      }
    }
  }
  committedTextRecords = committedTextRecords.filter(
    (t) => t.markerNumber === undefined || valid.has(t.markerNumber),
  );
}

/**
 * 允许预览写入的 CSS 属性白名单。preload 注入到任意第三方页面,setProperty 又带
 * !important,即便正常情况下 payload 只由宿主受控控件产生,这里仍按 curated 属性做
 * 防御性收口——渲染进程一旦被攻陷也无法借该通道对页面写入白名单外的任意样式。
 */
const DESIGN_PROP_ALLOWLIST: ReadonlySet<string> = new Set(BROWSER_COMMENT_DESIGN_PROPS);

/**
 * 应用 host 发来的全量预览状态:payload 里没有的已预览属性先还原(用户把
 * 控件改回了基线),再逐项应用 / 刷新;文本同理。
 */
function applyDesignPreview(payload: BrowserCommentDesignPreviewPayload): void {
  const el = state?.pending?.el;
  if (!el) return;
  const styles = payload?.styles ?? {};
  // 还原本次 payload 不再包含的属性。
  pendingStyleRecords = pendingStyleRecords.filter((r) => {
    if (r.property in styles) return true;
    revertStyleRecord(r);
    return false;
  });
  for (const [property, value] of Object.entries(styles)) {
    if (typeof value !== 'string') continue;
    // 白名单外属性直接忽略(见 DESIGN_PROP_ALLOWLIST 注释)。
    if (!DESIGN_PROP_ALLOWLIST.has(property)) continue;
    if (!pendingStyleRecords.some((r) => r.property === property)) {
      pendingStyleRecords.push({
        el,
        property,
        originalValue: el.style.getPropertyValue(property),
        originalPriority: el.style.getPropertyPriority(property),
      });
    }
    try {
      // !important 保证预览压过页面自身规则;还原时按记录的原值 / 原优先级写回。
      el.style.setProperty(property, value, 'important');
    } catch {
      // 非法值直接忽略(host 侧控件基本保证合法,这里防御)。
    }
  }
  const text = typeof payload?.text === 'string' ? payload.text : null;
  if (text === null) {
    if (pendingTextRecord) {
      try {
        pendingTextRecord.el.textContent = pendingTextRecord.originalText;
      } catch {
        // see revertStyleRecord
      }
      pendingTextRecord = null;
    }
  } else {
    if (!pendingTextRecord) {
      pendingTextRecord = { el, originalText: el.textContent ?? '' };
    }
    el.textContent = text;
  }
}

/**
 * 评论模式 overlay 的全部可变状态。单例(top frame only —— webview 未开
 * nodeIntegrationInSubFrames,preload 只在主 frame 跑)。
 */
interface OverlayState {
  /** 宿主容器(document.documentElement 直挂,Shadow root 载体)。 */
  container: HTMLDivElement;
  shadow: ShadowRoot;
  /** 全屏透明层,接管鼠标事件(页面在评论模式下不响应 hover / click)。 */
  blocker: HTMLDivElement;
  /** hover 高亮框(viewport 坐标,绝对定位描边)。 */
  highlight: HTMLDivElement;
  /** 框选拖拽中的临时矩形(viewport 坐标)。 */
  dragRect: HTMLDivElement;
  /**
   * 文档坐标层:marker / 区域框 / 文本高亮挂这里,子元素用文档绝对坐标定位,
   * 层整体 translate(-scrollX, -scrollY) 跟随滚动(compositor-only transform)。
   */
  docLayer: HTMLDivElement;
  /** 当前(下一条)评论的 marker 编号。 */
  markerNumber: number;
  /** 当前 hover 命中的页面元素(blocker 之下)。 */
  hoverTarget: Element | null;
  /** 待 host 提交 / 取消的 pending 选择;null = 点选中。 */
  pending: PendingVisual | null;
  /**
   * 已提交(commit-pending)的常驻 marker 登记(编号 → 元素)。截图前对账用:
   * composer 里 chip 被删 / 清空后,host 随 prepare-screenshot 下发现存编号
   * 白名单,不在名单里的常驻 marker 在截图前剪除。
   */
  committedMarkers: Array<{ number: number; marker: HTMLDivElement }>;
  /** Shift 拖拽状态(mousedown 起点);null = 未在拖拽。 */
  drag: { startX: number; startY: number; moved: boolean } | null;
  cleanupFns: Array<() => void>;
}

let state: OverlayState | null = null;

// ── DOM 构建 ────────────────────────────────────────────────────────────────

function buildOverlay(markerNumber: number): OverlayState {
  const container = document.createElement('div');
  // 定位上下文 + 不参与页面布局。pointer-events 由内部各层自己控制。
  container.style.cssText = `position:fixed;inset:0;z-index:${Z_MAX};pointer-events:none;`;
  const shadow = container.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .blocker {
      position: fixed; inset: 0;
      pointer-events: auto;
      cursor: crosshair;
      background: transparent;
    }
    .highlight, .drag-rect {
      position: fixed;
      display: none;
      pointer-events: none;
      border: 2px solid ${ACCENT};
      border-radius: 2px;
      background: rgba(59, 130, 246, 0.08);
      box-sizing: border-box;
    }
    .doc-layer {
      position: fixed; left: 0; top: 0;
      width: 0; height: 0;
      overflow: visible;
      pointer-events: none;
      will-change: transform;
    }
    .marker {
      position: absolute;
      pointer-events: none;
      width: 22px; height: 22px;
      margin: -11px 0 0 -11px;
      border-radius: 50%;
      background: ${ACCENT};
      color: #fff;
      /* 原为 font: 600 12px/22px … shorthand。拆分成 longhand 后必须显式补回
         shorthand 的隐式重置:本样式注入第三方页面的 Shadow DOM,下列字体属性
         全部可从宿主 host 继承(italic / small-caps 改字形,variation 的 wght 轴
         可整体改粗细,feature/kerning/size-adjust 改字宽与实际字号),shorthand
         时代它们被隐式归回初始值,拆分后需逐项手动锁死(红队评审二轮补全)。 */
      font-style: normal;
      font-variant: normal;
      font-stretch: normal;
      font-kerning: auto;
      font-feature-settings: normal;
      font-variation-settings: normal;
      font-optical-sizing: auto;
      font-size-adjust: none;
      font-weight: 600;
      font-size: 12px;
      line-height: 22px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      text-align: center;
      box-shadow: 0 0 0 2px #fff, 0 1px 4px rgba(0,0,0,0.35);
    }
    .region-box {
      position: absolute;
      pointer-events: none;
      border: 2px solid ${ACCENT};
      border-radius: 2px;
      background: rgba(59, 130, 246, 0.08);
      box-sizing: border-box;
    }
    .text-box {
      position: absolute;
      pointer-events: none;
      background: rgba(59, 130, 246, 0.28);
      border-radius: 2px;
    }
  `;
  const blocker = document.createElement('div');
  blocker.className = 'blocker';
  const highlight = document.createElement('div');
  highlight.className = 'highlight';
  const dragRect = document.createElement('div');
  dragRect.className = 'drag-rect';
  const docLayer = document.createElement('div');
  docLayer.className = 'doc-layer';

  shadow.append(style, blocker, highlight, dragRect, docLayer);
  (document.documentElement ?? document.body).appendChild(container);

  return {
    container,
    shadow,
    blocker,
    highlight,
    dragRect,
    docLayer,
    markerNumber,
    hoverTarget: null,
    pending: null,
    drag: null,
    committedMarkers: [],
    cleanupFns: [],
  };
}

function syncDocLayerScroll(): void {
  if (!state) return;
  state.docLayer.style.transform = `translate(${-window.scrollX}px, ${-window.scrollY}px)`;
}

/** 在文档坐标层放一个编号 marker(docX/docY 为文档坐标)。 */
function placeMarker(docX: number, docY: number, num: number): HTMLDivElement {
  if (!state) throw new Error('no overlay');
  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.textContent = String(num);
  marker.style.left = `${docX}px`;
  marker.style.top = `${docY}px`;
  state.docLayer.appendChild(marker);
  return marker;
}

/** 在文档坐标层放一个矩形(区域框 / 文本高亮),入参为 viewport 坐标。 */
function placeDocBox(
  className: 'region-box' | 'text-box',
  viewportRect: { x: number; y: number; width: number; height: number },
): HTMLDivElement {
  if (!state) throw new Error('no overlay');
  const box = document.createElement('div');
  box.className = className;
  box.style.left = `${viewportRect.x + window.scrollX}px`;
  box.style.top = `${viewportRect.y + window.scrollY}px`;
  box.style.width = `${viewportRect.width}px`;
  box.style.height = `${viewportRect.height}px`;
  state.docLayer.appendChild(box);
  return box;
}

// ── 元素定位与高亮 ──────────────────────────────────────────────────────────

/**
 * 命中归一化(对齐 Codex `Es()`:composedPath 上取第一个 HTMLElement):
 * 命中 SVG 内部节点(path / g / svg)时上溯到最近的 HTML 祖先 —— 用户点按钮
 * 里的图标,语义上选的是"那个按钮"。上溯越过 shadow 边界(host);纯 SVG
 * 文档没有 HTML 祖先,返回 null 由调用方回退原节点。
 */
function nearestHtmlElement(el: Element | null): HTMLElement | null {
  let cur: Node | null = el;
  while (cur) {
    if (cur instanceof HTMLElement) return cur;
    const parent: Node | null = (cur as Element).parentElement ?? cur.parentNode;
    if (parent) {
      cur = parent;
      continue;
    }
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** blocker 之下真正命中的页面元素(过滤掉我们自己的 overlay 容器,并归一化到
 *  最近的 HTMLElement —— hover 高亮、元数据、样式编辑三者共用同一语义)。 */
function pageElementAt(x: number, y: number): Element | null {
  if (!state) return null;
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === state.container || state.container.contains(el)) continue;
    if (el === document.documentElement || el === document.body) return el;
    return nearestHtmlElement(el) ?? el;
  }
  return null;
}

function moveHighlightTo(el: Element | null): void {
  if (!state) return;
  state.hoverTarget = el;
  if (!el) {
    state.highlight.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  const s = state.highlight.style;
  s.display = 'block';
  s.left = `${r.left}px`;
  s.top = `${r.top}px`;
  s.width = `${r.width}px`;
  s.height = `${r.height}px`;
}

// ── 元数据采集 ──────────────────────────────────────────────────────────────

/** 归一化空白 + 截断;空串归 null。 */
function normText(raw: string | null | undefined, max: number): string | null {
  const t = raw?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 可访问名:aria-label → aria-labelledby → alt → title → placeholder → 文本。 */
function accessibleLabel(el: Element): string | null {
  const aria = el.getAttribute('aria-label');
  if (aria) return normText(aria, 80);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const t = normText(parts, 80);
    if (t) return t;
  }
  const alt = el.getAttribute('alt');
  if (alt) return normText(alt, 80);
  const title = el.getAttribute('title');
  if (title) return normText(title, 80);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return normText(placeholder, 80);
  if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit')) {
    return normText(el.value, 80);
  }
  return normText(el.textContent, 80);
}

/** 显式 role 属性,否则常见标签的隐式 ARIA role(简化映射,覆盖高频交互元素)。 */
function elementRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : null;
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'img':
      return 'img';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    default:
      return null;
  }
}

/** 单层 selector 片段:tag(.稳定class 最多 2 个)(:nth-of-type 兄弟去重)。 */
function selectorSegment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let seg = tag;
  const classes = Array.from(el.classList)
    // 过滤明显是构建产物 / 状态类的 class(带 hash、超长、含冒号的 tailwind 变体)。
    .filter((c) => /^[a-zA-Z][\w-]{0,40}$/.test(c) && !/\d{4,}/.test(c))
    .slice(0, 2);
  for (const c of classes) seg += `.${CSS.escape(c)}`;
  const parent = el.parentElement;
  if (parent) {
    const sameTag = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
    if (sameTag.length > 1) {
      seg += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return seg;
}

/**
 * 尽量唯一的 CSS selector:祖先里最近的 id 作根,往下拼 segment;每加一层用
 * querySelectorAll 验唯一,唯一即止。封顶 6 层,拼不唯一就返回目前最好的组合
 * (给模型的是"线索"不是"定位器",不必绝对唯一)。
 */
function buildSelector(el: Element): string | null {
  try {
    const segs: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < 6; depth += 1) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        segs.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      segs.unshift(selectorSegment(cur));
      const candidate = segs.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      cur = cur.parentElement;
      if (cur === document.documentElement) break;
    }
    return segs.length > 0 ? segs.join(' > ') : null;
  } catch {
    return null;
  }
}

/** 纯 tag 祖先链(`html > body > div > button:nth-of-type(2)`),封顶 10 层。 */
function buildPath(el: Element): string | null {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 10; depth += 1) {
    parts.unshift(selectorSegment(cur));
    cur = cur.parentElement;
  }
  if (cur) parts.unshift('…');
  return parts.length > 0 ? parts.join(' > ') : null;
}

/** 目标附近的可见文本:向上找最近的"有非空 innerText 的块级祖先",归一化截断。 */
function nearbyText(el: Element): string | null {
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    if (cur instanceof HTMLElement) {
      const t = normText(cur.innerText, 200);
      if (t) return t;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** 按 body 背景色亮度推断页面明暗;透明 / 解析失败回落 prefers-color-scheme。 */
function themeVariant(): 'light' | 'dark' | null {
  try {
    const bg = getComputedStyle(document.body ?? document.documentElement).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) {
      const alpha = m[4] === undefined ? 1 : Number(m[4]);
      if (alpha > 0.1) {
        // ITU-R BT.709 亮度加权。
        const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
        return lum < 128 ? 'dark' : 'light';
      }
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return null;
  }
}

/** provenance 扫描的规则数上限 —— tailwind 类超大样式表兜底,防选中卡顿。 */
const MAX_PROVENANCE_RULES = 30000;

/**
 * 样式归属(best-effort):遍历同源样式表,找出**匹配该元素且设置了 curated
 * 属性**的规则,后出现的覆盖先出现的(近似 cascade 的 last-wins;不算
 * specificity,给模型的是"该去哪个文件找"的线索,不是精确 cascade 结论)。
 * 跨域样式表读 cssRules 会抛 SecurityError,直接跳过。
 */
function collectProvenance(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  let scanned = 0;
  const visit = (rules: CSSRuleList, sheetHref: string | null): boolean => {
    for (const rule of Array.from(rules)) {
      if (scanned >= MAX_PROVENANCE_RULES) return false;
      scanned += 1;
      if (rule instanceof CSSStyleRule) {
        let matched = false;
        try {
          matched = el.matches(rule.selectorText);
        } catch {
          continue; // 非法 / 不支持的 selector
        }
        if (!matched) continue;
        for (const prop of BROWSER_COMMENT_DESIGN_PROPS) {
          if (rule.style.getPropertyValue(prop)) {
            out[prop] = `selector ${rule.selectorText}${sheetHref ? `, ${sheetHref}` : ''}`;
          }
        }
      } else if (rule instanceof CSSGroupingRule) {
        if (!visit(rule.cssRules, sheetHref)) return false;
      }
    }
    return true;
  };
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域样式表
      }
      if (!visit(rules, sheet.href)) break;
    }
  } catch {
    // styleSheets 本身不可枚举的极端页面,放弃 provenance。
  }
  return out;
}

/** 选中元素的样式编辑基线(仅 element kind;采集失败返回 null,气泡隐藏样式区)。 */
function collectDesignBaseline(el: Element): BrowserCommentDesignBaseline | null {
  try {
    if (!(el instanceof HTMLElement)) return null;
    const cs = getComputedStyle(el);
    const styles: Record<string, string> = {};
    for (const prop of BROWSER_COMMENT_DESIGN_PROPS) {
      styles[prop] = cs.getPropertyValue(prop).trim();
    }
    // 文本改写只对"无任何子元素"的叶子开放 —— textContent 预览不毁结构。
    const editableText =
      el.children.length === 0 ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() || null : null;
    return { styles, editableText, provenance: collectProvenance(el) };
  } catch {
    return null;
  }
}

/** 组装上报 payload;element 相关字段仅在给了 `el` 时采集。 */
function collectTargetInfo(opts: {
  kind: BrowserCommentKind;
  x: number;
  y: number;
  el?: Element | null;
  region?: { x: number; y: number; width: number; height: number } | null;
  selectedText?: string | null;
  immediate: boolean;
}): BrowserCommentTargetInfo {
  const { kind, x, y, el, region, selectedText, immediate } = opts;
  return {
    kind,
    point: { x: Math.round(x), y: Math.round(y) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    region: region
      ? {
          x: Math.round(region.x),
          y: Math.round(region.y),
          width: Math.round(region.width),
          height: Math.round(region.height),
        }
      : null,
    selectedText: selectedText ?? null,
    targetTag: el ? el.tagName.toLowerCase() : null,
    targetLabel: el ? accessibleLabel(el) : null,
    targetRole: el ? elementRole(el) : null,
    targetSelector: el ? buildSelector(el) : null,
    targetPath: el ? buildPath(el) : null,
    nearbyText: el ? nearbyText(el) : null,
    themeVariant: themeVariant(),
    // 样式编辑基线只对元素点选提供(region 无目标元素;text 选区跨多元素)。
    designBaseline: kind === 'element' && el ? collectDesignBaseline(el) : null,
    markerNumber: state?.markerNumber ?? 1,
    immediate,
  };
}

// ── pending 选择的建立 ──────────────────────────────────────────────────────

/** 进入 pending:定住交互(不再 hover / 点选),放 marker + 附加可视,上报 host。
 *  编号在此从 state.markerNumber 冻结进 pending(commit 时登记进常驻对账表)。 */
function establishPending(
  visual: Omit<PendingVisual, 'number'>,
  info: BrowserCommentTargetInfo,
): void {
  if (!state) return;
  state.pending = { ...visual, number: state.markerNumber };
  state.highlight.style.display = 'none';
  state.blocker.style.cursor = 'default';
  ipcRenderer.sendToHost(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, info);
}

/** 元素点选 → pending。 */
function selectElement(el: Element, x: number, y: number, immediate: boolean): void {
  if (!state) return;
  const marker = placeMarker(x + window.scrollX, y + window.scrollY, state.markerNumber);
  establishPending(
    { kind: 'element', marker, extras: [], el: el instanceof HTMLElement ? el : null },
    collectTargetInfo({ kind: 'element', x, y, el, immediate }),
  );
}

/** Shift 框选 → pending(marker 放在释放点)。 */
function selectRegion(
  rect: { x: number; y: number; width: number; height: number },
  releaseX: number,
  releaseY: number,
  immediate: boolean,
): void {
  if (!state) return;
  const box = placeDocBox('region-box', rect);
  const marker = placeMarker(
    releaseX + window.scrollX,
    releaseY + window.scrollY,
    state.markerNumber,
  );
  establishPending(
    { kind: 'region', marker, extras: [box], el: null },
    collectTargetInfo({ kind: 'region', x: releaseX, y: releaseY, region: rect, immediate }),
  );
}

/**
 * 进入模式时页面已有文本选区 → 直接建为 text pending(选中文字高亮 + 末端
 * marker)。用户先选字、再点评论按钮,是文本评论的自然路径。
 */
function trySelectExistingTextSelection(): boolean {
  if (!state) return false;
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const text = normText(sel.toString(), MAX_SELECTED_TEXT);
    if (!text) return false;
    const range = sel.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 1 && r.height > 1,
    );
    if (rects.length === 0) return false;
    const extras = rects
      .slice(0, 50)
      .map((r) => placeDocBox('text-box', { x: r.left, y: r.top, width: r.width, height: r.height }));
    const last = rects[rects.length - 1];
    const x = Math.min(last.right + 4, window.innerWidth - 4);
    const y = last.top + last.height / 2;
    const marker = placeMarker(x + window.scrollX, y + window.scrollY, state.markerNumber);
    // 选区所在元素也采一份定位线索(anchorNode 的最近元素祖先,同样归一化到
    // HTMLElement —— SVG <text> 内选区等场景与点选语义保持一致)。
    const rawAnchorEl =
      sel.anchorNode instanceof Element
        ? sel.anchorNode
        : sel.anchorNode?.parentElement ?? null;
    const anchorEl = nearestHtmlElement(rawAnchorEl) ?? rawAnchorEl;
    establishPending(
      { kind: 'text', marker, extras, el: null },
      collectTargetInfo({ kind: 'text', x, y, el: anchorEl, selectedText: text, immediate: false }),
    );
    return true;
  } catch {
    return false;
  }
}

// ── 模式生命周期 ────────────────────────────────────────────────────────────

function enterMode(payload: BrowserCommentEnterModePayload): void {
  exitMode(); // 幂等:重复 enter 先拆旧的。
  if (!Number.isInteger(payload?.markerNumber) || payload.markerNumber <= 0) {
    throw new Error('invalid marker number');
  }
  const markerNumber = payload.markerNumber;
  state = buildOverlay(markerNumber);
  const s = state;
  syncDocLayerScroll();

  const onMouseDown = (e: MouseEvent) => {
    if (s.pending) return;
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    s.drag = { startX: e.clientX, startY: e.clientY, moved: false };
    moveHighlightTo(null);
  };
  const onMouseMove = (e: MouseEvent) => {
    if (s.pending) return;
    if (s.drag) {
      const r = dragRectOf(s.drag, e.clientX, e.clientY);
      if (r.width >= MIN_REGION_SIZE || r.height >= MIN_REGION_SIZE) s.drag.moved = true;
      const st = s.dragRect.style;
      st.display = 'block';
      st.left = `${r.x}px`;
      st.top = `${r.y}px`;
      st.width = `${r.width}px`;
      st.height = `${r.height}px`;
      return;
    }
    moveHighlightTo(pageElementAt(e.clientX, e.clientY));
  };
  const onMouseUp = (e: MouseEvent) => {
    if (!s.drag) return;
    const drag = s.drag;
    s.drag = null;
    s.dragRect.style.display = 'none';
    if (!drag.moved) return; // 无位移的 shift+click 走 click 分支(选元素)。
    e.preventDefault();
    e.stopPropagation();
    const r = dragRectOf(drag, e.clientX, e.clientY);
    if (r.width < MIN_REGION_SIZE && r.height < MIN_REGION_SIZE) return;
    selectRegion(r, e.clientX, e.clientY, e.metaKey || e.ctrlKey);
  };
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (s.pending) return;
    const el = s.hoverTarget ?? pageElementAt(e.clientX, e.clientY);
    if (!el) return;
    selectElement(el, e.clientX, e.clientY, e.metaKey || e.ctrlKey);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // pending 时焦点通常在 host 气泡里,这里兜底:pending 态的 Esc 交给 host
    // (气泡的 cancel),guest 只在点选态响应整体退出。
    if (s.pending) return;
    e.preventDefault();
    e.stopPropagation();
    exitMode();
    ipcRenderer.sendToHost(BROWSER_COMMENT_MODE_EXITED_CHANNEL);
  };
  // 滚动:文档坐标层整体位移(常驻 marker / 区域框 / 文本高亮跟随页面);
  // hover 高亮基于 viewport,清掉等下一次 mousemove 重算。
  const onScroll = () => {
    syncDocLayerScroll();
    if (!s.pending && !s.drag) moveHighlightTo(null);
  };

  s.blocker.addEventListener('mousedown', onMouseDown, true);
  s.blocker.addEventListener('mousemove', onMouseMove, true);
  s.blocker.addEventListener('mouseup', onMouseUp, true);
  s.blocker.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  s.cleanupFns.push(() => {
    s.blocker.removeEventListener('mousedown', onMouseDown, true);
    s.blocker.removeEventListener('mousemove', onMouseMove, true);
    s.blocker.removeEventListener('mouseup', onMouseUp, true);
    s.blocker.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
  });

  // 页面已有文本选区 → 直接进入 text pending(host 收到后弹气泡)。
  trySelectExistingTextSelection();
}

function dragRectOf(
  drag: { startX: number; startY: number },
  x: number,
  y: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(drag.startX, x),
    y: Math.min(drag.startY, y),
    width: Math.abs(x - drag.startX),
    height: Math.abs(y - drag.startY),
  };
}

function exitMode(): void {
  if (!state) return;
  // 页面回原样:pending + 已提交的样式预览全部还原(截图早已定格,页面不必
  // 继续背着预览态)。
  revertAllDesign();
  for (const fn of state.cleanupFns) {
    try {
      fn();
    } catch {
      // listener teardown must never throw into the page
    }
  }
  state.container.remove();
  state = null;
}

/** 恢复点选态的 crosshair 与输入拦截(commit / cancel 共用)。 */
function showInteraction(): void {
  if (!state) return;
  state.blocker.style.display = 'block';
  state.blocker.style.cursor = 'crosshair';
}

/**
 * 截图只需要隐藏会留下像素的临时交互反馈。透明 blocker 必须继续接管输入：
 * capture / cache 失败时 host 会保留 pending Popover，若这里释放 pointer events，
 * 底层网页会在评论仍待处理时直接响应点击，造成 host / guest 交互语义分叉。
 */
function hideTransientInteractionVisuals(): void {
  if (!state) return;
  state.highlight.style.display = 'none';
  state.dragRect.style.display = 'none';
}

/** 取消当前 pending:marker 与附加可视整组撤除,样式预览还原,回到点选状态。 */
function cancelPending(): void {
  revertPendingDesign();
  if (!state?.pending) {
    showInteraction();
    return;
  }
  const p = state.pending;
  p.marker.remove();
  for (const el of p.extras) el.remove();
  state.pending = null;
  state.highlight.style.display = 'none';
  showInteraction();
}

/** 提交成功:pending marker 转常驻(附加可视撤除),样式预览转入 committed
 *  组保留在页面上(与截图所见一致),编号推进,继续点选。 */
function commitPending(payload: BrowserCommentCommitPendingPayload): void {
  if (!state?.pending) throw new Error('missing pending comment');
  // 设计预览记录打上归属评论编号:截图前对账时,归属已删除 chip 的预览
  // 要与常驻 marker 一起被剪除 / 还原。
  const commitNumber = state.pending?.number;
  for (const r of pendingStyleRecords) r.markerNumber = commitNumber;
  committedStyleRecords.push(...pendingStyleRecords);
  pendingStyleRecords = [];
  if (pendingTextRecord) {
    pendingTextRecord.markerNumber = commitNumber;
    committedTextRecords.push(pendingTextRecord);
    pendingTextRecord = null;
  }
  const p = state.pending;
  if (p) {
    for (const el of p.extras) el.remove();
    // 常驻 marker 登记编号,供截图前按草稿白名单对账剪除。
    state.committedMarkers.push({ number: p.number, marker: p.marker });
    state.pending = null;
  }
  if (Number.isInteger(payload?.nextMarkerNumber) && payload.nextMarkerNumber > 0) {
    state.markerNumber = payload.nextMarkerNumber;
  } else {
    state.markerNumber += 1;
  }
  state.highlight.style.display = 'none';
  showInteraction();
}

/** 截图前置:隐藏交互 UI,保留有效标注(常驻 marker 先按草稿白名单对账剪除
 *  + pending 组);两帧后回执。 */
async function prepareScreenshot(payload?: BrowserCommentPrepareScreenshotPayload): Promise<void> {
  // 没有 pending 时截图不可能代表 host 正在提交的评论。明确失败，让 host
  // 保留输入并等待用户重试；不能回一张无 marker 的“成功”截图。
  if (!state?.pending) throw new Error('missing pending comment');
  // 对账:composer 里 chip 被单删 / 清空 / 随发送清草稿后,对应常驻 marker
  // 已无 `## Comment N` 块与之对应,截图前剪除,防孤儿 / 重号 marker 入图;
  // 归属这些评论的样式 / 文本预览同步还原(或做原值链拼接),防止截图展示
  // 已删除 requested annotation 的效果。
  if (Array.isArray(payload?.validMarkerNumbers)) {
    const valid = new Set(payload.validMarkerNumbers);
    state.committedMarkers = state.committedMarkers.filter((entry) => {
      if (valid.has(entry.number)) return true;
      entry.marker.remove();
      return false;
    });
    pruneCommittedDesignForInvalidMarkers(valid);
  }
  hideTransientInteractionVisuals();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

// ── 入口:只注册监听,零 DOM 副作用 ─────────────────────────────────────────

/**
 * 注册一条带 request/ack 的关键命令。handler 可以等待动画帧；无论同步异常还是
 * Promise rejection 都只向 host 返回 ok=false，不把不可信页面的错误细节带出去。
 */
function registerCommand<T>(
  command: BrowserCommentCommandChannel,
  handler: (payload: T) => void | Promise<void>,
): void {
  ipcRenderer.on(command, (_e, rawEnvelope) => {
    const envelope = rawEnvelope as BrowserCommentCommandEnvelope<T> | undefined;
    if (!envelope || typeof envelope.requestId !== 'string' || !envelope.requestId) return;
    void Promise.resolve()
      .then(() => handler(envelope.payload as T))
      .then(
        () => {
          const result: BrowserCommentCommandResult = {
            requestId: envelope.requestId,
            command,
            ok: true,
          };
          ipcRenderer.sendToHost(BROWSER_COMMENT_COMMAND_RESULT_CHANNEL, result);
        },
        () => {
          const result: BrowserCommentCommandResult = {
            requestId: envelope.requestId,
            command,
            ok: false,
          };
          ipcRenderer.sendToHost(BROWSER_COMMENT_COMMAND_RESULT_CHANNEL, result);
        },
      );
  });
}

registerCommand<BrowserCommentEnterModePayload>(BROWSER_COMMENT_ENTER_MODE_CHANNEL, enterMode);
registerCommand<void>(BROWSER_COMMENT_EXIT_MODE_CHANNEL, exitMode);
registerCommand<void>(BROWSER_COMMENT_CANCEL_PENDING_CHANNEL, cancelPending);
registerCommand<BrowserCommentCommitPendingPayload>(
  BROWSER_COMMENT_COMMIT_PENDING_CHANNEL,
  commitPending,
);
registerCommand<BrowserCommentPrepareScreenshotPayload | undefined>(
  BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
  prepareScreenshot,
);
ipcRenderer.on(BROWSER_COMMENT_DESIGN_PREVIEW_CHANNEL, (_e, payload) => {
  try {
    applyDesignPreview(payload as BrowserCommentDesignPreviewPayload);
  } catch {
    // see above
  }
});
ipcRenderer.on(BROWSER_COMMENT_DESIGN_RESET_CHANNEL, () => {
  try {
    revertPendingDesign();
  } catch {
    // see above
  }
});
