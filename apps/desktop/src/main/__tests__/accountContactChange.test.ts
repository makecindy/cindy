/**
 * 测试价值
 * - 生产入口与可观察结果:createAccountContactChangeHandlers 的 IPC 业务体;renderer 看到的
 *   是成功值或 auth-server 错误码,服务端看到的是带 account token 的四步请求。
 * - 规则依据:engineering-conventions §3(main 业务逻辑带主路径与关键错误路径测试)、
 *   server-channel-review(一次换绑只轮换一次 Passport 凭据,不按步骤重复轮换)。
 * - 现有覆盖缺口:换绑是新流程;账号注销 IPC 测试不覆盖票据留在 main、登录态变化作废流程。
 * - 最小失败输入:流程中途切换账号(epoch 变化)后继续提交新联系方式;另一窗口取消弹窗;
 *   服务端 429 带 Retry-After;旧账号请求在切换账号后才返回 ACCOUNT_UNAVAILABLE。
 * - tier:unit(内存 fake,无 Electron、无网络)。
 * - 实测耗时:单独运行约 1 秒。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { AuthApiError, type AccountContact } from '@cindy/auth-client';

import {
  createAccountContactChangeHandlers,
  type ContactChangeClient,
  type ContactChangeSession,
} from '../accountContactChange';

/** 发起换绑的窗口(webContents id)。 */
const W = 1;

