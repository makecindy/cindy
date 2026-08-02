// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
  confirmAgentSwitchRisk,
} from '@/components/new-chat/agentSwitchConfirmation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STORAGE_KEY = `confirm-dialog.skip:${AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY}`;
const COPY = {
  title: 'Switch Agent?',
  description: 'Switching agents has handoff costs.',
  confirmText: 'Switch Agent',
  cancelText: 'Keep Current Agent',
  dontShowAgainLabel: 'Don’t remind me again',
};

function Harness({
  hasSwitchIntent = false,
  onBrowse,
}: {
  hasSwitchIntent?: boolean;
  onBrowse: () => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmAgentSwitchRisk({
          hasSwitchIntent,
          confirm,
          copy: COPY,
        }).then((proceed) => {
          if (proceed) onBrowse();
        });
      }}
    >
      Browse Target Agent
    </button>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  return render(
    <ConfirmDialogProvider>
      <Harness {...props} />
    </ConfirmDialogProvider>,
  );
}

describe('Agent switch confirmation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts before browsing another Agent and cancel leaves the tab untouched', async () => {
    const onBrowse = vi.fn();
    renderHarness({ onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    const title = await screen.findByText(COPY.title);
    expect(title.className).toContain('select-none');
    expect(screen.getByText(COPY.description).className).toContain('select-none');

    fireEvent.click(screen.getByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(COPY.title)).toBeNull());
    expect(onBrowse).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not prompt again when an Agent switch intent already exists', async () => {
    const onBrowse = vi.fn();
    renderHarness({ hasSwitchIntent: true, onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it('persists the explicit skip override only after checked confirmation', async () => {
    const onBrowse = vi.fn();
    const first = renderHarness({ onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.confirmText }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');

    first.unmount();
    renderHarness({ onBrowse });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    });
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });
});
