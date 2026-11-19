import { describe, expect, it, vi } from 'vitest';
import { generateSharedImage } from '../sharedImageClient';
import { createSharedImageJobs } from '../sharedImageJobs';

describe('shared image result delivery', () => {
  it('releases the accepted job when the start acknowledgement is lost', async () => {
    const jobs = createSharedImageJobs();
    const allow = () => undefined;
    const generate = async () => ({ buffer: Buffer.from('image'), mimeType: 'image/png' });
    const invoke = vi.fn<Parameters<typeof generateSharedImage>[0]>(async (command) => {
      if (command.action === 'start') {
        jobs.start('guest', command.requestId, allow, generate);
        throw new Error('start acknowledgement timed out');
      }
      if (command.action === 'release') {
        jobs.release('guest', command.requestId);
        return {};
      }
      throw new Error('unexpected result read');
    });
    try {
      await expect(generateSharedImage(invoke, {
        op: 'shared-image', action: 'start', requestId: 'first',
        providerId: 'openai', model: 'openai/gpt-image-2', prompt: 'blue square',
      }, new AbortController().signal)).rejects.toThrow('start acknowledgement timed out');
      expect(invoke.mock.calls.map(([command]) => command.action)).toEqual(['start', 'release']);
      expect(() => jobs.start('guest', 'second', allow, generate)).not.toThrow();
    } finally {
      jobs.dispose();
    }
  });

  it('isolates concurrent relayed guests and keeps released records from blocking new jobs', () => {
    const jobs = createSharedImageJobs();
    const allow = () => undefined;
    const generate = async () => ({ buffer: Buffer.from('image'), mimeType: 'image/png' });
    try {
      jobs.start('coordinator', 'first', allow, generate, 'guest-one');
      jobs.start('coordinator', 'second', allow, generate, 'guest-two');
      expect(() => jobs.start('coordinator', 'third', allow, generate, 'guest-one')).toThrow('SHARED_IMAGE_BUSY');
      jobs.release('coordinator', 'first');
      jobs.release('coordinator', 'second');
      for (let i = 0; i < 65; i += 1) {
        const request = String(i);
        jobs.start('coordinator', request, allow, generate, 'guest-one');
        jobs.release('coordinator', request);
      }
    } finally {
      jobs.dispose();
    }
  });

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
