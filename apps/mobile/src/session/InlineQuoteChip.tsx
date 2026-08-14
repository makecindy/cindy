import { Alert } from 'react-native';
import { MessageSquareQuote } from 'lucide-react-native';
import { quoteSourceDisplayLabel, type ChatQuote } from '@cindy/maker-shared/chat-quotes';
import { InlineReferenceChip } from '@/session/InlineReferenceChip';
import { compactQuoteLabel } from '@/session/quotePresentation';
import { iconSize, iconStroke, useTheme } from '@/theme';

/** One quote per chip, shared geometry with message-anchor references. */
export function InlineQuoteChip({
  interactive = true,
  quote,
}: {
  interactive?: boolean;
  quote: ChatQuote;
}) {
  const { colors } = useTheme();
  const source = quoteSourceDisplayLabel(quote);
  const label = compactQuoteLabel(quote.text);
  return (
    <InlineReferenceChip
      accessibilityLabel={quote.text}
      icon={<MessageSquareQuote color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
      label={label}
      onPress={interactive
        ? () => Alert.alert('引用', [`“${quote.text}”`, source].filter(Boolean).join('\n\n'))
        : undefined}
      testID="message.quoteChip"
    />
  );
}
