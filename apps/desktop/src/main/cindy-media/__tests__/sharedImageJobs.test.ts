import { describe, expect, it, vi } from 'vitest';
import { createSharedImageJobs } from '../sharedImageJobs';

describe('shared image result delivery', () => {
  it('does not execute the same request twice and binds reads to its controller', async () => {
    const jobs = createSharedImageJobs();
    const assertAllowed = vi.fn();
    const generate = vi.fn(async () => ({ buffer: Buffer.from('image'), mimeType: 'image/png' }));
    try {
      jobs.start('guest-one', 'request', assertAllowed, generate);
      jobs.start('guest-one', 'request', assertAllowed, generate);
      await vi.waitFor(async () => expect(await jobs.read('guest-one', 'request', 0)).toEqual({
        state: 'complete', data: 'aW1hZ2U=', mimeType: 'image/png', size: 5,
      }));
      expect(generate).toHaveBeenCalledTimes(1);
      await expect(jobs.read('guest-two', 'request', 0)).rejects.toThrow();
      assertAllowed.mockImplementation(() => { throw new Error('revoked'); });
      await expect(jobs.read('guest-one', 'request', 0)).rejects.toThrow('revoked');
    } finally {
      jobs.dispose();
    }
  });
});
