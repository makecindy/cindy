// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoLightbox } from '@/components/chat/VideoLightbox';
import { useNativePopupSurface } from '../useNativePopupSurface';

// Unit regression: Mivo's native canvas covered the MP4 preview. The existing
// BrowserTabBody tests mock this hook and only cover the browser's own menu.
// Mount the production hook and video preview; fake only layout/hit testing
// (jsdom has no compositor) and the Electron IPC boundary. The observable result
// is setBounds.visible, without recreating or navigating the native page.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const snapshot = {
  url: 'https://example.test/canvas', title: 'Canvas', favicon: null,
  isLoading: false, canGoBack: false, canGoForward: false,
  isAudible: false, crash: null,
};
const native = {
  claim: vi.fn(), onEvent: vi.fn(), setBounds: vi.fn(), command: vi.fn(),
};
const slotRect = new DOMRect(600, 40, 400, 700);
const viewportRect = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
const panelRect = new DOMRect(40, 40, window.innerWidth - 80, window.innerHeight - 80);
const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
const originalHitStack = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');

function NativeTab({ visible = true, focusRequest = 0 }: { visible?: boolean; focusRequest?: number }) {
  const slot = useRef<HTMLDivElement>(null);
  useNativePopupSurface('surface-canvas', 'session-a', 'tab-canvas', slot, visible, focusRequest);
  return <div ref={slot} data-native-slot />;
}

function Preview({ open, local = false }: { open: boolean; local?: boolean }) {
  return open ? createPortal(
    <>
      {!local && <div data-preview-scrim style={{ position: 'fixed', inset: 0 }} />}
      <div data-test-preview style={{ position: local ? 'absolute' : 'fixed', inset: 40 }}>
        <div>File preview</div>
      </div>
    </>, document.body,
  ) : null;
}

async function flushFrame() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(20); });
}

function expectVisible(visible: boolean) {
  expect(native.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
    surfaceId: 'surface-canvas', visible,
  }));
}

