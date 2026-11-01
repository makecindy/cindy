import assert from 'node:assert/strict';

// Regression: the production MessageStream used to leave navigation highlights
// on forever. Existing scroll tests only cover landing/cancellation, not painted
// lifetime. One click is the minimal failing input; this is a real-renderer check.
export default {
  name: 'message-focus',
  entry: './focus-fixture.tsx',
  viewport: { width: 900, height: 600 },
  stubs: {
    'src/renderer/components/chat/GhostToolCard':
      'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
  },
  real: 'MessageStream navigation, focus lifecycle, background/ring transitions, theme tokens',
  notCovered: 'Host search transport, native mobile, agent execution',
  cases: {
    default: { about: 'Ordinary task message navigation' },
    compact: { about: 'Companion message navigation' },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const target = (id) => page.locator(`[data-message-client-id="${id}"]`);
    const highlighted = (id) =>
      target(id).evaluate((node) => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)');
    const locate = async (id) => {
      await page.getByTestId(`focus-${id}`).click();
      await page.waitForFunction((id) => {
        const node = document.querySelector(`[data-message-client-id="${id}"]`);
        return node && getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)';
      }, id);
    };
    // Install before navigation: screenshot/audit latency must not eat the fade.
    // Only record transitions whose destination is the original unlit style,
    // so entrance frames cannot satisfy an exit assertion.
    await target('first').evaluate((node) => {
      const properties = { 'background-color': 'backgroundColor', 'box-shadow': 'boxShadow' };
      const baseline = Object.fromEntries(
        Object.values(properties).map((key) => [key, getComputedStyle(node)[key]]),
      );
      const exits = {};
      window.__messageFocusFade = { baseline, exits };
      const recordExit = (event) => {
        const key = properties[event.propertyName];
        if (event.target !== node || !key) return;
        const animation = node
          .getAnimations()
          .find((item) => item.transitionProperty === event.propertyName);
        if (!animation || animation.effect.getKeyframes().at(-1)[key] !== baseline[key]) return;
        const elapsed = animation.currentTime;
        const duration = animation.effect.getComputedTiming().duration;
        // Sample the real CSS transition at exact progress points. This avoids
        // depending on renderer frame rate during a short, token-based exit.
        animation.pause();
        animation.currentTime = 0;
        const start = getComputedStyle(node)[key];
        animation.currentTime = duration / 2;
        const middle = getComputedStyle(node)[key];
        animation.currentTime = duration;
        const end = getComputedStyle(node)[key];
        animation.currentTime = elapsed;
        animation.play();
        animation.finished.then(() => {
          exits[key] = { start, middle, end, final: getComputedStyle(node)[key] };
          if (Object.keys(exits).length === 2)
            node.removeEventListener('transitionrun', recordExit);
        });
      };
      node.addEventListener('transitionrun', recordExit);
    });
    await locate('first');
    // Update while the locator is active, before any potentially slow capture.
    await page.getByTestId('update').click();
    await ui.capture('highlight');
    await page.waitForFunction(() => Object.keys(window.__messageFocusFade.exits).length === 2);
    const { baseline, exits } = await page.evaluate(() => window.__messageFocusFade);
    assert.equal(
      await highlighted('first'),
      false,
      'Navigation highlight expires despite content updates',
    );
    for (const key of ['backgroundColor', 'boxShadow']) {
      assert.notEqual(
        exits[key].middle,
        exits[key].start,
        `${key} leaves its lit value during exit`,
      );
      assert.notEqual(exits[key].middle, exits[key].end, `${key} has an intermediate exit value`);
      assert.equal(exits[key].final, baseline[key], `${key} returns to its unlit value`);
    }
    await ui.capture('faded');
    await locate('first'); // Repeat the same target after its previous expiry.
    await locate('second'); // Replace a still-visible target.
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-message-client-id="first"]'))
          .backgroundColor === 'rgba(0, 0, 0, 0)',
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-message-client-id="second"]'))
          .backgroundColor === 'rgba(0, 0, 0, 0)',
    );
    await locate('second');
    await page.getByTestId('clear').click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-message-client-id="second"]'))
          .backgroundColor === 'rgba(0, 0, 0, 0)',
    );
  },
};
