// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  region: 'cn', os: 'ios', base: 'https://share-cn.example.test',
  pending: [] as string[], listener: undefined as (() => void) | undefined,
  consume: vi.fn(), subscribe: vi.fn(), remove: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { get OS() { return h.os; } } }));
vi.mock('@/config/env', () => ({
  get AUTH_REGION() { return h.region; },
  getActiveMobileSessionRealm: () => h.region === 'global' ? 'global' : 'cn',
  getMobileEndpointForRealm: () => h.base,
}));
vi.mock('xdt-wechat-login', () => ({
  addWechatLaunchListener: h.subscribe,
  consumeWechatLaunchInfos: h.consume,
}));
import { useWechatChatInvite } from '@/chat/useWechatChatInvite';
import { closeChatInvite, getChatInviteIntent } from '@/chat/chatInviteIntent';

function Bridge() { useWechatChatInvite(); return null; }
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const current = getChatInviteIntent(); if (current) closeChatInvite(current.id);
  h.region = 'cn'; h.os = 'ios'; h.base = 'https://share-cn.example.test'; h.pending = []; h.listener = undefined;
  vi.clearAllMocks();
  h.subscribe.mockImplementation((listener: () => void) => { h.listener = listener; return { remove: h.remove }; });
  h.consume.mockImplementation(async () => h.pending.splice(0));
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  const current = getChatInviteIntent(); if (current) closeChatInvite(current.id);
});
const render = () => act(async () => root.render(createElement(Bridge)));
const deliver = (id: string) => act(async () => { h.pending.push(id); h.listener?.(); });

describe('WeChat invitation reception', () => {
  it.each(['ios', 'android'])('receives a cold-start invitation on %s through the existing intent', async os => {
    h.os = os; h.pending.push('A'.repeat(32)); await render();
    expect(getChatInviteIntent()?.link).toBe(`https://share-cn.example.test/chat-invite/${'A'.repeat(32)}`);
    expect(h.pending).toEqual([]);
  });

  it('retains the first invitation and reports a different warm-start invitation', async () => {
    await render(); await deliver('A'.repeat(32));
    const first = getChatInviteIntent()!;
    await deliver('A'.repeat(32)); expect(getChatInviteIntent()).toBe(first);
    await deliver('B'.repeat(32));
    expect(getChatInviteIntent()).toEqual({ ...first, hasOtherInvitation: true });
  });

  it('uses the configured dev endpoint without a production fallback', async () => {
    h.region = 'dev'; h.base = 'https://dev-share.example.test'; h.pending.push('A'.repeat(32));
    await render();
    expect(getChatInviteIntent()?.link).toBe(`https://dev-share.example.test/chat-invite/${'A'.repeat(32)}`);
  });

  it.each(['global', 'web'])('does not enable a WeChat bridge in %s', async environment => {
    if (environment === 'global') h.region = 'global'; else h.os = 'web';
    h.pending.push('A'.repeat(32)); await render();
    expect(h.subscribe).not.toHaveBeenCalled(); expect(h.consume).not.toHaveBeenCalled();
    expect(getChatInviteIntent()).toBeNull();
  });

  it.each(['', 'A'.repeat(31), 'A'.repeat(32) + '\n', 'https://untrusted.example/chat-invite/' + 'A'.repeat(32)])('rejects invalid launch data %j', async value => {
    h.pending.push(value); await render(); expect(getChatInviteIntent()).toBeNull();
  });

  it('does not open a late native response after unmounting', async () => {
    let resolve: ((value: string[]) => void) | undefined;
    h.consume.mockImplementation(() => new Promise<string[]>(done => { resolve = done; }));
    await render(); await act(async () => root.unmount());
    await act(async () => resolve?.(['A'.repeat(32)]));
    expect(getChatInviteIntent()).toBeNull(); expect(h.remove).toHaveBeenCalledOnce();
    root = createRoot(document.createElement('div'));
  });
});
