import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { floatingTopRow } from '@/platform/windowGeometry';
import { spacing } from '@/theme/tokens';
import { HTML_BROWSER_CONTROL_SIZE } from './HtmlBrowserChrome.types';

/**
 * Edges of the floating preview chrome and the content top that clears its first row.
 * iOS follows the window's status/bar geometry (Duo); other platforms keep the safe area.
 */
export function usePreviewChromeFrame() {
  const window = useAdaptiveWindow();
  const insets = useSafeAreaInsets();
  const row = Platform.OS === 'ios'
    ? floatingTopRow({ ...window, insets }, HTML_BROWSER_CONTROL_SIZE)
    : { top: insets.top, left: insets.left + spacing.md, right: insets.right + spacing.md, sharedStatusRow: false };
  // Only the chrome row shares the status row; content stays below the status area.
  const contentTop = Math.max(insets.top, row.top + HTML_BROWSER_CONTROL_SIZE + spacing.xs);
  return { ...row, bottom: insets.bottom, contentTop };
}
