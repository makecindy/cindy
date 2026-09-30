// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionImportApi } from '@cindy/maker-shared/companion-import';
import { BotImportForm } from '../BotImportForm';

const portraits = vi.hoisted(() => ({ load: vi.fn(async (index: number) => `data:image/png;base64,portrait-${index}`) }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../BotPortraitPicker', () => ({ BOT_PORTRAIT_COUNT: 17, galleryPortrait: portraits.load, BotPortraitPicker: ({ onChange, disabled }: { onChange(value: string): void; disabled: boolean }) => <button disabled={disabled} onClick={() => onChange('data:image/png;base64,chosen')}>existing-portrait-picker</button> }));
beforeEach(() => portraits.load.mockClear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('draws from the existing full gallery once per form and retains the choice through editing', async () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }], preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [] }), status: async () => undefined,
    start: vi.fn(async input => ({ requestId: input.requestId, botId: 'bot', status: 'complete' as const, checks: [] })) };
  const props = { api, onCreated() {}, onBack() {}, onBusy() {} };
  const first = render(<BotImportForm {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  await screen.findByRole('button', { name: 'existing-portrait-picker' });
  expect(portraits.load).toHaveBeenCalledWith(0);
  random.mockReturnValue(0.9999);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Grace' } });
  first.rerender(<BotImportForm {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ name: 'Grace', avatarImageBase64: 'portrait-0' })));
  expect(portraits.load).toHaveBeenCalledTimes(1);
  first.unmount();
  render(<BotImportForm {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  await screen.findByRole('button', { name: 'existing-portrait-picker' });
  expect(portraits.load).toHaveBeenLastCalledWith(16);
});

it('preserves an imported portrait instead of replacing it with a gallery default', async () => {
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }], preview: async () => ({ id: 'preview', name: 'Ada', avatarImageBase64: 'source-artwork', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [] }), status: async () => undefined,
    start: vi.fn(async input => ({ requestId: input.requestId, botId: 'bot', status: 'complete' as const, checks: [] })) };
  render(<BotImportForm api={api} onCreated={() => {}} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ avatarImageBase64: 'source-artwork' })));
  expect(portraits.load).not.toHaveBeenCalled();
});

it('clears a previous receipt after a definitive name conflict so the user can rename and submit a new request', async () => {
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }],
    preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [] }), status: async () => undefined,
    start: vi.fn<CompanionImportApi['start']>()
      .mockImplementationOnce(async input => ({ requestId: input.requestId, botId: 'bot', status: 'needs-attention', checks: [] }))
      .mockRejectedValueOnce(new Error("Error invoking remote method 'companion-import': Error: [IMPORT_NAME_EXISTS] Import rejected"))
      .mockImplementation(async input => ({ requestId: input.requestId, botId: 'new-bot', status: 'complete', checks: [] })) };
  render(<BotImportForm api={api} onCreated={() => {}} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.import.submit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.import.retry' }));
  await screen.findByRole('button', { name: 'bots.import.submit' });
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Grace' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(3));
  const requests = vi.mocked(api.start).mock.calls.map(call => call[0]);
  expect(requests[1]!.requestId).toBe(requests[0]!.requestId);
  expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId);
  expect(requests[2]!.name).toBe('Grace');
});

