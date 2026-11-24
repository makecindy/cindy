// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudInstanceAccessProvider, useCloudInstanceAccess, useCloudInstanceAccessUnverified } from '../CloudInstanceAccess';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const auth = vi.hoisted(() => ({
  mode: 'cloud',
  isAuthenticated: true,
  isInitializing: false,
  canEnterApp: true,
  dataOwnerId: 'owner-a',
  dataOwnerGeneration: 1,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const instanceAccess = vi.fn();
const instanceList = vi.fn();
vi.mock('@/features/remote-desktop/useRemoteDesktopAvailability', () => ({
  useRemoteDesktopAvailability: () => ({ available: false, checking: false, reason: 'offline' }),
}));
beforeEach(() => {
  Object.assign(auth, {
    mode: 'cloud',
    isAuthenticated: true,
    isInitializing: false,
    canEnterApp: true,
    dataOwnerId: 'owner-a',
    dataOwnerGeneration: 1,
  });
  setDataOwnerGeneration(auth.dataOwnerId, auth.dataOwnerGeneration);
  instanceAccess.mockReset().mockResolvedValue({ schemaVersion: 1, allowed: true });
  instanceList.mockReset().mockResolvedValue([]);
  vi.stubGlobal('electronAPI', { cloudSettings: { instanceAccess, instanceList } });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `Configure ${vars.name}` : key),
  }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function Probe() {
  return <output data-testid="access">{useCloudInstanceAccess()}</output>;
}
function UnverifiedProbe() {
  return <output data-testid="unverified">{String(useCloudInstanceAccessUnverified())}</output>;
}
function content() {
  return (
    <CloudInstanceAccessProvider>
      <Probe />
      <Probe />
    </CloudInstanceAccessProvider>
  );
}
const access = () => screen.getAllByTestId('access')[0]!.textContent;

// Only the account starts a check: a bridge that is a new object on every read must not loop.
it('asks once per account, whatever the identity of the bridge', async () => {
  vi.stubGlobal('electronAPI', { get cloudSettings() { return { instanceAccess, instanceList }; } });
  render(content());
  await act(async () => {});
  expect(access()).toBe('allowed');
  expect(instanceAccess).toHaveBeenCalledTimes(1);
});

// Real provider + Main bridge substitute: covers permissions, read-only empty
// membership, account switch races and expiry, beyond link routing.
it.each(['local', 'signed-out'])('does not query CIS in %s mode', async (mode) => {
  auth.mode = mode;
  render(content());
  expect(access()).toBe('hidden');
  expect(instanceAccess).not.toHaveBeenCalled();
});

it.each(['CLOUD_SETTINGS_SCOPE_CHANGED', 'CLOUD_SETTINGS_UNAVAILABLE'])(
  'keeps all consumers hidden on %s and recovers on focus',
  async (code) => {
    instanceAccess.mockRejectedValueOnce(new Error(code));
    render(content());
    expect(access()).toBe('checking');
    await act(async () => {});
    expect(access()).toBe('hidden');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(access()).toBe('allowed'); // An admitted account may have no instances yet.
    expect(instanceAccess).toHaveBeenCalledTimes(2); // Shared across both consumers.
  },
);

