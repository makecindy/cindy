import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { MOBILE_VISUAL_MOCK_ENABLED, getOfficialAgentNetApiBaseUrl, getOfficialDeviceLinkApiBaseUrl } from '@/config/env';
import { SettingsGroup, SettingsSwitchRow } from '@/session/SettingsGroupRows';
import { getActiveSelfHostedRelay } from './selfHostedRelayRouting';
import { MobileAgentNetEngine } from './agentNetNative';
import { ensureMobileAgentNetIdentity } from './agentNetIdentity';
import { readMobileAgentNetDirectory, writeMobileAgentNetDirectory } from './agentNetDirectoryCache';
import { setMobileAgentNetPreferences, useMobileAgentNetPreferences, waitForMobileAgentNetPreferences } from './agentNetPreferences';
import { mobileAgentNetEnableFailureKey, prepareMobileAgentNetEnable, rejoinMobileDeviceForAgentNet } from './deviceRejoin';

export function AgentNetSettingsGroup({ deviceName }: { deviceName: string }) {
  const { t } = useTranslation(), auth = useAuth(), preferences = useMobileAgentNetPreferences();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [mock, setMock] = useState({ enabled: false, onlyEncrypted: false });
  const nativeAvailable = MobileAgentNetEngine.available();
  const route = getActiveSelfHostedRelay();
  const configured = route ? !!route.signing?.agentNet : !!getOfficialAgentNetApiBaseUrl();
  const value = MOBILE_VISUAL_MOCK_ENABLED ? { ...mock, ready: true } : preferences;
  useEffect(() => {
    if (!MOBILE_VISUAL_MOCK_ENABLED) void waitForMobileAgentNetPreferences().catch(() => setMessage(t('relay.agentNet.failed')));
  }, [t]);
  async function change(patch: { enabled?: boolean; onlyEncrypted?: boolean }) {
    if (busy) return;
    if (MOBILE_VISUAL_MOCK_ENABLED) { setMock(previous => ({ ...previous, ...patch })); return; }
    const owner = getMobileAuthOwner();
    setBusy(true); setMessage(null);
    try {
      if (patch.enabled) {
        if (!nativeAvailable || !configured || !auth.deviceId) throw new Error('AGENT_NET_UNAVAILABLE');
        const options = { deviceId: auth.deviceId, deviceName, getAccessToken: auth.getAccessToken };
        // Signed roster first (offline: the stored one); a phone removed from the account rejoins here (deviceRejoin.ts).
        await prepareMobileAgentNetEnable({
          identity: () => ensureMobileAgentNetIdentity(options),
          refreshDirectory: async identity => writeMobileAgentNetDirectory(identity, await identity.api.directory()),
          hasLocalDirectory: async identity => !!(await readMobileAgentNetDirectory(identity)),
          official: () => getActiveSelfHostedRelay() === null,
          listed: async () => {
            try {
              const list = await auth.apiFetch<{ devices: { deviceId: string }[] }>('/api/device-link/devices', {
                baseUrl: getOfficialDeviceLinkApiBaseUrl(), timeoutMs: 3_000, cache: 'no-store' });
              return list.devices.some(device => device.deviceId === options.deviceId);
            } catch { return null; }
          },
          rejoin: rejoinMobileDeviceForAgentNet,
        });
      }
      if (!isMobileAuthOwnerCurrent(owner)) throw new Error('AGENT_NET_OWNER_CHANGED');
      await setMobileAgentNetPreferences(patch);
    } catch (error) { if (isMobileAuthOwnerCurrent(owner)) setMessage(t(mobileAgentNetEnableFailureKey(error))); }
    finally { setBusy(false); }
  }
  const unavailable = MOBILE_VISUAL_MOCK_ENABLED ? null : !nativeAvailable
    ? t('relay.agentNet.updateRequired') : !configured ? t('relay.agentNet.notConfigured') : null;
  return <SettingsGroup title="Agent-Net" testID="settings.agentNet"
    footer={unavailable ?? t('relay.agentNet.hint')}
    messages={[
      // Turned off because this phone was removed from the account (agentNetRuntime.ts); turning it on again rejoins.
      !MOBILE_VISUAL_MOCK_ENABLED && !route && preferences.removed && !preferences.enabled
        ? { text: t('relay.agentNet.removedOff'), testID: 'settings.agentNet.removed' } : null,
      message ? { text: message, testID: 'settings.agentNet.message' } : null,
    ]}>
    <SettingsSwitchRow label={t('relay.agentNet.enabled')} accessibilityLabel={t('relay.agentNet.enabled')}
      testID="settings.agentNet.enabled" switchTestID="settings.agentNet.enabled.switch" value={value.enabled}
      disabled={busy || !value.ready || (!value.enabled && !!unavailable)}
      onValueChange={enabled => void change({ enabled })} />
    {value.enabled ? <SettingsSwitchRow label={t('relay.agentNet.onlyEncrypted')}
      accessibilityLabel={t('relay.agentNet.onlyEncrypted')} testID="settings.agentNet.onlyEncrypted" switchTestID="settings.agentNet.onlyEncrypted.switch"
      value={value.onlyEncrypted} disabled={busy || !value.ready}
      onValueChange={onlyEncrypted => void change({ onlyEncrypted })} /> : null}
  </SettingsGroup>;
}
