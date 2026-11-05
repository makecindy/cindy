// @vitest-environment jsdom
import { act, createElement as el, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
// Unit: a completed turn must not hide records the reader opened, including after
// virtualized remount. Exercise the production shell and its shared disclosure memory.
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => el('div', null, children),
  Pressable: ({ children, onPress, accessibilityState, accessibilityLabel }: any) => el('button', {
    onClick: onPress, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded,
  }, children),
  ActivityIndicator: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: { create: (v: unknown) => v },
  Animated: { View: ({ children }: any) => el('span', null, children),
    Value: class { interpolate() { return '0deg'; } }, timing: () => ({ start(done?: (result: { finished: boolean }) => void) { done?.({ finished: true }); }, stop() {} }) },
}));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, Layers: () => null, Sparkles: () => null, Terminal: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
const history = vi.hoisted(() => ({ invoke: vi.fn(), generation: 1, subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined) }));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: history.generation }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: history.invoke, subscribe: history.subscribe, unsubscribe: history.unsubscribe }) }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress }, 'Retry') }));
vi.mock('@/session/BotGroupMessageText', () => ({ BotGroupMarkdownText: ({ content }: any) => el('p', null, content) }));
// Adapt native rows/viewers; keep the real payload builder, normalization,
// callbacks and disclosure state so this checks the group-to-viewer handoff.
vi.mock('@/session/MessageRenderer', async () => {
  const { buildToolResultPayload } = await import('@/session/messagePayload');
  return {
    WorkToolActivityRow: ({ activity, actions }: any) => el('div', null,
    el('p', null, activity.message.normalized.label, activity.toolResult),
    el('button', { disabled: !actions.onOpenPayload, onClick: () => actions.onOpenPayload?.(buildToolResultPayload(activity.message.normalized)) }, 'View full output')),
    MessagePayloadModal: ({ payload, onClose }: any) => payload ? el('div', { role: 'dialog' }, payload.body, el('button', { onClick: onClose }, 'Close output')) : null,
  };
});
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { BotGroupProcess, BotGroupProcessEntries } from '@/session/BotGroupProcess';
import { TeammateProcess } from '@/session/TeammateProcess';
import { __test_internals as memory } from '@/session/expandedBlockMemory';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, node: HTMLDivElement;
beforeEach(() => { history.invoke.mockReset(); history.generation = 1; remoteSessionStore.clear(); memory.reset(); node = document.createElement('div'); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const header = () => node.querySelector('button')!;
async function show(running: boolean) {
  await act(async () => root.render(el(TeammateProcess, { id: 'turn', title: running ? 'Reading feedback' : 'Progress', running,
    children: [el('p', { key: 'note' }, 'Found the cause'), el(TeammateProcess, { key: 'records', id: 'records', secondary: true, title: 'Activity log', children: 'First tool details' })],
  })));
}
it('shows live notes, collapses uninspected work on completion, and can restore every note', async () => {
  await show(true); expect(node.textContent).toContain('Found the cause');
  await show(false); expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(node.textContent).not.toContain('Found the cause');
  await act(async () => header().click()); expect(node.textContent).toContain('Found the cause');
});
it('keeps a turn open when its inner activity log was inspected, including remount', async () => {
  await show(true);
  await act(async () => node.querySelectorAll('button')[1]!.click());
  await show(false); expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('First tool details');
  await act(async () => root.render(null)); await show(false);
  expect(header().getAttribute('aria-expanded')).toBe('true'); expect(node.textContent).toContain('First tool details');
});
it('respects a manual collapse while live status and completion change', async () => {
  await show(true); await act(async () => header().click());
  await show(false); expect(header().getAttribute('aria-expanded')).toBe('false');
  await show(true); expect(header().getAttribute('aria-expanded')).toBe('false');
});

const process = { groupId: 'group', executionId: 'mobile-history', sessionId: 'lane', clientId: 'source' };
const group = () => el(BotGroupProcess, { process, owned: true, deviceId: 'mac' });
const meta = { botPrivateReply: true, botGroupLane: true };
const source = { clientId: 'source', role: 'user', content: 'Request' };
const final = { clientId: 'final', role: 'assistant', content: 'Final answer', agentMeta: { ...meta, turnCompleted: true } };

it('does not offer an empty group disclosure before or after its deferred read completes', async () => {
  let finish!: (rows: unknown[]) => void;
  history.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(group()));
  expect(header()).toBeNull();
  expect(history.invoke).toHaveBeenCalledTimes(1);
  await act(async () => finish([source, final]));
  expect(header()).toBeNull();
});

it('keeps group notes and tool details available through collapse and historical remount', async () => {
  history.invoke.mockResolvedValue([source,
    { clientId: 'note', role: 'assistant', content: 'Stage note', agentMeta: { ...meta, assistantPhase: 'commentary' } },
    { clientId: 'tool', role: 'tool_use', content: { toolName: 'Read', input: { file_path: '/repo/notes.md' } }, agentMeta: meta },
    { clientId: 'result', role: 'tool_result', content: 'Saved tool result', toolUseId: 'tool', agentMeta: meta }, final]);
  await act(async () => root.render(group()));
  expect(header().getAttribute('aria-expanded')).toBe('false');
  const reads = history.invoke.mock.calls.length;
  await act(async () => header().click());
  expect(node.textContent).toContain('Stage note');
  await act(async () => node.querySelectorAll('button')[1]!.click());
  expect(node.textContent).toContain('Saved tool result');
  await act(async () => header().click());
  await act(async () => header().click());
  expect(node.textContent).toContain('Saved tool result');
  expect(history.invoke).toHaveBeenCalledTimes(reads);
  await act(async () => root.render(null));
  await act(async () => root.render(group()));
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('Saved tool result');
  expect(node.textContent).not.toContain('Final answer');
});

it('keeps missing group history retryable and does not remove the heading on retry', async () => {
  history.invoke.mockResolvedValueOnce([]);
  await act(async () => root.render(group()));
  await act(async () => header().click());
  expect(node.textContent).toContain('Retry');
  history.invoke.mockResolvedValue([source, { clientId: 'note', role: 'assistant', content: 'Recovered note', agentMeta: { assistantPhase: 'commentary' } }, final]);
  await act(async () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'Retry')!.click());
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('Recovered note');
});

