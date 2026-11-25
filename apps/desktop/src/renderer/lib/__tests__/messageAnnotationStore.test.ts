// @vitest-environment jsdom
// Regression: a focus read overtook a slow save and discarded its visible result.
// Unit: exercise the production cache with a deferred IPC write and owner switch.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { loadMessageAnnotations, updateMessageAnnotations, useMessageAnnotations } from '../messageAnnotationStore';
import { setDataOwnerGeneration } from '../../contexts/dataOwnerGeneration';
import type { MessageAnnotation, MessageAnnotationRequest } from '../../../shared/messageAnnotations';

afterEach(() => { cleanup(); setDataOwnerGeneration(null); vi.unstubAllGlobals(); });

it('keeps a slow saved annotation visible when focus requests a refresh', async () => {
  setDataOwnerGeneration('owner');
  const record: MessageAnnotation = { id: 'saved', sessionId: 'task', sentAt: null, ordinal: 1,
    messageClientId: 'answer', sourceVersion: 'version', start: 0, end: 5, quote: 'quote',
    prefix: '', suffix: '', comment: 'review', createdAt: 1 };
  let finish!: (rows: MessageAnnotation[]) => void;
  let queueChanged!: (projection: { sessionId: string }) => void;
  let stored: MessageAnnotation[] = [];
  const ipc = vi.fn(async (request: MessageAnnotationRequest) => request.action === 'list' ? stored
    : await new Promise<MessageAnnotation[]>(resolve => { finish = rows => { stored = rows; resolve(rows); }; }));
  vi.stubGlobal('electronAPI', { localDb: { messageAnnotations: ipc }, maker: {
    onInputProjection: (callback: typeof queueChanged) => { queueChanged = callback; return () => {}; },
  } });
  const { result } = renderHook(() => useMessageAnnotations('task'));
  await waitFor(() => expect(ipc).toHaveBeenCalledTimes(1));
  await act(async () => { await loadMessageAnnotations('task'); });
  ipc.mockClear();
  const save = updateMessageAnnotations({ action: 'add', sessionId: 'task', anchor: record, comment: record.comment });
  const refresh = loadMessageAnnotations('task');
  await act(async () => { await Promise.resolve(); });
  await act(async () => { finish([record]); await save; await refresh; });
  expect(result.current).toEqual([record]);
  await act(async () => { expect(await loadMessageAnnotations('task')).toEqual([record]); });
  stored = [{ ...record, queued: true }];
  await act(async () => { queueChanged({ sessionId: 'task' }); await loadMessageAnnotations('task'); });
  expect(result.current[0].queued).toBe(true);
  stored = [record];
  await act(async () => { queueChanged({ sessionId: 'task' }); await loadMessageAnnotations('task'); });
  expect(result.current[0].queued).toBeUndefined();
});

it('does not execute an old-owner queued operation after switching accounts', async () => {
  setDataOwnerGeneration('old');
  let finish!: (rows: MessageAnnotation[]) => void;
  const ipc = vi.fn(() => new Promise<MessageAnnotation[]>(resolve => { finish = resolve; }));
  vi.stubGlobal('electronAPI', { localDb: { messageAnnotations: ipc } });
  const first = loadMessageAnnotations('task');
  const second = updateMessageAnnotations({ action: 'remove', sessionId: 'task', id: 'old' });
  const outcomes = Promise.allSettled([first, second]);
  setDataOwnerGeneration('new');
  finish([]);
  expect((await outcomes).map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
  expect(ipc).toHaveBeenCalledTimes(1);
});
