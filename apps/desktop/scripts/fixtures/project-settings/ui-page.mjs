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
  real: 'ProjectSettingsDialog, ProjectIcon and DeviceSectionHeader',
  notCovered: 'Real persistence, device-link transport, full sidebar navigation and phone native presentation.',
  cases: {
    'create-device': { about: 'Device-row add action appears on hover/focus and opens the creation form', data: { create: true } },
    'create-legacy': { about: 'Version 6 still requires an existing directory and hides clone fields', data: { create: true, version: 6 } },
    'create-blank': { about: 'Repository creation is opt-in and returning to blank cannot send a hidden clone URL', data: { create: true } },
    'create-auto': { about: 'Create by name without choosing a directory', data: { create: true } },
    'create-repository': {
      about: 'Paste a GitLab URL as the name and clone into the automatically allocated directory',
      data: { create: true },
    },
    'create-primary': {
      about:
        'The first directory becomes primary; removing it promotes the next directory before creation',
      data: { create: true },
    },
    'create-existing': {
      about: 'Selecting a registered project preserves its saved name, icon and directory grants',
      data: { create: true, directories: true },
    },
    'create-cancel': {
      about: 'Cancel creation and discard directory drafts without any profile write',
      data: { create: true },
    },
    directories: {
      about: 'New directory drafts allow writes and persist only on Save',
      data: { directories: true },
    },
    create: {
      about: 'New project uses the same settings form and does not create a task before saving',
      data: { create: true },
    },
    header: {
      about: 'Click a task header project icon to edit its owning project, including worktrees',
      data: { header: true },
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
      .getByRole('button', { name: /^(更换图标|Change icon|项目设置|Project settings|新建项目|New project)$/ })
      .first()
      .waitFor();
  },
  async check(page, ui) {
    // Real header and dialog, with a local specimen row. Existing dialog cases
    // cannot verify hover/focus visibility. ProjectsSection unit tests cover
    // local/remote target routing separately from this browser layout check.
    if (ui.case === 'create-device') {
      const add = page.getByRole('button', { name: await ui.t('ccAgent.sidebar.newProject'), exact: true });
      const wrapper = add.locator('..');
      if (await wrapper.evaluate(el => getComputedStyle(el).opacity) !== '0') throw new Error('Add action should be hidden at rest');
      await page.getByRole('button', { expanded: true }).hover();
      if (await wrapper.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Hover did not reveal add action');
      await ui.capture('device-hover');
      await page.mouse.move(350, 300);
      await add.focus();
      if (await wrapper.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Keyboard focus did not reveal add action');
      await add.click();
      await page.getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true }).waitFor();
      await ui.capture('device-create');
      return;
    }
    if (['create-auto', 'create-repository', 'create-blank'].includes(ui.case)) {
      const repositoryInput = page.getByRole('textbox', { name: await ui.t('projectSettings.repository'), exact: true });
      if (await repositoryInput.count()) throw new Error('Repository field appeared before opting in');
      if (await page.getByRole('group', { name: await ui.t('projectSettings.source'), exact: true }).count()) throw new Error('Unexpected source group');
      if (await page.getByRole('radio').count() !== 2) throw new Error('Creation must expose only two sources');
      const repository = ui.case === 'create-repository';
      if (ui.case === 'create-auto') {
        const name = page.getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true });
        await name.fill('Design/2027');
        if ((await name.inputValue()) !== 'Design/2027' || await repositoryInput.count()) throw new Error('A project name was interpreted as a GitHub shortcut');
      }
      await page
        .getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true })
        .fill(repository ? 'https://gitlab.example.com/engineering/platform/client/applications/project-management/demo' : 'Demo');
      if (repository && !(await repositoryInput.isVisible())) throw new Error('Pasted URL did not reveal repository options');
      if (ui.case === 'create-blank') {
        await page.getByRole('radio', { name: await ui.t('projectSettings.source_repository'), exact: true }).click();
        await repositoryInput.waitFor();
        await page.getByRole('button', { name: await ui.t('projectSettings.createAction'), exact: true }).click();
        if (await page.evaluate(() => window.projectSettingsWrites.length)) throw new Error('Empty repository mode created a blank project');
        await repositoryInput.fill('https://github.com/example/Demo');
        if (await page.getByText(await ui.t('projectSettings.invalidRepository'), { exact: true }).count()) throw new Error('Repository error persisted after editing');
        await ui.capture('repository-options');
        await page.getByRole('radio', { name: await ui.t('projectSettings.source_local'), exact: true }).click();
        if (await repositoryInput.count()) throw new Error('Repository field remained after switching to blank');
      }
      if (ui.case === 'create-auto') {
        await page.evaluate(() => window.projectPickerCancelled = true);
        await page.getByRole('button', { name: await ui.t('projectSettings.changeMainDirectory'), exact: true }).click();
        await page.getByText(await ui.t('projectSettings.automaticMain'), { exact: true }).waitFor();
        await page.evaluate(() => window.projectPickerCancelled = false);
      }
      await ui.capture('automatic-location');
      if (ui.case === 'create-auto') await page.getByRole('button', { name: await ui.t('projectSettings.addDirectory'), exact: true }).click();
      await page
        .getByRole('button', { name: await ui.t('projectSettings.createAction'), exact: true })
        .click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes.length !== 1 || writes[0].projectKey !== 'local:' || !writes[0].create)
        throw new Error('Missing automatic creation');
      if (repository && writes[0].repositoryUrl !== 'https://gitlab.example.com/engineering/platform/client/applications/project-management/demo')
        throw new Error('Repository paste was lost');
      if (!repository && writes[0].repositoryUrl) throw new Error('Blank creation retained a hidden repository URL');
      if (ui.case === 'create-auto' && writes[0].value.directories?.[0]?.path !== '/Projects/Reference') throw new Error('Adding another directory replaced the automatic primary');
      const opened = await page.evaluate(() => window.projectCreatedPath);
      if (opened !== (repository ? '/Projects/demo' : '/Projects/Demo'))
        throw new Error('Did not use host-assigned directory');
      return;
    }
    if (ui.case === 'create-primary') {
      // UI regression: choosing a folder with an empty name must visibly fill it;
      // the existing creation scenario previously checked only the submitted path.
      const nameInput = page.getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true });
      for (const path of ['/Projects/First', '/Projects/Second']) {
        await page.evaluate((path) => {
          window.projectPickerPath = path;
        }, path);
        await page
          .getByRole('button', { name: await ui.t(path === '/Projects/First' ? 'projectSettings.changeMainDirectory' : 'projectSettings.addDirectory'), exact: true })
          .click();
        if ((await nameInput.inputValue()) !== 'First') throw new Error('Selecting the main folder did not fill its name, or adding another folder changed it');
      }
      await ui.capture('folder-name');
      // Clearing a name returns to automatic naming on the next folder choice.
      await nameInput.fill(' ');
      await page.getByText(await ui.t('projectSettings.mainDirectory'), { exact: true }).waitFor();
      await page
        .getByRole('button', { name: await ui.t('projectSettings.removeDirectory'), exact: true })
        .first()
        .click();
      await page.getByText('/Projects/Second', { exact: true }).waitFor();
      if ((await nameInput.inputValue()) !== 'Second') throw new Error('Automatically filled name did not follow the promoted main folder');
      await ui.capture('promoted-primary');
      await page
        .getByRole('button', { name: await ui.t('projectSettings.createAction'), exact: true })
        .click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (
        writes.length !== 1 ||
        writes[0].projectKey !== 'local:/Projects/Second' ||
        writes[0].value.directories.length !== 0
      )
        throw new Error('First directory was not promoted to primary');
      return;
    }
    if (ui.case === 'create-existing') {
      await page.evaluate((path) => {
        window.projectPickerPath = path;
      }, '/Projects/Cindy');
      await page
        .getByRole('button', { name: await ui.t('projectSettings.changeMainDirectory'), exact: true })
        .click();
      await page.getByText('/Projects/Reference', { exact: true }).waitFor();
      if (
        (await page
          .getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true })
          .inputValue()) !== 'Cindy'
      )
        throw new Error('Existing name was not loaded');
      await ui.capture('existing-project');
      await page
        .getByRole('button', { name: await ui.t('projectSettings.createAction'), exact: true })
        .click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes.length !== 1 || Object.keys(writes[0].value).length !== 0)
        throw new Error('Creation overwrote an existing profile');
      return;
    }
    if (ui.case === 'create-cancel') {
      await page.evaluate((path) => {
        window.projectPickerPath = path;
      }, '/Projects/Example');
      await page
        .getByRole('button', { name: await ui.t('projectSettings.addDirectory'), exact: true })
        .click();
      await page.evaluate(() => {
        window.projectPickerPath = '/Projects/Reference';
      });
      await page
        .getByRole('button', { name: await ui.t('projectSettings.addDirectory'), exact: true })
        .last()
        .click();
      await page
        .getByRole('button', { name: await ui.t('projectSettings.cancel'), exact: true })
        .last()
        .click();
      await page
        .getByRole('button', { name: await ui.t('projectSettings.discard'), exact: true })
        .click();
      if (await page.evaluate(() => window.projectSettingsWrites.length))
        throw new Error('Cancelled creation persisted a draft');
      return;
    }

    if (ui.case === 'directories' || ['create', 'create-legacy'].includes(ui.case)) {
      if (['create', 'create-legacy'].includes(ui.case)) {
        if (ui.case === 'create-legacy') {
          if (await page.getByRole('textbox', { name: await ui.t('projectSettings.repository'), exact: true }).count()) throw new Error('Old host exposed cloning');
          await page.getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true }).fill('Demo');
          if (!(await page.getByRole('button', { name: await ui.t('projectSettings.createAction'), exact: true }).isDisabled())) throw new Error('Old host accepted automatic allocation');
        }
        await page
          .getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true })
          .fill('My project');
        await page.evaluate((path) => {
          window.projectPickerPath = path;
        }, '/Projects/Example');
        await page
          .getByRole('button', { name: await ui.t(ui.case === 'create-legacy' ? 'projectSettings.addDirectory' : 'projectSettings.changeMainDirectory'), exact: true })
          .click();
        if ((await page.getByRole('textbox', { name: await ui.t('projectSettings.name'), exact: true }).inputValue()) !== 'My project') throw new Error('Choosing a folder replaced the manually entered name');
        await page.evaluate(() => {
          window.projectPickerPath = '/Projects/Reference';
        });
        await page
          .getByRole('button', { name: await ui.t('projectSettings.addDirectory'), exact: true })
          .last()
          .click();
      }
      if (ui.case === 'directories') {
        await page.evaluate((path) => {
          window.projectPickerPath = path;
        }, '/Projects/Output');
        await page
          .getByRole('button', { name: await ui.t('projectSettings.addDirectory'), exact: true })
          .click();
      }
      if (await page.evaluate(() => window.projectSettingsWrites.length))
        throw new Error('Directory draft saved early');
      await ui.capture('directory-form');
      await page
        .getByRole('button', {
          name: await ui.t(
            ['create', 'create-legacy'].includes(ui.case) ? 'projectSettings.createAction' : 'projectSettings.save',
          ),
          exact: true,
        })
        .click();
      const writes = await page.evaluate(() => window.projectSettingsWrites);
      if (writes.length !== 1 || writes[0].value.directories.at(-1).access !== 'write')
        throw new Error('Missing project directory save');
      if (ui.case === 'directories' && writes[0].value.directories[0].access !== 'read')
        throw new Error('Changed a pre-existing directory permission');
      if (
        ['create', 'create-legacy'].includes(ui.case) &&
        (!writes[0].create || writes[0].projectKey !== 'local:/Projects/Example' || writes[0].value.name !== 'My project')
      )
        throw new Error('Wrong creation identity');
      return;
    }
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
      if ((await input.inputValue()) !== value)
        throw new Error('Inline edit did not update the displayed name');
      if (await page.evaluate(() => window.projectSettingsWrites.length))
        throw new Error('Inline rename persisted before Save');
    };
    if (ui.case === 'header') {
      const trigger = await button('title');
      // The title bar is draggable in Electron; its project button must opt out.
      if (
        (await trigger.evaluate((el) => el.style.getPropertyValue('-webkit-app-region'))) !==
        'no-drag'
      )
        throw new Error('Project settings trigger is still in the drag region');
      await trigger.click();
      await (await button('changeIcon')).waitFor();
      await page.getByText('/Projects/Cindy', { exact: true }).waitFor();
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
      await (await button('cancel')).last().click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await trigger.waitFor();
      return;
    }
    if (ui.case === 'default') {
      const input = page.getByRole('textbox', {
        name: await ui.t('projectSettings.name'),
        exact: true,
      });
      const original = await input.inputValue();
      await input.fill('Discard this name');
      await input.press('Escape');
      await (await button('keepEditing')).click();
      if (await input.inputValue() !== 'Discard this name') throw new Error('Continuing editing lost the name draft');
      await input.fill(original);
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
