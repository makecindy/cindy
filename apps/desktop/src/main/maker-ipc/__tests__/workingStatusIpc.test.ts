import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@cindy/maker-core';
const h = vi.hoisted(() => ({
  handler: null as null | ((event: unknown, request: unknown) => Promise<{ text: string | null }>),
  request: vi.fn(), trust: vi.fn(), session: null as any,
  owner: 'owner', chain: 'chain', locale: 'zh-CN', boundary: false,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (_channel: string, handler: typeof h.handler) => { h.handler = handler; } } }));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({ getSession: () => h.session }) }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: h.trust }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.request }));
vi.mock('../../utility-model/resolveAuxiliaryModelChain.js', () => ({ getEffectiveAuxiliaryModelChainSnapshot: () => h.chain }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.owner, isAppSessionBoundaryPending: () => h.boundary }));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => h.locale }));
import { registerWorkingStatusIpc } from '../workingStatus.js';
let listeners: Set<(event: AgentEvent) => void>;
const invoke = (phase = 'reading-memory') => h.handler!({}, { sessionId: 'test', phase, locale: 'zh-CN' });
const emit = (type: AgentEvent['type'], data: unknown = {}, metadata: Partial<AgentEvent> = {}) => { for (const listener of [...listeners]) listener({ type, data, ...metadata }); };
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 'owner'; h.chain = 'chain'; h.locale = 'zh-CN'; h.boundary = false;
  listeners = new Set();
  h.session = {
    isTurnRunning: () => true, getTurnGeneration: () => 1,
    onEvent: (listener: (e: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    onStatusChange: () => () => {},
  };
  registerWorkingStatusIpc();
  h.request.mockResolvedValue({ ok: true, text: '翻翻之前记下的事…' });
});
it('calls the configured utility path with public facts only and deduplicates phase requests', async () => {
  expect(await invoke()).toEqual({ text: '翻翻之前记下的事…' });
  expect(await invoke()).toEqual({ text: '翻翻之前记下的事…' });
  expect(h.request).toHaveBeenCalledTimes(1);
  const [, prompt, opts] = h.request.mock.calls[0];
  expect(JSON.parse(prompt)).toEqual({ language: 'zh-CN', execution: 'Reading or searching saved long-term memory. Its content is unknown.', previousCaption: null });
  expect(opts.systemPrompt).toContain('never completion');
  expect(await opts.beforeDispatch()).toBe(true);
  h.chain = 'changed';
  expect(await opts.beforeDispatch()).toBe(false);
});
it.each(['done', 'error', 'status'] as const)('aborts on %s, removes listeners and discards late results', async (type) => {
  let resolve!: (v: unknown) => void;
  h.request.mockReturnValue(new Promise((r) => { resolve = r; }));
  const result = invoke();
  await Promise.resolve();
  const opts = h.request.mock.calls[0][2];
  emit(type, type === 'status' ? { isRunning: false } : {});
  expect(opts.signal.aborted).toBe(true);
  expect(listeners.size).toBe(0);
  resolve({ ok: true, text: '翻翻之前记下的事…' });
  expect(await result).toEqual({ text: null });
});
it('cancels on real phase changes and human interaction, without reading event content', async () => {
  let resolve!: (v: unknown) => void;
  h.request.mockReturnValue(new Promise((r) => { resolve = r; }));
  const result = invoke();
  await Promise.resolve();
  emit('tool_use', { toolName: 'bot_memory', input: { action: 'write', body: 'PRIVATE' } });
  expect(h.request.mock.calls[0][2].signal.aborted).toBe(true);
  emit('interaction_request', {});
  resolve({ ok: true, text: '迟到文案' });
  expect(await result).toEqual({ text: null });
});
it('rejects untrusted callers and arbitrary material before model dispatch', async () => {
  await expect(h.handler!({}, { sessionId: 'test', phase: 'thinking', body: 'PRIVATE' })).rejects.toThrow();
  h.trust.mockImplementationOnce(() => { throw new Error('untrusted'); });
  await expect(invoke()).rejects.toThrow('untrusted');
  expect(h.request).not.toHaveBeenCalled();
});
it('does not request when idle, and drops a result after owner changes', async () => {
  h.session.isTurnRunning = () => false;
  expect(await invoke()).toEqual({ text: null });
  h.session.isTurnRunning = () => true;
  h.request.mockImplementation(async () => { h.owner = 'other'; return { ok: true, text: '翻翻之前记下的事…' }; });
  expect(await invoke()).toEqual({ text: null });
});

it('preserves the memory matter after tool result and subsequent reasoning', async () => {
  await invoke();
  emit('tool_use', { toolUseId: 't', toolName: 'bot_memory', input: { action: 'write' } });
  emit('tool_result', { toolUseId: 't' });
  let resolve!: (value: unknown) => void;
  h.request.mockReturnValue(new Promise((r) => { resolve = r; }));
  const result = invoke('reviewing-memory');
  await Promise.resolve();
  const opts = h.request.mock.calls.at(-1)![2];
  emit('thinking', { text: 'PRIVATE' });
  expect(opts.signal.aborted).toBe(false);
  resolve({ ok: true, text: '核对这条记忆…' });
  expect(await result).toEqual({ text: '核对这条记忆…' });
});
it('keeps generic fallback without spending a model call', async () => {
  for (const phase of ['processing', 'thinking', 'replying']) expect(await invoke(phase)).toEqual({ text: null });
  expect(h.request).not.toHaveBeenCalled();
});

it('preserves in-flight copy and the product-turn cache across claimed SDK boundaries', async () => {
  let resolve!: (value: unknown) => void;
  h.request.mockReturnValue(new Promise((r) => { resolve = r; }));
  const pending = invoke();
  await Promise.resolve();
  const opts = h.request.mock.calls[0][2];
  emit('status', { isRunning: false, status: 'Done' }, { turnContinuationId: 0 });
  emit('done', {}, { turnContinuationId: 0 });
  expect(opts.signal.aborted).toBe(false);
  expect(listeners.size).toBe(1);
  resolve({ ok: true, text: '翻翻之前记下的事…' });
  expect(await pending).toEqual({ text: '翻翻之前记下的事…' });
  emit('status', { isRunning: true, status: 'Working' });
  emit('tool_use', { toolName: 'bot_memory', input: { action: 'read' } });
  expect(await invoke()).toEqual({ text: '翻翻之前记下的事…' });
  expect(h.request).toHaveBeenCalledTimes(1);
  emit('done');
  expect(listeners.size).toBe(0);
  h.session.getTurnGeneration = () => 2;
  expect(await invoke()).toEqual({ text: '翻翻之前记下的事…' });
  expect(h.request).toHaveBeenCalledTimes(2);
});

it.each(['done', 'error', 'status'] as const)('still cancels at product %s after an SDK continuation boundary', async (type) => {
  let resolve!: (value: unknown) => void;
  h.request.mockReturnValue(new Promise((r) => { resolve = r; }));
  const pending = invoke();
  await Promise.resolve();
  emit('done', {}, { turnContinuationId: 1 });
  const opts = h.request.mock.calls[0][2];
  expect(opts.signal.aborted).toBe(false);
  emit(type, type === 'status' ? { isRunning: false, status: 'Stopped' } : {});
  expect(opts.signal.aborted).toBe(true);
  expect(listeners.size).toBe(0);
  resolve({ ok: true, text: '翻翻之前记下的事…' });
  expect(await pending).toEqual({ text: null });
});
