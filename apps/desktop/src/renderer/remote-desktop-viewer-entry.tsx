import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'harmonyos-sans-sc-webfont-splitted';
import '@/i18n';
import './themes/colors';
import './styles/globals.css';
import './features/remote-desktop/viewerWindow.css';
import { getInitialThemeVariant, ThemeProvider } from './hooks/useTheme';
import {
  applyFontSettings,
  getInitialFontSettings,
  FontSettingsProvider,
} from './hooks/useFontSettings';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';
import { RemoteDesktopViewerWindow } from './features/remote-desktop/RemoteDesktopViewerWindow';
import { TopLevelErrorBoundary } from './components/error/TopLevelErrorBoundary';

document.documentElement.dataset.platform = window.electronAPI.platform;
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
const root = document.getElementById('root');
if (!root) throw new Error('Missing viewer root');
createRoot(root).render(
  <TopLevelErrorBoundary>
    <ThemeProvider syncWindowVibrancy={false}>
      <FontSettingsProvider>
        <RemoteDesktopViewerWindow />
      </FontSettingsProvider>
    </ThemeProvider>
  </TopLevelErrorBoundary>,
);
