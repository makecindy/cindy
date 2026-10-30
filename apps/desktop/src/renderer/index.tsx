/**
 * Renderer 模块图分发入口。
 *
 * 资源用量窗口、右侧栏独立子窗口、截图浮层 / 贴图与主应用共用同一个受信任
 * HTML/origin，但从这里开始加载不同的模块图。判断必须发生在任何主应用静态依赖
 * 之前，否则 ESM 会先执行语音、诊断和设置初始化。
 */

const urlParams = new URLSearchParams(window.location.search);
const isRecordingPreview = urlParams.get('recordingPreview') === '1';
const isRemoteDesktopViewer = urlParams.get('remoteDesktopViewer') === '1';
const isResourceUsageWindow = urlParams.get('resourceUsageWindow') === '1';
const isSidebarWindow = urlParams.get('sidebarWindow') === '1';
const isRegionScreenshot = urlParams.get('regionScreenshot') === '1';
const isRegionScreenshotEditor = urlParams.get('regionScreenshotEditor') === '1';
const isRegionScreenshotPin = urlParams.get('regionScreenshotPin') === '1';

void (isRecordingPreview
  ? import('./recording-preview-entry')
  : isRemoteDesktopViewer
  ? import('./remote-desktop-viewer-entry')
  : isResourceUsageWindow
  ? import('./resource-usage-entry')
  : isSidebarWindow
    ? import('./sidebar-window-entry')
    : isRegionScreenshot
      ? import('./region-screenshot-entry')
      : isRegionScreenshotEditor
        ? import('./region-screenshot-entry')
        : isRegionScreenshotPin
          ? import('./region-screenshot-pin-entry')
          : import('./main-entry')
).catch((error: unknown) => {
  // 入口加载失败发生在 React boundary 之前，仍通过统一 renderer logger 落盘。
  window.electronAPI?.logToMain?.(
    'error',
    'renderer/entry',
    `renderer entry load failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
