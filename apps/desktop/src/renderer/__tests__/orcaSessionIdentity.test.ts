import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatOrcaLeadTitle,
  formatOrcaWorkerTitle,
  getSessionRouteOwnerId,
  isOrcaLeadSession,
  isOrcaWorkerSession,
  resolveSessionRoute,
} from '@/lib/orcaSessionIdentity';

describe('orcaSessionIdentity', () => {
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = (globalThis as unknown as { window?: unknown }).window;
    (globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        localDb: {
          sessions: {
            get: vi.fn(),
          },
          orcaWorkflows: {
            getByWorkerSession: vi.fn(),
          },
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as unknown as { window?: unknown }).window = originalWindow;
    vi.restoreAllMocks();
  });

  function electronApiMock() {
    return (
      globalThis as unknown as {
        window: {
          electronAPI: {
            localDb: {
              sessions: { get: ReturnType<typeof vi.fn> };
              orcaWorkflows: { getByWorkerSession: ReturnType<typeof vi.fn> };
            };
          };
        };
      }
    ).window.electronAPI;
  }

  it('detects durable Orca identity from session role', () => {
    expect(isOrcaLeadSession({ orcaRole: 'lead' })).toBe(true);
    expect(isOrcaLeadSession({ orcaRole: 'worker' })).toBe(false);
    expect(isOrcaLeadSession({ orcaRole: null })).toBe(false);

    expect(isOrcaWorkerSession({ orcaRole: 'worker' })).toBe(true);
    expect(isOrcaWorkerSession({ orcaRole: 'lead' })).toBe(false);
    expect(isOrcaWorkerSession({})).toBe(false);
  });

  it('keeps Orca display titles cosmetic only', () => {
    expect(formatOrcaLeadTitle('')).toBe('Orca Session');
    expect(formatOrcaLeadTitle('Implement task')).toBe('Implement task');
    expect(formatOrcaWorkerTitle('')).toBe('Orca Worker: Ready');
    expect(formatOrcaWorkerTitle('Implement task')).toBe('Orca Worker: Implement task');
  });

  it('extracts the canonical owner from a resolved session route', () => {
    expect(getSessionRouteOwnerId('/cc-agent/lead-1?worker=worker-1')).toBe('lead-1');
    expect(getSessionRouteOwnerId('/cc-agent/session%20one#message')).toBe('session one');
    expect(getSessionRouteOwnerId('/cc-agent')).toBeNull();
  });

  it('resolves canonical routes from a known session row', async () => {
    const api = electronApiMock();
    api.localDb.orcaWorkflows.getByWorkerSession.mockResolvedValue({
      leadSessionId: 'lead-1',
    });

    await expect(resolveSessionRoute('lead-1', { orcaRole: 'lead' })).resolves.toBe(
      '/cc-agent/lead-1',
    );
    await expect(resolveSessionRoute('worker-1', { orcaRole: 'worker' })).resolves.toBe(
      '/cc-agent/lead-1?worker=worker-1',
    );
    await expect(resolveSessionRoute('plain-1', { orcaRole: null })).resolves.toBe(
      '/cc-agent/plain-1',
    );

    expect(api.localDb.orcaWorkflows.getByWorkerSession).toHaveBeenCalledWith('worker-1');
  });

  it('fetches the session row when a generic entry point only has an id', async () => {
    const api = electronApiMock();
    api.localDb.sessions.get.mockResolvedValue({ orcaRole: 'lead' });

    await expect(resolveSessionRoute('lead-2')).resolves.toBe('/cc-agent/lead-2');

    expect(api.localDb.sessions.get).toHaveBeenCalledWith('lead-2');
  });

  it('routes orphaned Orca workers back through the index fallback', async () => {
    const api = electronApiMock();
    api.localDb.orcaWorkflows.getByWorkerSession.mockResolvedValue(null);

    await expect(resolveSessionRoute('worker-2', { orcaRole: 'worker' })).resolves.toBe(
      '/cc-agent',
    );
  });
});
