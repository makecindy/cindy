// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ invoke: vi.fn(), submit: vi.fn(), openLink: vi.fn(), created: vi.fn(), uuid: vi.fn(() => 'fixture-request-12345') }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (v: unknown) => v }, View: 'div', ScrollView: 'div',
  Pressable: ({ onPress, children }: any) => createElement('button', { onClick: onPress }, children),
  Switch: ({ accessibilityLabel, value, disabled, onValueChange }: any) => createElement('input', { type: 'checkbox', 'aria-label': accessibilityLabel, checked: value, disabled, onChange: (e: any) => onValueChange(e.target.checked) }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => h.uuid() }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.submit(...args) }));
vi.mock('@/components/AppText', () => ({ Text: 'span', TextInput: ({ value, editable, onChangeText }: any) => createElement('input', { value, disabled: !editable, onInput: (e: any) => onChangeText(e.target.value), onChange() {} }) }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => createElement('button', { onClick: action.onPress, disabled: action.disabled }, action.label) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: ({ children }: any) => children }));
vi.mock('@/session/CompanionPortraitPicker', () => ({ randomCompanionPortrait: async () => 'original-portrait', CompanionPortraitPicker: ({ onChange }: any) => createElement('button', { onClick: () => onChange('chosen-existing-portrait') }, 'existing portrait picker') }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useThemedStyles: () => ({}) }));
import { CompanionImportSheet } from '@/session/CompanionImportSheet';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.clearAllMocks(); h.uuid.mockReset().mockReturnValue('fixture-request-12345'); });
it('uses the existing portrait picker and sends only the remaining selections through the host resource', async () => {
  let imported = false;
  const result = { requestId: 'fixture-request-12345', botId: 'bot', canonicalSessionId: 'chat', status: 'complete', checks: [] };
  h.invoke.mockImplementation(async (_host: string, _channel: string, args: any[]) => {
    const id = args[0].ref.id;
    return { blocks: [{ primitive: 'companion-import', data: id === 'sources' ? { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] } : id.startsWith('preview:') ? { preview: { id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
      { id: 'personality', name: 'SOUL.md', category: 'personality', selected: true },
      { id: 'memory', name: 'USER.md', category: 'memory', selected: true },
      { id: 'unused', name: 'unused', category: 'skills', selected: false },
    ] } } : { result: imported ? result : null } }] };
  });
  h.submit.mockImplementation(async () => { imported = true; return { effects: [] }; });
  const container = document.createElement('div'); root = createRoot(container);
  await act(async () => root!.render(createElement(CompanionImportSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', online: true, onClose() {}, onCreated: h.created })));
  const click = async (text: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(button).toBeDefined(); button!.click(); }); };
  await click('Ada · Hermes');
  await click('existing portrait picker');
  await act(async () => (container.querySelector('[aria-label="devices.companionImport.memory"]') as HTMLInputElement).click());
  await click('devices.companionImport.submit');
  expect(h.submit.mock.calls[0]?.[2].input).toMatchObject({ entryIds: ['personality'], avatarImageBase64: 'chosen-existing-portrait' });
  await click('devices.companionImport.open'); expect(h.created).toHaveBeenCalledWith({ collectionId: 'teammates', kind: 'bot', id: 'bot' });
});


it.each(['IMPORT_NAME_EXISTS', 'INVALID_SELECTION', 'PROFILE_TEXT_TOO_LARGE', 'SOURCE_SNAPSHOT_TOO_LARGE', 'SOURCE_TOO_MANY_FILES', 'SOURCE_FILE_TOO_LARGE', 'SOURCE_ITEM_TOO_LARGE', 'SOURCE_LINK_OUTSIDE_FOLDER', 'SOURCE_LINK_CYCLE', 'SOURCE_NOT_REGULAR_FILE', 'SOURCE_CHANGED', 'INTERNAL'])('unlocks only definitive %s errors and preserves an ambiguous request', async code => {
  h.uuid.mockReturnValueOnce('fixture-request-original').mockReturnValue('fixture-request-corrected');
  h.invoke.mockImplementation(async (_host: string, _channel: string, args: any[]) => {
    const id = args[0].ref.id;
    return { blocks: [{ primitive: 'companion-import', data: id === 'sources' ? { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] } : id.startsWith('preview:') ? { preview: { id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
      { id: 'work', name: 'Work', category: 'connections', selected: false, exclusiveWith: ['personal'] },
      { id: 'personal', name: 'Personal', category: 'connections', selected: false, exclusiveWith: ['work'] },
    ] } } : { result: null } }] };
  });
  h.submit.mockRejectedValue(new Error(code === 'INTERNAL' ? '[INTERNAL] remote resource provider failed' : `[INVALID_PARAMS] ${code}`));
  const container = document.createElement('div'); root = createRoot(container);
  await act(async () => root!.render(createElement(CompanionImportSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', online: true, onClose() {}, onCreated: h.created })));
  const click = async (text: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith(text)); expect(button).toBeDefined(); button!.click(); }); };
  await click('Ada · Hermes');
  await click('devices.companionImport.connections');
  await act(async () => (container.querySelector('[aria-label="Work"]') as HTMLInputElement).click());
  await act(async () => (container.querySelector('[aria-label="Personal"]') as HTMLInputElement).click());
  expect((container.querySelector('[aria-label="Work"]') as HTMLInputElement).checked).toBe(false);
  await click('devices.companionImport.submit');
  const input = container.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  expect(input.disabled).toBe(code === 'INTERNAL');
  if (code !== 'INTERNAL') {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Corrected name');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[aria-label="Personal"]') as HTMLInputElement).click();
    });
  }
  await click('devices.companionImport.submit');
  const requests = h.submit.mock.calls.map(call => call[2].input);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ name: 'Ada', entryIds: ['personal'], requestId: 'fixture-request-original' });
  expect(requests[1]).toMatchObject(code === 'INTERNAL' ? requests[0] : { name: 'Corrected name', entryIds: [], requestId: 'fixture-request-corrected' });
});

