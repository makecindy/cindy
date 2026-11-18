/** Real table-body component, fixed local text, mock-only route in table-selection-preview. */
import { Stack } from 'expo-router';
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
  const text = TABLE_SELECTION_MARKDOWN.replace('中文 空格 42', '中文 🙂 空格 42')
    + (revision ? `\n\n正文修订 ${revision}。` : '')
    + (code ? '\n\n```ts\nconst 文本 = "中文  空格 🙂";\nconsole.log(文本);\n```\n\n[文件](/repo/xdt-maker/README.md) · [设置](cindy://settings) · [外链](https://example.test)' : '');
  const measurements = useRef({ native: 0, document: 0, outer: 0 });
  const [receipt, setReceipt] = useState('等待实测');
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
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
      ].map(([label, action]) => <Pressable key={String(label)} accessibilityRole="button"
        onPress={action as () => void} style={{ padding: spacing.sm, minHeight: 44 }}>
        <Text style={style}>{String(label)}</Text>
      </Pressable>)}
    </View>
    <Text style={style} testID="table-body.measurements">{receipt}</Text>
    <RichContentContext.Provider value={runtime}>
    <SelectionQuoteContext.Provider value={context}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg }}>
        <View onLayout={event => {
          measurements.current.outer = event.nativeEvent.layout.height;
          if (streaming) measurements.current.native = event.nativeEvent.layout.height;
        }}>
          <MarkdownBody text={text} layout={layout} richStateKey="fixed-table-body"
            androidTableSelection selectable={!streaming} streaming={streaming} codeCopyEnabled
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
