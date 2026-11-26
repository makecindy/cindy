import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import {
  BILLING_INVOKE,
  type BillingPurchasedGiftCardCode,
  type BillingSendGiftCardEmailResult,
  type BillingSubscriptionPortalResult,
  type CreateBillingGiftCardOrderRequest,
  type CreateBillingSubscriptionRequest,
  type CreateBillingTopupRequest,
} from '../../shared/billing.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { ServerApiError, serverApiFetch, type ApiFetchOptions } from '../serverApiClient.desktop.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { isAllowedBillingRedirectUrl } from './paymentRedirect.js';
import { normalizeGiftCardCode } from '../../shared/giftCard.js';
import {
  GIFT_CARD_ERROR_CODES,
  giftCardFailureOf,
  projectBillingGiftCardPreview,
  projectBillingGiftCardRedemption,
} from './giftCard.js';
import {
  projectBillingCatalog,
  projectBillingCurrentSubscription,
  projectGiftCardPurchasePolicy,
  projectPurchasedGiftCardCode,
  isPurchasedGiftCardCursor,
  isPurchasedGiftCardId,
  projectPurchasedGiftCardList,
  projectSentPurchasedGiftCard,
  projectBillingOrderList,
  projectBillingPaymentHistory,
  projectBillingPortalSession,
  projectBillingPaymentOrder,
  projectBillingPlanChange,
  projectBillingSubscription,
  projectModelAccessBalance,
  projectModelAccessCreditUsage,
} from './projection.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d{0,14})(?:\.\d{1,9})?$/;
const ID_MAX_LENGTH = 128;
const FACE_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** 礼品卡单张面额：正数、最多两位小数（与卡面和兑换入账精度一致）。 */
const GIFT_CARD_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
/** 收件邮箱只挡明显不是单个地址的输入（空白、逗号分隔的多个地址等）；服务端按自己的规则再校验。 */
const SINGLE_EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const MAX_EMAIL_LENGTH = 254;
const GIFT_CARD_EMAIL_ERROR_CODES = [
  'GIFT_CARD_RECIPIENT_INVALID',
  'GIFT_CARD_NOT_FOUND',
  'GIFT_CARD_NOT_AVAILABLE',
  'GIFT_CARD_EMAIL_COOLDOWN',
] as const;
// 服务端按自己的上限校验署名、留言与张数；这里只挡住明显越界的输入，不复制业务规则。
const MAX_GIFT_SENDER_LENGTH = 80;
const MAX_GIFT_MESSAGE_LENGTH = 240;
const MAX_GIFT_CARD_QUANTITY = 100;
const MAX_PURCHASED_GIFT_CARD_PAGE = 50;
const BILLING_REQUEST_TIMEOUT_MS = 20_000;
/** 旧服务端不支持付款记录 includeGiftCards 时，多久后再试一次带参数的请求。 */
const LEGACY_PAYMENT_HISTORY_RETRY_MS = 10 * 60_000;
const EXTERNAL_BROWSER_LAUNCH_TIMEOUT_MS = 10_000;

type ServerFetch = <T>(path: string, options: ApiFetchOptions) => Promise<T>;

export type BillingIpcDependencies = {
  getMainWindow: () => BrowserWindow | null;
  requirePersonalAccount: () => void;
  getBaseUrl?: () => string;
  /** 测试用：替换当前时间（毫秒）。 */
  now?: () => number;
  /** 当前账号区域的分享站；礼品卡领取链接拼在它的 `/gift` 下。 */
  getShareBaseUrl?: () => string;
  fetch?: ServerFetch;
  openExternal?: (url: string) => Promise<void>;
};

type BillingInvokeEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;
type BillingHandler = (event: BillingInvokeEvent, payload?: unknown) => Promise<unknown>;

function assertMainWindowSender(
  event: BillingInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
): void {
  const mainWindow = getMainWindow();
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throwIpcError('PERMISSION_DENIED', 'billing IPC is only available to the main window');
  }
}

