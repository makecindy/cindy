import assert from 'node:assert/strict';

const members = [
  { botId: 'a', name: 'Aster' },
  { botId: 'b', name: 'Nova' },
];
const base = { name: 'Design review', members, messages: 0, sidebar: true };
const LONG_DEVICE = 'Mac Studio · A very long device name for layout verification';

/** Migrated from check-group-control-layout.mjs (remote-control notice above the composer). */
export default {
  name: 'group-chat',
  entry: './group-control-fixture.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'BotGroupChatView (timeline, composer, send button, header registration), ControlledBanner, ContentHeader shell, Markdown, theme, fonts and translations',
  notCovered:
    'Sending, round control, real device-link control and revocation, pending interactions, plans and attachments; the sidebar is an empty frame',
  cases: {
    default: { about: 'Empty group, short controller name, expanded sidebar', data: base },
    'long-thread': {
      about: '40 messages: bottom pin and history position survive notice changes',
      viewport: { width: 800, height: 600 },
      data: { ...base, messages: 40 },
    },
    'long-device': {
      about: 'Long controller device name in the notice',
      data: base,
      controller: LONG_DEVICE,
    },
    multiline: { about: 'Eight-line draft pushes the composer up', data: base, lines: 8 },
    'no-sidebar': { about: 'Collapsed sidebar layout', data: { ...base, sidebar: false } },
  },
  async ready(page) {
    await page.locator('textarea').waitFor();
  },
  async check(page, ui) {
    const definition = this.cases[ui.case];
    const input = page.locator('textarea');
    const chip = page.locator('[data-controlled-banner-chip]');
    const collapsedDot = page.locator('[data-controlled-banner="collapsed"]');
    const scroller = page.getByTestId('bot-group-timeline');
    const connect = async (connected = true) => {
      const name = definition.controller ?? 'Mac Studio';
      assert.ok(
        await ui.emit('controlledState', {
          controllers: connected ? [{ deviceId: 'fixture', name }] : [],
        }),
        'banner subscribed to controlled state',
      );
      await chip.waitFor({ state: connected ? 'visible' : 'detached' });
    };
    const collapse = async () => {
      await page.locator('[data-controlled-banner-collapse]').click();
      await collapsedDot.waitFor();
      assert.equal(await chip.count(), 0);
    };
    const expand = async () => {
      await collapsedDot.click();
      await chip.waitFor();
    };

    if (ui.case === 'long-thread') {
      const bottomGap = () =>
        scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="bot-group-timeline"]');
        return (
          el &&
          el.scrollHeight > el.clientHeight &&
          el.scrollHeight - el.clientHeight - el.scrollTop < 1
        );
      });
      for (const [step, action] of [
        ['connection', () => connect()],
        ['collapse', collapse],
        ['expand', expand],
        ['disconnection', () => connect(false)],
      ]) {
        await action();
        assert.ok((await bottomGap()) < 1, `${step} keeps the thread pinned to the bottom`);
      }
      const before = await scroller.evaluate((el) => {
        el.scrollTop = 180;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        return el.scrollTop;
      });
      for (const [step, action] of [
        ['connection', () => connect()],
        ['collapse', collapse],
        ['expand', expand],
        ['disconnection', () => connect(false)],
      ]) {
        await action();
        assert.equal(
          await scroller.evaluate((el) => el.scrollTop),
          before,
          `${step} keeps history position`,
        );
      }
      await connect();
      await ui.capture('history');
      return;
    }

    await connect();
    await input.fill(
      Array(definition.lines ?? 1)
        .fill('Layout check only; never sent.')
        .join('\n'),
    );
    // BotGroupComposer labels its send button with bots.send (not the shared SendButton default).
    const sendLabel = await ui.t('bots.send');
    const layout = await page.evaluate((sendLabel) => {
      const notice = document.querySelector('[data-controlled-banner-chip]');
      const textarea = document.querySelector('textarea');
      const card = textarea.parentElement.getBoundingClientRect();
      const send = textarea.parentElement.querySelector(`button[aria-label="${sendLabel}"]`);
      const reachable = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      };
      const n = notice.getBoundingClientRect();
      return {
        centerDelta: Math.abs(n.x + n.width / 2 - card.x - card.width / 2),
        above: n.bottom <= card.y,
        reachable: [
          textarea,
          send,
          notice.querySelector('button'),
          notice.querySelector('[data-controlled-banner-collapse]'),
        ].map(reachable),
      };
    }, sendLabel);
    assert.ok(layout.centerDelta < 1, 'notice is centered on the composer');
    assert.ok(layout.above, 'notice sits above the composer');
    assert.deepEqual(
      Object.fromEntries(
        ['input', 'send', 'revoke', 'collapse'].map((name, i) => [name, layout.reachable[i]]),
      ),
      { input: true, send: true, revoke: true, collapse: true },
      `input, send ("${sendLabel}"), revoke and collapse are clickable`,
    );
    await ui.capture('connected');
    await collapse();
    const dot = await page.evaluate(() => {
      const el = document.querySelector('[data-controlled-banner="collapsed"]');
      const r = el.getBoundingClientRect();
      const card = document.querySelector('textarea').parentElement.getBoundingClientRect();
      return {
        centerDelta: Math.abs(r.x + r.width / 2 - card.x - card.width / 2),
        above: r.bottom <= card.y,
        reachable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      };
    });
    assert.ok(dot.centerDelta < 1 && dot.above && dot.reachable, 'collapsed indicator placement');
    await ui.capture('collapsed');
    await expand();
    // Reach the notice through normal tab order; both activation keys toggle it.
    const viaKeyboard = async (selector, key) => {
      await input.focus();
      await page.keyboard.press('Shift+Tab');
      const target = page.locator(selector);
      assert.ok(
        await target.evaluate(
          (el) =>
            el === document.activeElement &&
            Boolean(el.getAttribute('aria-label')) &&
            el.matches(':focus-visible') &&
            getComputedStyle(el).boxShadow !== 'none',
        ),
        `${selector} is keyboard reachable with visible focus`,
      );
      await page.keyboard.press(key);
    };
    for (const key of ['Enter', 'Space']) {
      await viaKeyboard('[data-controlled-banner-collapse]', key);
      await collapsedDot.waitFor();
      await viaKeyboard('[data-controlled-banner="collapsed"]', key);
      await chip.waitFor();
    }
    await input.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    assert.ok(
      await chip
        .locator('button')
        .first()
        .evaluate((el) => el === document.activeElement),
      'revoke is a separate tab stop',
    );
    assert.equal(await page.getByRole('dialog').count(), 0, 'folding never opens a dialog');
  },
};
