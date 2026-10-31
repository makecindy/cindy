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
    ollama: { about: 'Managed Ollama describes installation and opens its existing install guide' },
  },
  async check(page, ui) {
    const input = page.getByRole('combobox');
    const query = ui.case === 'ollama' ? 'Ollama' : ui.case === 'custom' ? 'My private gateway' : ['many', 'scroll'].includes(ui.case) ? 'de' : 'dee';
    await input.fill(query);
    await page.getByText(await ui.t('settings.providers.custom.nameSearchHint'), { exact: true }).waitFor();
    assert.equal(await page.getByText('匹配的供应商', { exact: true }).count(), 0);
    if (ui.case === 'ollama') {
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
      if (ui.case === 'jump') {
        await option.click();
        await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).waitFor();
        assert.equal(await page.getByRole('combobox').count(), 0);
      }
    }
  },
};
