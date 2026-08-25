import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';

// Registers the `<model-viewer>` custom element globally. Used by
// ModelLightbox to preview mivo-generated 3D models. Side-effect-only
// import — the package self-registers when loaded.
import '@google/model-viewer';

// 在任何 React 组件渲染前先 import 触发 i18next 同步 init —— 否则首屏 useTranslation
// 拿到的会是 fallback 英文文案再瞬切到目标语言，造成可见闪烁。
import '@/i18n';
import './themes/colors';

import { TopLevelErrorBoundary } from './components/error/TopLevelErrorBoundary';
import { initTapdb } from './analytics/tapdbClient';
import { installScrollbarAutoHide } from './lib/scrollbarAutoHide';
import { bootstrapMemorySettingsFromMain } from './lib/memorySettingsStore';
import {
  getVoiceInputSettings,
  migrateLegacyVoiceInputRendererStorage,
  syncVoiceInputGlobalShortcut,
} from './hooks/useVoiceInputSettings';
import { LocaleProvider } from './hooks/useLocale';
import {
  getInitialThemeVariant,
  ThemeProvider,
} from './hooks/useTheme';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { ConfirmDialogProvider } from './components/ui/confirm-dialog-provider';
import { bootstrapChatEmbeddingFromMain } from './lib/chatEmbeddingStore';
import { bootstrapGitSafetySettingsFromMain } from './lib/gitSafetySettingsStore';
import { bootstrapLspModeFromMain } from './lib/lspModeStore';
import { bootstrapSilentEncryptedRetryFromMain } from './lib/silentEncryptedRetryStore';
import { initRsbBrowserBridge } from './features/right-sidebar/lib/rsbBrowserBridge';
import { isGhostPanelWindow } from './lib/ghostPanelWindow';
import { isSecondaryWindow } from './lib/secondaryWindow';
import {
  installForegroundRecoveryDiagnostics,
  installPerformanceTimelineCleanupInterval,
} from './lib/foregroundRecoveryDiagnostics';
import { installRenderLoopWatchdog } from './lib/renderLoopWatchdog';
import { installHiddenAnimationGate } from './lib/hiddenAnimationGate';
import { installInteractionJankProbe } from './lib/interactionJankProbe';
import { installSwallowActivationClick } from './lib/swallowActivationClick';
import { installEarlyKeyDownCapture } from './lib/earlyKeyDownCapture';
import { getSwallowActivationClickEnabled } from './hooks/useSwallowActivationClickSettings';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';
import './styles/globals.css';
import './styles/sortable.css';

const disposeEarlyKeyDownCapture = installEarlyKeyDownCapture();
installScrollbarAutoHide();
const disposeForegroundRecoveryDiagnostics = installForegroundRecoveryDiagnostics();
// 睡醒白屏取证:主线程阻塞漂移 + 可见无帧探针,只记日志(见模块头注释)。
const disposeRenderLoopWatchdog = installRenderLoopWatchdog();
// 隐藏期冻结常驻装饰动画 —— 有 running turn 时 backgroundThrottling 被主动关闭,
// 不加这道闸门,看不见的窗口里动画会继续烧 CPU(见模块头注释)。浮窗同样适用:
// 语音浮窗的 mic 波形也是 infinite 装饰动画。
const disposeHiddenAnimationGate = installHiddenAnimationGate();
// Codex maker 化后, codex 事件流走 makerChatStore 内部的 maker:event 监听器,
// 不再需要专门的 codex progress dispatcher。

migrateLegacyVoiceInputRendererStorage();
void syncVoiceInputGlobalShortcut(getVoiceInputSettings().shortcut);
void bootstrapSilentEncryptedRetryFromMain();
// 对话语义索引开关 —— 先同步 signed-out 镜像；AuthContext 提交稳定 owner 后会切换
// owner 分区并重拉 Main 真值，迟到的启动响应会被 revision fence 丢弃。
void bootstrapChatEmbeddingFromMain();
// LSP Beta 开关 (Phase 1) — admin-only, 默认 false; 同款镜像同步方式。
void bootstrapLspModeFromMain();
// Git safety workflow 开关 — 默认 false; Codex rewind 入口同步依赖此镜像。
void bootstrapGitSafetySettingsFromMain();

const view = new URLSearchParams(window.location.search).get('view');
const isVoiceInputOverlay = view === 'voice-input-overlay';
const isVoiceInputDictionaryToast = view === 'voice-input-dictionary-toast';
const isComputerPermissionGuide = view === 'computer-permission-guide';
const isComputerPermissionBackdrop = view === 'computer-permission-backdrop';
const isComputerPermissionView = isComputerPermissionGuide || isComputerPermissionBackdrop;
const isAppearanceUtilityView =
  isVoiceInputOverlay || isVoiceInputDictionaryToast || isComputerPermissionView;
document.documentElement.dataset.platform = window.electronAPI.platform;
document.documentElement.dataset.windowBackdropMaterial =
  window.electronAPI.windowBackdropMaterial ?? 'none';
const disposeWindowBackdropMaterialChanged =
  window.electronAPI.onWindowBackdropMaterialChanged?.((material) => {
    document.documentElement.dataset.windowBackdropMaterial = material;
  }) ?? (() => {});
import.meta.hot?.dispose(disposeWindowBackdropMaterialChanged);
if (isVoiceInputOverlay || isVoiceInputDictionaryToast) {
  document.documentElement.dataset.voiceInputOverlay = 'true';
}
if (isComputerPermissionView) {
  document.documentElement.dataset.computerPermissionOverlay = 'true';
}

