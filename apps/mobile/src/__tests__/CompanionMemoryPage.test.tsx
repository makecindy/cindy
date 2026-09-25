// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ alert: vi.fn(), invoke: vi.fn(), read: vi.fn(), perform: vi.fn(), openLink: vi.fn(async () => {}), state: null as any }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' },
  t: (key: string, values?: Record<string, string>) => `${key.split('.').at(-1)}${values?.name ? `:${values.name}` : ''}` }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, Alert: { alert: h.alert },
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, testID }: any) => <button data-testid={testID} onClick={onPress}>{children}</button>,
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => <span>{children}</span>,
  TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} disabled={p.editable === false} onInput={e => p.onChangeText(e.currentTarget.value)} onChange={() => {}} />,
}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => <button disabled={!!action.disabled || !!action.busy} onClick={action.onPress}>{action.label}</button> }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/device-link/remoteResources', async original => ({ ...await original<object>(), invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));
vi.mock('@/session/companionProfileData', async original => ({ ...await original<object>(), loadCompanionProfile: (...args: unknown[]) => h.read(...args) }));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: ({ title, children }: any) => <section aria-label={title}>{children}</section> }));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'autocorrectionDisabled', 'buttonStyle', 'contentShape', 'disabled', 'font', 'foregroundStyle', 'frame', 'lineLimit', 'listRowInsets', 'textInputAutocapitalization', 'textSelection'].map(name => [name, (value: unknown) => ({ name, value })])),
  shapes: { rectangle: () => ({}) },
}));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  const mod = (props: any, name: string) => props.modifiers?.find((m: any) => m.name === name)?.value;
  return {
    HStack: Container, VStack: Container, Image: () => null, Spacer: () => null, ProgressView: () => <span>Loading</span>,
    Text: ({ children }: any) => <span>{children}</span>,
    Button: (props: any) => <button data-testid={props.testID} disabled={!!mod(props, 'disabled')} onClick={props.onPress}>{props.children}</button>,
    useNativeState: (initial: string) => {
      const state = useRef<any>(null);
      state.current ??= { value: initial, get() { return this.value; }, set(value: string) { this.value = value; } };
      return state.current;
    },
    TextField: (props: any) => <input aria-label={mod(props, 'accessibilityLabel')} defaultValue={props.text.get()} disabled={!!mod(props, 'disabled')}
      onInput={e => { props.text.value = e.currentTarget.value; props.onTextChange(e.currentTarget.value); }} />,
  };
});

import { parseCompanionProfileData } from '@/session/companionProfileData';
import { useCompanionMemory } from '@/session/useCompanionMemory';
import { CompanionMemoryPage } from '@/session/CompanionMemoryPage';
import { CompanionMemoryPage as NativeCompanionMemoryPage } from '@/session/CompanionMemoryPage.ios';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Memory = { stem: string; type: 'user' | 'feedback'; title: string; body: string; revision: number };
const kinds = { user: 'About you', feedback: 'Your preferences' };
let memories: Memory[] = [];
let grantId = 0;
const grants = new Map<string, { stem: string; operation: 'entry' | 'remove'; revision: number }>();
const ref = (id: string) => ({ collectionId: 'teammates', kind: 'bot', id });
/** Host-shaped resources, with one-use actions bound to the entry revision like `bindResource`. */
function hostResource(id: string, query = '') {
  if (id === 'settings:bot/memory') {
    const shown = memories.filter(item => !query || item.title.includes(query) || item.body.includes(query));
    const blocks: unknown[] = [{ id: 'search', primitive: 'search', fallbackMarkdown: '', data: { query, placeholder: 'Search memories' } }];
    for (const type of ['user', 'feedback'] as const) {
      const items = shown.filter(item => item.type === type);
      if (items.length) blocks.push({ id: `memory-${type}`, primitive: 'list', title: kinds[type], fallbackMarkdown: '', data: { count: items.length,
        entries: items.map(item => ({ id: item.stem, title: item.title, subtitle: item.body, timestamp: Date.UTC(2026, 0, 2), resourceId: `settings:bot/memory/${item.stem}` })) } });
    }
    return { ref: ref(id), revision: 'list', display: { title: 'Saved Memories' }, links: [], blocks };
  }
  const memory = memories.find(item => `settings:bot/memory/${item.stem}` === id);
  if (!memory) throw new Error('[NOT_FOUND] Memory not found');
  const entry = `grant-${++grantId}`; const remove = `grant-${++grantId}`;
  grants.set(entry, { stem: memory.stem, operation: 'entry', revision: memory.revision });
  grants.set(remove, { stem: memory.stem, operation: 'remove', revision: memory.revision });
  return { ref: ref(id), revision: String(memory.revision), display: { title: memory.title, subtitle: kinds[memory.type], timestamp: Date.UTC(2026, 0, 2) }, links: [],
    actions: [{ id: entry, label: 'Edit', fields: [{ id: 'title', label: 'Title', kind: 'text', required: true }, { id: 'body', label: 'Content', kind: 'multiline', required: true }] },
      { id: remove, label: 'Delete Memory', tone: 'destructive', confirmation: { title: 'Delete this memory?', body: `Sora will no longer refer to “${memory.title}”.`, confirmLabel: 'Delete' } }],
    blocks: [{ id: 'entry', primitive: 'form', title: 'Edit', fallbackMarkdown: memory.body, data: { actionId: entry, values: { title: memory.title, body: memory.body } } },
      { id: 'remove', primitive: 'action', fallbackMarkdown: 'Delete Memory', data: { actionId: remove } }] };
}
const teammateWrites = (stem: string, body: string) => { const memory = memories.find(item => item.stem === stem)!; memory.body = body; memory.revision++; };