function throwBillingFetchError(error: unknown): never {
  if (error instanceof ServerApiError) {
    if (error.code === 'PLAN_CHANGE_RENEWAL_PREPAID') {
      throwIpcError('PLAN_CHANGE_RENEWAL_PREPAID', 'next renewal is already paid');
    }
    if (error.code === 'PLAN_CHANGE_NOT_AVAILABLE') {
      throwIpcError('PLAN_CHANGE_NOT_AVAILABLE', 'target plan is not available');
    }
    if (error.code === 'RESUME_NOT_AVAILABLE') {
      throwIpcError('RESUME_NOT_AVAILABLE', 'subscription is not resumable');
    }
    if (error.code === 'GIFT_CARD_PURCHASE_LIMIT_REACHED') {
      throwIpcError('GIFT_CARD_PURCHASE_LIMIT_REACHED', 'gift card purchase limit reached');
    }
    if (error.code === 'GIFT_CARD_ORDER_AMOUNT_TOO_LARGE') {
      throwIpcError('GIFT_CARD_ORDER_AMOUNT_TOO_LARGE', 'gift card order total is too large');
    }
    if (error.statusCode === 400) {
      throwIpcError('INVALID_PARAMS', 'billing request was rejected');
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      throwIpcError('PERMISSION_DENIED', 'billing request is not authorized');
    }
    if (error.statusCode === 404) {
      throwIpcError('NOT_FOUND', 'billing resource was not found');
    }
    if (error.statusCode === 409 || error.statusCode === 412) {
      throwIpcError('PRECONDITION_FAILED', 'billing request conflicts with the current state');
    }
  }
  throwIpcError('INTERNAL', 'billing service request failed');
}

function throwBalanceFetchError(error: unknown): never {
  if (error instanceof ServerApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      throwIpcError('PERMISSION_DENIED', 'balance request is not authorized');
    }
    if (error.statusCode === 404) {
      throwIpcError('NOT_FOUND', 'balance account is not provisioned');
    }
    if (error.statusCode === 501) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'balance is not supported for this account');
    }
  }
  throwIpcError('MODEL_ACCESS_FAILED', 'balance service request failed');
}

function projectResponse<T>(value: unknown, projector: (input: unknown) => T): T {
  try {
    return projector(value);
  } catch {
    throwIpcError('INTERNAL', 'billing service response was invalid');
  }
}

function openExternalWithTimeout(
  openExternal: (url: string) => Promise<void>,
  url: string,
): Promise<BillingSubscriptionPortalResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (result: BillingSubscriptionPortalResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    timeout = setTimeout(
      () => finish({ success: false, timedOut: true }),
      EXTERNAL_BROWSER_LAUNCH_TIMEOUT_MS,
    );
    try {
      void openExternal(url).then(
        () => finish({ success: true }),
        () => finish({ success: false }),
      );
    } catch {
      finish({ success: false });
    }
  });
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey) throwIpcError('INVALID_PARAMS', `${name}.${unknownKey} is not allowed`);
}

function requireBoundedString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX_LENGTH) {
    throwIpcError('INVALID_PARAMS', `${name} must be a non-empty string`);
  }
  return value;
}

function requireCode(value: unknown, name: string): string {
  const code = requireBoundedString(value, name);
  if (!CODE_PATTERN.test(code)) throwIpcError('INVALID_PARAMS', `${name} is invalid`);
  return code;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throwIpcError('INVALID_PARAMS', 'idempotencyKey is invalid');
  }
  return value;
}

function requireAmount(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throwIpcError('INVALID_PARAMS', `${name} is invalid`);
  }
  return value;
}

function parseIdPayload(raw: unknown, key: 'orderId' | 'purchaseAttemptId' | 'planChangeId') {
  const payload = requireObject(raw);
  assertOnlyKeys(payload, [key], 'payload');
  return { [key]: requireBoundedString(payload[key], key) } as Record<typeof key, string>;
}

