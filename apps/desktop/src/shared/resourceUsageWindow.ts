/**
 * 资源用量独立子窗口的跨进程共享契约。
 *
 * 与 rightSidebarWindow 不同：资源用量窗口是纯本机数据视图，不需要
 * session 上下文转发，也不需要命令路由。除 open/close 外，仅保留首次
 * 真实内容完成绘制后的 ready 握手。
 */

/** renderer → main(invoke)：幂等打开窗口（已开则 show + focus）。 */
export const RESOURCE_USAGE_WINDOW_OPEN_CHANNEL = 'resource-usage-window:open';
/** renderer → main(invoke)：用户主动关窗。 */
export const RESOURCE_USAGE_WINDOW_CLOSE_CHANNEL = 'resource-usage-window:close';
/** renderer → main(invoke)：轻量窗口根组件已经挂载，可以安全展示表格壳。 */
export const RESOURCE_USAGE_WINDOW_RENDERER_READY_CHANNEL =
  'resource-usage-window:renderer-ready';
/** renderer → main(invoke)：首份进程快照已经提交；隐藏预热可以停止后台采样。 */
export const RESOURCE_USAGE_WINDOW_PRESENTATION_READY_CHANNEL =
  'resource-usage-window:presentation-ready';
/** main → renderer(send)：控制资源采样；隐藏窗口只保留最后一份快照，不持续轮询。 */
export const RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL =
  'resource-usage-window:sampling-active';
/** main → renderer(send)：主窗口语言偏好变化时同步已预热的资源窗口。 */
export const RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL =
  'resource-usage-window:locale-changed';
