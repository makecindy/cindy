// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mountRemoteDesktopViewer } from '@cindy/maker-shared/remote-desktop-viewer';
import { DESKTOP_KEY_CODES, REMOTE_DESKTOP_NETWORK } from '@cindy/device-link';

let viewer: ReturnType<typeof mountRemoteDesktopViewer>;
let messages: Record<string, unknown>[];
let stage: HTMLElement;
let drawImage: ReturnType<typeof vi.fn>;
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
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  document.body.innerHTML =
    '<div id="stage"><div id="bg"><canvas id="bg-canvas"></canvas></div><img id="image"><video id="video"></video><div id="cursor"><img id="cursor-image"></div></div><textarea id="keyboard-input"></textarea><div id="mouse-buttons"><button id="mouse-left"></button><button id="mouse-right"></button><button id="mouse-wheel"><span id="mouse-wheel-grip"></span></button></div>';
  stage = document.getElementById('stage')!;
  Object.defineProperties(stage, {
    clientWidth: { value: 1000, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
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

it('zooms locally within bounds and fit restores scale and position', () => {
  const image = document.getElementById('image')!;
  viewer.receive({ type: 'zoom', factor: 1.25 });
  expect(image.style.width).toBe('1250px');
  expect(image.style.left).toBe('-125px');
  viewer.receive({ type: 'zoom', factor: 0.8 });
  expect(image.style.width).toBe('1000px');
  viewer.receive({ type: 'zoom', factor: 100 });
  expect(image.style.width).toBe('5000px');
  viewer.receive({ type: 'zoom', factor: NaN });
  expect(image.style.width).toBe('5000px');
  viewer.receive({ type: 'fit' });
  expect(image.style.width).toBe('1000px');
  expect(image.style.left).toBe('0px');
  viewer.receive({ type: 'zoom', factor: 0.1 });
  expect(image.style.width).toBe('100px');
  viewer.receive({ type: 'zoom', factor: 0.1 });
  expect(image.style.width).toBe('100px');
  expect(events()).toEqual([]);
});

it('maps clicks through the zoomed picture and allows local zoom in view-only mode', () => {
  viewer.receive({ type: 'zoom', factor: 2 });
  pointer('pointerdown', 750, 352);
  pointer('pointerup', 750, 352);
  vi.advanceTimersByTime(40);
  expect(events()).toContainEqual({ kind: 'button', button: 0, down: true, x: 0.625, y: 0.5 });
  viewer.receive({ type: 'control', enabled: false });
  messages = [];
  viewer.receive({ type: 'zoom', factor: 1.25 });
  expect(document.getElementById('image')!.style.width).toBe('2500px');
  expect(events()).toEqual([]);
});

it('pans a zoomed view with middle drag, preserves middle click and resets with fit', () => {
  const image = document.getElementById('image')!;
  viewer.receive({ type: 'zoom', factor: 2 });
  pointer('pointerdown', 500, 352, 1);
  pointer('pointermove', 600, 352, 1);
  pointer('pointerup', 600, 352, 1);
  vi.advanceTimersByTime(250);
  expect(parseFloat(image.style.left)).toBeGreaterThan(-500);
  expect(events()).toEqual([]);
  viewer.receive({ type: 'fit' });
  expect(image.style.left).toBe('0px');
  viewer.receive({ type: 'zoom', factor: 2 });
  pointer('pointerdown', 500, 352, 1);
  pointer('pointerup', 500, 352, 1);
  vi.advanceTimersByTime(40);
  expect(
    events()
      .filter((e) => e.kind === 'button')
      .map((e) => [e.button, e.down]),
  ).toEqual([
    [1, true],
    [1, false],
  ]);
});

it('uses the local pointer while retaining immediate remote input coordinates', () => {
  const cursor = {
    visible: true,
    x: 0.1,
    y: 0.1,
    width: 32,
    height: 32,
    hotX: 2,
    hotY: 3,
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  };
  viewer.receive({ type: 'frame', jpeg: 'frame', cursor });
  pointer('pointermove', 800, 452);
  const overlay = document.getElementById('cursor')!;
  expect(overlay.style.display).toBe('none');
  expect(stage.style.cursor).toBe('default');
  expect(overlay.style.left).toBe('798px');
  expect(overlay.style.top).toBe('397px');
  expect(events()).toEqual([]);
  viewer.receive({ type: 'frame', jpeg: 'frame', cursor: { ...cursor, x: 0.2, y: 0.2 } });
  expect(overlay.style.left).toBe('798px');
  vi.advanceTimersByTime(34);
  expect(events()).toContainEqual({ kind: 'move', x: 0.8, y: 400 / 600 });
  viewer.receive({ type: 'control', enabled: false });
  viewer.receive({ type: 'frame', jpeg: 'frame', cursor });
  expect(overlay.style.left).toBe('98px');
});
it('uses the local system cursor to the remote picture regardless of window focus or cursor metadata', () => {
  expect(stage.style.cursor).toBe('default');
  viewer.receive({ type: 'frame', jpeg: 'frame' });
  expect(stage.style.cursor).toBe('default');
  pointer('pointerleave');
  expect(getComputedStyle(document.body).cursor).not.toBe('none');
  expect(getComputedStyle(document.getElementById('mouse-left')!).cursor).not.toBe('none');
  pointer('pointerenter');
  expect(stage.style.cursor).toBe('default');
  window.dispatchEvent(new Event('blur'));
  expect(stage.style.cursor).toBe('default');
  window.dispatchEvent(new Event('focus'));
  expect(stage.style.cursor).toBe('default');
  viewer.receive({ type: 'control', enabled: false });
  expect(stage.style.cursor).toBe('default');
  viewer.receive({ type: 'control', enabled: true });
  viewer.receive({ type: 'stop' });
  expect(stage.style.cursor).toBe('default');
});
it.each([
  'text',
  'pointer',
  'ew-resize',
  'grab',
  undefined,
  'future-shape',
  'url(https://invalid/cursor)',
])('uses only native cursor keywords for %s, regardless of remote size and zoom', (shape) => {
  viewer.receive({
    type: 'frame',
    jpeg: 'frame',
    cursor: {
      visible: true,
      x: 0.5,
      y: 0.5,
      width: 256,
      height: 256,
      hotX: 32,
      hotY: 32,
      png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      shape,
    },
  });
  viewer.receive({ type: 'zoom', factor: 5 });
  expect(document.getElementById('cursor')!.style.display).toBe('none');
  expect(stage.style.cursor).toBe(
    ['text', 'pointer', 'ew-resize', 'grab'].includes(shape ?? '') ? shape : 'default',
  );
  viewer.receive({ type: 'control', enabled: false });
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

it.each([500, 2000, 10000])('shows a %spx desktop at 1:1 independently of fit bounds', (width) => {
  const image = document.getElementById('image')!;
  viewer.receive({ type: 'init', epoch: 'lease', width, height: width * 0.6 });
  viewer.receive({ type: 'actualSize' });
  expect(image.style.width).toBe(`${width}px`);
  expect(parseFloat(image.style.left)).toBe((1000 - width) / 2);
  expect(messages).toContainEqual(expect.objectContaining({ type: 'scaleMode', mode: 'actual' }));
  viewer.receive({ type: 'zoom', factor: 1.25 });
  expect(parseFloat(image.style.width)).toBe(width * 1.25);
  viewer.receive({ type: 'actualSize' });
  Object.defineProperty(stage, 'clientWidth', { value: 800 });
  viewer.receive({ type: 'control', enabled: true });
  expect(image.style.width).toBe(`${width}px`);
  expect(parseFloat(image.style.left)).toBe((800 - width) / 2);
  viewer.receive({ type: 'fit' });
  expect(image.style.width).toBe('800px');
});

it('maps input and pans an actual-size desktop larger than the window', () => {
  viewer.receive({ type: 'init', epoch: 'lease', width: 2000, height: 1200 });
  viewer.receive({ type: 'control', enabled: true });
  viewer.receive({ type: 'actualSize' });
  pointer('pointerdown', 750, 352);
  pointer('pointerup', 750, 352);
  vi.advanceTimersByTime(40);
  expect(events()).toContainEqual({ kind: 'button', button: 0, down: true, x: 0.625, y: 0.5 });
  pointer('pointerdown', 500, 352, 1);
  pointer('pointermove', 600, 352, 1);
  pointer('pointerup', 600, 352, 1);
  vi.advanceTimersByTime(300);
  expect(parseFloat(document.getElementById('image')!.style.left)).toBeGreaterThan(-500);
});

it('fills all margins of a shrunken desktop with the shared fitted backdrop', () => {
  const image = document.getElementById('image')!;
  const bg = document.getElementById('bg')!;
  Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 600 } });
  viewer.receive({ type: 'zoom', factor: 0.8 });
  vi.advanceTimersByTime(32);
  expect(image.style.width).toBe('800px');
  expect(image.style.left).toBe('100px');
  expect(image.style.top).toBe('60px');
  expect(bg.style.display).toBe('block');
  expect(drawImage).toHaveBeenCalledTimes(3);
  expect(drawImage.mock.calls[0]).toEqual([image, 0, 0, 50, 600, 0, 0, 50, 600]);
  expect(drawImage.mock.calls[1].slice(5)).toEqual([50, 0, 900, 600]);
  expect(drawImage.mock.calls[2].slice(5)).toEqual([950, 0, 50, 600]);
  pointer('pointerdown', 700, 352);
  pointer('pointerup', 700, 352);
  vi.advanceTimersByTime(40);
  expect(events()).toContainEqual({ kind: 'button', button: 0, down: true, x: 0.75, y: 0.5 });
  viewer.receive({ type: 'fit' });
  expect(bg.style.display).toBe('none');
});

it('keeps the letterbox backdrop fitted while the foreground shrinks', () => {
  const image = document.getElementById('image')!;
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 600 } });
  viewer.receive({ type: 'init', epoch: 'lease', width: 600, height: 600 });
  vi.advanceTimersByTime(32);
  const fittedRects = drawImage.mock.calls.slice(-3).map((call) => call.slice(5));
  expect(fittedRects).toEqual([
    [0, 0, 230, 600],
    [230, 0, 540, 600],
    [770, 0, 230, 600],
  ]);
  drawImage.mockClear();
  viewer.receive({ type: 'zoom', factor: 0.8 });
  vi.advanceTimersByTime(32);
  expect(image.style.width).toBe('480px');
  expect(drawImage.mock.calls.map((call) => call.slice(5))).toEqual(fittedRects);
});

