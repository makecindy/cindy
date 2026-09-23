// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string) => key,
  }),
}));

import { AgentVersionsRows } from '../AboutSection';

const getBinaryVersion = vi.fn();
const getState = vi.fn();

describe('AboutSection agent binary versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockResolvedValue({ currentVersion: '0.84.4', restartRequired: false, official: { release: null }, upstream: { release: null }, operation: null });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        piKernel: { getState },
        agent: {
          getBinaryVersion,
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('requests and renders Claude Code, Codex, and Pi versions', async () => {
    getBinaryVersion.mockImplementation((kind: string) =>
      Promise.resolve({
        kind,
        binaryPath: `/${kind}`,
        version:
          kind === 'claude-code'
            ? '2.1.258 (Claude Code)'
            : kind === 'codex'
              ? 'codex-cli 0.145.0'
              : 'pi 0.84.4',
      }),
    );

    render(<AgentVersionsRows />);

    await waitFor(() => expect(getBinaryVersion).toHaveBeenCalledTimes(2));
    expect(getBinaryVersion).toHaveBeenCalledWith('claude-code');
    expect(getBinaryVersion).toHaveBeenCalledWith('codex');
    expect(getState).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('settings.about.claudeCodeVersionLabel')).toBeTruthy();
      expect(screen.getByText('settings.about.codexVersionLabel')).toBeTruthy();
      expect(screen.getByText('settings.about.piVersionLabel')).toBeTruthy();
      expect(screen.getByText('0.84.4')).toBeTruthy();
    });
  });

  it('shows the existing not-ready state when Pi is unavailable', async () => {
    getState.mockResolvedValue({ currentVersion: null, restartRequired: false, official: { release: null }, upstream: { release: null }, operation: null });
    getBinaryVersion.mockImplementation((kind: string) =>
      Promise.resolve(
        kind === 'pi'
          ? { kind, binaryPath: null, version: null, error: 'binary_not_ready' }
          : { kind, binaryPath: `/${kind}`, version: '1.0.0' },
      ),
    );

    render(<AgentVersionsRows />);

    await waitFor(() => expect(screen.getByText('settings.about.version.notReady')).toBeTruthy());
  });
});
