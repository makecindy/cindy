// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAutomationSheet } from '../session/CompanionAutomationSheet';
import { emptyRoutineDefinition, type RoutineDefinition } from '../session/companionRoutines';

const h = vi.hoisted(() => ({
  read: vi.fn(), invoke: vi.fn(), openLink: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), changed: vi.fn(), close: vi.fn(),
  alert: vi.fn(), account: 1, foreground: null as null | ((state: string) => void), nativeWrites: vi.fn(),
  definition: null as any, revision: 1, sheet: null as any,
}));
vi.mock('react-i18next', () => { const t = (key: string) => key.split('.').at(-1)!; return { useTranslation: () => ({ t, i18n: { language: 'en' } }) }; });
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }, StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
  View: 'div', Pressable: 'button', Switch: 'input', ScrollView: 'div', ActivityIndicator: 'span',
  useWindowDimensions: () => ({ width: 402, height: 874 }), Alert: { alert: h.alert },
  AppState: { addEventListener: (_name: string, fn: any) => { h.foreground = fn; return { remove() {} }; } },
}));
vi.mock('@/components/AppText', () => ({ Text: 'span', TextInput: () => { throw new Error('iOS automation must not mount the RN input path'); } }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, Clock3: () => null, Plus: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'created-trigger' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.account }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink, subscribe: h.subscribe, unsubscribe: h.unsubscribe, onRemoteResourceChanged: h.changed, connectionEpoch: 1 }) }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: (...args: any[]) => h.read(...args), invokeRemoteResourceAction: (...args: any[]) => h.invoke(...args) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (error: Error) => error.message }));
vi.mock('@/theme', () => ({ iconSize: { action: 20, lg: 24, xs: 12 }, spacing: { xs: 4, sm: 8, md: 12 }, useTheme: () => ({ mode: 'light', colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('../session/CompanionChoice', () => ({ CompanionChoice: () => null }));
vi.mock('../session/CompanionSheet', () => ({ CompanionSheet: () => { throw new Error('legacy automation sheet mounted'); } }));
vi.mock('../session/CompanionAutomationNativeView', async () => import('../session/CompanionAutomationNativeView.ios'));
vi.mock('../session/ComposerSheet', async () => import('../session/ComposerSheet.ios'));
vi.mock('../session/ComposerNativeSection', () => ({ ComposerNativeSection: ({ title, children }: any) => <section aria-label={title}>{children}</section> }));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'buttonStyle', 'contentShape', 'disabled', 'font', 'foregroundStyle', 'frame', 'keyboardType', 'lineLimit', 'pickerStyle', 'tag', 'textInputAutocapitalization', 'padding', 'presentationDetents', 'interactiveDismissDisabled', 'presentationDragIndicator', 'scrollContentBackground'].map(name => [name, (value: any) => ({ name, value })])),
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
    Text: (props: any) => mod(props, 'tag') !== undefined ? <option value={mod(props, 'tag')}>{props.children}</option> : <span>{props.children}</span>,
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
function resource(selected: boolean) {
  return { ref: { collectionId: 'routines', kind: 'routine', id: selected ? 'bot:bot/new' : 'bot:bot' }, display: { title: 'Automations' }, links: [], revision: String(h.revision),
    actions: [{ id: 'opaque-create', label: 'Create' }], blocks: [{ primitive: selected ? 'routine-detail' : 'routine-list', data: selected
      ? { id: null, revision: h.revision, editable: true, input: h.definition, sources: [{ id: 'mail', name: 'Mail', status: 'ready', events: [{ type: 'received', name: 'Received', fields: ['sender', 'subject'] }] }], history: [], operationActions: { 'routine-create': 'opaque-create' } }
      : { items: [], operationActions: { 'routine-create': 'opaque-create' } } }] };
}
async function render() { await act(async () => root.render(<CompanionAutomationSheet visible online onClose={h.close} botId="bot" collectionId="routines" deviceId="host" deviceName="Mac" />)); }
function input(label: string) { const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!node) throw new Error(`Missing ${label}`); return node; }
async function type(label: string, value: string) { await act(async () => { const field = input(label); field.focus(); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function click(label: string) { await act(async () => { const button = [...container.querySelectorAll('button')].find(node => node.textContent === label); if (!button) throw new Error(`Missing ${label}`); button.click(); }); }
async function select(label: string, value: string) { await act(async () => { const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function open() { await render(); await click('new'); }
beforeEach(() => {
  vi.clearAllMocks(); h.account = 1; h.revision = 1; h.definition = emptyRoutineDefinition();
  h.changed.mockReturnValue(() => {}); h.openLink.mockResolvedValue(undefined);
  h.read.mockImplementation((_invoke, _target, ref) => Promise.resolve(resource(ref.id.endsWith('/new'))));
  h.invoke.mockResolvedValue({ effects: [] });
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
  await click('save');
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(h.invoke.mock.calls[0][2]).toMatchObject({ actionId: 'opaque-create', input: { revision: 1, definition: { name: '应该', prompt: 'Check the inbox', triggers: [{ expression: '05 08 * * *' }] } } });
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

it('preserves values and shows the host error after an invalid time is rejected', async () => {
  await open(); await type('name', 'Brief'); await type('instructions', 'Summarize'); await type('hour', '123');
  h.invoke.mockRejectedValueOnce(new Error('Invalid cron hour'));
  await click('save');
  expect(input('hour').value).toBe('123'); expect(container.textContent).toContain('Invalid cron hour');
  await type('hour', '12'); await click('save');
  expect(h.invoke.mock.calls[1][2].input.definition.triggers[0].expression).toBe('0 12 * * *');
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