// Exercise the real group live/history component swap with the same policies
// tested above for private chat: auto-collapse unless the owner inspected it.
it.each(['automatic', 'inspected', 'collapsed'] as const)('uses private-chat completion policy for %s group work', async mode => {
  const messages = [source,
    { clientId: 'note', role: 'assistant', content: 'Live stage', agentMeta: { ...meta, assistantPhase: 'commentary' } },
    { clientId: 'tool', role: 'tool_use', content: { toolName: 'Read', input: { file_path: '/repo/notes.md' } }, agentMeta: meta }];
  history.invoke.mockResolvedValue([...messages, final]);
  await act(async () => root.render(el(TeammateProcess, { id: `group-process:${process.executionId}`, title: 'Working', running: true,
    children: el(BotGroupProcessEntries, { messages, id: `group-process:${process.executionId}`, running: true }) })));
  expect(header().getAttribute('aria-expanded')).toBe('true');
  if (mode === 'inspected') await act(async () => node.querySelectorAll('button')[1]!.click());
  if (mode === 'collapsed') await act(async () => header().click());
  await act(async () => root.render(group()));
  expect(header().getAttribute('aria-expanded')).toBe(mode === 'inspected' ? 'true' : 'false');
  await act(async () => header().click());
  expect(header()).not.toBeNull();
});

// Extended acceptance: different executions and owners must never receive a
// delayed response from the history that was visible before the switch.
it.each(['execution', 'account'] as const)('ignores an old history response after switching %s', async boundary => {
  let finishOld!: (rows: unknown[]) => void;
  history.invoke.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await act(async () => root.render(group()));
  history.invoke.mockResolvedValue([source,
    { clientId: 'new-note', role: 'assistant', content: 'Current execution note', agentMeta: { ...meta, assistantPhase: 'commentary' } }, final]);
  if (boundary === 'account') history.generation++;
  const current = boundary === 'execution' ? { ...process, executionId: 'next-execution', clientId: 'source' } : process;
  await act(async () => root.render(el(BotGroupProcess, { process: current, owned: true, deviceId: 'mac' })));
  await act(async () => header().click());
  expect(node.textContent).toContain('Current execution note');
  await act(async () => finishOld([source,
    { clientId: 'old-note', role: 'assistant', content: 'Stale previous note', agentMeta: { ...meta, assistantPhase: 'commentary' } }, final]));
  expect(node.textContent).toContain('Current execution note');
  expect(node.textContent).not.toContain('Stale previous note');
});

