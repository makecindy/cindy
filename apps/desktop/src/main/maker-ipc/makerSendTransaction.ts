export * from '@cindy/app-runtime/makerSendTransaction';
import { createMakerSendTransaction as createTransaction, type MakerSendTransactionDeps } from '@cindy/app-runtime/makerSendTransaction';
import { getResolvedMainLocale } from '../i18n.js';
import { channelTurnSourceFor, withChannelTurnSource } from './channelTurnSignal.js';
import { mcpAppModelContext } from '../mcp-apps/runtime.js';
import { prepareDirectoryGrantsForBootstrap as prepareGrants } from '@cindy/app-runtime/makerSendTransaction';
import { validateExtraDirs } from './extraDirsValidator.js';
export const prepareDirectoryGrantsForBootstrap = (opts: Parameters<typeof prepareGrants>[0], deps: Parameters<typeof prepareGrants>[1]) => prepareGrants(opts, deps, (...args) => validateExtraDirs(args[0], args[1], args[2]));
export function createMakerSendTransaction(deps: MakerSendTransactionDeps) {
  return createTransaction(deps, {
    getResolvedMainLocale: () => getResolvedMainLocale(),
    channelTurnSourceFor: (...args) => channelTurnSourceFor(...args),
    withChannelTurnSource: (...args) => withChannelTurnSource(...args),
    mcpAppModelContext: (...args) => mcpAppModelContext(...args),
  });
}
