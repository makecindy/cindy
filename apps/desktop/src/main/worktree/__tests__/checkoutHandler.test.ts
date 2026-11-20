/** Test value: a timed-out checkout must not replay writes or expose another caller's receipt.
 * New IPC contract, no existing handler coverage. Minimal input: one pending switch and two scopes.
 * Tier: unit, fake timers and an injected Git service (no filesystem or Electron).
 * Measured execution: 4ms; imports the production handler once.
 */
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCheckoutHandler } from '../checkoutHandler';
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  switch: vi.fn(),
  undo: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('../checkout', () => ({ createCheckoutService: () => mocks }));
const operationId = '8a7768e7-e652-4458-9c15-96af310bc9cb';
const req = {
  baseRepo: path.resolve('checkout-fixture'),
  action: 'switch',
  branch: 'main',
  expected: 'feature',
  fingerprint: 'abcd',
  strategy: 'carry',
  operationId,
};
let scope: string;
const trusted = vi.fn();
const handler = () =>
  createCheckoutHandler({
    assertTrustedAppRendererEvent: trusted,
    isDeviceLinkInvoke: () => false,
    getCallerScope: () => scope,
    listActivity: async () => [],
  });
beforeEach(() => {
  vi.clearAllMocks();
  scope = 'owner/controller';
});
afterEach(() => vi.useRealTimers());
it('validates renderer origin and rejects option-shaped branch inputs before Git', async () => {
  const run = handler();
  await expect(run({}, { ...req, branch: '--force' })).rejects.toThrow();
  expect(trusted).toHaveBeenCalledOnce();
  expect(mocks.switch).not.toHaveBeenCalled();
});
it('returns bounded pending replies and resumes the original write exactly once', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  mocks.switch.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const run = handler();
  const first = run({}, req);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await first).toEqual({ pending: true, operationId });
  const continuation = run(
    {},
    { baseRepo: path.resolve('checkout-fixture'), action: 'result', operationId },
  );
  const result = { status: { current: 'main' } };
  finish(result);
  expect(await continuation).toEqual(result);
  expect(mocks.switch).toHaveBeenCalledOnce();
});
it('deduplicates identical explicit operation ids and refuses altered requests', async () => {
  mocks.switch.mockResolvedValue({ status: { current: 'main' } });
  const run = handler();
  expect(await run({}, req)).toEqual(await run({}, req));
  await expect(run({}, { ...req, branch: 'other' })).rejects.toThrow('checkout:changed');
  expect(mocks.switch).toHaveBeenCalledOnce();
});
it('keeps outcomes and undo receipts scoped to the original account and controller', async () => {
  mocks.switch.mockResolvedValue({ status: { current: 'main' }, receipt: { id: 'receipt' } });
  const run = handler();
  await run({}, req);
  scope = 'other/controller';
  await expect(
    run({}, { baseRepo: path.resolve('checkout-fixture'), action: 'result', operationId }),
  ).rejects.toThrow('checkout:changed');
  await expect(
    run(
      {},
      {
        baseRepo: path.resolve('checkout-fixture'),
        action: 'undo',
        receiptId: 'receipt',
        operationId: '7a7768e7-e652-4458-9c15-96af310bc9cb',
      },
    ),
  ).rejects.toThrow();
  expect(mocks.undo).not.toHaveBeenCalled();
});
