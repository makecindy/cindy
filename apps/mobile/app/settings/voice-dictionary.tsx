import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL } from '@cindy/maker-shared/device-link-contract';
import type { MobileVoiceDictionarySnapshotResult } from '@cindy/maker-shared/device-link-contract';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import {
  hydrateMobileVoiceDictionary,
  readCachedMobileVoiceDictionarySnapshot,
  refreshMobileVoiceDictionary,
  subscribeMobileVoiceDictionaryCache,
} from '@/session/mobileVoiceDictionaryCache';
import { buildMobileVoiceDictionaryEntryViews } from '@/session/mobileVoiceDictionaryView';
import { useSettingsDeviceDirectory } from '@/session/settingsDeviceDirectory';
import { useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

/**
 * 语音词典查看页(只读,设置的二级页)。
 *
 * 独立 stack 路由:iOS 边缘右滑、Android 返回键都只退回设置,不会连设置一起关掉。
 *
 * 词典对用户是**一份**:同账号下所有开启同步的电脑收敛到同一份内容,「这条词来自
 * 哪台电脑」是实现细节,不该出现在界面上 —— 同一台机器换名或重装就会多出一个分组,
 * 列表立刻没法看。所以这里把所有电脑的快照合并成单一列表。
 *
 * 正本在电脑上,手机只拉快照用于润色,因此没有任何编辑入口:增删改一律回电脑做,
 * 避免手机维护一份会分叉的副本。
 */
export default function VoiceDictionaryScreen() {
  const router = useRouter();
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { invoke } = useDeviceLink();
  const { desktopDevices } = useSettingsDeviceDirectory();
  const [refreshing, setRefreshing] = useState(false);
  /** 缓存在模块里,组件用这个计数强制重渲染(每次刷新完成 +1)。 */
  const [dictionaryRevision, setDictionaryRevision] = useState(0);

  /**
   * 向所有在线电脑各拉一次词典快照。
   *
   * 它们本来就该收敛到同一份内容,拉多台只是为了容错(某台是旧版本、某台正好断线)。
   * 失败一律静默:电脑离线、没开「允许被控」、老版本不认识这个 channel 都是常态,
   * 页面继续显示上次缓存,不弹错。
   */
  const refreshVoiceDictionary = useCallback(() => {
    const online = desktopDevices.filter((host) => host.online);
    if (online.length === 0) return;
    setRefreshing(true);
    void Promise.all(
      online.map((host) => refreshMobileVoiceDictionary(
        host.deviceId,
        () => invoke<MobileVoiceDictionarySnapshotResult>(
          host.deviceId,
          DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL,
          [],
        ),
        { force: true },
      )),
    ).finally(() => {
      setRefreshing(false);
      // 缓存写在模块里,组件靠这个计数触发重渲染。
      setDictionaryRevision((value) => value + 1);
    });
  }, [desktopDevices, invoke]);

  // 设备清单是异步 REST 请求:页面打开后清单才到达时也走同一条路径,
  // 先把盘上缓存读进内存(离线也有内容可看),再拉一次最新的。
  useEffect(() => {
    if (desktopDevices.length === 0) return;
    let cancelled = false;
    void Promise.all(desktopDevices.map((host) => hydrateMobileVoiceDictionary(host.deviceId)))
      .then(() => {
        if (!cancelled) setDictionaryRevision((value) => value + 1);
      })
      .catch(() => undefined);
    refreshVoiceDictionary();
    return () => {
      cancelled = true;
    };
  }, [desktopDevices, refreshVoiceDictionary]);

  useEffect(() => subscribeMobileVoiceDictionaryCache(() => {
    setDictionaryRevision((value) => value + 1);
  }), []);

  // dictionaryRevision 只作为依赖存在:缓存是模块级的,刷新完成后靠它触发重算。
  const entries = useMemo(
    () =>
      buildMobileVoiceDictionaryEntryViews(
        desktopDevices.map((host) => readCachedMobileVoiceDictionarySnapshot(host.deviceId)),
      ),
    [desktopDevices, dictionaryRevision],
  );

  const status = desktopDevices.length === 0
    ? 'no-desktops'
    : desktopDevices.some((host) => host.online)
      ? 'ready'
      : 'all-offline';
  const footer = status === 'no-desktops'
    ? t('settings.voiceDictionary.noDesktops')
    : status === 'all-offline'
      ? t('settings.voiceDictionary.offlineHint')
      : t('settings.voiceDictionary.readOnlyHint');

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.voiceDictionary.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.voiceDictionary.backButton"
        onBack={() => goBackGuarded(router, '/settings')}
        title={t('settings.voiceDictionary.screenTitle')}
      />
      {/*
        词典上限是 1000 条,用 ScrollView 会把每一行都实例化出来 —— 低端机上首屏卡顿
        且常驻内存。这里换成虚拟化列表,只挂载可见行;卡片视觉靠 header/item/footer
        三段样式拼出来(FlatList 没法在外面包一层带圆角的 View 还保持自身滚动)。
      */}
      <FlatList
        {...simpleScrollInsetProps}
        ListFooterComponent={
          <>
            <View style={styles.listCardBottom} />
            <Text style={rowStyles.groupFooter}>{footer}</Text>
          </>
        }
        ListHeaderComponent={
          <>
            <View style={rowStyles.groupTitleRow}>
              <Text accessibilityRole="header" style={rowStyles.groupTitle}>{t('settings.voiceDictionary.sectionTitle')}</Text>
            </View>
            <View style={styles.listCardTop}>
              <Pressable
                accessibilityLabel={t('settings.voiceDictionary.refreshAccessibility')}
                accessibilityRole="button"
                accessibilityState={{ busy: refreshing || undefined }}
                onPress={refreshVoiceDictionary}
                style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
                testID="settings.voiceDictionary.refresh"
              >
                <View style={rowStyles.rowLine}>
                  <Text style={rowStyles.rowLabel}>
                    {t('settings.voiceDictionary.entryCount', { count: entries.length })}
                  </Text>
                  <Text style={rowStyles.rowValue} numberOfLines={1}>
                    {refreshing
                      ? t('settings.voiceDictionary.refreshing')
                      : t('settings.voiceDictionary.refresh')}
                  </Text>
                </View>
              </Pressable>
            </View>
          </>
        }
        contentContainerStyle={styles.listContent}
        data={entries}
        keyExtractor={(entry) => entry.key}
        renderItem={({ item }) => (
          <View style={styles.listCardMiddle}>
            <View style={rowStyles.divider} />
            <View style={rowStyles.row} testID={`settings.voiceDictionary.entry.${item.key}`}>
              <View style={rowStyles.rowLine}>
                <Text style={rowStyles.rowLabel} numberOfLines={2}>{item.text}</Text>
              </View>
              {item.aliases.length > 0 ? (
                <Text style={rowStyles.rowDetail} numberOfLines={2}>
                  {t('settings.voiceDictionary.aliases', {
                    aliases: item.aliases.join(t('settings.voiceDictionary.aliasSeparator')),
                  })}
                </Text>
              ) : null}
            </View>
          </View>
        )}
        testID="settings.voiceDictionary.scroll"
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  // —— 虚拟化列表拼出的卡片三段 ——
  listContent: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  listCardTop: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  listCardMiddle: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  listCardBottom: {
    backgroundColor: colors.surfaceElevated,
    borderBottomLeftRadius: radius.container,
    borderBottomRightRadius: radius.container,
    borderColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    height: radius.container,
    marginBottom: spacing.sm,
  },
});
