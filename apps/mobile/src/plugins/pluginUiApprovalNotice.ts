import type { PluginNoticeProps } from './PluginNotice';
import type { PluginManagementController, PluginManagementState } from './pluginManagementController';
import { pluginNeedsUiApproval, type ManagedPlugin, type PluginUiConsentItem } from './pluginManagementTypes';
import { pluginOperationHold, type PluginManagementSlot, type PluginSlotHolder } from './pluginManagementSlot';

/** The Host snapshot is the authority for approval and cross-controller deferral. */
export function pluginUiApprovalNotice(
  plugin: ManagedPlugin | PluginUiConsentItem | undefined,
  state: PluginManagementState | null,
  controller: PluginManagementController | null,
  t: (key: string, args?: Record<string, unknown>) => string,
  proactive = false,
  /**
   * The plugins page's management slot: Enable takes it when pressed (and does nothing if it cannot), and the
   * operation holds it until it is over. Its holder is only shown here (an unavailable button).
   */
  page?: { slot: PluginManagementSlot; who: PluginSlotHolder },
): PluginNoticeProps | undefined {
  const slot = page?.slot;
  if (!plugin || !state || !controller || ('manifest' in plugin && !pluginNeedsUiApproval(plugin))) return;
  const supported = state.snapshot?.uiCapabilityApproval === true || state.uiConsent?.uiCapabilityApproval === true;
  if (proactive && (!supported || ('manifest' in plugin && plugin.uiPromptSuppressed))) return;
  const pending = !!slot?.holder() || state.busy || ['running', 'confirmation', 'unknown'].includes(state.outcome);
  return {
    testID: 'plugins.uiApproval',
    title: t('plugins.uiApproval.title', { name: 'manifest' in plugin ? plugin.manifest.name : plugin.name }),
    detail: !supported ? t('plugins.uiApproval.updateHost')
      : state.outcome === 'failed' ? t('plugins.uiApproval.failed') : undefined,
    actions: supported ? [{
      label: t('plugins.uiApproval.enable'),
      testID: 'plugins.uiApproval.enable',
      disabled: pending || !state.online,
      // On the page the slot decides (a press from a stale render, or a second press in the same frame, cannot take
      // it); elsewhere the rendered state does, as before.
      onPress: () => {
        if (!slot) { if (!pending && state.online) void ('manifest' in plugin ? controller.approveUi(plugin) : controller.approveUiFromConsent(plugin)); return; }
        if (!('manifest' in plugin)) return;
        const token = slot.tryAcquire('page-approval', page!.who);
        if (!token) return;
        void controller.approveUi(plugin, pluginOperationHold(slot, token));
      },
    }, ...(proactive ? [{
      label: t('plugins.uiApproval.later'),
      testID: 'plugins.uiApproval.later',
      disabled: pending || !state.online,
      onPress: () => { if (!pending && state.online) void ('manifest' in plugin ? controller.deferUi(plugin) : controller.deferUiFromConsent(plugin)); },
    }] : [])] : undefined,
  };
}
