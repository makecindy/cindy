import assert from 'node:assert/strict';

export default {
  name: 'companion-composer',
  entry: './companion-composer-fixture.tsx',
  viewport: { width: 760, height: 360 },
  real: 'ChatInput, Tiptap editor, SendButton, VoiceInputButton, tooltips, send dispatch, themes and translations',
  notCovered:
    'Microphone/ASR, live companion tasks and speech synthesis; host services, model catalog and dictation hook use scenario data. Windows runtime is not exercised.',
  stubs: {
    'src/renderer/hooks/useProviders': `const providers = [{ id: 'openai', name: 'OpenAI', source: 'builtin', connected: true, agents: ['codex'], auth: { method: 'oauth' }, routing: { codex: { upstream: 'https://example.test', authStrategy: 'oauth-passthrough' } }, models: { codex: [{ id: 'fixture-chat', name: 'Fixture', contextWindow: 200000, efforts: [], defaultEffort: null }] } }]; export const useProviders = () => ({ providers, loading: false });`,
    'src/renderer/hooks/useDeviceProviders': {
      partial: `export const useDeviceProviders = () => ({ providers: [], loading: false, unsupported: false });`,
    },
    'src/renderer/hooks/useConnectedSource': `export const useConnectedSource = () => ({ hasConnectedSource: true, loading: false });`,
    'src/renderer/hooks/useAvailableAgents': {
      partial: `export const useAvailableAgents = () => ({ agents: [], loading: false });`,
    },
    'src/renderer/hooks/useAgentCapabilities': {
      partial: `export const useAgentCapabilities = () => ({ capabilities: null, loading: false });`,
    },
    'src/renderer/components/new-chat/ExtraDirsButton': `export const ExtraDirsButton = () => null;`,
    'src/renderer/components/new-chat/PermissionSelector': `export const PermissionSelector = () => null;`,
    'src/renderer/components/new-chat/NewGoalDialog': `export const NewGoalDialog = () => null;`,
    'src/renderer/components/new-chat/AtMentionPanel': `export const AtMentionPanel = () => null;`,
    'src/renderer/components/new-chat/SlashCommandPalette': `export const SlashCommandPalette = () => null;`,
    'src/renderer/voice-input/useVoiceInput': `import { useState, useRef } from 'react'; export function useVoiceInput(editor) { const [state, setState] = useState('idle'); const current = useRef(state); const update = value => { current.current = value; setState(value); }; return { state, getState: () => current.current, isListening: state === 'listening', isBusy: state !== 'idle', draftText: '', start: () => { update('listening'); return true; }, stop: async () => { update('idle'); editor?.commands.setContent('<p>Dictated message</p>'); }, cancel: async () => update('idle') }; }`,
  },
  cases: {
    recommendation: {
      about: 'Recommendation and call coexist; starting a call preserves the suggestion, accepting it restores Send',
      data: { recommendation: '帮我整理下一步计划' },
    },
    'recommendation-narrow': {
      about: 'Recommendation and call remain usable at narrow width',
      data: { recommendation: '帮我整理下一步计划' },
      viewport: { width: 360, height: 400 },
    },
    'voice-guidance': {
      about: 'Idle intentional focus teaches once without replacing placeholder or moving controls',
    },
    'voice-guidance-narrow': {
      about: 'Insufficient toolbar space suppresses teaching without consuming its budget',
      viewport: { width: 240, height: 400 },
    },
    'voice-hold': {
      about: 'Empty composer hints, native mouse selection during hold, and button hold/click release semantics',
      viewport: { width: 360, height: 400 },
    },
    default: {
      about:
        'Empty/text/attachment action switch, stable target, keyboard send, call return and stop/queue',
    },
    narrow: {
      about: 'Same companion interactions at narrow width',
      viewport: { width: 360, height: 400 },
    },
  },
  async ready(page) {
    await page.locator('[contenteditable="true"]').waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('voice-guidance')) {
      const editor = page.locator('.ProseMirror');
      const guidance = page.getByTestId('composer-voice-guidance');
      const mic = page.locator('button[aria-pressed]');
      const before = await mic.boundingBox();
      await editor.hover();
      await page.waitForTimeout(2100);
      assert.equal(await guidance.getAttribute('data-visible'), 'false');
      await editor.click();
      if (ui.case.endsWith('narrow')) {
        await page.waitForTimeout(2300);
        assert.equal(await guidance.getAttribute('data-visible'), 'false');
        assert.equal(await page.evaluate(() => localStorage.getItem('cindy.composer-voice-guidance.v1')), null);
        await ui.capture('narrow-no-guidance');
        return;
      }
      await page.waitForFunction(() => document.querySelector('[data-testid="composer-voice-guidance"]')?.dataset.visible === 'true');
      await page.mouse.move(1, 1);
      assert.equal(await guidance.getAttribute('data-visible'), 'true');
      assert.deepEqual(await mic.boundingBox(), before);
      assert.equal(await page.getByTestId('composer-voice-hint').count(), 0);
      await ui.capture('idle-guidance');
      await page.waitForFunction(() => document.querySelector('[data-testid="composer-voice-guidance"]')?.dataset.visible === 'false');
      await editor.click();
      await page.waitForTimeout(2300);
      assert.equal(await guidance.getAttribute('data-visible'), 'false');
      await editor.pressSequentially('Continue with the implementation');
      assert.equal(await guidance.getAttribute('data-visible'), 'false');
      await ui.capture('typing');
      return;
    }
    if (ui.data.recommendation) {
      const editor = page.locator('[contenteditable]');
      const call = page.getByRole('button', { name: await ui.t('bots.voiceMode.startConversation'), exact: true });
      const send = page.getByRole('button', { name: await ui.t('newChat.sendButton.send'), exact: true });
      const suggestion = page.getByRole('button', {
        name: `${await ui.t('newChat.chatInput.recommendationShortcut')}: ${ui.data.recommendation}`,
        exact: true,
      });
      await suggestion.waitFor();
      await ui.capture('recommendation');
      assert.equal(await call.count(), 1);
      assert.equal(await send.count(), 0);
      await call.click();
      assert.equal(await suggestion.count(), 0);
      assert.equal(await editor.textContent(), '');
      assert.equal(await page.getByTestId('sent').textContent(), '');
      await page.getByTestId('end-call').click();
      await suggestion.waitFor();
      assert.equal(await call.evaluate((node) => node === document.activeElement), true);
      await suggestion.click();
      assert.equal(await editor.textContent(), ui.data.recommendation);
      assert.equal(await call.count(), 0);
      await ui.capture('accepted');
      await send.click();
      await call.waitFor();
      assert.equal(await page.getByTestId('sent').textContent(), ui.data.recommendation);
      return;
    }
    if (ui.case === 'voice-hold') {
      const editor = page.locator('.ProseMirror');
      const hint = page.getByTestId('composer-voice-hint');
      const hintText = async (key) => {
        await hint.waitFor();
        assert.equal(await hint.textContent(), await ui.t(`newChat.chatInput.voiceInput.${key}`));
      };
      // Playwright fill mutates the DOM selection outside ProseMirror's input
      // flow. After a hold/drag, that selection can be restored before deletion.
      // Use the real next keyboard interaction and verify the entire document
      // is selected before deleting, so a partial clear cannot hide a hint path.
      const clearWithKeyboard = async () => {
        await editor.press('ControlOrMeta+A');
        await page.waitForFunction(() => {
          const current = document.querySelector('.ProseMirror')?.editor;
          if (!current) return false;
          const { doc, selection } = current.state;
          return doc.textBetween(selection.from, selection.to) === doc.textContent;
        });
        await editor.press('Backspace');
        assert.equal(await editor.textContent(), '');
        assert.equal(await editor.evaluate((node) => node.editor.isEmpty), true);
      };
      const card = page.locator('[data-split-group-composer-drop-target]');
      const cardBox = await card.boundingBox();
      // Start in the card's padding, outside the single text line.
      await page.mouse.move(cardBox.x + 4, cardBox.y + 4);
      assert.equal(await hint.count(), 0);
      await ui.capture('idle');
      await page.mouse.down();
      await page.waitForFunction(() => document.querySelector('[data-voice-holding="true"]'));
      await hintText('speakRelease');
      await ui.capture('hold-empty');
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent === 'Dictated message');
      assert.equal(await hint.count(), 0);

      // The gap above the toolbar is also part of the input surface.
      const editorBox = await editor.boundingBox();
      await page.mouse.move(cardBox.x + cardBox.width / 2, editorBox.y + editorBox.height + 5);
      await page.mouse.down();
      await page.waitForFunction(() => document.querySelector('[data-voice-holding="true"]'));
      await page.mouse.up();
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();

      const rect = await editor.boundingBox();
      const middle = await editor.evaluate((node) => {
        const text = node.querySelector('p').firstChild;
        const range = document.createRange();
        range.setStart(text, 8);
        range.setEnd(text, 9);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      });
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.waitForFunction(() => document.querySelector('[data-voice-holding="true"]'));
      await page.mouse.move(rect.x + rect.width - 8, rect.y + rect.height / 2, { steps: 12 });
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '');
      await page.mouse.move(rect.x + 2, middle.y, { steps: 12 });
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '');
      // Exercise selection changes that escape move/selectstart cancellation
      // (an already-running native selection gesture). The editor must retain
      // the insertion point, not adopt the expanded DOM selection.
      const insertionPoint = await editor.evaluate((node) => node.editor.state.selection.from);
      await editor.evaluate((node) => {
        const text = node.querySelector('p').firstChild;
        document.getSelection().setBaseAndExtent(text, 2, text, 5);
      });
      await page.waitForFunction(() => document.getSelection()?.isCollapsed);
      assert.equal(await editor.evaluate((node) => node.editor.state.selection.from), insertionPoint);
      assert.equal(await hint.count(), 0);
      await page.mouse.up();
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '');
      // A queued native selection change can arrive after pointerup/mouseup.
      // It must still be rejected until a new user interaction begins.
      await editor.evaluate((node) => {
        const text = node.querySelector('p').firstChild;
        document.getSelection().setBaseAndExtent(text, 2, text, 5);
      });
      await page.waitForFunction(() => document.getSelection()?.isCollapsed);
      assert.equal(await editor.evaluate((node) => node.editor.state.selection.empty), true);
      // Releasing restores ordinary text selection.
      const releasedText = await editor.locator('p').boundingBox();
      await page.mouse.move(releasedText.x + 5, releasedText.y + releasedText.height / 2);
      await page.mouse.down();
      await page.mouse.move(releasedText.x + 90, releasedText.y + releasedText.height / 2, { steps: 4 });
      await page.mouse.up();
      assert.notEqual(await page.evaluate(() => window.getSelection()?.toString()), '');
      await clearWithKeyboard();
      const mic = page.locator('button[aria-pressed]');
      await mic.click();
      await hintText('speakPressAgain');
      await ui.capture('click-empty');
      await mic.click();
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
      await clearWithKeyboard();
      await mic.hover();
      await page.mouse.down();
      await page.getByRole('button', { name: await ui.t('newChat.chatInput.voiceInput.releaseToStop'), exact: true }).waitFor();
      await hintText('speakRelease');
      await ui.capture('button-hold-empty');
      await page.mouse.up();
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
      return;
    }
    // Screenshot harness defaults to reduced motion; opt in to verify real transitions.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const editor = page.locator('[contenteditable]');
    const callName = await ui.t('bots.voiceMode.startConversation');
    const sendName = await ui.t('newChat.sendButton.send');
    const mic = page.getByRole('button', {
      name: await ui.t('newChat.chatInput.voiceInput.start'),
      exact: true,
    });
    const call = page.getByRole('button', { name: callName, exact: true });
    const send = page.getByRole('button', { name: sendName, exact: true });
    const micBefore = await mic.boundingBox();
    const slotBefore = await call.boundingBox();
    assert.equal(await send.count(), 0);
    assert.equal(slotBefore.width, 30);
    await call.click();
    await page.getByTestId('end-call').click();
    assert.equal(await call.evaluate((node) => node === document.activeElement), true);
    await editor.fill('   ');
    assert.equal(await call.count(), 1);
    // Sample the real transition rather than asserting Tailwind class strings.
    await editor.fill('Hello Cindy');
    assert.equal(await call.count(), 0);
    assert.equal(await send.isEnabled(), true);
    assert.deepEqual(await send.boundingBox(), slotBefore);
    assert.deepEqual(await mic.boundingBox(), micBefore);
    const motion = await send.evaluate((node) => {
      const icon = node.querySelector('svg.lucide-audio-lines').parentElement;
      return {
        duration: getComputedStyle(icon).transitionDuration,
        animations: icon.getAnimations().map((a) => a.effect.getKeyframes()),
      };
    });
    assert.equal(motion.duration, '0.25s');
    await send.evaluate(async (node) => {
      await Promise.all(
        node.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    assert.equal(
      await send.evaluate(
        (node) =>
          getComputedStyle(node.querySelector('svg.lucide-audio-lines').parentElement).transform,
      ),
      'matrix(0.55, 0, 0, 0.55, 0, 0)',
    );
    await ui.capture('typed');
    await send.click();
    await call.waitFor();
    assert.equal(await page.getByTestId('sent').textContent(), 'Hello Cindy');
    await editor.fill('Held Enter');
    await send.focus();
    await page.keyboard.down('Enter');
    await call.waitFor();
    // Playwright's second down is a native repeated keydown, not a synthetic click.
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    assert.equal(await page.getByTestId('end-call').count(), 0);
    assert.equal(await page.getByTestId('sent').textContent(), 'Held Enter');
    await page.getByTestId('attachment').click();
    await send.waitFor();
    await ui.capture('attachment');
    await page.getByTestId('attachment').click();
    await call.waitFor();
    await editor.fill('Keyboard message');
    await editor.press('Shift+Enter');
    assert.equal(await page.getByTestId('sent').textContent(), 'Held Enter');
    await editor.press('Enter');
    await call.waitFor();
    assert.equal((await page.getByTestId('sent').textContent()).trim(), 'Keyboard message');
    await page.getByTestId('running').click();
    const stop = page.getByRole('button', {
      name: await ui.t('newChat.sendButton.stop'),
      exact: true,
    });
    await stop.waitFor();
    assert.equal(await call.count(), 0);
    await editor.fill('Next message');
    await page
      .getByRole('button', { name: await ui.t('newChat.sendButton.queue'), exact: true })
      .waitFor();
    assert.equal(await stop.count(), 1);
    await ui.capture('queue');
    await stop.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await call.waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await editor.fill('Reduced motion');
    assert.equal(
      await send.evaluate(
        (node) =>
          getComputedStyle(node.querySelector('svg.lucide-audio-lines').parentElement)
            .transitionDuration,
      ),
      '0s',
    );
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  },
};
