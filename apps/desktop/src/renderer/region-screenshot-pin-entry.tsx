import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import 'harmonyos-sans-sc-webfont-splitted';

import '@/i18n';
import './themes/colors';
import './styles/globals.css';

import { ScreenshotErrorBoundary } from './features/region-screenshot/ScreenshotErrorBoundary';
import { PinView } from './features/region-screenshot/PinView';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';

/** 截图贴图窗口入口: 一张贴图一个窗口。 */
document.documentElement.dataset.platform = window.electronAPI.platform;
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());

const rootElement = document.getElementById('root');
const bridge = window.regionScreenshotPin;
if (!rootElement || !bridge) throw new Error('Missing pin root or bridge');

createRoot(rootElement).render(
  <ScreenshotErrorBoundary onFailure={() => bridge.command('close')}>
    <PinView bridge={bridge} />
  </ScreenshotErrorBoundary>,
);
