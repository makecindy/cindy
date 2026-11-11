import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { ImagePlus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import portraits from '../../assets/bot-presets/portrait-gallery.json';

// Bundled copies of the desktop picker: Cindy first, followed by the same sixteen portraits.
export const randomCompanionPortrait = () => portraits[Math.floor(Math.random() * portraits.length)];
export function CompanionPortraitPicker({ value, onChange, disabled = false }: { value: string; onChange(value: string): void; disabled?: boolean }) {
  const { t } = useTranslation(); const { colors } = useTheme(); const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pick = async () => {
    if (busy || disabled) return;
    setBusy(true); setError(false);
    try {
      const picker = await import('expo-image-picker');
      const result = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
      if (result.canceled || !result.assets[0]) return;
      const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
      const { File } = await import('expo-file-system');
      const context = ImageManipulator.manipulate(result.assets[0].uri);
      context.resize({ width: 256, height: 256 });
      let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
      try {
        image = await context.renderAsync();
        let bytes = '';
        for (const compress of [0.85, 0.65, 0.4]) {
          const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
          bytes = saved.base64 ?? '';
          // Only our generated thumbnail is temporary; never remove the selected source photo.
          try { new File(saved.uri).delete(); } catch { /* OS cache cleanup can finish later. */ }
          if (bytes && bytes.length <= 55_000) break;
        }
        if (!bytes || bytes.length > 55_000) throw new Error('Avatar unavailable');
        if (mounted.current) onChange(bytes);
      } finally { image?.release(); context.release(); }
    } catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setBusy(false); }
  };
  const chosenUpload = value && !portraits.includes(value);
  return <View style={styles.container}>
    <View style={styles.grid}>{portraits.map((bytes, index) => <Pressable key={index} accessibilityRole="button"
      accessibilityLabel={t('devices.companionProfile.portraitNumber', { number: index + 1 })} accessibilityState={{ selected: bytes === value, disabled: disabled || busy }}
      disabled={disabled || busy} onPress={() => onChange(bytes)} style={[styles.choice, bytes === value && { borderColor: colors.textPrimary }]}>
      <Image source={{ uri: `data:image/jpeg;base64,${bytes}` }} style={styles.image} />
    </Pressable>)}
      <Pressable accessibilityRole="button" accessibilityLabel={t('devices.companionProfile.uploadAvatar')} disabled={disabled || busy} accessibilityState={{ selected: !!chosenUpload, disabled: disabled || busy }} onPress={() => void pick()} style={[styles.choice, chosenUpload && { borderColor: colors.textPrimary }]}>
        {chosenUpload ? <Image source={{ uri: `data:image/jpeg;base64,${value}` }} style={styles.image} /> : <View style={styles.upload}><ImagePlus size={iconSize.action} color={colors.textSecondary} /></View>}
      </Pressable>
    </View>
    {busy || error ? <Text style={styles.note}>{t(busy ? 'devices.resources.loading' : 'devices.companionProfile.avatarFailed')}</Text> : null}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { gap: spacing.sm }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: { width: 60, height: 60, padding: 3, borderWidth: 1, borderColor: 'transparent', borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  image: { width: 52, height: 52, borderRadius: radius.pill },
  upload: { width: 52, height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
