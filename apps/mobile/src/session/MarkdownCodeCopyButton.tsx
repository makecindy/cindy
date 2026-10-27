import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { Check, CircleAlert, Copy } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { writeClipboardText, type CopyMessageStatus } from '@/session/messageActions';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';

const COPY_FEEDBACK_MS = 1500;
// The visible button stays compact; hitSlop expands it to the 44pt touch target.
const COPY_BUTTON_HIT_SLOP = 6;

type CopyState = CopyMessageStatus | 'idle' | 'copying';

/** Persistent mobile alternative to Desktop's hover-only code-block copy action. */
export function MarkdownCodeCopyButton({ text }: { text: string }) {
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

  const copyCode = useCallback(() => {
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
        : t('message.renderer.copyCode');

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityRole="button"
      accessibilityState={{ disabled: copying, busy: copying }}
      disabled={copying}
      hitSlop={COPY_BUTTON_HIT_SLOP}
      onPress={copyCode}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        copying && styles.disabled,
      ]}
      testID="message.markdownCodeCopyButton"
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
      <Text style={styles.label}>
        {state === 'copied'
          ? t('message.renderer.copyStateCopied')
          : state === 'failed'
            ? t('message.renderer.copyStateFailed')
            : t('message.renderer.copyCode')}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  button: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    marginBottom: spacing.xs,
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    minHeight: 32,
    paddingHorizontal: spacing.md,
  },
  disabled: { opacity: 0.6 },
  label: {
    color: colors.textPrimary,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.bodySmall,
  },
  pressed: { opacity: 0.72 },
});
