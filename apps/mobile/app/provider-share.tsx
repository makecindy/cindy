/**
 * 手机打开供应商分享链接时的提示页(产品规则 provider-sharing.md §3、§4.1 第 2 步):
 * 供应商分享只能在电脑上申请和使用,手机只提示「请在电脑上打开这个链接」,并可以把链接复制
 * 出来发到电脑。不申请、不访问服务端、不显示口令;链接只在本页内存里,离开即丢弃。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Laptop } from 'lucide-react-native';

import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import {
  getProviderShareLinkIntentSequence,
  subscribeProviderShareLinkIntent,
  takeProviderShareLinkIntent,
} from '@/device-link/providerShareLinkIntent';
import {
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
} from '@/platform/chrome/SimpleStackHeader';
import { writeClipboardText } from '@/session/messageActions';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

export default function ProviderShareLinkScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // 页面开着时又收到一条链接:换成新的(不合法的新链接会清掉旧的)。
  const sequence = useSyncExternalStore(
    subscribeProviderShareLinkIntent,
    getProviderShareLinkIntentSequence,
    getProviderShareLinkIntentSequence,
  );
  const [link, setLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<'copied' | 'copyFailed' | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const next = takeProviderShareLinkIntent();
    if (!next) return;
    setLink(next.link);
    setNotice(null);
  }, [sequence]);

  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await writeClipboardText(link);
      if (mounted.current) setNotice('copied');
    } catch {
      if (mounted.current) setNotice('copyFailed');
    }
  }, [link]);

  return (
    <SafeAreaView
      edges={simpleScrollScreenSafeAreaEdges()}
      style={styles.screen}
      testID="providerShare.screen"
    >
      <SimpleStackHeader
        scrollEdge
        title={t('providerShare.link.title')}
        backTestID="providerShare.back"
        onBack={() => goBackGuarded(router)}
      />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content}>
        <View style={styles.icon}>
          <Laptop size={iconSize.xl} color={colors.textSecondary} />
        </View>
        <Text accessibilityRole="header" style={styles.heading}>
          {t('providerShare.link.heading')}
        </Text>
        <Text style={styles.body}>{t('providerShare.link.body')}</Text>
        <Text style={styles.note}>{t('providerShare.link.note')}</Text>
        {link ? (
          <View style={styles.actions}>
            <MainWindowActionButton
              action={{
                label: t('providerShare.link.copy'),
                tone: 'primary',
                onPress: () => { void copy(); },
                testID: 'providerShare.copyLink',
              }}
            />
            {notice ? (
              <Text accessibilityLiveRegion="polite" style={styles.note}>
                {t(notice === 'copied' ? 'providerShare.link.copied' : 'providerShare.link.copyFailed')}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg, paddingTop: spacing.xl },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: 'center',
    marginBottom: spacing.xs,
    width: 48,
  },
  // 页面大标题:20/25 600 textPrimary。
  heading: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.title,
  },
  // 次级正文:15/20 400 textSecondary。
  body: {
    color: colors.textSecondary,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.bodySmall,
  },
  // 说明 / 提示:13/18 400 textSecondary。
  note: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  actions: { alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.sm },
});
