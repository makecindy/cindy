import type { NeutralHookProvider } from '../../shared/hookControlIpc.js';
import type { HookControlManager } from './manager.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { validateTelegramExternalUrl } from './telegramDeepLink.js';
import { validateXExternalUrl } from './xDeepLink.js';
import { validateFeishuExternalUrl } from './feishuDeepLink.js';
import { validateDiscordExternalUrl } from './discordDeepLink.js';

const validators: Record<NeutralHookProvider, (url: string) => string> = {
  telegram: validateTelegramExternalUrl,
  x: validateXExternalUrl,
  feishu: validateFeishuExternalUrl,
  discord: validateDiscordExternalUrl,
};

/** Resolve and validate the instance's current link before returning it to its controller. */
export function providerActionUrlFromIpc(
  manager: Pick<HookControlManager, 'providerActionUrl'>,
  provider: NeutralHookProvider,
  action: unknown,
): { url: string } {
  if (action !== 'connect' && action !== 'provider' && action !== 'add-to-group')
    throwIpcError('INVALID_PARAMS', 'invalid provider open action');
  const url = manager.providerActionUrl(provider, action);
  if (!url) throwIpcError('INVALID_PARAMS', 'provider action is not available');
  try {
    return { url: validators[provider](url) };
  } catch {
    throwIpcError('INVALID_PARAMS', 'invalid provider link');
  }
}
