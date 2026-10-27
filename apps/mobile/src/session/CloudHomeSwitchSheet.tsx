/**
 * 手机上更换伙伴的主力电脑（docs/product-rules/cloud-companions.md §3.1）：主力电脑在线时，经 device-link
 * 读那台电脑视角下可接手的电脑，选中后请它交出（与桌面同一条路径，交出前同步对话与资料）。伙伴还在回复时
 * 可以等这一轮结束或停止后再换。主力电脑版本较旧或连不上时只说明原因；离线时由离线页面「换一台电脑继续」。
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  COMPANION_CLOUD_CAPS_CHANNEL,
  COMPANION_CLOUD_HAND_OVER_CHANNEL,
  COMPANION_CLOUD_REMOTE_HAND_OVER_VERSION,
  COMPANION_CLOUD_TARGETS_CHANNEL,
  companionCloudCapsVersion,
  parseCompanionCloudRemoteActionResult,
  parseCompanionCloudRemoteTargets,
  type CompanionCloudRemoteTarget,
} from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';
import { CompanionSettingsRow } from './CompanionSettingsRow';
import { CompanionSheet } from './CompanionSheet';
import { cloudHomeTargets } from '@/chat/cloudCompanion';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; targets: CompanionCloudRemoteTarget[] }
  | { kind: 'note'; key: 'homeOutdated' | 'homeUnreachable' | 'devicesFailed' | 'noTargets' }
  | { kind: 'moving'; target: CompanionCloudRemoteTarget };

export function CloudHomeSwitchSheet({ visible, onClose, botId, name, homeDeviceId, homeName, selfDeviceId, onMoved }: {
  visible: boolean;
  onClose: () => void;
  botId: string;
  name: string;
  homeDeviceId: string;
  homeName: string;
  /** This phone (never a target). */
  selfDeviceId?: string | null;
  onMoved: (target: CompanionCloudRemoteTarget) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { invoke } = useDeviceLink();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setPhase({ kind: 'loading' });
    setError(null);
    void (async () => {
      const version = companionCloudCapsVersion(await invoke(homeDeviceId, COMPANION_CLOUD_CAPS_CHANNEL, []).catch(() => null));
      if (!live) return;
      if (version === 0) { setPhase({ kind: 'note', key: 'homeUnreachable' }); return; }
      if (version < COMPANION_CLOUD_REMOTE_HAND_OVER_VERSION) { setPhase({ kind: 'note', key: 'homeOutdated' }); return; }
      try {
        const targets = cloudHomeTargets(parseCompanionCloudRemoteTargets(await invoke(homeDeviceId, COMPANION_CLOUD_TARGETS_CHANNEL, [])),
          homeDeviceId, selfDeviceId ?? null);
        if (live) setPhase(targets.length ? { kind: 'ready', targets } : { kind: 'note', key: 'noTargets' });
      } catch {
        if (live) setPhase({ kind: 'note', key: 'devicesFailed' });
      }
    })();
    return () => { live = false; };
  }, [homeDeviceId, invoke, selfDeviceId, visible]);

  const move = async (target: CompanionCloudRemoteTarget, whenBusy?: 'wait' | 'stop') => {
    const offered = phase.kind === 'ready' ? phase.targets : [target];
    setPhase({ kind: 'moving', target });
    setError(null);
    let result;
    try {
      result = parseCompanionCloudRemoteActionResult(await invoke(homeDeviceId, COMPANION_CLOUD_HAND_OVER_CHANNEL,
        whenBusy ? [botId, target.deviceId, { whenBusy }] : [botId, target.deviceId]));
    } catch {
      result = { ok: false as const, code: 'OFFLINE' };
    }
    if (result.ok) { onMoved(target); return; }
    setPhase({ kind: 'ready', targets: offered });
    if (result.code === 'BUSY' && !whenBusy) {
      Alert.alert(t('devices.cloudCompanion.busyTitle', { name }), t('devices.cloudCompanion.busyDescription', { name, device: target.name }), [
        { text: t('devices.common.cancel'), style: 'cancel' },
        { text: t('devices.cloudCompanion.busyStop'), style: 'destructive', onPress: () => void move(target, 'stop') },
        { text: t('devices.cloudCompanion.busyWait'), onPress: () => void move(target, 'wait') },
      ]);
      return;
    }
    setError(t(result.code === 'BUSY' ? 'devices.cloudCompanion.transferBusy'
      : result.code === 'HOME_CONFLICT' ? 'devices.cloudCompanion.switchConflict' : 'devices.cloudCompanion.switchFailed', { name, device: target.name }));
  };

  const confirm = (target: CompanionCloudRemoteTarget) => {
    Alert.alert(t('devices.cloudCompanion.moveTitle', { name, device: target.name }), t('devices.cloudCompanion.moveDescription', { name, device: target.name }), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.cloudCompanion.moveAction', { device: target.name }), onPress: () => void move(target) },
    ]);
  };

  return <CompanionSheet visible={visible} onClose={onClose} title={t('devices.cloudCompanion.homeTitle')} preventDismiss={phase.kind === 'moving'} testID="cloudHome.sheet">
    <View style={styles.content}>
      <Text style={styles.note}>{t('devices.cloudCompanion.runsOn', { device: homeName })}</Text>
      {phase.kind === 'loading' || phase.kind === 'moving' ? <ActivityIndicator style={styles.spinner} /> : null}
      {phase.kind === 'moving' ? <Text style={styles.note}>{t('devices.cloudCompanion.moving', { name, device: phase.target.name })}</Text> : null}
      {phase.kind === 'note' ? <Text style={styles.note}>{t(`devices.cloudCompanion.${phase.key}`, { device: homeName })}</Text> : null}
      {phase.kind === 'ready' ? phase.targets.map(target => <CompanionSettingsRow key={target.deviceId} icon={null} trailing="chevron"
        label={t('devices.cloudCompanion.moveTo', { device: target.name || t('devices.cloudCompanion.unknownDevice') })}
        onPress={() => confirm(target)} testID={`cloudHome.target.${target.deviceId}`} />) : null}
      {error ? <Text style={styles.note} accessibilityRole="alert">{error}</Text> : null}
    </View>
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.sm, paddingBottom: spacing.lg },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  spinner: { marginVertical: spacing.md },
});
