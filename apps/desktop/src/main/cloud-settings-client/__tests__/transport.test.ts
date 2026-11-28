import { expect, it, vi } from 'vitest';
import { CloudClientError, createCloudClientHttp } from '../transport';

const owner = {
  key: 'owner',
  generation: 1,
  baseUrl: 'https://cis.example.test/api',
  accessToken: 'invalid-test-token',
};
const signal = () => new AbortController().signal;

it('uses the configured HTTPS base and bearer without cookies, redirects or referrers', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  expect(
    await createCloudClientHttp(fetcher).request(
      owner,
      '/client/settings',
      'POST',
      { example: true },
      signal(),
      () => {},
    ),
  ).toEqual({ ok: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([
    'https://cis.example.test/api/client/settings',
    expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer invalid-test-token', 'Content-Type': 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: '{"example":true}',
    }),
  ]);
});
it.each([
  'http://cis.example.test',
  'https://u:p@cis.example.test',
  'https://cis.example.test?token=x',
  'https://cis.example.test#fragment',
  'invalid',
])('refuses an invalid configured endpoint %s without sending credentials', async (baseUrl) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createCloudClientHttp(fetcher).request(
      { ...owner, baseUrl },
      '/client/settings',
      'GET',
      undefined,
      signal(),
      () => {},
    ),
  ).rejects.toThrow('NOT_READY');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['https://other.example.test', '//other.example.test', '/../credentials'])(
  'rejects an arbitrary transport path %s',
  async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createCloudClientHttp(fetcher).request(owner, path, 'GET', undefined, signal(), () => {}),
    ).rejects.toThrow('NOT_READY');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  [401, 'SCOPE_CHANGED'],
  [403, 'SCOPE_CHANGED'],
  [404, 'UNSUPPORTED'],
  [501, 'UNSUPPORTED'],
  [429, 'BUSY'],
  [500, 'UNAVAILABLE'],
] as const)('maps HTTP %s without leaking the response body or retrying', async (status, code) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('private-response-body', { status }));
  const error = (await createCloudClientHttp(fetcher)
    .request(owner, '/client/settings', 'POST', {}, signal(), () => {})
    .catch((e) => e)) as Error;
  expect(error.message).toBe(`CLOUD_SETTINGS_${code}`);
  expect(error.message).not.toContain('private');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  [403, 'CLOUD_MEMBER_SUSPENDED', 'MEMBER_SUSPENDED'],
  [403, 'MANAGEMENT_ACCESS_DENIED', 'ACCESS_DENIED'],
  [403, 'CLOUD_ADMISSION_NOT_LISTED', 'ADMISSION_NOT_LISTED'],
  [409, 'INSTANCE_QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
  [409, 'CLOUD_INSTANCE_TRANSFERRED', 'INSTANCE_TRANSFERRED'],
  [409, 'CLOUD_INSTANCE_HANDOVER_IN_PROGRESS', 'TRANSFER_IN_PROGRESS'],
  // Anything else keeps the status mapping, and nothing but a known code is kept.
  [403, 'SOMETHING_ELSE', 'SCOPE_CHANGED'],
  [409, 'toString', 'SCOPE_CHANGED'],
] as const)('keeps the CIS refusal %s %s as its own code', async (status, remote, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ error: { code: remote, message: 'private-detail' } }, { status }),
  );
  const error = (await createCloudClientHttp(fetcher)
    .request(owner, '/instance-login/api/manage/instances/wake', 'POST', {}, signal(), () => {})
    .catch((e) => e)) as Error;
  expect(error).toBeInstanceOf(CloudClientError);
  expect(error.message).toBe(`CLOUD_SETTINGS_${code}`);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds streamed response size and cancels the reader', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(65537));
    },
    cancel,
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
  await expect(
    createCloudClientHttp(fetcher).request(
      owner,
      '/client/settings',
      'GET',
      undefined,
      signal(),
      () => {},
    ),
  ).rejects.toThrow('INVALID_RESPONSE');
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('rejects malformed JSON with a fixed public error', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-not-json'));
  await expect(
    createCloudClientHttp(fetcher).request(
      owner,
      '/client/settings',
      'GET',
      undefined,
      signal(),
      () => {},
    ),
  ).rejects.toThrow(/^CLOUD_SETTINGS_INVALID_RESPONSE$/);
});
it('drops a completed response after the owner boundary changes', async () => {
  let current = true;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    current = false;
    return Response.json({ secret: 'private' });
  });
  await expect(
    createCloudClientHttp(fetcher).request(
      owner,
      '/client/settings',
      'GET',
      undefined,
      signal(),
      () => {
        if (!current) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
      },
    ),
  ).rejects.toThrow('SCOPE_CHANGED');
});
it('does not expose raw network exceptions', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('Bearer invalid-test-token private-internal-host'));
  await expect(
    createCloudClientHttp(fetcher).request(
      owner,
      '/client/settings',
      'GET',
      undefined,
      signal(),
      () => {},
    ),
  ).rejects.toThrow(/^CLOUD_SETTINGS_UNAVAILABLE$/);
});
it('maps a maintenance PATCH conflict without treating it as a changed login', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 409 }));
  await expect(
    createCloudClientHttp(fetcher).request(
      owner,
      '/instances/example/maintenance',
      'PATCH',
      {},
      signal(),
      () => {},
    ),
  ).rejects.toThrow('CLOUD_SETTINGS_CONFLICT');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('maps owner upgrade conflicts without claiming the account changed or leaking error details', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { error: { code: 'NO_RELEASE_AVAILABLE', message: 'private' } },
        { status: 409 },
      ),
    );
  await expect(
    createCloudClientHttp(fetcher).request(
      owner,
      '/instances/owned/maintenance/upgrade',
      'POST',
      {},
      signal(),
      () => {},
    ),
  ).rejects.toThrow(/^CLOUD_SETTINGS_CONFLICT$/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('cancels only an exact CIS capability without sending either account bearer', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'cancelled' }));
  const http = createCloudClientHttp(fetcher);
  await http.cancelLogin!('https://cis.example.test', 'aaaaaaaa_bbbbbbbb-cccccc', 'x'.repeat(43));
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://cis.example.test/instance-login/api/attempts/aaaaaaaa_bbbbbbbb-cccccc/cancel',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptSecret: 'x'.repeat(43) }),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    }),
  );
});
it.each(['../foreign', 'aaaaaaaa_bbbbbbbb-cccccc/other', 'not-an-id'])(
  'rejects an injected cancellation path %s before fetch',
  async (id) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createCloudClientHttp(fetcher).cancelLogin!('https://cis.example.test', id, 'x'.repeat(43)),
    ).rejects.toThrow('INVALID_RESPONSE');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([404, 410])(
  'only definite missing/expired attempts allow native login retry (%s)',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(
      createCloudClientHttp(fetcher).request(
        owner,
        '/instance-login/api/attempts/aaaaaaaa_bbbbbbbb-cccccc/status',
        'POST',
        { attemptSecret: 'x'.repeat(43) },
        signal(),
        () => {},
      ),
    ).rejects.toThrow('NOT_READY');
  },
);