it.each(['PREVIEW_EXPIRED', 'SELECTION_CHANGED'])('refreshes source IDs and allows a new selection after %s', async code => {
  let generation = 0;
  h.uuid.mockReturnValueOnce('fixture-original-request').mockReturnValue('fixture-new-request');
  h.invoke.mockImplementation(async (_host: string, _channel: string, args: any[]) => {
    const id = args[0].ref.id;
    return { blocks: [{ primitive: 'companion-import', data: id === 'sources' ? { sources: [{ id: `source-${++generation}`, name: 'Ada', kind: 'hermes' }] } : id.startsWith('preview:') ? { preview: { id: `preview-${generation}`, name: 'Ada', source: { id: `source-${generation}`, name: 'Ada', kind: 'hermes' }, entries: [] } } : { result: null } }] };
  });
  h.submit.mockRejectedValue(new Error(`[INVALID_PARAMS] ${code}`));
  const container = document.createElement('div'); root = createRoot(container);
  await act(async () => root!.render(createElement(CompanionImportSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', online: true, onClose() {}, onCreated: h.created })));
  const click = async (text: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(button).toBeDefined(); button!.click(); }); };
  await click('Ada · Hermes'); await click('devices.companionImport.submit');
  expect(generation).toBe(2);
  await click('Ada · Hermes');
  expect((container.querySelector('input') as HTMLInputElement).disabled).toBe(false);
  await click('devices.companionImport.submit');
  expect(h.submit.mock.calls.map(call => call[2].input)).toEqual([
    expect.objectContaining({ requestId: 'fixture-original-request', previewId: 'preview-1' }),
    expect.objectContaining({ requestId: 'fixture-new-request', previewId: 'preview-2' }),
  ]);
});

it('clears an earlier receipt after a name conflict and uses the existing editable form for a new request', async () => {
  h.uuid.mockReturnValueOnce('fixture-original-request').mockReturnValue('fixture-renamed-request');
  let hasReceipt = false;
  h.invoke.mockImplementation(async (_host: string, _channel: string, args: any[]) => {
    const id = args[0].ref.id;
    return { blocks: [{ primitive: 'companion-import', data: id === 'sources' ? { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] }
      : id.startsWith('preview:') ? { preview: { id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [] } }
      : { result: hasReceipt ? { requestId: 'fixture-original-request', botId: 'bot', status: 'needs-attention', checks: [] } : null } }] };
  });
  h.submit.mockReset().mockImplementationOnce(async () => { hasReceipt = true; return { effects: [] }; })
    .mockImplementation(async () => { hasReceipt = false; throw new Error('[INVALID_PARAMS] IMPORT_NAME_EXISTS'); });
  const container = document.createElement('div'); root = createRoot(container);
  await act(async () => root!.render(createElement(CompanionImportSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', online: true, onClose() {}, onCreated: h.created })));
  const click = async (text: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(button).toBeDefined(); button!.click(); }); };
  await click('Ada · Hermes');
  await click('devices.companionImport.submit');
  await click('devices.companionImport.retry');
  const input = container.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  expect(input.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Grace');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('devices.companionImport.submit');
  const requests = h.submit.mock.calls.map(call => call[2].input);
  expect(requests).toHaveLength(3);
  expect(requests[1].requestId).toBe(requests[0].requestId);
  expect(requests[2]).toMatchObject({ requestId: 'fixture-renamed-request', name: 'Grace' });
});

it('rejects an oversized action before freezing the selection and can submit after deselection', async () => {
  const avatar = 'a'.repeat(55_000);
  const entries = Array.from({ length: 400 }, (_, index) => ({ id: `entry-${index}-` + 'x'.repeat(30), name: `Entry ${index}`, category: 'memory', selected: true }));
  h.invoke.mockImplementation(async (_host: string, _channel: string, args: any[]) => {
    const id = args[0].ref.id;
    return { blocks: [{ primitive: 'companion-import', data: id === 'sources' ? { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] }
      : id.startsWith('preview:') ? { preview: { id: 'preview', name: 'Ada', avatarImageBase64: avatar, source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries } }
      : { result: null } }] };
  });
  h.submit.mockReset().mockResolvedValue({ effects: [] });
  const container = document.createElement('div'); root = createRoot(container);
  await act(async () => root!.render(createElement(CompanionImportSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', online: true, onClose() {}, onCreated: h.created })));
  const click = async (text: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(button).toBeDefined(); button!.click(); }); };
  await click('Ada · Hermes');
  await click('devices.companionImport.submit');
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.invoke.mock.calls.some(call => call[2][0].ref.id.startsWith('result:'))).toBe(false);
  expect((container.querySelector('input:not([type="checkbox"])') as HTMLInputElement).disabled).toBe(false);
  await act(async () => (container.querySelector('[aria-label="devices.companionImport.memory"]') as HTMLInputElement).click());
  await click('devices.companionImport.submit');
  expect(h.submit).toHaveBeenCalledTimes(1);
  const request = h.submit.mock.calls[0]![2];
  expect(request.input).toMatchObject({ entryIds: [], avatarImageBase64: avatar });
  const { parseRemoteActionInvokeRequest, REMOTE_RESOURCE_PROTOCOL_VERSION } = await import('@cindy/device-link');
  expect(parseRemoteActionInvokeRequest({ ...request, client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: [] } })).not.toBeNull();
});
