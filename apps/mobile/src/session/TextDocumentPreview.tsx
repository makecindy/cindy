import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useMemo, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import {
  Copy,
  Search,
  WrapText,
  ListOrdered,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import { monoFont, spacing, textStyles, useTheme } from "@/theme";
import { writeClipboardText } from "@/session/messageActions";
import { PreviewIconButton, PreviewToolbar } from "./PreviewChrome";

/** Bounded, virtualized source reader. Finding and wrapping never modify the original. */
export function TextDocumentPreview({
  text,
  initialLine,
  testID,
}: {
  text: string;
  testID?: string;
  initialLine?: number | null;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [find, setFind] = useState(false);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const list = useRef<LegendListRef>(null);
  const scrollToLine = (index: number) => {
    void list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false });
  };
  const initialPosition = useRef<{ text: string; line?: number | null } | null>(
    null,
  );
  const { lines, truncated } = useMemo(() => splitTextPreviewLines(text), [text]);
  const hits = useMemo(
    () =>
      query
        ? lines.flatMap((line, index) =>
            line.toLocaleLowerCase().includes(query.toLocaleLowerCase())
              ? [index]
              : [],
          )
        : [],
    [lines, query],
  );
  const jump = (index: number) => {
    const next = (index + hits.length) % hits.length;
    if (!hits.length) return;
    setMatch(next);
    scrollToLine(hits[next]!);
  };
  const reader = (
    <LegendList
      estimatedItemSize={20}
      ref={list}
      testID={testID}
      data={lines}
      keyExtractor={(_, index) => String(index)}
      onLoad={() => {
        if (
          initialPosition.current?.text === text &&
          initialPosition.current.line === initialLine
        )
          return;
        initialPosition.current = { text, line: initialLine };
        if (initialLine && initialLine > 0 && initialLine <= lines.length)
          scrollToLine(initialLine - 1);
      }}
      contentContainerStyle={{ padding: spacing.md }}
      style={{ flex: 1 }}
      renderItem={({ item, index }) => (
        <View
          style={{
            flexDirection: "row",
            backgroundColor:
              hits[match] === index ? colors.surfaceChip : undefined,
          }}
        >
          {numbers ? (
            <Text
              style={[
                textStyles.caption,
                {
                  color: colors.textTertiary,
                  minWidth: 40,
                  paddingRight: spacing.sm,
                  textAlign: "right",
                },
              ]}
            >
              {index + 1}
            </Text>
          ) : null}
          <Text
            selectable
            style={{
              color: colors.textPrimary,
              fontFamily: monoFont,
              ...textStyles.bodySmall,
              ...(wrap ? { flex: 1 } : {}),
            }}
          >
            {item || " "}
          </Text>
        </View>
      )}
    />
  );
  return (
    // 底色跟随宿主页面:预览顶栏是透明的浮动按钮,自带底色会在顶栏下方露出一道接缝。
    <View style={{ flex: 1 }}>
      <PreviewToolbar>
        <PreviewIconButton
          icon={Search}
          systemImage="magnifyingglass"
          label={t("message.attachmentPreview.find")}
          onPress={() => setFind((value) => !value)}
        />
        <PreviewIconButton
          icon={WrapText}
          systemImage="arrow.turn.down.left"
          label={t("message.attachmentPreview.wrap")}
          onPress={() => setWrap((value) => !value)}
        />
        <PreviewIconButton
          icon={ListOrdered}
          systemImage="list.number"
          label={t("message.attachmentPreview.lineNumbers")}
          onPress={() => setNumbers((value) => !value)}
        />
        <PreviewIconButton
          icon={Copy}
          systemImage="doc.on.doc"
          label={t("message.renderer.copyDetailContent")}
          onPress={() => {
            void writeClipboardText(text).catch(() =>
              Alert.alert(t("files.preview.readFailed")),
            );
          }}
        />
      </PreviewToolbar>
      {find ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: spacing.md,
          }}
        >
          <TextInput
            autoFocus
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setMatch(0);
            }}
            placeholder={t("message.attachmentPreview.find")}
            placeholderTextColor={colors.textTertiary}
            style={{
              flex: 1,
              minWidth: 0,
              color: colors.textPrimary,
              minHeight: 48,
            }}
            onSubmitEditing={() => jump(match + 1)}
          />
          <Text style={[textStyles.caption, { color: colors.textSecondary }]}>
            {hits.length ? match + 1 : 0}/{hits.length}
          </Text>
          <PreviewIconButton
            icon={ChevronLeft}
            systemImage="chevron.left"
            label={t("message.attachmentPreview.previous")}
            disabled={!hits.length}
            onPress={() => jump(match - 1)}
          />
          <PreviewIconButton
            icon={ChevronRight}
            systemImage="chevron.right"
            label={t("message.attachmentPreview.next")}
            disabled={!hits.length}
            onPress={() => jump(match + 1)}
          />
          <PreviewIconButton
            icon={X}
            systemImage="xmark"
            label={t("message.attachmentPreview.close")}
            onPress={() => {
              setFind(false);
              setQuery("");
            }}
          />
        </View>
      ) : null}
      {truncated ? (
        <Text style={[textStyles.caption, { padding: spacing.sm, color: colors.textSecondary }]}>
          {t("groupChat.server.attachmentPreviewTruncated")}
        </Text>
      ) : null}
      {wrap ? (
        reader
      ) : (
        <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
          {reader}
        </ScrollView>
      )}
    </View>
  );
}

// Keep the previous JSON rendering budget for every source reader. Copy uses the original text.
function splitTextPreviewLines(text: string): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let start = 0;
  let characters = 0;
  while (lines.length < 10_000 && characters < 100_000) {
    const end = text.indexOf('\n', start);
    const lineEnd = end < 0 ? text.length : end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const line = text.slice(start, lineEnd);
    const visible = line.slice(0, Math.min(4_096, 100_000 - characters));
    lines.push(visible);
    characters += visible.length;
    start = end < 0 ? text.length : end + 1;
    if (visible.length < line.length) return { lines, truncated: true };
    if (end < 0) return { lines, truncated: false };
  }
  return { lines, truncated: start < text.length };
}
