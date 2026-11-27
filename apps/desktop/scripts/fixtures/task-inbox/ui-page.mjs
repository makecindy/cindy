import assert from 'node:assert/strict';
export default {
  name: 'task-inbox',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 640 },
  real: 'TaskInbox, SessionEntryRows, SessionItem, TeammateInboxRow, shared inbox classifier',
  notCovered: 'Persistence, remote devices, mobile native sheets, full sidebar filtering, and how a teammate row is resolved from the roster stores (teammateInbox.test.ts)',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
  },
  cases: {
    structure: {
      about: 'Switch modes and filter automation tasks from the inbox menu',
      // Leave room next to the sidebar for its cascading desktop menus.
      viewport: { width: 880, height: 560 },
    },
    list: { about: 'Default list-row presentation with inbox actions at narrow width' },
    default: {
      about: 'Read task stays in inbox, waiting task above running, snoozed and processed sections',
    },
    reply: {
      about: 'Replying to the open task moves it to Working at once without scrolling the sidebar',
    },
    teammates: {
      about: 'Each teammate conversation is one row by whose turn it is; idle ones are left out; Done only where reading settles it',
    },
    pinned: {
      about: 'Pinned items in inbox mode share inbox display rules without Snooze or Done buttons',
    },
    intro: {
      about: 'The first switch into the inbox on this computer introduces it once; later switches do not',
      viewport: { width: 1040, height: 760 },
    },
    offline: {
      about: 'Offline remote computer tasks support queueing Done, Snooze, pending-sync labels, and offline Undo',
    },
  },
  async check(page, ui) {
    if (ui.case === 'offline') {
      const doneTarget = page.locator('[data-session-id="offline-done-target"]');
      const snoozeTarget = page.locator('[data-session-id="offline-snooze-target"]');
      const completeLabel = await ui.t('ccAgent.sidebar.inbox.complete');
      const snoozeLabel = await ui.t('ccAgent.sidebar.inbox.snooze');
      const unarchiveLabel = await ui.t('ccAgent.sidebar.sessionMenu.unarchive');

      await doneTarget.waitFor();
      await doneTarget.hover();
      assert.equal(await doneTarget.getByRole('button', { name: completeLabel, exact: true }).count(), 1);
      assert.equal(await doneTarget.getByRole('button', { name: snoozeLabel, exact: true }).count(), 1);
      await ui.capture('offline-actions');

      // Queue offline Complete -> moves to Archived with pending-archive subtitle
      await doneTarget.getByRole('button', { name: completeLabel, exact: true }).click();
      const archivedSection = page.locator('section > button')
        .filter({ hasText: await ui.t('ccAgent.sidebar.inbox.archived') }).locator('..');
      await archivedSection.locator('> button').click();
      await archivedSection.locator('[data-session-id="offline-done-target"]').waitFor();
      await archivedSection.getByText(await ui.t('ccAgent.sidebar.inbox.pendingArchiveSync')).waitFor();

      // Queue offline Snooze -> moves to Snoozed with pending-sync indicator
      await snoozeTarget.hover();
      await snoozeTarget.getByRole('button', { name: snoozeLabel, exact: true }).click();
      await page.getByRole('menuitem').filter({ hasText: await ui.t('ccAgent.sidebar.inbox.tomorrow') }).click();
      const snoozedSection = page.locator('section > button')
        .filter({ hasText: await ui.t('ccAgent.sidebar.inbox.snoozed') }).locator('..');
      await snoozedSection.locator('> button').click();
      await snoozedSection.locator('[data-session-id="offline-snooze-target"]').waitFor();
      await snoozedSection.getByText(new RegExp(await ui.t('ccAgent.sidebar.inbox.pendingSync'))).waitFor();
      await ui.capture('offline-queued-states');

      // Offline Undo on queued Complete restores it back to Pending
      await doneTarget.hover();
      await doneTarget.getByRole('button', { name: unarchiveLabel, exact: true }).click();
      const pendingSection = page.locator('section > button')
        .filter({ hasText: await ui.t('ccAgent.sidebar.inbox.inbox') }).locator('..');
      await pendingSection.locator('[data-session-id="offline-done-target"]').waitFor();
      await ui.capture('offline-undo');
      return;
    }
    if (ui.case === 'pinned') {
      const pinnedScope = page.locator('[data-sortable-scope="pinned"]');
      const pinnedRow = pinnedScope.locator('[data-session-id="pinned-ready"]');
      const pinnedChild = pinnedScope.locator('[data-session-id="pinned-project-child"]');
      const inboxRow = page.locator('[data-task-inbox-section="inbox"] [data-session-id="ready"]');
      await pinnedRow.waitFor();
      await pinnedChild.waitFor();
      await inboxRow.waitFor();
      // Same inbox display rules: no inline project name and no automation mark in pinned rows.
      assert.equal(await pinnedScope.locator('[data-project-source]').count(), 0, 'No project name beside pinned titles in inbox mode');
      assert.equal(await pinnedScope.locator('.lucide-timer').count(), 0, 'No automation mark in pinned rows in inbox mode');
      await pinnedRow.hover();
      // The sole difference from inbox rows: no Snooze, Done, More, or Archive buttons on hover.
      const doneLabel = await ui.t('ccAgent.sidebar.inbox.complete');
      const snoozeLabel = await ui.t('ccAgent.sidebar.inbox.snooze');
      const moreLabel = await ui.t('ccAgent.sidebar.sessionMenu.moreActions');
      const archiveLabel = await ui.t('ccAgent.sidebar.sessionMenu.archived');
      for (const row of [pinnedRow, pinnedChild]) {
        await row.hover();
        assert.equal(await row.getByRole('button', { name: snoozeLabel, exact: true }).count(), 0);
        assert.equal(await row.getByRole('button', { name: doneLabel, exact: true }).count(), 0);
        assert.equal(await row.getByRole('button', { name: moreLabel, exact: true }).count(), 0);
        assert.equal(await row.getByRole('button', { name: archiveLabel, exact: true }).count(), 0);
      }
      // Regular inbox rows right below still expose Snooze + Done on hover.
      await inboxRow.hover();
      assert.equal(await inboxRow.getByRole('button', { name: snoozeLabel, exact: true }).count(), 1);
      assert.equal(await inboxRow.getByRole('button', { name: doneLabel, exact: true }).count(), 1);
      await page.mouse.move(1, 639);
      await ui.capture('pinned-inbox-list');
      return;
    }
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
    if (ui.case === 'teammates') {
      const section = async (key) => page.locator('section > button')
        .filter({ hasText: await ui.t(`ccAgent.sidebar.inbox.${key}`) }).locator('..');
      const row = (id) => page.locator(`[data-teammate-inbox-row="teammate:local:${id}"]`);
      for (const key of ['working', 'snoozed']) await (await section(key)).locator('> button').click();
      const pending = await section('inbox');
      // Teammates lead their section; the idle one is not in the inbox at all.
      for (const id of ['pm', 'qa', 'older']) await pending.locator(`[data-teammate-inbox-row="teammate:local:${id}"]`).waitFor();
      await (await section('working')).locator('[data-teammate-inbox-row="teammate:local:momo"]').waitFor();
      await (await section('snoozed')).locator('[data-teammate-inbox-row="teammate:local:lulu"]').waitFor();
      assert.equal(await row('idle').count(), 0, 'An idle, read teammate is not listed');
      const header = await page.locator('section > button').first().boundingBox();
      const task = await page.locator('[data-session-id="ready"]').boundingBox();
      const first = await row('pm').boundingBox();
      assert.ok(header && task && first);
      assert.ok(Math.abs(first.width - task.width) <= 1 && Math.abs(first.height - task.height) <= 1,
        `A teammate row uses the task row geometry: ${first.width}x${first.height} / ${task.width}x${task.height}`);
      await page.mouse.move(1, 639);
      await ui.capture('teammate-rows');
      const done = await ui.t('ccAgent.sidebar.inbox.complete');
      const snooze = await ui.t('ccAgent.sidebar.inbox.snooze');
      const actions = async (id) => {
        await row(id).hover();
        return [await row(id).getByRole('button', { name: snooze, exact: true }).count(),
          await row(id).getByRole('button', { name: done, exact: true }).count()];
      };
      // A pending request cannot be completed; a running one has nothing to complete;
      // a computer that does not mirror the snooze offers none.
      assert.deepEqual(await actions('pm'), [1, 0]);
      assert.deepEqual(await actions('momo'), [1, 0]);
      assert.deepEqual(await actions('older'), [0, 1]);
      assert.deepEqual(await actions('qa'), [1, 1]);
      const hovered = await row('qa').boundingBox();
      assert.ok(hovered && Math.abs(hovered.width - first.width) <= 1, 'Hover actions do not change the row width');
      await ui.capture('teammate-actions');
      await row('qa').getByRole('button', { name: snooze, exact: true }).click();
      const tomorrow = page.getByRole('menuitem').filter({ hasText: await ui.t('ccAgent.sidebar.inbox.tomorrow') });
      const until = await tomorrow.locator('time').getAttribute('datetime');
      await ui.capture('teammate-snooze-menu');
      await tomorrow.click();
      // The snooze is written to the conversation's own Session.
      await page.waitForFunction((expected) => document.documentElement.dataset.snoozedUntil === expected
        && document.documentElement.dataset.snoozedSession === 'chat-qa', until);
      await row('lulu').hover();
      await row('lulu').getByRole('button', { name: snooze, exact: true }).click();
      await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.inbox.wake'), exact: true }).waitFor();
      await page.keyboard.press('Escape');
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
      assert.ok(await toggle.getAttribute('aria-description'), 'Unread inbox result in task list mode');
      await ui.capture('mode-toggle');
      await toggle.click();
      await inbox.waitFor();
      assert.equal(await toggle.getAttribute('aria-description'), null, 'Entering the inbox hides the unread indicator');
      await toggle.click();
      await project.waitFor();
      assert.ok(await toggle.getAttribute('aria-description'), 'Leaving with unread results restores the indicator');
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
      const pending = page.locator('section > button').filter({ hasText: await ui.t('ccAgent.sidebar.inbox.inbox') });
      const report = page.locator('[data-session-id="report"]');
      await report.waitFor();
      const count = Number(await pending.locator('span').last().innerText());
      const settings = page.getByRole('button').filter({ has: page.locator('svg.lucide-sliders-horizontal') });
      async function openFilters(inboxMode = true) {
        await settings.focus();
        await settings.press('Enter');
        assert.equal(await page.getByRole('menuitem', { name: new RegExp(await ui.t('ccAgent.sidebar.taskStatusHeading')) }).count(), inboxMode ? 0 : 1);
        await page.getByRole('menuitem', { name: new RegExp(await ui.t('ccAgent.sidebar.filterHeading')) }).press('ArrowRight');
      }
      await openFilters();
      const hide = page.getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.filterHideAutomations'), exact: true });
      assert.equal(await hide.getAttribute('aria-checked'), 'false');
      await hide.click();
      await report.waitFor({ state: 'detached' });
      assert.equal(await hide.getAttribute('aria-checked'), 'true');
      assert.equal(Number(await pending.locator('span').last().innerText()), count - 1);
      assert.equal(await toggle.getAttribute('aria-description'), null, 'Only the hidden automation was unread');
      await ui.capture('inbox-filter');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await toggle.click();
      await project.waitFor();
      await report.waitFor();
      const teammate = page.locator('[data-session-id="teammate"]');
      await teammate.waitFor();
      assert.equal(await toggle.getAttribute('aria-description'), null, 'Task mode keeps the inbox filter for its dot');
      await openFilters(false);
      assert.equal(await hide.getAttribute('aria-checked'), 'false');
      await hide.click();
      await report.waitFor({ state: 'detached' });
      await page.getByRole('menuitem', { name: new RegExp(await ui.t('ccAgent.sidebar.filterCreatorsHeading')) }).press('ArrowRight');
      await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterCreatorsNone'), exact: true }).press('Enter');
      await teammate.waitFor({ state: 'detached' });
      await page.locator('[data-session-id="ready"]').waitFor();
      await page.keyboard.press('ArrowLeft');
      await ui.capture('task-list-filters');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await toggle.click();
      await pending.waitFor();
      assert.equal(await report.count(), 0);
      await openFilters();
      await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterReset'), exact: true }).click();
      await report.waitFor();
      assert.equal(Number(await pending.locator('span').last().innerText()), count);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      const display = page.getByRole('menuitem', { name: new RegExp(await ui.t('ccAgent.sidebar.displayHeading')) });
      const compact = await ui.t('ccAgent.sidebar.viewStyleList');
      const wide = await ui.t('ccAgent.sidebar.viewStyleListWide');
      await settings.press('Enter');
      await display.press('ArrowRight');
      await page.getByRole('menuitem', { name: compact, exact: true }).press('Enter');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await toggle.click();
      await project.waitFor();
      await settings.press('Enter');
      assert.ok((await display.innerText()).includes(wide), 'Regular list retains its own row style');
      await page.keyboard.press('Escape');
      await toggle.click();
      await pending.waitFor();
      await settings.press('Enter');
      assert.ok((await display.innerText()).includes(compact), 'Inbox restores its row style');
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
    const snoozeLabel = await ui.t('ccAgent.sidebar.inbox.snooze');
    const pinned = page.locator('[data-session-id="waiting"]');
    assert.equal(await pinned.getByRole('button', { name: archiveLabel, exact: true }).count(), 1);
    assert.equal(await pinned.getByRole('button', { name: snoozeLabel, exact: true }).count(), 1);
    const moreLabel = await ui.t('ccAgent.sidebar.sessionMenu.moreActions');
    assert.equal(await ready.getByRole('button', { name: archiveLabel, exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: moreLabel, exact: true }).count(), 0);
    const hoverBox = await ready.boundingBox();
    assert.ok(Math.abs(hoverBox.width - headerBox.width) <= 2);
    await ui.capture('row-actions');
    await ready.click({ button: 'right' });
    await page.getByRole('menu').waitFor();
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
    // A pinned task snoozes like any other; the write carries only the snooze, so it stays pinned.
    const pinnedTask = page.locator('[data-session-id="waiting"]');
    await pinnedTask.hover();
    await pinnedTask.getByRole('button', { name: snoozeLabel, exact: true }).click();
    await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.inbox.indefinite'), exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.snoozedSession === 'waiting'
      && document.documentElement.dataset.snoozedUntil === '9999-12-31T23:59:59.999Z'
      && document.documentElement.dataset.patchKeys === 'snoozedUntil');
  },
};
