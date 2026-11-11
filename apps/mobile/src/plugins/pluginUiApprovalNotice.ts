import type { PluginNoticeProps } from './PluginNotice';
import type { PluginManagementController, PluginManagementState } from './pluginManagementController';
import { pluginNeedsUiApproval, type ManagedPlugin } from './pluginManagementTypes';

/** The Host snapshot is the authority for approval and cross-controller deferral. */
export function pluginUiApprovalNotice(
  plugin: ManagedPlugin | undefined,
  state: PluginManagementState | null,
  controller: PluginManagementController | null,
  t: (key: string, args?: Record<string, unknown>) => string,
  proactive = false,
): PluginNoticeProps | undefined {
  if (!plugin || !state || !controller || !pluginNeedsUiApproval(plugin)) return;
  if (proactive && (plugin.uiPromptSuppressed || !state.snapshot?.uiCapabilityApproval)) return;
  const supported = state.snapshot?.uiCapabilityApproval === true;
  const pending = state.busy || ['running', 'confirmation', 'unknown'].includes(state.outcome);
  return {
    testID: 'plugins.uiApproval',
    title: t('plugins.uiApproval.title', { name: plugin.manifest.name }),
    detail: !supported ? t('plugins.uiApproval.updateHost')
      : state.outcome === 'failed' ? t('plugins.uiApproval.failed') : undefined,
    actions: supported ? [{
      label: t('plugins.uiApproval.enable'),
      testID: 'plugins.uiApproval.enable',
      disabled: pending || !state.online,
      onPress: () => { void controller.approveUi(plugin); },
    }, ...(proactive ? [{
      label: t('plugins.uiApproval.later'),
      testID: 'plugins.uiApproval.later',
      disabled: pending || !state.online,
      onPress: () => { void controller.deferUi(plugin); },
    }] : [])] : undefined,
  };
}
