import assert from 'node:assert/strict';

export default {
  name: 'ssh-authentication',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 640 },
  real: 'SshAuthenticationForm, Input, FormField, Button and Radix modal',
  notCovered: 'Real SSH transport and privileged IPC, covered by connection and broker tests',
  cases: {
    default: { about: 'One masked authentication code', data: {} },
    narrow: { about: 'Long server text and multiple prompts on a narrow window', viewport: { width: 320, height: 640 }, data: { multiple: true } },
  },
  async ready(page) { await page.getByRole('dialog').waitFor(); },
  async check(page, ui) {
    const button = await page.getByRole('button', { name: await ui.t('settings.remote.authentication.submit') }).boundingBox();
    const dialog = await page.getByRole('dialog').boundingBox();
    assert(button && dialog && button.y >= dialog.y && button.y + button.height <= dialog.y + dialog.height,
      'Authentication actions stay visible inside the modal on narrow windows');
  },
};
