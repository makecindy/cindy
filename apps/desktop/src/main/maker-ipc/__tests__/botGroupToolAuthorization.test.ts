import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeGroupTool, registerGroupToolAuthority, GroupToolAuthorizationError } from '../botGroupToolAuthorization.js';
import { setMainLocale } from '../../i18n.js';

const releases: Array<() => void> = [];
afterEach(() => { releases.splice(0).forEach(release => release()); setMainLocale('en'); });

describe('live group tool authority', () => {
  it.each(['owner', 'tools'] as const)('allows self inspection with %s authority', async mode => {
    const validate = vi.fn(async () => {});
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode, validate, isCurrent: () => true }));
    await expect(authorizeGroupTool('lane', 'bot', 'read-self')).resolves.toBeDefined();
    expect(validate).toHaveBeenCalledOnce();
    if (mode === 'tools') await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).rejects.toMatchObject({ code: 'GROUP_AUTHORIZATION_REQUIRED' });
  });
  it('refuses persisted lanes, chat-only grants and another bot identity', async () => {
    await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).rejects.toThrow();
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode: 'chat', validate: async () => {}, isCurrent: () => true }));
    await expect(authorizeGroupTool('lane', 'bot', 'read-self')).rejects.toThrow();
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode: 'owner', validate: async () => {}, isCurrent: () => true }));
    await expect(authorizeGroupTool('lane', 'other-bot', 'owner-action')).rejects.toThrow();
  });
  it('rejects stale completion after a new runtime replaces the same lane', async () => {
    let complete!: () => void;
    const oldRelease = registerGroupToolAuthority('lane', { botId: 'bot', mode: 'owner', isCurrent: () => true,
      validate: () => new Promise<void>(resolve => { complete = resolve; }) });
    releases.push(oldRelease);
    const pending = authorizeGroupTool('lane', 'bot', 'owner-action');
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode: 'owner', isCurrent: () => true, validate: async () => {} }));
    oldRelease(); complete();
    await expect(pending).rejects.toThrow();
    await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).resolves.toBeDefined();
  });
  it('rechecks revocation and refuses authority after the execution ends', async () => {
    let live = true;
    let revoked = false;
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode: 'owner', isCurrent: () => live,
      validate: async () => { if (revoked) throw new GroupToolAuthorizationError(); } }));
    const authority = await authorizeGroupTool('lane', 'bot', 'owner-action');
    live = false; expect(authority.assertCurrent).toThrow();
    live = true; revoked = true;
    await expect(authority.refresh()).rejects.toThrow();
    revoked = false; // Failed validation cannot revive the old execution.
    await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).rejects.toThrow();
  });
  it('cannot refresh an old operation using a replacement execution for the same lane', async () => {
    const grant = { botId: 'bot', mode: 'owner' as const, isCurrent: () => true, validate: async () => {} };
    releases.push(registerGroupToolAuthority('lane', grant));
    const old = await authorizeGroupTool('lane', 'bot', 'owner-action');
    releases.push(registerGroupToolAuthority('lane', { ...grant }));
    await expect(old.refresh()).rejects.toThrow();
    await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).resolves.toBeDefined();
  });
  it('denies transient failures but retries validation on the same live execution', async () => {
    const validate = vi.fn().mockRejectedValueOnce(new Error('network timeout')).mockResolvedValue(undefined);
    releases.push(registerGroupToolAuthority('lane', { botId: 'bot', mode: 'owner', isCurrent: () => true, validate }));
    await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).rejects.toMatchObject({ code: 'GROUP_AUTHORIZATION_UNAVAILABLE' });
    await expect(authorizeGroupTool('lane', 'bot', 'owner-action')).resolves.toBeDefined();
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const)('localizes a denied call in %s', async locale => {
    setMainLocale(locale);
    expect(new GroupToolAuthorizationError(true).message).not.toContain('groupTools.');
    await expect(authorizeGroupTool('unregistered', 'bot', 'owner-action')).rejects.toMatchObject({
      code: 'GROUP_AUTHORIZATION_REQUIRED', message: expect.not.stringContaining('groupTools.'),
    });
  });
});

// Unit: #8443 review distinguishes intentional permission tiers from revoked or
// unavailable authorization. Only failed live validation may notify the group.
it.each(['chat', 'tools', 'revoked', 'transport', 'stale', 'report-fails'])('keeps the original %s denial and reports only validation failures', async condition => {
  const onDenied = vi.fn(async (_error: GroupToolAuthorizationError) => { if (condition === 'report-fails') throw new Error('report unavailable'); });
  releases.push(registerGroupToolAuthority('notice-lane', {
    botId: 'bot', mode: condition === 'chat' ? 'chat' : condition === 'tools' ? 'tools' : 'owner',
    isCurrent: () => condition !== 'stale', onDenied,
    validate: async () => {
      if (condition === 'transport') throw new Error('private test-only transport detail');
      throw new GroupToolAuthorizationError();
    },
  }));
  await expect(authorizeGroupTool('notice-lane', 'bot', 'owner-action')).rejects.toMatchObject({
    code: condition === 'transport' ? 'GROUP_AUTHORIZATION_UNAVAILABLE' : 'GROUP_AUTHORIZATION_REQUIRED',
  });
  await Promise.resolve();
  if (['chat', 'tools', 'stale'].includes(condition)) expect(onDenied).not.toHaveBeenCalled();
  else {
    expect(onDenied).toHaveBeenCalledOnce();
    expect(onDenied.mock.calls[0][0]).toBeInstanceOf(GroupToolAuthorizationError);
    expect(onDenied.mock.calls[0][0].message).not.toContain('private test-only');
  }
});
