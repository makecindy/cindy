import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { Check, CircleAlert, Copy } from 'lucide-react-native';
import { writeClipboardText, type CopyMessageStatus } from '@/session/messageActions';
import {
  iconSize,
  iconStroke,
  radius,
  spacing,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';

const COPY_FEEDBACK_MS = 1500;
// The visible button stays compact; hitSlop expands it to the 44pt touch target.
const COPY_BUTTON_HIT_SLOP = 6;

type CopyState = CopyMessageStatus | 'idle' | 'copying';

/** Whole-block copy complements native selection, which cannot cross table cells. */
export function MarkdownBlockCopyButton({ text, kind = 'code' }: { text: string; kind?: 'code' | 'table' }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<CopyState>('idle');
  const operationRef = useRef(0);

  useEffect(() => {
    operationRef.current += 1;
    setState('idle');
  }, [text]);

  useEffect(() => () => {
    operationRef.current += 1;
  }, []);

  useEffect(() => {
    if (state !== 'copied' && state !== 'failed') return;
    const timer = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copyBlock = useCallback(() => {
    if (!text.trim() || state === 'copying') return;
    const operation = ++operationRef.current;
    setState('copying');
    void writeClipboardText(text).then(() => {
      if (operationRef.current === operation) setState('copied');
    }).catch(() => {
      if (operationRef.current === operation) setState('failed');
    });
  }, [state, text]);

  if (!text.trim()) return null;

  const copying = state === 'copying';
  const label = state === 'copied'
    ? t('message.renderer.copyStateCopied')
    : state === 'failed'
      ? t('message.renderer.copyStateFailed')
      : copying
        ? t('message.renderer.copyStateCopying')
        : t(kind === 'table' ? 'message.renderer.copyTable' : 'message.renderer.copyCode');

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityRole="button"
      accessibilityState={{ disabled: copying, busy: copying }}
      disabled={copying}
      hitSlop={COPY_BUTTON_HIT_SLOP}
      onPress={copyBlock}
      style={({ pressed }) => [
        styles.button,
        kind === 'table' && styles.tableButton,
        pressed && styles.pressed,
        copying && styles.disabled,
      ]}
      testID={kind === 'table' ? 'message.markdownTableCopyButton' : 'message.markdownCodeCopyButton'}
    >
      {copying ? (
        <ActivityIndicator color={colors.textSecondary} size="small" />
      ) : state === 'copied' ? (
        <Check color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
      ) : state === 'failed' ? (
        <CircleAlert color={colors.statusError} size={iconSize.md} strokeWidth={iconStroke.regular} />
      ) : (
        <Copy color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
      )}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  button: {
    alignItems: 'center',
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: spacing.xxl,
    justifyContent: 'center',
    width: spacing.xxl,
  },
  // Keep the action outside the scrollable grid and clear of header/cell text.
  tableButton: {
    alignSelf: 'flex-end',
    position: 'relative',
    top: 0,
    right: 0,
    marginTop: spacing.xs,
    marginRight: spacing.xs,
  },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.72 },
});
