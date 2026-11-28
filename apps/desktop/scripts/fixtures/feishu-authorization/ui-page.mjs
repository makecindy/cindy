import assert from 'node:assert/strict';

export default {
  name: 'feishu-authorization',
  entry: './fixture.tsx',
  viewport: { width: 660, height: 850 },
  real: 'FeishuBotSection, FeishuBotQrConfig, both Feishu hooks, QR generation and translations',
  notCovered:
    'Live Feishu authorization, browser navigation, credentials, bot provisioning and WebSocket handshake',
  stubs: {
    'src/renderer/components/settings/ImDefaultSettingsSection':
      'export const ImDefaultSettingsSection = () => null;',
    'src/renderer/components/settings/FeishuBotNotificationSection':
      'export const FeishuBotNotificationSection = () => null;',
  },
  cases: {
    default: { about: 'Authorize by QR or link, then cancel', data: {} },
    narrow: {
      about: 'Authorization fits a 320px settings panel',
      data: {},
      viewport: { width: 320, height: 850 },
    },
    lark: { about: 'Authorize a Lark bot', data: { lark: true } },
    denied: { about: 'Denied authorization offers another attempt', data: { denied: true } },
  },
  async ready(page) {
    await page.getByRole('button', { name: /.+/ }).first().waitFor();
  },
  async check(page, ui) {
    await page
      .getByRole('button', { name: await ui.t('settings.feishuBot.qr.begin'), exact: true })
      .click();
    await page.getByAltText(await ui.t('settings.feishuBot.qr.qrAlt')).waitFor();
    assert.equal(await page.getByRole('textbox').count(), 0);
    assert.ok(
      await page
        .getByRole('button', { name: await ui.t('settings.feishuBot.qr.openLink'), exact: true })
        .isEnabled(),
    );
    await ui.capture('authorize');
    if (ui.data.denied) {
      await ui.emit('feishu-registration', {
        status: 'error',
        // runId 必须与 registrationBegin 返回的一致: renderer 据此判定结果
        // 属于当前这一轮，带不上就会被当作旧轮次收尾而忽略。
        runId: 1,
        error: 'Authorization denied (fixture)',
      });
      await page.getByRole('alert').waitFor();
    } else {
      await page
        .getByRole('button', { name: await ui.t('settings.feishuBot.qr.cancel'), exact: true })
        .click();
    }
    await page
      .getByRole('button', { name: await ui.t('settings.feishuBot.qr.retry'), exact: true })
      .waitFor();
    assert.equal(await page.getByAltText(await ui.t('settings.feishuBot.qr.qrAlt')).count(), 0);
  },
};
