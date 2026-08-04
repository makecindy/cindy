/**
 * browserComment — RSB 内置浏览器「页面评论」功能的 guest ↔ host 消息契约。
 *
 * 功能对齐 Codex desktop 的 "Comment on the page"(反编译 comment-preload.js /
 * browser-sidebar-runtime-* 消息集,2026-07-08 核对):进入评论模式后在页面里
 * 点选元素 → 宿主侧弹评论输入气泡 → 提交时截一张带蓝色 marker 的页面截图,
 * 连同元素元数据一起进 composer 草稿。
 *
 * 通信通道(均为 webview tag 层,不经 ipcMain):
 *  - host → guest:`webview.send(channel, payload)`,guest preload 里
 *    `ipcRenderer.on(channel, ...)` 接收。
 *  - guest → host:`ipcRenderer.sendToHost(channel, payload)`,host renderer 在
 *    webview DOM 节点上监听 `ipc-message` 事件、按 `event.channel` 分发。
 *
 * 本文件同时被 renderer(BrowserTabBody / useBrowserComment)与 guest preload
 * (browserCommentPreload.ts)引用,保持单一来源。
 */

// ── host → guest ───────────────────────────────────────────────────────────

/** 进入评论模式:guest 挂交互层(hover 高亮 + 点选)。payload: {@link BrowserCommentEnterModePayload} */
export const BROWSER_COMMENT_ENTER_MODE_CHANNEL = 'browser-comment:enter-mode';
/** 退出评论模式:guest 拆除全部 overlay DOM 与监听器。无 payload。 */
export const BROWSER_COMMENT_EXIT_MODE_CHANNEL = 'browser-comment:exit-mode';
/** 取消当前 pending 选择:移除 marker,回到点选状态(评论模式保持)。无 payload。 */
export const BROWSER_COMMENT_CANCEL_PENDING_CHANNEL = 'browser-comment:cancel-pending';
/**
 * 截图前置:guest 隐藏交互层与 hover 高亮,只保留蓝色 marker(含已提交的常驻
 * marker)与当前 pending 的区域框 / 文本高亮,并继续保留透明 blocker 隔离
 * 页面输入。页面完成两帧渲染后,guest 通过统一的
 * {@link BROWSER_COMMENT_COMMAND_RESULT_CHANNEL} 回执当前 requestId；host
 * 收到 matching ACK 后再调 main capturePage,保证截图里只有标注、没有可见
 * 交互 UI。
 */
export const BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL = 'browser-comment:prepare-screenshot';
/**
 * 提交成功后的收尾(Phase 2 多评论):pending marker 转为常驻(区域框 / 文本
 * 高亮撤除,只留编号圆点),交互层恢复,继续点选下一条。payload:
 * {@link BrowserCommentCommitPendingPayload}(带下一条评论的 marker 编号)。
 */
export const BROWSER_COMMENT_COMMIT_PENDING_CHANNEL = 'browser-comment:commit-pending';
/**
 * 样式实时预览(Phase 3 styling feedback):host 气泡样式编辑器每次变更把
 * **全量当前编辑状态**发给 guest,guest 以 inline !important 应用到 pending
 * 元素上并记录原值(apply-only 语义 —— 单项回退由 host 发 baseline 值实现,
 * 整体还原走 design-reset / cancel / exit)。payload:
 * {@link BrowserCommentDesignPreviewPayload}。
 */
export const BROWSER_COMMENT_DESIGN_PREVIEW_CHANNEL = 'browser-comment:design-preview';
/** 还原当前 pending 元素上的全部样式预览(host 气泡「重置」按钮)。无 payload。 */
export const BROWSER_COMMENT_DESIGN_RESET_CHANNEL = 'browser-comment:design-reset';

// ── guest → host ───────────────────────────────────────────────────────────

/**
 * 关键 host → guest 命令的统一完成回执。host 只在收到当前 WebView 代际发回的
 * matching requestId 后推进评论状态机，避免 `webview.send()` 丢失时两端状态分叉。
 */
