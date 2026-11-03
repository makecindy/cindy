// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GhostCardForm } from '../GhostCardForm';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);
// Sent mail must lose empty add-recipient affordances, while existing Bcc stays viewable.
it('removes empty recipient fields after sending without hiding existing addresses', () => {
  let width = 500;
  let resize = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const fields = [
    { name: 'to', label: 'To', value: 'to@example.test', kind: 'recipients' as const },
    { name: 'cc', label: 'Cc', value: '', kind: 'recipients' as const },
    { name: 'bcc', label: 'Bcc', value: 'hidden@example.test', kind: 'recipients' as const, collapsed: true },
  ];
  const onChange = vi.fn();
  try {
    const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Cc: chat.ghostCall.expandFields (0)' })).toBeTruthy();
    rerender(<GhostCardForm fields={fields} disabled={false} readOnly onChange={onChange} />);
    expect(screen.queryByText('Cc')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.expandFields' }));
    expect(screen.queryByLabelText('Cc')).toBeNull();
    expect((screen.getByLabelText('To') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText('Bcc') as HTMLTextAreaElement).value).toBe('hidden@example.test');
    expect((screen.getByLabelText('Bcc') as HTMLTextAreaElement).disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.collapseFields' }));
    rerender(<GhostCardForm fields={fields.map(f => f.name === 'bcc' ? { ...f, value: '' } : f)} disabled={false} readOnly onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'chat.ghostCall.expandFields' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'To: to@example.test' })).toBeNull();
    width = 1;
    act(() => resize());
    expect(screen.getByRole('button', { name: 'chat.ghostCall.expandFields' })).toBeTruthy();
    width = 500;
    act(() => resize());
    expect(screen.queryByRole('button', { name: 'chat.ghostCall.expandFields' })).toBeNull();
  } finally {
    size.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('keeps recipient and multiline edits through re-renders and disables both while submitting', () => {
  const fields = [
    { name: 'to', label: 'To', value: 'original@example.test' },
    { name: 'cc', label: 'Cc', value: '' },
    { name: 'body', label: 'Message', value: 'Original', multiline: true },
  ];
  const changed = vi.fn();
  const { rerender } = render(
    <GhostCardForm fields={fields} disabled={false} onChange={changed} />,
  );
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'new@example.test' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Edited\n\nSignature' } });
  expect(changed).toHaveBeenLastCalledWith({
    to: 'new@example.test',
    cc: '',
    body: 'Edited\n\nSignature',
  });
  rerender(
    <GhostCardForm
      fields={fields.map((f) => ({
        ...f,
        value: f.name === 'cc' ? 'remote@example.test' : f.value,
      }))}
      disabled
      onChange={changed}
    />,
  );
  expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('new@example.test');
  expect((screen.getByLabelText('Cc') as HTMLInputElement).value).toBe('remote@example.test');
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
});

// User requirement: names fill the available width, and expanding must replace
// the summary while retaining every address in the editable/submitted value.
it('reflows recipients on resize and edits the full header without duplicate labels', () => {
  let width = 500;
  let resize = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const size = vi
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockImplementation(() => width);
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return { width: this.dataset.measure?.startsWith('chip') ? 60 : 30 } as DOMRect;
    });
  const changed = vi.fn();
  const fields = [
    {
      name: 'to',
      label: 'To',
      value: 'Jane <jane@example.test>, Rigo <rigo@example.test>, Oliver <oliver@example.test>',
      kind: 'recipients' as const,
      row: 'recipients',
    },
    {
      name: 'cc',
      label: 'Cc',
      value: 'Emma <emma@example.test>',
      kind: 'recipients' as const,
      row: 'recipients',
    },
    {
      name: 'bcc',
      label: 'Bcc',
      value: 'Hidden <hidden@example.test>',
      kind: 'recipients' as const,
      collapsed: true,
    },
  ];
  try {
    render(<GhostCardForm fields={fields} disabled={false} onChange={changed} />);
    expect(screen.getByRole('button', { name: 'To: Oliver <oliver@example.test>' })).toBeTruthy();
    expect(screen.queryByText('Bcc')).toBeNull();
    width = 230;
    act(() => resize());
    expect(screen.queryByRole('button', { name: 'To: Oliver <oliver@example.test>' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.expandFields' }));
    expect(screen.getAllByText('To')).toHaveLength(1);
    expect(screen.getAllByText('Cc')).toHaveLength(1);
    expect(screen.getAllByText('Bcc')).toHaveLength(1);
    for (const label of ['To', 'Cc', 'Bcc']) {
      expect((screen.getByLabelText(label) as HTMLTextAreaElement).rows).toBe(1);
    }
    fireEvent.change(screen.getByLabelText('Bcc'), {
      target: { value: 'Private <private@example.test>' },
    });
    expect((screen.getByLabelText('To') as HTMLTextAreaElement).value).toBe(fields[0].value);
    fireEvent.change(screen.getByLabelText('Cc'), { target: { value: 'New <new@example.test>' } });
    expect(changed).toHaveBeenLastCalledWith({
      to: fields[0].value,
      cc: 'New <new@example.test>',
      bcc: 'Private <private@example.test>',
    });
    fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.collapseFields' }));
    expect(screen.queryByText('Bcc')).toBeNull();
    width = 500;
    act(() => resize());
    expect(screen.getByRole('button', { name: 'Cc: New <new@example.test>' })).toBeTruthy();
  } finally {
    size.mockRestore();
    rect.mockRestore();
    vi.unstubAllGlobals();
  }
});
