import { readFile } from 'node:fs/promises';
const artwork =
  'data:image/png;base64,' +
  (
    await readFile(new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url))
  ).toString('base64');
export default {
  name: 'project-settings',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 800 },
  real: 'Task header project menu, bulk archive confirmation, project settings and icon',
  notCovered: 'Real persistence, device-link transport and phone native presentation.',
  cases: {
    header: {
      about:
        'Click the header project icon to create a task or edit its owning project, including worktrees',
      data: { header: true },
    },
    'remote-archive': {
      about:
        'Open the remote project menu, review the named project and skipped tasks, then cancel',
      data: { header: true, remote: true },
    },
    letters: {
      about: 'Project-name initials prefill, draft preservation, cancellation and persistence',
    },
    'letters-legacy': {
      about: 'A v4 host retains plain initials without unsupported letter colors',
      data: { version: 4 },
    },
    'monogram-fallback': {
      about:
        'No artwork displays theme-adaptive initials and renaming does not save an icon override',
      data: { automatic: true },
    },
    'image-failure': {
      about: 'Undecodable project artwork falls back to the name tile',
      data: { automatic: true, artwork: 'data:image/png;base64,AAAA' },
    },
    'monogram-legacy': {
      about: 'An old host still displays name initials without querying unsupported artwork',
      data: { automatic: true, version: 2 },
    },
    automatic: {
      about: 'Automatic artwork is a default, never a persisted manual image',
      data: { artwork, automatic: true },
    },
    candidate: {
      about: 'GitHub owner avatar requires explicit selection',
      data: { candidate: true, artwork },
    },
    adaptive: { about: 'Default symbol follows theme and saves without a fixed color' },
    legacy: { about: 'Old hosts retain uncolored icon editing', data: { version: 2 } },
    color: { about: 'Color-only edits, default reset, picker cancel and profile save' },
    default: {
      about: 'Draft editing, searchable icon picker, upload, cancel and one profile save',
    },
  },
  async ready(page) {
    await page
      .getByRole('button', { name: /更换图标|Change icon/ })
      .or(page.locator('button[aria-haspopup="menu"]'))
      .first()
      .waitFor();
  },
  async check(page, ui) {
    const button = async (key) => {
      if (key.startsWith('colors.') && ui.case !== 'legacy') {
        const trigger = page.getByRole('button', {
          name: await ui.t('taskTags.color'),
          exact: true,
        });
        if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
      }
      return page.getByRole('button', {
        name: await ui.t(
          key.startsWith('colors.') && key !== 'colors.default'
            ? `taskTags.${key.slice(7)}`
            : `projectSettings.${key}`,
        ),
        exact: true,
      });
    };
    const editName = async (value, blur = false) => {
      const writesBeforeEdit = await page.evaluate(() => window.projectSettingsWrites.length);
      await (await button('name')).click();
      const input = page.getByRole('textbox', {
        name: await ui.t('projectSettings.name'),
        exact: true,
      });
      await input.fill(value);
      await ui.capture('editing-name');
      if (blur)
        await page
          .getByRole('heading', { name: await ui.t('projectSettings.title'), exact: true })
          .click();
      else await input.press('Enter');
      await (await button('name')).waitFor();
      if ((await (await button('name')).textContent()).trim() !== value)
        throw new Error('Inline edit did not update the displayed name');
      if (await page.evaluate(() => window.projectSettingsWrites.length) !== writesBeforeEdit)
        throw new Error('Inline rename persisted before Save');
    };
    const movedActions = await Promise.all([
      'ccAgent.sidebar.projectAction.pin',
      'settings.sessionImport.projectMenu',
      'ccAgent.sidebar.projectAction.removeFromSidebar',
    ].map((key) => ui.t(key)));
    if (ui.case === 'remote-archive') {
      await page.locator('button[aria-haspopup="menu"]').click();
      await ui.capture('project-menu');
      const showFiles = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.projectAction.showFiles'), exact: true });
      await showFiles.click();
      await page.waitForFunction(() => window.projectFilesHref === '/cc-agent/files/header-task?device=fixture-studio');
      await page.locator('button[aria-haspopup="menu"]').click();
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (href) => { window.copiedProjectLink = href; } },
        });
      });
      await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.projectAction.copyDeepLink'), exact: true }).click();
      await page.waitForFunction(() => window.copiedProjectLink === 'cindy://project/device%3Afixture-studio%3A%2FProjects%2FCindy');
      await page.locator('button[aria-haspopup="menu"]').click();
      await page
        .getByRole('menuitem', {
          name: await ui.t('ccAgent.sidebar.projectAction.archivedAll'),
          exact: true,
        })
        .click();
      const dialog = page.getByRole('alertdialog');
      await dialog.getByRole('heading', { name: /Cindy.*Studio/ }).waitFor();
      const skip = await ui.t('ccAgent.sidebar.archiveAll.skipPinned', { count: 1 });
      await dialog
        .getByText(
          await ui.t('ccAgent.sidebar.archiveAll.descriptionWithSkip', { count: 2, skip }),
          { exact: true },
        )
        .waitFor();
      await ui.capture('archive-confirmation');
      await dialog
        .getByRole('button', { name: await ui.t('ccAgent.sidebar.archiveAll.cancel'), exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
      if (await page.evaluate(() => window.projectSettingsWrites.length))
        throw new Error('Cancelling the remote archive changed a task');
      await page.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: await ui.t('projectSettings.title'), exact: true }).click();
      const settingsDialog = page.getByRole('dialog');
      await settingsDialog.getByRole('button', { name: movedActions[0], exact: true }).waitFor();
      for (const name of movedActions.slice(1)) {
        if (await settingsDialog.getByRole('button', { name, exact: true }).count())
          throw new Error('Local-only project action appeared in remote settings: ' + name);
      }
      await (await button('cancel')).last().click();
      return;
    }
    if (ui.case === 'header') {
      const trigger = page.getByRole('button', {
        name: await ui.t('ccAgent.sidebar.projectAction.menu', { name: 'Cindy' }),
        exact: true,
      });
      const settings = page.getByRole('menuitem', {
        name: await ui.t('projectSettings.title'),
        exact: true,
      });
      // The title bar is draggable in Electron; its project button must opt out.
      if (
        (await trigger.evaluate((el) => el.style.getPropertyValue('-webkit-app-region'))) !==
        'no-drag'
      )
        throw new Error('Project settings trigger is still in the drag region');
      await trigger.click();
      await settings.waitFor();
      for (const name of movedActions) {
        if (await page.getByRole('menuitem', { name, exact: true }).count())
          throw new Error('Settings action still appears in the project menu: ' + name);
      }
      await ui.capture('project-menu');
      await page
        .getByRole('menuitem', { name: await ui.t('ccAgent.common.newSession'), exact: true })
        .click();
      await page.waitForFunction(() => window.createdProjectKey === 'local:/Projects/Cindy');
      await trigger.click();
      await settings.click();
      await (await button('changeIcon')).waitFor();
      await page.getByText('/Projects/Cindy', { exact: true }).waitFor();
      const settingsAction = async (key) => page.getByRole('button', { name: await ui.t(key), exact: true });
      await (await settingsAction('settings.sessionImport.projectMenu')).waitFor();
      await (await settingsAction('ccAgent.sidebar.projectAction.removeFromSidebar')).waitFor();
      await ui.capture('project-settings');
      await (await settingsAction('ccAgent.sidebar.projectAction.pin')).click();
      await trigger.click();
      await settings.click();
      await (await settingsAction('ccAgent.sidebar.projectAction.unpin')).waitFor();
      await editName('Header project');
      await (await button('save')).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (
        writes.length !== 1 ||
        writes[0].projectKey !== 'local:/Projects/Cindy' ||
        writes[0].value.name !== 'Header project'
      )
        throw new Error('Header settings saved to the worktree instead of the owning project');
      await trigger.click();
      await settings.click();
      await editName('Unsaved');
      await (await settingsAction('settings.sessionImport.projectMenu')).click();
      await (await button('keepEditing')).click();
      await (await settingsAction('settings.sessionImport.projectMenu')).click();
      await (await button('discard')).click();
      await page.waitForFunction(() => window.importTarget === 'local:/Projects/Cindy');
      await trigger.click();
      await settings.click();
      await (await settingsAction('ccAgent.sidebar.projectAction.removeFromSidebar')).click();
      const removal = page.getByRole('alertdialog');
      const checkbox = removal.getByRole('checkbox');
      const remove = await ui.t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmAction');
      const removeAndArchive = await ui.t('ccAgent.sidebar.projectAction.removeAndArchive');
      await removal.getByRole('button', { name: remove, exact: true }).waitFor();
      if (await checkbox.isChecked()) throw new Error('Archive must be opt-in');
      await ui.capture('remove-project');
      await checkbox.check();
      await removal.getByRole('button', { name: removeAndArchive, exact: true }).waitFor();
      await ui.capture('remove-project-archive');
      await removal.getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true }).click();
      if (await page.evaluate(() => window.removedProject || window.archivedTask)) throw new Error('Cancelling changed the project');
      const reopenRemoval = async () => {
        await trigger.click();
        await settings.click();
        await (await settingsAction('ccAgent.sidebar.projectAction.removeFromSidebar')).click();
        await checkbox.waitFor();
        if (await checkbox.isChecked()) throw new Error('Previous archive choice leaked');
      };
      await reopenRemoval();
      await removal.getByRole('button', { name: remove, exact: true }).click();
      await page.waitForFunction(() => window.removedProject === 'local:/Projects/Cindy');
      if (await page.evaluate(() => window.archivedTask)) throw new Error('Unchecked removal archived a task');
      await page.evaluate(() => { delete window.removedProject; });
      await reopenRemoval();
      await checkbox.check();
      await removal.getByRole('button', { name: removeAndArchive, exact: true }).click();
      await page.waitForFunction(() => window.archivedTask === 'header-task' && window.removedProject === 'local:/Projects/Cindy');
      await trigger.waitFor();
      return;
    }
    if (ui.case === 'default') {
      await (await button('name')).click();
      const input = page.getByRole('textbox', {
        name: await ui.t('projectSettings.name'),
        exact: true,
      });
      const original = await input.inputValue();
      await input.fill('Discard this name');
      await input.press('Escape');
      await (await button('name')).waitFor();
      if ((await (await button('name')).textContent()).trim() !== original)
        throw new Error('Escape did not restore the name');
      if (await (await button('save')).isEnabled())
        throw new Error('Cancelled inline rename left an unsaved change');
    }
    if (['monogram-fallback', 'image-failure', 'monogram-legacy'].includes(ui.case)) {
      const tile = page.locator('[data-project-monogram]');
      await tile.getByText('C', { exact: true }).waitFor();
      await editName('My Project');
      await tile.getByText('MP', { exact: true }).waitFor();
      const hasColor = await tile.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.color !== 'transparent';
      });
      if (!hasColor) throw new Error('Automatic initials lost their colored tile');
      await ui.capture('automatic-letters');
      await (await button('save')).click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes.length !== 1 || writes[0].value.name !== 'My Project' || 'icon' in writes[0].value)
        throw new Error('Automatic initials were persisted as an override');
      return;
    }
    if (ui.case === 'letters' || ui.case === 'letters-legacy') {
      await editName('My Project');
      await (await button('changeIcon')).first().click();
      const lettersTab = page.getByRole('radio', {
        name: await ui.t('projectSettings.letters'),
        exact: true,
      });
      const input = page.getByLabel(await ui.t('projectSettings.letters'), { exact: true });
      await lettersTab.click();
      if ((await input.inputValue()) !== 'MP') throw new Error('Missing project-name initials');
      const colored = ui.case === 'letters';
      if (
        !colored &&
        (await page
          .getByRole('button', { name: await ui.t('taskTags.color'), exact: true })
          .count())
      )
        throw new Error('Letter colors shown on a v4 host');
      if (colored) {
        await (await button('colors.white')).click();
        await ui.capture('letters-white');
        await (await button('colors.blue')).click();
        const matches = await page.getByText('MP', { exact: true }).evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.color =
            'color-mix(in srgb, var(--task-tag-blue) 80%, var(--project-contrast))';
          el.parentElement.append(probe);
          const result = getComputedStyle(el).color === getComputedStyle(probe).color;
          probe.remove();
          return result;
        });
        if (!matches) throw new Error('Letter preview did not adopt the selected color');
      }
      await ui.capture('initials');
      await input.fill('XY');
      await page
        .getByRole('radio', { name: await ui.t('projectSettings.symbols'), exact: true })
        .click();
      await page.getByRole('button', { name: 'Rocket', exact: true }).click();
      await lettersTab.click();
      if ((await input.inputValue()) !== 'XY')
        throw new Error('Custom letters lost when switching tabs');
      await (await button('cancel')).last().click();
      if (await page.evaluate(() => window.projectSettingsWrites.length))
        throw new Error('Picker cancellation persisted a draft');
      await (await button('changeIcon')).first().click();
      await lettersTab.click();
      if ((await input.inputValue()) !== 'MP')
        throw new Error('Cancelled initials leaked into the next draft');
      if (colored) await (await button('colors.blue')).click();
      await (await button('applyIcon')).click();
      await (await button('changeIcon')).first().click();
      if ((await input.inputValue()) !== 'MP')
        throw new Error('Applied letters were not preserved');
      await (await button('applyIcon')).click();
      await (await button('save')).click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes[0]?.value.icon !== (colored ? 'text:MP:blue' : 'text:MP'))
        throw new Error('Generated initials or their color were not saved');
      return;
    }
    if (ui.case === 'automatic' || ui.case === 'candidate') {
      if (ui.case === 'automatic') {
        await page.getByText('assets/icon.png', { exact: false }).waitFor();
        await page.locator('img[src^="data:image/"]').first().waitFor();
        await ui.capture('automatic');
        await editName('Cindy Project');
        await (await button('changeIcon')).first().click();
        await page.getByRole('button', { name: 'Rocket', exact: true }).click();
        await (await button('applyIcon')).click();
        await (await button('changeIcon')).first().click();
        await (await button('reset')).click();
        await (await button('applyIcon')).click();
        await page.locator('img[src^="data:image/"]').first().waitFor();
        await (await button('save')).click();
        const writes = await page.evaluate(() => window.projectSettingsWrites);
        // Returning to the unchanged automatic default saves only the name, no icon override.
        if (
          writes.length !== 1 ||
          writes[0]?.value.name !== 'Cindy Project' ||
          'icon' in writes[0].value
        )
          throw new Error('Automatic artwork persisted as a manual override');
      } else {
        await (await button('githubAvatar')).waitFor();
        await ui.capture('candidate');
        await (await button('githubAvatar')).click();
        await (await button('save')).click();
        const writes = await page.evaluate(() => window.projectSettingsWrites);
        if (!writes[0]?.value.icon?.startsWith('data:image/'))
          throw new Error('Explicit avatar choice was not saved');
      }
      return;
    }
    await (await button('changeIcon')).first().click();
    await page
      .getByRole('radio', { name: await ui.t('projectSettings.symbols'), exact: true })
      .click();
    await page.getByRole('button', { name: 'Rocket', exact: true }).click();
    if (ui.case === 'legacy') {
      if (await (await button('colors.blue')).count())
        throw new Error('Color controls shown on v2 host');
      await (await button('applyIcon')).click();
      await (await button('save')).click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes[0]?.value.icon !== 'symbol:Rocket')
        throw new Error('Legacy symbol encoding changed');
      return;
    }
    await (await button('colors.white')).click();
    await ui.capture('white');
    await (await button('colors.coral')).click();
    await ui.capture('tag-colors');
    await (await button('colors.blue')).click();
    await ui.capture('icons');
    if (ui.case === 'adaptive') {
      await (await button('colors.default')).click();
      const glyph = page.getByRole('button', { name: 'Rocket', exact: true }).locator('svg');
      const matchesTheme = await glyph.evaluate(
        (el) =>
          getComputedStyle(el).color ===
          (() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--text-primary)';
            el.parentElement.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          })(),
      );
      if (!matchesTheme) throw new Error('Default glyph does not use the theme foreground');
      await ui.capture('adaptive');
      await (await button('applyIcon')).click();
      await (await button('save')).click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes[0]?.value.icon !== 'symbol:Rocket')
        throw new Error('Default stored a fixed color');
      return;
    }

    if (ui.case === 'color') {
      await (await button('applyIcon')).click();
      await (await button('changeIcon')).first().click();
      if ((await (await button('colors.blue')).getAttribute('aria-pressed')) !== 'true')
        throw new Error('Color was lost on reopening');
      await (await button('colors.red')).click();
      await (await button('cancel')).last().click();
      await (await button('changeIcon')).first().click();
      if ((await (await button('colors.blue')).getAttribute('aria-pressed')) !== 'true')
        throw new Error('Cancelled color leaked into profile');
      await (await button('colors.default')).click();
      await page.getByRole('button', { name: 'Code', exact: true }).click();
      await (await button('colors.purple')).click();
      await page.getByRole('button', { name: 'Rocket', exact: true }).click();
      if ((await (await button('colors.purple')).getAttribute('aria-pressed')) !== 'true')
        throw new Error('Changing shape discarded color');
      await ui.capture('palette');
      await page.keyboard.press('Escape');
      await ui.capture('color');
      await (await button('applyIcon')).click();
      await ui.capture('color-profile');
      await (await button('save')).click();
      await page.waitForFunction(() => window.projectSettingsWrites?.length === 1);
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes[0].value.icon !== 'symbol:Rocket:purple' || 'name' in writes[0].value)
        throw new Error('Color-only save changed name or lost color');
      return;
    }
    await page
      .getByRole('radio', { name: await ui.t('projectSettings.emoji'), exact: true })
      .click();
    await page.getByRole('button', { name: '🌱', exact: true }).click();
    await ui.capture('emoji');
    await page
      .getByRole('radio', { name: await ui.t('projectSettings.letters'), exact: true })
      .click();
    await page.getByLabel(await ui.t('projectSettings.letters'), { exact: true }).fill('CY');
    await ui.capture('letters');
    await (await button('cancel')).last().click();
    if (await page.evaluate(() => window.projectSettingsWrites.length))
      throw new Error('Cancelling the picker wrote settings');
    await (await button('changeIcon')).first().click();
    await page
      .getByRole('radio', { name: await ui.t('projectSettings.letters'), exact: true })
      .click();
    await page.getByLabel(await ui.t('projectSettings.letters'), { exact: true }).fill('@');
    if (await (await button('applyIcon')).isEnabled())
      throw new Error('Invalid monogram can be applied');
    await page
      .getByRole('radio', { name: await ui.t('projectSettings.image'), exact: true })
      .click();
    await ui.capture('image-empty');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cindy.png',
      mimeType: 'image/png',
      buffer: await readFile(
        new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url),
      ),
    });
    await page.locator('img[src^="data:image/png"]').first().waitFor();
    await ui.capture('upload');
    await (await button('applyIcon')).click();
    await (await button('changeIcon')).first().click();
    if (
      (await page
        .getByRole('radio', { name: await ui.t('projectSettings.image'), exact: true })
        .getAttribute('aria-checked')) !== 'true'
    )
      throw new Error('Uploaded image did not reopen in image tab');
    await (await button('cancel')).last().click();
    await editName('New project', true);
    await ui.capture('draft');
    await (await button('save')).click();
    await page.waitForFunction(() => window.projectSettingsWrites?.length === 1);
    const writes = await page.evaluate(() => window.projectSettingsWrites);
    if (
      writes[0].field !== 'profile' ||
      writes[0].value.name !== 'New project' ||
      !writes[0].value.icon.startsWith('data:image/png') ||
      writes[0].projectKey !== 'local:/Projects/Cindy'
    )
      throw new Error('Profile did not reach the selected host project');
  },
};
