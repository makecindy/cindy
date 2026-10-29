/* global window, document, getComputedStyle -- evaluated inside the page by Playwright */
import assert from 'node:assert/strict';

const ARM_WAIT = 800; // ARM_MS (600) plus margin for the real clock

export default {
  name: 'approvals-inbox',
  entry: './approvals-inbox-fixture.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'ApprovalsInbox (queue, inspector, DecisionGate, selection, placeholders, worker identity lookup), real PermissionPrompt, MenuButton with its approvals badge, standard Button, theme tokens and all five locales',
  notCovered: 'Real makerChatStore and IPC decisions (an in-memory store mirrors respondToPermission: submitting at once, card cleared on a simulated receipt), host reconciliation, session metadata IPC, navigation for Open session, the full title bar and native Mobile',
  stubs: {
    'src/renderer/lib/makerChatStore': './store-stub.ts',
    'src/renderer/lib/makerTransport': './transport-stub.ts',
    'src/renderer/lib/orcaSessionIdentity': { partial: 'export const resolveSessionRoute = async (id) => "/cc-agent/" + id;' },
    'src/renderer/features/cc-agent/useRegisterCCAgentSidebar': 'export const useRegisterCCAgentSidebar = () => {};',
    'src/renderer/state/agentIslandActivity': 'const activities = new Map(); export const useAgentIslandActivityMap = () => activities;',
    'src/renderer/features/device-link/useSharedTaskTasks': 'export const useSharedTaskTasks = () => {};',
    'src/renderer/features/device-link/SharedTaskEndedNotice': 'export const SharedTaskEndedNotice = () => null;',
    'src/renderer/lib/checkForUpdateWithToast': 'export const checkForUpdateWithToast = async () => {};',
  },
  cases: {
    default: { about: 'Wide window: five requests, nothing selected; the check selects one, waits out the arming lock and decides with real pointer input' },
    idle: { about: 'Nothing selected: calm inspector, no decision control exists' },
    submitting: { about: 'A decision is in flight: that row says Sending and its prompt is disabled' },
    failed: { about: 'Delivery failed: the row says Not sent and the prompt stays usable' },
    placeholder: { about: 'A request vanished: same-height No longer waiting placeholder, nothing selected' },
    empty: { about: 'No requests: no badge, calm empty state' },
    mid: { about: '900x700: two panels, prompt actions on one row', viewport: { width: 900, height: 700 } },
    boundary: { about: '780x700, below the two-panel threshold: queue, then stacked inspector with Back', viewport: { width: 780, height: 700 } },
    narrow: { about: '520x800: queue, then stacked inspector with Back', viewport: { width: 520, height: 800 } },
  },
  async check(page, ui) {
    await page.getByRole('heading', { name: await ui.t('approvalsInbox.title'), exact: true, level: 1 }).waitFor({ state: 'attached' });
    const log = () => page.evaluate(() => window.__approvalStore.log);
    const options = page.getByRole('option');
    const allow = page.getByRole('button', { name: await ui.t('agentIsland.native.allowOnce'), exact: true });
    const gateInert = () => page.getByTestId('decision-gate').evaluate((element) => element.hasAttribute('inert'));

    if (ui.case === 'empty') {
      assert.equal(await options.count(), 0);
      assert.equal(await page.getByTestId('approvals-indicator').count(), 0, 'no badge without requests');
      assert.ok(await page.getByText(await ui.t('approvalsInbox.emptyTitle'), { exact: true }).isVisible());
      return;
    }

    // Rows are summaries only: no decision control, no command text, no keycap shortcuts.
    const queue = page.getByRole('listbox');
    if (await queue.count()) {
      assert.equal(await queue.getByRole('button').count(), 0, 'queue rows have no buttons');
      const text = await queue.innerText();
      assert.ok(!/pnpm|git diff|verify-localization/.test(text), 'queue never shows the command');
    }
    assert.equal(await page.locator('kbd').count(), 0, 'no approval shortcut keycaps');
    assert.equal(await page.getByTestId('approvals-indicator').first().innerText(), String(await countPending(page)), 'badge matches the queue');

    if (ui.case === 'idle') {
      assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 0);
      assert.equal(await page.getByTestId('decision-gate').count(), 0, 'nothing selected, no decision control');
      return;
    }

    if (ui.case === 'placeholder') {
      await page.evaluate(() => window.__approvalStore.remove('s-tests'));
      const ended = page.locator('[role="option"][aria-disabled="true"]');
      await ended.waitFor();
      assert.ok((await ended.innerText()).includes(await ui.t('approvalsInbox.ended')));
      assert.ok(!/allowed|denied/i.test(await ended.innerText()), 'neutral wording only');
      assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 0);
      await ui.capture('placeholder');
      return;
    }

    if (ui.case === 'boundary' || ui.case === 'narrow') {
      assert.equal(await page.getByTestId('decision-gate').count(), 0, 'stacked list view has no inspector');
      await options.first().click();
      await page.getByRole('button', { name: await ui.t('approvalsInbox.back'), exact: true }).waitFor();
      assert.equal(await page.getByRole('listbox').count(), 0, 'detail replaces the queue');
      assert.equal(await gateInert(), true, 'arming lock after selecting');
      await ui.capture('detail-arming');
      await page.waitForTimeout(ARM_WAIT);
      assert.equal(await gateInert(), false);
      await ui.capture('detail-ready');
      await page.getByRole('button', { name: await ui.t('approvalsInbox.back'), exact: true }).click();
      assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 0, 'Back clears the selection');
      return;
    }

    // Wide layouts: select by real click, observe the arming lock, then decide.
    await options.first().click();
    assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 1);
    assert.equal(await gateInert(), true, 'inert while arming');
    const strip = page.getByTestId('arming-band');
    assert.equal(await strip.getAttribute('data-visible'), 'true');
    if (ui.case === 'default') await ui.capture('arming');

    // A real pointer click on Allow once during arming must do nothing.
    const box = await allow.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal((await log()).length, 0, 'click during arming is ignored');

    await page.waitForTimeout(ARM_WAIT);
    assert.equal(await gateInert(), false, 'armed after 600 ms');
    const armed = await allow.boundingBox();
    assert.deepEqual([armed.x, armed.y, armed.width, armed.height], [box.x, box.y, box.width, box.height], 'Allow once does not move when arming ends');
    await page.mouse.move(2, 2);
    const look = await allow.evaluate((element) => { const c = getComputedStyle(element); return { opacity: c.opacity, bg: c.backgroundColor, color: c.color }; });
    if (ui.case !== 'submitting') assert.equal(look.opacity, '1', 'controls are fully opaque once armed: ' + JSON.stringify(look));
    await ui.capture('ready');

    if (ui.case === 'submitting' || ui.case === 'failed') {
      const disabled = await allow.isDisabled();
      assert.equal(disabled, ui.case === 'submitting', ui.case === 'submitting' ? 'prompt disabled while sending' : 'prompt usable after a failed delivery');
      return;
    }
    if (ui.case === 'mid') {
      const wrapped = await page.locator('[data-compact-actions]').evaluate((element) => {
        const tops = [...element.querySelectorAll('button')].map((button) => Math.round(button.getBoundingClientRect().top));
        return Math.max(...tops) - Math.min(...tops);
      });
      assert.ok(wrapped < 24, 'Deny / session action / Allow once share a row at 900 px (offset ' + wrapped + ' px)');
      return;
    }

    // Keyboard: Tab from the selected row reaches Open session; Enter and Escape never decide.
    await page.getByRole('option', { selected: true }).focus();
    await page.keyboard.press('Tab');
    assert.ok((await page.evaluate(() => document.activeElement?.textContent ?? '')).includes(await ui.t('approvalsInbox.openSession')), 'Tab order: row, Open session');
    await page.getByRole('option', { selected: true }).focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Enter');
    assert.equal((await log()).length, 0, 'global keys never decide');

    // Decide with a real click: exactly one decision, to the selected session.
    await allow.click();
    await page.waitForFunction(() => window.__approvalStore.log.length === 1);
    assert.equal((await log())[0].sessionId, 's-frontend');
    assert.equal((await log()).length, 1);
    await page.waitForSelector('[role="option"][aria-disabled="true"]');
    assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 0, 'nothing auto-selected after a decision');
    assert.equal(await page.getByTestId('decision-gate').count(), 0);
    await ui.capture('after-decision');

    // The queue changes under the cursor: the next click still acts on the request that is displayed.
    await options.nth(2).click();
    await page.waitForTimeout(ARM_WAIT);
    const target = await page.getByRole('option', { selected: true }).getAttribute('data-key');
    const queueBox = await page.getByRole('listbox').boundingBox();
    await page.mouse.move(queueBox.x + queueBox.width / 2, queueBox.y + 60);
    await page.evaluate(() => { window.__approvalStore.remove('s-tests'); window.__approvalStore.add('s-review'); });
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('option', { selected: true }).getAttribute('data-key'), target, 'selection survives queue changes');
    await allow.click();
    await page.waitForFunction(() => window.__approvalStore.log.length === 2);
    assert.equal((await log())[1].sessionId, 's-backend', 'decision reached the displayed request');
    assert.equal((await log()).length, 2);
    await ui.capture('queue-changed-under-cursor');
  },
};

async function countPending(page) {
  return page.locator('[role="option"]:not([aria-disabled="true"])').count();
}
