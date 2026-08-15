/**
 * 插件面板独立子窗口的轻量渲染入口。
 *
 * 与 sidebar-window-entry.tsx 模式一致：只加载字体/CSS/主题/Provider，
 * 直接渲染 GhostPanelWindowLayout，不经过 main-entry.tsx 的完整 App 链。
 *
 * 插件面板需要 ghost 管理基础设施(cindy-brain/ghostPanels/runtimeStates)
 * 但不需要 maker 会话、登录、设置、语音等重量模块。
 *
 * 由 index.tsx 的 ?ghostPanelWindow=<id> 分发进入。
 */

import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';

import '@/i18n';
import './themes/colors';
import './styles/globals.css';

import { TopLevelErrorBoundary } from './components/error/TopLevelErrorBoundary';
import { GhostPanelWindowLayout } from './components/layout/GhostPanelWindowLayout';
import { ConfirmDialogProvider } from './components/ui/confirm-dialog-provider';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { bootstrapInitialLocale, LocaleProvider } from './hooks/useLocale';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';
import {
  ensureGhostPanelsRegistered,
} from '@/cindy-brain/ghostPanels';

document.documentElement.dataset.platform = window.electronAPI.platform;
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
bootstrapInitialLocale();
ensureGhostPanelsRegistered();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <TopLevelErrorBoundary>
    <LocaleProvider>
      <ConfirmDialogProvider>
        <GhostPanelWindowLayout />
      </ConfirmDialogProvider>
    </LocaleProvider>
  </TopLevelErrorBoundary>,
);
