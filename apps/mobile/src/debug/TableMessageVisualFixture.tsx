/** Real table-body component, fixed local text, mock-only route in table-selection-preview. */
import { Stack } from 'expo-router';
import { TABLE_SELECTION_ANSWER } from '@cindy/maker-shared/ui-mock';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, TextInput } from '@/components/AppText';
import { useWindowWidth } from '@/platform/windowDimension';
import { RichContentContext } from '@/session/richContentContext';
import { RichContentRuntime } from '@/session/richContentRuntime';
import { SelectionQuoteContext } from '@/session/selectionQuote';
import { MarkdownBody } from '@/session/MessageRenderer';
import { ThemeOverrideProvider } from '@/theme/ThemeProvider';
import { buildMessageContentLayout } from '@/session/messageContentLayout';
import { messageBubbleBase, userMessageBubble } from '@/session/messageBubbleStyles';
import { lineHeight, spacing, typeScale, useTheme } from '@/theme';
import { TABLE_SELECTION_MARKDOWN } from './tableSelectionVisualFixture';

export function TableMessageVisualFixture() {
  const [dark, setDark] = useState(false);
  return <ThemeOverrideProvider mode={dark ? 'dark' : 'light'}>
    <Body dark={dark} onTheme={() => setDark(value => !value)} />
  </ThemeOverrideProvider>;
}
function Body({ dark, onTheme }: { dark: boolean; onTheme: () => void }) {
  const { colors } = useTheme();
  const width = useWindowWidth();
  const [streaming, setStreaming] = useState(false), [revision, setRevision] = useState(0), [code, setCode] = useState(false);
  const [whitespace, setWhitespace] = useState(false), [native, setNative] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const text = (whitespace ? TABLE_SELECTION_ANSWER : TABLE_SELECTION_MARKDOWN.replace('中文 空格 42', '中文 🙂 空格 42'))
    + (revision ? `\n\n正文修订 ${revision}。` : '')
    + (code ? '\n\n```ts\nconst 文本 = "中文  空格 🙂";\nconsole.log(文本);\n```\n\n[文件](/repo/xdt-maker/README.md) · [设置](cindy://settings) · [外链](https://example.test)' : '');
  const measurements = useRef({ native: 0, document: 0, outer: 0, width: 0 });
  const [receipt, setReceipt] = useState('等待实测');
  const bodyWidth = narrow ? Math.round(width * 0.73) : width;
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: bodyWidth }), [bodyWidth]);
  const runtime = useMemo(() => new RichContentRuntime(), []);
  useEffect(() => () => runtime.clear(), [runtime]);
  const [quote, setQuote] = useState(''), [side, setSide] = useState(''), [pasted, setPasted] = useState('');
  const context = useMemo(() => ({ commitQuote: setQuote, askInSideChat: setSide }), []);
  const style = { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption };
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
    <Stack.Screen options={{ headerShown: false }} />
    <Text style={style}>Table body · real component · isolated fixture</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {[[streaming ? '完成' : '生成', () => setStreaming(value => !value)],
        ['修订', () => setRevision(value => value + 1)], ['代码链接', () => setCode(value => !value)],
        [dark ? '浅色' : '深色', onTheme], ['测量', () => setReceipt(JSON.stringify(measurements.current))],
        [whitespace ? '长表' : '空白对照', () => setWhitespace(value => !value)],
        [native ? '统一正文' : '原生正文', () => setNative(value => !value)],
        [narrow ? '宽容器' : '窄容器', () => setNarrow(value => !value)],
      ].map(([label, action]) => <Pressable key={String(label)} accessibilityRole="button"
        onPress={action as () => void} style={{ padding: spacing.sm, minHeight: 44 }}>
        <Text style={style}>{String(label)}</Text>
      </Pressable>)}
    </View>
    <Text style={style} testID="table-body.measurements">{receipt}</Text>
    <RichContentContext.Provider value={runtime}>
    <SelectionQuoteContext.Provider value={context}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg }}>
        <View style={whitespace ? [messageBubbleBase, userMessageBubble(colors),
          narrow && { maxWidth: bodyWidth - spacing.lg * 2 }] : undefined} onLayout={event => {
          measurements.current.outer = event.nativeEvent.layout.height;
          measurements.current.width = event.nativeEvent.layout.width;
          if (streaming || native) measurements.current.native = event.nativeEvent.layout.height;
        }}>
          <MarkdownBody text={text} layout={layout} richStateKey="fixed-table-body"
            androidTableSelection={!native} selectable={!streaming} streaming={streaming} codeCopyEnabled
            tableFallbackBackground={whitespace ? colors.surfaceElevated : colors.surface}
            onTableMeasured={height => { measurements.current.document = height; }} />
        </View>
      </ScrollView>
    </SelectionQuoteContext.Provider>
    </RichContentContext.Provider>
    <Text style={style} testID="table-body.quote">引用：{JSON.stringify(quote)}</Text>
    <Text style={style} testID="table-body.side-chat">侧聊：{JSON.stringify(side)}</Text>
    <View style={{ padding: spacing.sm }}>
      <TextInput testID="table-body.paste" accessibilityLabel="系统粘贴回执" multiline value={pasted}
        onChangeText={setPasted} placeholder="在这里使用系统粘贴菜单"
        style={{ height: 76, borderWidth: 1, borderColor: colors.border, color: colors.textPrimary,
          padding: spacing.sm, fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed }} />
    </View>
    <Text style={style}>粘贴 {pasted.length} 字 · 首尾 {pasted.includes('表前开始') && pasted.includes('表后结束') ? '完整' : '未齐'}</Text>
  </SafeAreaView>;
}
