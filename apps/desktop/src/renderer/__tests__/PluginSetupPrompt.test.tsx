// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { PluginSetupPrompt } from '@/components/new-chat/PluginSetupPrompt';
import { parsePendingPluginSetup, type PendingPluginSetup } from '@/lib/makerChatStore';

const pending: PendingPluginSetup = {
  requestId: 'setup-1',
  revision: 3,
  ghost: {
    id: 'filo-google',
    name: 'Filo Google',
  },
  intro: 'Filo Google needs access to your account.',
  steps: [
    {
      id: 'google-account',
      groupId: 'account',
      groupMode: 'any_of',
      title: 'Connect your Google account',
      description: 'Authorize Gmail access. <script>not markup</script>',
      phase: 'pending',
      action: {
        id: 'oauth-connect:google-account',
        kind: 'oauth_connect',
      },
    },
  ],
};

const inlinePending: PendingPluginSetup = {
  requestId: 'setup-1',
  revision: 3,
  ghost: {
    id: 'art',
    name: 'Art',
  },
  intro: 'Art needs an API key.',
  steps: [
    {
      id: 'api-key',
      groupId: 'credential',
      groupMode: 'any_of',
      title: 'Configure API key',
      description: 'Enter the key provided by Art.',
      phase: 'pending',
      action: {
        id: 'inline:api-key',
        kind: 'inline_form',
        form: {
          fields: [
            {
              id: 'value',
              type: 'secret',
              label: 'API Key',
              description: 'Stored securely on this desktop.',
              placeholder: 'Enter API Key',
              externalLink: {
                url: 'https://console.example.com/keys',
              },
              required: true,
              maxLength: 200,
            },
          ],
        },
      },
    },
  ],
};

