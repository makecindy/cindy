import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Plug, RotateCcw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { ContextSheetGroup, ContextSheetRow } from './ContextSheet';
import { detectComposerPluginTrigger, filterComposerPlugins } from './composerPlugins';
import type { ComposerPlugin } from './remoteComposerPlugins';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

interface PluginCatalogOptions {
  deviceId?: string;
  workingDir?: string;
  enabled: boolean;
}

function useComposerPluginCatalog({ deviceId, workingDir, enabled }: PluginCatalogOptions) {
  const { accountGeneration } = useAuth();
  const { openLink, connectionEpoch } = useDeviceLink();
  const maker = useMobileMakerTransport(deviceId ?? '');
  const scope = JSON.stringify([accountGeneration, deviceId, workingDir ?? '', connectionEpoch]);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ scope: string; plugins: ComposerPlugin[]; loading: boolean; failed: boolean }>();

  useEffect(() => {
    if (!enabled || !deviceId) return;
    let cancelled = false;
    const owner = getMobileAuthOwner();
    const current = () => !cancelled && isMobileAuthOwnerCurrent(owner);
    setResult((previous) => previous?.scope === scope && !previous.failed
      ? previous
      : { scope, plugins: [], loading: true, failed: false });
    void openLink(deviceId).then(() => {
      if (!current()) return null;
      return maker.listComposerPlugins(workingDir);
    }).then((plugins) => {
      if (plugins && current()) setResult({ scope, plugins, loading: false, failed: false });
    }).catch(() => {
      if (current()) setResult({ scope, plugins: [], loading: false, failed: true });
    });
    return () => { cancelled = true; };
  }, [deviceId, enabled, maker, openLink, retry, scope, workingDir]);

  return { current: result?.scope === scope ? result : undefined, reload: () => setRetry((value) => value + 1) };
}

export function ContextSheetPlugins({ disabled, onOpen, testID }: {
  disabled?: boolean;
  onOpen: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <ContextSheetGroup label={t('session.common.plugins')}>
      <ContextSheetRow
        disabled={disabled}
        icon={<Plug color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
        label={t('session.common.plugins')}
        dismissBeforePress
        onPress={onOpen}
        testID={testID + '.entry'}
        trailing="chevron"
      />
    </ContextSheetGroup>
  );
}

export function ComposerPluginPalette({ deviceId, workingDir, draft, enabled, visible, disabled, horizontalInset = 0, maxHeight, onSelect, testID }: {
  deviceId?: string;
  workingDir?: string;
  draft: string;
  enabled: boolean;
  visible: boolean;
  disabled?: boolean;
  horizontalInset?: number;
  maxHeight?: number;
  onSelect: (plugin: ComposerPlugin, roster: ComposerPlugin[]) => void;
  testID: string;
}) {
  const styles = useThemedStyles(makePluginPaletteStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { current, reload } = useComposerPluginCatalog({ deviceId, workingDir, enabled });
  if (!visible) return null;
  const trigger = detectComposerPluginTrigger(draft);
  const visiblePlugins = current ? filterComposerPlugins(current.plugins, trigger?.query ?? '') : [];
  const icon = <Plug color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />;
  let status: ReactNode = null;
  if (!deviceId) status = <TextStatus text={t('session.common.pluginsChooseDevice')} styles={styles} />;
  else if (current?.failed) status = <Pressable onPress={reload} style={styles.statusRow} testID={testID + '.retry'}><RotateCcw color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} /><TextStatus text={t('session.common.pluginsReload')} styles={styles} /></Pressable>;
  else if (!current || current.loading) status = <View style={styles.statusRow}><ActivityIndicator color={colors.textSecondary} /><TextStatus text={t('session.common.pluginsLoading')} styles={styles} /></View>;
  else if (current.plugins.length === 0) status = <TextStatus text={t('session.common.pluginsEmpty')} styles={styles} />;
  else if (visiblePlugins.length === 0) status = <TextStatus text={t('session.common.noMatchingCommands')} styles={styles} />;
  return (
    <View style={[styles.panel, { marginHorizontal: horizontalInset }, maxHeight != null && { maxHeight }]} testID={testID}>
      {status ?? <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {visiblePlugins.map((plugin) => (
          <Pressable
            accessibilityLabel={t('session.common.insertCommand', { name: plugin.manifest.name })}
            accessibilityRole="button"
            disabled={disabled}
            key={plugin.manifest.id}
            onPress={() => onSelect(plugin, current!.plugins)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}
            testID={testID + '.' + plugin.manifest.id}
          >
            {plugin.iconDataUrl ? <Image contentFit="contain" source={{ uri: plugin.iconDataUrl }} style={styles.icon} /> : icon}
            <Text style={styles.primary} numberOfLines={1}>{plugin.manifest.name}</Text>
          </Pressable>
        ))}
      </ScrollView>}
    </View>
  );
}

function TextStatus({ text, styles }: { text: string; styles: ReturnType<typeof makePluginPaletteStyles> }) {
  return <Text style={styles.statusText}>{text}</Text>;
}

function makePluginPaletteStyles(colors: ThemeColors) {
  return StyleSheet.create({
    panel: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderRadius: radius.container, borderWidth: StyleSheet.hairlineWidth, flexShrink: 1, marginTop: spacing.sm, maxHeight: 260, padding: spacing.sm },
    row: { alignItems: 'center', borderRadius: radius.control, flexDirection: 'row', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md },
    rowPressed: { backgroundColor: colors.surfaceChip },
    rowDisabled: { opacity: 0.5 },
    icon: { height: iconSize.lg, width: iconSize.lg },
    primary: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium, lineHeight: lineHeight.body },
    statusRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md },
    statusText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  });
}
