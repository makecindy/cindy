import { t } from '../i18n.js';
import { renderGhostInstallConsentText as render, buildGhostInstallConsentInteraction as build, createTaskInstallConsentPrompt as create } from '@cindy/plugin-runtime/ghostInstallConsentInteraction';
export { GHOST_INSTALL_CONSENT_HOST_CONFIRMATION, ghostInstallTargetText, ghostInstallConsentSourceText } from '@cindy/plugin-runtime/ghostInstallConsentInteraction';
export type { HostPermissionRequester } from '@cindy/plugin-runtime/ghostInstallConsentInteraction';
export const renderGhostInstallConsentText = (request: Parameters<typeof render>[0], translate = t) => render(request, translate);
export const buildGhostInstallConsentInteraction = (id: string, request: Parameters<typeof build>[1], translate = t) => build(id, request, translate);
export const createTaskInstallConsentPrompt = (task: Parameters<typeof create>[0], requester: Parameters<typeof create>[1]) => create(task, requester, t);
