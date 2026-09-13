/**
 * 区域截图(capture-region 快捷键)的 IPC 契约 — main / preload / renderer 共用。
 *
 * renderer → main "调起系统区域截图, 把 PNG 字节返回给我"。捕获必须发生在
 * main: 选区 UI 由 macOS 系统的 /usr/sbin/screencapture -i 提供(spawn 子进程
 * 是 main 的能力)。成功时 main 同时把图片写入系统剪贴板(其它 composer 可
 * 直接 ⌘V), renderer 拿到字节后合并进当前目标草稿。
 */
export const SCREEN_CAPTURE_REGION_CHANNEL = 'screen-capture:region';

/**
 * renderer → main(send): 主区当前路由是否存在截图目标 composer。webview guest
 * 的快捷键转发(main/webview-security)以此决定要不要拦截按键 —— 无目标路由上
 * 拦了也无事发生, 反而吞掉网页对该组合键的原生处理(review P2)。MainLayout 的
 * 全局消费端在挂载与路由变化时上报。
 */
export const SCREEN_CAPTURE_TARGET_AVAILABLE_CHANNEL = 'screen-capture:target-available';

/**
 * 覆盖层配色(win/linux): renderer 在触发瞬间解析当前主题语义 token 的计算值
 * 随 invoke 传入 —— 覆盖层是 main 自生成页面, 不加载 renderer 的主题 CSS 变量,
 * 传"解析后的值"让 Light/Dark 与自定义主题 override 都自然生效(DESIGN.md
 * 双模式门槛)。main 侧逐字段做严格色值格式校验, 非法则回退内置默认。
 */
export interface ScreenCaptureOverlayPalette {
  /** 未选区/选区外遮罩 — token `--overlay-modal`。 */
  scrim: string;
  /** 选框描边 — token `--region-capture-selection-border`。 */
  selectionBorder: string;
  /** 尺寸标签/提示条底色 — token `--tooltip-bg`。 */
  pillBg: string;
  /** 尺寸标签/提示条文字 — token `--tooltip-text`。 */
  pillFg: string;
}

export interface ScreenCaptureRegionResult {
  ok: true;
  /**
   * 用户取消选区(Esc), 或已有一次选区进行中被去重时为 true — 都不算错误,
   * renderer 静默返回即可。
   */
  cancelled: boolean;
  /** PNG 字节(cancelled 为 false 时存在)。Buffer 跨 IPC 到 renderer 是 Uint8Array。 */
  data?: Uint8Array;
}

// ── win/linux 自绘选区覆盖层的通道 ──
// darwin 走系统 screencapture -i, 无覆盖层。流程: main 用 desktopCapturer
// 冻结光标所在显示器 → 开全屏覆盖层窗口(main 自生成 HTML 经 data: URL 加载,
// 专用最小 preload regionCaptureOverlayPreload 只暴露 ready/init/result)展示
// 冻结帧 → 用户拖框/Esc → 覆盖层经 result 通道回报 → main 运行时校验 payload
// 后按 scaleFactor 裁剪出 PNG。提示条文案由 renderer 随 region invoke 的
// { overlayHint } 传入(i18n 在 renderer 侧)。

/** overlay → main: 覆盖层 React 组件挂载完成、已订阅 init —— main 收到后再发
 *  冻结帧, 避免 did-finish-load 与组件异步挂载间的发送竞态(先发必丢)。 */
export const SCREEN_CAPTURE_OVERLAY_READY_CHANNEL = 'screen-capture:overlay-ready';
/** main → overlay: 冻结帧与选区坐标系初始化。 */
export const SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL = 'screen-capture:overlay-init';
/** overlay → main: 冻结帧 <img> 已解码完成(load 事件) —— main 此后才 show()
 *  覆盖层窗口, 避免大分辨率帧解码期间先闪出全屏纯黑窗口(review P2)。 */
export const SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL = 'screen-capture:overlay-content-ready';
/** overlay → main: 选区结果(main 侧校验 sender 必须是覆盖层窗口本体)。 */
export const SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL = 'screen-capture:overlay-result';

export interface ScreenCaptureOverlayInitPayload {
  /** 冻结屏幕帧(光标所在显示器, 像素分辨率)的 data:image/png URL。 */
  imageDataUrl: string;
  /** 覆盖层窗口的 DIP 尺寸 —— 选区 rect 的坐标系。 */
  displaySize: { width: number; height: number };
}

/** 选区 rect: 覆盖层窗口内 DIP 坐标。 */
export interface ScreenCaptureOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenCaptureOverlayResult =
  | { kind: 'cancel' }
  | { kind: 'select'; rect: ScreenCaptureOverlayRect };
