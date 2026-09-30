// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePromptRecommendation } from '@/session/usePromptRecommendation';
import { createComposerDraftSource } from '@/session/composerDraftSource';
import { textComposerDocument } from '@/session/composerDocument';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let props: Parameters<typeof usePromptRecommendation>[0];
let value: ReturnType<typeof usePromptRecommendation>;
let request: ReturnType<typeof vi.fn>;
let sequence = 0;
function Probe() { value = usePromptRecommendation(props); return null; }
async function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(Probe)));
}
async function advance() { await act(async () => vi.advanceTimersByTimeAsync(500)); }
beforeEach(() => {
  vi.useFakeTimers();
  request = vi.fn().mockResolvedValue({ prompt: 'Suggested next step' });
  props = { ownerId: 'owner', deviceId: 'host', sessionId: `task-${++sequence}`, agentKind: 'codex',
    revision: 10, running: false, maker: { predictNextPrompt: request } };
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

it('historical navigation only requests a cached host result', async () => {
  await render(); await advance();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ cacheOnly: true, completionRevision: 10 }));
  expect(value.prompt).toBe('Suggested next step');
});

it.each(['queueEditing', 'hasAttachments', 'voiceIsBusy'] as const)(
  'defers prediction and hides retained results while %s is active', async (blocker) => {
  await render({ [blocker]: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  expect(value.prompt).toBeNull();
  await render({ [blocker]: false }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Suggested next step');
  await render({ [blocker]: true }); await advance();
  expect(value.prompt).toBeNull();
  await render({ [blocker]: false }); await advance();
  expect(value.prompt).toBe('Suggested next step');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['queueEditing', 'hasAttachments', 'voiceIsBusy'] as const)(
  'hides a prediction that resolves after %s begins', async (blocker) => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(); await advance();
  await render({ [blocker]: true });
  await act(async () => resolve({ prompt: 'Late suggestion' }));
  expect(value.prompt).toBeNull();
  await render({ [blocker]: false });
  expect(value.prompt).toBe('Late suggestion');
  expect(request).toHaveBeenCalledTimes(1);
});

it('waits for the new completion revision even when stopped arrives first', async () => {
  await render({ running: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ running: false }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
  await render({ revision: 20 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 20 }));
});

it('metadata refresh after opening cached history stays cache-only, including retries', async () => {
  request.mockResolvedValue({ prompt: null });
  await render(); await advance();
  await render({ revision: 20 }); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(request).toHaveBeenCalledTimes(5);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
});

it('an observed run authorizes only its completion, and a later run can predict again', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 20 }));
  await render({ revision: 30 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true, completionRevision: 30 }));
  await render({ running: true });
  await render({ running: false, revision: 40 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 40 }));
});

it('defers prediction during voice input and permits it after voice ends', async () => {
  await render({ running: true, voiceIsBusy: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ voiceIsBusy: false }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Suggested next step');
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('starting voice defers a scheduled request and retains an already pending result', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20 });
  await render({ voiceIsBusy: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ running: true, voiceIsBusy: false });
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: false, revision: 30 }); await advance();
  await render({ voiceIsBusy: true });
  await act(async () => resolve({ prompt: 'Retained suggestion' }));
  await render({ voiceIsBusy: false }); await advance();
  expect(value.prompt).toBe('Retained suggestion');
  expect(request).toHaveBeenCalledTimes(1);
});

it('dismissal or sending rejects late results and survives a page remount', async () => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(); await advance();
  await act(async () => value.dismiss());
  await act(async () => resolve({ prompt: 'Late suggestion' }));
  expect(value.prompt).toBeNull();
  await act(async () => root.render(null));
  await render(); await advance();
  expect(value.prompt).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('does not show a previous task result while changing task or running again', async () => {
  await render(); await advance();
  expect(value.prompt).toBeTruthy();
  await render({ sessionId: `${props.sessionId}-other` });
  expect(value.prompt).toBeNull();
  await advance();
  await render({ running: true });
  expect(value.prompt).toBeNull();
});

it('owner and device changes cannot reuse a dismissed revision or an old promise', async () => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(); await advance();
  await render({ ownerId: 'other', deviceId: 'other-host' });
  await act(async () => resolve({ prompt: 'Wrong owner' }));
  expect(value.prompt).toBeNull();
  await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('old hosts without the channel fail silently', async () => {
  request.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
  await render(); await advance();
  expect(value.prompt).toBeNull();
});

it('consumes terminal failures without predicting, but permits the next successful turn', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20, hasTerminalError: true });
  await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ hasTerminalError: false }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('defers an occupied completion until the draft is cleared', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument('My next question'));
  await render({ running: true, composerSource });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  // Draft occupancy is published on the next frame; let React commit it before
  // advancing the prediction's own debounce timer.
  await act(async () => vi.advanceTimersToNextFrame());
  await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Suggested next step');
});

it('defers attachment-only input and retains results arriving after input is added', async () => {
  await render({ hasAttachments: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ hasAttachments: false, running: true });
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: false, revision: 20 }); await advance();
  await render({ hasAttachments: true });
  await act(async () => resolve({ prompt: 'Retained suggestion' }));
  await render({ hasAttachments: false }); await advance();
  expect(value.prompt).toBe('Retained suggestion');
  expect(request).toHaveBeenCalledTimes(1);
});

it('retries a cache miss without promoting navigation to a paid request', async () => {
  request.mockResolvedValueOnce({ prompt: null });
  await render(); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
  expect(value.prompt).toBe('Suggested next step');
});

it('bounds cache retries and cancels them on dismissal', async () => {
  request.mockResolvedValue({ prompt: null });
  await render(); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(4);
  await render({ sessionId: props.sessionId + '-other' }); await advance();
  await act(async () => value.dismiss());
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(5);
});


it('finishes bounded cache retries while editing, then reuses the result after clearing', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  request.mockResolvedValueOnce({ prompt: null });
  await render({ composerSource }); await advance();
  await act(async () => composerSource.setDocument(textComposerDocument('Typing')));
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(value.prompt).toBe('Suggested next step');
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps retries bounded across repeated typing and clearing', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  request.mockResolvedValue({ prompt: null });
  await render({ composerSource }); await advance();
  for (let i = 0; i < 6; i++) {
    await act(async () => composerSource.setDocument(textComposerDocument('Typing')));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => composerSource.setDocument(textComposerDocument('')));
    await advance();
  }
  expect(request).toHaveBeenCalledTimes(4);
});

it('retains the same recommendation through typing, clearing and attachment changes without another request', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  await render({ composerSource }); await advance();
  await act(async () => composerSource.setDocument(textComposerDocument('My draft')));
  expect(value.prompt).toBe('Suggested next step'); // Presentation owns temporary hiding.
  await render({ hasAttachments: true });
  expect(value.prompt).toBeNull();
  await render({ hasAttachments: false });
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(value.prompt).toBe('Suggested next step');
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => value.dismiss());
  await act(async () => composerSource.setDocument(textComposerDocument('More typing')));
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(value.prompt).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it('retains a prediction arriving during editing without dispatching it twice', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: true, composerSource });
  await render({ running: false, revision: 20 }); await advance();
  await act(async () => composerSource.setDocument(textComposerDocument('Typing')));
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ prompt: 'Still relevant' }));
  expect(value.prompt).toBe('Still relevant');
});
