import assert from 'node:assert/strict';

export default {
  name: 'feishu-connection',
  entry: './fixture.tsx',
  viewport: { width: 660, height: 620 },
  real: 'FeishuBotSection, useFeishuBot, ImChannelSettingsCard, ErrorNotice, Button and translated recovery text',
  notCovered:
    'Live Feishu network, credential writes and model/notification settings; transport recovery has targeted unit tests',
  stubs: {
    'src/renderer/components/settings/ImDefaultSettingsSection':
      'export const ImDefaultSettingsSection = () => null;',
    'src/renderer/components/settings/FeishuBotNotificationSection':
      'export const FeishuBotNotificationSection = () => null;',
  },
  cases: {
    unbound: {
      about: 'Unbound form: app setup hint, create link and collapsed steps',
      viewport: { width: 660, height: 760 },
      data: { status: 'idle', hasSecret: false, appId: '', ownerOpenId: null },
    },
    default: {
      about: 'Timeout explains recovery and exposes reconnect',
      data: { error: 'Timed out waiting for connection (no onReady).' },
    },
    network: {
      about: 'Network failure has a specific explanation',
      data: { error: 'connect ECONNREFUSED' },
    },
    credentials: {
      about: 'Invalid credentials do not receive network advice',
      data: { error: 'App ID / App Secret 不正确（auth_failed）' },
    },
    unknown: {
      about: 'Unknown cause stays neutral',
      data: { error: 'Unexpected connection failure' },
    },
    conflict: {
      about: 'Device conflict preserves the binding',
      data: { status: 'conflict', error: 'exceed_conn_limit' },
    },
    reconnecting: { about: 'Automatic recovery shows progress', data: { status: 'reconnecting' } },
    connected: {
      about: 'Healthy connection retains a quiet reconnect action',
      data: { status: 'connected' },
    },
    narrow: {
      about: 'Recovery actions wrap at 320px',
      viewport: { width: 320, height: 760 },
      data: { error: 'connect ETIMEDOUT' },
    },
  },
  async ready(page) {
    await page.locator('#personal-im-feishu').waitFor();
  },
  async check(page, ui) {
    const card = page.locator('#personal-im-feishu');
    if (ui.case === 'unbound') {
      await card
        .getByText(await ui.t('bots.channels.add.feishu.stepCreate'), { exact: true })
        .waitFor();
      assert.ok(
        await card
          .getByRole('button', {
            name: await ui.t('settings.feishuBot.createLink', {
              service: await ui.t('settings.feishuBot.services.feishu'),
            }),
          })
          .isVisible(),
      );
      assert.ok(
        await card
          .getByRole('button', { name: await ui.t('settings.feishuBot.bind'), exact: true })
          .isVisible(),
      );
      const steps = card.getByRole('button', {
        name: await ui.t('bots.channels.add.feishu.stepsLabel'),
        exact: true,
      });
      assert.equal(await steps.getAttribute('aria-expanded'), 'false');
      assert.equal(
        await card.getByText(await ui.t('settings.feishuBot.setup.afterBind'), { exact: true }).count(),
        0,
      );
      await steps.click();
      assert.equal(await steps.getAttribute('aria-expanded'), 'true');
      await card
        .getByText(await ui.t('settings.feishuBot.setup.afterBind'), { exact: true })
        .waitFor();
      await ui.capture('expanded');
      return;
    }
    const connectionCard = page.locator('[data-feishu-connection-card]');
    const reconnect = connectionCard.getByRole('button', {
      name: await ui.t('settings.feishuBot.connected.reconnect', {
        service: await ui.t('settings.feishuBot.services.feishu'),
      }),
      exact: true,
    });
    assert.ok(await reconnect.isVisible());
    assert.ok(await reconnect.isEnabled());
    const notes = {
      default: 'timeoutErrorNote',
      narrow: 'timeoutErrorNote',
      network: 'networkErrorNote',
      credentials: 'credentialsErrorNote',
      unknown: 'errorNote',
      conflict: 'conflictNote',
      reconnecting: 'reconnectingNote',
    };
    if (notes[ui.case])
      assert.ok(
        await connectionCard
          .getByText(await ui.t(`settings.feishuBot.saved.${notes[ui.case]}`), { exact: true })
          .isVisible(),
      );
    if (ui.data.error) {
      const details = connectionCard.getByRole('button', {
        name: await ui.t('chat.errorBanner.networkShowRaw'),
        exact: true,
      });
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      await details.click();
      assert.equal(await connectionCard.locator('pre').innerText(), ui.data.error);
    }
    if (ui.case === 'default') {
      await ui.emit('feishu-status', {
        status: 'connected',
        botAppId: 'cli_example1234567890',
        ownerOpenId: 'ou_example1234567890',
      });
      await connectionCard
        .getByText(
          await ui.t('settings.feishuBot.connected.heading', {
            service: await ui.t('settings.feishuBot.services.feishu'),
          }),
          { exact: true },
        )
        .waitFor();
      assert.equal(await connectionCard.locator('pre').count(), 0);
      await ui.capture('recovered');
    }
    await reconnect.click();
    assert.ok(await reconnect.isDisabled());
    assert.ok(
      await page
        .getByRole('status', {
          name: await ui.t('settings.feishuBot.statusAria', {
            status: await ui.t('settings.feishuBot.status.connecting'),
          }),
          exact: true,
        })
        .isVisible(),
    );
    assert.ok(
      await connectionCard
        .getByText(await ui.t('settings.feishuBot.status.connecting'), { exact: true })
        .isVisible(),
    );
  },
};
