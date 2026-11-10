/** Unit: public bridge configuration/factory. Embedded/CLI V2 relays had no
 * delivery callback even when a provider bridge was configured. Kernel socket
 * tests inject notify directly and cannot catch missing host configuration.
 * Minimal failures: a partial endpoint/secret pair, a malformed secret, or a
 * rejected delivery exposing upstream text. A separate module needs filesystem
 * and fetch fakes, unlike identity or actual-socket tests; no real I/O/waits. */
import { expect, it, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createNotificationBridge, readNotificationBridgeConfig } from '../notificationBridge.js';
const secretFile = path.join(tmpdir(), 'unit-agent-net-notification-token');
it('requires an explicit secure endpoint and absolute operator-secret file together', () => {
  expect(readNotificationBridgeConfig({})).toBeUndefined();
  for (const env of [{ AGENT_NET_NOTIFICATION_URL: 'https://push.example.test' },
    { AGENT_NET_NOTIFICATION_URL: 'http://push.example.test', AGENT_NET_NOTIFICATION_SECRET_FILE: secretFile },
    { AGENT_NET_NOTIFICATION_URL: 'https://user:unit@push.example.test', AGENT_NET_NOTIFICATION_SECRET_FILE: secretFile },
    { AGENT_NET_NOTIFICATION_URL: 'https://push.example.test', AGENT_NET_NOTIFICATION_SECRET_FILE: 'relative-secret' }])
    expect(() => readNotificationBridgeConfig(env)).toThrow();
});
it('delivers only opaque notification data to the configured provider with no redirects or upstream error text', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response('unit-private-upstream-diagnostic', { status: 403 }));
  const notify = (await createNotificationBridge({ url: 'https://push.example.test', secretFile },
    { fetch: request, readSecret: async file => { expect(file).toBe(secretFile); return 'unit-public-fixture-'.repeat(3); } }))!;
  const input = { networkId: 'private:unit', from: 'owner', to: 'phone', ciphertext: 'unit-encrypted-envelope',
    registration: { provider: 'fcm' as const, token: 'unit-push-destination', appVariant: 'global' as const, apnsEnv: 'prod' as const } };
  await notify(input);
  expect(request.mock.calls[0][0]).toBe('https://push.example.test');
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', body: JSON.stringify(input),
    headers: { authorization: 'Bearer ' + 'unit-public-fixture-'.repeat(3) } });
  await expect(notify(input)).rejects.toThrow(/^NOTIFICATION_DELIVERY_FAILED$/);
});
it('refuses unreadable or invalid secrets before making a delivery request', async () => {
  const request = vi.fn();
  for (const secret of ['short', 'A'.repeat(33) + '\n' + 'B'.repeat(33)])
    await expect(createNotificationBridge({ url: 'https://push.example.test', secretFile }, { fetch: request, readSecret: async () => secret }))
      .rejects.toThrow('INVALID_NOTIFICATION_SECRET');
  await expect(createNotificationBridge({ url: 'https://push.example.test', secretFile },
    { fetch: request, readSecret: async () => { throw new Error('unit-private-file-diagnostic'); } }))
    .rejects.toThrow(/^INVALID_NOTIFICATION_SECRET$/);
  expect(request).not.toHaveBeenCalled();
});
