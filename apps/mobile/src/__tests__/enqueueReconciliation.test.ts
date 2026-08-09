import { DeviceLinkError } from '@cindy/device-link';
import { expect, it } from 'vitest';
import { reconcileEnqueueFailure } from '@/session/enqueueReconciliation';
const inFlight = new DeviceLinkError('NOT_CONNECTED', 'ack lost');
inFlight.inFlight = true;
const reconcile = (error: unknown, read = async () => false) => reconcileEnqueueFailure({ error, readAuthoritativeAcceptance: read });
it('classifies enqueue failures by positive evidence and delivery ambiguity', async () => {
  const unknown = [inFlight, new DeviceLinkError('INVOKE_TIMEOUT', 'reply lost'), new Error('INVOKE_TIMEOUT')];
  for (const error of unknown) expect(await reconcile(error)).toBe('unknown');
  await expect(reconcile(inFlight, async () => { throw new Error('offline'); })).resolves.toBe('unknown');
  const rejected = ['NOT_CONNECTED', 'BACKPRESSURE', 'LINK_NOT_OPEN', 'ACCESS_REVOKED'] as const;
  for (const code of rejected) expect(await reconcile(new DeviceLinkError(code, code))).toBe('rejected');
  await expect(reconcile(inFlight, async () => true)).resolves.toBe('accepted');
});
