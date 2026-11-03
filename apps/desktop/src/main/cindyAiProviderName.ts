import { cindyAiAccountName, cindyAiAccountLogoKind } from '../shared/cindyAiPresentation.js';
import { getAuthState } from './authManager.js';
import { t } from './i18n.js';

/** Read the current account each time; this name is safe to send to remote clients. */
export function getCindyAiProviderName(): string {
  const state = getAuthState();
  return cindyAiAccountName(state.mode === 'cloud' ? state.user : null, t);
}

/** Use the source host's live membership, including remote catalog requests. */
export function getCindyAiProviderLogoKind(): 'xd' | 'cindy' {
  const state = getAuthState();
  return cindyAiAccountLogoKind(state.mode === 'cloud' ? state.user : null);
}
