import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/env', () => ({
  WECHAT_APP_ID: 'wx-test-mobile',
  WECHAT_UNIVERSAL_LINK: 'https://login.example.com/app/',
}));

import { setMobileAuthOwner, invalidateMobileAuthOwnerForSwitch } from '@/auth/authOwnerGeneration';
import { clearSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';
import {
  clearProviderShareLinkIntent,
  peekProviderShareLinkIntentForTest,
  takeProviderShareLinkIntent,
} from '@/device-link/providerShareLinkIntent';
import { clearRelayJoinIntent, getPendingRelayJoinIntent } from '@/device-link/relayJoinIntent';
import { redirectSystemPath } from '../../app/+native-intent';
import { closeChatInvite, getChatInviteIntent, openManualChatInvite } from '@/chat/chatInviteIntent';

const invitation = 'A'.repeat(43);
const incoming = 'cindy://shared-session?invitation=' + invitation + '&server=https%3A%2F%2Frelay.example.test';
const shareInvitation = 'B'.repeat(43);
const shareIncoming = 'cindy://provider-share/join?invitation=' + shareInvitation + '&server=https%3A%2F%2Frelay.example.test%2Fdl';
const shareWebLink = 'https://relay.example.test/dl/provider-share/join#' + shareInvitation;
const relayCode = 'R'.repeat(43);
const relayOwnerKey = 'Q'.repeat(43);
const relayPairSecret = 'S'.repeat(43);
const relayUnsignedIncoming = 'cindy://relay/join?u=' + encodeURIComponent('https://relay.home.example:47820/') + '&c=' + relayCode;
const relayIncoming = relayUnsignedIncoming + '&o=' + relayOwnerKey + '&s=' + relayPairSecret;
function clearChatInvite() {
  const pending = getChatInviteIntent();
  if (pending) closeChatInvite(pending.id);
}
beforeEach(() => { vi.useFakeTimers(); clearSharedTaskInvitationIntent(); clearProviderShareLinkIntent(); clearRelayJoinIntent(); clearChatInvite(); setMobileAuthOwner(null); });
afterEach(() => { clearSharedTaskInvitationIntent(); clearProviderShareLinkIntent(); clearRelayJoinIntent(); clearChatInvite(); vi.useRealTimers(); });

describe('mobile native deep-link redirects', () => {
  // A2 contract: the actual native entry must redact the invite before routing,
  // preserve it across login, and never replace an active confirmation. Existing
  // shared-task/provider tests do not cover group invitations. Unit tier: one
  // native URL plus account changes, no network, storage or native runtime.
  it.each([true, false])('receives group invitations without routing their token (initial=%s)', initial => {
    for (const path of [
      `cindy://chat-invite/${invitation}`,
      `cindycn://chat-invite/${invitation}`,
      `cindydev://chat-invite/${invitation}`,
      `/chat-invite/${invitation}`,
      `https://public.example.invalid/dl/chat-invite/join#${invitation}?app=cindycn`,
      `/dl/chat-invite/join#${invitation}?app=cindydev`,
    ]) {
      const route = redirectSystemPath({ path, initial });
      expect(route).toBe(initial ? '/' : null);
      expect(getChatInviteIntent()).toMatchObject({ link: `cindy://chat-invite/${invitation}`, hasOtherInvitation: false });
      expect(getPendingSharedTaskInvitationIntent()).toBeNull();
      clearChatInvite();
    }
  });

  it('shows the local format result without retaining malformed input or selecting its server', () => {
    for (const path of [
      'cindy://chat-invite/short',
      `cindycn://chat-invite/${invitation}?secret=fixture`,
      `cindydev://chat-invite/${invitation}#fixture`,
      `other://chat-invite/${invitation}`,
      `cindy://CHAT-INVITE/${invitation}`,
      `/chat-invite/join#${invitation}?app=other`,
      `https://user@public.example.invalid/chat-invite/join#${invitation}`,
      `http://public.example.invalid/chat-invite/join#${invitation}`,
      `/chat-invite/join?token=${invitation}`,
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
      expect(getChatInviteIntent()).toMatchObject({ link: 'cindy://chat-invite/' });
      clearChatInvite();
    }
  });

  it('retains the original group target through unsuccessful login and account changes until closed', () => {
    redirectSystemPath({ path: `cindy://chat-invite/${invitation}`, initial: true });
    const target = getChatInviteIntent()!;
    redirectSystemPath({ path: 'cindy://auth?error=access_denied', initial: false });
    expect(getChatInviteIntent()).toBe(target);
    setMobileAuthOwner('first');
    invalidateMobileAuthOwnerForSwitch();
    setMobileAuthOwner('second', 'cn');
    expect(getChatInviteIntent()).toBe(target);
    closeChatInvite(target.id);
    expect(getChatInviteIntent()).toBeNull();
  });

  it('deduplicates a group link and leaves a different invitation to be reopened', () => {
    redirectSystemPath({ path: `cindy://chat-invite/${invitation}`, initial: false });
    const target = getChatInviteIntent()!;
    redirectSystemPath({ path: `cindycn://chat-invite/${invitation}`, initial: false });
    expect(getChatInviteIntent()).toBe(target);
    redirectSystemPath({ path: `cindy://chat-invite/${shareInvitation}`, initial: false });
    expect(getChatInviteIntent()).toEqual({ ...target, hasOtherInvitation: true });
    closeChatInvite(target.id);
    expect(getChatInviteIntent()).toBeNull(); // No pending FIFO is exposed after closing.
  });

  it('shares manual entry with the external host and ignores a stale close callback', () => {
    openManualChatInvite();
    const manual = getChatInviteIntent()!;
    openManualChatInvite();
    expect(getChatInviteIntent()).toBe(manual);
    redirectSystemPath({ path: `cindy://chat-invite/${invitation}`, initial: false });
    expect(getChatInviteIntent()).toEqual({ ...manual, hasOtherInvitation: true });
    closeChatInvite(manual.id);
    redirectSystemPath({ path: `cindy://chat-invite/${invitation}`, initial: false });
    closeChatInvite(manual.id);
    expect(getChatInviteIntent()?.link).toBe(`cindy://chat-invite/${invitation}`);
  });

  it('keeps the invitation out of router state, survives login, and clears on an account change', () => {
    expect(redirectSystemPath({ path: incoming, initial: true })).toBe('/shared-session');
    expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation, server: 'https://relay.example.test' });
    setMobileAuthOwner('first');
    expect(getPendingSharedTaskInvitationIntent()).not.toBeNull();
    invalidateMobileAuthOwnerForSwitch();
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });
  it('handles a warm path and expires an unclaimed invitation', () => {
    redirectSystemPath({ path: incoming.replace('cindy:/', ''), initial: false });
    expect(getPendingSharedTaskInvitationIntent()).not.toBeNull();
    vi.advanceTimersByTime(15 * 60_000);
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });
  it.each([true, false])('normalizes both relative invitation routes without retaining secrets (initial=%s)', initial => {
    for (const route of ['/shared-session', '/shared-task/join']) {
      const path = route + incoming.slice(incoming.indexOf('?'));
      expect(redirectSystemPath({ path, initial })).toBe('/shared-session');
      expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation, server: 'https://relay.example.test' });
      expect(redirectSystemPath({ path: path + '&invitation=bad', initial })).toBe('/shared-session');
      expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    }
  });
  it('drops an earlier pending invitation when a malformed one arrives', () => {
    redirectSystemPath({ path: incoming, initial: false });
    expect(redirectSystemPath({ path: incoming + '&invitation=bad', initial: false })).toBe('/shared-session');
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });

  it.each([true, false])('sends provider-share links to the computer-only notice without the token (initial=%s)', initial => {
    for (const [path, link] of [
      [shareIncoming, shareWebLink],
      [shareIncoming.replace('cindy://', 'cindycn://'), shareWebLink + '?app=cindycn'],
      [shareIncoming.replace('cindy://', 'cindydev://'), shareWebLink + '?app=cindydev'],
      [shareIncoming.replace('cindy://', 'xdt-maker://'), shareWebLink],
      [shareIncoming.replace('cindy:/', ''), shareWebLink],
    ]) {
      const route = redirectSystemPath({ path, initial });
      expect(route).toBe('/provider-share');
      expect(takeProviderShareLinkIntent()).toEqual({ link });
      // 取走即清空;共享任务的邀请不受影响。
      expect(peekProviderShareLinkIntentForTest()).toBeNull();
      expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    }
  });

  it('keeps nothing for malformed provider-share links and never forwards their query', () => {
    redirectSystemPath({ path: shareIncoming, initial: false });
    for (const path of [
      shareIncoming + '&invitation=bad',
      shareIncoming + '#fragment',
      'cindy://provider-share/join?invitation=short&server=https%3A%2F%2Frelay.example.test',
      'cindy://provider-share/join?invitation=' + shareInvitation + '&server=http%3A%2F%2Frelay.example.test',
      'cindy://provider-share?invitation=' + shareInvitation,
      '/provider-share/other?invitation=' + shareInvitation,
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBe('/provider-share');
      expect(peekProviderShareLinkIntentForTest()).toEqual({ link: null });
    }
    expect(redirectSystemPath({ path: '/provider-shared?x=1', initial: false })).toBe('/provider-shared?x=1');
  });

  it('forgets an unopened provider-share link after its lifetime or an account change', () => {
    redirectSystemPath({ path: shareIncoming, initial: true });
    vi.advanceTimersByTime(5 * 60_000);
    expect(peekProviderShareLinkIntentForTest()).toBeNull();

    setMobileAuthOwner('first');
    redirectSystemPath({ path: shareIncoming, initial: false });
    expect(peekProviderShareLinkIntentForTest()).toEqual({ link: shareWebLink });
    invalidateMobileAuthOwnerForSwitch();
    expect(peekProviderShareLinkIntentForTest()).toBeNull();
  });

  // Self-hosted relay join (docs/self-hosted-relay-plan.md §5.1): the one-time join code is a secret,
  // so the router only ever sees the bare join page; the parsed link lives in memory for that page.
  it.each([true, false])('routes relay join links to the join page without the join code (initial=%s)', initial => {
    for (const path of [
      relayIncoming,
      relayIncoming.replace('cindy://', 'cindycn://'),
      relayIncoming.replace('cindy://', 'cindydev://'),
      relayIncoming.replace('cindy:/', ''),
      relayIncoming.replace('cindy://', ''),
    ]) {
      const route = redirectSystemPath({ path, initial });
      expect(route).toBe('/relay-join');
      expect(getPendingRelayJoinIntent()?.link).toEqual({
        baseUrl: 'https://relay.home.example:47820',
        code: relayCode,
        ownerPublicKey: relayOwnerKey,
        pairSecret: relayPairSecret,
      });
      expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    }
  });

  it('keeps nothing for malformed relay join links and forgets a valid one after expiry or an account switch', () => {
    for (const path of [
      relayIncoming.replace('c=' + relayCode, 'c=short'),
      // Pre-signature links carry no owner key / pairing secret, so the certificate could never be checked.
      relayUnsignedIncoming,
      'cindy://relay/join?u=' + encodeURIComponent('ftp://relay.home.example') + '&c=' + relayCode,
      'xdt-maker://relay/join?u=https%3A%2F%2Frelay.home.example&c=' + relayCode,
      '/relay?c=' + relayCode,
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBe('/relay-join');
      expect(getPendingRelayJoinIntent()?.link).toBeNull();
    }
    redirectSystemPath({ path: relayIncoming, initial: true });
    vi.advanceTimersByTime(10 * 60_000);
    expect(getPendingRelayJoinIntent()).toBeNull();

    redirectSystemPath({ path: relayIncoming, initial: false });
    setMobileAuthOwner('first'); // the first sign-in claims a link scanned while signed out
    expect(getPendingRelayJoinIntent()?.link).not.toBeNull();
    invalidateMobileAuthOwnerForSwitch();
    expect(getPendingRelayJoinIntent()).toBeNull();
  });

  // 首次登录的真实账号发布顺序：匿名扫码 → switching 缓存清理 → 账号提交。
  // 旧测试只直接 setMobileAuthOwner，漏掉了会清空扫码意图的中间步骤。tier: unit，生产深链入口。
  it('preserves an anonymous relay join through fresh-login cleanup and clears it on a later account switch', () => {
    expect(redirectSystemPath({ path: relayIncoming, initial: true })).toBe('/relay-join');
    const original = getPendingRelayJoinIntent();
    invalidateMobileAuthOwnerForSwitch();
    expect(getPendingRelayJoinIntent()).toBe(original);
    setMobileAuthOwner('first');
    expect(getPendingRelayJoinIntent()).toBe(original);
    invalidateMobileAuthOwnerForSwitch();
    expect(getPendingRelayJoinIntent()).toBeNull();
  });

  it.each([true, false])('keeps WeChat SDK callbacks out of navigation (initial=%s)', (initial) => {
    for (const path of [
      'cindycn://oauth?code=test-wechat-code&state=test-state',
      'wx-test-mobile://oauth?code=test-wechat-code&state=test-state',
      '/oauth/?code=test-wechat-code#fragment',
      'wx-test-mobile://refreshToken?wechat_auth_context_id=test-context',
      'https://login.example.com/app/wx-test-mobile/oauth?code=test-wechat-code',
      'https://login.example.com/app/wx-test-mobile/refreshToken/',
      'https://login.example.com/app/oauth?code=test-wechat-code',
      'cindycn://app/wx-test-mobile/oauth?code=test-wechat-code',
      '/app/wx-test-mobile/refreshToken/',
      'https://login.example.com/app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload&_wechat_sdk_biz_data_len=12',
      'cindycn://app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload&_wechat_sdk_biz_data_len=12',
      '/app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload',
    ]) {
      expect(redirectSystemPath({ path, initial })).toBe('/');
    }
  });

  it('does not consume unrelated paths, hosts or app IDs', () => {
    for (const path of [
      'cindycn://oauth/another-route',
      'https://other.example.com/app/oauth?code=test-code',
      'https://login.example.com/elsewhere/oauth',
      'https://login.example.com/app/wx-other/oauth',
      'https://login.example.com/app/article',
      'https://user@login.example.com/app/oauth',
      'https://other.example.com/app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-other/?_wechat_sdk_biz_data=test-payload',
      'cindycn://elsewhere/wx-test-mobile/?_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-test-mobile/article?_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-test-mobile/',
      'cindycn://app/wx-test-mobile/?other=test-payload#_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-test-mobile/?_wechat_sdk_biz_data_extra=test-payload',
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });

  it('lets the pending-batch bridge own cold and warm share navigation', () => {
    expect(redirectSystemPath({
      path: 'cindycn://expo-sharing',
      initial: true,
    })).toBe('/');
    expect(redirectSystemPath({
      path: '/expo-sharing?source=share-extension',
      initial: false,
    })).toBeNull();
  });

  it.each(['cindy://auth?code=fixture&state=fixture', 'cindycn://auth?error=access_denied&state=fixture', '/auth?code=fixture'])('keeps the current route for warm OAuth callbacks: %s', path => {
    expect(redirectSystemPath({path, initial: false})).toBeNull();
    expect(redirectSystemPath({path, initial: true})).toBe('/');
  });

  it('preserves existing auth and ordinary deep-link behavior', () => {
    expect(redirectSystemPath({
      path: 'cindy://auth?code=abc',
      initial: true,
    })).toBe('/');
    expect(redirectSystemPath({
      path: '/sessions/session-1',
      initial: false,
    })).toBe('/sessions/session-1');
  });
});
