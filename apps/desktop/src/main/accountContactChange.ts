/**
 * accountContactChange.ts — 设置页「换绑手机号 / 邮箱」的 main 侧流程。
 *
 * auth-server 契约(Account Bearer):
 *   1. /api/me/identities 取联系方式 id → 向当前联系方式发码
 *   2. 验当前联系方式 → 一次性 changeTicket(10 分钟,绑定 Passport 与设备)
 *   3. 凭票据向新联系方式发码
 *   4. 验新联系方式 → 原子替换
 *
 * changeTicket 与 account token 只留在本模块内存,不进入 renderer、不落盘;登录态
 * 代际变化(登出、切换账号)后整条流程作废。account token 每次换绑流程只换取一次,
 * 在短窗口内复用,避免每一步都轮换保存的 Passport 凭据;过期时换取一次再重试。
 * Electron 注册只做 adapter,业务体依赖注入,便于不启动 Electron 测试。
 */

import {
  AuthApiError,
  type AccountContact,
  type AuthRegion,
  type ContactChangeCodeSent,
  type ContactChangeTarget,
  type ContactChangeTicket,
} from '@cindy/auth-client';

import {
  parseDesktopContactChangeCode,
  parseDesktopContactChangeValue,
  type DesktopContactChangeAvailability,
  type DesktopContactChangeCodeSent,
  type DesktopContactChangeCompleted,
  type DesktopContactChangeResult,
  type DesktopContactChangeType,
  type DesktopContactChangeVerified,
} from '../shared/authIpc';

/** 当前可换绑的 Passport 会话;SSO 会话、被动实例或没有 account 凭据时为 null。 */
export interface ContactChangeSession {
  realm: AuthRegion;
  passportId: string;
  /** 登录态代际;变化即说明登出或切换过账号。 */
  epoch: number;
}

/** auth-client 中换绑用到的方法子集。 */
export interface ContactChangeClient {
  getAccountContacts(accountToken: string): Promise<AccountContact[]>;
  requestCurrentContactChangeCode(accountToken: string, contactId: string): Promise<ContactChangeCodeSent>;
  verifyCurrentContactChange(accountToken: string, contactId: string, code: string): Promise<ContactChangeTicket>;
  requestNewContactChangeCode(accountToken: string, changeTicket: string, target: ContactChangeTarget): Promise<void>;
  confirmContactChange(
    accountToken: string,
    changeTicket: string,
    target: ContactChangeTarget,
    code: string,
  ): Promise<AccountContact>;
}

export interface AccountContactChangeDeps {
  /** 完整校验(含读取保存的 Passport 凭据);只在显示入口和开始流程时调用。 */
  getSession(): ContactChangeSession | null;
  /** 流程每一步之间的内存校验:发起流程的登录态是否仍有效。 */
  isSessionCurrent(session: ContactChangeSession): boolean;
  /** 经保存的 Passport 会话换取 account access token(会轮换并持久化 refresh token)。 */
  issueAccountToken(session: ContactChangeSession): Promise<string>;
  createClient(realm: AuthRegion): ContactChangeClient;
  /** 账号已不可用(注销等)时让本地会话失效。 */
  runProtected<T>(request: () => Promise<T>): Promise<T>;
  /** 换绑邮箱成功后刷新当前用户展示的邮箱。 */
  reloadProfile(): Promise<void>;
  now(): number;
  logWarn(message: string, error?: unknown): void;
}

export interface AccountContactChangeHandlers {
  getAvailability(): DesktopContactChangeAvailability;
  requestCurrentCode(): Promise<DesktopContactChangeResult<DesktopContactChangeCodeSent>>;
  verifyCurrentCode(rawCode: unknown): Promise<DesktopContactChangeResult<DesktopContactChangeVerified>>;
  requestNewCode(rawValue: unknown): Promise<DesktopContactChangeResult<null>>;
  confirm(rawInput: unknown): Promise<DesktopContactChangeResult<DesktopContactChangeCompleted>>;
  cancel(): void;
}