it.each(['SOURCE_FILE_TOO_LARGE', 'SOURCE_ITEM_TOO_LARGE', 'SOURCE_LINK_OUTSIDE_FOLDER', 'SOURCE_LINK_CYCLE', 'SOURCE_NOT_REGULAR_FILE', 'SOURCE_CHANGED', 'INTERNAL', 'IMPORT_FAILED'])('allows correcting a rejected skill after %s, retaining unknown requests', async code => {
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }],
    preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [{ id: 'skill', name: 'Optional skill', category: 'skills', selected: false }] }),
    status: async () => undefined,
    start: vi.fn<CompanionImportApi['start']>().mockRejectedValueOnce(new Error(`Error invoking remote method 'companion-import': Error: [${code}] Import rejected; INVALID_SELECTION PREVIEW_EXPIRED`)).mockImplementation(async input => ({ requestId: input.requestId, botId: 'bot', status: 'complete', checks: [] })) };
  render(<BotImportForm api={api} onCreated={() => {}} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: /bots.import.skills/ }));
  fireEvent.click(screen.getByLabelText('Optional skill'));
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.back' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(['INTERNAL', 'IMPORT_FAILED'].includes(code));
  expect((screen.getByRole('checkbox', { name: 'bots.import.skills' }) as HTMLInputElement).disabled).toBe(['INTERNAL', 'IMPORT_FAILED'].includes(code));
  if (!['INTERNAL', 'IMPORT_FAILED'].includes(code)) fireEvent.click(screen.getByRole('checkbox', { name: 'bots.import.skills' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.back' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await screen.findByRole('button', { name: 'bots.import.open' });
  const [first, second] = vi.mocked(api.start).mock.calls.map(call => call[0]);
  expect(first!.entryIds).toEqual(['skill']);
  expect(second!.entryIds).toEqual(['INTERNAL', 'IMPORT_FAILED'].includes(code) ? ['skill'] : []);
  expect(second!.requestId === first!.requestId).toBe(['INTERNAL', 'IMPORT_FAILED'].includes(code));
});

it.each(['PREVIEW_EXPIRED', 'SELECTION_CHANGED'])('returns to fresh sources after %s and submits a new editable preview', async code => {
  let attempt = 0;
  const api: CompanionImportApi = { sources: vi.fn(async () => [{ id: `source-${++attempt}`, name: 'Ada', kind: 'hermes' as const }]),
    preview: vi.fn(async sourceId => ({ id: `preview-${sourceId}`, name: 'Ada', source: { id: sourceId, name: 'Ada', kind: 'hermes' as const }, entries: [] })), status: async () => undefined,
    start: vi.fn<CompanionImportApi['start']>().mockRejectedValueOnce(new Error(`Error invoking remote method 'companion-import': Error: [${code}] Import rejected; INVALID_SELECTION PREVIEW_EXPIRED`)).mockImplementation(async input => ({ requestId: input.requestId, botId: 'bot', status: 'complete', checks: [] })) };
  render(<BotImportForm api={api} onCreated={() => {}} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.import.submit' }));
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  const input = await screen.findByRole('textbox');
  expect((input as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(input, { target: { value: 'Corrected' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
  const requests = vi.mocked(api.start).mock.calls.map(call => call[0]);
  expect(requests[1]).toMatchObject({ previewId: 'preview-source-2', name: 'Corrected' });
  expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
});

it('uses the original portrait control and sends only the items still selected', async () => {
  const api: CompanionImportApi = { sources: vi.fn<CompanionImportApi['sources']>(async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }]), preview: vi.fn<CompanionImportApi['preview']>(async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
    { id: 'memory', category: 'memory', name: 'USER.md', selected: true },
    { id: 'skill', category: 'skills', name: 'Useful skill', selected: true },
    { id: 'unused', category: 'skills', name: 'Unused skill', selected: false },
  ] })), status: vi.fn(async () => undefined), start: vi.fn<CompanionImportApi['start']>(async input => ({ requestId: input.requestId, botId: 'imported', canonicalSessionId: 'chat', status: 'complete', checks: [] })) };
  const open = vi.fn();
  render(<BotImportForm api={api} onCreated={open} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'existing-portrait-picker' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'bots.import.memory' }));
  // The unused skill remains unselected; the selected skill is deliberately kept.
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.start).mock.calls[0]![0]).toMatchObject({ name: 'Ada', entryIds: ['skill'], avatarImageBase64: 'chosen' });
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('imported'));
  expect(screen.queryByRole('button', { name: 'bots.import.open' })).toBeNull();
});


