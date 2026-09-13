// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mountRemoteDesktopViewer } from '@cindy/maker-shared/remote-desktop-viewer';
import { DESKTOP_KEY_CODES, REMOTE_DESKTOP_NETWORK } from '@cindy/device-link';

let viewer: ReturnType<typeof mountRemoteDesktopViewer>;
let messages: Record<string, unknown>[];
let stage: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  document.body.innerHTML =
    '<div id="stage"><img id="image"><video id="video"></video><div id="cursor"><img id="cursor-image"></div></div><textarea id="keyboard-input"></textarea><div id="mouse-buttons"><button id="mouse-left"></button><button id="mouse-right"></button><button id="mouse-wheel"><span id="mouse-wheel-grip"></span></button></div>';
  stage = document.getElementById('stage')!;
  Object.defineProperties(stage, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
  stage.setPointerCapture = vi.fn();
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 52,
    left: 0,
    top: 52,
    width: 1000,
    height: 600,
    right: 1000,
    bottom: 652,
    toJSON() {},
  });
  messages = [];
  viewer = mountRemoteDesktopViewer(
    document,
    (message) => {
      messages.push(message);
      if (message.type === 'input')
        viewer.receive({ type: 'ack', epoch: 'lease', sequence: message.sequence });
    },
    { desktop: true, net: REMOTE_DESKTOP_NETWORK, iceServers: [], keyCodes: DESKTOP_KEY_CODES },
  );
  viewer.receive({ type: 'init', epoch: 'lease', width: 1000, height: 600 });
  viewer.receive({ type: 'control', enabled: true });
});
afterEach(() => {
  viewer.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function pointer(type: string, x = 500, y = 352, button = 0) {
  const e = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  stage.dispatchEvent(e);
}
function events() {
  return messages.flatMap((m) =>
    m.type === 'input' ? (m.events as Record<string, unknown>[]) : [],
  );
}
it('scopes cursor hiding to the remote picture regardless of window focus or cursor metadata', () => {
  expect(stage.style.cursor).toBe('none');
  viewer.receive({ type: 'frame', jpeg: 'frame' });
  expect(stage.style.cursor).toBe('none');
  pointer('pointerleave');
  expect(getComputedStyle(document.body).cursor).not.toBe('none');
  expect(getComputedStyle(document.getElementById('mouse-left')!).cursor).not.toBe('none');
  pointer('pointerenter');
  expect(stage.style.cursor).toBe('none');
  window.dispatchEvent(new Event('blur'));
  expect(stage.style.cursor).toBe('none');
  window.dispatchEvent(new Event('focus'));
  expect(stage.style.cursor).toBe('none');
  viewer.receive({ type: 'control', enabled: false });
  expect(stage.style.cursor).toBe('default');
  viewer.receive({ type: 'control', enabled: true });
  viewer.receive({ type: 'stop' });
  expect(stage.style.cursor).toBe('default');
});
it.each(['control', 'meta'])(
  'bridges %s clipboard shortcuts once without forwarding or inserting them',
  (modifier) => {
    viewer.receive({
      type: 'init',
      epoch: 'lease',
      width: 1000,
      height: 600,
      clipboardShortcuts: true,
      clipboardModifier: modifier,
    });
    viewer.receive({ type: 'control', enabled: true });
    pointer('pointerdown');
    pointer('pointerup');
    messages = [];
    const input = document.getElementById('keyboard-input')!;
    const modifiers = { ctrlKey: modifier === 'control', metaKey: modifier === 'meta' };
    const modifierCode = modifier === 'meta' ? 'MetaLeft' : 'ControlLeft';
    for (const code of ['KeyC', 'KeyV']) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { code: modifierCode, ...modifiers, bubbles: true }),
      );
      const event = new KeyboardEvent('keydown', {
        code,
        ...modifiers,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          code,
          ...modifiers,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keyup', { code, ...modifiers, bubbles: true, cancelable: true }),
      );
      input.dispatchEvent(new KeyboardEvent('keyup', { code: modifierCode, bubbles: true }));
    }
    vi.advanceTimersByTime(34);
    expect(messages.filter((message) => message.type === 'clipboard')).toEqual([
      { type: 'clipboard', action: 'copy', epoch: 'lease' },
      { type: 'clipboard', action: 'paste', epoch: 'lease' },
    ]);
    expect(events().filter((event) => event.kind === 'key' || event.kind === 'text')).toEqual([]);
  },
);
it('does not bridge clipboard in local controls, composition, view-only mode or unsupported hosts', () => {
  const shortcut = () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'KeyV',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  pointer('pointerdown');
  pointer('pointerup');
  shortcut();
  expect(messages.some((message) => message.type === 'clipboard')).toBe(false);
  viewer.receive({
    type: 'init',
    epoch: 'lease',
    width: 1000,
    height: 600,
    clipboardShortcuts: true,
  });
  viewer.receive({ type: 'control', enabled: true });
  const button = document.createElement('button');
  document.body.append(button);
  button.focus();
  shortcut();
  pointer('pointerdown');
  pointer('pointerup');
  const input = document.getElementById('keyboard-input')!;
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  shortcut();
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  viewer.receive({ type: 'control', enabled: false });
  shortcut();
  expect(messages.some((message) => message.type === 'clipboard')).toBe(false);
});
it.each(['key', 'button', 'scroll'])(
  'preserves the deferred modifier for ordinary %s input',
  (kind) => {
    viewer.receive({
      type: 'init',
      epoch: 'lease',
      width: 1000,
      height: 600,
      clipboardShortcuts: true,
    });
    viewer.receive({ type: 'control', enabled: true });
    pointer('pointerdown');
    pointer('pointerup');
    messages = [];
    const input = document.getElementById('keyboard-input')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'ControlLeft', ctrlKey: true, bubbles: true }),
    );
    if (kind === 'key') {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keyup', { code: 'KeyA', ctrlKey: true, bubbles: true }),
      );
    } else if (kind === 'button') {
      pointer('pointerdown');
      pointer('pointerup');
    } else {
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 32, ctrlKey: true, bubbles: true, cancelable: true }),
      );
    }
    input.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft', bubbles: true }));
    vi.advanceTimersByTime(34);
    expect(events()[0]).toEqual({ kind: 'key', code: 'ControlLeft', down: true });
    expect(events().at(-1)).toEqual({ kind: 'key', code: 'ControlLeft', down: false });
    expect(events().some((event) => event.kind === kind)).toBe(true);
    expect(events().some((event) => event.kind === 'release')).toBe(false);
  },
);
it('maps real mouse movement, right button and wheel to the picture below the toolbar', () => {
  pointer('pointermove');
  vi.advanceTimersByTime(34);
  expect(events()).toContainEqual({ kind: 'move', x: 0.5, y: 0.5 });
  expect(document.getElementById('cursor')!.style.display).toBe('none');
  pointer('pointerdown', 500, 352, 2);
  pointer('pointerup', 500, 352, 2);
  stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 32, bubbles: true, cancelable: true }));
  expect(events()).toContainEqual({ kind: 'button', button: 2, down: true, x: 0.5, y: 0.5 });
  expect(events()).toContainEqual({ kind: 'button', button: 2, down: false, x: 0.5, y: 0.5 });
  expect(events()).toContainEqual({ kind: 'scroll', dx: 0, dy: 32 });
});
it('commits IME text once and never forwards local toolbar keyboard input', () => {
  pointer('pointerdown');
  pointer('pointerup');
  const input = document.getElementById('keyboard-input') as HTMLTextAreaElement;
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'KeyN',
      key: 'Process',
      isComposing: true,
      bubbles: true,
    }),
  );
  input.value = '你好';
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  expect(events().filter((e) => e.kind === 'text')).toEqual([{ kind: 'text', text: '你好' }]);
  input.blur();
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }));
  vi.advanceTimersByTime(34);
  expect(events().some((e) => e.kind === 'key' && e.code === 'KeyA')).toBe(false);
});
it('releases held buttons on window blur and disposal removes all timers', () => {
  pointer('pointerdown');
  window.dispatchEvent(new Event('blur'));
  expect(events()).toContainEqual({ kind: 'release' });
  viewer.dispose();
  messages = [];
  vi.advanceTimersByTime(5000);
  expect(messages).toEqual([]);
});