it('recovers an offline history read using retry without removing its disclosure', async () => {
  history.invoke.mockRejectedValueOnce(new Error('DEVICE_OFFLINE'));
  await act(async () => root.render(group()));
  await act(async () => header().click());
  expect(node.textContent).toContain('Retry');
  history.invoke.mockResolvedValue([source,
    { clientId: 'online-note', role: 'assistant', content: 'Restored after reconnection', agentMeta: { ...meta, assistantPhase: 'commentary' } }, final]);
  await act(async () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'Retry')!.click());
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('Restored after reconnection');
});

it('restores a persisted late tool result after leaving and returning to history', async () => {
  const rows: import('@cindy/maker-shared/botGroupChat').BotGroupProcessMessage[] = [source,
    { clientId: 'tool', role: 'tool_use', toolUseId: 'tool', content: { toolName: 'Read', input: { file_path: '/repo/notes.md' } }, agentMeta: meta }, final];
  history.invoke.mockImplementation(async () => [...rows]);
  await act(async () => root.render(group()));
  await act(async () => header().click());
  await act(async () => node.querySelectorAll('button')[1]!.click());
  expect(node.textContent).not.toContain('Late persisted result');
  rows.push({ clientId: 'result', role: 'tool_result', content: 'Late persisted result', toolUseId: 'tool', agentMeta: meta });
  await act(async () => root.render(null));
  await act(async () => root.render(group()));
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('Late persisted result');
});

it('updates an open history from a persisted tool result without remounting', async () => {
  vi.useFakeTimers();
  const rows: import('@cindy/maker-shared/botGroupChat').BotGroupProcessMessage[] = [source,
    { clientId: 'tool', role: 'tool_use', toolUseId: 'tool', content: { toolName: 'Read', input: { file_path: '/repo/notes.md' } }, agentMeta: meta }, final];
  history.invoke.mockImplementation(async () => [...rows]);
  await act(async () => root.render(group()));
  await act(async () => header().click());
  await act(async () => node.querySelectorAll('button')[1]!.click());
  const result = { id: 'result', clientId: 'result', sessionId: process.sessionId, role: 'tool_result' as const,
    content: 'Result delivered while open', toolUseId: 'tool', agentMeta: meta, createdAt: new Date().toISOString() };
  rows.push(result);
  await act(async () => {
    remoteSessionStore.applyRemotePush('mac', 'local-db:messages:created', { sessionId: process.sessionId, message: result });
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('Result delivered while open');
});


it.each([false, true])('opens and closes the complete tool payload (running=%s)', async running => {
  const output = 'Long tool output\n'.repeat(80) + 'END OF COMPLETE RESULT';
  await act(async () => root.render(el(BotGroupProcessEntries, { id: 'payload-turn', running, messages: [source,
    { clientId: 'tool', role: 'tool_use', toolUseId: 'tool', content: { toolName: 'Read', input: { file_path: '/repo/notes.md' } }, agentMeta: meta },
    { clientId: 'result', role: 'tool_result', toolUseId: 'tool', content: output, agentMeta: meta }, final] })));
  await act(async () => header().click());
  const open = Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'View full output')!;
  expect(open.disabled).toBe(false);
  await act(async () => open.click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain(output);
  await act(async () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'Close output')!.click());
  expect(node.querySelector('[role="dialog"]')).toBeNull();
});

it('stops refreshing a historical turn after seeing the next input', async () => {
  vi.useFakeTimers();
  history.invoke.mockResolvedValue([source,
    { clientId: 'note', role: 'assistant', content: 'Closed turn note', agentMeta: { assistantPhase: 'commentary' } }, final,
    { clientId: 'next-input', role: 'user', content: 'Next request' }]);
  await act(async () => root.render(group()));
  const reads = history.invoke.mock.calls.length;
  await act(async () => {
    remoteSessionStore.applyRemotePush('mac', 'local-db:messages:created', { sessionId: process.sessionId,
      message: { id: 'new-work', clientId: 'new-work', sessionId: process.sessionId, role: 'thinking', content: '', createdAt: new Date().toISOString() } });
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(history.invoke).toHaveBeenCalledTimes(reads);
});
