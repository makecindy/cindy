/**
 * Manual/e2e probe for B's missing measurement/lifecycle evidence, not a chat
 * renderer. Fixed local Markdown, no links/resources/host actions or streaming.
 * Real device snapshots measure one bounded 24-message list, not performance.
 */
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { Stack } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { MAX_FONT_SIZE_MULTIPLIER, Text } from '@/components/AppText';
import { withHtmlPreviewCsp } from '@/session/htmlPreviewCsp';
import { interceptHtmlNavigation } from '@/session/htmlNavigationPolicy';
import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';
import { lineHeight, spacing, typeScale, useTheme } from '@/theme';
import { TABLE_SELECTION_MARKDOWN } from './tableSelectionVisualFixture';

const items = Array.from({ length: 24 }, (_, index) => ({
  key: `probe-${index}`, index,
  markdown: index % 4 === 0
    ? TABLE_SELECTION_MARKDOWN.replace('| 项目乙 Beta | | 末行 Final | 隐藏 终格 |',
      '| 项目乙 Beta | | 末行 Final | 隐藏 终格 |\n' + Array.from({ length: 18 }, (_, n) =>
        `| 长表 ${n + 1} | 中文 空格 | 多行内容 自然换行 文字${n + 1} | 右列 ${n + 1} |`).join('\n'))
    : `消息 ${index + 1} 开始。\n\n${'固定本地正文 中文 空格。'.repeat(8)}\n\n消息 ${index + 1} 结束。`,
}));
type Item = typeof items[number];
type Stats = { active: Set<string>; mounts: number; unmounts: number; peak: number;
  dom: Map<string, number>; native: Map<string, number> };

export function TableSelectionListVisualFixture() {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const list = useRef<LegendListRef>(null);
  const stats = useRef<Stats>({ active: new Set(), mounts: 0, unmounts: 0, peak: 0, dom: new Map(), native: new Map() });
  const nativeScroll = useRef(0);
  const viewport = useRef(0);
  const [snapshot, setSnapshot] = useState('等待实测');
  const track = useCallback((key: string, mounted: boolean, height?: number, nativeHeight?: number) => {
    const s = stats.current;
    if (nativeHeight !== undefined) { s.native.set(key, nativeHeight); return; }
    if (height !== undefined) { s.dom.set(key, height); return; }
    if (mounted) { s.active.add(key); s.mounts++; s.peak = Math.max(s.peak, s.active.size); }
    else { s.active.delete(key); s.unmounts++; }
  }, []);
  const capture = () => {
    const state = list.current?.getState();
    if (!state) return;
    const y = nativeScroll.current;
    const anchor = items.find(item => {
      const top = state.positionByKey(item.key);
      return top !== undefined && top + state.sizeAtIndex(item.index) > y;
    });
    const s = stats.current;
    setSnapshot(JSON.stringify({ fontScale, cssScale: Math.min(fontScale, MAX_FONT_SIZE_MULTIPLIER),
      viewport: viewport.current, scroll: Math.round(y),
      anchor: anchor?.key, offset: anchor ? Math.round((state.positionByKey(anchor.key) ?? 0) - y) : null,
      active: s.active.size, mounts: s.mounts, unmounts: s.unmounts, peak: s.peak,
      rows: [...s.active].sort().map(key => ({ key, dom: s.dom.get(key), native: s.native.get(key),
        row: Math.round(state.sizeAtIndex(Number(key.split('-')[1]))) })) }));
  };
  const renderItem = useCallback(({ item }: { item: Item }) => <ProbeRow item={item} track={track} />, [track]);
  return <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}>
    <Stack.Screen options={{ headerShown: false }} />
    <Text style={{ color: colors.textSecondary }}>Table selection · isolated list probe</Text>
    <View style={styles.controls}>
      {[
        ['记录', capture],
        ['第13条', () => list.current?.scrollToIndex({ index: 12, animated: false })],
        ['回第1条', () => list.current?.scrollToIndex({ index: 0, animated: false })],
      ].map(([label, action]) => <Pressable key={String(label)} accessibilityRole="button"
        onPress={action as () => void} style={[styles.control, { borderColor: colors.border }]}>
        <Text style={{ color: colors.textPrimary }}>{String(label)}</Text>
      </Pressable>)}
    </View>
    <Text testID="table-selection.list-metrics" numberOfLines={5}
      style={{ height: 100, color: colors.textSecondary, fontSize: typeScale.caption }}>
      {snapshot}
    </Text>
    <View style={styles.fill} onLayout={e => { viewport.current = e.nativeEvent.layout.height; }}>
      <LegendList ref={list} data={items} renderItem={renderItem} keyExtractor={item => item.key}
        recycleItems={false} estimatedItemSize={100} drawDistance={800}
        maintainVisibleContentPosition={{ data: false, size: true }}
        onScroll={e => { nativeScroll.current = e.nativeEvent.contentOffset.y; }} scrollEventThrottle={16} />
    </View>
  </SafeAreaView>;
}

