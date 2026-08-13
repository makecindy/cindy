/**
 * 右侧栏独立子窗口的轻量渲染入口。
 *
 * 与 resource-usage-entry.tsx 模式一致：只加载字体/CSS/主题/Provider，
 * 直接渲染 SidebarWindowLayout，不经过 main-entry.tsx 的完整 App 链
 * (完整 App 包含 maker-ipc 会话、登录、设置、语音等上千行启动代码)。
 *
 * 由 index.tsx 的 ?sidebarWindow=1 分发进入。
 */

import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';

import '@/i18n';
import './themes/colors';
import './styles/globals.css';

import { TopLevelErrorBoundary } from './components/error/TopLevelErrorBoundary';
import { SidebarWindowLayout } from './components/layout/SidebarWindowLayout';
import { AuthProvider } from './contexts/AuthContext';
import { ConfirmDialogProvider } from './components/ui/confirm-dialog-provider';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { LocaleProvider, bootstrapInitialLocale } from './hooks/useLocale';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';

document.documentElement.dataset.platform = window.electronAPI.platform;
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
bootstrapInitialLocale();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <TopLevelErrorBoundary>
    <LocaleProvider>
      <ConfirmDialogProvider>
        <AuthProvider enableSessionExpiredPrompt={false}>
          <SidebarWindowLayout />
        </AuthProvider>
      </ConfirmDialogProvider>
    </LocaleProvider>
  </TopLevelErrorBoundary>,
);
