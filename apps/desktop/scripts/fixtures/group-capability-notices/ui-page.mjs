export default {
  name: 'group-capability-notices', entry: './fixture.tsx', viewport: { width: 760, height: 520 },
  real: 'BotGroupCapabilityNotice as used in BotGroupTimelineItem; theme, type and all supported translations',
  notCovered: 'The complete group timeline, IPC, network delivery, server permissions, native mobile UI and attachment IO',
  cases: { default: { about: 'Three distinct non-terminal operation reasons with recovery advice' },
    attachments: { about: 'Download failures, attachment limits and both reasons together' } },
  async check(page, ui) {
    const codes = ui.case === 'attachments'
      ? ['ATTACHMENTS_DOWNLOAD_FAILED', 'ATTACHMENTS_LIMIT_REACHED', 'ATTACHMENTS_DOWNLOAD_FAILED_AND_LIMIT_REACHED']
      : ['GROUP_AUTHORIZATION_REQUIRED', 'GROUP_AUTHORIZATION_UNAVAILABLE', 'ATTACHMENTS_UNAVAILABLE'];
    for (const code of codes)
      await page.getByText(await ui.t(`bots.groupChat.notice.capability.${code}`, { name: 'Aster' }), { exact: true }).waitFor();
  },
};
