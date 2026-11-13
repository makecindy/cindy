import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';

// Browser-tier regression: the real ChatInput hid plugin actions with a long model at
// 400px; the original model-only scenarios cannot measure plugin reachability or clipping.
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
  real: 'ChatInput, ModelSelector, ExtraDirsButton, PermissionSelector, PluginUiProvider, PluginUiSlot, VoiceInputButton and SendButton',
  notCovered: 'Full Desktop, native window drag, real accounts, microphone and model discovery; the host and model catalog use fixture data.',
  stubs,
  cases: {
    default: { about: 'Long English model fits without premature truncation', data: { showRuntimeControls: true, modelName: 'GPT-6 Astra Extended Context' } },
    chinese: { about: 'Chinese model name and a narrow composer', viewport: { width: 420, height: 400 }, data: { showRuntimeControls: true, modelName: '复杂任务长名称模型' } },
    'long-ultra': { about: 'A very long model name leaves room for icon-only controls', viewport: { width: 400, height: 400 }, data: { showRuntimeControls: true, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'long-dense': { about: 'A very long model name leaves room for the permission label', viewport: { width: 600, height: 400 }, data: { showRuntimeControls: true, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'plugin-long': { about: 'A long model name does not hide a plugin toolbar action', viewport: { width: 400, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 1, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'plugin-many': { about: 'Several plugin actions remain reachable in a narrow composer', viewport: { width: 400, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 3, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'plugin-tight': { about: 'Plugin actions remain reachable in an extremely narrow composer', viewport: { width: 300, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 2, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'plugin-compact': { about: 'A plugin action remains reachable next to a long model name in a compact composer', viewport: { width: 500, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 1, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'plugin-dense': { about: 'A plugin action remains reachable next to a long model name in a wider composer', viewport: { width: 600, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 1, modelName: 'Anthropic Claude Opus Extended Reasoning Context with Long Provider Model Name' } },
    'plugin-wide': { about: 'A long plugin label uses available space in a wide composer', data: { showRuntimeControls: true, pluginToolbar: 1, pluginTitle: 'A much longer plugin action label', modelName: 'GPT-6 Astra' } },
    'plugin-hidden': { about: 'Hidden plugin actions do not reserve empty toolbar space', data: { showRuntimeControls: true, pluginToolbar: 1, pluginHidden: true, modelName: 'GPT-6 Astra Extended Context' } },
    'plugin-hidden-narrow': { about: 'Hidden plugin actions do not obstruct a narrow composer', viewport: { width: 400, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 1, pluginHidden: true, modelName: 'GPT-6 Astra Extended Context' } },
    'plugin-recording': { about: 'Recording and plugin actions remain reachable together', viewport: { width: 360, height: 400 }, data: { showRuntimeControls: true, pluginToolbar: 2, recording: true, modelName: 'GPT-6 Astra Extended Context' } },
    'plugin-no-model': { about: 'Plugin actions remain reachable when runtime controls are hidden', viewport: { width: 300, height: 400 }, data: { pluginToolbar: 2 } },
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
    const toolbar = ui.data.showRuntimeControls ? slot.locator('..').locator('..') :
      page.getByRole('button', { name: 'Plugin 1', exact: true })
        .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " overflow-x-auto ")][1]/..');
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
    if (ui.data.showRuntimeControls) await trigger.getByText(ui.data.modelName, { exact: true }).waitFor();
    if (ui.data.pluginHidden) {
      await page.getByRole('button', { name: 'Plugin 1', exact: true }).waitFor({ state: 'detached' });
      const width = await toolbar.locator(':scope > .overflow-x-auto').evaluate((element) => element.getBoundingClientRect().width);
      assert.ok(width <= 1, `hidden plugin actions reserved ${width}px`);
    } else if (ui.data.pluginToolbar) {
      for (let index = 1; index <= ui.data.pluginToolbar; index++) {
        const action = page.getByRole('button', { name: ui.data.pluginTitle || `Plugin ${index}`, exact: true });
        if (index === 1) await action.focus();
        else await page.keyboard.press('Tab');
        const geometry = await action.evaluate((button) => {
          const control = button.getBoundingClientRect();
          const parent = button.closest('.overflow-x-auto');
          const scrollport = parent.getBoundingClientRect();
          return { control: { left: control.left, right: control.right }, scrollport: { left: scrollport.left, right: scrollport.right, scrollLeft: parent.scrollLeft, scrollWidth: parent.scrollWidth, clientWidth: parent.clientWidth }, focused: document.activeElement === button };
        });
        assert.ok(geometry.focused, `plugin action ${index} is not keyboard reachable`);
        assert.ok(geometry.control.left >= geometry.scrollport.left - 1 && geometry.control.right <= geometry.scrollport.right + 1,
          `plugin action is clipped: ${JSON.stringify(geometry)}`);
        await action.click();
        assert.equal(await page.evaluate(() => window.__pluginActions.at(-1)), `action-${index - 1}`);
      }
    }
    if (ui.case === 'recording' || ui.data.recording) {
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
        .map((button) => {
          const bounds = rect(button);
          const scrollport = button.closest('.overflow-x-auto');
          if (scrollport && root.contains(scrollport)) {
            const clip = rect(scrollport);
            bounds.left = Math.max(bounds.left, clip.left);
            bounds.right = Math.min(bounds.right, clip.right);
            bounds.width = Math.max(0, bounds.right - bounds.left);
          }
          return { label: button.getAttribute('aria-label'), ...bounds };
        }).filter((button) => button.width > 0) };
    });
    assert.ok(bounds.buttons.length >= (ui.data.showRuntimeControls ? 5 : 4), 'the composer controls must be present');
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
    if (ui.case === 'default' || ui.case === 'plugin-hidden') {
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
