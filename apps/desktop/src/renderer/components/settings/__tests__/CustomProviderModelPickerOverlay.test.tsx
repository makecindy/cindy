// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelPickerOverlay } from '../CustomProviderDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const models = Array.from({ length: 9 }, (_, index) => ({
  id: `model-${index}`,
  name: `Model ${index}`,
}));

describe('ModelPickerOverlay', () => {
  it('focuses search, traps focus, closes on Escape, and restores the trigger', async () => {
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(true);
      const [picker, setPicker] = useState<{
        agent: 'claude-code' | 'codex' | 'pi';
        models: typeof models;
        selected: Set<string>;
        query: string;
      }>({
        agent: 'pi',
        models,
        selected: new Set(['model-0']),
        query: '',
      });
      const triggerRef = useRef<HTMLButtonElement>(null);

      return (
        <>
          <button ref={triggerRef} type="button">
            Fetch models
          </button>
          {open && (
            <ModelPickerOverlay
              picker={picker}
              onChange={setPicker}
              onConfirm={() => {}}
              onClose={() => {
                onClose();
                setOpen(false);
              }}
              returnFocusRef={triggerRef}
            />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);

    expect(
      screen.queryAllByRole('button', { name: 'settings.providers.custom.cancel' }),
    ).toHaveLength(1);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText('settings.providers.custom.fetch.searchPlaceholder'),
      ),
    );

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).not.toBeNull();

    await user.tab({ shift: true });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fetch models' })),
    );
  });

  it('focuses the first model when the short list has no search field', async () => {
    const triggerRef = { current: null };

    render(
      <ModelPickerOverlay
        picker={{
          agent: 'codex',
          models: models.slice(0, 2),
          selected: new Set(),
          query: '',
        }}
        onChange={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        returnFocusRef={triggerRef}
      />,
    );

    const firstModel = screen.getAllByRole('checkbox')[0];
    await waitFor(() => expect(document.activeElement).toBe(firstModel));
  });
});
