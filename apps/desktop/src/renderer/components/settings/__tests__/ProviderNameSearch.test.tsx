// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderNameSearch } from '../ProviderNameSearch';
import type { ProviderSearchResult } from '../providerSearch';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { product?: string }) => values?.product ? `${key}: ${values.product}` : key }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const a: ProviderSearchResult = { key: 'preset:a', id: 'a', name: 'Supplier A', names: [], metaKey: 'wizard.metaApiKey', target: { kind: 'preset', presetId: 'a' } };
const b: ProviderSearchResult = { ...a, key: 'preset:b', id: 'b', name: 'Supplier B', target: { kind: 'preset', presetId: 'b' } };
function Harness({ choices, onSelect }: { choices: ProviderSearchResult[]; onSelect: ReturnType<typeof vi.fn> }) {
  const [value, setValue] = useState('Supplier');
  const [open, setOpen] = useState(true);
  return <ProviderNameSearch value={value} onChange={setValue} choices={choices} open={open} onOpenChange={setOpen} onSelect={onSelect} aria-label="name" />;
}
it('keeps the active supplier identity when an asynchronous catalog changes order', () => {
  Element.prototype.scrollIntoView = vi.fn();
  const onSelect = vi.fn();
  const { rerender } = render(<Harness choices={[a, b]} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  rerender(<Harness choices={[b, a]} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(a.target);
});
it('does not select a replacement after the active supplier disappears or during IME composition', () => {
  const onSelect = vi.fn();
  const { rerender } = render(<Harness choices={[a, b]} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  rerender(<Harness choices={[b]} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
  expect(onSelect).not.toHaveBeenCalled();
});

it.each([{ isComposing: true }, { keyCode: 229 }])('keeps search open for IME Escape %j, then lets ordinary Escape dismiss it', flags => {
  render(<Harness choices={[a, b]} onSelect={vi.fn()} />);
  fireEvent.keyDown(document, { key: 'Escape', ...flags });
  expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
});

// The visible row must interpolate the existing product name, not leak {{product}}.
it('renders preset-specific summary values in the search result', () => {
  const choice = { ...a, metaKey: 'models.subscriptionProduct', metaValues: { product: 'MiMo Token Plan' } };
  render(<Harness choices={[choice]} onSelect={vi.fn()} />);
  expect(screen.getByText('settings.providers.models.subscriptionProduct: MiMo Token Plan')).toBeTruthy();
});

// #8065 r4431297882: reopening remounts the options after keydown; checking
// the committed DOM catches the previous synchronous scroll of a missing row.
it.each([false, true])('scrolls a remounted keyboard option (retained=%s)', retained => {
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = vi.fn(function(this: Element) { if (this.isConnected) scrolled.push(this.id); });
  const choices = Array.from({ length: 40 }, (_, index) => ({ ...a, key: `preset:${index}`, id: `${index}`, name: `Supplier ${index}`, target: { kind: 'preset' as const, presetId: `${index}` } }));
  render(<Harness choices={choices} onSelect={vi.fn()} />);
  if (retained) { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' }); flush(); }
  scrolled.length = 0;
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
  const activeId = screen.getByRole('combobox').getAttribute('aria-activedescendant')!;
  flush();
  expect(scrolled).toContain(activeId);
  expect(document.getElementById(activeId)?.textContent).toContain(retained ? 'Supplier 38' : 'Supplier 39');
});
