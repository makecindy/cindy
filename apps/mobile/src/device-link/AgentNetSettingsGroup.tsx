import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { MOBILE_VISUAL_MOCK_ENABLED, getOfficialAgentNetApiBaseUrl } from '@/config/env';
import { SettingsGroup, SettingsSwitchRow } from '@/session/SettingsGroupRows';
import { getActiveSelfHostedRelay } from './selfHostedRelayRouting';
import { MobileAgentNetEngine } from './agentNetNative';
import { ensureMobileAgentNetIdentity } from './agentNetIdentity';
import { readMobileAgentNetDirectory, writeMobileAgentNetDirectory } from './agentNetDirectoryCache';
import { setMobileAgentNetPreferences, useMobileAgentNetPreferences, waitForMobileAgentNetPreferences } from './agentNetPreferences';

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
        const identity = await ensureMobileAgentNetIdentity({ deviceId: auth.deviceId, deviceName,
          getAccessToken: auth.getAccessToken });
        // A signed roster is required for cold-start peer authentication. An
        // existing, unexpired local roster also permits enabling while offline.
        try { await writeMobileAgentNetDirectory(identity, await identity.api.directory()); }
        catch (error) { if (!(await readMobileAgentNetDirectory(identity))) throw error; }
      }
      if (!isMobileAuthOwnerCurrent(owner)) throw new Error('AGENT_NET_OWNER_CHANGED');
      await setMobileAgentNetPreferences(patch);
    } catch { if (isMobileAuthOwnerCurrent(owner)) setMessage(t('relay.agentNet.failed')); }
    finally { setBusy(false); }
  }
  const unavailable = MOBILE_VISUAL_MOCK_ENABLED ? null : !nativeAvailable
    ? t('relay.agentNet.updateRequired') : !configured ? t('relay.agentNet.notConfigured') : null;
  return <SettingsGroup title="Agent-Net" testID="settings.agentNet"
    footer={unavailable ?? t('relay.agentNet.hint')}
    messages={[message ? { text: message, testID: 'settings.agentNet.message' } : null]}>
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
