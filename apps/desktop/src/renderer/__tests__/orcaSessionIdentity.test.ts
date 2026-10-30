import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatOrcaLeadTitle,
  formatOrcaWorkerTitle,
  getSessionRouteOwnerId,
  isOrcaLeadSession,
  isOrcaWorkerSession,
  orcaWorkerSessionRoute,
  resolveSessionRoute,
} from '@/lib/orcaSessionIdentity';
import { registerLoadedBotProfilesReader } from '@/features/bots/botSessionOwners';
import type { BotProfile } from '@/features/bots/botStore';

// The loaded projection reaches the route helper through the registry botStore fills at
// load; the store itself never loads here (no dynamic import on a click).
const bots = { loaded: true, profiles: [] as unknown[] };
registerLoadedBotProfilesReader(() => (bots.loaded ? (bots.profiles as BotProfile[]) : null));

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
    bots.loaded = true;
    bots.profiles = [];
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

  // A notification may reach the Worker before its Lead's device origin is
  // cached. The redirect must carry the device into the Lead origin gate.
  it('retains the original device and query when a Worker entry redirects to its Lead', () => {
    const target = new URL(orcaWorkerSessionRoute('lead/1', 'worker/1', '?device=studio&worker=stale&source=notification'), 'https://cindy.invalid');
    expect(target.pathname).toBe('/cc-agent/lead%2F1');
    expect(target.searchParams.get('device')).toBe('studio');
    expect(target.searchParams.get('worker')).toBe('worker/1');
    expect(target.searchParams.get('source')).toBe('notification');
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

  it.each(['cindy-make', 'cindy-make-merge'] as const)('redirects old %s links to the task index', async (source) => {
    const api = electronApiMock();
    await expect(resolveSessionRoute('old-make', { orcaRole: null, source })).resolves.toBe('/cc-agent');
    api.localDb.sessions.get.mockResolvedValue({ orcaRole: null, source });
    await expect(resolveSessionRoute('old-make')).resolves.toBe('/cc-agent');
    expect(api.localDb.orcaWorkflows.getByWorkerSession).not.toHaveBeenCalled();
  });

  it('keeps the main Bot chat entry and opens every other task on the ordinary route', async () => {
    bots.profiles = [{
      id: 'bot-a',
      sessions: [
        { id: 'bot-main', role: 'canonical', kind: 'chat' },
        { id: 'bot-old', role: 'history', kind: 'history' },
        { id: 'bot-task', role: 'delegation', kind: 'worker' },
        { id: 'bot-lane', role: 'group', kind: 'group', groupId: 'group/1' },
        { id: 'bot-legacy-lane', role: 'group', kind: 'group' },
      ],
    }];
    await expect(resolveSessionRoute('bot-main', { orcaRole: null, source: 'bot' })).resolves.toBe('/bots/bot-a/session/bot-main');
    await expect(resolveSessionRoute('bot-old', { orcaRole: null })).resolves.toBe('/cc-agent/bot-old');
    await expect(resolveSessionRoute('bot-task', { orcaRole: null, source: 'desktop' })).resolves.toBe('/cc-agent/bot-task');
    await expect(resolveSessionRoute('bot-lane', { orcaRole: null })).resolves.toBe('/cc-agent/bot-lane');
    await expect(resolveSessionRoute('bot-legacy-lane', { orcaRole: null })).resolves.toBe('/cc-agent/bot-legacy-lane');
    await expect(resolveSessionRoute('plain-3', { orcaRole: null })).resolves.toBe('/cc-agent/plain-3');
  });

  it('falls back to the ordinary route while Bot profiles are not loaded, without waiting on IPC', async () => {
    bots.loaded = false;
    bots.profiles = [{ id: 'bot-a', sessions: [{ id: 'bot-main', role: 'canonical', kind: 'chat' }] }];
    await expect(resolveSessionRoute('bot-main', { orcaRole: null })).resolves.toBe('/cc-agent/bot-main');
  });

  it('does not redirect an explicitly remote task to a same-id local Bot', async () => {
    bots.profiles = [{ id: 'local', sessions: [{ id: 'same', role: 'canonical', kind: 'chat' }] }];
    await expect(resolveSessionRoute('same', { orcaRole: null }, { remote: true })).resolves.toBe('/cc-agent/same');
    await expect(resolveSessionRoute('same', { orcaRole: null })).resolves.toBe('/bots/local/session/same');
  });

  it('routes orphaned Orca workers back through the index fallback', async () => {
    const api = electronApiMock();
    api.localDb.orcaWorkflows.getByWorkerSession.mockResolvedValue(null);

    await expect(resolveSessionRoute('worker-2', { orcaRole: 'worker' })).resolves.toBe(
      '/cc-agent',
    );
  });
});
