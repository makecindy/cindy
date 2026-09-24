// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAutomationSheet } from '../session/CompanionAutomationSheet';
import { emptyRoutineDefinition, type RoutineDefinition } from '../session/companionRoutines';

const h = vi.hoisted(() => ({
  read: vi.fn(), invoke: vi.fn(), openLink: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), changed: vi.fn(), close: vi.fn(),
  alert: vi.fn(), account: 1, foreground: null as null | ((state: string) => void), nativeWrites: vi.fn(),
  definition: null as any, revision: 0, existing: false, now: 0, uuid: 0, perform: vi.fn(), sheet: null as any, platform: 'ios',
  history: [] as { id: string; status: string; createdAt: number }[],
}));
vi.mock('react-i18next', () => { const t = (key: string) => key.split('.').at(-1)!; return { useTranslation: () => ({ t, i18n: { language: 'en' } }) }; });
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.platform; } }, StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, testID }: any) => <button disabled={disabled} onClick={onPress} data-testid={testID}>{children}</button>,
  Switch: ({ value, onValueChange, disabled }: any) => <input type="checkbox" checked={value} disabled={disabled} onChange={e => onValueChange(e.currentTarget.checked)} />,
  ScrollView: 'div', ActivityIndicator: () => <span>Loading</span>,
  useWindowDimensions: () => ({ width: 402, height: 874 }), Alert: { alert: h.alert },
  AppState: { addEventListener: (_name: string, fn: any) => { h.foreground = fn; return { remove() {} }; } },
}));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => <span>{children}</span>, TextInput: (p: any) => {
  if (h.platform === 'ios') throw new Error('iOS automation must not mount the RN input path');
  return <input aria-label={p.accessibilityLabel} value={p.value} disabled={p.editable === false} onInput={e => p.onChangeText(e.currentTarget.value)} onChange={() => {}} />;
} }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, Clock3: () => null, Plus: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `creation-request-${++h.uuid}` }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.account }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink, subscribe: h.subscribe, unsubscribe: h.unsubscribe, onRemoteResourceChanged: h.changed, connectionEpoch: 1 }) }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: (...args: any[]) => h.read(...args), invokeRemoteResourceAction: (...args: any[]) => h.invoke(...args) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (error: Error) => error.message }));
vi.mock('@/theme', () => ({ iconSize: { action: 20, lg: 24, xs: 12 }, spacing: { xs: 4, sm: 8, md: 12 }, useTheme: () => ({ mode: 'light', colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('../session/CompanionChoice', () => ({ CompanionChoice: () => null }));
vi.mock('../session/CompanionSheet', () => ({ CompanionSheet: ({ children, footer }: any) => {
  if (h.platform === 'ios') throw new Error('legacy automation sheet mounted');
  return <div>{children}{footer}</div>;
} }));
vi.mock('../session/CompanionAutomationNativeView', async () => import('../session/CompanionAutomationNativeView.ios'));
vi.mock('../session/ComposerSheet', async () => import('../session/ComposerSheet.ios'));
vi.mock('../session/ComposerNativeSection', () => ({ ComposerNativeSection: ({ title, children }: any) => <section aria-label={title}>{children}</section> }));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'buttonStyle', 'contentShape', 'disabled', 'font', 'foregroundStyle', 'frame', 'keyboardType', 'lineLimit', 'pickerStyle', 'tag', 'textInputAutocapitalization', 'textSelection', 'padding', 'presentationDetents', 'interactiveDismissDisabled', 'presentationDragIndicator', 'scrollContentBackground'].map(name => [name, (value: any) => ({ name, value })])),
  shapes: { rectangle: () => ({}) },
}));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  const mod = (props: any, name: string) => props.modifiers?.find((m: any) => m.name === name)?.value;
  return {
    Group: Container, HStack: Container, VStack: Container, ProgressView: () => <span>Loading</span>, Image: () => null, Spacer: () => null,
    RNHostView: () => { throw new Error('native automation form must not mount RNHostView'); },
    Form: ({ children }: any) => <div data-testid="native-form">{children}</div>,
    BottomSheet: (props: any) => { h.sheet = props; return props.isPresented ? <div>{props.children}</div> : null; },
    Text: (props: any) => mod(props, 'tag') !== undefined ? <option value={mod(props, 'tag')}>{props.children}</option> : <span data-native-selectable={mod(props, 'textSelection')}>{props.children}</span>,
    Button: (props: any) => <button data-testid={props.testID} disabled={!!mod(props, 'disabled')} onClick={props.onPress}>{props.children}</button>,
    Picker: (props: any) => <select aria-label={props.label} value={props.selection} disabled={!!mod(props, 'disabled')} onChange={e => props.onSelectionChange(e.currentTarget.value)}>{props.children}</select>,
    Toggle: (props: any) => <input aria-label={props.label} type="checkbox" checked={props.isOn} disabled={!!mod(props, 'disabled')} onChange={e => props.onIsOnChange(e.currentTarget.checked)} />,
    useNativeState: (initial: string) => {
      const state = useRef<any>(null);
      state.current ??= { value: initial, get() { return this.value; }, set(value: string) { h.nativeWrites(value); this.value = value; } };
      return state.current;
    },
    // Native widget semantics: edits update native state first; callbacks then notify JS.
    TextField: (props: any) => <input aria-label={mod(props, 'accessibilityLabel')} defaultValue={props.text.get()} maxLength={props.maxLength}
      disabled={!!mod(props, 'disabled')} onInput={e => { props.text.value = e.currentTarget.value; props.onTextChange(e.currentTarget.value); }} />,
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let container: HTMLDivElement;
let grantId = 0;
const grants = new Map<string, { operation: string; revision: number; expires: number }>();
function resource(id: string) {
  const selected = id.includes('/');
  const existing = selected && !id.endsWith('/new');
  const revision = existing ? h.revision : 0;
  const operations = existing ? ['routine-save', 'routine-run', 'routine-delete'] : ['routine-create'];
  const operationActions = Object.fromEntries(operations.map(operation => {
    const token = `opaque-${++grantId}`;
    grants.set(token, { operation, revision, expires: h.now + 15 * 60_000 });
    return [operation, token];
  }));
  return { ref: { collectionId: 'routines', kind: 'routine', id }, display: { title: 'Automations' }, links: [], revision: String(revision),
    actions: Object.values(operationActions).map(id => ({ id, label: 'Action' })), blocks: [{ primitive: selected ? 'routine-detail' : 'routine-list', data: selected
      ? { id: existing ? 'rule' : null, revision, editable: true, input: h.definition, sources: [{ id: 'mail', name: 'Mail', status: 'ready', events: [{ type: 'received', name: 'Received', fields: ['sender', 'subject'] }] }], history: h.history, operationActions }
      : { items: h.existing ? [{ id: 'rule', name: 'Existing', enabled: true, revision: h.revision, triggers: [] }] : [], operationActions } }] };
}
async function render(online = true) { await act(async () => root.render(<CompanionAutomationSheet visible online={online} onClose={h.close} botId="bot" collectionId="routines" deviceId="host" deviceName="Mac" />)); }
function input(label: string) { const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!node) throw new Error(`Missing ${label}`); return node; }
async function type(label: string, value: string) { await act(async () => { const field = input(label); field.focus(); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function click(label: string) { await act(async () => { const button = [...container.querySelectorAll('button')].find(node => node.textContent === label); if (!button) throw new Error(`Missing ${label}`); button.click(); }); }
async function select(label: string, value: string) { await act(async () => { const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function open() { await render(); await click('new'); }
beforeEach(() => {
  vi.resetAllMocks(); h.account = 1; h.revision = 0; h.existing = false; h.now = 0; h.uuid = 0; h.platform = 'ios'; h.definition = emptyRoutineDefinition();
  h.history = [];
  grants.clear(); grantId = 0;
  h.changed.mockReturnValue(() => {}); h.openLink.mockResolvedValue(undefined);
  h.read.mockImplementation((_invoke, _target, ref) => Promise.resolve(resource(ref.id)));
  h.perform.mockResolvedValue({ effects: [] });
  h.invoke.mockImplementation(async (_invoke, _target, request) => {
    const grant = grants.get(request.actionId);
    if (!grant || grant.expires <= h.now || grant.revision !== request.input.revision)
      throw Object.assign(new Error('Refresh before retrying'), { code: 'PRECONDITION_FAILED' });
    // Host consumes before running business validation, including rejected operations.
    grants.delete(request.actionId);
    return h.perform({ ...request, actionId: grant.operation });
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('keeps native editor identity through name changes and submits the edited time through the existing grant', async () => {
  await open();
  const name = input('name'); const hour = input('hour');
  await type('name', '应该'); await type('instructions', 'Check the inbox');
  for (const value of ['12', '1', '', '08']) await type('hour', value);
  for (const value of ['30', '3', '', '05']) await type('minute', value);
  expect(input('name')).toBe(name); expect(input('hour')).toBe(hour);
  expect(document.activeElement).toBe(input('minute'));
  expect(hour.hasAttribute('maxlength')).toBe(false);
  expect(h.nativeWrites).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="native-form"]')).not.toBeNull();
  const save = container.querySelector('[data-testid="companion.automation.save"]');
  expect(save?.closest('section')).not.toBeNull();
  expect(save?.closest('[data-testid="native-form"]')).toBe(hour.closest('[data-testid="native-form"]'));
  await click('save');
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(h.perform.mock.calls[0][0]).toMatchObject({ actionId: 'routine-create', input: { revision: 0, definition: { name: '应该', prompt: 'Check the inbox', triggers: [{ expression: '05 08 * * *' }] } } });
});

it('keeps editing and focus when a foreground refresh returns while the draft is dirty', async () => {
  await open(); await type('name', 'Keep this'); const name = input('name');
  h.definition = { ...emptyRoutineDefinition(), name: 'Remote' };
  await act(async () => h.foreground?.('active'));
  expect(input('name')).toBe(name); expect(name.value).toBe('Keep this'); expect(document.activeElement).toBe(name);
  await type('instructions', 'Still editable');
  expect(h.nativeWrites).not.toHaveBeenCalled();
});

it('loads fresh native field values when a clean remote draft changes', async () => {
  await open(); const name = input('name');
  h.definition = { ...emptyRoutineDefinition(), name: 'Remote', triggers: [{ id: 'daily', kind: 'cron', expression: '45 17 * * *', timezone: 'UTC' }] };
  await act(async () => h.foreground?.('active'));
  expect(input('name')).not.toBe(name); expect(input('name').value).toBe('Remote'); expect(input('hour').value).toBe('17'); expect(input('minute').value).toBe('45');
});

it.each(['ios', 'android'])('renews a consumed create action and keeps the draft and request ID on %s', async platform => {
  h.platform = platform;
  await open(); await type('name', 'Brief'); await type('instructions', 'Summarize'); await type('hour', '11');
  const hour = input('hour');
  h.perform.mockRejectedValueOnce(new Error('Host rejected the automation'));
  await click('save');
  expect(input('hour')).toBe(hour); expect(hour.value).toBe('11');
  expect(container.textContent).toContain('Host rejected the automation');
  if (platform === 'ios') expect([...container.querySelectorAll('[data-native-selectable="true"]')].some(node => node.textContent === 'Host rejected the automation')).toBe(true);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await type('hour', '12'); await click('save');
  expect(h.perform).toHaveBeenCalledTimes(2);
  expect(h.invoke.mock.calls[1][2].actionId).not.toBe(h.invoke.mock.calls[0][2].actionId);
  expect(h.invoke.mock.calls[1][2].input.requestId).toBe(h.invoke.mock.calls[0][2].input.requestId);
  expect(h.invoke.mock.calls[1][2].input.definition.triggers[0].expression).toBe('0 12 * * *');
  expect(container.querySelector('input[aria-label="hour"]')).toBeNull();
});

it('preserves each trigger kind and the remaining native filter values after removing a filter', async () => {
  h.definition = { ...emptyRoutineDefinition(), name: 'Mail', prompt: 'Summarize', triggers: [{ id: 'mail-trigger', kind: 'event', sourceId: 'mail', eventType: 'received', filters: [
    { field: 'sender', operator: 'contains', value: 'Alice' }, { field: 'subject', operator: 'contains', value: 'Report' },
  ] }] } satisfies RoutineDefinition;
  await open(); await click('removeFilter');
  expect(input('filterField').value).toBe('subject'); expect(input('filterValue').value).toBe('Report');
  await select('triggerType', 'interval'); await type('minutes', '90');
  await select('triggerType', 'cron'); await select('repeat', 'weekly'); await select('weekday', '5');
  await type('hour', '18'); await type('minute', '30'); await click('save');
  expect(h.invoke.mock.calls[0][2].input.definition.triggers).toEqual([{ id: 'mail-trigger', kind: 'cron', expression: '30 18 * * 5', timezone: expect.any(String) }]);
});

it.each(['ios', 'android'])('blocks invalid times before invoking and allows correction on %s', async platform => {
  h.platform = platform;
  await open(); await type('name', 'Brief'); await type('instructions', 'Summarize');
  for (const [field, invalid, corrected] of [['hour', '25', '12'], ['hour', '', '08'], ['minute', '60', '30'], ['minute', '', '05']]) {
    await type(field!, invalid!); await click('save');
    expect(h.invoke).not.toHaveBeenCalled();
    expect(input(field!).value).toBe(invalid);
    expect(container.textContent).toContain('invalid');
    await type(field!, corrected!);
  }
  await click('save');
  expect(h.perform).toHaveBeenCalledOnce();
  expect(h.perform.mock.calls[0][0].input.definition.triggers[0].expression).toBe('05 08 * * *');
});

async function openExisting() {
  h.existing = true; h.revision = 1;
  h.definition = { ...emptyRoutineDefinition(), name: 'Existing', prompt: 'Check the inbox' };
  await render(); await click('Existing');
}

it.each(['ios', 'android'])('renews a consumed save action without replacing edited fields on %s', async platform => {
  h.platform = platform;
  await openExisting(); await type('hour', '11');
  h.perform.mockRejectedValueOnce(new Error('Host rejected the automation'));
  await click('save');
  expect(input('hour').value).toBe('11');
  await type('hour', '12'); await click('save');
  expect(h.perform).toHaveBeenCalledTimes(2);
  expect(h.perform.mock.calls[1][0]).toMatchObject({ actionId: 'routine-save', input: { revision: 1, definition: { triggers: [{ expression: '0 12 * * *' }] } } });
  expect(h.invoke.mock.calls[1][2].actionId).not.toBe(h.invoke.mock.calls[0][2].actionId);
});

it('recovers from expiry without automatically repeating the write', async () => {
  await openExisting(); await type('hour', '12'); h.now += 16 * 60_000;
  await click('save');
  expect(h.invoke).toHaveBeenCalledOnce(); expect(h.perform).not.toHaveBeenCalled();
  expect(input('hour').value).toBe('12');
  await click('save');
  expect(h.perform).toHaveBeenCalledOnce();
});

it('reuses the creation intent after a lost acknowledgement without creating a duplicate', async () => {
  await open(); await type('name', 'Brief'); await type('instructions', 'Summarize');
  const created = new Map<string, unknown>();
  h.perform.mockImplementation(async request => {
    const { requestId, definition } = request.input;
    if (!created.has(requestId)) {
      created.set(requestId, definition);
      throw new Error('Response lost');
    }
    expect(definition).toEqual(created.get(requestId));
    return { effects: [] };
  });
  await click('save');
  expect(h.invoke).toHaveBeenCalledOnce(); expect(created.size).toBe(1);
  expect(input('name').value).toBe('Brief');
  await click('save');
  expect(created.size).toBe(1);
  expect(container.querySelector('input[aria-label="name"]')).toBeNull();
});

it('keeps a failed refresh retryable without letting save reuse a consumed action', async () => {
  await openExisting(); await type('hour', '12');
  h.perform.mockRejectedValueOnce(new Error('Save rejected'));
  h.read.mockRejectedValueOnce(new Error('Read unavailable'));
  await click('save');
  expect(container.textContent).toContain('Save rejected');
  expect(container.textContent).toContain('loadFailed');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="companion.automation.save"]')!.disabled).toBe(true);
  await click('save'); expect(h.invoke).toHaveBeenCalledOnce();
  await click('retry');
  expect(input('hour').value).toBe('12');
  await click('save'); expect(h.perform).toHaveBeenCalledTimes(2);
});

it('preserves a dirty draft and blocks stale saves when the host version changed', async () => {
  await openExisting(); await type('hour', '12');
  h.perform.mockImplementationOnce(async () => {
    h.revision = 2;
    h.definition = { ...h.definition, name: 'Changed elsewhere' };
    throw new Error('Response lost');
  });
  await click('save');
  expect(container.textContent).toContain('Response lost');
  expect(container.textContent).toContain('changed');
  expect(input('name').value).toBe('Existing'); expect(input('hour').value).toBe('12');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="companion.automation.save"]')!.disabled).toBe(true);
  await click('retry'); await click('save');
  expect(h.invoke).toHaveBeenCalledOnce();
});

it.each(['ios', 'android'])('reconciles an acknowledged-by-read save without overwriting or locking the draft on %s', async platform => {
  h.platform = platform;
  await openExisting(); await type('hour', '12');
  const hour = input('hour');
  h.perform.mockImplementationOnce(async request => {
    h.definition = request.input.definition; h.revision++;
    throw new Error('Response lost');
  });
  await click('save');
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Response lost');
  expect(container.textContent).not.toContain('changed');
  expect(input('hour')).toBe(hour); expect(hour.value).toBe('12');
  await type('hour', '13'); await click('save');
  expect(h.perform).toHaveBeenCalledTimes(2);
  expect(h.perform.mock.calls[1][0].input).toMatchObject({ revision: 2, definition: { triggers: [{ expression: '0 13 * * *' }] } });
});

it.each(['ios', 'android'])('shows the action error when the connection goes offline before it settles on %s', async platform => {
  h.platform = platform;
  await openExisting(); await type('hour', '12');
  let reject!: (error: Error) => void;
  h.perform.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await click('save');
  const reads = h.read.mock.calls.length;
  await render(false);
  await act(async () => reject(new Error('Host rejected the automation')));
  expect(container.textContent).toContain('Host rejected the automation');
  expect(container.textContent).toContain('offline');
  expect(input('hour').value).toBe('12');
  expect(h.read).toHaveBeenCalledTimes(reads);
  await click('save'); expect(h.invoke).toHaveBeenCalledOnce();
  await render(true); await click('save');
  expect(h.perform).toHaveBeenCalledTimes(2);
});

it.each(['ios', 'android'])('disables run and delete during an ordinary refresh on %s', async platform => {
  h.platform = platform;
  await openExisting();
  let finish!: (value: ReturnType<typeof resource>) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => h.foreground?.('active'));
  for (const label of ['run', 'delete']) {
    expect([...container.querySelectorAll('button')].find(node => node.textContent === label)?.disabled).toBe(true);
    await click(label);
  }
  expect(h.invoke).not.toHaveBeenCalled(); expect(h.alert).not.toHaveBeenCalled();
  await act(async () => finish(resource('bot:bot/rule')));
  for (const label of ['run', 'delete']) {
    expect([...container.querySelectorAll('button')].find(node => node.textContent === label)?.disabled).toBe(false);
  }
  await click('run'); expect(h.perform).toHaveBeenCalledOnce();
});

it.each(['ios', 'android'])('does not repeat a lost-acknowledgement run and blocks running or queued history on %s', async platform => {
  h.platform = platform;
  await openExisting();
  h.perform.mockImplementationOnce(async () => {
    h.history = [{ id: 'run-1', status: 'queued', createdAt: 1 }];
    throw new Error('Response lost');
  });
  await click('run');
  expect(h.invoke).toHaveBeenCalledOnce();
  for (const status of ['queued', 'running']) {
    h.history = [{ id: 'run-1', status, createdAt: 1 }];
    await act(async () => h.foreground?.('active'));
    expect([...container.querySelectorAll('button')].find(node => node.textContent === 'run')?.disabled).toBe(true);
    await click('run'); expect(h.invoke).toHaveBeenCalledOnce();
  }
  h.history = [{ id: 'run-1', status: 'success', createdAt: 1 }];
  await act(async () => h.foreground?.('active'));
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('success');
  await click('run'); expect(h.perform).toHaveBeenCalledTimes(2);
});

it('waits for reconciliation and discards a late read after switching accounts', async () => {
  await openExisting(); await type('hour', '12');
  h.perform.mockRejectedValueOnce(new Error('Save rejected'));
  let finish!: (value: ReturnType<typeof resource>) => void;
  const oldResult = resource('bot:bot/rule');
  h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click('save');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="companion.automation.save"]')!.disabled).toBe(true);
  await click('save'); expect(h.invoke).toHaveBeenCalledOnce();
  h.account++; h.existing = false;
  await render();
  await act(async () => finish(oldResult));
  expect(container.querySelector('input[aria-label="hour"]')).toBeNull();
  expect(container.textContent).not.toContain('Save rejected');
});

it.each(['run', 'delete'])('renews a consumed %s action for an explicit retry', async operation => {
  await openExisting();
  const perform = async () => {
    await click(operation);
    if (operation === 'delete') await act(async () => h.alert.mock.calls.at(-1)![2].find((item: any) => item.style === 'destructive').onPress());
  };
  h.perform.mockRejectedValueOnce(new Error('Operation rejected'));
  await perform(); expect(h.invoke).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Operation rejected');
  await perform();
  expect(h.perform).toHaveBeenCalledTimes(2);
  expect(h.perform.mock.calls[1][0].actionId).toBe(`routine-${operation}`);
  expect(h.invoke.mock.calls[1][2].actionId).not.toBe(h.invoke.mock.calls[0][2].actionId);
});

async function confirmDelete() {
  await click('delete');
  await act(async () => h.alert.mock.calls.at(-1)![2].find((item: any) => item.style === 'destructive').onPress());
}

it.each(['ios', 'android'])('returns to a fresh list when delete succeeded but its acknowledgement was lost on %s', async platform => {
  h.platform = platform;
  await openExisting();
  h.perform.mockImplementationOnce(async () => {
    h.existing = false;
    throw new Error('Response lost');
  });
  h.read.mockImplementation((_invoke, _target, ref) => {
    if (ref.id === 'bot:bot/rule' && !h.existing) {
      // Device-link IPC transports a bracketed message; also accept structured errors.
      throw platform === 'ios' ? new Error('[NOT_FOUND] Automation unavailable')
        : Object.assign(new Error('Automation unavailable'), { code: 'NOT_FOUND' });
    }
    return Promise.resolve(resource(ref.id));
  });
  await confirmDelete();
  expect(h.perform).toHaveBeenCalledOnce();
  expect(h.perform.mock.calls[0][0].actionId).toBe('routine-delete');
  expect(h.read.mock.calls.at(-1)![2].id).toBe('bot:bot');
  expect(container.querySelector('input[aria-label="name"]')).toBeNull();
  expect(container.textContent).toContain('empty');
  expect(container.textContent).not.toContain('loadFailed');
  expect(container.textContent).not.toContain('Existing');
});

it('retains delete reconciliation across a transient read failure and a manual retry', async () => {
  await openExisting();
  h.perform.mockRejectedValueOnce(new Error('Response lost'));
  h.read.mockRejectedValueOnce(new Error('Read unavailable'));
  await confirmDelete();
  expect(container.textContent).toContain('Response lost');
  expect(container.textContent).toContain('loadFailed');
  expect(input('name').value).toBe('Existing');
  h.existing = false;
  h.read.mockRejectedValueOnce(Object.assign(new Error('Automation unavailable'), { code: 'NOT_FOUND' }));
  await click('retry');
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(container.querySelector('input[aria-label="name"]')).toBeNull();
  expect(container.textContent).toContain('empty');
});

it('does not discard edits when a missing detail is unrelated to a pending delete', async () => {
  await openExisting(); await type('hour', '12');
  h.perform.mockRejectedValueOnce(new Error('Save rejected'));
  h.read.mockRejectedValueOnce(Object.assign(new Error('Automation unavailable'), { code: 'NOT_FOUND' }));
  await click('save');
  expect(input('hour').value).toBe('12');
  expect(container.textContent).toContain('Save rejected');
  expect(container.textContent).toContain('loadFailed');
});

it('reconciles a lost delete response after reconnecting without sending delete again', async () => {
  await openExisting();
  let reject!: (error: Error) => void;
  h.perform.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await confirmDelete(); await render(false);
  await act(async () => reject(new Error('Response lost')));
  expect(input('name').value).toBe('Existing');
  expect(container.textContent).toContain('Response lost');
  h.existing = false;
  h.read.mockRejectedValueOnce(Object.assign(new Error('Automation unavailable'), { code: 'NOT_FOUND' }));
  await render(true);
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(container.querySelector('input[aria-label="name"]')).toBeNull();
  expect(container.textContent).toContain('empty');
});

it('keeps edits made after an uncertain delete when a retry finds the detail missing', async () => {
  await openExisting();
  h.perform.mockRejectedValueOnce(new Error('Response lost'));
  h.read.mockRejectedValueOnce(new Error('Read unavailable'));
  await confirmDelete();
  await type('hour', '12');
  h.read.mockRejectedValueOnce(Object.assign(new Error('Automation unavailable'), { code: 'NOT_FOUND' }));
  await click('retry');
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(input('hour').value).toBe('12');
  expect(container.textContent).toContain('loadFailed');
});

it('keeps a successful save committed when the following run fails', async () => {
  await openExisting(); await type('hour', '12');
  h.perform.mockImplementationOnce(async request => {
    h.definition = request.input.definition; h.revision++;
    return { effects: [] };
  }).mockRejectedValueOnce(new Error('Run rejected'));
  await click('saveAndRun');
  expect(h.perform.mock.calls.map(([request]) => request.actionId)).toEqual(['routine-save', 'routine-run']);
  expect(input('hour').value).toBe('12');
  expect(container.textContent).toContain('Run rejected');
  await click('run');
  expect(h.perform.mock.calls.map(([request]) => request.actionId)).toEqual(['routine-save', 'routine-run', 'routine-run']);
  expect(h.perform.mock.calls[2][0].input.revision).toBe(2);
});
