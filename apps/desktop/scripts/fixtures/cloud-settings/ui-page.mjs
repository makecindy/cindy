import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Expand Vite's eager glob for this esbuild-only fixture. Keep the actual catalog
// implementation and every real sidecar; do not replace search behavior with mocks.
const settingsDir = fileURLToPath(
  new URL('../../../src/renderer/components/settings/', import.meta.url),
);
const searchFiles = readdirSync(settingsDir, { recursive: true })
  .filter((name) => name.endsWith('.settings-search.ts'))
  .sort();
const imports = searchFiles
  .map(
    (name, index) => `import search${index} from ${JSON.stringify(path.join(settingsDir, name))};`,
  )
  .join('\n');
const catalog =
  imports +
  '\n' +
  readFileSync(path.join(settingsDir, 'settingsSearchCatalog.ts'), 'utf8')
    .replace(
      /const modules = import\.meta\.glob[^;]+;/,
      `const modules = {${searchFiles.map((_, index) => `search${index}`).join(',')}};`,
    )
    .replaceAll(
      "'./settingsSearchTypes'",
      JSON.stringify(path.join(settingsDir, 'settingsSearchTypes')),
    );
export default {
  name: 'cloud-settings',
  entry: './fixture.tsx',
  viewport: { width: 1040, height: 800 },
  real: 'CloudSettingsPanel, NativeCloudSections and shared native settings views, sidebar and search',
  notCovered:
    'Uses in-memory cloud state. No real CIS, login, credentials or runtime changes; bot forms use synthetic tickets, without real authorization or credential persistence.',
  stubs: {
    'src/renderer/components/settings/settingsSearchCatalog': catalog,
    'src/renderer/contexts/AuthContext':
      'export const useAuth=()=>({mode:"cloud",isAuthenticated:true,dataOwnerId:"fixture-owner",dataOwnerGeneration:1}); export const useOptionalAuthDeviceId=()=>null; export const useOptionalAuthUser=()=>null; export const useOptionalDataOwnerGeneration=()=>1;',
    // Voice input is not mounted here; its worklet needs Vite's ?url asset loader.
    'src/renderer/voice-input/workletUrl':
      'export function getVoiceInputWorkletUrl(){return "http://cindy-ui.test/unused-worklet.js";}',
  },
  cases: {
    shown: {
      about:
        'Every supported category in the local order, then More settings, against the instance catalog',
      data: { shown: true },
    },
    'shown-narrow': {
      about: 'The shown categories at a narrow desktop window',
      data: { shown: true },
      viewport: { width: 760, height: 850 },
    },
    offline: {
      about: 'An unreachable instance points at its device card',
      data: { shown: true, offline: true },
    },
    'im-read-failure': {
      about:
        'Native new-conversation section remains visible on failed cloud reads and recovers after retry',
      data: { bots: true, imReadFailure: true },
    },
    'im-notifications': {
      about: 'WeCom group webhook and Feishu/Discord notices inside the native channel cards',
      data: { bots: true, imNotifications: true },
    },
    'im-preferences': {
      about: 'Target IM defaults and personal Telegram group controls',
      data: { bots: true, imPreferences: true },
    },
    appearance: {
      about:
        'Window-only appearance stays with the remote desktop; per-field override and reset on a built-in tool',
      data: { appearance: true },
    },
    pages: {
      about: 'Tools, automation, storage and about reuse the local page frames',
      data: { pages: true },
      viewport: { width: 1040, height: 900 },
    },
    bots: { about: 'All six personal bot channels and credential forms', data: { bots: true } },
    default: {
      about:
        'Cloud language reuses native settings; the send shortcut stays with the remote desktop; LSP override and reset',
    },
    personalization: {
      about: 'Cloud shell, tips and reset controls reuse native settings; link opening stays with the remote desktop',
      data: { personalization: true },
    },
    unavailable: {
      about: 'An unavailable group leaves its neighbour usable; a missing saved shell remains visible',
      data: { personalization: true, unavailable: true },
    },
    'read-failed': {
      about: 'Reading keeps failing after three automatic reconnects: an error notice with a reload',
      data: { readBroken: true, live: true },
    },
    'domain-unreadable': {
      about: 'One group the instance does not answer: read again three times, then a notice named after it, in its place',
      data: { domainUnreadable: true, live: true },
    },
    'providers-unreadable': {
      about: 'The model provider list cannot be read: the local catalog notice under the title with a retry',
      data: { shown: true, providersUnreadable: true },
    },
    'header-default-name': {
      about: 'An instance with the default name: the page notice names it once',
      data: { defaultName: true },
    },
    'search-prompt': {
      about:
        'Searching the custom prompt opens Personalization with the local page offset and highlight',
      data: { searchPrompt: true },
    },
    narrow: {
      about: 'Cloud controls and dropdowns at a narrow desktop window',
      viewport: { width: 760, height: 850 },
    },
  },
  async ready(page) {
    await page
      .locator('#settings-search-target-general-language [role="combobox"], #settings-tab-more')
      .first()
      .waitFor();
  },
  async check(page, ui) {
    if (ui.data.offline) {
      await page
        .getByRole('button', { name: await ui.t('settings.tabs.remoteControl'), exact: true })
        .waitFor();
      await ui.capture('providers');
      await page
        .getByRole('tab', { name: await ui.t('cloudSettings.moreSettings'), exact: true })
        .click();
      await ui.capture('more');
      return;
    }
    if (ui.data.providersUnreadable) {
      await page.getByRole('tab', { name: await ui.t('settings.tabs.providers'), exact: true }).click();
      // The local page's notice for a model list it cannot update.
      const notice = page.getByRole('status').filter({
        hasText: await ui.t('settings.providers.catalogRecovery.catalog'),
      });
      await notice.waitFor();
      await notice
        .getByRole('button', { name: await ui.t('settings.providers.catalogRecovery.retry'), exact: true })
        .waitFor();
      assert.equal(await page.getByText('DEVICE_LINK_TIMEOUT').count(), 0);
      await ui.capture('providers-unreadable');
      return;
    }
    if (ui.data.shown) {
      // No overview (it is the device card's Update dialog). Plugins shows the remote
      // plugin page.
      assert.deepEqual(
        await page.getByRole('tab').allInnerTexts(),
        await Promise.all(
          [
            'settings.tabs.general',
            'settings.tabs.personalization',
            'settings.tabs.providers',
            'settings.tabs.imBot',
            'settings.tabs.ghosts',
            'settings.tabs.builtinTools',
            'settings.tabs.computerUse',
            'settings.tabs.storage',
            'settings.tabs.about',
            'cloudSettings.moreSettings',
          ].map((key) => ui.t(key)),
        ),
      );
      const general = page.getByRole('tab', { name: await ui.t('settings.tabs.general'), exact: true });
      assert.equal(await general.getAttribute('aria-selected'), 'true');
      await page.locator('#settings-panel-general #settings-collaboration').waitFor();
      await ui.capture('sidebar');
      await page.getByRole('tab', { name: await ui.t('settings.tabs.providers'), exact: true }).click();
      await page.getByText('Cloud model', { exact: true }).waitFor();
      await page.getByText('Shared Claude', { exact: true }).waitFor();
      // Sharing, joining by link and the instance's CLI suggestions are shown, as on this computer.
      await page.getByTestId('provider-share-paste-button').waitFor();
      await page.getByText(await ui.t('cloudSettings.cliDetect.groupLabel'), { exact: true }).waitFor();
      assert.equal(
        await page.getByText(await ui.t('settings.providers.detect.groupLabel'), { exact: true }).count(),
        0,
      );
      await ui.capture('providers');
      await page.getByRole('tab', { name: await ui.t('settings.tabs.imBot'), exact: true }).click();
      await page.getByText(await ui.t('settings.feishuBot.title'), { exact: true }).waitFor();
      await ui.capture('im-bot');
      await page
        .getByRole('tab', { name: await ui.t('settings.tabs.personalization'), exact: true })
        .click();
      await page.locator('#settings-search-target-personalization-memory').waitFor();
      assert.equal(await page.locator('#settings-panel-personalization #settings-bots').count(), 0);
      await ui.capture('personalization');
      await page
        .getByRole('tab', { name: await ui.t('cloudSettings.moreSettings'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await ui.t('cloudSettings.openInCloudDesktop'), exact: true })
        .waitFor();
      await ui.capture('more');
      return;
    }
    if (ui.data.domainUnreadable) {
      // In place of the group, named as on the page: 「读不到 Agent 资源占用设置」.
      const title = await ui.t('cloudSettings.groupReadFailed', {
        names: ` ${await ui.t('settings.agentResource.title')}`,
      });
      const place = page.locator('#settings-agent-resource-unreadable');
      // The failure sits in the group's heading row, with an icon-only retry.
      const notice = place.locator('[data-cloud-group-status]');
      // Not before the three automatic reads (about seven seconds).
      await page.waitForTimeout(1_000);
      assert.equal(await place.count(), 0);
      await notice.waitFor({ timeout: 15_000 });
      assert.equal((await notice.textContent()).trim(), title.trim());
      await notice.getByRole('button', { name: await ui.t('commonUi.retry'), exact: true }).waitFor();
      assert.equal(await place.getByText('SETTINGS_REQUEST_FAILED').count(), 0);
      // Right after Collaboration, where Agent resources would be; none of its controls show.
      assert.equal(await place.evaluate((el) => el.previousElementSibling?.id), 'settings-collaboration');
      assert.equal(await page.locator('#settings-agent-resource').count(), 0);
      // The rest of the category reads; no page-wide or generic notice.
      await page.locator('#settings-search-target-general-language [role="combobox"]').waitFor();
      // Only that group says so: the page notice stays as it is.
      assert.equal(await page.getByText(await ui.t('bots.remoteSettings.loadFailed')).count(), 0);
      await place.scrollIntoViewIfNeeded();
      await ui.capture('domain-unreadable');
      return;
    }
    if (ui.data.readBroken) {
      // Three reconnects (about seven seconds) before the page says it cannot read.
      // The page's one notice says so (rule 4: each state in one place), with its retry.
      const notice = page.getByRole('status').filter({ hasText: await ui.t('bots.remoteSettings.loadFailed') });
      await notice.waitFor({ timeout: 15_000 });
      const retry = await ui.t('settings.ghosts.remote.retry');
      await notice.getByRole('button', { name: retry, exact: true }).waitFor();
      assert.equal(await page.getByText('CLOUD_SETTINGS_SCOPE_CHANGED').count(), 0);
      // No retry in the sidebar.
      assert.equal(await page.locator('aside').getByRole('button', { name: retry, exact: true }).count(), 0);
      await ui.capture('read-failed');
      return;
    }
    if (ui.data.defaultName) {
      const name = await ui.t('cloudSettings.onboarding.defaultNameSole');
      const notice = page.getByRole('status').filter({
        hasText: await ui.t('settings.ghosts.remote.managingTarget', { device: name }),
      });
      await notice.waitFor();
      // Named once, in the title; the line below says what the page is doing.
      assert.equal((await notice.innerText()).split(name).length - 1, 1);
      await notice.getByText(await ui.t('cloudSettings.trial'), { exact: true }).waitFor();
      await ui.capture('header');
      return;
    }
    if (ui.data.searchPrompt) {
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      await search.fill(await ui.t('settings.personalization.subtitle'));
      await page.locator('[id="settings-search-result-personalization.instructions"]').click();
      // As on the local settings page: the shared section hook marks the
      // prompt field and scrolls it to 8 px below the top of the scroll area, which lies under the
      // page header rather than behind it.
      await page.waitForFunction(() => {
        const field = document.getElementById('settings-user-instructions');
        const scroller = field?.closest('.overflow-y-auto');
        if (!field?.classList.contains('settings-search-target-highlight') || !scroller) return false;
        const offset = field.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        return Math.abs(offset - 8) < 2;
      });
      await ui.capture('search-prompt');
      return;
    }
    if (ui.data.pages) {
      // Subagent pickers read the target catalog over DeviceLink.
      for (const [tab, anchor] of [
        ['settings.tabs.personalization', '#settings-search-target-personalization-subagents'],
      ]) {
        await page.getByRole('tab', { name: await ui.t(tab), exact: true }).click();
        await page.locator(anchor).scrollIntoViewIfNeeded();
        await ui.capture(anchor.slice(1));
      }
      for (const [tab, ready] of [
        ['settings.tabs.builtinTools', 'settings.builtinTools.plugins.browser.name'],
        ['settings.tabs.computerUse', 'settings.computerUse.directControl.title'],
        ['settings.tabs.storage', 'settings.about.storage.databaseSectionTitle'],
        ['settings.tabs.about', 'settings.about.analyticsLabel'],
      ]) {
        await page.getByRole('tab', { name: await ui.t(tab), exact: true }).click();
        await page
          .getByText(await ui.t(ready), { exact: true })
          .first()
          .waitFor();
        await ui.capture(tab.split('.').pop());
        // A cloud instance cannot reach the user's Android devices.
        if (tab === 'settings.tabs.computerUse')
          assert.equal(
            await page
              .getByText(await ui.t('settings.computerUse.android.title'), { exact: true })
              .count(),
            0,
          );
      }
      return;
    }
    if (ui.data.appearance) {
      // Theme, fonts and reply animation only change the instance's own window: no tab here.
      assert.equal(
        await page.getByRole('tab', { name: await ui.t('settings.tabs.appearance'), exact: true }).count(),
        0,
      );
      await page
        .getByRole('tab', { name: await ui.t('settings.tabs.builtinTools'), exact: true })
        .click();
      const name = await ui.t('settings.builtinTools.plugins.docs.name');
      const toggle = page.getByRole('switch', {
        name: await ui.t('settings.builtinTools.toggleAria', { name }),
      });
      const before = await toggle.getAttribute('aria-checked');
      await toggle.click();
      assert.notEqual(await toggle.getAttribute('aria-checked'), before);
      const row = page.locator('li, [role="listitem"], div').filter({ has: toggle }).last();
      const reset = row.getByRole('button', { name: await ui.t('settings.defaults.restore'), exact: true });
      await reset.waitFor();
      await ui.capture('tool-customized');
      await reset.click();
      await reset.waitFor({ state: 'hidden' });
      assert.equal(await toggle.getAttribute('aria-checked'), before);
      await ui.capture('tool-default');
    } else if (ui.data.imReadFailure) {
      await page.getByRole('tab', { name: await ui.t('settings.tabs.imBot'), exact: true }).click();
      await page.getByText(await ui.t('settings.wechatBot.title'), { exact: true }).click();
      const defaults = page.getByRole('region', {
        name: await ui.t('settings.imBot.defaults.title'),
      });
      const failed = defaults.getByText(await ui.t('cloudSettings.imReadFailed'), { exact: true });
      await failed.waitFor();
      // Still there after the page's automatic re-reads (about seven seconds).
      await page.waitForTimeout(8_000);
      await failed.waitFor();
      await defaults.scrollIntoViewIfNeeded();
      await ui.capture('im-read-failed');
      await defaults.getByRole('button', { name: await ui.t('commonUi.retry'), exact: true }).click();
      await failed.waitFor({ state: 'hidden' });
      await defaults
        .getByText(await ui.t('settings.imBot.defaults.modelLabel'), { exact: true })
        .waitFor();
      await ui.capture('im-read-recovered');
    } else if (ui.data.imNotifications) {
      await page.getByRole('tab', { name: await ui.t('settings.tabs.imBot'), exact: true }).click();
      await page.getByText(await ui.t('settings.wecomBot.title'), { exact: true }).click();
      const webhook = page.getByLabel(await ui.t('settings.notifications.wecomGroupLabel'), {
        exact: true,
      });
      await webhook.scrollIntoViewIfNeeded();
      // The URL is stored on the target, so the hint names it instead of "this device".
      await page
        .getByText(await ui.t('cloudSettings.wecomGroupHint', { name: 'Cloud example' }), {
          exact: true,
        })
        .waitFor();
      await ui.capture('wecom-webhook');
      // Trial tickets only: nothing is sent and no real webhook is stored.
      await webhook.fill('https://example.invalid/cgi-bin/webhook/send?key=fixture');
      await page
        .getByRole('button', { name: await ui.t('settings.notifications.wecomGroupSaveAndTest') })
        .click();
      const test = page.getByRole('button', {
        name: await ui.t('settings.notifications.wecomGroupTest'),
      });
      await test.waitFor();
      await test.scrollIntoViewIfNeeded();
      await ui.capture('wecom-configured');
      await page.getByText(await ui.t('settings.discordBot.title'), { exact: true }).click();
      await page
        .getByText(await ui.t('settings.discordBot.title'), { exact: true })
        .scrollIntoViewIfNeeded();
      await ui.capture('discord-unconfigured');
    } else if (ui.data.imPreferences) {
      await page.getByRole('tab', { name: await ui.t('settings.tabs.imBot'), exact: true }).click();
      await page.getByText(await ui.t('settings.telegramBot.title'), { exact: true }).click();
      const defaults = page.getByRole('region', {
        name: await ui.t('settings.imBot.defaults.title'),
      });
      await defaults.scrollIntoViewIfNeeded();
      await ui.capture('im-default-model');
      const group = page.getByRole('radiogroup', {
        name: `Cloud group · ${await ui.t('settings.telegramBot.groups.title')}`,
      });
      await group
        .getByRole('radio', {
          name: await ui.t('settings.telegramBot.groups.mode.always'),
          exact: true,
        })
        .click();
      assert.equal(
        await group
          .getByRole('radio', {
            name: await ui.t('settings.telegramBot.groups.mode.always'),
            exact: true,
          })
          .getAttribute('aria-checked'),
        'true',
      );
      await ui.capture('telegram-group-always');
    } else if (ui.data.bots) {
      await page.getByRole('tab', { name: await ui.t('settings.tabs.imBot'), exact: true }).click();
      for (const channel of ['wechat', 'wecom', 'feishu', 'dingtalk', 'discord', 'telegram'])
        await page.getByText(await ui.t(`settings.${channel}Bot.title`), { exact: true }).waitFor();
      await ui.capture('all-channels');
      await page.getByText(await ui.t('settings.feishuBot.title'), { exact: true }).click();
      await page.getByLabel(await ui.t('settings.feishuBot.appIdLabel'), { exact: true }).waitFor();
      await page
        .getByLabel(await ui.t('settings.feishuBot.appSecretLabel'), { exact: true })
        .scrollIntoViewIfNeeded();
      await ui.capture('feishu-form');
    } else if (ui.data.personalization) {
      await page
        .getByRole('tab', { name: await ui.t('settings.tabs.personalization'), exact: true })
        .click();
      const terminal = page.getByRole('combobox', {
        name: await ui.t('settings.terminalShell.card.selectAria'),
      });
      await terminal.waitFor();
      await terminal.scrollIntoViewIfNeeded();
      await ui.capture('terminal');
      if (ui.data.unavailable) {
        assert.ok((await terminal.textContent()).includes('fish'));
        // The unavailable group is left out; the tips row beside it keeps working.
        assert.equal(
          await page
            .getByRole('switch', { name: await ui.t('settings.chatEmbedding.toggleAria') })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole('switch', { name: await ui.t('settings.silentEncryptedRetry.toggleAria') })
            .isEnabled(),
          true,
        );
      }
      await terminal.click();
      await ui.capture('shell-choices');
      await page.keyboard.press('Escape');
      // Link opening only changes the instance's own window.
      assert.equal(
        await page.locator('#settings-search-target-personalization-link-open').count(),
        0,
      );
      const tips = page.locator('#settings-search-target-personalization-tips');
      const retry = tips.getByRole('switch', {
        name: await ui.t('settings.silentEncryptedRetry.toggleAria'),
      });
      const before = await retry.getAttribute('aria-checked');
      await retry.click();
      const reset = tips.getByRole('button', {
        name: await ui.t('settings.defaults.restore'),
        exact: true,
      });
      await reset.first().waitFor();
      await tips.scrollIntoViewIfNeeded();
      await ui.capture('tips-customized');
      await reset.first().click();
      await reset.first().waitFor({ state: 'hidden' });
      assert.equal(await retry.getAttribute('aria-checked'), before);
      await ui.capture('tips');
    } else {
      const language = page.getByRole('combobox', {
        name: await ui.t('settings.language.ariaLabel'),
      });
      const textWidth = await page
        .locator('#settings-language')
        .getByText(await ui.t('settings.language.hint'), { exact: true })
        .evaluate((element) => element.getBoundingClientRect().width);
      assert.ok(textWidth >= 180, `Language explanation must remain readable: ${textWidth}px`);
      const triggerBox = await language.boundingBox();
      await language.click();
      const menuBox = await page.getByRole('listbox').boundingBox();
      assert.ok(
        triggerBox && menuBox && Math.abs(triggerBox.width - menuBox.width) <= 2,
        'Language menu follows trigger width',
      );
      await ui.capture('languages');
      await page.keyboard.press('Escape');
      // The send shortcut only changes the instance's own window.
      assert.equal(await page.locator('#settings-composer').count(), 0);
      const lsp = page.getByRole('switch', { name: await ui.t('settings.lspMode.toggleAria') });
      const before = await lsp.getAttribute('aria-checked');
      await lsp.click();
      const reset = page
        .locator('#settings-search-target-general-experimental')
        .getByRole('button', { name: await ui.t('settings.defaults.restore'), exact: true });
      await reset.waitFor();
      assert.notEqual(await lsp.getAttribute('aria-checked'), before);
      await lsp.scrollIntoViewIfNeeded();
      await ui.capture('lsp-customized');
      await reset.click();
      await reset.waitFor({ state: 'hidden' });
      assert.equal(await lsp.getAttribute('aria-checked'), before);
    }
  },
};
