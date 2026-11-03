import assert from 'node:assert/strict';
export default {
  name: 'provider-name-search', entry: './fixture.tsx', viewport: { width: 1000, height: 900 },
  real: 'Production custom endpoint name search, complete bundled catalog, and existing supplier configuration wizard',
  notCovered: 'Real credentials, OAuth, model discovery and persistence. Host reads are fixtures. Native app coexistence is verified separately.',
  cases: {
    default: { about: 'Supplier matches appear directly below the free-text name' },
    many: { about: 'Many supplier matches scroll independently while the custom endpoint hint stays fully visible' },
    scroll: { about: 'Real mouse-wheel input scrolls to a bottom supplier that can be selected' },
    custom: { about: 'Unmatched names remain valid custom endpoint names' },
    jump: { about: 'Selecting DeepSeek opens its existing configuration form' },
    'keyboard-reopen': { about: 'Reopening with ArrowUp keeps the active result visible, including a retained bottom selection' },
    'offline-jump': { about: 'Bundled DeepSeek still opens when both catalog reads fail; cancel retains the original draft' },
    ollama: { about: 'Managed Ollama describes installation and opens its existing install guide' },
    'theme-surface': { about: 'Independent popover/dialog theme overrides retain the shared popover surface and elevation' },
  },
  async check(page, ui) {
    if (ui.case === 'theme-surface') {
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--popover', 'var(--background)');
        document.documentElement.style.setProperty('--confirm-bg', 'var(--surface-elevated)');
        document.documentElement.style.setProperty('--shadow-menu', '0 4px 12px var(--border-default)');
      });
    }
    const input = page.getByRole('combobox');
    const query = ui.case === 'keyboard-reopen' ? 'a' : ui.case === 'ollama' ? 'Ollama' : ui.case === 'custom' ? 'My private gateway' : ['many', 'scroll', 'keyboard-reopen'].includes(ui.case) ? 'de' : 'dee';
    await input.fill(query);
    await page.getByText(await ui.t('settings.providers.custom.nameSearchHint'), { exact: true }).waitFor();
    if (ui.case === 'theme-surface') {
      const styles = await page.getByRole('listbox').evaluate(list => {
        const panel = list.parentElement;
        const probe = document.createElement('div');
        panel.append(probe);
        probe.style.backgroundColor = 'hsl(var(--popover))';
        const expected = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = 'var(--confirm-bg)';
        const dialog = getComputedStyle(probe).backgroundColor;
        probe.style.boxShadow = 'var(--shadow-menu)';
        const shadow = getComputedStyle(probe).boxShadow;
        const actual = getComputedStyle(panel);
        const result = { expected, dialog, shadow, background: actual.backgroundColor, actualShadow: actual.boxShadow };
        probe.remove();
        return result;
      });
      assert.notEqual(styles.expected, styles.dialog, 'theme probe must distinguish popover and dialog surfaces');
      assert.equal(styles.background, styles.expected);
      assert.notEqual(styles.shadow, 'none', 'theme probe must provide a visible menu shadow');
      // Tailwind may prepend transparent focus-ring layers to the menu shadow.
      assert.ok(styles.actualShadow.endsWith(styles.shadow), 'popover must retain the themed menu shadow');
      await ui.capture('theme-surface');
    }
    assert.equal(await page.getByText('匹配的供应商', { exact: true }).count(), 0);
    if (ui.case === 'keyboard-reopen') {
      assert.ok(await page.getByRole('option').count() >= 8);
      const list = page.getByRole('listbox');
      for (const retained of [false, true]) {
        await input.fill('');
        await input.fill(query);
        if (retained) await input.press('ArrowUp');
        await input.press('Escape');
        await list.waitFor({ state: 'hidden' });
        await input.press('ArrowUp');
        await page.waitForFunction(() => {
          const input = document.querySelector('[role="combobox"]');
          const row = document.getElementById(input?.getAttribute('aria-activedescendant') ?? '');
          const list = document.querySelector('[role="listbox"]');
          if (!row || !list) return false;
          const r = row.getBoundingClientRect(), b = list.getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && list.scrollTop > 0;
        }, undefined, { timeout: 2500 }).catch(async error => {
          await ui.capture('keyboard-failure');
          const state = await page.evaluate(() => {
            const input = document.querySelector('[role="combobox"]');
            const row = document.getElementById(input?.getAttribute('aria-activedescendant') ?? '');
            const list = document.querySelector('[role="listbox"]');
            return { active: input?.getAttribute('aria-activedescendant'), expanded: input?.getAttribute('aria-expanded'), row: row?.getBoundingClientRect().toJSON(), list: list?.getBoundingClientRect().toJSON(), scroll: list?.scrollTop, options: list?.childElementCount };
          });
          throw new Error(`${error.message} ${JSON.stringify(state)}`);
        });
        await ui.capture(`keyboard-reopen-${retained ? 'retained' : 'initial'}`);
      }
      await input.press('Enter');
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.cancel'), exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox').count(), 0);
    } else if (ui.case === 'ollama') {
      const managed = page.getByRole('option').filter({ has: page.getByText(await ui.t('settings.providers.local.subtitle'), { exact: true }) });
      assert.equal(await managed.count(), 1);
      await ui.capture('ollama-search-result');
      await managed.click();
      await page.getByText(await ui.t('settings.providers.local.onboardingTitle'), { exact: true }).waitFor();
    } else if (ui.case === 'custom') {
      assert.equal(await page.getByRole('option').count(), 0);
      assert.equal(await input.inputValue(), query);
    } else if (['many', 'scroll'].includes(ui.case)) {
      assert.ok(await page.getByRole('option').count() >= 6);
      const list = page.getByRole('listbox');
      const hint = page.getByText(await ui.t('settings.providers.custom.nameSearchHint'), { exact: true });
      const hintBox = await hint.boundingBox();
      const panelBox = await hint.locator('..').boundingBox();
      const listBox = await list.boundingBox();
      assert.ok(hintBox && panelBox && listBox);
      assert.ok(hintBox.y >= listBox.y + listBox.height - 1, 'hint must stay outside the scrolling results');
      assert.ok(hintBox.y + hintBox.height <= panelBox.y + panelBox.height - 1, 'hint must fit fully inside the panel');
      assert.ok(await hint.evaluate(el => el.scrollHeight <= el.clientHeight), 'hint text must not be clipped');
      assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight), 'many matches must create an actual scroll area');
      const beforeScroll = await list.evaluate(el => el.scrollTop);
      await list.hover();
      await page.mouse.wheel(0, 600);
      await page.waitForFunction(({ id, before }) => document.getElementById(id)?.scrollTop > before,
        { id: await list.getAttribute('id'), before: beforeScroll }, { timeout: 1500 });
      const afterScroll = await hint.boundingBox();
      assert.equal(afterScroll.y, hintBox.y, 'scrolling results must not move the hint');
      if (ui.case === 'scroll') {
        const last = page.getByRole('option').last();
        const lastBox = await last.boundingBox();
        assert.ok(lastBox && lastBox.y + lastBox.height <= listBox.y + listBox.height + 1, 'last supplier must be fully reachable after scrolling');
        await last.click();
        await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).waitFor();
      }
    } else {
      const option = page.getByRole('option', { name: /DeepSeek/ }).first();
      await option.waitFor();
      if (ui.case === 'jump' || ui.case === 'offline-jump') {
        await option.click();
        await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).waitFor();
        assert.equal(await page.getByRole('combobox').count(), 0);
        if (ui.case === 'offline-jump') {
          assert.equal(await page.locator('input').evaluateAll(inputs => inputs.some(input => input.value === 'DeepSeek')), true);
          await page.getByRole('button', { name: await ui.t('settings.providers.wizard.cancel'), exact: true }).click();
          await input.waitFor();
          assert.equal(await input.inputValue(), query);
        }
      }
    }
  },
};
