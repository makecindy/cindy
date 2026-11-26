import { normalizeCompanionModelRoute, type CompanionModelRoute } from '@cindy/maker-shared/model-route';
import { findCatalogModel } from '@cindy/model-providers';
import { buildMobileModelSections } from './providerModelSections';
import { mobileProviderAccountTitle } from './mobileModelRowPresentation';
import { iconSize, lineHeight } from '@/theme';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight, Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useDeviceProviders } from '@/device-link/useDeviceProviders';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { useAuth } from '@/auth/AuthContext';
import { spacing, typeScale, useTheme } from '@/theme';
import { fontWeight, iconStroke, lineHeight as lineHeights, typeScale as typeScales } from '@/theme/tokens';
import { NativeSwitch } from '@/platform/chrome/NativeSwitch';
import { ModelPickerSheet } from './ModelPickerSheet';
import { normalizeMobileAgentCapabilities } from './agentCapabilities';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  findPluginEngine,
  isPluginEngineEffort,
  pluginEngineModelName,
  usePluginEngines,
  type MobilePluginEngineSelection,
} from './pluginEngines';
import type { MobileModelConfiguration } from './unifiedMobileModels';
import type { CompanionModelGroup, ProfileValues } from './companionProfileData';
import type { TFunction } from 'i18next';
import { useRemoteAgentCatalogs } from './useRemoteAgentCatalogs';
export type { CompanionModelRoute } from '@cindy/maker-shared/model-route';
/** 来源数 · 选法 · 推理强度，与 Desktop 选择器里模型组那一行同一写法。 */
function modelGroupHint(group: CompanionModelGroup, t: TFunction): string {
  return [t('models.modelGroups.sourceCount', { count: group.sources }), group.strategy ? t(`models.modelGroups.strategy.${group.strategy}`) : '',
    group.effort ? t(`models.options.effortLevels.${group.effort}`, { defaultValue: group.effort }) : ''].filter(Boolean).join(' · ');
}
export function readCompanionModelChain(value: unknown): CompanionModelRoute[] {
  if (typeof value !== 'string') return [];
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > 5 || rows.some(r => !r || !['claude', 'codex', 'pi', 'acp'].includes(r.harness) || typeof r.model !== 'string' || !r.model || !(typeof r.providerId === 'string' || r.providerId === null) || typeof r.effort !== 'string' || (typeof r.fastMode !== 'boolean' && r.fastMode !== 'ultrafast'))) return [];
    const normalized = rows.map(normalizeCompanionModelRoute);
    return normalized.every((row): row is CompanionModelRoute => row !== null) ? normalized : [];
  } catch { return []; }
}
// 伙伴只用一个模型(2026-11-26 用户裁决取消备用，想自动换来源就选智能路由)：默认只编辑这一个。旧版电脑存着的备用项原样带回，不在这里列出。
export function CompanionModelChain({ deviceId, values, onChange, onPick, disabled, modelGroups }: { deviceId: string; values: ProfileValues; onChange(values: ProfileValues): void; onPick(index: number): void; disabled: boolean; modelGroups?: CompanionModelGroup[] }) {
  const { t } = useTranslation(); const { colors } = useTheme();
  const catalog = useDeviceProviders(deviceId);
  const maker = useMobileMakerTransport(deviceId);
  // Only a ready catalog for this device may name a route. Never borrow a cached other-device account.
  const providers = catalog.ready ? catalog.providers : [];
  const chain = readCompanionModelChain(values.modelChain);
  const pluginEngines = usePluginEngines(maker, deviceId, chain.some(route => route.harness === 'acp' && !route.agentDeviceId));
  const routeCatalogs = useRemoteAgentCatalogs({ enabled: chain.some(route => !!route.agentDeviceId),
    controlledDeviceId: deviceId, keepDeviceIds: chain.flatMap(route => route.agentDeviceId ? [route.agentDeviceId] : []), keepOnly: true });
  const following = values.followsDefault === true;
  const routeRow = (route: CompanionModelRoute) => {
    const remote = route.agentDeviceId ? routeCatalogs.find(item => item.deviceId === route.agentDeviceId) : undefined;
    const group = route.modelGroup ? modelGroups?.find(item => item.id === route.modelGroup) : undefined;
    const effort = route.effort ? t(`models.options.effortLevels.${route.effort}`, { defaultValue: route.effort }) : '';
    let title: string;
    let detail: string;
    if (group) {
      title = group.name;
      detail = modelGroupHint(group, t);
    } else if (route.harness === 'acp') {
      const engine = !route.agentDeviceId ? findPluginEngine(pluginEngines.engines, route.providerId) : null;
      title = pluginEngineModelName(engine, route.model)
        ?? (route.model === PLUGIN_ENGINE_DEFAULT_MODEL ? t('models.pluginEngines.defaultModel') : route.model);
      detail = [engine?.name ?? t('models.pluginEngines.genericName'), remote?.name, effort].filter(Boolean).join(' · ');
    } else {
      const agent = route.harness === 'claude' ? 'claude-code' : route.harness;
      const routeProviders = route.agentDeviceId ? remote?.providers ?? [] : providers;
      const providerId = route.providerId ?? buildMobileModelSections({ providers: routeProviders, agentKind: agent,
        selectedModelId: route.model, selectedProviderId: null, existingSessionRoute: true,
        visibilityOverrides: catalog.modelVisibilityOverrides }).activeSourceId;
      const provider = routeProviders.find(item => item.id === providerId);
      title = (provider && findCatalogModel(provider, route.model, agent)?.name) ?? route.model;
      detail = [provider ? mobileProviderAccountTitle(provider) : route.providerId, remote?.name,
        route.harness === 'claude' ? 'Claude Code' : route.harness === 'codex' ? 'Codex' : 'Pi',
        effort, route.fastMode ? t(route.fastMode === 'ultrafast' ? 'models.options.speed.ultrafast' : 'models.options.fastMode') : '']
        .filter(Boolean).join(' · ');
    }
    return <View style={styles.row}>
      <Pressable accessibilityRole="button" disabled={disabled || following} onPress={() => onPick(0)} style={[styles.row, { flex: 1 }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ ...styles.title, color: colors.textPrimary }}>{title}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>{detail}</Text>
        </View>
        <ChevronRight size={iconSize.lg} color={colors.textTertiary} strokeWidth={iconStroke.regular} />
      </Pressable>
    </View>;
  };
  const addRow = !following ? <Pressable accessibilityRole="button" disabled={disabled} style={styles.row} onPress={() => onPick(0)}><Plus size={iconSize.action} color={colors.textPrimary} /><Text style={{ ...styles.title, color: colors.textPrimary }}>{t('devices.companionProfile.addModel')}</Text></Pressable> : null;
  return <View style={{ gap: spacing.sm }}>
    <View style={styles.row}><Text style={{ ...styles.title, color: colors.textPrimary, flex: 1 }}>{t('devices.companionProfile.modelFollowsDefault')}</Text><NativeSwitch accessibilityLabel={t('devices.companionProfile.modelFollowsDefault')} value={following} disabled={disabled} onValueChange={value => onChange({ ...values, followsDefault: value })} seedColor={colors.inputCaret} /></View>
    {chain.length ? routeRow(chain[0]) : addRow}
  </View>;
}
export function CompanionModelPicker({ visible, deviceId, route, onClose, onClosed, onSelect, modelGroups }: {
  visible: boolean; deviceId: string; route?: CompanionModelRoute; onClose(): void; onClosed(): void; onSelect(route: CompanionModelRoute): boolean;
  /** The host computer's model groups; absent from older hosts. */
  modelGroups?: CompanionModelGroup[];
}) {
  const { user } = useAuth(); const { t } = useTranslation();
  const catalog = useDeviceProviders(visible ? deviceId : undefined, visible);
  const maker = useMobileMakerTransport(deviceId);
  const pluginEngines = usePluginEngines(maker, deviceId, visible);
  const remoteCatalogs = useRemoteAgentCatalogs({ enabled: visible, controlledDeviceId: deviceId,
    keepDeviceIds: route?.agentDeviceId ? [route.agentDeviceId] : [] });
  const agent = route?.harness === 'claude' ? 'claude-code' : route?.harness === 'codex' || route?.harness === 'pi' ? route.harness : 'pi';
  const activePluginEngine = route?.harness === 'acp' && route.providerId && !route.agentDeviceId
    ? {
        providerId: route.providerId,
        modelId: route.model || PLUGIN_ENGINE_DEFAULT_MODEL,
        ...(isPluginEngineEffort(route.effort) ? { effort: route.effort } : {}),
      }
    : null;
  const selectPluginEngine = (selection: MobilePluginEngineSelection) => onSelect({
    agentDeviceId: null,
    harness: 'acp',
    model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
    providerId: selection.providerId,
    effort: selection.effort ?? '',
    fastMode: false,
  });
  const select = async (config: MobileModelConfiguration, source?: { deviceId: string | null }) => onSelect({ agentDeviceId: source?.deviceId ?? null, harness: config.agent === 'claude-code' ? 'claude' : config.agent, model: config.modelId, providerId: config.providerId, effort: config.effort, fastMode: config.fast });
  // 选组只记下组；这一项暂以原来的模型(新加的一项用组里第一个来源)作存下的具体模型，保存时伙伴所在的电脑换成组此刻会选的来源。
  const selectGroup = (id: string) => {
    const group = modelGroups?.find(item => item.id === id);
    const base = route?.model ? route : group?.fallback ? { ...group.fallback, effort: group.effort ?? '', fastMode: false as const } : undefined;
    return !!group && !!base && onSelect({ ...base, modelGroup: group.id });
  };
  const groupRows = (modelGroups ?? []).filter(group => route?.model || group.fallback)
    .map(group => ({ id: group.id, title: group.name, subtitle: modelGroupHint(group, t), selected: route?.modelGroup === group.id }));
  return <ModelPickerSheet visible={visible} onClose={onClose} onClosed={onClosed} providers={catalog.ready ? catalog.providers : []}
    modelVisibilityOverrides={catalog.modelVisibilityOverrides} providersReady={catalog.ready}
    flatOptions={[]} agentKind={agent} capabilities={null} activeModelId={route?.harness === 'acp' ? '' : (route?.model ?? '')} selectedProviderId={route?.harness === 'acp' ? null : (route?.providerId ?? null)}
    selectedEffort={route?.harness === 'acp' ? '' : (route?.effort ?? '')} selectedFastMode={route?.harness === 'acp' ? false : (route?.fastMode ?? false)} existingSessionRoute
    disabled={!catalog.ready && pluginEngines.engines.length === 0} loading={catalog.loading && pluginEngines.engines.length === 0} emptyHint={catalog.error ?? t('devices.companionProfile.modelsUnavailable')}
    unified={{
      remote: { catalogs: remoteCatalogs, selectedDeviceId: route?.harness === 'acp' ? null : (route?.agentDeviceId ?? null), hostDeviceId: deviceId },
      scope: JSON.stringify([user?.id, deviceId]),
      agents: ['claude-code', 'codex', 'pi'],
      loadCapabilities: async agent => { const value = normalizeMobileAgentCapabilities(await maker.getCapabilities(agent)); if (!value) throw new Error('Capabilities unavailable'); return value; },
      onSelect: select,
      ...(groupRows.length ? { modelGroups: { rows: groupRows, onSelect: selectGroup } } : {}),
      ...(pluginEngines.engines.length || activePluginEngine
        ? {
            pluginEngines: {
              engines: pluginEngines.engines,
              active: activePluginEngine,
              onSelect: selectPluginEngine,
              onOpen: pluginEngines.refresh,
            },
          }
        : {}),
    }}
    onSelectFlatModel={() => {}} onSelectProviderRow={() => {}} permissionOptions={[]} activePermissionMode="ask" onSelectPermissionMode={() => {}} hidePermissionTrigger keyboardAvoidingBehavior="padding" />;
}
// §3 roles: row titles / options 16/22 medium.
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  title: { fontSize: typeScales.body, lineHeight: lineHeights.body, fontWeight: fontWeight.medium } });
