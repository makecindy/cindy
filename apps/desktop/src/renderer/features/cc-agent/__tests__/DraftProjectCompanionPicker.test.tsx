// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftProjectCompanionPicker } from '../DraftProjectCompanionPicker';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

// Unit: operate the actual new-task selector with an ID distinct from its name.
// An unavailable selection must remain visible and clearable before the user sends.
it('selects a partner by ID and offers the default even after the selected partner disappears', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const onChange = vi.fn();
  const partners = [{ id: 'default', name: '小满' }];
  const { rerender } = render(<DraftProjectCompanionPicker partners={partners} value={null} onChange={onChange} />);
  const trigger = screen.getByRole('combobox', { name: 'projectCompanion.title · projectCompanion.default' });
  expect(trigger.textContent).toBe('projectCompanion.default');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(await screen.findByRole('group', { name: 'projectCompanion.title' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'projectCompanion.default' }).getAttribute('data-state')).toBe('checked');
  fireEvent.keyDown(await screen.findByRole('option', { name: '小满' }), { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('default');
  rerender(<DraftProjectCompanionPicker partners={[]} value="default" onChange={onChange} />);
  expect(trigger.textContent).toBe('projectCompanion.unavailable');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.keyDown(await screen.findByRole('option', { name: 'projectCompanion.default' }), { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith(null);
});
