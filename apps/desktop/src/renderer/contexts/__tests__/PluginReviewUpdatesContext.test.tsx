/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginReviewUpdate } from '../../../shared/pluginContributions';
import { PluginReviewUpdatesProvider, usePluginReviewUpdates } from '../PluginReviewUpdatesContext';

const harness = vi.hoisted(() => ({ owner: 'A', generation: 1, membershipKind: 'personal', read: vi.fn(), mark: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({
  dataOwnerId: harness.owner, dataOwnerGeneration: harness.generation,
  user: { id: harness.owner, membershipKind: harness.membershipKind }, mode: 'cloud',
}) }));
const update: PluginReviewUpdate = { pluginId: 'plugin', key: 'approval', releaseId: 'release',
  version: '1.0.0', sha256: 'a'.repeat(64), revision: 'revision', status: 'approved', decidedAt: 'time', unread: true };
function Probe() {
  const { updates, refresh, markRead } = usePluginReviewUpdates();
  return <><output>{updates.filter(item => item.unread).map(item => item.key).join(',')}</output>
    <button onClick={() => void refresh()}>refresh</button>
    <button onClick={() => void markRead('plugin', 'approval')}>read result</button></>;
}
const app = () => <PluginReviewUpdatesProvider><Probe /></PluginReviewUpdatesProvider>;
beforeEach(() => {
  harness.owner = 'A'; harness.generation = 1; harness.membershipKind = 'personal';
  harness.read.mockReset().mockResolvedValue([update]); harness.mark.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { pluginContributions: { reviewUpdates: harness.read, markReviewRead: harness.mark } } });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('in-app review result indicators', () => {
  it.each(['personal', 'org'])('preserves unread %s results offline and after failed acknowledgement, then only clears the exact result', async membershipKind => {
    harness.membershipKind = membershipKind;
    render(app());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('approval'));
    expect(harness.mark).not.toHaveBeenCalled();
    harness.read.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByText('refresh'));
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toBe('approval');
    harness.mark.mockRejectedValueOnce(new Error('disk unavailable'));
    fireEvent.click(screen.getByText('read result'));
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toBe('approval');
    fireEvent.click(screen.getByText('read result'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(''));
    // A poll started before/after acknowledgement must not resurrect that same decision.
    fireEvent.click(screen.getByText('refresh'));
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toBe('');
    harness.read.mockResolvedValueOnce([{ ...update, key: 'rejection', status: 'rejected' }]);
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('rejection'));
  });
  it('hides previous-account results immediately and ignores its late response', async () => {
    let finish!: (value: PluginReviewUpdate[]) => void;
    harness.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(app());
    harness.owner = 'B'; harness.generation++;
    harness.read.mockResolvedValueOnce([{ ...update, key: 'B-result' }]);
    view.rerender(app());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('B-result'));
    await act(async () => { finish([update]); });
    expect(screen.getByRole('status').textContent).toBe('B-result');
  });
  it('polls while foregrounded and refreshes when returning online without acknowledging a list', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    render(app());
    await act(async () => {});
    expect(harness.read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(harness.read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(harness.read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(harness.read).toHaveBeenCalledTimes(3);
    expect(harness.mark).not.toHaveBeenCalled();
  });
});
