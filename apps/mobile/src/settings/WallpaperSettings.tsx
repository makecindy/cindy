import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ban, Check, Ellipsis, ImagePlus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { MainWindowOptionButton } from '@/components/MobilePrimitives';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { NativePullDownMenu, SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges, usesNativePullDownMenu } from '@/platform/chrome';
import { ActionInfoRow, SettingsCardFill, SettingsGroup, useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { SessionHeaderNativeBlur } from '@/session/SessionHeaderNativeControls';
import { useOptionalHeaderHeight } from '@/session/useOptionalHeaderHeight';
import { iconSize, radius, spacing, useTheme } from '@/theme';
import { WallpaperBackdrop } from '@/theme/WallpaperBackdrop';
import { useWallpaper, wallpaperRaisedFill, wallpaperSources, type SceneId, type WallpaperId } from '@/theme/wallpaper';
import { goBackGuarded } from '@/utils/backGuard';

const gallery: ('none' | SceneId)[] = ['none', ...Object.keys(wallpaperSources) as SceneId[]];

export function WallpaperSettings() {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();
  const router = useRouter();
  const headerHeight = useOptionalHeaderHeight();
  const row = useSettingsRowStyles();
  const { selected, dynamic, custom, select, importCustom, removeCustom } = useWallpaper();
  const picking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [galleryWidth, setGalleryWidth] = useState(0);
  const wide = galleryWidth >= 600;
  const columns = galleryWidth < 330 ? 2 : 3;
  const tileWidth = Math.floor((galleryWidth - (columns - 1) * spacing.md) / columns);
  const title = t('settings.appearance.wallpaper.title');
  const name = (id: WallpaperId) => t(`settings.appearance.wallpaper.options.${id}`);
  const chooseLabel = t('settings.appearance.wallpaper.choose');
  const replaceLabel = t('settings.appearance.wallpaper.replace');
  const removeLabel = t('settings.appearance.wallpaper.remove');
  const hasMotion = selected === 'custom' ? !!custom?.video : selected !== 'none';
  const pick = async () => {
    if (picking.current) return;
    picking.current = true;
    setBusy(true);
    try {
      const picker = await import('expo-image-picker');
      const result = await picker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 1 });
      if (!result.canceled && result.assets[0]) await importCustom(result.assets[0]);
    } catch (error) {
      Alert.alert(title, error instanceof Error && error.message === 'WALLPAPER_TOO_LARGE'
        ? t('settings.appearance.wallpaper.tooLarge') : t('settings.appearance.wallpaper.importFailed'));
    } finally { picking.current = false; setBusy(false); }
  };
  const apply = (id: WallpaperId, motion?: boolean) => {
    void select(id, motion).catch(() => Alert.alert(title, t('settings.appearance.wallpaper.saveFailed')));
  };
  const remove = () => { void removeCustom().catch(() => Alert.alert(title, t('settings.appearance.wallpaper.saveFailed'))); };
  return <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={[styles.screen, { backgroundColor: colors.surface }]}>
    <WallpaperBackdrop />
    <SimpleStackHeader scrollEdge title={title} onBack={() => goBackGuarded(router, '/settings')} />
    <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content} testID="settings.wallpaper.screen">
      <SettingsCardFill.Provider value={selected === 'none' ? undefined : wallpaperRaisedFill(colors.surfaceElevated, mode)}>
        <SettingsGroup>
          {custom ? (
            <View style={styles.customRow}>
              <Pressable accessibilityRole="radio" accessibilityLabel={name('custom')}
                accessibilityState={{ checked: selected === 'custom', disabled: busy }} disabled={busy}
                onPress={() => apply('custom')} testID="settings.wallpaper.custom"
                style={({ pressed }) => [row.row, styles.customChoice, pressed && mobileInteractionStyles.pressed]}>
                <View style={row.rowLine}>
                  <Image accessible={false} source={{ uri: custom.imageUri }} style={styles.customPreview} />
                  <Text style={row.rowLabel}>{name('custom')}</Text>
                  {busy ? <ActivityIndicator accessibilityLabel={t('settings.appearance.wallpaper.importing')} /> :
                    selected === 'custom' && <Check color={colors.textPrimary} size={iconSize.xl} />}
                </View>
              </Pressable>
              <NativePullDownMenu disabled={busy} actions={[
                { id: 'replace', title: replaceLabel, image: 'photo.on.rectangle' },
                { id: 'remove', title: removeLabel, image: 'trash', destructive: true },
              ]} onAction={action => { if (action === 'replace') void pick(); else if (action === 'remove') remove(); }}>
                <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('session.row.moreOptions')}
                  testID="settings.wallpaper.more" style={styles.more}
                  onPress={() => { if (!usesNativePullDownMenu()) Alert.alert(name('custom'), undefined, [
                    { text: replaceLabel, onPress: pick }, { text: removeLabel, style: 'destructive', onPress: remove },
                    { text: t('session.common.cancel'), style: 'cancel' },
                  ]); }}>
                  <Ellipsis color={colors.textSecondary} size={iconSize.xl} />
                </Pressable>
              </NativePullDownMenu>
            </View>
          ) : (
            <ActionInfoRow label={chooseLabel} accessibilityLabel={chooseLabel} onPress={pick} disabled={busy}
              lead={busy ? <ActivityIndicator accessibilityLabel={t('settings.appearance.wallpaper.importing')} /> : <ImagePlus color={colors.textPrimary} size={iconSize.xl} />}
              testID="settings.wallpaper.pick" />
          )}
        </SettingsGroup>
        <View accessibilityRole="radiogroup" accessibilityLabel={title} style={styles.gallery}
          onLayout={event => setGalleryWidth(event.nativeEvent.layout.width)}>
          {tileWidth > 0 && gallery.map(id => {
            const checked = selected === id;
            return <Pressable key={id} disabled={busy}
              accessibilityRole="radio" accessibilityLabel={name(id)} accessibilityState={{ checked, disabled: busy }}
              testID={`settings.wallpaper.${id}`} onPress={() => apply(id)}
              style={({ pressed }) => [{ width: tileWidth }, styles.tile, pressed && mobileInteractionStyles.pressed]}>
              <View style={[styles.frame, { aspectRatio: wide ? 16 / 9 : 1, borderColor: checked ? colors.textPrimary : 'transparent' }]}>
                {id === 'none' ? <View style={[styles.thumbnail, styles.none, { backgroundColor: colors.surfaceChip }]}>
                  <Ban size={iconSize.action} color={colors.textSecondary} />
                </View> : <Image accessible={false} source={wide ? wallpaperSources[id].image() : wallpaperSources[id].tile()} style={styles.thumbnail} />}
                {checked && <View style={[styles.check, { backgroundColor: colors.cta }]}>
                  <Check size={iconSize.sm} color={colors.ctaText} />
                </View>}
              </View>
              <Text style={[row.rowLabel, styles.caption]}>{name(id)}</Text>
            </Pressable>;
          })}
        </View>
        {hasMotion && <SettingsGroup>
          <View style={[row.row, styles.motion]} accessibilityRole="radiogroup" accessibilityLabel={t('settings.appearance.wallpaper.motionLabel')}>
            <Text style={[row.rowLabel, styles.motionLabel]}>{t('settings.appearance.wallpaper.motionLabel')}</Text>
            <View style={styles.modes}>
              {(['static', 'dynamic'] as const).map(option => <MainWindowOptionButton key={option}
                label={t(`settings.appearance.wallpaper.${option}`)} accessibilityRole="radio"
                accessibilityState={{ checked: dynamic === (option === 'dynamic') }} variant="segmented"
                disabled={busy} selected={dynamic === (option === 'dynamic')} onPress={() => apply(selected, option === 'dynamic')}
                testID={`settings.wallpaper.${option}`} />)}
            </View>
          </View>
        </SettingsGroup>}
      </SettingsCardFill.Provider>
    </ScrollView>
    {selected !== 'none' && headerHeight > 0 && <SessionHeaderNativeBlur height={headerHeight} />}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { width: '100%', maxWidth: 880, alignSelf: 'center', padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  gallery: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: spacing.lg },
  tile: { gap: spacing.xs },
  frame: { padding: 2, borderWidth: 2, borderRadius: radius.container },
  thumbnail: { flex: 1, width: '100%', borderRadius: radius.control },
  caption: { flex: 0, textAlign: 'center' },
  none: { alignItems: 'center', justifyContent: 'center' },
  check: { position: 'absolute', right: spacing.sm, bottom: spacing.sm, padding: spacing.xs, borderRadius: radius.pill },
  customRow: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.sm },
  customChoice: { flex: 1 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  customPreview: { width: 44, height: 44, borderRadius: radius.control },
  motion: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
  motionLabel: { flex: 0 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
