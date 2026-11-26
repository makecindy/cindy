import assert from 'node:assert/strict';
import console from 'node:console';
export default {
  name: 'checkout',
  entry: './checkout-fixture.tsx',
  viewport: { width: 760, height: 680 },
  real: 'WorktreeChipsRow, useCheckout, checkout dialog/menu, shared toast, buttons and themes',
  notCovered:
    'Real Git and remote devices; switch responses are simulated in memory, no Git executes',
  cases: {
    'checkbox-tooltip': { about: 'Shared one-line worktree benefit' },
    'default-source': { about: 'Worktree without a saved source defaults to origin/main' },
    'sync-off': { about: 'Unchecked worktree still exposes remote branch refresh' },
    'recover-busy': { about: 'Recovery toast action is disabled during a menu-triggered restore' },
    'recover-missing': { about: 'Restore reply reports saved changes deleted outside Cindy' },
    'recover-changed': { about: 'Restore reply reports the current branch changed outside Cindy' },
    restored: { about: 'Restore completion toast' },
    undone: { about: 'Undo completion toast' },
    ...Object.fromEntries(
      [
        'git',
        'changed',
        'missing',
        'dirty',
        'diverged',
        'conflict',
        'savedMissing',
        'undoUnavailable',
      ].map((code) => [
        'error-' + code.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
        { about: code + ' error toast' },
      ]),
    ),
    'many-files': { about: 'Dialog with 60 changed files' },
    'dirty-idle': { about: 'Dialog with idle sessions' },
    recover: { about: 'Saved changes recovery notice' },
    operation: { about: 'Merge in progress notice' },
    fetched: { about: 'New commits toast' },
    stashed: { about: 'Saved changes toast' },
    default: { about: 'Actual branch while unchecked and an occupied branch in the menu' },
    'busy-two': { about: 'Two running sessions' },
    'idle-menu': { about: 'Idle sessions in one quiet line' },
    busy: { about: 'Running session blocks checkout with an explicit worktree alternative' },
    idle: { about: 'Idle sessions are named without blocking branch choices' },
    dirty: { about: 'Scrollable dirty file list with fixed actions and worktree alternative' },
    conflict: { about: 'Carry option disabled for overlapping changes' },
    ignored: { about: 'Clean checkout names ignored files that prevent switching' },
    ordinary: { about: 'A plain checkout updates the branch without a success toast' },
    carried: { about: 'Carried changes produce a success toast with undo' },
    occupied: {
      about: 'An occupied branch is clickable and explains the rejection after preflight',
    },
    success: { about: 'Successful checkout toast with undo leaves the controls aligned' },
    switching: {
      about: 'Pending checkout keeps the right-aligned branch button width and position',
    },
    saved: { about: 'Saved changes toast and persistent menu entry leave the controls aligned' },
  },
  async ready(page) {
    await page.getByTestId('create-agent-branch-chip').filter({ hasText: 'main' }).waitFor();
  },
  async check(page, ui) {
    assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    assert.equal(
      await page
        .getByTestId('create-agent-branch-worktree')
        .evaluate((el) => globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region')),
      'no-drag',
    );
    const geometry = async () => {
      const result = {};
      for (const id of [
        'checkout-controls-row',
        'checkout-project',
        'create-agent-branch-chip',
        'checkout-input',
      ]) {
        const box = await page.getByTestId(id).boundingBox();
        assert.ok(box, id);
        result[id] = {
          x: box.x,
          y: box.y,
          height: box.height,
          ...(ui.case === 'switching' || ui.case === 'sync-off' ? { width: box.width } : {}),
        };
      }
      return result;
    };
    const before = await geometry();
    await ui.capture('before-feedback');
    if (ui.case === 'default-source') {
      await page.getByTestId('create-agent-worktree-chip').click();
      await page
        .getByTestId('create-agent-branch-chip')
        .filter({ hasText: 'origin/main' })
        .waitFor();
      assert.equal(await page.getByRole('checkbox').isChecked(), true);
      assert.equal(await page.locator('[data-toast-id]').count(), 0);
      return;
    }
    if (ui.case === 'sync-off') {
      const refresh = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.action', {
          branch: 'main',
          remote: 'origin',
          remoteBranch: 'main',
        }),
      });
      await refresh.waitFor();
      assert.equal(await refresh.isDisabled(), false);
      await ui.capture('unchecked-refresh');
      await page.getByTestId('create-agent-worktree-chip').click();
      await page
        .getByRole('button', {
          name: await ui.t('newChat.branchSync.action', {
            branch: 'main',
            remote: 'origin',
            remoteBranch: 'main',
          }),
        })
        .waitFor();
      const after = await geometry();
      assert.deepEqual(after, before, 'Toggling worktree must not hide refresh or resize the row');
      await ui.capture('checked-refresh');
      return;
    }
    if (ui.case === 'checkbox-tooltip') {
      await page.getByTestId('create-agent-worktree-chip').hover();
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      assert.equal(await tooltip.innerText(), await ui.t('newChat.worktree.chipTooltip'));
      const box = await tooltip.boundingBox();
      assert.ok(
        box.x >= 0 && box.x + box.width <= (await page.evaluate(() => globalThis.innerWidth)),
      );
      return;
    }
    await page.getByTestId('create-agent-branch-chip').click();
    await page.getByRole('option', { name: /^feature/ }).waitFor();
    if (['recover-missing', 'recover-changed'].includes(ui.case)) {
      await page
        .locator('[aria-live][data-state]')
        .getByRole('button', {
          name: await ui.t('newChat.checkout.restore'),
          exact: true,
        })
        .click();
      await page
        .getByRole('alert')
        .filter({
          hasText: await ui.t(
            'newChat.checkout.errors.' +
              (ui.case === 'recover-missing' ? 'savedMissing' : 'restoreChanged'),
          ),
        })
        .waitFor();
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
        .waitFor({ state: 'hidden' });
    } else if (ui.case === 'recover-busy') {
      await page
        .getByTestId('checkout-menu-notices')
        .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
        .and(page.locator('[disabled]'))
        .waitFor();
    } else if (ui.case === 'restored') {
      await page
        .getByTestId('checkout-menu-notices')
        .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
        .click();
      await page
        .getByRole('status')
        .filter({ hasText: await ui.t('newChat.checkout.restored') })
        .waitFor();
    } else if (ui.case === 'undone') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.undo'), exact: true })
        .click();
      await page
        .getByRole('status')
        .filter({ hasText: await ui.t('newChat.checkout.undone') })
        .waitFor();
    } else if (ui.case.startsWith('error-')) {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({
          hasText: await ui.t(
            'newChat.checkout.errors.' +
              ui.case.slice(6).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
          ),
        })
        .waitFor();
    } else if (ui.case === 'ordinary') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.getByTestId('create-agent-branch-chip').filter({ hasText: 'feature' }).waitFor();
      assert.equal(await page.locator('[data-toast-id]').count(), 0);
    } else if (['carried', 'stashed', 'fetched'].includes(ui.case)) {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      if (ui.case !== 'fetched') {
        await page.getByRole('dialog').waitFor();
        if (ui.case === 'stashed') await page.getByRole('radio').nth(1).check();
        await page
          .getByRole('button', {
            name: await ui.t(
              'newChat.checkout.' + (ui.case === 'stashed' ? 'stashConfirm' : 'carryConfirm'),
            ),
            exact: true,
          })
          .click();
      }
      const feedback = page.getByRole('status');
      await feedback.waitFor();
      assert.ok((await feedback.innerText()).length > 0);
      assert.equal(
        await feedback
          .getByRole('button', { name: await ui.t('newChat.checkout.undo'), exact: true })
          .count(),
        1,
      );
    } else if (ui.case === 'occupied') {
      const option = page.getByRole('option', { name: 'release', exact: true });
      assert.equal(await option.getAttribute('aria-disabled'), 'false');
      await option.click();
      const feedback = page.getByRole('alert');
      await feedback.waitFor();
      assert.equal(
        await feedback.innerText(),
        await ui.t('newChat.checkout.errors.occupied', { branch: 'release' }),
      );
      assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    } else if (ui.case === 'switching') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.locator('[data-testid="create-agent-branch-chip"][aria-busy="true"]').waitFor();
      assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
      assert.equal(
        await page.getByTestId('create-agent-branch-chip').getAttribute('aria-disabled'),
        'true',
      );
    } else if (ui.case === 'ignored') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      const feedback = page.getByRole('alert');
      await feedback.waitFor();
      assert.match(await feedback.innerText(), /private\/collision/);
      assert.match(await feedback.innerText(), /feature/);
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    } else if (['success', 'saved'].includes(ui.case)) {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.undo'), exact: true })
        .waitFor();
      if (ui.case === 'saved') {
        await page
          .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
          .waitFor();
        await ui.capture('saved-toast');
        await page.getByTestId('create-agent-branch-chip').click();
        await page.getByRole('listbox').waitFor();
        assert.equal(
          await page
            .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
            .count(),
          2,
        );
        await ui.capture('saved-menu');
        await page.keyboard.press('Escape');
      }
    } else if (['dirty', 'conflict', 'many-files', 'dirty-idle'].includes(ui.case)) {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      const carry = page.getByRole('radio', {
        name: await ui.t('newChat.checkout.carry', { branch: 'feature' }),
        exact: true,
      });
      assert.equal(await carry.isDisabled(), ui.case === 'conflict');
      const radioPaint = await page.getByRole('radio').evaluateAll((inputs) => {
        const selected = inputs.find((input) => input.checked);
        const dot = selected.closest('label').querySelector('span[aria-hidden] > span');
        return {
          width: dot.getBoundingClientRect().width,
          height: dot.getBoundingClientRect().height,
          color: globalThis.getComputedStyle(dot).backgroundColor,
          outer: globalThis.getComputedStyle(dot.parentElement).backgroundColor,
        };
      });
      const alpha = radioPaint.color.startsWith('rgba')
        ? parseFloat(radioPaint.color.split(',')[3])
        : 1;
      assert.ok(alpha >= 0.95, 'Radio center must not blend into its filled outer circle');
      assert.ok(
        radioPaint.width >= 5 && radioPaint.height >= 5,
        'Selected radio must have a visible inner dot',
      );
      assert.notEqual(
        radioPaint.color,
        radioPaint.outer,
        'Radio dot must contrast with its outer fill',
      );
      const leave = page.getByRole('radio').nth(1);
      assert.equal(await leave.isChecked(), ui.case === 'conflict');
      const firstAvailable = ui.case === 'conflict' ? leave : carry;
      const focusPaint = () =>
        firstAvailable.evaluate((input) => {
          const label = input.closest('label');
          const indicator = label.querySelector('span[aria-hidden]');
          const style = globalThis.getComputedStyle(indicator);
          const circle = indicator.getBoundingClientRect();
          const group = label.parentElement.getBoundingClientRect();
          return {
            focused: globalThis.document.activeElement === input,
            visible: input.matches(':focus-visible'),
            outline: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
            offset: parseFloat(style.outlineOffset),
            rowShadow: globalThis.getComputedStyle(label).boxShadow,
            contained:
              circle.left - 4 >= group.left &&
              circle.right + 4 <= group.right &&
              circle.top - 4 >= group.top &&
              circle.bottom + 4 <= group.bottom,
          };
        });
      await firstAvailable.locator('..').click();
      const mouse = await focusPaint();
      assert.equal(mouse.visible, false, 'Mouse selection must not paint keyboard focus');
      assert.equal(mouse.rowShadow, 'none', 'The row must not have a rectangular focus ring');
      assert.equal(mouse.outline, 'none');
      await ui.capture('mouse-selection');
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.showFiles'), exact: true })
        .focus();
      await page.keyboard.press('Tab');
      assert.equal((await focusPaint()).focused, true, 'Tab must enter on the checked radio');
      await page.keyboard.press('ArrowDown');
      assert.equal(await firstAvailable.isChecked(), false);
      await page.keyboard.press('ArrowUp');
      assert.equal(await firstAvailable.isChecked(), true);
      const keyboard = await focusPaint();
      assert.equal(keyboard.visible, true);
      assert.equal(keyboard.rowShadow, 'none');
      assert.equal(keyboard.outline, 'solid');
      assert.equal(keyboard.width, 2);
      assert.equal(keyboard.offset, 2);
      assert.equal(
        keyboard.contained,
        true,
        'Circular focus outline must fit inside the clipped group',
      );
      await ui.capture('keyboard-first-option');
      // Keyboard checks can scroll the dialog body; capture its initial view.
      await page.getByRole('radiogroup').evaluate((el) => {
        el.parentElement.scrollTop = 0;
      });
      const dialog = page.getByRole('dialog');
      assert.equal(
        await dialog.evaluate((el) =>
          globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region'),
        ),
        'no-drag',
      );
      assert.equal(await dialog.getByRole('listitem').count(), 0);
      await ui.capture('collapsed');
      await dialog
        .getByRole('button', { name: await ui.t('newChat.checkout.showFiles'), exact: true })
        .click();
      await dialog.getByRole('listitem').first().waitFor();
      await dialog.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      assert.equal(await dialog.getByRole('listitem').count(), 3);
      if (ui.case === 'many-files')
        await dialog
          .getByText(await ui.t('newChat.checkout.moreFiles', { count: 57 }), { exact: true })
          .waitFor();
      assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      const body = await page.getByRole('radiogroup').evaluate((el) => {
        const parent = el.parentElement;
        const box = parent.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          scrollHeight: parent.scrollHeight,
          clientHeight: parent.clientHeight,
        };
      });
      const viewport = await page.evaluate(() => ({
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
      }));
      if (viewport.width >= 760)
        assert.ok(
          body.scrollHeight <= body.clientHeight,
          'Desktop dialog must fit without body scrolling',
        );
      const choices = await dialog.getByRole('radio').evaluateAll((inputs) =>
        inputs.map((input) => {
          const box = input.closest('label').getBoundingClientRect();
          return { top: box.top, bottom: box.bottom };
        }),
      );
      for (const choice of choices)
        assert.ok(
          choice.top >= body.top - 1 && choice.bottom <= body.bottom + 1,
          'Both options must be fully visible',
        );
      const panel = await dialog.boundingBox();
      for (const button of await dialog.getByRole('button').all()) {
        const box = await button.boundingBox();
        assert.ok(
          box.x >= panel.x &&
            box.x + box.width <= panel.x + panel.width &&
            box.y >= panel.y &&
            box.y + box.height <= Math.min(panel.y + panel.height, viewport.height),
          'Footer buttons must be fully visible',
        );
      }

      assert.equal(
        await page
          .getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true })
          .isVisible(),
        true,
      );
    } else {
      assert.equal(
        await page.getByRole('option', { name: /^feature/ }).getAttribute('aria-disabled'),
        String(['busy', 'busy-two', 'operation'].includes(ui.case)),
      );
      assert.equal(
        await page.getByRole('option', { name: /^release/ }).getAttribute('aria-disabled'),
        String(['busy', 'busy-two', 'operation'].includes(ui.case)),
      );
    }
    if (['busy', 'busy-two', 'operation', 'idle', 'idle-menu', 'recover'].includes(ui.case)) {
      const notice = page.getByTestId('checkout-menu-notices');
      assert.equal(
        await notice.evaluate((el) =>
          globalThis.getComputedStyle(el.parentElement).getPropertyValue('-webkit-app-region'),
        ),
        'no-drag',
      );
      const oldBox = await notice.boundingBox();
      const list = page.getByRole('listbox');
      const current = page.getByRole('option', {
        name: ui.case.startsWith('busy') ? /^main/ : 'main',
        exact: true,
      });
      const viewport = await list.boundingBox();
      const currentBox = await current.boundingBox();
      assert.ok(
        currentBox.y >= viewport.y - 1 &&
          currentBox.y + currentBox.height <= viewport.y + viewport.height + 1,
        'Current branch must be visible on open',
      );
      // Real layout regression: the notice grows after the first menu frame,
      // as it does when checkout status arrives later than the branch list.
      assert.ok(
        oldBox.width <= Math.min(360, (await page.evaluate(() => globalThis.innerWidth)) - 32),
      );
      await notice.evaluate((el) => {
        el.style.paddingBottom = '48px';
      });
      await page.waitForFunction(() => {
        const list = globalThis.document.querySelector('[role="listbox"]');
        const row = list?.querySelector('[aria-selected="true"]');
        if (!list || !row) return false;
        const viewport = list.getBoundingClientRect();
        const current = row.getBoundingClientRect();
        return current.top >= viewport.top - 1 && current.bottom <= viewport.bottom + 1;
      });
      await notice.evaluate((el) => {
        el.style.paddingBottom = '';
      });
      const initialScroll = await list.evaluate((el) => el.scrollTop);
      if (ui.case === 'operation') {
        assert.equal(initialScroll, 0, 'A current branch near the top must not scroll');
      } else {
        assert.ok(initialScroll > 0, 'A current branch near the end must scroll into view');
      }
      await page.getByRole('listbox').evaluate((el) => {
        el.scrollTop = 1000;
      });
      assert.deepEqual(await notice.boundingBox(), oldBox);
      await list.evaluate((el, scroll) => {
        el.scrollTop = scroll;
      }, initialScroll);
    }
    for (const card of await page.locator('[aria-live][data-state]').all()) {
      assert.equal(
        await card.evaluate((el) =>
          globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region'),
        ),
        'no-drag',
      );
    }
    const after = await geometry();
    assert.deepEqual(after, before, 'Feedback must not move or resize the controls row or input');
    console.log('CHECKOUT_ROW_GEOMETRY', JSON.stringify({ case: ui.case, before, after }));
  },
};
