import assert from 'node:assert/strict';
export default {
  name: 'orca-worker-project',
  entry: './worker-project-fixture.tsx',
  viewport: { width: 560, height: 640 },
  real: 'WorkerProjectField, selection hook, FolderPickerPopover, BranchWorktreeChip, RolePillDropdown, themes, fonts and five locales',
  notCovered:
    'Full Worker creation popover, model/device selection, native folder dialog, filesystem discovery, IPC and actual worktree creation',
  cases: {
    'rows-long-names': {
      about: '32-character CJK and unbroken Latin names in a 280px sidebar; controls and full-name tooltips remain reachable',
    },
    'attention-error': {
      about: 'Idle Worker with unhandled task error in tabs, both menus and collapsed trigger',
    },
    'attention-awaiting': {
      about: 'Waiting confirmation shown as blue avatar dots including collapsed trigger',
    },
    'attention-done': {
      about:
        'Completion unread stays green for unselected Worker and does not aggregate on trigger',
    },
    default: {
      about:
        'Inherited Lead worktree, new-worktree branch chooser, project search and dirty other project',
    },
    'same-repo': {
      about:
        'Browsing the main checkout preserves that selection; current-project row restores inherited worktree',
    },
    'browse-error': { about: 'Native folder dialog failure leaves the current project usable' },
    missing: { about: 'Missing directory explains why creation cannot continue' },
    empty: { about: 'Empty repository explains why worktree creation is unavailable' },
    detached: {
      about: 'Detached HEAD is displayed as a short SHA and allows choosing a real branch',
    },
    workers: { about: 'Worker project badge appears only for the other project' },
    dialogue: { about: 'Dialogue Lead hides checkbox until a Git project is selected' },
  },
  async ready(page) {
    await page.getByRole('button').first().waitFor();
  },
  async check(page, ui) {
    // #13575 review: UI regression through the real toolbar. jsdom cannot measure
    // overflow; the existing short-name scenes do not exercise a single overwide pill.
    if (ui.case === 'rows-long-names') {
      const rows = page.getByTestId('worker-rows-list');
      const pills = rows.locator('[data-worker-id]');
      assert.equal(await pills.count(), 4);
      const bounds = await rows.boundingBox();
      for (const pill of await pills.all()) {
        const box = await pill.boundingBox();
        assert.ok(box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1,
          'every pill must fit inside the wrapping list');
        const buttons = await pill.getByRole('button').all();
        for (const button of buttons) {
          const control = await button.boundingBox();
          assert.ok(control.x + control.width <= bounds.x + bounds.width + 1,
            'selection and archive controls must stay inside the sidebar');
        }
      }
      const error = rows.getByLabel(await ui.t('orca.rolePill.errorBadgeAria'));
      assert.ok((await error.boundingBox()).width > 16, 'error badge must remain readable');
      await ui.capture('wrapped-long-names');

      for (const [id, name] of [['long-cjk', '超長中文角色名稱'.repeat(4)], ['long-latin', 'W'.repeat(32)]]) {
        const button = rows.locator(`[data-worker-id="${id}"]`).getByRole('button').first();
        await button.click();
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        await page.mouse.move(0, 0);
        await button.hover();
        const tooltip = page.getByRole('tooltip').filter({ hasText: name });
        await tooltip.waitFor();
        assert.ok((await tooltip.textContent()).includes(name), 'tooltip preserves the full name');
        // Radix gives the accessible tooltip a visually-hidden span; measure its
        // rendered content parent rather than the 1px accessibility copy.
        assert.ok(await tooltip.evaluate((el) => el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1),
          'full name wraps within the tooltip');
        await ui.capture(`full-name-${id}`);
        await page.keyboard.press('Escape');
        await page.mouse.move(0, 0);
      }
      // Keyboard focus must expose the same full-name hint as pointer hover.
      await page.getByTestId('long-names-sidebar').getByRole('button').first().focus();
      await page.keyboard.press('Tab');
      const keyboardTooltip = page.getByRole('tooltip').filter({ hasText: '超長中文角色名稱'.repeat(4) });
      await keyboardTooltip.waitFor();
      assert.ok((await keyboardTooltip.textContent()).includes('超長中文角色名稱'.repeat(4)));
      await ui.capture('keyboard-full-name');
      await page.keyboard.press('Escape');

      const archive = rows.locator('[data-worker-id="long-cjk"]').getByRole('button').nth(1);
      await archive.click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: await ui.t('newChat.collaboration.archiveWorkerConfirmCancel'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('orca.rolePill.layoutMenuLabel') }).click();
      await ui.capture('long-names-menu');
      const edit = page.getByRole('button', {
        name: await ui.t('orca.rolePill.editWorkerAria', { name: '超長中文角色名稱'.repeat(4) }), exact: true,
      });
      const menuName = await edit.locator('..').getByText('超長中文角色名稱'.repeat(4), { exact: true }).boundingBox();
      const editBox = await edit.boundingBox();
      assert.ok(menuName.x + menuName.width <= editBox.x, 'long menu names leave the edit control clear');
      await edit.click();
      assert.equal(await page.getByTestId('long-names-action').textContent(), 'edit:long-cjk');
      return;
    }
    if (ui.case.startsWith('attention-')) {
      const key =
        ui.case === 'attention-error'
          ? 'errorBadgeAria'
          : ui.case === 'attention-awaiting'
            ? 'awaitingBadgeAria'
            : 'unread';
      const label = await ui.t(`orca.rolePill.${key}`);
      await page.getByTestId('attention-tabs').getByLabel(label).waitFor();
      const dropdown = page.getByTestId('attention-dropdown');
      if (ui.case !== 'attention-done') await dropdown.getByLabel(label).waitFor();
      await ui.capture('tabs-and-collapsed');
      await dropdown.getByRole('button', { name: /frontend/ }).click();
      // ERR 是行按钮的相邻徽章；蓝 / 绿点在按钮头像里。
      if (ui.case === 'attention-error') assert.equal(await dropdown.getByLabel(label).count(), 2);
      else
        await dropdown
          .getByRole('button', { name: /reviewer/ })
          .getByLabel(label)
          .waitFor();
      await ui.capture('dropdown-list');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: await ui.t('orca.rolePill.layoutMenuLabel') }).click();
      await ui.capture('layout-menu-list');
      return;
    }
    if (ui.case === 'workers') {
      await page.getByRole('button', { name: /frontend/ }).click();
      await page.getByText('design-system', { exact: true }).first().waitFor();
      await ui.capture('worker-project-badge');
      return;
    }
    const current = await ui.t('orca.workerProject.current');
    const checkbox = page.getByRole('checkbox');
    if (ui.case === 'same-repo') {
      await page.getByRole('button', { name: current, exact: true }).click();
      await page
        .getByRole('button', { name: await ui.t('newChat.folderPicker.browseProjectFolder') })
        .click();
      await page
        .getByText(await ui.t('orca.workerProject.direct', { project: 'cindy', branch: 'main' }))
        .waitFor();
      await ui.capture('explicit-main-checkout');
      await page.getByText(await ui.t('orca.workerProject.newWorktree'), { exact: true }).click();
      const sourceBranch = page.getByRole('button', {
        name: await ui.t('newChat.branchChip.label'),
        exact: true,
      });
      assert.equal(await sourceBranch.textContent(), 'main');
      await ui.capture('same-repo-source-branch');
      await page.getByRole('button', { name: 'cindy', exact: true }).click();
      await page.getByRole('button', { name: 'cindy /projects/cindy', exact: true }).click();
      await page.getByRole('button', { name: current, exact: true }).waitFor();
      await ui.capture('restored-inherited-worktree');
      return;
    }
    if (ui.case === 'browse-error') {
      await page.getByRole('button', { name: current, exact: true }).click();
      await page
        .getByRole('button', { name: await ui.t('newChat.folderPicker.browseProjectFolder') })
        .click();
      await page
        .getByRole('alert')
        .getByText(await ui.t('newChat.folderPicker.browseFailed'))
        .waitFor();
      await ui.capture('native-folder-error');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: current, exact: true }).waitFor();
      assert.equal(
        await page.getByText(await ui.t('ccAgent.common.loading'), { exact: true }).count(),
        0,
      );
      await ui.capture('native-folder-error-dismissed');
      return;
    }
    if (ui.case === 'missing') {
      assert.equal(await checkbox.count(), 0);
      await page
        .getByRole('status')
        .getByText(await ui.t('orca.workerProject.missingDirectory'))
        .waitFor();
      assert.equal(
        await page
          .getByText(
            await ui.t('orca.workerProject.notGit', { directory: '/projects/missing-project' }),
            { exact: true },
          )
          .count(),
        0,
      );
      await ui.capture('missing-directory');
      return;
    }
    if (ui.case === 'empty') {
      assert.equal(await checkbox.count(), 0);
      await page
        .getByText(await ui.t('orca.workerProject.emptyRepo', { directory: '/projects/cindy' }))
        .waitFor();
      await ui.capture('empty-repository');
      return;
    }
    const detachedLabel = await ui.t('orca.workerProject.detachedHead', { sha: 'abcdef01' });
    const sourceLabel = ui.case === 'detached' ? detachedLabel : 'feat/worker-project-picker';
    if (ui.case === 'dialogue') assert.equal(await checkbox.count(), 0);
    else {
      await page.getByText(await ui.t('orca.workerProject.newWorktree'), { exact: true }).click();
      await page
        .getByText(await ui.t('orca.workerProject.splitWarning', { branch: sourceLabel }))
        .waitFor();
      await ui.capture('new-worktree');
      await page
        .getByRole('button', { name: await ui.t('newChat.branchChip.label'), exact: true })
        .click();
      await page.getByRole('option', { name: 'main', exact: true }).waitFor();
      await ui.capture('branches');
      if (ui.case === 'detached') {
        await page.getByRole('option', { name: 'main', exact: true }).click();
        const branchButton = page.getByRole('button', {
          name: await ui.t('newChat.branchChip.label'),
          exact: true,
        });
        assert.equal(await branchButton.textContent(), 'main');
        await ui.capture('detached-pick-branch');
      } else await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: current, exact: true }).click();
    await page.getByRole('textbox').waitFor();
    assert.equal(
      await page.getByText(await ui.t('newChat.folderPicker.dialogue'), { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole('button', { name: await ui.t('newChat.folderPicker.removeFromList') })
        .count(),
      0,
    );
    await ui.capture('projects');
    await page.getByRole('textbox').fill('design-system');
    await page.getByText('design-system', { exact: true }).click();
    await page.getByText(await ui.t('orca.workerProject.dirty')).waitFor();
    assert.equal(await checkbox.isChecked(), false, 'project changes reset worktree selection');
    if (ui.case === 'detached') {
      await page
        .getByText(
          await ui.t('orca.workerProject.directDetached', {
            project: 'design-system',
            branch: detachedLabel,
          }),
        )
        .waitFor();
    }
    await ui.capture('other-project');
    await page.getByText(await ui.t('orca.workerProject.newWorktree'), { exact: true }).click();
    const rememberedBranch = page.getByRole('button', {
      name: await ui.t('newChat.branchChip.label'),
      exact: true,
    });
    assert.equal(await rememberedBranch.textContent(), 'release/v2');
    await ui.capture('remembered-source-branch');
  },
};