let root: Root; let container: HTMLDivElement;
function Harness({ platform }: { platform: string }) {
  const memory = useCompanionMemory({ invoke: vi.fn() as never, openLink: h.openLink, deviceId: 'host', deviceName: 'Mac', collectionId: 'teammates',
    resourceKind: 'bot', listResourceId: 'settings:bot/memory', online: true, active: true, binding: 'account-1' });
  h.state = memory;
  const Page = platform === 'ios' ? NativeCompanionMemoryPage : CompanionMemoryPage;
  return <Page memory={memory} online botName="Sora" memoryEnabled />;
}
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
async function render(platform: string) { await act(async () => root.render(<Harness platform={platform} />)); await settle(); }
const buttons = () => [...container.querySelectorAll('button')];
/** Visible copy, including native Section titles (rendered as headers, not body text). */
const shown = (text: string) => container.textContent!.includes(text)
  || [...container.querySelectorAll('section')].some(section => section.getAttribute('aria-label')?.includes(text));
async function click(text: string) {
  const button = buttons().find(node => node.textContent === text || node.dataset.testid === text);
  if (!button) throw new Error(`Missing ${text}`);
  await act(async () => { button.click(); }); await settle();
}
async function type(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!field) throw new Error(`Missing ${label}`);
  await act(async () => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function openEditor(platform: string, stem = 'user_coffee') {
  await render(platform); await click(`companionMemory.${stem}`); await click('memoryEdit');
}

beforeEach(() => {
  vi.clearAllMocks(); grants.clear(); grantId = 0;
  memories = [
    { stem: 'user_coffee', type: 'user', title: 'Coffee', body: 'Black, no sugar.', revision: 1 },
    { stem: 'feedback_short', type: 'feedback', title: 'Short replies', body: 'Lead with the answer.', revision: 1 },
    { stem: 'feedback_sources', type: 'feedback', title: 'Cite sources', body: 'Link every quote.', revision: 1 },
  ];
  h.read.mockImplementation(async (_invoke: unknown, _device: string, target: { id: string }, _locale: string, options?: { query?: string }) =>
    parseCompanionProfileData(hostResource(target.id, options?.query), ref(target.id)));
  h.invoke.mockImplementation(async (_invoke: unknown, _target: unknown, request: { actionId: string; input: Record<string, string> }) => {
    const grant = grants.get(request.actionId); const memory = memories.find(item => item.stem === grant?.stem);
    // Provider conflicts reach the controller only as an opaque failure.
    if (!grant || !memory || memory.revision !== grant.revision) throw new Error('[INTERNAL] remote resource provider failed');
    grants.delete(request.actionId);
    h.perform(grant.operation, request.input);
    if (grant.operation === 'remove') memories = memories.filter(item => item !== memory);
    else { Object.assign(memory, request.input); memory.revision++; }
    return { effects: [{ kind: 'toast', message: grant.operation === 'remove' ? 'Memory deleted' : 'Memory saved' }] };
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each(['android', 'ios'])('groups memories by kind and searches through host retrieval on %s', async platform => {
  await render(platform);
  expect(shown('About you')).toBe(true); expect(shown('Your preferences')).toBe(true);
  expect(container.textContent).toContain('Lead with the answer.');
  if (platform === 'ios') expect(container.querySelector('section[aria-label="Your preferences 2"]')).not.toBeNull();
  await type('memorySearch', 'Link');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); }); await settle();
  expect(h.read).toHaveBeenLastCalledWith(expect.anything(), 'host', ref('settings:bot/memory'), 'en', { query: 'Link' });
  expect(container.textContent).toContain('Cite sources'); expect(container.textContent).not.toContain('Coffee');
  await type('memorySearch', 'nothing matches');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); }); await settle();
  expect(container.textContent).toContain('memoryNoResults');
});

