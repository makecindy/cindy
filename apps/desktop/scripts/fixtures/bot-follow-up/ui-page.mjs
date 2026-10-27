import assert from 'node:assert/strict';
export default {
  name: 'bot-follow-up',
  entry: './follow-up-fixture.tsx',
  viewport: { width: 580, height: 400 },
  real: 'BotFollowUpInvitation, BotAutonomySettings, botStore settings subscription, buttons and confirmation dialog',
  notCovered: 'Real message delivery, scheduler execution, account persistence and Mobile. The send action represents an accepted user message.',
  stubs: {
    'src/renderer/features/bots/botStore': { partial: 'export const useBotProfiles=()=>[{id:"cindy-default",name:"Cindy"}];' },
  },
  cases: {
    'before-chat': { about: 'Opening alone never invites; an accepted message reveals the invitation' },
    'remote': { about: 'Remote chat uses the same invitation with the host-owned scope and choice' },
    'default': { about: 'One-line invitation after an accepted user message; Start opens the settings confirmation with scope and model allowance before saving' },
    'settings-off': { about: 'Off by default; explain scope before enabling' },
    'settings-on': { about: 'An explicit choice is preserved; disabling is immediate' },
  },
  async ready(page) {
    await page.locator('[role="switch"], section[aria-label], [data-testid="send"]').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'before-chat') {
      assert.equal(await page.getByRole('region').count(), 0);
      await page.getByTestId('send').click();
      await page.getByRole('region').waitFor();
      await ui.capture('invitation');
    }
    if (ui.case === 'default' || ui.case === 'before-chat' || ui.case === 'remote') {
      await page.getByRole('button', { name: await ui.t('bots.autonomy.invitation.notNow'), exact: true }).click();
      await page.getByRole('region').waitFor({ state: 'detached' });
    } else if (ui.case === 'settings-off') {
      await page.getByRole('switch').first().click();
      await page.getByRole('alertdialog').waitFor();
      await ui.capture('consent');
      await page.getByRole('button', { name: await ui.t('bots.autonomy.invitation.start'), exact: true }).click();
      await page.locator('[role="switch"][aria-checked="true"]').waitFor();
    } else {
      await page.getByRole('switch').first().click();
      await page.locator('[role="switch"][aria-checked="false"]').waitFor();
      assert.equal(await page.getByRole('alertdialog').count(), 0);
    }
  },
};
