import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import 'harmonyos-sans-sc-webfont-splitted';

import '@/i18n';
import './themes/colors';
import './styles/globals.css';

import { ScreenshotErrorBoundary } from './features/region-screenshot/ScreenshotErrorBoundary';
import { RegionScreenshotOverlay } from './features/region-screenshot/RegionScreenshotOverlay';
import type { RegionScreenshotOverlayBridge } from './features/region-screenshot/bridge';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';

/** 全局框选截图浮层入口 (隐藏预热, 每次截图由 main 推送会话)。 */
document.documentElement.dataset.platform = window.electronAPI.platform;
// Scrolling leaves the source region transparent while the original overlay
// owns only its outline, thumbnail and actions.
const imageEditor = !!window.regionScreenshotEditor;
if (!imageEditor) {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
}
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());

const rootElement = document.getElementById('root');
let editorToken: string | null = null;
const editor = window.regionScreenshotEditor;
const bridge: RegionScreenshotOverlayBridge | undefined = editor ? {
  ...editor,
  onBegin: (callback) => editor.onBegin((payload) => { editorToken = payload.token; callback(payload); }),
  onEnd: (callback) => editor.onEnd(() => { editorToken = null; callback(); }),
  abandon: () => { if (editorToken) editor.cancel(editorToken); },
  // Rendering adapters only: none of these unused capture capabilities cross preload.
  onClear: () => () => {}, focused: () => {}, selectionStarted: () => {}, copyText: () => {},
  elementsAt: async () => [], autoScroll: async () => false, restoreEditor: async () => false,
  holdCapture: async () => {}, startLive: async () => null, liveFrame: async () => null, saveRecording: async () => false,
  recordingControls: async () => null, previewRecording: async () => false,
} : window.regionScreenshot;
if (!rootElement || !bridge) throw new Error('Missing region screenshot root or bridge');

createRoot(rootElement).render(
  <ScreenshotErrorBoundary onFailure={() => editor ? editor.failed() : bridge.abandon()}>
    <RegionScreenshotOverlay bridge={bridge} imageEditor={imageEditor} />
  </ScreenshotErrorBoundary>,
);
