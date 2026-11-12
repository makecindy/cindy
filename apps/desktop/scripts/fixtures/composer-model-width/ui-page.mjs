import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';

// Browser-tier regression: jsdom cannot measure clipped text or overlapping controls.
const stubs = { ...companion.stubs };
delete stubs['src/renderer/components/new-chat/ExtraDirsButton'];
delete stubs['src/renderer/components/new-chat/PermissionSelector'];
stubs['src/renderer/hooks/useProviders'] = `
  export const useProviders = () => ({
    providers: [{ id: 'openai', name: 'OpenAI', source: 'builtin', connected: true,
      agents: ['codex'], auth: { method: 'oauth' },
      routing: { codex: { upstream: 'https://example.test', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'fixture-chat', name: window.__uiPage.ctx.data.modelName,
        contextWindow: 200000, efforts: [], defaultEffort: null }] } }], providerOrder: [], loading: false,
  });`;

export default {
  name: 'composer-model-width',
  entry: '../companion-composer/companion-composer-fixture.tsx',
  viewport: { width: 760, height: 400 },
  real: 'ChatInput, ModelSelector, ExtraDirsButton, PermissionSelector, VoiceInputButton and SendButton',
  notCovered: 'Full Desktop, native window drag, real accounts, microphone and model discovery; the host and model catalog use fixture data.',
  stubs,
  cases: {
    default: { about: 'Long English model fits without premature truncation', data: { showRuntimeControls: true, modelName: 'GPT-6 Astra Extended Context' } },
    chinese: { about: 'Chinese model name and a narrow composer', viewport: { width: 420, height: 400 }, data: { showRuntimeControls: true, modelName: '复杂任务长名称模型' } },
    tight: { about: 'All controls remain reachable in an extremely narrow composer', viewport: { width: 300, height: 400 }, data: { showRuntimeControls: true, modelName: 'GPT-6 Astra Extended Context' } },
    recording: { about: 'Expanded recording controls do not hide neighbouring actions', viewport: { width: 360, height: 400 }, data: { showRuntimeControls: true, modelName: 'GPT-6 Astra Extended Context' } },
    resize: { about: 'The model menu closes when the composer is resized without resizing the window', data: { showRuntimeControls: true, modelName: 'GPT-6 Astra Extended Context' } },
    'loading-narrow': { about: 'Loading a model preserves the action position in a narrow composer', viewport: { width: 320, height: 400 }, data: { showRuntimeControls: true, modelLoading: true, modelName: 'GPT-6 Astra Extended Context' } },
    'loading-wide': { about: 'Loading a model preserves the action position in a wide composer', viewport: { width: 800, height: 400 }, data: { showRuntimeControls: true, modelLoading: true, modelName: 'GPT-6 Astra Extended Context' } },
  },
  async ready(page) {
    await page.locator('[contenteditable="true"]').waitFor();
  },
  async check(page, ui) {
    const slot = page.locator('[data-session-model-slot]');
    const toolbar = slot.locator('..').locator('..');
    if (ui.data.modelLoading) {
      const action = toolbar.locator('button').last();
      const before = await action.boundingBox();
      await page.getByTestId('toggle-model-ready').click();
      await slot.locator('button').first().waitFor();
      const after = await action.boundingBox();
      assert.ok(Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1,
        `model hydration moved the action: ${JSON.stringify({ before, after })}`);
    }
    const trigger = slot.locator('button').first();
    await trigger.getByText(ui.data.modelName, { exact: true }).waitFor();
    if (ui.case === 'recording') {
      await page.locator('button[aria-pressed]').last().click();
      await page.locator('button[aria-pressed="true"]').waitFor();
      await ui.capture('recording');
    }
    const bounds = await toolbar.evaluate((root) => {
      const rect = (element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const card = root.closest('[data-split-group-composer-drop-target]');
      return { card: rect(card), buttons: [...root.querySelectorAll('button')]
        .filter((button) => button.getClientRects().length)
        .map((button) => ({ label: button.getAttribute('aria-label'), ...rect(button) })) };
    });
    assert.ok(bounds.buttons.length >= 5, 'the model, permission, add, voice and send controls must be present');
    for (const button of bounds.buttons) {
      assert.ok(button.width > 0 && button.height > 0, `empty control: ${button.label}`);
      assert.ok(button.left >= bounds.card.left - 1 && button.right <= bounds.card.right + 1, `control outside composer: ${button.label}`);
    }
    for (const [index, left] of bounds.buttons.entries()) {
      for (const right of bounds.buttons.slice(index + 1)) {
        const overlapX = Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        assert.ok(overlapX <= 1 || overlapY <= 1, `overlapping controls: ${left.label} / ${right.label}`);
      }
    }
    if (ui.case === 'default') {
      const label = await trigger.getByText(ui.data.modelName, { exact: true }).evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(label.scroll <= label.client + 1, `model name truncated despite available space: ${JSON.stringify(label)}`);
    }
    if (ui.case === 'resize') {
      await trigger.click();
      await page.locator('[data-morph-side][data-state="open"]').waitFor();
      await page.locator('[data-fixture-composer]').evaluate((element) => { element.style.width = '300px'; });
      await slot.locator('button[aria-expanded="false"]').waitFor();
      await ui.capture('resized');
    }
  },
};
