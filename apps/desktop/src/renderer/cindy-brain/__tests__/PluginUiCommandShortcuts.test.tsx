// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginUiView } from '@cindy/maker-shared';
import type { PluginShortcutDefinition } from '../../../shared/appShortcuts';
import { selectPluginShortcutView } from '../PluginUiCommandShortcuts';

const shortcutId = `plugin:${'a'.repeat(64)}` as const;
const combo = { code: 'KeyJ', meta: false, ctrl: false, alt: true, shift: true };
const definition: PluginShortcutDefinition = {
  id: shortcutId, label: 'Format', pluginName: 'Writer', scope: 'message', defaultCombo: combo,
};
const view: PluginUiView = {
  version: 1, viewId: 'view-1', contributionId: 'format', point: 'message.shortcuts', revision: '1',
  command: { shortcutId }, controls: [{ kind: 'button', id: 'run', label: 'Format', actionId: 'run' }],
  actions: [{ id: 'run', label: 'Format' }], blocks: [], fallbackMarkdown: '',
};
const key = (target: EventTarget, changes: Partial<KeyboardEvent> = {}) => ({
  target, isTrusted: true, code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: true,
  ...changes,
}) as KeyboardEvent;

beforeEach(() => {
  document.body.innerHTML = `
    <div data-plugin-ui-session="one">
      <div data-message-client-id="first"><button id="first">First</button><span id="first-text">First message</span></div>
      <div data-message-client-id="second"><button id="second">Second</button><span id="second-text">Second message</span></div>
      <div data-chat-input-root><textarea id="composer"></textarea></div>
      <input id="other-input" />
    </div>
    <div data-plugin-ui-session="two"><button id="other-session">Other session</button></div>`;
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

function choose(event: KeyboardEvent, options: Partial<Parameters<typeof selectPluginShortcutView>[0]> = {}) {
  return selectPluginShortcutView({
    event, root: document.querySelector('[data-plugin-ui-session="one"]')!, focusMessageId: 'first',
    entry: 'message', definitions: [definition], views: [view], overrides: {}, platform: 'win32',
    pending: new Set(), disabled: false, ...options,
  });
}

describe('plugin command shortcut targeting', () => {
  it('accepts a real key only for the focused message in this session', () => {
    expect(choose(key(document.querySelector('#first')!))).toBe(view);
    expect(choose(key(document.querySelector('#second')!))).toBeUndefined();
    expect(choose(key(document.querySelector('#other-session')!))).toBeUndefined();
    expect(choose(key(document.querySelector('#first')!, { isTrusted: false }))).toBeUndefined();
  });

  it('uses a text selection only when it belongs to one exact message', () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#first-text')!);
    window.getSelection()!.addRange(range);
    expect(choose(key(document.body))).toBe(view);
    range.setEnd(document.querySelector('#second-text')!.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(choose(key(document.body))).toBeUndefined();
  });

  it('leaves other inputs, native editing, voice bindings and pending actions alone', () => {
    expect(choose(key(document.querySelector('#other-input')!), { focusMessageId: undefined, entry: 'session' })).toBeUndefined();
    const copy = { ...definition, scope: 'session' as const, defaultCombo: { ...combo, code: 'KeyC', ctrl: true, alt: false, shift: false } };
    expect(choose(key(document.querySelector('#composer')!, { code: 'KeyC', ctrlKey: true, altKey: false, shiftKey: false }),
      { focusMessageId: undefined, entry: 'session', definitions: [copy] })).toBeUndefined();
    expect(choose(key(document.querySelector('#first')!), { voiceCombo: combo })).toBeUndefined();
    expect(choose(key(document.querySelector('#first')!), { pending: new Set(['view-1']) })).toBeUndefined();
  });

  it('routes a turn-only command through the turn entry rather than the message entry', () => {
    const turn = { ...definition, points: ['turn.footer'] };
    expect(choose(key(document.querySelector('#first')!), { definitions: [turn] })).toBeUndefined();
    expect(choose(key(document.querySelector('#first')!), { definitions: [turn], entry: 'turn' })).toBe(view);
  });
});
