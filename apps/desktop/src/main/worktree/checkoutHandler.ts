import path from 'node:path';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate';
import { createCheckoutService, type CheckoutActivity } from './checkout';
import type { CheckoutReply, CheckoutRequest, CheckoutResult } from '../../shared/worktreeCheckout';

/** Bounded replies retain the outcome of each explicit mutation; result requests never replay Git. */
export function createCheckoutHandler<Event>(deps: {
  assertTrustedAppRendererEvent(event: Event): void;
  isDeviceLinkInvoke(): boolean;
  getCallerScope(): string | null;
  listActivity(): Promise<CheckoutActivity[]>;
}) {
  const service = createCheckoutService(deps.listActivity);
  const receipts = new Map<string, string>();
  const operations = new Map<
    string,
    { scope: string; repo: string; request: string; result: Promise<CheckoutResult> }
  >();
  function parse(input: unknown): CheckoutRequest {
    const body = requireObject(input);
    const baseRepo = requireString(body.baseRepo, 'baseRepo');
    if (!path.isAbsolute(baseRepo) || baseRepo.includes('\0') || baseRepo.length > 32768)
      throwIpcError('INVALID_PARAMS', 'Invalid checkout path');
    const action = requireString(body.action, 'action');
    const field = (name: string) => {
      const value = requireString(body[name], name);
      if (
        !value ||
        value.length > 1024 ||
        Array.from(value).some((char) => char.charCodeAt(0) <= 32 || '~^:?*\\['.includes(char)) ||
        value.startsWith('-') ||
        value.includes('..')
      )
        throwIpcError('INVALID_PARAMS', 'Invalid checkout parameter');
      return value;
    };
    if (action === 'status')
      return {
        baseRepo,
        action,
        ...(body.branch === undefined ? {} : { branch: field('branch') }),
      };
    const operationId = field('operationId');
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throwIpcError('INVALID_PARAMS', 'Invalid operation');
    if (action === 'result') return { baseRepo, action, operationId };
    if (action === 'undo') return { baseRepo, action, operationId, receiptId: field('receiptId') };
    if (action === 'restore')
      return {
        baseRepo,
        action,
        operationId,
        stashId: field('stashId'),
        expected: field('expected'),
      };
    if (action !== 'switch' || (body.strategy !== 'carry' && body.strategy !== 'stash'))
      throwIpcError('INVALID_PARAMS', 'Invalid checkout action');
    return {
      baseRepo,
      action,
      operationId,
      branch: field('branch'),
      expected: field('expected'),
      fingerprint: field('fingerprint'),
      strategy: body.strategy,
    };
  }
  return async (event: Event, input: unknown): Promise<CheckoutReply> => {
    if (!deps.isDeviceLinkInvoke()) deps.assertTrustedAppRendererEvent(event);
    const req = parse(input);
    const scope = deps.getCallerScope();
    if (!scope) throwIpcError('INTERNAL', 'checkout:changed');
    const assertScope = () => {
      if (deps.getCallerScope() !== scope) throwIpcError('INTERNAL', 'checkout:changed');
    };
    const run = async (): Promise<CheckoutResult> => {
      try {
        if (deps.getCallerScope() !== scope) throwIpcError('INTERNAL', 'checkout:changed');
        if (req.action === 'status')
          return { status: await service.status(req.baseRepo, req.branch) };
        if (req.action === 'switch')
          return await service.switch(
            req.baseRepo,
            req.branch,
            req.expected,
            req.fingerprint,
            req.strategy,
            assertScope,
          );
        if (req.action === 'restore')
          return await service.restore(req.baseRepo, req.stashId, req.expected, assertScope);
        if (req.action === 'undo') {
          if (receipts.get(req.receiptId) !== scope)
            throwIpcError('INVALID_PARAMS', 'checkout:changed');
          return await service.undo(req.baseRepo, req.receiptId, assertScope);
        }
        throwIpcError('INVALID_PARAMS', 'checkout:changed');
      } catch {
        throwIpcError('INTERNAL', 'checkout:git');
      }
    };
    if (req.action === 'status') return run();
    let operation = operations.get(req.operationId);
    if (
      operation &&
      (operation.scope !== scope ||
        operation.repo !== req.baseRepo ||
        (req.action !== 'result' && operation.request !== JSON.stringify(req)))
    )
      throwIpcError('INVALID_PARAMS', 'checkout:changed');
    if (!operation) {
      if (req.action === 'result') throwIpcError('NOT_FOUND', 'checkout:changed');
      const result = run().then((result) => {
        if (result.receipt) receipts.set(result.receipt.id, scope);
        return result;
      });
      operation = { scope, repo: req.baseRepo, request: JSON.stringify(req), result };
      operations.set(req.operationId, operation);
      const expire = () => {
        const timer = setTimeout(() => operations.delete(req.operationId), 30 * 60_000);
        timer.unref?.();
      };
      void result.then(expire, expire);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.result,
        new Promise<CheckoutReply>((resolve) => {
          timer = setTimeout(() => resolve({ pending: true, operationId: req.operationId }), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
