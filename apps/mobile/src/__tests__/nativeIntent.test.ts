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
import { redirectSystemPath } from '../../app/+native-intent';

const invitation = 'A'.repeat(43);
const incoming = 'cindy://shared-session?invitation=' + invitation + '&server=https%3A%2F%2Frelay.example.test';
const shareInvitation = 'B'.repeat(43);
const shareIncoming = 'cindy://provider-share/join?invitation=' + shareInvitation + '&server=https%3A%2F%2Frelay.example.test%2Fdl';
const shareWebLink = 'https://relay.example.test/dl/provider-share/join#' + shareInvitation;
beforeEach(() => { vi.useFakeTimers(); clearSharedTaskInvitationIntent(); clearProviderShareLinkIntent(); setMobileAuthOwner(null); });
afterEach(() => { clearSharedTaskInvitationIntent(); clearProviderShareLinkIntent(); vi.useRealTimers(); });

describe('mobile native deep-link redirects', () => {
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

  it('waits for a pending batch on cold start and preserves the warm share handoff', () => {
    expect(redirectSystemPath({
      path: 'cindycn://expo-sharing',
      initial: true,
    })).toBe('/');
    expect(redirectSystemPath({
      path: '/expo-sharing?source=share-extension',
      initial: false,
    })).toBe('/sessions/new');
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
