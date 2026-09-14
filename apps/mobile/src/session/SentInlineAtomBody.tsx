import type { ReactNode } from "react";
import {
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { slashCommandDisplayLabel } from "@cindy/maker-shared/composer-palette";
import { FileText } from "lucide-react-native";
import { Text } from "@/components/AppText";
import { InlineQuoteChip } from "@/session/InlineQuoteChip";
import { InlineReferenceChip } from "@/session/InlineReferenceChip";
import {
  buildTextPayload,
  type MessagePayload,
} from "@/session/messagePayload";
import type { SentInlineToken } from "@/session/sentMessageAtoms";
import {
  iconSize,
  iconStroke,
  lineHeight,
  spacing,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

/**
 * Shared rendering shell for the structured atoms embedded in a sent message.
 *
 * The completed-message renderer supplies a Markdown text renderer, while the
 * optimistic pending bubble supplies a lightweight plain-text renderer. Keeping
 * the atom/chip decisions here means the first optimistic frame and the
 * authoritative message use the same quote, pasted-text, and slash shapes.
 */
export function SentInlineAtomBody({
  interactiveAtoms = true,
  maxVisibleLines,
  numberOfLines,
  onOpenPayload,
  renderText,
  selectable,
  textStyle,
  testID = "message.sentInlineAtoms",
  tokens,
}: {
  interactiveAtoms?: boolean;
  maxVisibleLines?: number;
  numberOfLines?: number;
  onOpenPayload?: (payload: MessagePayload) => void;
  renderText?: (text: string, index: number) => ReactNode;
  selectable?: boolean;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
  tokens: readonly SentInlineToken[];
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const clampStyle: StyleProp<ViewStyle> = maxVisibleLines === undefined
    ? undefined
    : {
        maxHeight:
          maxVisibleLines * lineHeight.bodyLarge
          + Math.max(0, maxVisibleLines - 1) * spacing.xs,
        overflow: "hidden",
      };
  return (
    <View style={[styles.body, clampStyle]} testID={testID}>
      {tokens.map((token, index) => {
        if (token.kind === "quote") {
          return (
            <InlineQuoteChip
              interactive={interactiveAtoms}
              key={`quote:${token.quote.sourcePath ?? "chat"}:${index}:${token.quote.text}`}
              quote={token.quote}
            />
          );
        }
        if (token.kind === "pasted") {
          return (
            <InlineReferenceChip
              accessibilityLabel={token.display}
              icon={
                <FileText
                  color={colors.textSecondary}
                  size={iconSize.sm}
                  strokeWidth={iconStroke.regular}
                />
              }
              key={`pasted:${index}`}
              label={token.display}
              onPress={
                interactiveAtoms && onOpenPayload
                  ? () =>
                      onOpenPayload(buildTextPayload("Pasted text", token.text))
                  : undefined
              }
              testID="message.pastedTextChip"
            />
          );
        }
        if (token.kind === "slash") {
          const slashLabel = slashCommandDisplayLabel(token.text);
          return (
            <InlineReferenceChip
              accessibilityLabel={slashLabel}
              key={`slash:${index}`}
              label={slashLabel}
              testID="message.slashCommandChip"
            />
          );
        }
        if (!token.text) return null;
        if (renderText) return renderText(token.text, index);
        return (
          <View key={`text:${index}`} style={styles.textChunk}>
            <Text
              numberOfLines={numberOfLines}
              selectable={selectable}
              style={[styles.defaultText, textStyle]}
            >
              {token.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.xs,
      maxWidth: "100%",
    },
    textChunk: {
      flexBasis: "100%",
      flexShrink: 1,
      maxWidth: "100%",
    },
    defaultText: {
      color: colors.textPrimary,
    },
  });