it.each([
  [995, 352, 'left', -500, -1],
  [5, 352, 'left', -500, 1],
  [500, 647, 'top', -300, -1],
  [500, 57, 'top', -300, 1],
] as const)(
  'pans continuously toward pointer at %s,%s and stops on leaving',
  (x, y, axis, initial, direction) => {
    viewer.receive({ type: 'zoom', factor: 2 });
    const image = document.getElementById('image')!;
    pointer('pointermove', x, y);
    vi.advanceTimersByTime(200);
    expect((parseFloat(image.style[axis]) - initial) * direction).toBeGreaterThan(0);
    const moved = image.style[axis];
    pointer('pointerleave', x, y);
    vi.advanceTimersByTime(200);
    expect(image.style[axis]).toBe(moved);
  },
);

it('clamps edge panning to desktop bounds and keeps the remote pointer mapped', () => {
  viewer.receive({ type: 'zoom', factor: 2 });
  pointer('pointermove', 995, 647);
  vi.advanceTimersByTime(3000);
  const image = document.getElementById('image')!;
  expect(image.style.left).toBe('-1000px');
  expect(image.style.top).toBe('-600px');
  expect(
    events()
      .filter((e) => e.kind === 'move')
      .at(-1),
  ).toEqual({ kind: 'move', x: 0.9975, y: 1195 / 1200 });
  pointer('pointermove', 500, 352);
  vi.advanceTimersByTime(100);
  expect(image.style.left).toBe('-1000px');
});