it('uses the existing credential checkboxes as alternatives without selecting an arbitrary account in bulk', async () => {
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }], preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
    { id: 'work', category: 'connections', name: 'Work', selected: false, exclusiveWith: ['personal'] },
    { id: 'personal', category: 'connections', name: 'Personal', selected: false, exclusiveWith: ['work'] },
  ] }), status: async () => undefined, start: vi.fn<CompanionImportApi['start']>(async input => ({ requestId: input.requestId, botId: 'bot', status: 'complete', checks: [] })) };
  render(<BotImportForm api={api} onCreated={() => {}} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  await screen.findByRole('button', { name: 'existing-portrait-picker' });
  fireEvent.click(screen.getByRole('button', { name: /bots.import.connections/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'bots.import.selectAll' }));
  expect((screen.getByLabelText('Work') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText('Work'));
  fireEvent.click(screen.getByLabelText('Personal'));
  expect((screen.getByLabelText('Work') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Personal') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.back' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ entryIds: ['personal'] })));
});

it('shows 142 selected skills in a flat searchable paginated list and opens chat after deferred setup', async () => {
  const entries = Array.from({ length: 142 }, (_, i) => ({ id: `skill-${i}`, category: 'skills' as const, name: `Skill ${i}`, selected: true }));
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }],
    preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries }), status: async () => undefined,
    start: async input => ({ requestId: input.requestId, botId: 'bot', canonicalSessionId: 'chat', status: 'needs-attention', saved: true, savedEntryIds: entries.map(entry => entry.id), checks: [{ entryId: 'skill-0', status: 'needs-attention', message: 'NATIVE_AUTH_REFRESH_REQUIRED' }] }) };
  const open = vi.fn();
  const { container } = render(<BotImportForm api={api} onCreated={open} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: /bots.import.skills/ }));
  expect(screen.getAllByRole('checkbox')).toHaveLength(21);
  expect(container.querySelector('details')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.next' }));
  expect(screen.getByLabelText('Skill 20')).toBeDefined();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Skill 141' } });
  expect((screen.getByLabelText('Skill 141') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.back' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('bot'));
  expect(screen.queryByRole('button', { name: 'bots.import.open' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'bots.import.retry' })).toBeNull();
});

it('distinguishes partial saves, setup-only checks and failed automations while leaving chat and retry available', async () => {
  const entries = [
    { id: 'partial', name: 'long-document.md', category: 'memory' as const, selected: true },
    { id: 'saved', name: 'ready.md', category: 'memory' as const, selected: true },
    { id: 'routine', name: 'Daily report', category: 'automations' as const, selected: true },
  ];
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }],
    preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries }), status: async () => undefined,
    start: vi.fn(async input => ({ requestId: input.requestId, botId: 'bot', canonicalSessionId: 'chat', saved: true, savedEntryIds: ['saved'], status: 'needs-attention' as const,
      checks: [{ entryId: 'partial', status: 'needs-attention' as const, message: 'IMPORT_DISK_FULL', progress: { saved: 1, total: 3 } }, { entryId: 'routine', status: 'needs-attention' as const, message: 'SOURCE_AUTOMATION_INVALID' }] })) };
  const created = vi.fn();
  render(<BotImportForm api={api} onCreated={created} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.import.submit' }));
  await screen.findByText('bots.import.partial');
  expect(screen.queryByText('bots.import.complete')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /bots.import.details/ }));
  expect(screen.getByText('long-document.md')).toBeTruthy();
  expect(screen.getByText(/bots.import.partlySaved.*bots.import.diskFull/)).toBeTruthy();
  expect(screen.getByText('1 / 3')).toBeTruthy();
  expect(screen.getByText(/bots.import.notSaved.*bots.import.automationInvalid/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bots.import.retry' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.open' }));
  expect(created).toHaveBeenCalledWith('bot');
});
