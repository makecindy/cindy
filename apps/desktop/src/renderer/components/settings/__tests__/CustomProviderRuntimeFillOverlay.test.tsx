// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CustomProviderRuntimeFillOverlay,
  type RuntimeFillDialogState,
} from '../CustomProviderRuntimeFillOverlay';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function draft(overrides: Partial<RuntimeFillDialogState['sourceDraft']> = {}) {
  return {
    baseUrl: 'https://source.example/v1',
    requestPath: '',
    apiKey: '',
    wireProtocol: 'openai-chat' as const,
    models: [],
    headers: [],
    modelsUrl: '',
    ...overrides,
  };
}

const runtimeNames = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

function state(overrides: Partial<RuntimeFillDialogState> = {}): RuntimeFillDialogState {
  return {
    source: 'codex',
    sourceDraft: draft(),
    includeApiKey: true,
    oauthPiUnavailable: false,
    stage: 'review',
    targets: [
      {
        agent: 'pi',
        draft: draft({
          baseUrl: 'https://target.example/v1',
          requestPath: '/responses',
        }),
        diffs: [
          { field: 'baseUrl', targetState: 'conflict' },
          { field: 'requestPath', targetState: 'conflict' },
          { field: 'wireProtocol', targetState: 'same' },
        ],
      },
    ],
    selected: { pi: ['baseUrl', 'requestPath', 'wireProtocol'] },
    ...overrides,
  };
}

function renderOverlay(value: RuntimeFillDialogState, onClose = vi.fn()) {
  return render(
    <CustomProviderRuntimeFillOverlay
      state={value}
      runtimeNames={runtimeNames}
      onClose={onClose}
      onContinue={() => {}}
      onBack={() => {}}
      onToggleField={() => {}}
      onApply={() => {}}
    />,
  );
}

describe('CustomProviderRuntimeFillOverlay', () => {
  it('never reflects request-path query credentials into text or title attributes', () => {
    renderOverlay(
      state({
        sourceDraft: draft({ requestPath: '/infer?api_key=source-secret' }),
        targets: [
          {
            agent: 'pi',
            draft: draft({ requestPath: '/infer?token=target-secret' }),
            diffs: [{ field: 'requestPath', targetState: 'conflict' }],
          },
        ],
        selected: { pi: ['requestPath'] },
      }),
    );

    expect(document.body.textContent).toContain('/infer');
    expect(document.body.innerHTML).not.toContain('source-secret');
    expect(document.body.innerHTML).not.toContain('target-secret');
  });

  it('renders the endpoint tuple as one checkbox in the confirmation stage', () => {
    renderOverlay(state({ stage: 'confirm' }));

    const choices = screen.getAllByRole('checkbox');
    expect(choices).toHaveLength(1);
    expect(choices[0].textContent).toContain(
      'settings.providers.custom.runtimeFill.fields.endpointBundle',
    );
    expect(choices[0].getAttribute('aria-checked')).toBe('true');
  });

  it('keeps implicit endpoint clears in the same confirmation checkbox', () => {
    renderOverlay(
      state({
        stage: 'confirm',
        targets: [
          {
            agent: 'pi',
            draft: draft({ modelsUrl: 'https://target.example/models' }),
            diffs: [
              { field: 'baseUrl', targetState: 'same' },
              { field: 'requestPath', targetState: 'same' },
              { field: 'wireProtocol', targetState: 'same' },
              { field: 'modelsUrl', targetState: 'conflict', implicitClear: true },
            ],
          },
        ],
        selected: { pi: ['baseUrl', 'requestPath', 'wireProtocol', 'modelsUrl'] },
      }),
    );

    const choices = screen.getAllByRole('checkbox');
    expect(choices).toHaveLength(1);
    expect(choices[0].textContent).toContain(
      'settings.providers.custom.runtimeFill.fields.endpointBundle',
    );
  });

  it('shows protocol incompatibility instead of silently hiding the skipped field', () => {
    renderOverlay(
      state({
        targets: [
          {
            agent: 'claude-code',
            draft: draft({ wireProtocol: 'anthropic-messages' }),
            diffs: [
              {
                field: 'wireProtocol',
                targetState: 'incompatible',
                incompatibilityReason: 'protocol',
              },
            ],
          },
        ],
        selected: {},
      }),
    );

    expect(
      screen.getByText('settings.providers.custom.runtimeFill.incompatibleProtocol'),
    ).not.toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('does not mislabel endpoint incompatibility as an unsupported protocol', () => {
    renderOverlay(
      state({
        targets: [
          {
            agent: 'pi',
            draft: draft(),
            diffs: [
              {
                field: 'requestPath',
                targetState: 'incompatible',
                incompatibilityReason: 'endpoint',
              },
            ],
          },
        ],
        selected: {},
      }),
    );

    expect(
      screen.getByText('settings.providers.custom.runtimeFill.incompatibleEndpoint'),
    ).not.toBeNull();
    expect(
      screen.queryByText('settings.providers.custom.runtimeFill.incompatibleProtocol'),
    ).toBeNull();
  });

  it('shows hidden target headers as configured without exposing values', () => {
    renderOverlay(
      state({
        targets: [
          {
            agent: 'pi',
            draft: draft({ headersState: 'configured' }),
            diffs: [{ field: 'headers', targetState: 'conflict', implicitClear: true }],
          },
        ],
        selected: { pi: ['headers'] },
      }),
    );

    expect(screen.getByText('settings.providers.custom.runtimeFill.values.secretSet')).not.toBeNull();
  });

  it('does not present unreadable target headers as empty', () => {
    renderOverlay(
      state({
        sourceDraft: draft({ headersState: 'unknown' }),
        targets: [
          {
            agent: 'pi',
            draft: draft(),
            diffs: [
              {
                field: 'headers',
                targetState: 'incompatible',
                incompatibilityReason: 'headers',
              },
            ],
          },
        ],
        selected: {},
      }),
    );

    expect(screen.getByText('settings.providers.custom.runtimeFill.values.secretSet')).not.toBeNull();
  });

  it('explains that main-only source headers cannot be copied', () => {
    renderOverlay(
      state({
        sourceDraft: draft({ headersState: 'configured' }),
        targets: [
          {
            agent: 'pi',
            draft: draft(),
            diffs: [
              {
                field: 'headers',
                targetState: 'incompatible',
                incompatibilityReason: 'headers',
              },
            ],
          },
        ],
        selected: {},
      }),
    );

    expect(
      screen.getByText('settings.providers.custom.runtimeFill.incompatibleHeaders'),
    ).not.toBeNull();
  });

  it('focuses the primary action, traps keyboard focus, closes on Escape, and restores focus', async () => {
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button">
            Open fill
          </button>
          {open && (
            <CustomProviderRuntimeFillOverlay
              state={state()}
              runtimeNames={runtimeNames}
              returnFocusRef={triggerRef}
              onClose={() => {
                onClose();
                setOpen(false);
              }}
              onContinue={() => {}}
              onBack={() => {}}
              onToggleField={() => {}}
              onApply={() => {}}
            />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const primary = screen.getByRole('button', {
      name: 'settings.providers.custom.runtimeFill.continue',
    });
    await waitFor(() => expect(document.activeElement).toBe(primary));

    await user.tab();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open fill' })),
    );
  });
});
