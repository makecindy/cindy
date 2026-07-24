import { describe, expect, it, vi } from 'vitest';
import { ModerationClient } from '../client.js';

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const reviewInput = {
  signBaseUrl: 'https://sign.example.com',
  accessToken: 'access-token',
  membershipId: 'member-1',
  businessCode: 'maker-nickname' as const,
  dataId: 'profile-nickname:member-1:mutation-1',
  items: [{ type: 'TEXT' as const, data: 'Alice', content_id: 'mutation-1:text:0' }],
  deadlineMs: 5_000,
};

function signedResponse() {
  return response({
    gateway_base_url: 'https://moderation.example.com/gateway',
    logical_path: '/api/v1/review/submit',
    headers: {
      Authorization: 'short-lived-hmac',
      'X-Timestamp': '1700000000',
      'X-Nonce': '00112233445566778899aabbccddeeff',
      'Content-Type': 'application/json',
    },
  }, 200);
}

describe('ModerationClient', () => {
  it('queries once per second and rejects only an explicit status 3', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(signedResponse())
      .mockResolvedValueOnce(response({
        code: 200,
        data: { task_token: 'task-token', status: 1 },
      }, 201))
      .mockResolvedValueOnce(response({ code: 200, data: { status: 1 } }, 200))
      .mockResolvedValueOnce(response({ code: 200, data: { status: 3 } }, 200));
    const promise = new ModerationClient(fetchMock as typeof fetch).review(reviewInput);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe('reject');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'https://moderation.example.com/gateway/api/v1/review/tasks',
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer task-token' },
    });
    vi.useRealTimers();
  });

  it.each([
    ['approved', 2],
    ['manual-required', 4],
  ])('allows immediate %s submit status', async (_label, status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(signedResponse())
      .mockResolvedValueOnce(response({
        code: 200,
        data: { task_token: 'task-token', status },
      }, 201));
    await expect(
      new ModerationClient(fetchMock as typeof fetch).review(reviewInput),
    ).resolves.toBe('allow');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails open on malformed responses and unknown status', async () => {
    const malformed = vi.fn().mockResolvedValue(response({ nope: true }, 200));
    await expect(
      new ModerationClient(malformed as typeof fetch).review(reviewInput),
    ).resolves.toBe('allow');

    const unknown = vi.fn()
      .mockResolvedValueOnce(signedResponse())
      .mockResolvedValueOnce(response({
        code: 200,
        data: { task_token: 'task-token', status: 9 },
      }, 201));
    await expect(
      new ModerationClient(unknown as typeof fetch).review(reviewInput),
    ).resolves.toBe('allow');
  });
});
