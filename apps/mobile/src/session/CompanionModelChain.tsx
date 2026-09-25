import { findCatalogModel } from '@cindy/model-providers';
import { buildMobileModelSections } from './providerModelSections';
import { mobileProviderAccountTitle } from './mobileModelRowPresentation';
import { iconSize } from '@/theme';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { ChevronDown, ChevronRight, ChevronUp, MinusCircle, Plus, ArrowUp } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useDeviceProviders } from '@/device-link/useDeviceProviders';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { useAuth } from '@/auth/AuthContext';
import { spacing, typeScale, useTheme } from '@/theme';
import { ModelPickerSheet } from './ModelPickerSheet';
import { normalizeMobileAgentCapabilities } from './agentCapabilities';
import type { MobileModelConfiguration } from './unifiedMobileModels';
import type { ProfileValues } from './companionProfileData';
export interface CompanionModelRoute { harness: 'claude' | 'codex' | 'pi'; model: string; providerId: string | null; effort: string; fastMode: boolean }
export function readCompanionModelChain(value: unknown): CompanionModelRoute[] {
  if (typeof value !== 'string') return [];
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > 5 || rows.some(r => !r || !['claude', 'codex', 'pi'].includes(r.harness) || typeof r.model !== 'string' || !r.model || !(typeof r.providerId === 'string' || r.providerId === null) || typeof r.effort !== 'string' || typeof r.fastMode !== 'boolean')) return [];
    return rows;
  } catch { return []; }
}
export function CompanionModelChain({ deviceId, values, onChange, onPick, disabled }: { deviceId: string; values: ProfileValues; onChange(values: ProfileValues): void; onPick(index: number): void; disabled: boolean }) {
  const { t } = useTranslation(); const { colors } = useTheme();
  const catalog = useDeviceProviders(deviceId);
  // Only a ready catalog for this device may name a route. Never borrow a cached other-device account.
  const providers = catalog.ready ? catalog.providers : [];
  const chain = readCompanionModelChain(values.modelChain);
  const following = values.followsDefault === true;
  const update = (chain: CompanionModelRoute[]) => onChange({ ...values, modelChain: JSON.stringify(chain) });
  const [showBackups, setShowBackups] = useState(false);
  const routeRow = (route: CompanionModelRoute, index: number) => {
    const agent = route.harness === 'claude' ? 'claude-code' : route.harness;
    const providerId = route.providerId ?? buildMobileModelSections({ providers, agentKind: agent, selectedModelId: route.model, selectedProviderId: null, existingSessionRoute: true, visibilityOverrides: catalog.modelVisibilityOverrides }).activeSourceId;
    const provider = providers.find(item => item.id === providerId);
    const model = provider ? findCatalogModel(provider, route.model, agent) : undefined;
    const source = provider ? mobileProviderAccountTitle(provider) : route.providerId;
    return <View key={`${route.harness}:${route.providerId}:${route.model}`} style={styles.row}>
      <Pressable accessibilityRole="button" disabled={disabled || following} onPress={() => onPick(index)} style={[styles.row, { flex: 1 }]}>
        <Text style={{ color: colors.textSecondary }}>{index + 1}</Text><View style={{ flex: 1 }}><Text style={{ color: colors.textPrimary, fontSize: typeScale.body }}>{model?.name ?? route.model}</Text><Text style={{ color: colors.textSecondary, fontSize: typeScale.footnote }}>{[source, route.harness === 'claude' ? 'Claude Code' : route.harness === 'codex' ? 'Codex' : 'Pi', route.effort ? t(`models.options.effortLevels.${route.effort}`, { defaultValue: route.effort }) : '', route.fastMode ? 'Fast' : ''].filter(Boolean).join(' · ')}</Text></View><ChevronRight size={iconSize.md} color={colors.textSecondary} />
      </Pressable>
      {/* Desktop BotModelChainEditor: the first model stays primary (change it with the picker);
          backups reorder among themselves and can be removed. */}
      {!following && index > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={t('devices.companionProfile.moveModelUp')} disabled={disabled} style={styles.hit} onPress={() => { const next = [...chain]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update(next); }}><ArrowUp size={iconSize.lg} color={colors.textSecondary} /></Pressable> : null}
      {!following && index > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={t('devices.companionProfile.removeModel')} disabled={disabled} style={styles.hit} onPress={() => update(chain.filter((_, i) => index !== i))}><MinusCircle size={iconSize.lg} color={colors.textSecondary} /></Pressable> : null}
    </View>;
  };
  const addRow = !following && chain.length < 5 ? <Pressable accessibilityRole="button" disabled={disabled} style={styles.row} onPress={() => onPick(chain.length)}><Plus size={iconSize.action} color={colors.textPrimary} /><Text style={{ color: colors.textPrimary }}>{t('devices.companionProfile.addModel')}</Text></Pressable> : null;
  return <View style={{ gap: spacing.sm }}>
    <View style={styles.row}><Text style={{ color: colors.textPrimary, flex: 1 }}>{t('devices.companionProfile.modelFollowsDefault')}</Text><Switch accessibilityLabel={t('devices.companionProfile.modelFollowsDefault')} value={following} disabled={disabled} onValueChange={value => onChange({ ...values, followsDefault: value })} /></View>
    {chain.length ? routeRow(chain[0], 0) : addRow}
    {chain.length ? <>
      {/* The backup chain stays folded inside this editor, as on Desktop. */}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showBackups }} onPress={() => setShowBackups(value => !value)} style={styles.row} testID="companionModels.backups">
        <Text style={{ color: colors.textSecondary, fontSize: typeScale.footnote, flex: 1 }}>{t('devices.companionProfile.backupModels', { count: chain.length - 1 })}</Text>
        {showBackups ? <ChevronUp size={iconSize.md} color={colors.textSecondary} /> : <ChevronDown size={iconSize.md} color={colors.textSecondary} />}
      </Pressable>
      {showBackups ? <>{chain.slice(1).map((route, offset) => routeRow(route, offset + 1))}{addRow}</> : null}
    </> : null}
  </View>;
}
export function CompanionModelPicker({ visible, deviceId, route, onClose, onClosed, onSelect }: {
  visible: boolean; deviceId: string; route?: CompanionModelRoute; onClose(): void; onClosed(): void; onSelect(route: CompanionModelRoute): boolean;
}) {
  const { user } = useAuth(); const { t } = useTranslation();
  const catalog = useDeviceProviders(visible ? deviceId : undefined, visible);
  const maker = useMobileMakerTransport(deviceId);
  const agent = route?.harness === 'claude' ? 'claude-code' : route?.harness ?? 'pi';
  const select = async (config: MobileModelConfiguration) => onSelect({ harness: config.agent === 'claude-code' ? 'claude' : config.agent, model: config.modelId, providerId: config.providerId, effort: config.effort, fastMode: config.fast });
  return <ModelPickerSheet visible={visible} onClose={onClose} onClosed={onClosed} providers={catalog.ready ? catalog.providers : []}
    modelVisibilityOverrides={catalog.modelVisibilityOverrides} providersReady={catalog.ready}
    flatOptions={[]} agentKind={agent} capabilities={null} activeModelId={route?.model ?? ''} selectedProviderId={route?.providerId ?? null}
    selectedEffort={route?.effort ?? ''} selectedFastMode={route?.fastMode ?? false} existingSessionRoute
    disabled={!catalog.ready} loading={catalog.loading} emptyHint={catalog.error ?? t('devices.companionProfile.modelsUnavailable')}
    unified={{ scope: JSON.stringify([user?.id, deviceId]), agents: ['claude-code', 'codex', 'pi'],
      loadCapabilities: async agent => { const value = normalizeMobileAgentCapabilities(await maker.getCapabilities(agent)); if (!value) throw new Error('Capabilities unavailable'); return value; }, onSelect: select }}
    onSelectFlatModel={() => {}} onSelectProviderRow={() => {}} permissionOptions={[]} activePermissionMode="ask" onSelectPermissionMode={() => {}} hidePermissionTrigger keyboardAvoidingBehavior="padding" />;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 }, hit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' } });
