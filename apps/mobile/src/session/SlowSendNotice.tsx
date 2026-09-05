import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { lineHeight, typeScale, useTheme } from '@/theme';

export type SlowSendPhase = 'preparing' | 'uploading' | 'connecting' | 'checkingModel' | 'creating' | 'sending';
export const SLOW_SEND_NOTICE_DELAY_MS = 8_000;

/** Fast sends add no text or layout space; one elapsed clock survives phase changes. */
export function SlowSendNotice({ startedAt, phase }: { startedAt: number | null; phase: SlowSendPhase }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [visibleFor, setVisibleFor] = useState<number | null>(null);
  useEffect(() => {
    setVisibleFor(null);
    if (startedAt === null) return;
    const timer = setTimeout(() => setVisibleFor(startedAt), Math.max(0, startedAt + SLOW_SEND_NOTICE_DELAY_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [startedAt]);
  if (startedAt === null || visibleFor !== startedAt) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{ color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption }}
      testID="session.slowSendNotice"
    >
      {t(`session.new.slowSend.${phase}`)}
    </Text>
  );
}
