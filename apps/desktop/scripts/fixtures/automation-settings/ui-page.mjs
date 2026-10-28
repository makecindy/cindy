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
    loading: {
      about:
        'Browser detection and computer configuration remain pending; other controls stay usable',
    },
    error: {
      about:
        'Backend configuration fails twice, showing localized recovery inside the browser card',
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
    if (ui.case === 'error') {
      await page
        .getByRole('button', { name: await ui.t('settings.computerUse.configurationRead.retry') })
        .waitFor();
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