describe('native popup visibility beneath global previews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.claim.mockResolvedValue({ alive: true, snapshot });
    native.onEvent.mockReturnValue(() => undefined);
    native.setBounds.mockResolvedValue(undefined);
    native.command.mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true, value: { rsbNativePopup: native },
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computedStyle(element);
      // jsdom does not load Tailwind. Current PreviewScrim's positioning comes
      // from its classes, while its sibling panel has inline 40px margins.
      return element.classList.contains('fixed')
        ? new Proxy(style, { get: (target, key) => key === 'position' ? 'fixed' : Reflect.get(target, key) })
        : style;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-native-slot')) return slotRect;
      const element = this as HTMLElement;
      if (this.hasAttribute('data-preview-scrim') || element.style.inset === '0px') return viewportRect;
      return panelRect;
    });
    const hitStack = () => {
      const overlays = [...document.querySelectorAll<HTMLElement>('body > div')]
        .filter((node) => node.style.position === 'fixed' || node.hasAttribute('data-preview-scrim') || node.hasAttribute('data-test-preview'))
        .reverse();
      return [
        ...overlays.flatMap((node) => node.firstElementChild ? [node.firstElementChild, node] : [node]),
        document.querySelector('[data-native-slot]')!, document.body,
      ];
    };
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true, value: vi.fn(hitStack),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true, value: vi.fn(() => hitStack()[0]),
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
    else Reflect.deleteProperty(document, 'elementFromPoint');
    if (originalHitStack) Object.defineProperty(document, 'elementsFromPoint', originalHitStack);
    else Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  // Unit regression #10449: a native menu restore must accompany showing the
  // real page, occur once, and be discarded on hiding; geometry-only tests
  // could not detect a lost native keyboard focus request.
  it('sends native focus once with restored visibility and discards a hidden request', async () => {
    const view = render(<NativeTab visible={false} />);
    await flushFrame();
    view.rerender(<NativeTab focusRequest={1} />);
    await flushFrame();
    expect(native.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, focus: true }));
    native.setBounds.mockClear();
    fireEvent(window, new Event('resize'));
    await flushFrame();
    expect(native.setBounds).not.toHaveBeenCalled();
    view.rerender(<NativeTab visible={false} focusRequest={2} />);
    await flushFrame();
    expect(native.setBounds.mock.calls.every(([input]) => input.focus !== true)).toBe(true);
    view.rerender(<NativeTab focusRequest={2} />);
    await flushFrame();
    expect(native.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    expect(native.setBounds.mock.calls.every(([input]) => input.focus !== true)).toBe(true);
  });

  it('hides for a real video preview through its closing animation, then restores the same page', async () => {
    render(<NativeTab />);
    await flushFrame();
    expectVisible(true);

    const preview = render(<VideoLightbox src="xdt-video://preview.mp4" onClose={() => preview.unmount()} />);
    await flushFrame();
    expectVisible(false);

    // The production player suppresses Escape just after a context menu closes.
    await act(async () => { vi.advanceTimersByTime(150); });
    fireEvent.keyDown(document, { key: 'Escape' });
    await flushFrame();
    expectVisible(false);
    await act(async () => { vi.advanceTimersByTime(200); });
    await flushFrame();
    expectVisible(true);
    expect(native.claim).toHaveBeenCalledTimes(1);
    expect(native.command).not.toHaveBeenCalled();
  });

  it('stays hidden until all overlapping global previews have closed', async () => {
    render(<NativeTab />);
    await flushFrame();
    const first = render(<Preview open />);
    const second = render(<Preview open />);
    await flushFrame();
    expectVisible(false);
    second.unmount();
    await flushFrame();
    expectVisible(false);
    first.unmount();
    await flushFrame();
    expectVisible(true);
  });

  it('finds the sibling scrim beneath an inset panel, and restores after closing', async () => {
    // PR #10346 review: the slot center hits panel content, whose ancestors do
    // not include PreviewScrim. Treating every element as viewport-sized hid
    // this failure; preserve the real 40px panel inset in the layout double.
    render(<NativeTab />);
    await flushFrame();
    const preview = render(<Preview open />);
    await flushFrame();
    expect(document.elementFromPoint(800, 390)?.getBoundingClientRect()).toEqual(panelRect);
    expectVisible(false);
    preview.unmount();
    await flushFrame();
    expectVisible(true);
  });

  it('ignores a full-window layer behind the native slot in the host hit stack', async () => {
    render(<NativeTab />);
    render(<Preview open />);
    const slot = document.querySelector('[data-native-slot]')!;
    const scrim = document.querySelector('[data-preview-scrim]')!;
    vi.mocked(document.elementsFromPoint).mockReturnValue([slot, scrim, document.body]);
    vi.mocked(document.elementFromPoint).mockReturnValue(slot);
    await flushFrame();
    expectVisible(true);
  });

  it('does not reveal an inactive tab when a preview closes, and rechecks before activation', async () => {
    const tab = render(<NativeTab />);
    const preview = render(<Preview open />);
    await flushFrame();
    expectVisible(false);
    tab.rerender(<NativeTab visible={false} />);
    preview.rerender(<Preview open={false} />);
    await flushFrame();
    expectVisible(false);

    preview.rerender(<Preview open />);
    tab.rerender(<NativeTab />);
    await flushFrame();
    expectVisible(false);
    preview.rerender(<Preview open={false} />);
    await flushFrame();
    expectVisible(true);
  });

  it('does not mistake local content for a global overlay', async () => {
    render(<NativeTab />);
    render(<Preview open local />);
    await flushFrame();
    expectVisible(true);
  });

  it('keeps a canvas-owned preview visible and editable after closing it inside the guest document', async () => {
    // The canvas has its own document: hiding the native view for a fixed
    // overlay inside that document would hide the preview itself. This boundary
    // is distinct from a host portal and is not covered by the local-content case.
    render(<NativeTab />);
    const slot = document.querySelector('[data-native-slot]')!;
    const guest = document.createElement('iframe');
    slot.appendChild(guest);
    const canvas = guest.contentDocument!;
    canvas.body.innerHTML = '<input aria-label="Canvas draft" value="Unsaved canvas edit"><button>Open canvas preview</button>';
    const draft = canvas.querySelector('input')!;
    const preview = canvas.createElement('div');
    preview.style.cssText = 'position:fixed;inset:0;';
    const close = canvas.createElement('button');
    close.textContent = 'Close canvas preview';
    preview.appendChild(close);
    canvas.querySelector('button')!.addEventListener('click', () => canvas.body.appendChild(preview));
    close.addEventListener('click', () => preview.remove());
    vi.mocked(document.elementFromPoint).mockReturnValue(guest);
    vi.mocked(document.elementsFromPoint).mockReturnValue([guest, slot]);
    await flushFrame();
    expectVisible(true);
    const updates = native.setBounds.mock.calls.length;

    fireEvent.click(canvas.querySelector('button')!);
    window.dispatchEvent(new Event('resize'));
    await flushFrame();
    expect(preview.isConnected).toBe(true);
    expectVisible(true);

    fireEvent.click(close);
    window.dispatchEvent(new Event('resize'));
    await flushFrame();
    expect(preview.isConnected).toBe(false);
    expectVisible(true);
    expect(native.setBounds).toHaveBeenCalledTimes(updates);
    expect(guest.contentDocument).toBe(canvas);
    expect(draft.value).toBe('Unsaved canvas edit');
    fireEvent.change(draft, { target: { value: 'Continue editing after preview' } });
    expect(draft.value).toBe('Continue editing after preview');
    expect(native.claim).toHaveBeenCalledTimes(1);
    expect(native.command).not.toHaveBeenCalled();
  });

  it('avoids duplicate IPC during unrelated DOM updates and stops observing on unmount', async () => {
    const tab = render(<NativeTab />);
    await flushFrame();
    const count = native.setBounds.mock.calls.length;
    const content = render(<p>Streaming response</p>);
    await flushFrame();
    expect(native.setBounds).toHaveBeenCalledTimes(count);

    tab.unmount();
    const afterUnmount = native.setBounds.mock.calls.length;
    content.rerender(<Preview open />);
    await flushFrame();
    expect(native.setBounds).toHaveBeenCalledTimes(afterUnmount);
  });
});