/** account access token 的复用窗口;明显短于服务端 access token 有效期。 */
const ACCOUNT_TOKEN_REUSE_MS = 4 * 60_000;
const TOKEN_RETRY_CODES = new Set(['TOKEN_EXPIRED', 'INVALID_TOKEN']);

interface FlowState {
  realm: AuthRegion;
  passportId: string;
  epoch: number;
  type: DesktopContactChangeType;
  contactId: string;
  changeTicket: string | null;
  accountToken: string | null;
  accountTokenAt: number;
}

/** 国内版(cn)以手机号为登录锚点,国际版以邮箱为锚点。 */
export function contactChangeTypeForRealm(realm: AuthRegion): DesktopContactChangeType {
  return realm === 'cn' ? 'phone' : 'email';
}

function failureCode(error: unknown): string {
  return error instanceof AuthApiError ? error.code : 'AUTH_REQUEST_FAILED';
}

function sameSession(a: ContactChangeSession, flow: FlowState): boolean {
  return a.realm === flow.realm && a.passportId === flow.passportId && a.epoch === flow.epoch;
}

function toTarget(type: DesktopContactChangeType, value: string): ContactChangeTarget {
  return type === 'phone' ? { type, phone: value } : { type, email: value };
}

class FlowError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function createAccountContactChangeHandlers(
  deps: AccountContactChangeDeps,
): AccountContactChangeHandlers {
  let flow: FlowState | null = null;
  let inFlight: Promise<unknown> | null = null;

  /** 当前会话仍是发起流程的那个会话,否则作废流程。 */
  function currentFlow(): FlowState {
    if (!flow) throw new FlowError('CONTACT_CHANGE_TICKET_INVALID');
    if (!deps.isSessionCurrent(flow)) {
      flow = null;
      throw new FlowError('AUTH_FLOW_SUPERSEDED');
    }
    return flow;
  }

  async function accountToken(state: FlowState, forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && state.accountToken && deps.now() - state.accountTokenAt < ACCOUNT_TOKEN_REUSE_MS) {
      return state.accountToken;
    }
    const token = await deps.issueAccountToken(state);
    if (flow !== state || !deps.isSessionCurrent(state)) {
      throw new FlowError('AUTH_FLOW_SUPERSEDED');
    }
    state.accountToken = token;
    state.accountTokenAt = deps.now();
    return token;
  }

  /** 以 account token 调用一步;token 被服务端判定过期时换取一次再重试(鉴权失败发生在任何副作用之前)。 */
  async function callWithAccount<T>(
    state: FlowState,
    request: (client: ContactChangeClient, token: string) => Promise<T>,
  ): Promise<T> {
    const client = deps.createClient(state.realm);
    const run = async (forceRefresh: boolean) => {
      const token = await accountToken(state, forceRefresh);
      return deps.runProtected(() => request(client, token));
    };
    let result: T;
    try {
      result = await run(false);
    } catch (error) {
      if (!(error instanceof AuthApiError && error.statusCode === 401 && TOKEN_RETRY_CODES.has(error.code))) {
        throw error;
      }
      result = await run(true);
    }
    if (flow !== state || !deps.isSessionCurrent(state)) {
      throw new FlowError('AUTH_FLOW_SUPERSEDED');
    }
    return result;
  }

  /** 同一时间只允许一个换绑请求在途,重复点击不会重复发码或重复提交。 */
  async function exclusive<T>(operation: () => Promise<T>): Promise<DesktopContactChangeResult<T>> {
    if (inFlight) return { success: false, code: 'CONTACT_CHANGE_BUSY' };
    const running = operation();
    inFlight = running;
    try {
      return { success: true, value: await running };
    } catch (error) {
      return { success: false, code: error instanceof FlowError ? error.code : failureCode(error) };
    } finally {
      if (inFlight === running) inFlight = null;
    }
  }

  async function startFlow(session: ContactChangeSession): Promise<FlowState> {
    const type = contactChangeTypeForRealm(session.realm);
    const state: FlowState = {
      ...session,
      type,
      contactId: '',
      changeTicket: null,
      accountToken: null,
      accountTokenAt: 0,
    };
    flow = state;
    const contacts = await callWithAccount(state, (client, token) => client.getAccountContacts(token));
    // 服务端按验证时间升序返回;同类型有多条时换最近验证的那条。
    const target = contacts.filter((c) => c.type === type && c.id && c.changeable === true).at(-1);
    if (!target?.id) {
      if (flow === state) flow = null;
      throw new FlowError('CONTACT_CHANGE_UNAVAILABLE');
    }
    state.contactId = target.id;
    return state;
  }

  return {
    getAvailability() {
      const session = deps.getSession();
      if (!session) return { available: false, type: null };
      return { available: true, type: contactChangeTypeForRealm(session.realm) };
    },

    requestCurrentCode() {
      return exclusive(async () => {
        const session = deps.getSession();
        if (!session) throw new FlowError('CONTACT_CHANGE_UNAVAILABLE');
        // 重发验证码复用已选定的联系方式;会话变化或尚未开始时重新开始,并作废旧票据。
        const state = flow && sameSession(session, flow) && deps.isSessionCurrent(flow) && flow.contactId
          ? flow
          : await startFlow(session);
        state.changeTicket = null;
        const sent = await callWithAccount(state, (client, token) =>
          client.requestCurrentContactChangeCode(token, state.contactId),
        );
        return { channel: sent.channel, maskedTarget: sent.maskedTarget };
      });
    },

    verifyCurrentCode(rawCode) {
      return exclusive(async () => {
        const code = parseDesktopContactChangeCode(rawCode);
        if (!code) throw new FlowError('INVALID_PARAMS');
        const state = currentFlow();
        const ticket = await callWithAccount(state, (client, token) =>
          client.verifyCurrentContactChange(token, state.contactId, code),
        );
        state.changeTicket = ticket.changeTicket;
        return { type: state.type };
      });
    },

    requestNewCode(rawValue) {
      return exclusive(async () => {
        const state = currentFlow();
        if (!state.changeTicket) throw new FlowError('CONTACT_CHANGE_TICKET_INVALID');
        const value = parseDesktopContactChangeValue(state.type, rawValue);
        if (!value) throw new FlowError('INVALID_PARAMS');
        const ticket = state.changeTicket;
        await callWithAccount(state, (client, token) =>
          client.requestNewContactChangeCode(token, ticket, toTarget(state.type, value)),
        );
        return null;
      });
    },

    confirm(rawInput) {
      return exclusive(async () => {
        const state = currentFlow();
        if (!state.changeTicket) throw new FlowError('CONTACT_CHANGE_TICKET_INVALID');
        const input = typeof rawInput === 'object' && rawInput !== null
          ? (rawInput as Record<string, unknown>)
          : {};
        const value = parseDesktopContactChangeValue(state.type, input.value);
        const code = parseDesktopContactChangeCode(input.code);
        if (!value || !code) throw new FlowError('INVALID_PARAMS');
        const ticket = state.changeTicket;
        let contact: AccountContact;
        try {
          contact = await callWithAccount(state, (client, token) =>
            client.confirmContactChange(token, ticket, toTarget(state.type, value), code),
          );
        } catch (error) {
          // 票据已被服务端判定失效时,本地也作废,下一次必须从验证当前联系方式重新开始。
          if (error instanceof AuthApiError && error.code === 'CONTACT_CHANGE_TICKET_INVALID') {
            state.changeTicket = null;
          }
          throw error;
        }
        flow = null;
        if (state.type === 'email') {
          try {
            await deps.reloadProfile();
          } catch (error) {
            // 换绑已在服务端完成;展示邮箱会在下次刷新资料时更新。
            deps.logWarn('contact change succeeded but profile reload failed', error);
          }
        }
        return { type: state.type, maskedValue: contact.value };
      });
    },

    cancel() {
      flow = null;
    },
  };
}
