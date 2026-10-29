import { cindyAiAccountName } from '../shared/cindyAiPresentation.js';
import { getAuthState } from './authManager.js';
import { t } from './i18n.js';

/** Read the current account each time; this name is safe to send to remote clients. */
export function getCindyAiProviderName(): string {
  const state = getAuthState();
  return cindyAiAccountName(state.mode === 'cloud' ? state.user : null, t);
}
