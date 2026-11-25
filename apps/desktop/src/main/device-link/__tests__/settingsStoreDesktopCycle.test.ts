/**
 * The availability policy reaches back into Device Link settings, so the desktop settings
 * store can initialize before the policy's exports exist (the bundle order decides which
 * module of the cycle runs first). The store must not read the policy port while it
 * initializes, and must still reach the live policy once it is ready.
 */
import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  policyReady: false,
  mutation: vi.fn(async (_providerId: string | undefined, work: () => Promise<unknown>) => work()),
  ports: null as null | {
    withAvailabilityPolicyMutation: (providerId: string | undefined, work: () => Promise<unknown>) => Promise<unknown>;
  },
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userdata' } }));
vi.mock('../providerShareAvailabilityPolicy.js', () => ({
  get withAvailabilityPolicyMutation() {
    if (!h.policyReady) throw new ReferenceError("Cannot access 'withAvailabilityPolicyMutation' before initialization");
    return h.mutation;
  },
}));
vi.mock('../settings-store.js', () => ({
  createDeviceLinkSettingsStore: (ports: NonNullable<typeof h.ports>) => {
    h.ports = ports;
    return {};
  },
}));

it('initializes before the availability policy and forwards to it once ready', async () => {
  await import('../settings-store.desktop.js');
  expect(h.mutation).not.toHaveBeenCalled();

  h.policyReady = true;
  const work = vi.fn(async () => 'written');
  await expect(h.ports?.withAvailabilityPolicyMutation(undefined, work)).resolves.toBe('written');
  expect(h.mutation).toHaveBeenCalledWith(undefined, work);
});
