import { useTranslation } from 'react-i18next';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatRunningTokenCount } from './lib/runningTokenUsage';

/** Own interpolation in the text leaf: animation frames must not re-render the
 * status bar, its popover/chart, or a token count that is not being displayed. */
export function RunningTokenCount({ tokenUsage }: { tokenUsage: number }) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const displayed = useAnimatedNumber(tokenUsage, reducedMotion ? 0 : 400);
  return <>{t('chat.runningStatus.tokenCount', { tokens: formatRunningTokenCount(displayed) })}</>;
}
