import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'harmonyos-sans-sc-webfont-splitted';
import i18n from '@/i18n';
import './themes/colors';
import './styles/globals.css';
import { RecordingPreview } from './features/region-screenshot/RecordingPreview';
import { ScreenshotErrorBoundary } from './features/region-screenshot/ScreenshotErrorBoundary';
import type { RecordingPreviewDocument } from '../shared/regionCapture';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';

document.documentElement.dataset.platform = window.electronAPI.platform;
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
const bridge = window.recordingPreview!;
function App() {
  const [clip, setClip] = useState<RecordingPreviewDocument | null>(null);
  useEffect(() => {
    const begin = bridge.onBegin((value) => { void i18n.changeLanguage(value.locale); setClip(value); });
    const end = bridge.onEnd(() => { (document.activeElement as HTMLElement | null)?.blur(); setClip(null); });
    bridge.ready();
    return () => { begin(); end(); };
  }, []);
  return clip ? <RecordingPreview key={clip.token} document={clip} bridge={bridge} /> : null;
}
createRoot(document.getElementById('root')!).render(<ScreenshotErrorBoundary onFailure={() => bridge.failed()}><App /></ScreenshotErrorBoundary>);
