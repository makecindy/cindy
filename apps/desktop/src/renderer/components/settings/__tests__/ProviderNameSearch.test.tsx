// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderNameSearch } from '../ProviderNameSearch';
import type { ProviderSearchResult } from '../providerSearch';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
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