const inlineAlternativesPending: PendingPluginSetup = {
  requestId: 'setup-alternatives',
  revision: 5,
  ghost: {
    id: 'web-search',
    name: 'Web Search',
  },
  intro: 'Configure a search provider to continue.',
  steps: [
    {
      id: 'brave-key',
      groupId: 'search-provider',
      groupMode: 'any_of',
      title: 'Brave API Key',
      description: 'Use a Brave Search API key.',
      phase: 'pending',
      action: {
        id: 'inline:brave',
        kind: 'inline_form',
        form: {
          fields: [
            {
              id: 'value',
              type: 'secret',
              label: 'Brave API Key',
              externalLink: { url: 'https://brave.example.com/keys' },
              required: true,
              maxLength: 200,
            },
          ],
        },
      },
    },
    {
      id: 'tavily-key',
      groupId: 'search-provider',
      groupMode: 'any_of',
      title: 'Tavily API Key',
      description: 'Use a Tavily API key.',
      phase: 'pending',
      action: {
        id: 'inline:tavily',
        kind: 'inline_form',
        form: {
          fields: [
            {
              id: 'value',
              type: 'secret',
              label: 'Tavily API Key',
              externalLink: { url: 'https://tavily.example.com/keys' },
              required: true,
              maxLength: 200,
            },
          ],
        },
      },
    },
  ],
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openExternal: vi.fn(async () => ({ success: true })),
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('PluginSetupPrompt', () => {
  it('accepts the full manifest capacity plus bounded Host-owned setup steps', () => {
    const steps = Array.from({ length: 65 }, (_, index) => ({
      ...pending.steps[0],
      id: `setup-step-${index}`,
    }));

    expect(parsePendingPluginSetup({ ...pending, steps })).not.toBeNull();
    expect(
      parsePendingPluginSetup({
        ...pending,
        steps: Array.from({ length: 89 }, (_, index) => ({
          ...pending.steps[0],
          id: `oversized-step-${index}`,
        })),
      }),
    ).toBeNull();
  });

  it('accepts known setup error codes and rejects unknown codes at the Renderer boundary', () => {
    expect(
      parsePendingPluginSetup({
        ...pending,
        steps: [{ ...pending.steps[0], phase: 'failed', errorCode: 'AUTH_FAILED' }],
      })?.steps[0].errorCode,
    ).toBe('AUTH_FAILED');
    expect(
      parsePendingPluginSetup({
        ...pending,
        steps: [{ ...pending.steps[0], phase: 'failed', errorCode: 'PROVIDER_RAW_ERROR' }],
      }),
    ).toBeNull();
  });

  it('renders Host identity and Agent text as plain text, then sends a run_action command', () => {
    const onCommand = vi.fn();
    render(
      <PluginSetupPrompt
        pending={pending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    expect(screen.getByText('Filo Google Settings')).toBeTruthy();
    expect(screen.getByText('Authorize Gmail access. <script>not markup</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    const stepList = screen.getByTestId('plugin-setup-step-list');
    expect(stepList.classList.contains('rounded-[12px]')).toBe(false);
    expect(screen.queryByText('Pending')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(onCommand).toHaveBeenCalledWith('setup-1', 'run_action', 'oauth-connect:google-account');
  });

  it('stays expanded and hides collapse controls even when viewer state is minimized', () => {
    const onViewerStateChange = vi.fn();
    const onCommand = vi.fn();
    render(
      <PluginSetupPrompt
        pending={pending}
        viewerState="minimized"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={onViewerStateChange}
        onCommand={onCommand}
      />,
    );

    expect(screen.getByText('Authorize Gmail access. <script>not markup</script>')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore Filo Google settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Minimize Filo Google settings' })).toBeNull();
    expect(onViewerStateChange).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('keeps remote setup visible but disables local-only actions', () => {
    render(
      <PluginSetupPrompt
        pending={pending}
        viewerState="expanded"
        commandInFlight={null}
        remote
        onViewerStateChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'Complete this setup on the controlled desktop. This card will update automatically.',
      ),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Authorize' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('disables duplicate commands while Main owns an in-flight action', () => {
    render(
      <PluginSetupPrompt
        pending={pending}
        viewerState="expanded"
        commandInFlight={{
          requestId: 'setup-1',
          action: 'run_action',
          actionId: 'oauth-connect:google-account',
        }}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole('button', { name: 'In progress…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('allows a Host action to be retried while waiting for external setup', () => {
    const onCommand = vi.fn();
    render(
      <PluginSetupPrompt
        pending={{
          ...pending,
          steps: [
            {
              ...pending.steps[0],
              phase: 'waiting_external',
              action: {
                id: 'open-settings:account',
                kind: 'open_plugin_settings',
              },
            },
          ],
        }}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    const retryButton = screen.getByRole('button', { name: 'Open settings' });
    expect((retryButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retryButton);
    expect(onCommand).toHaveBeenCalledWith(
      'setup-1',
      'run_action',
      'open-settings:account',
    );
  });

  it('localizes stable error codes and ignores legacy Main copy when both are present', () => {
    render(
      <PluginSetupPrompt
        pending={{
          ...pending,
          steps: [
            {
              ...pending.steps[0],
              phase: 'failed',
              errorCode: 'TIMEOUT',
              errorMessage: '等待超时',
            },
          ],
        }}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getByText('Setup timed out. Try again.')).toBeTruthy();
    expect(screen.queryByText('等待超时')).toBeNull();
  });

  it('hides actions after a partially satisfied setup is cancelled', () => {
    render(
      <PluginSetupPrompt
        pending={{
          ...pending,
          steps: [
            { ...pending.steps[0], phase: 'satisfied' },
            {
              ...pending.steps[0],
              id: 'second-step',
              phase: 'cancelled',
            },
          ],
        }}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Authorize' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('renders and submits an inline Secret without keeping it in the input', () => {
    const onCommand = vi.fn();
    render(
      <PluginSetupPrompt
        pending={inlinePending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    const input = screen.getByLabelText('API Key') as HTMLInputElement;
    const saveButton = screen.getByRole('button', { name: 'Save Configuration' });
    expect(input.type).toBe('password');
    expect(screen.getByText('Art needs an API key.')).toBeTruthy();
    expect(screen.queryByText('Configure API key')).toBeNull();
    expect(screen.queryByText('Enter the key provided by Art.')).toBeNull();
    expect(screen.getByText('Stored securely on this desktop.')).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'secret-value' } });
    fireEvent.click(saveButton);

    expect(onCommand).toHaveBeenCalledWith('setup-1', 'submit_form', 'inline:api-key', {
      value: 'secret-value',
    });
    expect(input.value).toBe('');
  });

  it('drops an unsubmitted inline Secret when the Host advances the setup revision', () => {
    const onCommand = vi.fn();
    const { rerender } = render(
      <PluginSetupPrompt
        pending={inlinePending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    const previousInput = screen.getByLabelText('API Key') as HTMLInputElement;
    fireEvent.change(previousInput, { target: { value: 'transient-secret' } });
    expect(previousInput.value).toBe('transient-secret');

    rerender(
      <PluginSetupPrompt
        pending={{ ...inlinePending, revision: inlinePending.revision + 1 }}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    const nextInput = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(nextInput).not.toBe(previousInput);
    expect(nextInput.value).toBe('');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('replaces the completed card with the next queued request and resets transient input', () => {
    const onCommand = vi.fn();
    const { rerender } = render(
      <PluginSetupPrompt
        pending={inlinePending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    const firstInput = screen.getByLabelText('API Key') as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: 'transient-secret' } });

    rerender(
      <PluginSetupPrompt
        pending={{ ...pending, requestId: 'setup-2', revision: inlinePending.revision }}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    expect(screen.queryByLabelText('API Key')).toBeNull();
    expect(screen.getByText('Filo Google Settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(onCommand).toHaveBeenCalledWith('setup-2', 'run_action', 'oauth-connect:google-account');
  });

  it('opens the Host-declared credential page as a compact auxiliary link', async () => {
    render(
      <PluginSetupPrompt
        pending={inlinePending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Get API Key' }));
    expect(window.electronAPI.openExternal).toHaveBeenCalledWith(
      'https://console.example.com/keys',
    );
  });

  it('submits inline configuration on Enter but ignores composing Enter', () => {
    const onCommand = vi.fn();
    render(
      <PluginSetupPrompt
        pending={inlinePending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    const input = screen.getByLabelText('API Key');
    fireEvent.change(input, { target: { value: 'secret-value' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('setup-1', 'submit_form', 'inline:api-key', {
      value: 'secret-value',
    });
  });

  it('keeps inline Secret submission disabled on remote sessions', () => {
    render(
      <PluginSetupPrompt
        pending={inlinePending}
        viewerState="expanded"
        commandInFlight={null}
        remote
        onViewerStateChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    expect((screen.getByLabelText('API Key') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Save Configuration' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Get API Key' })).toBeNull();
  });

  it('shows every Host-declared any-of option and submits the selected setup path', () => {
    const onCommand = vi.fn();
    render(
      <PluginSetupPrompt
        pending={inlineAlternativesPending}
        viewerState="expanded"
        commandInFlight={null}
        remote={false}
        onViewerStateChange={vi.fn()}
        onCommand={onCommand}
      />,
    );

    expect(screen.queryByText('Choose one setup method')).toBeNull();
    const scrollRegion = screen.getByTestId('interaction-prompt-scroll-region');
    expect(scrollRegion.classList.contains('overflow-y-auto')).toBe(true);
    expect(scrollRegion.classList.contains('max-h-[min(320px,42vh)]')).toBe(true);
    const shell = scrollRegion.parentElement?.parentElement;
    expect(shell?.classList.contains('w-full')).toBe(true);
    expect(shell?.classList.contains('max-w-[914px]')).toBe(false);
    const stepList = screen.getByTestId('plugin-setup-step-list');
    expect(stepList.classList.contains('rounded-[12px]')).toBe(false);
    expect(stepList.classList.contains('border')).toBe(false);
    expect(screen.queryByText('Pending')).toBeNull();
    expect(screen.getByLabelText('Brave API Key')).toBeTruthy();
    const tavilyInput = screen.getByLabelText('Tavily API Key');
    expect(tavilyInput).toBeTruthy();
    const braveInput = screen.getByLabelText('Brave API Key');
    const braveHint = screen.getByText('Use a Brave Search API key.');
    const credentialLink = screen.getByRole('button', { name: 'Get Brave API Key' });
    expect(braveHint.parentElement).toBe(credentialLink.parentElement);
    fireEvent.blur(braveInput);
    const validationMessage = screen.getByText('Enter Brave API Key');
    expect(validationMessage.parentElement).toBe(credentialLink.parentElement);
    expect(screen.queryByText('Use a Brave Search API key.')).toBeNull();
    expect(
      tavilyInput.parentElement?.contains(
        screen.getAllByRole('button', { name: 'Save Configuration' })[1],
      ),
    ).toBe(true);
    fireEvent.change(tavilyInput, { target: { value: 'tvly-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save Configuration' })[1]);

    expect(onCommand).toHaveBeenCalledWith('setup-alternatives', 'submit_form', 'inline:tavily', {
      value: 'tvly-secret',
    });
  });
});
