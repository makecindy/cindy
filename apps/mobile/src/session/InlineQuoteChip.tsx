import { Alert } from 'react-native';
import { MessageSquareQuote } from 'lucide-react-native';
import { quoteSourceDisplayLabel, type ChatQuote } from '@cindy/maker-shared/chat-quotes';
import { InlineReferenceChip } from '@/session/InlineReferenceChip';
import { iconSize, iconStroke, useTheme } from '@/theme';

export function compactQuoteLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** One quote per chip, shared geometry with message-anchor references. */
export function InlineQuoteChip({ quote }: { quote: ChatQuote }) {
  const { colors } = useTheme();
  const source = quoteSourceDisplayLabel(quote);
  const label = compactQuoteLabel(quote.text);
  return (
    <InlineReferenceChip
      accessibilityLabel={quote.text}
      icon={<MessageSquareQuote color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
      label={label}
      onPress={() => Alert.alert('引用', [`“${quote.text}”`, source].filter(Boolean).join('\n\n'))}
      testID="message.quoteChip"
    />
  );
}
