import assert from 'node:assert/strict';

// Regression: DESIGN §4 requires menu hover to preserve size and wrapping while
// changing weight. jsdom's dropdownMenuHighlight tests cannot measure font fallback.
// Minimal failure: open the real group's + menu and hover the attachment label on
// macOS; PingFang 400 -> 500 previously shrank its width from 155 to 132 CSS px.
// Tier: ui:check (real Electron layout); no copied product markup or mocked geometry.
function measureMenu(el) {
  return {
    panel: [el.offsetWidth, el.offsetHeight],
    rows: Array.from(el.querySelectorAll('[role="menuitem"]')).map(row => ({
      size: [row.offsetWidth, row.offsetHeight],
      labels: Array.from(row.querySelectorAll('[data-menu-label]')).map(label => {
        const range = document.createRange();
        range.selectNodeContents(label);
        const lines = Array.from(range.getClientRects());
        // Actual CJK advances catch glyph shrink even when a reserved label box is fixed.
        const advances = [];
        const text = label.firstChild;
        if (text?.nodeType === Node.TEXT_NODE) {
          for (let i = 0; i < text.length; i++) {
            if (!/\p{Script=Han}/u.test(text.textContent[i])) continue;
            range.setStart(text, i);
            range.setEnd(text, i + 1);
            advances.push(range.getBoundingClientRect().width);
          }
        }
        return {
          text: label.textContent,
          fontSize: getComputedStyle(label).fontSize,
          width: label.offsetWidth,
          height: label.offsetHeight,
          lines: lines.length,
          advances,
        };
      }),
    })),
  };
}

export default {
  name: 'group-composer-menu',
  entry: './fixture.tsx',
  viewport: { width: 680, height: 420 },
  real: 'BotGroupComposer, shared dropdown menu, menu labels/highlight, product fonts, themes and translations',
  notCovered: 'Audio capture, native voice shortcuts, sending, attachment IO/preview, plans, account state and server operations',
  // No attachment is present; preview imports need Vite's ?url loader, which this builder lacks.
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/components/new-chat/ComposerAttachments': 'export const AttachmentRejectionStrip = () => null; export const ThumbnailStrip = () => null;',
  },
  cases: {
    default: { about: 'Group + menu with its short description' },
    steps: { about: 'Group + menu with a wrapping step-by-step description', data: { divisionSteps: true } },
    'custom-font': {
      about: 'An explicitly selected UI font retains precedence over the repaired fallback',
      data: { divisionSteps: true, uiFamily: '"HarmonyOS Sans SC"' },
    },
  },
  async check(page, ui) {
    const trigger = page.getByRole('button', { name: await ui.t('bots.groupChat.composer.more'), exact: true });
    await trigger.click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await menu.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    await page.mouse.move(600, 30);
    const before = await menu.evaluate(measureMenu);
    if (ui.case === 'custom-font') {
      assert.match(await menu.evaluate(el => getComputedStyle(el).fontFamily), /^"HarmonyOS Sans SC"/);
    }
    await ui.capture('rest');
    const stable = async () => {
      // Sample real geometry throughout the weight transition, not only its endpoints.
      for (let frame = 0; frame < 8; frame++) {
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const after = await menu.evaluate(measureMenu);
        assert.deepEqual(after, before, `Hover/focus must preserve text size and wrapping: ${JSON.stringify({ before, after })}`);
      }
    };
    const rows = menu.getByRole('menuitem');
    for (let repeat = 0; repeat < 2; repeat++) {
      for (let index = 0; index < await rows.count(); index++) {
        await rows.nth(index).hover();
        await stable();
        assert.equal(await rows.nth(index).evaluate(el => getComputedStyle(el).fontWeight), '500');
        if (repeat === 0) await ui.capture(`hover-${index}`);
      }
    }
    await page.mouse.move(600, 30);
    for (const [key, index] of [['Home', 0], ['ArrowDown', 1], ['ArrowUp', 0]]) {
      await page.keyboard.press(key);
      await stable();
      assert.equal(await rows.nth(index).evaluate(el => el === document.activeElement), true);
    }
    await ui.capture('keyboard');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  },
};
