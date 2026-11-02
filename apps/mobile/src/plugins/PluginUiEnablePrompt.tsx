import { isProviderSharePeer, isSharedTaskPeer } from '@cindy/device-link';
import { useTranslation } from 'react-i18next';
import { PluginNotice } from './PluginNotice';
import { PluginManagementConfirmation } from './PluginManagementConfirmation';
import { pluginUiApprovalNotice } from './pluginUiApprovalNotice';
import { pluginNeedsUiApproval } from './pluginManagementTypes';
import { usePluginManagement } from './usePluginManagement';

interface Props {
  deviceId?: string;
  deviceName: string;
  sessionId?: string;
  online: boolean;
  active: boolean;
}
export function PluginUiEnablePrompt(props: Props) {
  if (!props.deviceId || isSharedTaskPeer(props.deviceId) || isProviderSharePeer(props.deviceId)) return null;
  return <OwnerPluginUiEnablePrompt {...props} />;
}
function OwnerPluginUiEnablePrompt({ deviceId, deviceName, sessionId, online, active }: Props) {
  const { t } = useTranslation();
  const { state, controller } = usePluginManagement(deviceId, online, active, sessionId ?? 'new-task');
  const plugin = state?.snapshot?.ghosts.find((item) => pluginNeedsUiApproval(item) && !item.uiPromptSuppressed);
  const notice = pluginUiApprovalNotice(plugin, state, controller, t, true);
  if (!active || !state || !controller) return null;
  return <>
    {notice ? <PluginNotice {...notice} compact /> : null}
    {state.outcome === 'unknown' ? <PluginNotice compact
      title={t('plugins.notice.title.resultUnknown')}
      actions={[{ label: t('plugins.management.checkResult'), disabled: !online || state.busy,
        onPress: () => { void controller.reconcile(); } }]} /> : null}
    <PluginManagementConfirmation key={`${deviceId}:${state.operationId ?? "idle"}`} state={state} controller={controller} deviceName={deviceName} active={active && online} />
  </>;
}