it('discards an old account response and hides immediately on logout or generation change', async () => {
  let complete!: (value: { schemaVersion: 1; allowed: boolean }) => void;
  instanceAccess.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = render(content());
  auth.dataOwnerId = 'owner-b';
  auth.dataOwnerGeneration++;
  setDataOwnerGeneration(auth.dataOwnerId, auth.dataOwnerGeneration);
  instanceAccess.mockRejectedValueOnce(new Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
  view.rerender(content());
  expect(access()).toBe('checking');
  await act(async () => {});
  expect(access()).toBe('hidden');
  await act(async () => complete({ schemaVersion: 1, allowed: true }));
  expect(access()).toBe('hidden');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(access()).toBe('allowed');
  auth.dataOwnerGeneration++;
  setDataOwnerGeneration(auth.dataOwnerId, auth.dataOwnerGeneration);
  instanceAccess.mockImplementationOnce(() => new Promise(() => {}));
  view.rerender(content());
  expect(access()).toBe('checking');
  auth.mode = 'signed-out';
  auth.isAuthenticated = false;
  view.rerender(content());
  expect(access()).toBe('hidden');
});

it('rechecks visible permissions periodically and removes revoked access', async () => {
  vi.useFakeTimers();
  render(content());
  await act(async () => {});
  expect(access()).toBe('allowed');
  instanceAccess.mockRejectedValueOnce(new Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(access()).toBe('hidden');
});

// An allowed account whose recheck cannot reach the service keeps its pages, marked unverified,
// until the service answers again; a denial still removes them.
it('keeps an allowed account on its pages while a recheck cannot reach the service', async () => {
  vi.useFakeTimers();
  render(<CloudInstanceAccessProvider><Probe /><UnverifiedProbe /></CloudInstanceAccessProvider>);
  const unverified = () => screen.getByTestId('unverified').textContent;
  await act(async () => {});
  expect([access(), unverified()]).toEqual(['allowed', 'false']);
  instanceAccess.mockRejectedValue(new Error('[CLOUD_SETTINGS_UNAVAILABLE] timed out'));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect([access(), unverified()]).toEqual(['allowed', 'true']);
  instanceAccess.mockResolvedValue({ schemaVersion: 1, allowed: true });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect([access(), unverified()]).toEqual(['allowed', 'false']);
  instanceAccess.mockResolvedValue({ schemaVersion: 1, allowed: false });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect([access(), unverified()]).toEqual(['hidden', 'false']);
});

// Query only after Main has committed login and Renderer finished startup.
it.each(['isInitializing', 'canEnterApp'])(
  'waits for %s before fetching admission',
  async (field) => {
    if (field === 'isInitializing') auth.isInitializing = true;
    else auth.canEnterApp = false;
    const view = render(content());
    expect(access()).toBe('hidden');
    expect(instanceAccess).not.toHaveBeenCalled();
    auth.isInitializing = false;
    auth.canEnterApp = true;
    view.rerender(content());
    await act(async () => {});
    expect(access()).toBe('allowed');
    expect(instanceAccess).toHaveBeenCalledTimes(1);
  },
);
it('keeps a signed-in denied account hidden, without treating the response as permission', async () => {
  instanceAccess.mockResolvedValue({ schemaVersion: 1, allowed: false });
  render(content());
  await act(async () => {});
  expect(access()).toBe('hidden');
});
it('coalesces focus and visibility events without missing a later revocation', async () => {
  vi.useFakeTimers();
  render(content());
  await act(async () => {});
  for (const event of ['focus', 'focus', 'online']) {
    await act(async () => window.dispatchEvent(new Event(event)));
  }
  expect(instanceAccess).toHaveBeenCalledTimes(1);
  instanceAccess.mockResolvedValue({ schemaVersion: 1, allowed: false });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(access()).toBe('hidden');
  expect(instanceAccess).toHaveBeenCalledTimes(2);
});

// Both consumers must recover immediately after denied -> admitted -> denied,
// without waiting for focus or the one-minute permission refresh interval.
it('refreshes both entries on every account switch without reusing denied or allowed results', async () => {
  instanceAccess.mockResolvedValueOnce({ schemaVersion: 1, allowed: false });
  const view = render(content());
  await act(async () => {});
  expect(screen.getAllByTestId('access').map((node) => node.textContent)).toEqual([
    'hidden',
    'hidden',
  ]);
  for (const [owner, allowed] of [
    ['enterprise', true],
    ['personal', false],
    ['enterprise', true],
  ] as const) {
    let resolve!: (value: { schemaVersion: 1; allowed: boolean }) => void;
    instanceAccess.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    auth.dataOwnerId = owner;
    auth.dataOwnerGeneration++;
    setDataOwnerGeneration(owner, auth.dataOwnerGeneration);
    view.rerender(content());
    expect(screen.getAllByTestId('access').map((node) => node.textContent)).toEqual([
      'checking',
      'checking',
    ]);
    await act(async () => resolve({ schemaVersion: 1, allowed }));
    expect(screen.getAllByTestId('access').map((node) => node.textContent)).toEqual(
      allowed ? ['allowed', 'allowed'] : ['hidden', 'hidden'],
    );
  }
  expect(instanceAccess).toHaveBeenCalledTimes(4);
});

// Main can publish a committed owner just before releasing its transition fence.
// The first read then rejects even though the next read is authorized. No focus
// or visible-page polling event is guaranteed after the switch.
it('recovers from the account transition fence without focus, even while hidden', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  instanceAccess.mockRejectedValueOnce(new Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
  try {
    render(content());
    await act(async () => {});
    expect(access()).toBe('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getAllByTestId('access').map((node) => node.textContent)).toEqual([
      'allowed',
      'allowed',
    ]);
    expect(instanceAccess).toHaveBeenCalledTimes(2);
  } finally {
    visibility.mockRestore();
  }
});

it('does not retry an explicit denial and cancels the outgoing account retry', async () => {
  vi.useFakeTimers();
  instanceAccess.mockRejectedValueOnce(new Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
  const view = render(content());
  await act(async () => {});
  auth.dataOwnerId = 'denied-account';
  auth.dataOwnerGeneration++;
  setDataOwnerGeneration(auth.dataOwnerId, auth.dataOwnerGeneration);
  instanceAccess.mockResolvedValue({ schemaVersion: 1, allowed: false });
  view.rerender(content());
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(access()).toBe('hidden');
  expect(instanceAccess).toHaveBeenCalledTimes(2);
});

it('bounds failed-read retries and cancels them when unmounted', async () => {
  vi.useFakeTimers();
  instanceAccess.mockRejectedValue(new Error('CLOUD_SETTINGS_UNAVAILABLE'));
  const view = render(content());
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(access()).toBe('hidden');
  expect(instanceAccess).toHaveBeenCalledTimes(4);
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(instanceAccess).toHaveBeenCalledTimes(4);
});

// Ordinary clients: a window without the main window's cloud bridge, or a region whose Main
// has no cloud instance service, must not keep a periodic or focus-driven check running.
it('makes no check in a window without the cloud bridge', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('electronAPI', {});
  render(content());
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(access()).toBe('hidden');
  expect(instanceAccess).not.toHaveBeenCalled();
});

it('stops checking an account once Main reports no cloud instance service', async () => {
  vi.useFakeTimers();
  instanceAccess.mockRejectedValueOnce(
    new Error("Error invoking remote method: Error: [CLOUD_SETTINGS_UNSUPPORTED] No cloud instance service in this region"),
  );
  const view = render(content());
  await act(async () => {});
  expect(access()).toBe('hidden');
  await act(async () => vi.advanceTimersByTimeAsync(180_000));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(instanceAccess).toHaveBeenCalledTimes(1);

  // Another account asks once again.
  auth.dataOwnerId = 'owner-b';
  auth.dataOwnerGeneration++;
  setDataOwnerGeneration(auth.dataOwnerId, auth.dataOwnerGeneration);
  view.rerender(content());
  await act(async () => {});
  expect(instanceAccess).toHaveBeenCalledTimes(2);
  expect(access()).toBe('allowed');
});