function parseCreateTopup(raw: unknown): {
  request: CreateBillingTopupRequest;
  idempotencyKey: string;
} {
  const payload = requireObject(raw);
  assertOnlyKeys(payload, ['request', 'idempotencyKey'], 'payload');
  const request = requireObject(payload.request, 'request');
  assertOnlyKeys(request, ['offerCode', 'amount', 'purchaseOptionId'], 'request');
  return {
    request: {
      offerCode: requireCode(request.offerCode, 'offerCode'),
      ...(request.amount === undefined ? {} : { amount: requireAmount(request.amount, 'amount') }),
      purchaseOptionId: requireBoundedString(request.purchaseOptionId, 'purchaseOptionId'),
    },
    idempotencyKey: requireIdempotencyKey(payload.idempotencyKey),
  };
}

function requireGiftText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', `${name} must be a string`);
  const text = value.trim();
  if (text.length > maxLength) throwIpcError('INVALID_PARAMS', `${name} is too long`);
  return text;
}

function parseCreateGiftCardOrder(raw: unknown): {
  request: CreateBillingGiftCardOrderRequest;
  idempotencyKey: string;
} {
  const payload = requireObject(raw);
  assertOnlyKeys(payload, ['request', 'idempotencyKey'], 'payload');
  const request = requireObject(payload.request, 'request');
  assertOnlyKeys(
    request,
    ['offerCode', 'amount', 'quantity', 'faceCode', 'senderName', 'message', 'purchaseOptionId'],
    'request',
  );
  // 自填面额：正数、最多两位小数；是否在范围内由服务端按价格方案校验。
  if (
    request.amount !== undefined &&
    (typeof request.amount !== 'string' || !GIFT_CARD_AMOUNT_PATTERN.test(request.amount))
  ) {
    throwIpcError('INVALID_PARAMS', 'amount is invalid');
  }
  const { quantity, faceCode } = request;
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_GIFT_CARD_QUANTITY
  ) {
    throwIpcError('INVALID_PARAMS', 'quantity is invalid');
  }
  if (typeof faceCode !== 'string' || !FACE_CODE_PATTERN.test(faceCode)) {
    throwIpcError('INVALID_PARAMS', 'faceCode is invalid');
  }
  const senderName = requireGiftText(request.senderName, 'senderName', MAX_GIFT_SENDER_LENGTH);
  if (!senderName) throwIpcError('INVALID_PARAMS', 'senderName is required');
  const message =
    request.message === null || request.message === undefined
      ? null
      : requireGiftText(request.message, 'message', MAX_GIFT_MESSAGE_LENGTH) || null;
  return {
    request: {
      offerCode: requireCode(request.offerCode, 'offerCode'),
      ...(request.amount === undefined ? {} : { amount: request.amount as string }),
      quantity,
      faceCode,
      senderName,
      message,
      purchaseOptionId: requireBoundedString(request.purchaseOptionId, 'purchaseOptionId'),
    },
    idempotencyKey: requireIdempotencyKey(payload.idempotencyKey),
  };
}

/**
 * 礼品卡领取链接：`<分享站>/gift?face=<卡面>#<兑换码>`。兑换码放在 fragment，
 * 浏览器不会把它发给分享站。分享站只接受本版本配置的 https 源；拿不到时不拼链接。
 */
function giftCardClaimUrl(shareBaseUrl: () => string, faceCode: string, code: string): string | null {
  try {
    const base = new URL(shareBaseUrl());
    if (base.protocol !== 'https:' || base.username || base.password) return null;
    const url = new URL('/gift', base.origin);
    url.searchParams.set('face', faceCode);
    url.hash = code;
    return url.toString();
  } catch {
    return null;
  }
}

