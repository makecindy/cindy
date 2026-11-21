import assert from 'node:assert/strict';

export default {
  name: 'side-chat',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 320 },
  real: 'SideChatTabBody promotion header, shared Button and translations',
  notCovered: 'Conversation editor, live database, device-link transport and mobile native layout',
  stubs: {
    'src/renderer/features/cc-agent/CCAgentSessionView': 'export const CCAgentSessionView = () => null;',
    'src/renderer/features/device-link/remoteProjectsStore': 'export const remoteProjectsStore = {};',
    'src/renderer/hooks/useWindowVisible': 'export const useWindowVisible = () => true; export const useDocumentVisible = () => true;',
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = {};',
    'src/renderer/lib/composerDraftStore': 'export const discardDraft = () => {};',
    'src/renderer/lib/sessionService': 'export const setStatus = () => {};',
    'src/renderer/lib/sidebarWindow': 'export const isSidebarWindow = () => false;',
    'src/renderer/features/right-sidebar/store': 'export const closeTab = () => {};',
    'src/renderer/features/right-sidebar/lib/mergeSidebarWindowBack': 'export const mergeSidebarWindowBack = () => {};',
  },
  cases: { default: { about: 'Convert a side chat at narrow panel width' } },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('chat.sideChat.promote'), exact: true }).click();
    assert.equal(await page.locator('body').getAttribute('data-promoted'), 'true');
    await page.getByRole('button', { name: await ui.t('chat.sideChat.openConversation'), exact: true }).waitFor();
  },
};
