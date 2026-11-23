/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginReviewUpdate } from '../../../shared/pluginContributions';
import { PluginReviewUpdatesProvider, usePluginReviewUpdates } from '../PluginReviewUpdatesContext';

const harness = vi.hoisted(() => ({ owner: 'A', generation: 1, membershipKind: 'personal', read: vi.fn(), team: vi.fn(), mark: vi.fn(),
  windowHidden: null as ((hidden: boolean) => void) | null }));
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
  harness.team.mockReset().mockResolvedValue([]);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    pluginContributions: { reviewUpdates: harness.read, markReviewRead: harness.mark },
    pluginAuthor: { reviewUpdates: harness.team },
    onWindowHiddenChange: (callback: (hidden: boolean) => void) => { harness.windowHidden = callback; return () => {}; },
  } });
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
  // #1541 review: public and team results are read separately, so a slow or failing side must
  // neither delay nor clear the other. Minimal failing input: one side never settles.
  it('shows team results while the public read is pending, and public results while the team read is pending or failing', async () => {
    harness.membershipKind = 'org';
    let finishPublic!: (value: PluginReviewUpdate[]) => void;
    harness.read.mockImplementationOnce(() => new Promise(resolve => { finishPublic = resolve; }));
    harness.team.mockResolvedValueOnce([{ ...update, pluginId: 'team-plugin', key: 'org:team' }]);
    render(app());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('org:team'));
    await act(async () => { finishPublic([update]); });
    expect(screen.getByRole('status').textContent).toBe('approval,org:team');
    let finishTeam!: (value: PluginReviewUpdate[]) => void;
    harness.team.mockImplementationOnce(() => new Promise(resolve => { finishTeam = resolve; }));
    harness.read.mockResolvedValueOnce([{ ...update, key: 'rejection', status: 'rejected' }]);
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('rejection,org:team'));
    await act(async () => { finishTeam([]); });
    expect(screen.getByRole('status').textContent).toBe('rejection');
    harness.team.mockRejectedValueOnce(new Error('team offline'));
    harness.read.mockResolvedValueOnce([update]);
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('approval'));
  });
  it('does not read team results for a personal account', async () => {
    render(app());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('approval'));
    expect(harness.team).not.toHaveBeenCalled();
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
  // Greptile review on #12208: with background throttling off (a running turn or a voice call) a
  // hidden or minimized window still reports visibilityState 'visible'. Minimal failing input:
  // Main reports the window hidden, then the 60s poll fires — it must not read.
  it('does not read while Main reports the window hidden, and reads once when it is shown again', async () => {
    vi.useFakeTimers();
    harness.membershipKind = 'org';
    render(app());
    await act(async () => {});
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(harness.team).toHaveBeenCalledTimes(1);
    await act(async () => { harness.windowHidden?.(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(harness.team).toHaveBeenCalledTimes(1);
    await act(async () => { harness.windowHidden?.(false); });
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(harness.team).toHaveBeenCalledTimes(2);
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