function harness(options: { realm?: 'cn' | 'global'; contacts?: AccountContact[] } = {}) {
  const realm = options.realm ?? 'cn';
  let session: ContactChangeSession | null = { realm, passportId: 'passport-1', epoch: 1 };
  let now = 0;
  let tokenSeq = 0;
  const contacts: AccountContact[] = options.contacts ?? [
    { id: 'email-1', type: 'email', value: 'a***@example.com', verifiedAt: '2026-01-01T00:00:00.000Z', changeable: true },
    { id: 'phone-old', type: 'phone', value: '+8613****11', verifiedAt: '2026-01-01T00:00:00.000Z', changeable: true },
    { id: 'phone-new', type: 'phone', value: '+8613****55', verifiedAt: '2026-02-01T00:00:00.000Z', changeable: true },
  ];
  const client = {
    getAccountContacts: vi.fn(async () => contacts),
    requestCurrentContactChangeCode: vi.fn(async (_token: string, contactId: string) => ({
      status: 'sent' as const,
      channel: realm === 'cn' ? ('sms' as const) : ('email' as const),
      maskedTarget: contacts.find((c) => c.id === contactId)!.value,
    })),
    verifyCurrentContactChange: vi.fn(async (_token: string, _contactId: string, _code: string) => ({
      changeTicket: 'ticket-1',
      type: realm === 'cn' ? ('phone' as const) : ('email' as const),
      expiresAt: '2026-01-01T00:10:00.000Z',
    })),
    requestNewContactChangeCode: vi.fn(async () => undefined),
    confirmContactChange: vi.fn(async (_token: string, _ticket: string, target: { type: string }) => ({
      id: 'changed',
      type: target.type as 'phone' | 'email',
      value: target.type === 'phone' ? '+8613****66' : 'n***@example.com',
      verifiedAt: '2026-03-01T00:00:00.000Z',
    })),
  } satisfies ContactChangeClient;
  const protectedSessions: ContactChangeSession[] = [];
  const deps = {
    getSession: () => session,
    isSessionCurrent: (s: ContactChangeSession) =>
      session !== null && session.realm === s.realm && session.passportId === s.passportId && session.epoch === s.epoch,
    issueAccountToken: vi.fn(async () => `account-token-${++tokenSeq}`),
    createClient: () => client,
    runProtected: <T,>(session: ContactChangeSession, request: () => Promise<T>) => {
      protectedSessions.push(session);
      return request();
    },
    reloadProfile: vi.fn(async () => undefined),
    now: () => now,
    logWarn: vi.fn(),
  };
  const handlers = createAccountContactChangeHandlers(deps);
  return {
    handlers,
    client,
    deps,
    protectedSessions,
    setSession: (next: ContactChangeSession | null) => {
      session = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('account contact change handlers', () => {
  it.each([
    { realm: 'cn' as const, type: 'phone', value: '137 0000 6666', sent: '13700006666', masked: '+8613****66', reload: 0 },
    { realm: 'global' as const, type: 'email', value: ' New@Example.com ', sent: 'New@Example.com', masked: 'n***@example.com', reload: 1 },
  ])('changes the $type for a $realm account with one Passport rotation', async ({ realm, type, value, sent, masked, reload }) => {
    const { handlers, client, deps } = harness({ realm });

    expect(handlers.getAvailability()).toEqual({ available: true, type });
    const codeSent = await handlers.requestCurrentCode(W);
    expect(codeSent.success).toBe(true);
    // 同类型多条时换最近验证的那条
    const expectedContact = type === 'phone' ? 'phone-new' : 'email-1';
    expect(client.requestCurrentContactChangeCode).toHaveBeenCalledWith('account-token-1', expectedContact);
    await expect(handlers.verifyCurrentCode(W, '123456')).resolves.toEqual({ success: true, value: { type } });
    await expect(handlers.requestNewCode(W, value)).resolves.toEqual({ success: true, value: null });
    const target = type === 'phone' ? { type, phone: sent } : { type, email: sent };
    expect(client.requestNewContactChangeCode).toHaveBeenCalledWith('account-token-1', 'ticket-1', target);
    await expect(handlers.confirm(W, { value, code: '654321' })).resolves.toEqual({
      success: true,
      value: { type, maskedValue: masked },
    });
    expect(client.confirmContactChange).toHaveBeenCalledWith('account-token-1', 'ticket-1', target, '654321');
    expect(deps.issueAccountToken).toHaveBeenCalledTimes(1);
    expect(deps.reloadProfile).toHaveBeenCalledTimes(reload);

    // 完成后流程清空,不能拿旧票据再提交
    await expect(handlers.confirm(W, { value, code: '654321' })).resolves.toEqual({
      success: false,
      code: 'CONTACT_CHANGE_TICKET_INVALID',
    });
  });

  it('abandons the flow when the signed-in account changes mid-way', async () => {
    const { handlers, client, setSession } = harness();
    await handlers.requestCurrentCode(W);
    await handlers.verifyCurrentCode(W, '123456');

    setSession({ realm: 'cn', passportId: 'passport-2', epoch: 2 });
    await expect(handlers.requestNewCode(W, '13700006666')).resolves.toEqual({
      success: false,
      code: 'AUTH_FLOW_SUPERSEDED',
    });
    expect(client.requestNewContactChangeCode).not.toHaveBeenCalled();
    // 切回原账号也不能复用被作废的票据
    setSession({ realm: 'cn', passportId: 'passport-1', epoch: 1 });
    await expect(handlers.confirm(W, { value: '13700006666', code: '654321' })).resolves.toEqual({
      success: false,
      code: 'CONTACT_CHANGE_TICKET_INVALID',
    });
  });

  it('retries once with a fresh account token after the cached token expires', async () => {
    const { handlers, client, deps, advance } = harness();
    await handlers.requestCurrentCode(W);
    advance(5 * 60_000);
    client.verifyCurrentContactChange.mockRejectedValueOnce(
      new AuthApiError('TOKEN_EXPIRED', 401, 'expired'),
    );
    await expect(handlers.verifyCurrentCode(W, '123456')).resolves.toMatchObject({ success: true });
    expect(client.verifyCurrentContactChange.mock.calls.map(([token]) => token)).toEqual([
      'account-token-2',
      'account-token-3',
    ]);
    expect(deps.issueAccountToken).toHaveBeenCalledTimes(3);
  });

  it('keeps the ticket for retryable confirm errors and drops it when the server rejects it', async () => {
    const { handlers, client } = harness();
    await handlers.requestCurrentCode(W);
    await handlers.verifyCurrentCode(W, '123456');

    client.confirmContactChange.mockRejectedValueOnce(new AuthApiError('CONTACT_TAKEN', 409, 'taken'));
    await expect(handlers.confirm(W, { value: '13700006666', code: '654321' })).resolves.toEqual({
      success: false,
      code: 'CONTACT_TAKEN',
    });
    await expect(handlers.requestNewCode(W, '13700007777')).resolves.toMatchObject({ success: true });

    client.confirmContactChange.mockRejectedValueOnce(
      new AuthApiError('CONTACT_CHANGE_TICKET_INVALID', 400, 'expired'),
    );
    await expect(handlers.confirm(W, { value: '13700007777', code: '654321' })).resolves.toEqual({
      success: false,
      code: 'CONTACT_CHANGE_TICKET_INVALID',
    });
    await expect(handlers.requestNewCode(W, '13700007777')).resolves.toEqual({
      success: false,
      code: 'CONTACT_CHANGE_TICKET_INVALID',
    });
    expect(client.requestNewContactChangeCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'SSO or passive session',
      setup: (h: ReturnType<typeof harness>) => h.setSession(null),
      code: 'CONTACT_CHANGE_UNAVAILABLE',
    },
    {
      name: 'server without contact ids',
      contacts: [{ type: 'phone' as const, value: '+8613****11', verifiedAt: '2026-01-01T00:00:00.000Z' }],
      code: 'CONTACT_CHANGE_UNAVAILABLE',
    },
  ])('reports $name as unavailable without sending a code', async ({ setup, contacts, code }) => {
    const h = harness({ contacts });
    setup?.(h);
    await expect(h.handlers.requestCurrentCode(W)).resolves.toEqual({ success: false, code });
    expect(h.client.requestCurrentContactChangeCode).not.toHaveBeenCalled();
  });

  it('rejects malformed renderer input before contacting the server', async () => {
    const { handlers, client } = harness();
    await handlers.requestCurrentCode(W);
    await expect(handlers.verifyCurrentCode(W, '12ab56')).resolves.toEqual({ success: false, code: 'INVALID_PARAMS' });
    await handlers.verifyCurrentCode(W, '123456');
    await expect(handlers.requestNewCode(W, 'not-a-phone')).resolves.toEqual({ success: false, code: 'INVALID_PARAMS' });
    expect(client.verifyCurrentContactChange).toHaveBeenCalledTimes(1);
    expect(client.requestNewContactChangeCode).not.toHaveBeenCalled();
  });

  it('keeps each window\'s flow separate so another window cannot cancel or replace it', async () => {
    const { handlers, client } = harness();
    await handlers.requestCurrentCode(W);
    await handlers.verifyCurrentCode(W, '123456');

    // 另一窗口打开弹窗、发码后取消:只作废它自己的流程
    await expect(handlers.requestCurrentCode(2)).resolves.toMatchObject({ success: true });
    handlers.cancel(2);
    await expect(handlers.requestNewCode(2, '13700006666')).resolves.toEqual({
      success: false,
      code: 'CONTACT_CHANGE_TICKET_INVALID',
    });

    await expect(handlers.requestNewCode(W, '13700006666')).resolves.toEqual({ success: true, value: null });
    await expect(handlers.confirm(W, { value: '13700006666', code: '654321' })).resolves.toMatchObject({
      success: true,
    });
    expect(client.confirmContactChange).toHaveBeenCalledWith(
      expect.any(String),
      'ticket-1',
      { type: 'phone', phone: '13700006666' },
      '654321',
    );
  });

  it('runs every request under the session that started the flow', async () => {
    const { handlers, protectedSessions } = harness();
    await handlers.requestCurrentCode(W);
    await handlers.verifyCurrentCode(W, '123456');
    expect(protectedSessions).toEqual([
      expect.objectContaining({ realm: 'cn', passportId: 'passport-1', epoch: 1 }),
      expect.objectContaining({ realm: 'cn', passportId: 'passport-1', epoch: 1 }),
      expect.objectContaining({ realm: 'cn', passportId: 'passport-1', epoch: 1 }),
    ]);
  });

  it('passes a future Retry-After deadline back with RATE_LIMITED and drops stale ones', async () => {
    const { handlers, client, advance } = harness();
    advance(1_000);
    client.requestCurrentContactChangeCode.mockRejectedValueOnce(
      new AuthApiError('RATE_LIMITED', 429, 'slow down', 61_000),
    );
    await expect(handlers.requestCurrentCode(W)).resolves.toEqual({
      success: false,
      code: 'RATE_LIMITED',
      retryAt: 61_000,
    });

    client.requestCurrentContactChangeCode.mockRejectedValueOnce(
      new AuthApiError('RATE_LIMITED', 429, 'slow down', 500),
    );
    await expect(handlers.requestCurrentCode(W)).resolves.toEqual({ success: false, code: 'RATE_LIMITED' });
  });
});

/**
 * authManager 依赖 Electron,不能在 node 测试环境直接 import;沿用
 * authSessionExpiredDetection.test.ts 的做法,从源码取出真实函数转译后执行。
 */
describe('account-unavailable handling for contact change requests', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8');
  const file = ts.createSourceFile('authManager.ts', source, ts.ScriptTarget.Latest, true);
  const fn = (name: string) => {
    const node = file.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
    return ts.transpileModule(node.getText(file).replace(/^export\s+/, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  };

  function load(current: ContactChangeSession) {
    const invalidateSession = vi.fn(async () => undefined);
    const isContactChangeSessionCurrent = (s: ContactChangeSession) =>
      s.realm === current.realm && s.passportId === current.passportId && s.epoch === current.epoch;
    const runProtectedAccountRequest = new Function(
      'AuthApiError',
      'invalidateSession',
      'isContactChangeSessionCurrent',
      `${fn('runProtectedAuthRequest')}\n${fn('runProtectedAccountRequest')}\nreturn runProtectedAccountRequest;`,
    )(AuthApiError, invalidateSession, isContactChangeSessionCurrent) as <T>(
      session: ContactChangeSession,
      request: () => Promise<T>,
    ) => Promise<T>;
    return { runProtectedAccountRequest, invalidateSession };
  }

  const unavailable = () => Promise.reject(new AuthApiError('ACCOUNT_UNAVAILABLE', 401, 'gone'));

  it('signs out when the account that started the request is still the current one', async () => {
    const session = { realm: 'cn' as const, passportId: 'passport-1', epoch: 1 };
    const { runProtectedAccountRequest, invalidateSession } = load(session);
    await expect(runProtectedAccountRequest(session, unavailable)).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
    });
    expect(invalidateSession).toHaveBeenCalledWith('account-unavailable');
  });

  it('keeps the account the user switched to when an old request comes back unavailable', async () => {
    const { runProtectedAccountRequest, invalidateSession } = load({
      realm: 'cn',
      passportId: 'passport-2',
      epoch: 2,
    });
    await expect(
      runProtectedAccountRequest({ realm: 'cn', passportId: 'passport-1', epoch: 1 }, unavailable),
    ).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
    expect(invalidateSession).not.toHaveBeenCalled();
  });
});
