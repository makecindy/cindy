import { expect, it, vi } from 'vitest';
import { filterCindyMakeSharedTasks } from '../cindyMakeFeature';

const task = { sessionId: 'task', hostDeviceId: 'offline-host', title: 'Share' };
const options = () => ({
  knownSession: vi.fn<(candidate: typeof task) => { id: string; source?: string | null } | undefined>(() => undefined),
  readSession: vi.fn<() => Promise<{ id: string; source?: string } | null>>(async () => null),
  isCurrent: vi.fn(() => true),
  onHiddenTask: vi.fn(async () => {}),
  onHiddenTaskError: vi.fn<(candidate: typeof task, error: unknown) => void>(),
});

it.each(['cindy-make', 'cindy-make-merge'])('hides a legacy share confirmed as %s by the old host', async source => {
  const reader = options();
  reader.readSession.mockResolvedValue({ id: task.sessionId, source });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.onHiddenTask).toHaveBeenCalledExactlyOnceWith(task);
});

it.each(['cindy-make', 'cindy-make-merge'])('uses the unfiltered cached %s source even with an offline host', async source => {
  const reader = options();
  reader.knownSession.mockReturnValue({ id: task.sessionId, source });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.readSession).not.toHaveBeenCalled();
  expect(reader.onHiddenTask).toHaveBeenCalledExactlyOnceWith(task);
});

it.each(['offline', 'missing', 'wrong-task'])('keeps an unconfirmed %s share hidden and retries on recovery', async reason => {
  const reader = options();
  if (reason === 'offline') reader.readSession.mockRejectedValueOnce(new Error('offline'));
  if (reason === 'wrong-task') reader.readSession.mockResolvedValueOnce({ id: 'other-task', source: 'desktop' });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.onHiddenTask).not.toHaveBeenCalled();
  reader.readSession.mockResolvedValue({ id: task.sessionId, source: 'desktop' });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([{ ...task, source: 'desktop' }]);
  expect(reader.onHiddenTask).not.toHaveBeenCalled();
});

it('confirms a matching legacy ordinary task whose successful metadata omits source', async () => {
  const reader = options();
  reader.knownSession.mockReturnValue({ id: task.sessionId });
  reader.readSession.mockResolvedValue({ id: task.sessionId });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([{ ...task, source: null }]);
  expect(reader.readSession).toHaveBeenCalledExactlyOnceWith(task);
  expect(reader.onHiddenTask).not.toHaveBeenCalled();
});

it('does not publish an old account response or start new reads after invalidation', async () => {
  const reader = options();
  let current = true;
  reader.isCurrent.mockImplementation(() => current);
  reader.readSession.mockImplementation(async () => { current = false; return { id: task.sessionId, source: 'desktop' }; });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  reader.readSession.mockClear();
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.readSession).not.toHaveBeenCalled();
  expect(reader.onHiddenTask).not.toHaveBeenCalled();
});

it('does not let a delayed read override newly arrived hidden source metadata', async () => {
  const reader = options();
  reader.readSession.mockImplementation(async () => {
    reader.knownSession.mockReturnValue({ id: task.sessionId, source: 'cindy-make' });
    return { id: task.sessionId, source: 'desktop' };
  });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.onHiddenTask).toHaveBeenCalledExactlyOnceWith(task);
});

it.each(['cached', 'remote'].flatMap(origin =>
  ['cindy-make', 'cindy-make-merge'].map(source => ({ origin, source })),
))('isolates $source cleanup failure from ordinary shares and retries it ($origin)', async ({ origin, source }) => {
  const reader = options();
  const ordinary = { ...task, sessionId: 'ordinary', title: 'Ordinary share' };
  reader.knownSession.mockImplementation(candidate => candidate.sessionId === ordinary.sessionId
    ? { id: ordinary.sessionId, source: 'desktop' }
    : origin === 'cached' ? { id: task.sessionId, source } : undefined);
  reader.readSession.mockResolvedValue({ id: task.sessionId, source });
  const failure = new Error('leave failed');
  reader.onHiddenTask.mockRejectedValueOnce(failure);
  const visible = [{ ...ordinary, source: 'desktop' }];
  expect(await filterCindyMakeSharedTasks([task, ordinary], reader)).toEqual(visible);
  expect(reader.onHiddenTaskError).toHaveBeenCalledExactlyOnceWith(task, failure);
  expect(await filterCindyMakeSharedTasks([task, ordinary], reader)).toEqual(visible);
  expect(reader.onHiddenTask).toHaveBeenCalledTimes(2);
  expect(reader.onHiddenTask).not.toHaveBeenCalledWith(ordinary);
  expect(reader.onHiddenTaskError).toHaveBeenCalledTimes(1);
});

it('keeps a failed hidden cleanup isolated even when diagnostics fail', async () => {
  const reader = options();
  reader.knownSession.mockReturnValue({ id: task.sessionId, source: 'cindy-make' });
  reader.onHiddenTask.mockRejectedValue(new Error('leave failed'));
  reader.onHiddenTaskError.mockImplementation(() => { throw new Error('diagnostics failed'); });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.onHiddenTaskError).toHaveBeenCalledTimes(1);
});

it('does not report cleanup failures for an invalidated account', async () => {
  const reader = options();
  reader.knownSession.mockReturnValue({ id: task.sessionId, source: 'cindy-make' });
  reader.onHiddenTask.mockImplementation(async () => {
    reader.isCurrent.mockReturnValue(false);
    throw new Error('leave failed');
  });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.onHiddenTaskError).not.toHaveBeenCalled();
});

it('does not revoke a membership identified after an account change', async () => {
  const reader = options();
  reader.readSession.mockImplementation(async () => {
    reader.isCurrent.mockReturnValue(false);
    return { id: task.sessionId, source: 'cindy-make' };
  });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.onHiddenTask).not.toHaveBeenCalled();
});