function parseCreateSubscription(raw: unknown): {
  request: CreateBillingSubscriptionRequest;
  idempotencyKey: string;
} {
  const payload = requireObject(raw);
  assertOnlyKeys(payload, ['request', 'idempotencyKey'], 'payload');
  const request = requireObject(payload.request, 'request');
  assertOnlyKeys(request, ['offerCode', 'purchaseOptionId'], 'request');
  return {
    request: {
      offerCode: requireCode(request.offerCode, 'offerCode'),
      purchaseOptionId: requireBoundedString(request.purchaseOptionId, 'purchaseOptionId'),
    },
    idempotencyKey: requireIdempotencyKey(payload.idempotencyKey),
  };
}

export function createBillingHandlers(
  deps: BillingIpcDependencies,
): Record<string, BillingHandler> {
  const fetch = deps.fetch ?? serverApiFetch;
  const getBaseUrl = deps.getBaseUrl ?? (() => getClientEndpoint('modelAccessApiBaseUrl'));
  // 旧服务端不认识付款记录的 includeGiftCards（400）：记下这个地址在一段时间内不支持，期间直接走
  // 原来的请求，不让每次读付款记录都先白跑一趟；过期后再试一次，服务端升级后自动恢复。
  const legacyPaymentHistoryUntil = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());
  const getShareBaseUrl = deps.getShareBaseUrl ?? (() => getClientEndpoint('shareBaseUrl'));
  const openExternal = deps.openExternal ?? ((url: string) => shell.openExternal(url));
  const invoke = async <T>(path: string, options: Omit<ApiFetchOptions, 'baseUrl'> = {}) => {
    try {
      return await fetch<T>(path, {
        timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
        ...options,
        redactErrorDetails: true,
        baseUrl: getBaseUrl,
      });
    } catch (error) {
      throwBillingFetchError(error);
    }
  };
  /**
   * 礼品卡请求：兑换码只走请求体。服务端明确给出的卡片状态作为结果返回，由
   * Renderer 逐一说明；其它失败沿用计费请求的统一错误。
   */
  const giftCard = async <T extends object>(
    path: string,
    raw: unknown,
    project: (value: unknown) => T,
  ) => {
    const payload = requireObject(raw);
    assertOnlyKeys(payload, ['code'], 'payload');
    const code = typeof payload.code === 'string' ? normalizeGiftCardCode(payload.code) : null;
    if (!code) return { ok: false as const, reason: 'NOT_FOUND' as const };
    let response: unknown;
    try {
      response = await fetch<unknown>(path, {
        method: 'POST',
        body: { code },
        timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
        redactErrorDetails: true,
        allowedRedactedErrorCodes: GIFT_CARD_ERROR_CODES,
        // 403 只把「需要个人身份」当成预期结果；其它 403 仍按异常记录。
        expectedErrors: [{ status: 404 }, { status: 409 }, { status: 429 }, { status: 403, code: 'PERSONAL_ACCOUNT_REQUIRED' }],
        baseUrl: getBaseUrl,
      });
    } catch (error) {
      const reason = giftCardFailureOf(error);
      if (reason) return { ok: false as const, reason };
      throwBillingFetchError(error);
    }
    return { ok: true as const, ...projectResponse(response, project) };
  };
  const protect =
    (handler: (payload?: unknown) => Promise<unknown>): BillingHandler =>
    async (event, payload) => {
      assertMainWindowSender(event, deps.getMainWindow);
      deps.requirePersonalAccount();
      return handler(payload);
    };

  return {
    [BILLING_INVOKE.GET_BALANCE]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'balance request does not accept a payload');
      }
      let response: unknown;
      try {
        response = await fetch<unknown>('/api/model-access/balance', {
          timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
          redactErrorDetails: true,
          baseUrl: getBaseUrl,
        });
      } catch (error) {
        throwBalanceFetchError(error);
      }
      return projectResponse(response, projectModelAccessBalance);
    }),
    [BILLING_INVOKE.GET_CREDIT_USAGE]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'credit usage request does not accept a payload');
      }
      let response: unknown;
      try {
        response = await fetch<unknown>('/api/model-access/credit-usage', {
          timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
          redactErrorDetails: true,
          baseUrl: getBaseUrl,
        });
      } catch (error) {
        throwBalanceFetchError(error);
      }
      return projectResponse(response, projectModelAccessCreditUsage);
    }),
    [BILLING_INVOKE.GET_CATALOG]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'catalog request does not accept a payload');
      }
      return projectResponse(await invoke<unknown>('/api/billing/catalog'), projectBillingCatalog);
    }),
    [BILLING_INVOKE.LIST_PAYMENT_HISTORY]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['limit', 'cursor'], 'payload');
      if (typeof payload.limit !== 'number' || !Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 100) {
        throwIpcError('INVALID_PARAMS', 'limit must be an integer between 1 and 100');
      }
      if (payload.cursor !== undefined && (typeof payload.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(payload.cursor))) {
        throwIpcError('INVALID_PARAMS', 'cursor must be a bounded history cursor');
      }
      const query = new URLSearchParams({ limit: String(payload.limit) });
      if (typeof payload.cursor === 'string') query.set('cursor', payload.cursor);
      const withGiftCards = new URLSearchParams(query);
      withGiftCards.set('includeGiftCards', 'true');
      const baseUrl = getBaseUrl();
      if ((legacyPaymentHistoryUntil.get(baseUrl) ?? 0) > now()) {
        return projectResponse(await invoke<unknown>(`/api/billing/payment-history?${query}`), projectBillingPaymentHistory);
      }
      let response: unknown;
      try {
        response = await fetch<unknown>(`/api/billing/payment-history?${withGiftCards}`, {
          timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
          redactErrorDetails: true,
          expectedErrors: [{ status: 400 }],
          baseUrl: getBaseUrl,
        });
      } catch (error) {
        // 服务端还没上线礼品卡时不认识这个参数（400）：退回原来的请求，订单记录照常显示。不带参数的
        // 请求成功了才记下「暂不支持」——别的 400（比如游标过期）回退也会失败，不能因此 10 分钟不带参数。
        if (!(error instanceof ServerApiError) || error.statusCode !== 400) throwBillingFetchError(error);
        response = await invoke<unknown>(`/api/billing/payment-history?${query}`);
        legacyPaymentHistoryUntil.set(baseUrl, now() + LEGACY_PAYMENT_HISTORY_RETRY_MS);
      }
      return projectResponse(response, projectBillingPaymentHistory);
    }),
    [BILLING_INVOKE.LIST_ORDERS]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['limit'], 'payload');
      if (
        typeof payload.limit !== 'number' ||
        !Number.isInteger(payload.limit) ||
        payload.limit < 1 ||
        payload.limit > 100
      )
        throwIpcError('INVALID_PARAMS', 'limit must be an integer between 1 and 100');
      return projectResponse(
        await invoke<unknown>(`/api/billing/orders?limit=${payload.limit}`),
        projectBillingOrderList,
      );
    }),
    [BILLING_INVOKE.GET_ORDER]: protect(async (raw) => {
      const { orderId } = parseIdPayload(raw, 'orderId');
      return projectResponse(
        await invoke<unknown>(`/api/billing/orders/${encodeURIComponent(orderId)}`),
        projectBillingPaymentOrder,
      );
    }),
    [BILLING_INVOKE.CREATE_TOPUP]: protect(async (raw) => {
      const payload = parseCreateTopup(raw);
      return projectResponse(
        await invoke<unknown>('/api/billing/credit-topup/orders', {
          method: 'POST',
          body: payload.request,
          headers: { 'Idempotency-Key': payload.idempotencyKey },
        }),
        projectBillingPaymentOrder,
      );
    }),
    [BILLING_INVOKE.REFRESH_TOPUP]: protect(async (raw) => {
      const { orderId } = parseIdPayload(raw, 'orderId');
      return projectResponse(
        await invoke<unknown>(`/api/billing/orders/${encodeURIComponent(orderId)}/refresh`, {
          method: 'POST',
        }),
        projectBillingPaymentOrder,
      );
    }),
    [BILLING_INVOKE.CANCEL_TOPUP]: protect(async (raw) => {
      const { orderId } = parseIdPayload(raw, 'orderId');
      return projectResponse(
        await invoke<unknown>(`/api/billing/orders/${encodeURIComponent(orderId)}/cancel`, {
          method: 'POST',
        }),
        projectBillingPaymentOrder,
      );
    }),
    [BILLING_INVOKE.RETRY_TOPUP]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['orderId', 'idempotencyKey'], 'payload');
      const orderId = requireBoundedString(payload.orderId, 'orderId');
      const idempotencyKey = requireIdempotencyKey(payload.idempotencyKey);
      return projectResponse(
        await invoke<unknown>(`/api/billing/orders/${encodeURIComponent(orderId)}/retry`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
        projectBillingPaymentOrder,
      );
    }),
    [BILLING_INVOKE.CREATE_SUBSCRIPTION]: protect(async (raw) => {
      const payload = parseCreateSubscription(raw);
      return projectResponse(
        await invoke<unknown>('/api/billing/subscriptions', {
          method: 'POST',
          body: payload.request,
          headers: { 'Idempotency-Key': payload.idempotencyKey },
        }),
        projectBillingSubscription,
      );
    }),
    [BILLING_INVOKE.GET_CURRENT_SUBSCRIPTION]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'subscription request does not accept a payload');
      }
      return projectResponse(
        await invoke<unknown>('/api/billing/subscription'),
        projectBillingCurrentSubscription,
      );
    }),
    [BILLING_INVOKE.CANCEL_CURRENT_SUBSCRIPTION]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'subscription cancellation does not accept a payload');
      }
      return projectResponse(
        await invoke<unknown>('/api/billing/subscription', { method: 'DELETE' }),
        projectBillingSubscription,
      );
    }),
    [BILLING_INVOKE.RESUME_CURRENT_SUBSCRIPTION]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'subscription resume does not accept a payload');
      }
      return projectResponse(
        await invoke<unknown>('/api/billing/subscription/resume', {
          method: 'POST',
          allowedRedactedErrorCodes: ['RESUME_NOT_AVAILABLE'],
        }),
        projectBillingSubscription,
      );
    }),
    [BILLING_INVOKE.REFRESH_SUBSCRIPTION_PURCHASE]: protect(async (raw) => {
      const { purchaseAttemptId } = parseIdPayload(raw, 'purchaseAttemptId');
      return projectResponse(
        await invoke<unknown>(
          `/api/billing/subscriptions/purchases/${encodeURIComponent(purchaseAttemptId)}/refresh`,
          { method: 'POST' },
        ),
        projectBillingSubscription,
      );
    }),
    [BILLING_INVOKE.QUOTE_PLAN_CHANGE]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['targetOfferCode', 'idempotencyKey'], 'payload');
      const targetOfferCode = requireCode(payload.targetOfferCode, 'targetOfferCode');
      const idempotencyKey = requireIdempotencyKey(payload.idempotencyKey);
      return projectResponse(
        await invoke<unknown>('/api/billing/subscription/plan-change-quotes', {
          method: 'POST',
          body: { targetOfferCode },
          headers: { 'Idempotency-Key': idempotencyKey },
          allowedRedactedErrorCodes: ['PLAN_CHANGE_NOT_AVAILABLE', 'PLAN_CHANGE_RENEWAL_PREPAID'],
        }),
        projectBillingPlanChange,
      );
    }),
    [BILLING_INVOKE.CONFIRM_PLAN_CHANGE]: protect(async (raw) => {
      const { planChangeId } = parseIdPayload(raw, 'planChangeId');
      return projectResponse(
        await invoke<unknown>(
          `/api/billing/subscription/plan-changes/${encodeURIComponent(planChangeId)}/confirm`,
          { method: 'POST', allowedRedactedErrorCodes: ['PLAN_CHANGE_RENEWAL_PREPAID'] },
        ),
        projectBillingPlanChange,
      );
    }),
    [BILLING_INVOKE.REFRESH_PLAN_CHANGE]: protect(async (raw) => {
      const { planChangeId } = parseIdPayload(raw, 'planChangeId');
      return projectResponse(
        await invoke<unknown>(
          `/api/billing/subscription/plan-changes/${encodeURIComponent(planChangeId)}/refresh`,
          { method: 'POST' },
        ),
        projectBillingPlanChange,
      );
    }),
    [BILLING_INVOKE.CANCEL_PLAN_CHANGE]: protect(async (raw) => {
      const { planChangeId } = parseIdPayload(raw, 'planChangeId');
      return projectResponse(
        await invoke<unknown>(
          `/api/billing/subscription/plan-changes/${encodeURIComponent(planChangeId)}`,
          { method: 'DELETE' },
        ),
        projectBillingPlanChange,
      );
    }),
    [BILLING_INVOKE.OPEN_SUBSCRIPTION_PORTAL]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'subscription portal does not accept a payload');
      }
      const session = projectResponse(
        await invoke<unknown>('/api/billing/subscription/portal', { method: 'POST' }),
        projectBillingPortalSession,
      );
      return openExternalWithTimeout(openExternal, session.url);
    }),
    [BILLING_INVOKE.OPEN_PAYMENT_REDIRECT]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['url'], 'payload');
      if (!isAllowedBillingRedirectUrl(payload.url)) {
        throwIpcError('INVALID_PARAMS', 'billing redirect URL is not allowed');
      }
      try {
        await openExternal(payload.url);
        return { success: true };
      } catch {
        return { success: false };
      }
    }),
    [BILLING_INVOKE.PREVIEW_GIFT_CARD]: protect((raw) =>
      giftCard('/api/gift-cards/preview', raw, projectBillingGiftCardPreview),
    ),
    [BILLING_INVOKE.REDEEM_GIFT_CARD]: protect((raw) =>
      giftCard('/api/gift-cards/redeem', raw, projectBillingGiftCardRedemption),
    ),
    [BILLING_INVOKE.GET_GIFT_CARD_PURCHASE_POLICY]: protect(async (raw) => {
      if (raw !== undefined) {
        throwIpcError('INVALID_PARAMS', 'gift card purchase policy does not accept a payload');
      }
      return projectResponse(
        await invoke<unknown>('/api/gift-cards/purchase-policy', {
          // 旧服务端没有这个接口：按「还不能买礼品卡」处理，不当异常记录。
          expectedErrors: [{ status: 404 }],
        }),
        projectGiftCardPurchasePolicy,
      );
    }),
    [BILLING_INVOKE.CREATE_GIFT_CARD_ORDER]: protect(async (raw) => {
      const payload = parseCreateGiftCardOrder(raw);
      return projectResponse(
        await invoke<unknown>('/api/billing/gift-card/orders', {
          method: 'POST',
          body: payload.request,
          headers: { 'Idempotency-Key': payload.idempotencyKey },
          allowedRedactedErrorCodes: [
            'GIFT_CARD_PURCHASE_LIMIT_REACHED',
            'GIFT_CARD_ORDER_AMOUNT_TOO_LARGE',
          ],
        }),
        projectBillingPaymentOrder,
      );
    }),
    [BILLING_INVOKE.LIST_PURCHASED_GIFT_CARDS]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['limit', 'cursor'], 'payload');
      if (
        typeof payload.limit !== 'number' ||
        !Number.isInteger(payload.limit) ||
        payload.limit < 1 ||
        payload.limit > MAX_PURCHASED_GIFT_CARD_PAGE
      ) {
        throwIpcError('INVALID_PARAMS', 'limit must be an integer between 1 and 50');
      }
      if (
        payload.cursor !== undefined &&
        !isPurchasedGiftCardCursor(payload.cursor)
      ) {
        throwIpcError('INVALID_PARAMS', 'cursor must be a bounded page cursor');
      }
      const query = new URLSearchParams({ limit: String(payload.limit) });
      if (typeof payload.cursor === 'string') query.set('cursor', payload.cursor);
      return projectResponse(
        await invoke<unknown>(`/api/gift-cards/purchased?${query}`, {
          expectedErrors: [{ status: 404 }],
        }),
        projectPurchasedGiftCardList,
      );
    }),
    [BILLING_INVOKE.REVEAL_PURCHASED_GIFT_CARD]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['cardId', 'faceCode'], 'payload');
      if (!isPurchasedGiftCardId(payload.cardId)) {
        throwIpcError('INVALID_PARAMS', 'cardId is invalid');
      }
      if (typeof payload.faceCode !== 'string' || !FACE_CODE_PATTERN.test(payload.faceCode)) {
        throwIpcError('INVALID_PARAMS', 'faceCode is invalid');
      }
      const { code } = projectResponse(
        await invoke<unknown>(
          `/api/gift-cards/purchased/${encodeURIComponent(payload.cardId)}/code`,
          {
            method: 'POST',
            expectedErrors: [{ status: 404 }, { status: 409 }],
          },
        ),
        projectPurchasedGiftCardCode,
      );
      return {
        code,
        claimUrl: giftCardClaimUrl(getShareBaseUrl, payload.faceCode, code),
      } satisfies BillingPurchasedGiftCardCode;
    }),
    /**
     * 把一张未领取的卡发到买家填的邮箱（发信异步进行）。邮箱不合法、卡已不可发、还在冷却
     * 作为结果返回，由界面就地说明；其它失败沿用计费请求的统一错误。
     */
    [BILLING_INVOKE.SEND_PURCHASED_GIFT_CARD_EMAIL]: protect(async (raw) => {
      const payload = requireObject(raw);
      assertOnlyKeys(payload, ['cardId', 'email'], 'payload');
      if (!isPurchasedGiftCardId(payload.cardId)) {
        throwIpcError('INVALID_PARAMS', 'cardId is invalid');
      }
      if (typeof payload.email !== 'string') throwIpcError('INVALID_PARAMS', 'email is invalid');
      const email = payload.email.trim();
      if (email.length > MAX_EMAIL_LENGTH || !SINGLE_EMAIL_PATTERN.test(email)) {
        return { ok: false, reason: 'INVALID_EMAIL' } satisfies BillingSendGiftCardEmailResult;
      }
      let response: unknown;
      try {
        response = await fetch<unknown>(
          `/api/gift-cards/purchased/${encodeURIComponent(payload.cardId)}/email`,
          {
            method: 'POST',
            body: { email },
            timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
            redactErrorDetails: true,
            allowedRedactedErrorCodes: GIFT_CARD_EMAIL_ERROR_CODES,
            expectedErrors: [{ status: 400 }, { status: 404 }, { status: 409 }, { status: 429 }],
            baseUrl: getBaseUrl,
          },
        );
      } catch (error) {
        if (error instanceof ServerApiError) {
          if (error.code === 'GIFT_CARD_RECIPIENT_INVALID') {
            return { ok: false, reason: 'INVALID_EMAIL' } satisfies BillingSendGiftCardEmailResult;
          }
          if (error.code === 'GIFT_CARD_NOT_AVAILABLE' || error.code === 'GIFT_CARD_NOT_FOUND') {
            return { ok: false, reason: 'NOT_AVAILABLE' } satisfies BillingSendGiftCardEmailResult;
          }
          if (error.code === 'GIFT_CARD_EMAIL_COOLDOWN') {
            return {
              ok: false,
              reason: 'COOLDOWN',
              retryAt: typeof error.retryAt === 'number' && Number.isFinite(error.retryAt) ? error.retryAt : null,
            } satisfies BillingSendGiftCardEmailResult;
          }
        }
        throwBillingFetchError(error);
      }
      return {
        ok: true,
        card: projectResponse(response, projectSentPurchasedGiftCard),
      } satisfies BillingSendGiftCardEmailResult;
    }),
  };
}

export function registerBillingIpc(deps: BillingIpcDependencies): void {
  const handlers = createBillingHandlers(deps);
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
}
