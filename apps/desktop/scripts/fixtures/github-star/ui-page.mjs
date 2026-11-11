export default {
  name: 'github-star',
  entry: './fixture.tsx',
  viewport: { width: 520, height: 260 },
  real: 'Toast, Button, shared canvas confetti, quota rollup and QuotaBar',
  notCovered: 'GitHub authentication, network writes, real sending and persistent eligibility; covered by unit tests with fake dependencies',
  cases: {
    quota: { about: 'Small quota burst accompanying the quota reset rollup', viewport: { width: 720, height: 480 } },
    'quota-reduced': { about: 'Quota reveal without motion', viewport: { width: 720, height: 480 } },
    interactive: { about: 'Hands-on production notification flow with simulated GitHub responses', viewport: { width: 720, height: 480 } },
    default: { about: 'Persistent Star invitation with both dismissal controls' },
    busy: { about: 'Star request in flight' },
    celebration: { about: 'Real canvas-confetti: launch, flight and cleanup' },
    'celebration-reduced': { about: 'Reduced motion suppresses the confetti' },
    success: { about: 'Acknowledged Star' },
    fallback: { about: 'Direct Star unavailable; opening the GitHub repository' },
    'open-failed': { about: 'Browser could not open; retain a retryable GitHub link' },
    narrow: { about: 'Long translations wrap on a narrow window', viewport: { width: 320, height: 320 } },
  },
  async ready(page) {
    // The runner reduces motion by default; this fixture explicitly previews animation.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  },
  async check(page, ui) {
    if (ui.case.startsWith('quota')) {
      const reduced = ui.case === 'quota-reduced';
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.locator('[data-preview-quota]').click();
      if (reduced) {
        await page.getByText('100%', { exact: true }).waitFor();
        if (await page.locator('[data-confetti-burst]').count()) throw new Error('Quota confetti must skip reduced motion');
        await ui.capture('reduced');
        return;
      }
      await page.locator('[data-confetti-preset="quota"]').waitFor({ state: 'attached' });
      await page.waitForTimeout(300);
      await ui.capture('quota-flight-300');
      await page.waitForTimeout(600);
      await ui.capture('quota-flight-900');
      await page.locator('[data-confetti-burst]').waitFor({ state: 'detached' });
      await page.getByText('100%', { exact: true }).waitFor();
      await ui.capture('quota-finished');
      return;
    }
    if (ui.case === 'interactive') {
      const copy = key => page.evaluate(key => window.__uiPage.t(key), key);
      const action = page.getByRole('button', { name: await copy('githubStar.action'), exact: true });
      const before = await action.boundingBox();
      await action.click();
      const busy = page.getByRole('button', { name: await copy('githubStar.starring'), exact: true });
      await busy.waitFor();
      const after = await busy.boundingBox();
      if (!before || !after || Math.abs(before.width - after.width) > 0.5 || Math.abs(before.x - after.x) > 0.5) {
        throw new Error('Star button must retain its width and position while the request is pending');
      }
      await ui.capture('busy');
      await page.locator('[data-confetti-burst]').waitFor({ state: 'attached' });
      const acknowledgement = page.getByText(await copy('githubStar.thanks'), { exact: true });
      await acknowledgement.waitFor();
      await acknowledgement.hover();
      await ui.capture('success');
      await page.locator('[data-confetti-burst]').waitFor({ state: 'detached' });
      await acknowledgement.waitFor({ state: 'hidden', timeout: 6000 });
      await page.locator('[data-preview-failure]').click();
      await page.getByRole('button', { name: await copy('githubStar.action'), exact: true }).click();
      await page.getByText(await copy('githubStar.openFailed'), { exact: true }).waitFor();
      await ui.capture('failure');
      await page.locator('[data-preview-replay]').click();
      await page.getByRole('button', { name: await copy('githubStar.action'), exact: true }).waitFor();
      return;
    }
    if (!ui.case.startsWith('celebration')) return;
    const reduced = ui.case === 'celebration-reduced';
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.locator('[data-preview-celebration]').click();
    if (reduced) {
      await page.locator('[data-confetti-burst]').waitFor({ state: 'detached' });
      await ui.capture('reduced');
      return;
    }
    await page.locator('[data-confetti-burst]').waitFor({ state: 'attached' });
    await page.waitForTimeout(300);
    await ui.capture('flight-300');
    await page.waitForTimeout(600);
    await ui.capture('flight-900');
    await page.locator('[data-confetti-burst]').waitFor({ state: 'detached' });
    await ui.capture('finished');
  },
};
