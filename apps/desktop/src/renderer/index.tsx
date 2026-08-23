/**
 * Renderer 模块图分发入口。
 *
 * 资源用量窗口、右侧栏独立子窗口与主应用共用同一个受信任 HTML/origin，
 * 但从这里开始加载不同的模块图。判断必须发生在任何主应用静态依赖之前，
 * 否则 ESM 会先执行语音、诊断和设置初始化。
 */

const urlParams = new URLSearchParams(window.location.search);
const isResourceUsageWindow = urlParams.get('resourceUsageWindow') === '1';
const isSidebarWindow = urlParams.get('sidebarWindow') === '1';
const ghostPanelWindowId = urlParams.get('ghostPanelWindow');

void (isResourceUsageWindow
  ? import('./resource-usage-entry')
  : isSidebarWindow
    ? import('./sidebar-window-entry')
    : ghostPanelWindowId
      ? import('./ghost-panel-window-entry')
      : import('./main-entry')
).catch((error: unknown) => {
  // 入口加载失败发生在 React boundary 之前，仍通过统一 renderer logger 落盘。
  window.electronAPI?.logToMain?.(
    'error',
    'renderer/entry',
    `renderer entry load failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
