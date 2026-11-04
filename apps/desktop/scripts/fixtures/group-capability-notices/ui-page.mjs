export default {
  name: 'group-capability-notices', entry: './fixture.tsx', viewport: { width: 760, height: 520 },
  real: 'BotGroupCapabilityNotice as used in BotGroupTimelineItem; theme, type and all supported translations',
  notCovered: 'The complete group timeline, IPC, network delivery, server permissions, native mobile UI and attachment IO',
  cases: { default: { about: 'Three distinct non-terminal operation reasons with recovery advice' } },
  async check(page, ui) {
    for (const code of ['GROUP_AUTHORIZATION_REQUIRED', 'GROUP_AUTHORIZATION_UNAVAILABLE', 'ATTACHMENTS_UNAVAILABLE'])
      await page.getByText(await ui.t(`bots.groupChat.notice.capability.${code}`, { name: 'Aster' }), { exact: true }).waitFor();
  },
};
