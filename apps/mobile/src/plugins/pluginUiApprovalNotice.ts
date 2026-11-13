import type { PluginNoticeProps } from './PluginNotice';
import type { PluginManagementController, PluginManagementState } from './pluginManagementController';
import { pluginNeedsUiApproval, type ManagedPlugin, type PluginUiConsentItem } from './pluginManagementTypes';

/** The Host snapshot is the authority for approval and cross-controller deferral. */
export function pluginUiApprovalNotice(
  plugin: ManagedPlugin | PluginUiConsentItem | undefined,
  state: PluginManagementState | null,
  controller: PluginManagementController | null,
  t: (key: string, args?: Record<string, unknown>) => string,
  proactive = false,
): PluginNoticeProps | undefined {
  if (!plugin || !state || !controller || ('manifest' in plugin && !pluginNeedsUiApproval(plugin))) return;
  const supported = state.snapshot?.uiCapabilityApproval === true || state.uiConsent?.uiCapabilityApproval === true;
  if (proactive && (!supported || ('manifest' in plugin && plugin.uiPromptSuppressed))) return;
  const pending = state.busy || ['running', 'confirmation', 'unknown'].includes(state.outcome);
  return {
    testID: 'plugins.uiApproval',
    title: t('plugins.uiApproval.title', { name: 'manifest' in plugin ? plugin.manifest.name : plugin.name }),
    detail: !supported ? t('plugins.uiApproval.updateHost')
      : state.outcome === 'failed' ? t('plugins.uiApproval.failed') : undefined,
    actions: supported ? [{
      label: t('plugins.uiApproval.enable'),
      testID: 'plugins.uiApproval.enable',
      disabled: pending || !state.online,
      onPress: () => { void ('manifest' in plugin ? controller.approveUi(plugin) : controller.approveUiFromConsent(plugin)); },
    }, ...(proactive ? [{
      label: t('plugins.uiApproval.later'),
      testID: 'plugins.uiApproval.later',
      disabled: pending || !state.online,
      onPress: () => { void ('manifest' in plugin ? controller.deferUi(plugin) : controller.deferUiFromConsent(plugin)); },
    }] : [])] : undefined,
  };
}
