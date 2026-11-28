import assert from 'node:assert/strict';

// #10679: real tabs, list, header and CodeMirror. Existing file-body fixtures
// cover rendering/error geometry, not same-basename identity or template provenance.
// Tier: opt-in UI integration; minimal collision is one/src and two/src/AGENTS.md.
export default {
  name: 'file-context',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 560 },
  real: 'FileTabsBar, TabStrip/FileBrowserTabPillTitle, FilterResultList, FileBodyView/FilePathHeader, useFileContent and template metadata parsing',
  notCovered: 'Actual filesystem, SSH/device-link transmission, OS clipboard and writes; file data and template record come from fixture host APIs',
  cases: {
    default: { about: 'Known Cindy template rule and nested namesakes remain distinct', data: { template: true } },
    ordinary: { about: 'An ordinary AGENTS.md has a path but no invented rule source', data: { template: false } },
    'windows-narrow': { about: 'Logical Windows workdir and narrow embedded view preserve path context', data: { template: true }, viewport: { width: 360, height: 480 } },
    loading: { about: 'File location remains visible while its content loads', data: { template: true, contentKind: 'loading' } },
    'read-error': { about: 'File location remains visible when reading fails', data: { template: true, contentKind: 'error' } },
    'long-parent': { about: 'Long shared directory prefixes wrap instead of hiding the distinguishing directory', data: { template: true, prefix: 'projects/a-very-long-shared-directory-name/' } },
  },
  async ready(page) {
    await page.locator('[data-file-display-path]').waitFor();
  },
  async check(page, ui) {
    if (!ui.data.contentKind) await page.locator('.cm-editor').waitFor();
    const workdir = ui.case === 'windows-narrow' ? 'C:\\projects\\example' : '/projects/example';
    const separator = ui.case === 'windows-narrow' ? '\\' : '/';
    const header = page.locator('[data-file-path-header]');
    const prefix = ui.data.prefix ?? '';
    const one = `${prefix}apps/one/src/AGENTS.md`;
    const two = `${prefix}apps/two/src/AGENTS.md`;
    assert.equal(await header.locator('[data-file-display-path]').textContent(), `${workdir}${separator}AGENTS.md`);
    if (ui.data.template) {
      await header.locator('[data-file-rule-source]').waitFor();
      assert.equal(await header.locator('[data-file-rule-source]').textContent(), await ui.t('ccAgent.workdirBrowse.fileBody.templateRules'));
    } else {
      assert.equal(await header.locator('[data-file-rule-source]').count(), 0);
    }
    const tabs = page.locator('[data-file-tabs]');
    assert.match(await tabs.textContent(), /one\/src/);
    assert.match(await tabs.textContent(), /two\/src/);
    // Both title and close control must fit even when directory ancestors are long.
    const sidebar = page.locator('[data-sidebar-file-tabs]');
    const pill = sidebar.locator('[data-tab-pill="1"]');
    assert.equal(await pill.locator('[data-file-tab-directory]').textContent(), 'one/src');
    assert.equal(await pill.locator(`[title="${one}"]`).evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      return range.getBoundingClientRect().width <= el.closest('button').clientWidth + 1;
    }), true);
    assert.equal(await pill.evaluate(el => {
      const activate = el.querySelector('button');
      const close = el.querySelector('button[data-no-drag]');
      const box = el.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      return activate.clientWidth <= 240 && closeBox.left >= box.left && closeBox.right <= box.right + 1;
    }), true, 'A bounded title must not push the close control out of its pill');
    if (ui.case !== 'windows-narrow') {
      assert.match(await page.locator('[data-file-list]').textContent(), /apps\/two\/src/);
      assert.equal(await page.locator('[data-file-list] button').evaluateAll(buttons =>
        buttons.every(button => {
          const directory = button.querySelector('span.flex > span:last-child');
          return directory && directory.scrollWidth <= directory.clientWidth + 1;
        })), true, 'Directory context must remain visible even with a long shared prefix');
      await page.locator(`[data-file-list] button[title="${two}"]`).click();
      await page.waitForFunction(expected => document.querySelector('[data-file-display-path]')?.textContent === expected, `${workdir}${separator}${two.replaceAll('/', separator)}`);
      assert.equal(await header.locator('[data-file-rule-source]').count(), 0);
      await sidebar.locator('[data-tab-pill="0"] > button').first().click();
      await page.waitForFunction(expected => document.querySelector('[data-file-display-path]')?.textContent === expected, `${workdir}${separator}AGENTS.md`);
      if (ui.data.template) await header.locator('[data-file-rule-source]').waitFor();
    }
    await ui.capture('root-file');
    await tabs.locator(`div[title="${one}"]`).click();
    const nestedPath = `${workdir}${separator}${one.replaceAll('/', separator)}`;
    await page.waitForFunction(expected => document.querySelector('[data-file-display-path]')?.textContent === expected, nestedPath);
    assert.equal(await header.locator('[data-file-rule-source]').count(), 0, 'Nested namesakes are not template rules');
    // Removing one collision refreshes the surviving tab label without reopening the file.
    await tabs.locator(`div[title="${two}"] button`).click();
    assert.doesNotMatch(await tabs.textContent(), /one\/src/);
    assert.match(await tabs.textContent(), /src/);
    assert.equal(await header.locator('[data-file-display-path]').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await ui.capture('nested-file');
    await pill.locator('button').first().click();
    await pill.locator('button[data-no-drag]').click();
    assert.equal(await sidebar.locator('[data-tab-pill="1"]').count(), 0, 'The visible sidebar close control remains usable');
    assert.equal(await sidebar.locator('[data-file-tab-directory]').last().textContent(), 'src', 'Closing a sidebar namesake refreshes surviving directory context');
  },
};
