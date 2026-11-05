// @vitest-environment jsdom
import { act, createElement as el, useEffect, useState, type ReactNode } from 'react';
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
const history = vi.hoisted(() => ({ invoke: vi.fn(), generation: 1, subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined), toolActions: undefined as any, resolveMedia: vi.fn(async (media: any) => ({ url: 'https://media.invalid/resolved', mimeType: media.kind === 'video' ? 'video/mp4' : 'image/png' })), mediaDevice: '' }));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: history.generation }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: history.invoke, subscribe: history.subscribe, unsubscribe: history.unsubscribe }) }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress }, 'Retry') }));
vi.mock('@/session/BotGroupMessageText', () => ({ BotGroupMarkdownText: ({ content }: any) => el('p', null, content) }));
vi.mock('@/session/useBotGroupRemoteMedia', () => ({ useBotGroupRemoteMedia: (device: string) => { history.mediaDevice = device; return history.resolveMedia; } }));
// Only adapt the native viewer. Exercise the group callback and its resolver
// handoff, not a fake claim that native image/video decoding was tested.
vi.mock('@/session/ImageLightbox', () => ({ ImageLightbox: ({ images, onResolveRemoteMedia, onClose }: any) => {
  const [uri, setUri] = useState('');
  useEffect(() => {
    void onResolveRemoteMedia?.(images[0].payload.media, { front: true }).then((value: any) => setUri(value.url));
  }, [images, onResolveRemoteMedia]);
  return el('div', { 'data-testid': 'process-lightbox', 'data-url': uri }, el('button', { onClick: onClose }, 'Close media'));
} }));
// Adapt native rows/viewers; keep the real payload builder, normalization,
// callbacks and disclosure state so this checks the group-to-viewer handoff.
vi.mock('@/session/MessageRenderer', async () => {
  const { buildToolResultPayload, buildTextPayload, buildMediaPayload } = await import('@/session/messagePayload');
  const { readToolProcessMedia } = await import('@cindy/maker-shared/tool-process-media');
  return {
    WorkToolActivityRow: ({ activity, actions }: any) => {
      history.toolActions = actions;
      const tool = activity.message.normalized;
      return el('div', { 'data-message-id': tool.source.id, 'data-session-id': tool.source.sessionId },
        el('p', null, tool.label, tool.body, tool.secondaryBody, activity.toolResult),
        ...readToolProcessMedia(tool.secondaryBody).map(media => el('button', { key: media.url, onClick: () => actions.onOpenPayload(buildMediaPayload({ ...media, previewable: false }, 'Process media')) }, 'Open process media')),
        tool.toolInputProjection && el('button', { disabled: !actions.onLoadToolInput, onClick: () => {
          void actions.onLoadToolInput(tool.toolInputProjection).then((detail: any) => actions.onOpenPayload(buildTextPayload('Full input', detail.body)));
        } }, 'Load full input'),
        el('button', { disabled: !actions.onOpenPayload, onClick: () => actions.onOpenPayload?.(buildToolResultPayload(tool)) }, 'View full output'));
    },
    MessagePayloadModal: ({ payload, onClose }: any) => payload ? el('div', { role: 'dialog' }, payload.body, el('button', { onClick: onClose }, 'Close output')) : null,
  };
});
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { BotGroupProcess, BotGroupProcessEntries } from '@/session/BotGroupProcess';
import { TeammateProcess } from '@/session/TeammateProcess';
import { __test_internals as memory } from '@/session/expandedBlockMemory';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, node: HTMLDivElement;
beforeEach(() => { history.invoke.mockReset(); history.resolveMedia.mockClear(); history.toolActions = undefined; history.generation = 1; remoteSessionStore.clear(); memory.reset(); node = document.createElement('div'); root = createRoot(node); });
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
    children: el(BotGroupProcessEntries, { messages, id: `group-process:${process.executionId}`, deviceId: 'mac', sessionId: 'lane', running: true }) })));
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
  await act(async () => root.render(el(BotGroupProcessEntries, { id: 'payload-turn', deviceId: 'mac', sessionId: 'lane', running, messages: [source,
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


it.each([false, true])('loads a projected input from its execution device and real session (running=%s)', async running => {
  const projection = { projected: true as const, version: 1 as const, toolName: 'WebFetch', toolUseId: 'tool-id', toolUseMessageId: 'persisted-tool', summary: 'Large input' };
  const projected = { id: 'persisted-tool', clientId: 'tool-client', role: 'tool_use', toolUseId: 'tool-id',
    content: { toolName: 'WebFetch', toolUseId: 'tool-id', input: null, mobilePayloadProjected: true }, mobileToolInputProjection: projection, agentMeta: meta };
  const full = { ...projected, sessionId: 'execution-lane', mobileToolInputProjection: undefined, createdAt: new Date(0).toISOString(),
    content: { toolName: 'WebFetch', toolUseId: 'tool-id', input: { prompt: 'x'.repeat(40000) + 'COMPLETE_INPUT_END' } } };
  history.invoke.mockImplementation(async (_device, channel) => channel === 'local-db:messages:around' ? [full] : [source, projected, final]);
  const entries = el(BotGroupProcessEntries, { messages: [source, projected, final], id: 'group-process:projection', running,
    deviceId: 'execution-mac', sessionId: 'execution-lane' });
  await act(async () => root.render(running ? entries : el(BotGroupProcess, {
    process: { ...process, executionId: 'projection', sessionId: 'execution-lane', deviceId: 'execution-mac' }, owned: true, deviceId: 'new-home',
  })));
  if (!running) await act(async () => header().click());
  await act(async () => Array.from(node.querySelectorAll('button')).find(button => button.getAttribute('aria-expanded') === 'false')!.click());
  const button = Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'Load full input')!;
  expect(button.disabled).toBe(false);
  const readsBeforeOpen = history.invoke.mock.calls.filter(call => call[1] === 'local-db:messages:around');
  expect(readsBeforeOpen).toHaveLength(0);
  await act(async () => button.click());
  expect(history.invoke).toHaveBeenCalledWith('execution-mac', 'local-db:messages:around', ['execution-lane', 'persisted-tool', { radius: 0 }]);
  expect(node.querySelector('[data-message-id="persisted-tool"]')?.getAttribute('data-session-id')).toBe('execution-lane');
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain('COMPLETE_INPUT_END');
  history.invoke.mockResolvedValueOnce([]);
  await expect(history.toolActions.onLoadToolInput(projection)).rejects.toThrow('tool input is unavailable');
  history.invoke.mockResolvedValueOnce([full]);
  await expect(history.toolActions.onLoadToolInput(projection)).resolves.toMatchObject({ toolName: 'WebFetch' });
});

it.each(['AskUserQuestion', 'ExitPlanMode'])('retains %s call, input and result in group process', async toolName => {
  await act(async () => root.render(el(BotGroupProcessEntries, { id: 'interaction-history', deviceId: 'mac', sessionId: 'lane', messages: [source,
    { clientId: 'interaction', role: 'tool_use', toolUseId: 'interaction-id', content: { toolName, toolUseId: 'interaction-id', input: { note: 'Interaction input detail' } }, agentMeta: meta },
    { clientId: 'interaction-result', role: 'tool_result', toolUseId: 'interaction-id', content: 'Interaction result detail', agentMeta: meta }, final] })));
  await act(async () => header().click());
  expect(node.textContent).toContain(toolName);
  expect(node.textContent).toContain('Interaction input detail');
  expect(node.textContent).toContain('Interaction result detail');
});

// PR #8979 / unit: real focused history and reader, native rendering adapted.
// Existing pushes resolved immediately; a slow read plus spaced notifications
// must keep one request and one trailing refresh, including failure/blur cleanup.
it.each(['success', 'failure', 'unmount'])('coalesces in-flight group history refreshes (%s)', async outcome => {
  vi.useFakeTimers();
  const latest = [source, { clientId: 'new-note', role: 'assistant', content: 'Newest persisted progress', agentMeta: { ...meta, assistantPhase: 'commentary' } }];
  const pending: Array<{ resolve(rows: unknown[]): void; reject(error: Error): void }> = [];
  let slow = true;
  let reads = 0;
  history.invoke.mockImplementation((_device, _channel, args) => {
    if (args[1] !== process.clientId) return Promise.resolve(latest);
    reads++;
    return slow ? new Promise((resolve, reject) => pending.push({ resolve, reject })) : Promise.resolve(latest);
  });
  await act(async () => root.render(group()));
  try {
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        remoteSessionStore.applyRemotePush('mac', 'local-db:messages:created', { sessionId: process.sessionId,
          message: { id: `slow-${i}`, clientId: `slow-${i}`, sessionId: process.sessionId, role: 'thinking', content: '', createdAt: new Date().toISOString() } });
        await vi.advanceTimersByTimeAsync(60);
      }
    });
    expect(reads).toBe(1);
    if (outcome === 'unmount') await act(async () => root.render(null));
    slow = false;
    await act(async () => {
      if (outcome === 'failure') pending[0]!.reject(new Error('slow read failed'));
      else pending[0]!.resolve([source]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads).toBe(outcome === 'unmount' ? 1 : 2);
    if (outcome !== 'unmount') {
      await act(async () => header().click());
      expect(node.textContent).toContain('Newest persisted progress');
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(reads).toBe(outcome === 'unmount' ? 1 : 2);
  } finally {
    await act(async () => root.render(null));
    await act(async () => { pending.forEach(request => request.resolve([source])); });
  }
});

// PR #8979 / unit: production normalization previously filtered out commentary,
// making an unfinished tool falsely adjacent to another tool's result.
it('preserves commentary boundaries when pairing group tool results', async () => {
  await act(async () => root.render(el(BotGroupProcessEntries, { id: 'pairing-boundary', deviceId: 'mac', sessionId: 'lane', messages: [
    { clientId: 'tool-b', role: 'tool_use', toolUseId: 'B', content: { toolName: 'Read', input: { file_path: '/repo/b.md' } } },
    { clientId: 'tool-a', role: 'tool_use', toolUseId: 'A', content: { toolName: 'Read', input: { file_path: '/repo/a.md' } } },
    { clientId: 'between', role: 'assistant', content: 'Still processing', agentMeta: { assistantPhase: 'commentary' } },
    { clientId: 'result-b', role: 'tool_result', toolUseId: 'B', content: 'OUTPUT FROM B ONLY' },
  ] })));
  await act(async () => header().click());
  const toolA = node.querySelector('[data-message-id="tool-a"]');
  expect(toolA).not.toBeNull();
  expect(toolA!.textContent).not.toContain('OUTPUT FROM B ONLY');
  expect(node.querySelector('[data-message-id="tool-b"]')!.textContent).toContain('OUTPUT FROM B ONLY');
});

// PR #8979 / unit: real process-media parsing/payloads and group viewer routing;
// the native viewer is adapted, preserving execution-device resolver handoff.
it.each(['image', 'video'] as const)('routes group tool %s through the execution-device resolver and shared lightbox', async kind => {
  const url = `cindy-media://blobs/${'c'.repeat(64)}.${kind === 'image' ? 'png' : 'mp4'}`;
  await act(async () => root.render(el(BotGroupProcessEntries, { id: `media-${kind}`, deviceId: 'execution-mac', sessionId: 'execution-lane', messages: [
    { clientId: 'capture', role: 'tool_use', toolUseId: 'capture', content: { toolName: 'Capture', input: {} } },
    { clientId: 'captured', role: 'tool_result', toolUseId: 'capture', content: JSON.stringify({ cindy_process_media: [{ kind, url }] }) },
  ] })));
  await act(async () => header().click());
  expect(history.toolActions.onResolveRemoteMedia).toBe(history.resolveMedia);
  await act(async () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'Open process media')!.click());
  expect(history.mediaDevice).toBe('execution-mac');
  expect(history.resolveMedia).toHaveBeenCalledWith(expect.objectContaining({ kind, url }), { front: true });
  expect(node.querySelector('[data-testid="process-lightbox"]')?.getAttribute('data-url')).toBe('https://media.invalid/resolved');
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'Close media')!.click());
  expect(node.querySelector('[data-testid="process-lightbox"]')).toBeNull();
  expect(node.querySelector('[data-message-id="capture"]')).not.toBeNull();
});