export const BROWSER_COMMENT_COMMAND_RESULT_CHANNEL = 'browser-comment:command-result';
/** 用户在页面里点选了一个元素。payload: {@link BrowserCommentTargetInfo} */
export const BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL = 'browser-comment:element-selected';
/** guest 侧主动退出评论模式(用户在页面里按 Esc)。无 payload。 */
export const BROWSER_COMMENT_MODE_EXITED_CHANNEL = 'browser-comment:mode-exited';

// ── payload 类型 ────────────────────────────────────────────────────────────

/** 需要确认完成的 host → guest 命令集合。高频样式预览仍走无回执通知。 */
export type BrowserCommentCommandChannel =
  | typeof BROWSER_COMMENT_ENTER_MODE_CHANNEL
  | typeof BROWSER_COMMENT_EXIT_MODE_CHANNEL
  | typeof BROWSER_COMMENT_CANCEL_PENDING_CHANNEL
  | typeof BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL
  | typeof BROWSER_COMMENT_COMMIT_PENDING_CHANNEL;

/** host 包裹关键命令的传输信封；requestId 在单个评论控制器生命周期内唯一。 */
export interface BrowserCommentCommandEnvelope<T = unknown> {
  requestId: string;
  payload?: T;
}

/** guest 执行关键命令后的统一结果；不把第三方页面异常细节跨边界返回 host。 */
export interface BrowserCommentCommandResult {
  requestId: string;
  command: BrowserCommentCommandChannel;
  ok: boolean;
}

/** host → guest enter-mode 的参数。 */
export interface BrowserCommentEnterModePayload {
  /**
   * 本条评论的 marker 编号(1 起)。由 host 根据当前 composer 草稿里已有的
   * `## Comment N` 块数决定,guest 只负责把数字画进蓝色圆点。
   */
  markerNumber: number;
}

/** host → guest commit-pending 的参数。 */
export interface BrowserCommentCommitPendingPayload {
  /** 下一条评论的 marker 编号(host 在草稿写入后重新按 max+1 推得)。 */
  nextMarkerNumber: number;
}

/**
 * host → guest prepare-screenshot 的参数(截图前对账)。
 *
 * 常驻 marker 与 composer 里的评论 chip 生命周期独立(chip 可被单删 / 清空 /
 * 随发送清草稿,且这些都是 silent 草稿写入,无法事件通知到 guest)——截图是
 * marker 状态唯一进入记录(附件 + prompt)的时刻,在这里以草稿现存编号为
 * 白名单剪除失效 marker,保证截图里不出现没有对应 `## Comment N` 块的
 * 孤儿 / 重号 marker。
 */
export interface BrowserCommentPrepareScreenshotPayload {
  /** 草稿中仍存在的评论 marker 编号(pending 中的当前编号无需包含)。 */
  validMarkerNumbers: number[];
}

/** 评论标注类型:元素点选 / Shift 拖拽框选区域 / 页面文本选区。 */
export type BrowserCommentKind = 'element' | 'region' | 'text';

/**
 * 样式编辑器暴露的属性集(Phase 3 curated set)—— guest 采集 baseline、host
 * 渲染控件、序列化输出三方共用同一份清单。刻意收窄到高频视觉调整项,不做
 * 全量 CSS 面板(那是 DevTools 的活)。
 */
export const BROWSER_COMMENT_DESIGN_PROPS = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'padding',
  'border-radius',
] as const;
export type BrowserCommentDesignProp = (typeof BROWSER_COMMENT_DESIGN_PROPS)[number];

/**
 * 选中元素时 guest 采集的样式编辑基线(仅 kind=element 提供)。
 * 所有值同属不可信页面数据。
 */
