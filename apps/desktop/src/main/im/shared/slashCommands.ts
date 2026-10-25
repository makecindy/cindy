/**
 * main/im/shared/slashCommands.ts
 * ---------------------------------------------------------------------------
 * Recognise + handle bot slash commands (`/help`, `/new`, `/model`, ...)。
 * Returns true when handled (caller skips agent invocation), false otherwise.
 *
 * Slash commands are PARSED here and routed; cardActionHandler is responsible
 * for executing the consequences of /model picks (it sees the button press).
 *
 * 渠道无关(原 im/feishu/slashCommands.ts 工厂化): 渠道差异经 adapter 注入,
 * detach source 标记为 `${channel}-slash`。
 */
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { readDeviceProviderViews } from '../../remote-agent/controller/deviceCatalog';
import {
  getModelVisibilityOverride,
  waitForModelVisibilityMirror,
} from '../../maker-host/model-visibility-mirror';
import { getSessionProvider } from '../../maker-host/session-provider-store';
import { createLogger } from '../../logger';
import { resetImSessionToChannelDefaults } from './channelDefaultRouteSync';
import {
  listProjectsForControl,
  listRecentSessionsForPicker,
  readSessionTitle,
} from './controlProjects';
import { startThreadControlFlow } from './controlFlow';
import { enterControl } from './controlState';
import { bindingStore, executeDetach } from '../binding';
import { createSlashHandlers as createSharedSlashHandlers } from '@cindy/im-runtime/slashCommands';
export * from '@cindy/im-runtime/slashCommands';
export function createSlashHandlers(
  ...args: [
    Parameters<typeof createSharedSlashHandlers>[0],
    Parameters<typeof createSharedSlashHandlers>[1],
    Parameters<typeof createSharedSlashHandlers>[2],
    Parameters<typeof createSharedSlashHandlers>[3],
  ]
) {
  return createSharedSlashHandlers(...args, {
    createLogger: (...args) => createLogger(...args),
    waitForModelVisibilityMirror: (...args) => waitForModelVisibilityMirror(...args),
    getModelVisibilityOverride: (...args) => getModelVisibilityOverride(...args),
    getSessionProvider: (...args) => getSessionProvider(...args),
    resetImSessionToChannelDefaults: (...args) => resetImSessionToChannelDefaults(...args),
    listProjectsForControl: (...args) => listProjectsForControl(...args),
    listRecentSessionsForPicker: (...args) => listRecentSessionsForPicker(...args),
    readSessionTitle: (...args) => readSessionTitle(...args),
    enterControl: (...args) => enterControl(...args),
    startThreadControlFlow: (...args) => startThreadControlFlow(...args),
    executeDetach: (...args) => executeDetach(...args),
    bindingStore,
    listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: true }),
    readDeviceProviderViews: async (deviceId) => {
      const { remoteBackgroundInvoke } = await import('../../device-link');
      return readDeviceProviderViews(remoteBackgroundInvoke, deviceId);
    },
  });
}
