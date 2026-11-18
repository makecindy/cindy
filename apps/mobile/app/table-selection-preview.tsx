/** Development-only experiment; never selected by a production message renderer. */
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Text, TextInput } from '@/components/AppText';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { buildTableSelectionFixtureHtml } from '@/debug/tableSelectionVisualFixture';
import { interceptHtmlNavigation } from '@/session/htmlNavigationPolicy';
import { commitSelectionMenuAction, selectionQuoteMenuLabel } from '@/session/selectionQuote';
import { lineHeight, spacing, typeScale, useTheme } from '@/theme';

export default function TableSelectionPreview() {
  if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;
  return <Experiment />;
}

function Experiment() {
  const { menu } = useLocalSearchParams<{ menu?: string }>();
  // Android's installed WebView custom ActionMode may replace system Copy.
  // Verify real Copy first; the quote URL tests that callback separately.
  const quoteMenu = Platform.OS === 'ios' || menu === 'quote';
  const { colors } = useTheme();
  const settled = useRef(false);
  const [selected, setSelected] = useState('');
  const [scroll, setScroll] = useState('');
  const [quote, setQuote] = useState('');
  const [pasted, setPasted] = useState('');
  const html = useMemo(() => {
    settled.current = false;
    return buildTableSelectionFixtureHtml({
      fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed,
      borderColor: colors.border, chipColor: colors.surfaceChip,
      textColor: colors.textPrimary, mutedColor: colors.textSecondary,
    });
  }, [colors]);
  const source = useMemo(() => ({ html, baseUrl: 'about:blank' }), [html]);
  const menuItems = useMemo(() => [{ key: 'xdtQuote', label: selectionQuoteMenuLabel() }], []);
  const textStyle = { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption };
  return <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}>
    <Stack.Screen options={{ headerShown: false }} />
    <Text style={textStyle}>Table selection · isolated fixture · {quoteMenu ? 'quote menu' : 'system copy'}</Text>
    <Text style={textStyle} testID="table-selection.observation">选区 {selected.length} 字 · 横滚 {scroll}</Text>
    <View style={styles.fill}>
      <WebView
        source={source}
        style={[styles.fill, { backgroundColor: 'transparent' }]}
        incognito
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={request => interceptHtmlNavigation(request, settled.current)}
        onLoadEnd={() => { settled.current = true; }}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        mediaCapturePermissionGrantType="deny"
        menuItems={quoteMenu ? menuItems : undefined}
        onCustomMenuSelection={event => {
          const { key, selectedText } = event.nativeEvent;
          if (key === 'xdtQuote' && typeof selectedText === 'string' && selectedText.length <= 4096) {
            commitSelectionMenuAction('quote', selectedText, { commitQuote: setQuote });
          }
        }}
        onMessage={event => {
          // Observation only: no navigation, copy, arbitrary eval or host tools.
          if (event.nativeEvent.data.length > 24000) return;
          try {
            const value = JSON.parse(event.nativeEvent.data);
            if (value?.kind !== 'table-selection-observation' || typeof value.text !== 'string'
              || value.text.length > 4096) return;
            const dimensions = [value.scrollLeft, value.scrollWidth, value.viewportWidth];
            if (!dimensions.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100000)) return;
            setSelected(value.text);
            setScroll(`${Math.round(value.scrollLeft)} / ${value.scrollWidth - value.viewportWidth}`);
          } catch { /* Malformed observations have no effect. */ }
        }}
      />
    </View>
    <Text style={textStyle} testID="table-selection.quote">引用：{JSON.stringify(quote)}</Text>
    <TextInput accessibilityLabel="系统粘贴回执" testID="table-selection.paste" multiline
      value={pasted} onChangeText={setPasted} placeholder="在这里使用系统粘贴菜单"
      placeholderTextColor={colors.textPlaceholder}
      style={[styles.paste, { color: colors.textPrimary, borderColor: colors.border }]} />
    <Text style={textStyle}>粘贴 {pasted.length} 字 · 首尾 {pasted.includes('表前开始') && pasted.includes('表后结束') ? '完整' : '未齐'}</Text>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  paste: { borderWidth: 1, margin: spacing.sm, padding: spacing.sm,
    fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed, height: 76 },
});
