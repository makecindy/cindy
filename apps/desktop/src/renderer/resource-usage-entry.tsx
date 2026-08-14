import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';

import '@/i18n';
import './themes/colors';
import './styles/globals.css';

import { TopLevelErrorBoundary } from './components/error/TopLevelErrorBoundary';
import { ResourceUsageWindowRoot } from './components/resource-usage/ResourceUsageWindowLayout';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';

document.documentElement.dataset.platform = window.electronAPI.platform;
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <TopLevelErrorBoundary>
    <ResourceUsageWindowRoot />
  </TopLevelErrorBoundary>,
);
