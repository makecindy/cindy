// @vitest-environment jsdom
// Renderer unit: a click on an old DAG question must not retry a newer terminal failure,
// even if both questions have the same text and subscription recovery yields asynchronously.
import { StrictMode, useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ErrorBanner } from '@/components/chat/ErrorBanner';
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), confirmThree: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', exists: () => false } }) }));
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDagFailedRetry, DagFailedRetryBridge, DagRetryAvailable, dagFailedRetryTarget } from '../DagFailedRetry';
import type { AgentInputProjection } from '../../../../shared/agentInputQueue';

const item = (clientId: string, source?: string) => ({ clientId, retrySourceClientId: source, text: 'same question' });
const state = (id = 'original', queued = false) => ({
  error: 'terminal', errorReason: null, errorPersistId: 'failure-1', errorRetryText: 'same question',
  inputRecovery: queued ? { kind: 'queue-head', clientId: id } : { kind: 'active-turn', item: item(id) },
  pendingQueue: queued ? [item(id)] : [], agentStatus: { isRunning: false },
} as Parameters<typeof dagFailedRetryTarget>[0]);
const projection = (head = item('clone', 'original')) => ({
  sessionId: 'branch', recovery: null, error: null, pendingQueue: [head],
} as AgentInputProjection);
function pause() {
  let resume!: () => void;
  const promise = new Promise<void>(r => { resume = r; });
  return { promise, resume };
}
function fixture() {
  const p = pause();
  const request = createDagFailedRetry('branch', 'original', () => current);
  let current = true, route = 'local';
  let snapshot = state();
  const prepare = vi.fn(async (dispatch: () => Promise<void>) => { await p.promise; await dispatch(); });
  const retry = vi.fn(async (observe: (p: AgentInputProjection) => void) => observe(projection()));
  function Pane({ visible = true, id = 'branch' }: { visible?: boolean; id?: string }) {
    const available = useRef(false);
    return <>
      <DagFailedRetryBridge id={id} request={request} withPreparedRetry={prepare} retry={retry}
        target={() => available.current ? dagFailedRetryTarget(snapshot, request.userMessageId, route) : null} />
      {visible && <DagRetryAvailable flag={available} />}
    </>;
  }
  return { Pane, request, p, prepare, retry, change: (v: ReturnType<typeof state>) => { snapshot = v; },
    reroute: () => { route = 'peer'; }, revoke: () => { current = false; } };
}
afterEach(cleanup);

it('retries once after native preparation, including StrictMode effect replay, without resending text', async () => {
  const { Pane, request, prepare, retry, p } = fixture();
  const page = render(<StrictMode><Pane /></StrictMode>);
  page.rerender(<StrictMode><Pane /></StrictMode>);
  expect(retry).not.toHaveBeenCalled();
  await act(async () => { p.resume(); expect(await request.receipt).toBe('accepted'); });
  expect(prepare).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledWith(expect.any(Function));
  expect(request.replacement).toBeUndefined();
});
it('reports only a verified manual replacement, preserving the original question across a second retry', async () => {
  const { Pane, request, retry, p, change } = fixture();
  const original = state();
  if (original.inputRecovery?.kind !== 'active-turn') throw new Error('expected active-turn fixture');
  change({ ...original, inputRecovery: { kind: 'active-turn', item: { ...original.inputRecovery.item,
    clientId: 'clone-1', retrySourceClientId: 'original', supersedesUserClientId: 'original' } } });
  retry.mockImplementation(async observe => {
    const receipt = projection(item('clone-2', 'original'));
    receipt.pendingQueue[0].supersedesUserClientId = 'clone-1';
    observe(receipt);
  });
  render(<Pane />); p.resume();
  expect(await request.receipt).toBe('accepted');
  expect(request.replacement).toEqual({ clientId: 'clone-2', source: 'original', replaces: 'clone-1' });
});
it.each(['no banner action', 'wrong pane', 'other question', 'wrong queue head'])(
  'rejects %s without preparing or waiting for a later matching failure', async reason => {
    const { Pane, request, prepare, change } = fixture();
    if (reason === 'other question') change(state('other'));
    if (reason === 'wrong queue head') change({ ...state('original', true), pendingQueue: state('other', true).pendingQueue });
    const page = render(<Pane visible={reason !== 'no banner action'} id={reason === 'wrong pane' ? 'other' : 'branch'} />);
    expect(await request.receipt).toBe('rejected');
    change(state()); page.rerender(<Pane />);
    expect(prepare).not.toHaveBeenCalled();
  });
it.each(['different question', 'replaced failure', 'closed pane', 'disabled button', 'route changed', 'revoked', 'cancelled'])(
  'rechecks after asynchronous native preparation: %s', async reason => {
    const { Pane, request, retry, p, change, reroute, revoke } = fixture();
    const page = render(<Pane />);
    if (reason === 'different question') change(state('other'));
    if (reason === 'replaced failure') change({ ...state(), errorPersistId: 'failure-2' });
    if (reason === 'closed pane') page.unmount();
    if (reason === 'disabled button') page.rerender(<Pane visible={false} />);
    if (reason === 'route changed') reroute();
    if (reason === 'revoked') revoke();
    if (reason === 'cancelled') request.cancel();
    p.resume();
    expect(await request.receipt).toBe('rejected');
    expect(retry).not.toHaveBeenCalled();
  });
it.each(['no evidence', 'unrelated', 'no-op', 'lost reply', 'cancelled in flight'])(
  'does not convert %s into success or dispatch a second retry', async reason => {
    const { Pane, request, retry, p } = fixture();
    retry.mockImplementation(async observe => {
      if (reason === 'unrelated') observe(projection(item('different', 'another')));
      if (reason === 'no-op') observe({ ...projection(), error: 'unchanged error' });
      if (reason === 'lost reply') throw new Error('disconnected');
      if (reason === 'cancelled in flight') { request.cancel(); observe(projection()); }
    });
    const page = render(<Pane />);
    p.resume();
    expect(await request.receipt).toBe(reason === 'no-op' ? 'rejected' : 'unknown');
    page.unmount(); render(<Pane />);
    expect(retry).toHaveBeenCalledOnce();
  });
it('exposes the native retry capability only for the enabled original-input action, never for continue', () => {
  const flag = { current: false };
  const native = vi.fn();
  const banner = (error: string, retryText: string | null, blocked = false) => <MemoryRouter>
    <ErrorBanner error={error} retryText={retryText} onRetry={native} onContinueAfterError={native}
      forkStripEncryptedRunning={blocked} nativeRetrySlot={<DagRetryAvailable flag={flag} />} />
  </MemoryRouter>;
  const page = render(banner('terminal', 'original'));
  expect(flag.current).toBe(true);
  page.rerender(banner('terminal', null));
  expect(flag.current).toBe(false);
  page.rerender(banner('thread not found', 'original'));
  expect(flag.current).toBe(false);
  page.rerender(banner('terminal', 'original', true));
  expect(flag.current).toBe(false);
  expect(native).not.toHaveBeenCalled();
});
it('requires the existing queue-head client ID in the authoritative receipt', async () => {
  const { Pane, request, retry, p, change } = fixture();
  change(state('original', true));
  retry.mockImplementation(async observe => observe(projection(item('original'))));
  render(<Pane />); p.resume();
  expect(await request.receipt).toBe('accepted');
});
