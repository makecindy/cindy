import assert from 'node:assert/strict';

export default {
  name: 'automation-settings',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 1000 },
  real: 'ComputerUseSection, independent configuration reads, localized loading/error rows and existing browser/computer/Android controls',
  notCovered:
    'Real IPC, browser discovery and device permissions; timeout and stale response behavior is covered by ComputerUseSection.browserHealth.test.tsx',
  cases: {
    default: { about: 'All settings loaded' },
    'driver-rate-limited': {
      about:
        'cua-driver installed, update check rate-limited by GitHub: the row names the rate limit instead of a generic failure',
    },
    loading: {
      about:
        'Browser detection and computer configuration remain pending; other controls stay usable',
    },
    error: {
      about:
        'Backend configuration fails twice, showing localized recovery inside the browser card',
    },
    'browser-updating': { about: 'Plugin update waits for browser work and reconnects without an outdated-plugin warning' },
    'browser-selection': { about: 'A changed extension source requires selection, not a plugin update' },
    'my-browser-disconnected': { about: 'Disconnected extension is not presented as missing or requiring reinstall' },
    'my-browser-probe-failed': { about: 'Probe failure does not show the extension store instruction' },
    'my-browser': {
      about: 'My browser selected while login copying is on; the login copy switch stays hidden',
    },
  },
  async check(page, ui) {
    const browser = page.getByRole('switch', {
      name: await ui.t('settings.computerUse.browser.toggleAria'),
    });
    await browser.waitFor();
    await page.waitForFunction(
      () => !document.querySelector('#automation-browser button[role="switch"]')?.disabled,
    );
    assert.ok(await browser.isEnabled());
    assert.ok(
      await page
        .getByText(await ui.t('settings.computerUse.android.title'), { exact: true })
        .isVisible(),
    );
    const loginCopy = page.getByRole('switch', {
      name: await ui.t('settings.computerUse.realProfile.toggleAria'),
    });
    if (ui.case === 'default') await loginCopy.waitFor();
    if ((ui.case.startsWith('my-browser') || ['browser-updating', 'browser-selection'].includes(ui.case))) {
      await page
        .getByRole('radio', {
          name: await ui.t('settings.computerUse.browserBackend.userBrowser.title'),
          checked: true,
        })
        .waitFor();
      assert.equal(await loginCopy.count(), 0);
    }
    if (ui.case === 'browser-updating' || ui.case === 'browser-selection') {
      const prefix = 'settings.computerUse.browserBackend.userBrowserSetup.';
      await page.getByText(await ui.t(prefix + (ui.case === 'browser-updating' ? 'updatingTitle' : 'selectPluginTitle')), { exact: true }).waitFor();
      assert.equal(await page.getByText(await ui.t(prefix + 'updatePluginTitle'), { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: await ui.t(prefix + 'selectPlugin'), exact: true }).count(), ui.case === 'browser-updating' ? 0 : 1);
    }
    if (ui.case === 'my-browser-disconnected') {
      await page.getByText(await ui.t('settings.computerUse.browserBackend.userBrowserSetup.connectExtensionTitle'), { exact: true }).waitFor();
      assert.ok(await page.getByRole('button', { name: await ui.t('settings.computerUse.browserBackend.userBrowserSetup.openExtensionStore') }).isVisible());
    }
    if (ui.case === 'my-browser-probe-failed') {
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.computerUse.browserBackend.userBrowserSetup.openExtensionStore') }).count(), 0);
    }
    if (ui.case === 'error') {
      await page
        .getByRole('button', { name: await ui.t('settings.computerUse.configurationRead.retry') })
        .waitFor();
    }
    if (ui.case === 'driver-rate-limited') {
      await page
        .getByText(await ui.t('settings.computerUse.directControl.update.rateLimited'), {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByText(await ui.t('settings.computerUse.directControl.update.checkFailed'), {
            exact: true,
          })
          .count(),
        0,
      );
      assert.ok(
        await page
          .getByRole('button', {
            name: await ui.t('settings.computerUse.directControl.update.retry'),
          })
          .isVisible(),
      );
    }
    if (ui.case === 'loading') {
      assert.ok(
        await page
          .getByRole('switch', {
            name: await ui.t('settings.computerUse.directControl.toggleAria'),
          })
          .isDisabled(),
      );
      assert.equal(
        await page
          .getByText(await ui.t('settings.computerUse.browser.notDetected'), { exact: true })
          .count(),
        0,
      );
    }
  },
};