it('allows view-only edge panning but stops on focus loss and fit', () => {
  viewer.receive({ type: 'control', enabled: false });
  viewer.receive({ type: 'zoom', factor: 2 });
  messages = [];
  pointer('pointermove', 995, 352);
  vi.advanceTimersByTime(200);
  const image = document.getElementById('image')!;
  expect(parseFloat(image.style.left)).toBeLessThan(-500);
  expect(events()).toEqual([]);
  window.dispatchEvent(new Event('blur'));
  const left = image.style.left;
  vi.advanceTimersByTime(400);
  expect(image.style.left).toBe(left);
  pointer('pointermove', 995, 352);
  viewer.receive({ type: 'fit' });
  vi.advanceTimersByTime(200);
  expect(image.style.left).toBe('0px');
  pointer('pointermove', 995, 352);
  vi.advanceTimersByTime(200);
  expect(image.style.left).toBe('0px');
});

it('continues edge panning when the first browser frame predates the pointer event', () => {
  viewer.receive({ type: 'zoom', factor: 2 });
  vi.advanceTimersByTime(32);
  let firstFrame!: FrameRequestCallback;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementationOnce((callback) => {
    firstFrame = callback;
    return 123456;
  });
  pointer('pointermove', 995, 352);
  firstFrame(performance.now() - 1);
  vi.advanceTimersByTime(200);
  expect(parseFloat(document.getElementById('image')!.style.left)).toBeLessThan(-500);
});
