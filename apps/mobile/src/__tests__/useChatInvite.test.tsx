// @vitest-environment jsdom
// Unit: real invitation hook, bot-group-chat §10 account/explicit-accept contract.
// No earlier mobile hook existed. Minimal failures: double tap, late owner result, lost POST receipt.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ owner: 'one', preview: vi.fn(), accept: vi.fn(), close: vi.fn(), joined: vi.fn(), view: vi.fn(), uuid: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `operation-${++h.uuid}` }));
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => {
  const owner = h.owner;
  return { owner, enabled: true, current: () => owner === h.owner, client: { previewInvite: h.preview, acceptInvite: h.accept } };
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/chat/ChatInviteView', () => ({ ChatInviteView: (props: unknown) => { h.view(props); return null; } }));
import { ChatInviteSheet } from '@/chat/ChatInviteSheet';
import { useChatInvite, type ChatInviteSheetProps } from '@/chat/useChatInvite';
const token = 'A'.repeat(43);
const preview = { groupId: 'group', name: 'Weekend', inviterName: 'Lin', expiresAt: null, reusable: true, joined: false, memberCount: 8 };
let model: ReturnType<typeof useChatInvite>; let root: Root;
let props: ChatInviteSheetProps;
function App() { model = useChatInvite(props); return null; }
const render = () => act(async () => root.render(createElement(App)));
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); vi.clearAllMocks(); h.owner = 'one';
  h.preview.mockResolvedValue(preview); h.accept.mockResolvedValue({ groupId: 'group' });
  root = createRoot(document.createElement('div')); props = { visible: true, link: token, onClose: h.close, onJoined: h.joined };
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it('reads without accepting, blocks duplicate join and delivers only after sheet dismissal', async () => {
  await render(); expect(model.phase).toBe('preview'); expect(h.accept).not.toHaveBeenCalled();
  const pending = deferred<{ groupId: string }>(); h.accept.mockReturnValue(pending.promise);
  await act(async () => { model.accept(); model.accept(); model.close(); });
  expect(h.accept).toHaveBeenCalledTimes(1); expect(h.close).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ groupId: 'group' })); expect(h.close).toHaveBeenCalledTimes(1); expect(h.joined).not.toHaveBeenCalled();
  props.visible = false; await render();
  await act(async () => { model.closed(); model.closed(); }); expect(h.joined).toHaveBeenCalledExactlyOnceWith('group');
});
it.each([false, true])('manual continuation reads membership without joining (joined=%s)', async joined => {
  props.link = undefined;
  h.preview.mockResolvedValueOnce({ ...preview, joined });
  await act(async () => root.render(createElement(ChatInviteSheet, props)));
  await act(async () => h.view.mock.lastCall![0].model.setInput(token));
  await act(async () => h.view.mock.lastCall![0].primary.onPress());
  expect(h.preview).toHaveBeenCalledExactlyOnceWith(token, expect.any(AbortSignal));
  expect(h.accept).not.toHaveBeenCalled();
  if (joined) {
    expect(h.close).not.toHaveBeenCalled();
    expect(h.view.mock.lastCall![0].message).toBe('groupChat.invitation.alreadyMember');
    expect(h.view.mock.lastCall![0].primary.label).toBe('groupChat.invitation.openGroup');
    await act(async () => h.view.mock.lastCall![0].primary.onPress());
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
    props.visible = false;
    await act(async () => root.render(createElement(ChatInviteSheet, props)));
    await act(async () => h.view.mock.lastCall![0].model.closed());
    expect(h.joined).toHaveBeenCalledExactlyOnceWith('group');
  } else {
    expect(h.close).not.toHaveBeenCalled();
    expect(h.view.mock.lastCall![0].model.phase).toBe('preview');
    await act(async () => h.view.mock.lastCall![0].primary.onPress());
    expect(h.accept).toHaveBeenCalledOnce();
  }
});
it.each(['cindycn', 'cindydev'])('previews a pasted %s link through the current client and keeps manual editing', async scheme => {
  props.link = undefined; props.onTargetChange = vi.fn();
  await render();
  await act(async () => model.setInput(` \n${scheme}://chat-invite/${token}\n `));
  await act(async () => model.read());
  expect(model.phase).toBe('preview'); expect(model.manual).toBe(true);
  expect(h.preview).toHaveBeenCalledExactlyOnceWith(token, expect.any(AbortSignal));
  expect(props.onTargetChange).toHaveBeenCalledExactlyOnceWith(`cindy://chat-invite/${token}`);
  expect(h.accept).not.toHaveBeenCalled();
});
it('rejects a truncated app-scheme invitation before requesting a preview', async () => {
  props.link = undefined; props.onTargetChange = vi.fn();
  await render();
  await act(async () => model.setInput('cindydev://chat-invite/truncated'));
  await act(async () => model.read());
  expect(model.error).toBe('format'); expect(h.preview).not.toHaveBeenCalled();
  expect(props.onTargetChange).not.toHaveBeenCalled(); expect(h.accept).not.toHaveBeenCalled();
});
it('re-previews the same target for a new account and discards the previous account result', async () => {
  const old = deferred<typeof preview>(); h.preview.mockReturnValueOnce(old.promise);
  await render(); h.owner = 'two'; await render(); expect(model.preview).toEqual(preview);
  await act(async () => old.resolve({ ...preview, name: 'Old account', joined: true }));
  expect(model.preview?.name).toBe('Weekend'); expect(h.close).not.toHaveBeenCalled(); expect(h.joined).not.toHaveBeenCalled();
  expect(h.preview).toHaveBeenCalledTimes(2);
});
it('cancels reading and starts empty on manual re-entry without late navigation', async () => {
  const old = deferred<typeof preview>(); h.preview.mockReturnValue(old.promise); props.link = undefined; await render();
  await act(async () => model.setInput(token)); await act(async () => model.read());
  await act(async () => model.close()); props.visible = false; await render();
  await act(async () => old.resolve({ ...preview, joined: true }));
  await act(async () => { model.closed(); model.closed(); }); expect(h.joined).not.toHaveBeenCalled();
  props.visible = true; await render(); expect(model.input).toBe(''); expect(model.phase).toBe('input');
});
it('retries an uncertain acceptance with the same operation and expires a visible preview', async () => {
  await render(); h.accept.mockRejectedValueOnce(new Error('offline'));
  await act(async () => model.accept()); expect(model.error).toBe('uncertain');
  const operation = h.accept.mock.calls[0][1]; await act(async () => model.retry()); expect(h.accept.mock.calls[1][1]).toBe(operation);
  props.visible = false; await render(); h.preview.mockResolvedValue({ ...preview, expiresAt: new Date(Date.now() + 1000).toISOString() });
  props.visible = true; await render(); await act(async () => vi.advanceTimersByTimeAsync(1001));
  expect(model.error).toBe('expired'); expect(model.preview).toBeUndefined();
});
it('opens an existing membership without acceptance and bounds a hung request', async () => {
  h.preview.mockResolvedValueOnce({ ...preview, joined: true }); await render(); expect(h.accept).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
  expect(model.preview?.joined).toBe(true);
  await act(async () => model.accept());
  expect(h.accept).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalledTimes(1);
  props.visible = false; await render(); await act(async () => model.closed()); expect(h.joined).toHaveBeenCalledWith('group');
  h.preview.mockReturnValue(new Promise(() => {})); props.visible = true; await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_001)); expect(model.error).toBe('network');
  expect(h.preview.mock.calls.at(-1)?.[1].aborted).toBe(true);
});
it.each([['INVITATION_UNAVAILABLE', 'invalid'], ['FORBIDDEN', 'forbidden'], ['AUTH_REQUIRED', 'auth']])('shows the %s refusal without accepting', async (code, expected) => {
  h.preview.mockRejectedValueOnce(Object.assign(new Error('redacted'), { code })); await render();
  expect(model.error).toBe(expected); expect(model.preview).toBeUndefined(); expect(h.accept).not.toHaveBeenCalled();
});
it('does not use a late acceptance receipt after account replacement', async () => {
  await render(); const old = deferred<{ groupId: string }>(); h.accept.mockReturnValue(old.promise);
  await act(async () => model.accept()); h.owner = 'two'; await render();
  await act(async () => old.resolve({ groupId: 'old-group' })); expect(model.phase).toBe('preview'); expect(h.close).not.toHaveBeenCalled();
  props.visible = false; await render(); await act(async () => model.closed()); expect(h.joined).not.toHaveBeenCalled();
});
// Review regression: native controls can deliver a queued callback after an
// owner change or before the joining-disabled state reaches the native view.
it.each(['close', 'edit', 'read', 'setInput'] as const)('ignores stale %s controls from the previous account', async control => {
  props.link = undefined; await render();
  await act(async () => model.setInput(token)); await act(async () => model.read());
  const old = model;
  h.owner = 'two'; await render();
  const next = 'B'.repeat(43);
  await act(async () => model.edit()); await act(async () => model.setInput(next)); await act(async () => model.read());
  await act(async () => { if (control === 'setInput') old.setInput('stale input'); else old[control](); });
  expect(h.close).not.toHaveBeenCalled(); expect(model.phase).toBe('preview'); expect(model.input).toBe(next);
  h.preview.mockClear(); await act(async () => model.retry());
  expect(h.preview).toHaveBeenCalledExactlyOnceWith(next, expect.any(AbortSignal));
});
it('preserves a new account receipt when an old native dismissal arrives first', async () => {
  await render(); const old = model;
  h.owner = 'two'; await render(); await act(async () => model.accept());
  props.visible = false; await render();
  await act(async () => { old.closed(); model.closed(); });
  expect(h.joined).toHaveBeenCalledExactlyOnceWith('group');
});
it('keeps an accepted request alive when an edit callback races its disabled state', async () => {
  props.link = undefined; await render();
  await act(async () => model.setInput(token)); await act(async () => model.read());
  const pending = deferred<{ groupId: string }>(); h.accept.mockReturnValueOnce(pending.promise);
  await act(async () => { model.accept(); model.edit(); });
  expect(model.phase).toBe('joining'); expect(h.accept.mock.lastCall?.[2].aborted).toBe(false);
  await act(async () => pending.resolve({ groupId: 'group' })); expect(h.close).toHaveBeenCalledOnce();
});
it('keeps an empty input idle and rejects malformed manual input before HTTP', async () => {
  props.link = undefined; await render(); await act(async () => model.read()); expect(model.phase).toBe('input');
  await act(async () => model.setInput('https://example.invalid/broken')); await act(async () => model.read());
  expect(model.error).toBe('format'); expect(h.preview).not.toHaveBeenCalled();
});

