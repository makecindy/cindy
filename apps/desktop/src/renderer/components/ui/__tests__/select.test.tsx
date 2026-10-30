// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Select, SelectParts } from '../select';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerType: string;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerType = options.pointerType ?? 'mouse';
      }
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Number(this.dataset.width ?? 200);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Number(this.dataset.height ?? 32);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const group = this.parentElement?.closest<HTMLElement>('[data-positioned-group]');
    return new DOMRect(
      100 + Number(this.dataset.x ?? 0) + Number(group?.dataset.x ?? 0),
      50 + Number(this.dataset.y ?? 0) + Number(group?.dataset.y ?? 0),
      Number(this.dataset.width ?? 200),
      Number(this.dataset.height ?? 32),
    );
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
];

describe('shared Select interaction', () => {
  it('switches focus feedback between keyboard and mouse without dropping restored focus', async () => {
    const change = vi.fn();
    render(<Select label="Language" value="a" options={options} onValueChange={change} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const alpha = await screen.findByRole('option', { name: 'Alpha' });
    await waitFor(() => expect(document.activeElement).toBe(alpha));
    fireEvent.keyDown(alpha, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.hasAttribute('data-pointer-focus')).toBe(false);

    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0, ctrlKey: false });
    await screen.findByRole('listbox');
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute('data-pointer-focus')).toBe('true');

    fireEvent.keyDown(trigger, { key: 'Enter' });
    const reopened = await screen.findByRole('listbox');
    fireEvent.keyDown(reopened, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.hasAttribute('data-pointer-focus')).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });

  it('browses past disabled options without saving, then commits once and returns focus', async () => {
    const change = vi.fn();
    render(<Select label="Language" value="a" options={options} onValueChange={change} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const alpha = await screen.findByRole('option', { name: 'Alpha' });
    await waitFor(() => expect(document.activeElement).toBe(alpha));
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    const gamma = screen.getByRole('option', { name: 'Gamma' });
    await waitFor(() => expect(document.activeElement).toBe(gamma));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'Beta' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(gamma, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(change).toHaveBeenCalledExactlyOnceWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('pointer browsing and Esc preserve the selected value; disabled items cannot commit', async () => {
    const change = vi.fn();
    render(<Select label="Language" value="a" options={options} onValueChange={change} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const gamma = await screen.findByRole('option', { name: 'Gamma' });
    fireEvent.pointerMove(gamma, { pointerType: 'mouse' });
    await waitFor(() => expect(document.activeElement).toBe(gamma));
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    fireEvent.keyDown(gamma, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(change).not.toHaveBeenCalled();
    expect(trigger.textContent).toContain('Alpha');
    expect(trigger.className).toContain('focus-visible:ring-2');
    expect(trigger.className).not.toMatch(/(?:^|\s)focus:ring-/);
  });

  it('joins the shared menu glide highlight and keeps the check on the saved value', async () => {
    render(
      <SelectParts.Root defaultValue="a">
        <SelectParts.Trigger aria-label="Device">
          <SelectParts.Value />
        </SelectParts.Trigger>
        <SelectParts.Portal>
          <SelectParts.Content>
            <SelectParts.Viewport>
              <SelectParts.Group>
                <SelectParts.Label>Computers</SelectParts.Label>
                <SelectParts.Item value="a">
                  <SelectParts.ItemText>Local</SelectParts.ItemText>
                  <SelectParts.ItemIndicator>Saved</SelectParts.ItemIndicator>
                </SelectParts.Item>
                <SelectParts.Item value="c">
                  <SelectParts.ItemText>Remote</SelectParts.ItemText>
                  <span>Last synchronized today</span>
                </SelectParts.Item>
                <SelectParts.Item value="d" className="data-[highlighted]:bg-[var(--surface-hover)]">
                  <SelectParts.ItemText>Custom</SelectParts.ItemText>
                </SelectParts.Item>
              </SelectParts.Group>
            </SelectParts.Viewport>
          </SelectParts.Content>
        </SelectParts.Portal>
      </SelectParts.Root>,
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    const local = await screen.findByRole('option', { name: 'Local' });
    await waitFor(() => expect(document.activeElement).toBe(local));
    const layers = document.querySelectorAll<HTMLElement>('[data-menu-highlight-layer]');
    expect(layers).toHaveLength(1);
    const layer = layers[0];
    expect(layer.parentElement?.hasAttribute('data-menu-panel')).toBe(true);
    await waitFor(() => expect(layer.dataset.row).toBe('0'));
    expect(layer.dataset.visible).toBe('true');

    const remote = screen.getByRole('option', { name: 'Remote' });
    fireEvent.keyDown(local, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(remote));
    await waitFor(() => expect(layer.dataset.row).toBe('1'));
    expect(remote.hasAttribute('data-menu-active')).toBe(true);
    expect(local.getAttribute('data-state')).toBe('checked');
    expect(remote.getAttribute('data-state')).toBe('unchecked');

    const custom = screen.getByRole('option', { name: 'Custom' });
    expect(custom.hasAttribute('data-menu-own-highlight')).toBe(true);
    fireEvent.keyDown(remote, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(custom));
    await waitFor(() => expect(layer.dataset.visible).toBeUndefined());
  });
});