const ProbeRow = memo(function ProbeRow({ item, track }: {
  item: Item; track: (key: string, mounted: boolean, height?: number, nativeHeight?: number) => void;
}) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const cssScale = Math.min(fontScale, MAX_FONT_SIZE_MULTIPLIER);
  const [height, setHeight] = useState(1);
  const settled = useRef(false);
  useEffect(() => { track(item.key, true); return () => track(item.key, false); }, [item.key, track]);
  const source = useMemo(() => {
    settled.current = false;
    const html = buildSelectableMarkdownHtml(item.markdown, { fontSize: typeScale.body * cssScale,
      lineHeight: lineHeight.bodyRelaxed * cssScale, tableCellMinWidth: 160, borderColor: colors.border,
      textColor: colors.textPrimary, mutedColor: colors.textSecondary, chipColor: colors.surfaceChip });
    return { baseUrl: 'about:blank', html: withHtmlPreviewCsp(html.replace('</head>',
      '<style>th,td{width:160px;max-width:160px}html,body{min-height:0;height:auto}</style></head>')
      .replace('</body>', `<script>(()=>{let last=0;const report=()=>{
        const h=Math.ceil(document.getElementById('xdt-content').getBoundingClientRect().height);
        if(h!==last){last=h;window.ReactNativeWebView?.postMessage(JSON.stringify({kind:'probe-height',height:h,scale:${fontScale}}));}
      };new ResizeObserver(report).observe(document.getElementById('xdt-content'));report();})();</script></body>`)) };
  }, [item.markdown, colors, fontScale, cssScale]);
  return <View style={{ borderBottomWidth: 1, borderColor: colors.border }}
    onLayout={e => track(item.key, true, undefined, e.nativeEvent.layout.height)}>
    <Text style={{ color: colors.textSecondary }}>探针消息 {item.index + 1}</Text>
    <WebView source={source} style={{ height, backgroundColor: colors.surface }} scrollEnabled={false}
      incognito originWhitelist={['*']} allowFileAccess={false} setSupportMultipleWindows={false}
      mediaCapturePermissionGrantType="deny"
      onShouldStartLoadWithRequest={r => interceptHtmlNavigation(r, settled.current)}
      onLoadEnd={() => { settled.current = true; }}
      onMessage={e => {
        if (e.nativeEvent.data.length > 128) return;
        try {
          const value = JSON.parse(e.nativeEvent.data);
          if (value.kind !== 'probe-height' || value.scale !== fontScale
            || !Number.isFinite(value.height) || value.height < 1 || value.height > 30000) return;
          track(item.key, true, value.height); setHeight(value.height);
        } catch { /* No host operation is available to the document. */ }
      }} />
  </View>;
});

const styles = StyleSheet.create({
  fill: { flex: 1 }, controls: { flexDirection: 'row', gap: spacing.sm },
  control: { borderWidth: 1, borderRadius: 9999, padding: spacing.sm, minHeight: 44 },
});