it.each(['android', 'ios'])('never overwrites a newer teammate write and saves mine only after I choose on %s', async platform => {
  await openEditor(platform);
  await type('Content', 'Oat latte.');
  teammateWrites('user_coffee', 'Espresso, written by Sora.');
  await click(platform === 'ios' ? 'companionMemory.done' : 'memoryDone');
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.state.saveState).toBe('conflict');
  expect(shown('memoryChanged:Sora')).toBe(true); expect(container.textContent).toContain('Espresso, written by Sora.');
  expect(h.state.draft.body).toBe('Oat latte.');
  await click(platform === 'ios' ? 'companionMemory.keepMine' : 'memoryKeepMine');
  expect(h.perform).toHaveBeenCalledOnce(); expect(h.perform).toHaveBeenCalledWith('entry', { body: 'Oat latte.' });
  expect(memories[0].body).toBe('Oat latte.'); expect(h.state.saveState).toBe('saved'); expect(h.state.dirty).toBe(false);
});

it.each(['android', 'ios'])('can take the teammate’s latest version instead of my draft on %s', async platform => {
  await openEditor(platform);
  await type('Content', 'Oat latte.');
  teammateWrites('user_coffee', 'Espresso, written by Sora.');
  await click(platform === 'ios' ? 'companionMemory.done' : 'memoryDone');
  await click(platform === 'ios' ? 'companionMemory.useLatest' : 'memoryUseLatest');
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.state.draft.body).toBe('Espresso, written by Sora.'); expect(h.state.dirty).toBe(false);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Content"]')!.value).toBe('Espresso, written by Sora.');
});

it.each(['android', 'ios'])('deletes only after confirmation and not over a newer teammate write on %s', async platform => {
  await render(platform); await click('companionMemory.feedback_sources');
  await click(platform === 'ios' ? 'companionMemory.delete' : 'Delete Memory');
  const [title, body, choices] = h.alert.mock.calls[0];
  expect([title, body]).toEqual(['Delete this memory?', 'Sora will no longer refer to “Cite sources”.']);
  teammateWrites('feedback_sources', 'Changed on the computer.');
  await act(async () => { choices[1].onPress(); }); await settle();
  expect(h.perform).not.toHaveBeenCalled(); expect(container.textContent).toContain('memoryChanged:Sora');
  expect(container.textContent).toContain('Changed on the computer.');
  await click(platform === 'ios' ? 'companionMemory.delete' : 'Delete Memory');
  await act(async () => { h.alert.mock.calls[1][2][1].onPress(); }); await settle();
  expect(h.perform).toHaveBeenCalledWith('remove', {});
  expect(h.state.view).toBe('list'); expect(container.textContent).not.toContain('Cite sources'); expect(container.textContent).toContain('Memory deleted');
});

it('reconciles a lost save acknowledgement by reading instead of replaying', async () => {
  await openEditor('android');
  const perform = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementationOnce(async (...args: any[]) => { await perform(...args); throw new Error('request timed out'); });
  await type('Content', 'Oat latte.'); await click('memoryDone');
  expect(h.invoke).toHaveBeenCalledOnce(); expect(memories[0].body).toBe('Oat latte.');
  expect(h.state.view).toBe('detail'); expect(container.textContent).toContain('Oat latte.');
});

it('keeps the draft after an ordinary failure and steps back through edit, detail and list', async () => {
  await openEditor('android');
  h.invoke.mockRejectedValueOnce(new Error('[INTERNAL] remote resource provider failed'));
  await type('Content', 'Oat latte.'); await click('memoryDone');
  expect(h.state.saveState).toBe('error'); expect(h.state.draft.body).toBe('Oat latte.'); expect(h.state.view).toBe('edit');
  let handled = false;
  await act(async () => { handled = await h.state.back(); }); await settle();
  expect(handled).toBe(true); expect(memories[0].body).toBe('Oat latte.'); expect(h.state.view).toBe('detail');
  await act(async () => { handled = await h.state.back(); }); await settle();
  expect(handled).toBe(true); expect(h.state.view).toBe('list');
  await act(async () => { handled = await h.state.back(); });
  expect(handled).toBe(false);
});

it('asks before discarding an unsavable draft when leaving', async () => {
  await openEditor('android');
  await type('Content', '   ');
  let left: Promise<boolean> | undefined;
  await act(async () => { left = h.state.flush(); }); await settle();
  expect(h.alert).toHaveBeenCalledOnce(); expect(h.invoke).not.toHaveBeenCalled();
  await act(async () => { h.alert.mock.calls[0][2][0].onPress(); });
  await expect(left).resolves.toBe(false);
  expect(h.state.draft.body).toBe('   ');
});

it('shows a memory that disappeared as missing rather than as a failure', async () => {
  await render('android');
  memories = memories.filter(item => item.stem !== 'user_coffee');
  await click('companionMemory.user_coffee');
  expect(h.state.missing).toBe(true); expect(container.textContent).toContain('memoryMissing');
});
