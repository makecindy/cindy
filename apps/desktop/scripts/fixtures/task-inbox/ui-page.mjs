import assert from 'node:assert/strict';
export default {
  name: 'task-inbox',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 640 },
  real: 'TaskInbox, SessionEntryRows, SessionItem, shared inbox classifier',
  notCovered: 'Persistence, remote devices, mobile native sheets and full sidebar filtering',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
  },
  cases: {
    structure: {
      about: 'Task list and inbox switch exclusively from sidebar settings',
    },
    list: { about: 'Default list-row presentation with inbox actions at narrow width' },
    default: {
      about: 'Read task stays in inbox, waiting task above running, snoozed and processed sections',
    },
    reply: {
      about: 'Replying to the open task moves it to Working at once without scrolling the sidebar',
    },
    intro: {
      about: 'The first switch into the inbox on this computer introduces it once; later switches do not',
      viewport: { width: 1040, height: 760 },
    },
  },
  async check(page, ui) {
    if (ui.case === 'reply') {
      const scroller = page.locator('[data-inbox-scroller]');
      const working = page.locator('section').filter({ has: page.locator('button', { hasText: await ui.t('ccAgent.sidebar.inbox.working') }) });
      await working.locator('> button').click();
      await page.locator('[data-session-id="ready"]').click();
      await scroller.evaluate((node) => { node.scrollTop = 0; });
      // Reading a row inside the list must allow it to change sections.
      await page.locator('[data-session-id="ready"]').hover({ position: { x: 30, y: 10 } });
      await page.evaluate(() => window.__replyToReady());
      await working.locator('[data-session-id="ready"]').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await scroller.evaluate((node) => node.scrollTop), 0, 'The sidebar does not scroll after the moved row');
      await ui.capture('replied');
      return;
    }
    if (ui.case === 'intro') {
      const toggle = page.locator('[data-task-list-mode-toggle]');
      await toggle.click();
      const intro = page.locator('[data-feature-intro]');
      await page.getByText(await ui.t('featureIntro.taskInbox.lead'), { exact: true }).waitFor();
      const box = await intro.boundingBox();
      assert.ok(box && box.height < ui.viewport.height, 'The introduction fits without scrolling');
      await ui.capture('intro');
      await page.getByRole('button', { name: await ui.t('featureIntro.taskInbox.start'), exact: true }).click();
      await intro.waitFor({ state: 'detached' });
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      // Shown once: leaving and entering again goes straight to the inbox.
      await toggle.click();
      await toggle.click();
      assert.equal(await intro.count(), 0);
      return;
    }
    if (ui.case === 'structure') {
      const project = page.locator('[data-project-header]').first();
      const inbox = page.locator('section > button').first();
      await project.waitFor();
      await project.click();
      assert.equal(await inbox.count(), 0);
      await ui.capture('task-list-mode');
      // The toggle at the right end of the top chrome row switches modes and shows pressed in the inbox.
      const toggle = page.locator('[data-task-list-mode-toggle]');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      await ui.capture('mode-toggle');
      await toggle.click();
      await inbox.waitFor();
      assert.equal(await project.count(), 0);
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByRole('menuitem', { name: new RegExp(await ui.t('ccAgent.sidebar.taskListMode.heading')) }).count(), 0);
      await page
        .locator('section > button')
        .filter({ hasText: await ui.t('ccAgent.sidebar.inbox.archived') })
        .click();
      await page.locator('[data-session-id="done"]').waitFor();
      // The project icon is enough: no project name beside inbox titles (2026-11-18 user decision).
      assert.equal(await page.locator('[data-project-source]').count(), 0, 'No project name beside inbox titles');
      await ui.capture('inbox-mode');
      return;
    }

    // Hidden inbox actions must not reserve a second column beside the task row.
    // Check a non-hovered row after focusing a different task so keyboard actions remain covered.
    await page.mouse.move(1, 639);
    const ready = page.locator('[data-session-id="ready"]');
    const sectionHeader = page.locator('section > button').first();
    const rowBox = await ready.boundingBox();
    const headerBox = await sectionHeader.boundingBox();
    assert.ok(rowBox && headerBox);
    assert.ok(
      Math.abs(rowBox.width - headerBox.width) <= 2,
      `Task row must use section width: ${rowBox.width} / ${headerBox.width}`,
    );
    await page.locator('[data-session-id="ready"]').click();
    assert.equal(await page.locator('[data-session-id="ready"]').count(), 1);
    for (const section of ['working', 'snoozed', 'archived']) {
      await page
        .locator('section > button')
        .filter({ hasText: await ui.t(`ccAgent.sidebar.inbox.${section}`) })
        .first()
        .click();
    }
    await page.locator('[data-session-id="done"]').waitFor();
    const workingSection = page.locator('section > button').filter({ hasText: await ui.t('ccAgent.sidebar.inbox.working') }).locator('..');
    await workingSection.locator('[data-session-id="following"]').waitFor();
    assert.equal(await workingSection.locator('[data-session-id="running"]').count(), 1);
    assert.equal(await workingSection.locator('[data-session-id="waiting"]').count(), 0);
    // Schedules have loaded ('following' sits in Working). The inbox still shows no automation
    // mark, although 'ready' and 'following' are bound to automations (2026-11-18 user decision).
    for (const key of ['ccAgent.sidebar.scheduleBinding.viewTask', 'ccAgent.sidebar.scheduleBinding.label']) {
      assert.equal(await page.locator(`[aria-label="${await ui.t(key)}"]`).count(), 0, 'No automation mark in inbox rows');
    }
    await ui.capture('all-sections');
    await ready.hover();
    // Inbox shows a one-click Done instead of the two-step archive.
    const archiveLabel = await ui.t('ccAgent.sidebar.inbox.complete');
    const moreLabel = await ui.t('ccAgent.sidebar.sessionMenu.moreActions');
    assert.equal(await ready.getByRole('button', { name: archiveLabel, exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: moreLabel, exact: true }).count(), 0);
    const hoverBox = await ready.boundingBox();
    assert.ok(Math.abs(hoverBox.width - headerBox.width) <= 2);
    await ui.capture('row-actions');
    await ready.click({ button: 'right' });
    await page.getByRole('menu').waitFor();
    const snoozeLabel = await ui.t('ccAgent.sidebar.inbox.snooze');
    await page.getByRole('menuitem', { name: snoozeLabel, exact: true }).waitFor();
    await ui.capture('context-menu');
    await page.keyboard.press('Escape');
    // One click on Done archives at once (even for the open task). The list holds still while
    // hovered, but an explicit Done leaves its slot immediately; restore brings it back.
    await ready.hover();
    await ready.getByRole('button', { name: archiveLabel, exact: true }).click();
    const archivedSection = page.locator('section > button')
      .filter({ hasText: await ui.t('ccAgent.sidebar.inbox.archived') }).locator('..');
    await archivedSection.locator('[data-session-id="ready"]').waitFor();
    assert.equal(await ready.getByRole('button', {
      name: await ui.t('ccAgent.sidebar.sessionMenu.archived'), exact: true,
    }).count(), 0);
    await ready.click({ button: 'right' });
    await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.sessionMenu.unarchive'), exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: snoozeLabel, exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await ready.hover();
    await ready
      .getByRole('button', {
        name: await ui.t('ccAgent.sidebar.sessionMenu.unarchive'),
        exact: true,
      })
      .click();
    await ready.getByRole('button', { name: archiveLabel, exact: true }).waitFor();
    await page.locator('[data-session-id="later"]').hover();
    await page
      .locator('[data-session-id="later"]')
      .getByRole('button', { name: await ui.t('ccAgent.sidebar.inbox.snooze'), exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.inbox.wake'), exact: true })
      .waitFor();
    await ui.capture('snooze-menu');
    const tomorrow = page
      .getByRole('menuitem')
      .filter({ hasText: await ui.t('ccAgent.sidebar.inbox.tomorrow') });
    assert.equal(await tomorrow.locator('time').count(), 1);
    const previewedUntil = await tomorrow.locator('time').getAttribute('datetime');
    await tomorrow.click();
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.snoozedUntil === expected,
      previewedUntil,
    );
    const later = page.locator('[data-session-id="later"]');
    await later.getByRole('button', { name: snoozeLabel, exact: true }).click();
    const indefinite = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.inbox.indefinite'), exact: true });
    assert.equal(await indefinite.locator('time').count(), 0);
    await indefinite.click();
    await page.waitForFunction(() => document.documentElement.dataset.snoozedUntil === '9999-12-31T23:59:59.999Z');
    await later.click({ button: 'right' });
    await page.getByRole('menuitem', { name: snoozeLabel, exact: true }).click();
    await page
      .getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.inbox.custom'), exact: true })
      .click();
    const dialog = page.getByRole('alertdialog');
    const input = dialog.locator('input[type="datetime-local"]');
    await input.fill('2000-01-01T09:00');
    const confirm = dialog.getByRole('button', {
      name: await ui.t('ccAgent.sidebar.inbox.snooze'),
      exact: true,
    });
    assert.equal(await confirm.isDisabled(), true);
    const customValue = await page.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() + 2);
      date.setHours(10, 30, 0, 0);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:30`;
    });
    await input.fill(customValue);
    await ui.capture('custom-time');
    const expectedCustom = await page.evaluate(
      (value) => new Date(value).toISOString(),
      customValue,
    );
    await confirm.click();
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.snoozedUntil === expected,
      expectedCustom,
    );
    assert.equal(await dialog.count(), 0);
  },
};