export interface BrowserCommentDesignBaseline {
  /** curated 属性的 computed 值(如 `rgb(38, 38, 38)` / `14px`)。 */
  styles: Record<string, string>;
  /**
   * 元素的纯文本内容(无任何子元素时才提供,否则 null)—— 文本改写预览会
   * 直接写 textContent,有子元素时这么做会毁结构,故不提供。
   */
  editableText: string | null;
  /**
   * 样式归属(best-effort):curated 属性 → 拥有它的 CSS 规则描述
   * (`selector .btn-primary, https://…/app.css`)。跨域样式表读不到
   * cssRules 的直接跳过;取不到的属性不出现在 map 里。
   */
  provenance: Record<string, string>;
}

/** host 气泡样式编辑器 → guest 的实时预览 payload(全量当前编辑状态)。 */
export interface BrowserCommentDesignPreviewPayload {
  /** 要应用的属性值(仅含被用户改过的项;值为 CSS 字面量)。 */
  styles: Record<string, string>;
  /** 文本改写(null = 未改文本)。 */
  text: string | null;
}

/** 提交时随评论落草稿的单项样式变更(previousValue 来自 baseline)。 */
export interface BrowserCommentStyleChange {
  /** CSS 属性名,或特殊值 `text content`(文本改写)。 */
  property: string;
  previousValue: string;
  value: string;
}

/**
 * guest 点选元素后采集上报的目标信息。字段集合对齐 Codex 的浏览器评论
 * 序列化格式(Target / Target role / Target selector / Target path /
 * Nearby text / Node position / App theme)。
 *
 * 所有字段都来自不可信网页,host 序列化进 prompt 时必须置于
 * "Untrusted page evidence" 标记之下(见 renderer/lib/browserComments)。
 */
export interface BrowserCommentTargetInfo {
  /** 标注类型。element = 点选;region = Shift 框选;text = 进入模式时已有文本选区。 */
  kind: BrowserCommentKind;
  /** 锚点位置(点击点 / 框选释放点 / 选区末端),guest viewport CSS 像素坐标。 */
  point: { x: number; y: number };
  /** guest viewport 尺寸(CSS 像素)。 */
  viewport: { width: number; height: number };
  /** kind=region 时的框选矩形(viewport CSS 像素);其它 kind 为 null。 */
  region: { x: number; y: number; width: number; height: number } | null;
  /** kind=text 时的选区文本(归一化空白 + 截断);其它 kind 为 null。 */
  selectedText: string | null;
  /**
   * Cmd(mac)/ Ctrl(win)+ 点击的「立即添加」:host 跳过评论输入气泡,直接以
   * 空评论文本走提交流程(只留标注 + 截图,用户回 composer 再补话)。
   */
  immediate: boolean;
  /** 目标元素 tag 名(小写,如 `div` / `button`);region 或取不到为 null。
   *  composer 评论 chip 的预览徽标用(对齐 Codex 预览卡的 tag 徽标)。 */
  targetTag: string | null;
  /** 元素可访问名(aria-label / alt / title / 文本内容等,截断后),取不到为 null。 */
  targetLabel: string | null;
  /** 显式 role 属性或常见标签的隐式 role,取不到为 null。 */
  targetRole: string | null;
  /** 尽量唯一的 CSS selector(id 优先,否则 tag/class/nth-of-type 组合),null = 无稳定 selector。 */
  targetSelector: string | null;
  /** DOM 祖先链路径(`html > body > div > button:nth-of-type(2)` 形式,封顶若干层)。 */
  targetPath: string | null;
  /** 目标附近的可见文本(就近块级祖先 innerText,归一化空白后截断)。 */
  nearbyText: string | null;
  /** 页面明暗(按背景色亮度推断),推断失败为 null。 */
  themeVariant: 'light' | 'dark' | null;
  /** 样式编辑基线(Phase 3;仅 kind=element 且采集成功时非 null)。 */
  designBaseline: BrowserCommentDesignBaseline | null;
  /** 与 enter-mode 下发一致的 marker 编号,回传用于 host 侧对账。 */
  markerNumber: number;
}
