// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FormField } from '../form-field';
import { Input } from '../input';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('associates labels, hints, errors and caller descriptions without native required validation', async () => {
  const { rerender } = render(
    <FormField label="Endpoint" hint="Use HTTPS" required describedBy="external" reserveFeedback>
      {(control) => <Input {...control} value="" onChange={() => {}} />}
    </FormField>,
  );
  const input = screen.getByLabelText('Endpoint');
  const id = input.id;
  await userEvent.click(screen.getByText('Endpoint'));
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute('aria-required')).toBe('true');
  expect(input.hasAttribute('required')).toBe(false);
  rerender(
    <FormField
      label="Endpoint"
      hint="Use HTTPS"
      error="Invalid URL"
      required
      describedBy="external"
      reserveFeedback
    >
      {(control) => <Input {...control} value="bad" onChange={() => {}} />}
    </FormField>,
  );
  expect(input.id).toBe(id);
  expect(input.getAttribute('aria-describedby')).toBe(`external ${id}-hint ${id}-error`);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(`${id}-error`)?.textContent).toBe('Invalid URL');
});

it('keeps surviving dynamic field identities when an earlier row is removed', () => {
  const fields = (keys: number[]) =>
    keys.map((key) => (
      <FormField key={key} label={`Header ${key}`}>
        {(control) => <Input {...control} value="" onChange={() => {}} />}
      </FormField>
    ));
  const { rerender } = render(<>{fields([1, 2])}</>);
  const survivingId = screen.getByLabelText('Header 2').id;
  expect(screen.getByLabelText('Header 1').id).not.toBe(survivingId);
  rerender(<>{fields([2])}</>);
  expect(screen.getByLabelText('Header 2').id).toBe(survivingId);
});