// Windows-only: emulate macOS `acceptFirstMouse: false` so a click that
// activates the window from background doesn't fall through to any in-page
// target. Skip on voice-input overlay windows — those are click-through
// popups (focusable:false, acceptFirstMouse:true by design).
const disposeSwallowActivationClick =
  !isVoiceInputOverlay && !isVoiceInputDictionaryToast && !isComputerPermissionView
    ? installSwallowActivationClick({
        window,
        platform: window.electronAPI?.platform ?? '',
        performanceNow: (): number => performance.now(),
        // 用户偏好每次事件回调都实时读一次 localStorage,toggle 立即生效。
        isEnabled: getSwallowActivationClickEnabled,
      })
    : (): void => {};

// dev-only: React 19 的 development 构建会为每个组件每次 commit 发一条 performance.measure
// (⚛ Components track), 且永不清理。长时间挂着 dev 跑 + 流式聊天高频重渲染会让性能时间线
// 堆到数 GB(堆外存储、GC 回收不掉), 最终把 renderer 撑爆 OOM 自动重载, 循环往复。
// 这里定时清空时间线缓冲兜底: 没有任何业务代码读这些 measure, 清空无副作用。
// production 构建里 react-dom 根本不发这些 measure, 且 import.meta.env.DEV 为 false 整段被
// tree-shake, 故对正式包零影响。
// 注意: 若你正在用 DevTools 的 Performance 面板录制 React profile, 会被这次清空打断 ——
// 录制期间临时把这段注释掉即可。
if (import.meta.env.DEV) {
  const disposePerformanceTimelineCleanupInterval = installPerformanceTimelineCleanupInterval();
  // 交互卡顿探针(诊断用):longtask + Event Timing,只在主视图装,浮窗窗口没有交互归因价值。
  const disposeInteractionJankProbe =
    !isVoiceInputOverlay && !isVoiceInputDictionaryToast ? installInteractionJankProbe() : (): void => {};
  import.meta.hot?.dispose(() => {
    disposeForegroundRecoveryDiagnostics();
    disposeRenderLoopWatchdog();
    disposeHiddenAnimationGate();
    disposeEarlyKeyDownCapture();
    disposePerformanceTimelineCleanupInterval();
    disposeSwallowActivationClick();
    disposeInteractionJankProbe();
  });
}

bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
const disposeUtilityAppearanceSettingsSync = isAppearanceUtilityView
  ? (window.electronAPI.appearanceSettings?.onChanged?.(applyFontSettings) ?? (() => {}))
  : (): void => {};
import.meta.hot?.dispose(disposeUtilityAppearanceSettingsSync);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}
const root = createRoot(rootElement);

void (async () => {
  if (isComputerPermissionBackdrop) {
    const { ComputerPermissionBackdrop } = await import(
      './components/settings/ComputerPermissionGuideWindow'
    );
    root.render(
      <ThemeProvider syncWindowVibrancy={false}>
        <ComputerPermissionBackdrop />
      </ThemeProvider>,
    );
    return;
  }

  if (isComputerPermissionGuide) {
    const { ComputerPermissionGuideWindow } = await import(
      './components/settings/ComputerPermissionGuideWindow'
    );
    root.render(
      <ThemeProvider syncWindowVibrancy={false}>
        <LocaleProvider>
          <ComputerPermissionGuideWindow />
        </LocaleProvider>
      </ThemeProvider>,
    );
    return;
  }

  if (isVoiceInputDictionaryToast) {
    const { VoiceInputDictionaryToast } = await import('./voice-input/VoiceInputDictionaryToast');
    root.render(
      <ThemeProvider syncWindowVibrancy={false}>
        <LocaleProvider>
          <VoiceInputDictionaryToast />
        </LocaleProvider>
      </ThemeProvider>,
    );
    return;
  }

  if (isVoiceInputOverlay) {
    const { VoiceInputOverlay } = await import('./voice-input/VoiceInputOverlay');
    root.render(
      <ThemeProvider syncWindowVibrancy={false}>
        <LocaleProvider>
          <ConfirmDialogProvider>
            <VoiceInputOverlay />
          </ConfirmDialogProvider>
        </LocaleProvider>
      </ThemeProvider>,
    );
    return;
  }

  // Install the RSB control listener before any child Settings effect can ask
  // main for health. It is renderer-process scoped and must survive collapsed
  // or unmounted sidebar UI. Only the primary and dedicated sidebar windows
  // can own RSB tabs; other full-app windows must not publish an empty pool
  // snapshot into the primary registry.
  if (!isGhostPanelWindow() && !isSecondaryWindow()) {
    const disposeRsbBrowserBridge = initRsbBrowserBridge();
    import.meta.hot?.dispose(disposeRsbBrowserBridge);
  }

  // 主视图挂载前完成 memory 真值同步与旧配置迁移，确保用户可交互的 toggle 不会和
  // 启动快照并发。浮窗不消费该设置，跳过同步以免多个 renderer 争写共享 localStorage。
  await bootstrapMemorySettingsFromMain();

  // TapDB 在线活跃上报 — 只在主视图启用,避免 voice-input 浮窗的弹出被算成 PV。
  // 这里只挂"同意闸":SDK 是否初始化由 main 的 analytics-settings 决定,用户没
  // 同意过《隐私政策》时一个字节都不会发出去(见 analytics/tapdbClient.ts)。
  initTapdb();

  // 顶层 boundary:App 内 RouterProvider 之上的 provider 链渲染崩溃时兜底
  // (路由子树的崩溃仍由 router.tsx 的 errorElement 就近接住)。
  // App 必须延迟到辅助窗口分流之后再加载:完整 App 的 useApiKey 等模块会在
  // ghost/secondary renderer 启动时触发 safe-storage-read,被 main 正确拒绝并制造噪声。
  const { App } = await import('./App');
  root.render(
    <TopLevelErrorBoundary>
      <App />
    </TopLevelErrorBoundary>,
  );
})();
