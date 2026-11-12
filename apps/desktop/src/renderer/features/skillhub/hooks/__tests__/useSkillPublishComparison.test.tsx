// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SkillhubPublishComparison } from '../../../../../shared/skillhubPublishComparison';

let useSkillPublishComparison: typeof import('../useSkillPublishComparison').useSkillPublishComparison;
let invalidatePublishComparison: typeof import('../useSkillPublishComparison').invalidatePublishComparison;
let setDataOwnerGeneration: typeof import('@/contexts/dataOwnerGeneration').setDataOwnerGeneration;
const comparePublished = vi.fn();
const skill = (name = 'demo') => ({ id: name, kind: 'skill', absolutePath: '/skills/' + name, registryEntry: null }) as SkillhubSkill;
const same: SkillhubPublishComparison = { status: 'same', version: '1.0.0', pending: false };
const different: SkillhubPublishComparison = { status: 'different', version: '1.0.0', pending: false };

beforeEach(async () => {
  vi.resetModules();
  comparePublished.mockReset().mockResolvedValue(same);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { skillhub: { comparePublished } } });
  ({ setDataOwnerGeneration } = await import('@/contexts/dataOwnerGeneration'));
  setDataOwnerGeneration('owner-a', 1);
  ({ useSkillPublishComparison, invalidatePublishComparison } = await import('../useSkillPublishComparison'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('reuses fresh focus reads, then refreshes after expiry or local mutation without polling', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const hook = renderHook(() => useSkillPublishComparison(skill()));
  await waitFor(() => expect(hook.result.current.comparison).toEqual(same));
  comparePublished.mockResolvedValue(different);
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(hook.result.current.comparison).toEqual(same));
  expect(comparePublished).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(131_000);
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(hook.result.current.comparison).toEqual(different));
  comparePublished.mockResolvedValue(same);
  act(() => invalidatePublishComparison('/skills/demo'));
  await waitFor(() => expect(hook.result.current.comparison).toEqual(same));
  expect(comparePublished).toHaveBeenCalledTimes(3);
});

it('deduplicates concurrent and StrictMode consumers', async () => {
  let resolve!: (value: SkillhubPublishComparison) => void;
  comparePublished.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const first = renderHook(() => useSkillPublishComparison(skill()), { wrapper: StrictMode });
  const second = renderHook(() => useSkillPublishComparison(skill()));
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(1));
  act(() => resolve(different));
  await waitFor(() => expect(first.result.current.comparison).toEqual(different));
  expect(second.result.current.comparison).toEqual(different);
});

it('bounds concurrent scans for a large local list', async () => {
  const resolves: Array<(value: SkillhubPublishComparison) => void> = [];
  comparePublished.mockImplementation(() => new Promise((done) => { resolves.push(done); }));
  for (let n = 0; n < 5; n++) renderHook(() => useSkillPublishComparison(skill(String(n))));
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(3));
  act(() => resolves[0](same));
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(4));
  act(() => resolves[1](same));
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(5));
  await act(async () => resolves.forEach((resolve) => resolve(same)));
});

it('drops stale results after switching skill, refreshing or changing accounts', async () => {
  let stale!: (value: SkillhubPublishComparison) => void;
  comparePublished.mockImplementationOnce(() => new Promise((done) => { stale = done; }));
  const hook = renderHook(({ name }) => useSkillPublishComparison(skill(name)), { initialProps: { name: 'old' } });
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(1));
  setDataOwnerGeneration('owner-b', 2);
  hook.rerender({ name: 'new' });
  await waitFor(() => expect(hook.result.current.comparison).toEqual(same));
  await act(async () => stale(different));
  expect(hook.result.current.comparison).toEqual(same);
});

it('maps both rejected IPC and error envelopes to unavailable, never clean', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  comparePublished.mockRejectedValueOnce(new Error('offline'));
  const hook = renderHook(() => useSkillPublishComparison(skill()));
  await waitFor(() => expect(hook.result.current.comparison.status).toBe('unavailable'));
  clock.mockReturnValue(131_000);
  comparePublished.mockResolvedValueOnce({ success: false, error: 'grant revoked' });
  act(() => invalidatePublishComparison());
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(hook.result.current.comparison.status).toBe('unavailable'));
});


it('cancels queued comparisons when their last consumer leaves', async () => {
  const resolves: Array<(value: SkillhubPublishComparison) => void> = [];
  comparePublished.mockImplementation(() => new Promise((done) => { resolves.push(done); }));
  const hooks = Array.from({ length: 20 }, (_, n) => renderHook(() => useSkillPublishComparison(skill(String(n)))));
  await waitFor(() => expect(comparePublished).toHaveBeenCalledTimes(3));
  hooks.forEach((hook) => hook.unmount());
  await act(async () => resolves.forEach((resolve) => resolve(same)));
  expect(comparePublished).toHaveBeenCalledTimes(3);
});

it('shares fresh results across navigation but not across account generations', async () => {
  const first = renderHook(() => useSkillPublishComparison(skill()));
  await waitFor(() => expect(first.result.current.comparison).toEqual(same));
  first.unmount();
  const second = renderHook(() => useSkillPublishComparison(skill()));
  await waitFor(() => expect(second.result.current.comparison).toEqual(same));
  expect(comparePublished).toHaveBeenCalledTimes(1);
  second.unmount();
  setDataOwnerGeneration('owner-b', 2);
  const third = renderHook(() => useSkillPublishComparison(skill()));
  await waitFor(() => expect(third.result.current.comparison).toEqual(same));
  expect(comparePublished).toHaveBeenCalledTimes(2);
});

it('stops draining network requests after failure and permits a later focus retry', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  comparePublished.mockResolvedValue({ status: 'unavailable', reason: 'service' });
  const hooks = Array.from({ length: 20 }, (_, n) => renderHook(() => useSkillPublishComparison(skill(String(n)))));
  await waitFor(() => expect(hooks.every((hook) => hook.result.current.comparison.status === 'unavailable')).toBe(true));
  expect(comparePublished).toHaveBeenCalledTimes(3);
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(hooks.every((hook) => hook.result.current.comparison.status === 'unavailable')).toBe(true));
  expect(comparePublished).toHaveBeenCalledTimes(3);
  hooks.slice(1).forEach((hook) => hook.unmount());
  comparePublished.mockResolvedValue(same);
  clock.mockReturnValue(131_000);
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(hooks[0].result.current.comparison).toEqual(same));
  expect(comparePublished).toHaveBeenCalledTimes(4);
});


it('keeps a local comparison failure isolated and retries repaired content immediately', async () => {
  const broken = skill('broken');
  comparePublished.mockImplementation(async ({ skillId }) => skillId === broken.id ? { status: 'unavailable' } : same);
  const first = renderHook(() => useSkillPublishComparison(broken));
  const healthy = Array.from({ length: 6 }, (_, n) => renderHook(() => useSkillPublishComparison(skill(String(n)))));
  await waitFor(() => expect(first.result.current.comparison.status).toBe('unavailable'));
  await waitFor(() => expect(healthy.every((hook) => hook.result.current.comparison.status === 'same')).toBe(true));
  expect(comparePublished).toHaveBeenCalledTimes(7);
  comparePublished.mockResolvedValue(same);
  act(() => invalidatePublishComparison(broken.absolutePath));
  await waitFor(() => expect(first.result.current.comparison).toEqual(same));
  expect(comparePublished).toHaveBeenCalledTimes(8);
});
