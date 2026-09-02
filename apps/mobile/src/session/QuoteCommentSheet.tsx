import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import type { ChatQuote } from '@cindy/maker-shared/chat-quotes';

import { Text, TextInput } from '@/components/AppText';
import { ContextSheet, ContextSheetFooterButton } from '@/session/ContextSheet';
import { withSelectionQuoteComment } from '@/session/selectionQuote';
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useThemedStyles,
  useTheme,
  type ThemeColors,
} from '@/theme';

export interface PendingQuoteComment {
  sessionId: string;
  quote: ChatQuote;
}

/** Touch-friendly optional-comment step shared by chat and file selections. */
export function QuoteCommentSheet({
  pending,
  onClose,
  onSubmit,
}: {
  pending: PendingQuoteComment | null;
  onClose: () => void;
  onSubmit: (pending: PendingQuoteComment, quote: ChatQuote) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft('');
  }, [pending]);

  const submit = (comment: string) => {
    if (!pending) return;
    onSubmit(pending, withSelectionQuoteComment(pending.quote, comment));
  };
  const normalizedDraft = draft.trim();

  return (
    <ContextSheet
      keyboardAvoidingBehavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      onClose={onClose}
      testID="quoteCommentSheet"
      title={t('message.quote.commentSheetTitle')}
      visible={pending !== null}
      footer={(
        <View style={styles.footer}>
          <Pressable
            accessibilityLabel={t('message.quote.addWithoutComment')}
            accessibilityRole="button"
            onPress={() => submit('')}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            testID="quoteCommentSheet.addWithoutComment"
          >
            <Text style={styles.secondaryButtonLabel}>{t('message.quote.addWithoutComment')}</Text>
          </Pressable>
          <View style={styles.primaryButton}>
            <ContextSheetFooterButton
              disabled={!normalizedDraft}
              label={t('message.quote.addWithComment')}
              onPress={() => submit(draft)}
              testID="quoteCommentSheet.addWithComment"
            />
          </View>
        </View>
      )}
    >
      {pending ? (
        <View style={styles.content}>
          <Text numberOfLines={4} style={styles.quotePreview}>
            {`“${pending.quote.text}”`}
          </Text>
          <Text style={styles.commentLabel}>{t('message.quote.commentLabel')}</Text>
          <TextInput
            autoFocus
            multiline
            onChangeText={setDraft}
            placeholder={t('message.quote.commentPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="quoteCommentSheet.input"
            textAlignVertical="top"
            value={draft}
          />
        </View>
      ) : null}
    </ContextSheet>
  );
}

function makeStyles(colors: ThemeColors) {
  return {
    content: {
      gap: spacing.md,
      paddingTop: spacing.lg,
    },
    quotePreview: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    commentLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    input: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.control,
      borderWidth: 1,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      minHeight: 120,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    footer: {
      flexDirection: 'row' as const,
      gap: spacing.sm,
    },
    primaryButton: {
      flex: 1,
    },
    secondaryButton: {
      alignItems: 'center' as const,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: 1,
      flex: 1,
      height: 50,
      justifyContent: 'center' as const,
    },
    secondaryButtonLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.semibold,
    },
    pressed: {
      opacity: 0.7,
    },
  };
}
