import assert from 'node:assert/strict';

const narrow = { width: 320, height: 850 };
const HEADER = 'button[data-setting-id="imBot.discord.channels"]';
const T = 'settings.discordBot.channels';

export default {
  name: 'discord-channel-access',
  entry: './fixture.tsx',
  viewport: { width: 660, height: 850 },
  real: 'DiscordChannelAccessSection, useDiscordChannelAccess, server-level access transforms, settings rows, Switch, SegmentedControl, ErrorNotice and translations',
  notCovered:
    'Live Discord servers, the main-process allowlist store, the BotChannelsPage wrapper and the remote-computer operations',
  stubs: {},
  cases: {
    default: { about: 'personal: upgraded channel list = server on, selected channels', data: { kind: 'personal', access: 'selected' } },
    off: { about: 'personal: every server off; first enable opens all channels', data: { kind: 'personal', access: 'none' } },
    all: { about: 'personal: server covering all channels, more expanded', data: { kind: 'personal', access: 'all' } },
    closed: { about: 'personal: closed server keeps its selection; reopening restores it', data: { kind: 'personal', access: 'closed-with-selection' } },
    'selected-narrow': { about: 'personal: selected channels, more expanded, 320px', data: { kind: 'personal', access: 'selected' }, viewport: narrow },
    teammate: { about: 'teammate: server-level member switch under more', data: { kind: 'teammate', access: 'mixed' } },
    'teammate-narrow': { about: 'teammate: 320px, switch and more stay visible', data: { kind: 'teammate', access: 'mixed' }, viewport: narrow },
    'teammate-offline': { about: 'teammate bot not connected: saved allowlist, offline note', data: { kind: 'teammate', access: 'selected', online: false } },
    'teammate-unsupported': { about: 'older remote computer: upgrade message, no retry, no editing', data: { kind: 'teammate', access: 'none', unsupported: true } },
    empty: { about: 'bot is in no server yet', data: { kind: 'empty', access: 'none' } },
    error: { about: 'server list cannot be read', data: { kind: 'error', access: 'none' } },
  },
  // ready only receives the page: wait on the section's real header button by its stable
  // setting id (the visible title is translated per locale).
  async ready(page) {
    await page.locator(HEADER).waitFor();
  },
  async check(page, ui) {
    const { kind, access } = ui.data;
    await page.locator(HEADER).click();
    if (kind === 'empty') {
      await page.getByText(await ui.t(`${T}.empty`)).waitFor();
      return ui.capture('open');
    }
    if (kind === 'error') {
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByText(await ui.t(`${T}.summary.unknown`)).count(), 0);
      return ui.capture('open');
    }
    if (ui.data.unsupported) {
      await page.getByText(await ui.t(`${T}.error.unsupported`)).waitFor();
      assert.equal(await page.getByRole('switch').count(), 0);
      assert.equal(await page.getByRole('button', { name: await ui.t(`${T}.refresh`) }).count(), 0);
      return ui.capture('open');
    }
    await page.getByText('Design Team', { exact: true }).waitFor();
    const switches = page.getByRole('switch');
    if (access === 'none') {
      assert.equal(await switches.first().getAttribute('aria-checked'), 'false');
      await switches.first().click();
      await page.getByText(await ui.t(`${T}.guild.summary.all`)).waitFor();
      return ui.capture('opened-all');
    }
    if (access === 'closed-with-selection') {
      assert.equal(await switches.first().getAttribute('aria-checked'), 'false');
      await switches.first().click();
      await page.getByText(await ui.t(`${T}.guild.summary.selected`, { count: 1 })).waitFor();
      return ui.capture('reopened');
    }
    // The "more" entry sits on the same row as the server switch.
    const more = page.getByRole('button', { name: await ui.t(`${T}.guild.more`) }).first();
    await more.waitFor();
    assert.equal(await more.isVisible(), true);
    assert.equal(await switches.first().isVisible(), true);
    await more.click();
    if (access === 'selected') {
      await page.getByText('#general').waitFor();
      assert.equal(await page.getByText(await ui.t(`${T}.permission.cannotSend`)).count(), 1);
    } else {
      await page.getByText(await ui.t(`${T}.guild.allHint`)).waitFor();
    }
    await ui.capture('more-open');
    if (kind === 'teammate' && access === 'mixed') {
      // Server covering all channels: its own member switch (already allowed in this data).
      const members = page.getByRole('switch', {
        name: await ui.t(`${T}.members.guildAria`, { guild: 'Design Team' }),
      });
      assert.equal(await members.getAttribute('aria-checked'), 'true');
    }
  },
};
