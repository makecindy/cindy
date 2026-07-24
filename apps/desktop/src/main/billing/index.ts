import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import {
  BILLING_INVOKE,
  type CreateBillingSubscriptionRequest,
  type CreateBillingTopupRequest,
} from '../../shared/billing.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { ServerApiError, serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { isAllowedBillingRedirectUrl } from './paymentRedirect.js';
import {
  projectBillingCatalog,
  projectBillingCurrentSubscription,
  projectBillingOrderList,
  projectBillingPaymentOrder,
  projectBillingSubscription,
  projectModelAccessBalance,
} from './projection.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d{0,14})(?:\.\d{1,9})?$/;
const ID_MAX_LENGTH = 128;
const BILLING_REQUEST_TIMEOUT_MS = 20_000;

type ServerFetch = <T>(path: string, options: ApiFetchOptions) => Promise<T>;

export type BillingIpcDependencies = {
  getMainWindow: () => BrowserWindow | null;
  getBaseUrl?: () => string;
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

function parseIdPayload(raw: unknown, key: 'orderId' | 'purchaseAttemptId') {
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
  const openExternal = deps.openExternal ?? ((url: string) => shell.openExternal(url));
  const invoke = async <T>(path: string, options: Omit<ApiFetchOptions, 'baseUrl'> = {}) => {
    try {
      return await fetch<T>(path, {
        timeoutMs: BILLING_REQUEST_TIMEOUT_MS,
        ...options,
        redactErrorDetails: true,
        baseUrl: getBaseUrl(),
      });
    } catch (error) {
      throwBillingFetchError(error);
    }
  };
  const protect =
    (handler: (payload?: unknown) => Promise<unknown>): BillingHandler =>
    async (event, payload) => {
      assertMainWindowSender(event, deps.getMainWindow);
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
          baseUrl: getBaseUrl(),
        });
      } catch (error) {
        throwBalanceFetchError(error);
      }
      return projectResponse(response, projectModelAccessBalance);
    }),
    [BILLING_INVOKE.GET_CATALOG]: protect(async () =>
      projectResponse(await invoke<unknown>('/api/billing/catalog'), projectBillingCatalog),
    ),
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
    [BILLING_INVOKE.GET_CURRENT_SUBSCRIPTION]: protect(async () =>
      projectResponse(
        await invoke<unknown>('/api/billing/subscription'),
        projectBillingCurrentSubscription,
      ),
    ),
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
  };
}

export function registerBillingIpc(deps: BillingIpcDependencies): void {
  const handlers = createBillingHandlers(deps);
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
}