// The external-link surface remains read-only even when token parsing fails.
it.each([false, true])('keeps malformed invitation entry editable only for manual paste (manual=%s)', async manual => {
  props.link = manual ? undefined : 'https://example.invalid/broken';
  await act(async () => root.render(createElement(ChatInviteSheet, props)));
  if (manual) {
    await act(async () => h.view.mock.lastCall![0].model.setInput('https://example.invalid/broken'));
    await act(async () => h.view.mock.lastCall![0].model.read());
  }
  const view = h.view.mock.lastCall![0];
  expect(view.model.error).toBe('format');
  expect(view.input).toBe(manual);
  expect(view.primary.label).toBe(manual ? 'groupChat.invitation.previewInvite' : 'groupChat.invitation.close');
  if (!manual) { await act(async () => view.primary.onPress()); expect(h.close).toHaveBeenCalledOnce(); }
  expect(h.accept).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
});

it('retains a manual target through authentication hiding, but re-reads it for the new owner', async () => {
  props.link = undefined; await render();
  await act(async () => model.setInput(token));
  await act(async () => model.read());
  expect(model.preview?.name).toBe('Weekend');
  props.visible = false; props.retainTargetWhenHidden = true; h.owner = 'signed-out'; await render();
  expect(h.preview).toHaveBeenCalledTimes(1);
  h.owner = 'two'; props.visible = true; props.retainTargetWhenHidden = false;
  h.preview.mockResolvedValueOnce({ ...preview, name: 'New owner preview' });
  await render();
  expect(h.preview).toHaveBeenCalledTimes(2);
  expect(h.preview.mock.lastCall?.[0]).toBe(token);
  expect(model.preview?.name).toBe('New owner preview');
  expect(h.accept).not.toHaveBeenCalled();
  expect(h.joined).not.toHaveBeenCalled();
});
