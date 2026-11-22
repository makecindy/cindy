import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, net } from 'electron';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  safeStorage: {},
  app: {},
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../im/ownerScopedStorage', () => ({
  ownerScopedImSecrets: {
    read: vi.fn(() => null),
    write: vi.fn(() => true),
    remove: vi.fn(),
  },
}));
vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import {
  initWecomGroupNotificationIpc,
  WecomGroupNotificationService,
  __testing,
} from '../wecomGroupNotification';
import { ownerScopedImSecrets } from '../im/ownerScopedStorage';
import { activateImAccountBoundary, deactivateImAccountBoundary } from '../im/accountBoundary';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const WEBHOOK_SECRET_NAME = 'wecom-group-webhook-url';
const ENABLED_SETTING_NAME = 'wecom-group-notification-enabled';

function createSecrets(initialUrl: string | null = null, initialEnabled: string | null = null) {
  const values = new Map<string, string>();
  if (initialUrl !== null) values.set(WEBHOOK_SECRET_NAME, initialUrl);
  if (initialEnabled !== null) values.set(ENABLED_SETTING_NAME, initialEnabled);
  return {
    read: vi.fn((name: string) => values.get(name) ?? null),
    write: vi.fn((name: string, next: string) => {
      values.set(name, next);
      return true;
    }),
    remove: vi.fn((name: string) => {
      values.delete(name);
    }),
  };
}

describe('WeCom group notification security boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activateImAccountBoundary();
  });

  afterEach(() => activateImAccountBoundary());

  it('accepts only the official HTTPS webhook endpoint with one key parameter', () => {
    expect(() =>
      __testing.parseWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789'),
    ).not.toThrow();
    for (const invalid of [
      'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
      'https://evil.example/cgi-bin/webhook/send?key=x',
      'https://qyapi.weixin.qq.com.evil.example/cgi-bin/webhook/send?key=x',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x&next=https://evil.example',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
    ]) {
      expect(() => __testing.parseWebhookUrl(invalid)).toThrow('WECOM_GROUP_WEBHOOK_INVALID');
    }
  });

  it('splits UTF-8 text without breaking code points or exceeding the byte limit', () => {
    const chunks = __testing.splitUtf8('企'.repeat(20), 10);
    expect(chunks.join('')).toBe('企'.repeat(20));
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 10)).toBe(true);
  });

  it('tests before persisting and never exposes the stored URL', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return response({ errcode: 0, errmsg: 'ok' });
    });
    const secrets = createSecrets();
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    const state = await service.saveAndTest(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
      'Localized test message',
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
    expect(secrets.write).toHaveBeenCalledTimes(2);
    expect(secrets.write).toHaveBeenNthCalledWith(1, WEBHOOK_SECRET_NAME, expect.any(String));
    expect(secrets.write).toHaveBeenNthCalledWith(2, ENABLED_SETTING_NAME, 'true');
    expect(state).toEqual({ configured: true, enabled: true, maskedKey: '••••efgh' });
    expect(JSON.stringify(service.getState())).not.toContain('abcdefgh');
    expect(sentBody).toContain('Localized test message');
  });

  it('keeps existing webhook configurations enabled until the user turns them off', () => {
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(vi.fn(), createSecrets(url));

    expect(service.getState()).toEqual({
      configured: true,
      enabled: true,
      maskedKey: '••••efgh',
    });
  });

  it('uses the persisted master switch to gate automation publishes', async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: 0, errmsg: 'ok' }));
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const secrets = createSecrets(url);
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    expect(service.setEnabled(false).enabled).toBe(false);
    await expect(service.publishMarkdown('automation result')).rejects.toThrow(
      'WECOM_GROUP_NOTIFICATIONS_DISABLED',
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    expect(service.setEnabled(true).enabled).toBe(true);
    await service.publishMarkdown('automation result');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('allows an explicit test while the automation master switch is off', async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: 0, errmsg: 'ok' }));
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url, 'false'));

    await service.test('Localized test message');

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not send a queued test after the account boundary changes', async () => {
    let releasePublish: (() => void) | undefined;
    let current = true;
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      return response({ errcode: 0, errmsg: 'ok' });
    });
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    const publish = service.publishMarkdown('automation result');
    const testing = service.test('Localized test message', () => current);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    current = false;
    releasePublish?.();

    await expect(publish).resolves.toBeUndefined();
    await expect(testing).rejects.toThrow('IM account changed');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not send a queued test after the webhook configuration changes', async () => {
    let releasePublish: (() => void) | undefined;
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      return response({ errcode: 0, errmsg: 'ok' });
    });
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    const publish = service.publishMarkdown('automation result');
    const testing = service.test('Localized test message');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    service.clear();
    releasePublish?.();

    await expect(publish).resolves.toBeUndefined();
    await expect(testing).rejects.toThrow('WECOM_GROUP_CONFIG_CHANGED');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not persist a webhook when the test call fails', async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: 93000, errmsg: 'invalid' }));
    const secrets = createSecrets();
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    await expect(
      service.saveAndTest(
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
        'Localized test message',
      ),
    ).rejects.toThrow('WECOM_GROUP_SEND_FAILED:93000');
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('does not persist a tested webhook after the account boundary changes', async () => {
    let release: (() => void) | undefined;
    let current = true;
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response({ errcode: 0, errmsg: 'ok' });
    });
    const secrets = createSecrets();
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    const saving = service.saveAndTest(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
      'Localized test message',
      () => current,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    current = false;
    release?.();

    await expect(saving).rejects.toThrow('IM account changed');
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('does not resurrect a webhook save that was queued before clear', async () => {
    let releasePublish: (() => void) | undefined;
    const existingUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=existing';
    const replacementUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=replacement';
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      return response({ errcode: 0, errmsg: 'ok' });
    });
    const secrets = createSecrets(existingUrl, 'true');
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    const publishing = service.publishMarkdown('blocking publish');
    const saving = service.saveAndTest(replacementUrl, 'Localized test message');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    expect(service.clear()).toEqual({ configured: false, enabled: false });
    releasePublish?.();

    await expect(publishing).resolves.toBeUndefined();
    await expect(saving).rejects.toThrow('WECOM_GROUP_CONFIG_CHANGED');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(service.getState()).toEqual({ configured: false, enabled: false });
  });

  it('rejects redirects instead of following a changed destination', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example' },
        }),
    );
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    await expect(service.test('Localized test message')).rejects.toThrow(
      'WECOM_GROUP_REDIRECT_REJECTED',
    );
  });

  it('serializes concurrent publishes to preserve message order', async () => {
    const releases: Array<() => void> = [];
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      await new Promise<void>((resolve) => releases.push(resolve));
      return response({ errcode: 0 });
    });
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    const first = service.publishMarkdown('first');
    const second = service.publishMarkdown('second');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(bodies[0]).toContain('first');
    expect(bodies[1]).toContain('second');
  });

  it('stops queued chunks after the master switch is disabled', async () => {
    let releaseFirstChunk: (() => void) | undefined;
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstChunk = resolve;
      });
      return response({ errcode: 0 });
    });
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    const publishing = service.publishMarkdown('a'.repeat(4_001));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    service.setEnabled(false);
    releaseFirstChunk?.();

    await expect(publishing).rejects.toThrow('WECOM_GROUP_NOTIFICATIONS_DISABLED');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not send a queued publish through a replacement account webhook', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=account-one';
    const secondUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=account-two';
    const secrets = createSecrets(firstUrl);
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return response({ errcode: 0 });
    });
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    const first = service.publishMarkdown('first');
    const second = service.publishMarkdown('second');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    deactivateImAccountBoundary();
    secrets.write(WEBHOOK_SECRET_NAME, secondUrl);
    activateImAccountBoundary();
    releaseFirst?.();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow('IM account changed');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(firstUrl, expect.any(Object));
  });

  it.each([
    { channel: 'wecomGroupNotification:test', args: ['Localized test message'] },
    { channel: 'wecomGroupNotification:set-enabled', args: [false] },
    { channel: 'wecomGroupNotification:clear', args: [] },
  ])('rejects $channel when the account generation changes before mutation', async ({
    channel,
    args,
  }) => {
    type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
    const handlers = new Map<string, RegisteredHandler>();
    vi.mocked(ipcMain.handle).mockImplementation((registeredChannel, handler) => {
      handlers.set(registeredChannel, handler as RegisteredHandler);
    });
    initWecomGroupNotificationIpc();

    const handler = handlers.get(channel);
    expect(handler).toBeDefined();
    const operation = Promise.resolve(handler?.({}, ...args));
    deactivateImAccountBoundary();

    await expect(operation).rejects.toThrow('IM account changed');
    expect(ownerScopedImSecrets.write).not.toHaveBeenCalled();
    expect(ownerScopedImSecrets.remove).not.toHaveBeenCalled();
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('clears both the webhook and its master switch', () => {
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const secrets = createSecrets(url, 'true');
    const service = new WecomGroupNotificationService(vi.fn(), secrets);

    expect(service.clear()).toEqual({ configured: false, enabled: false });
    expect(secrets.remove).toHaveBeenCalledWith(WEBHOOK_SECRET_NAME);
    expect(secrets.remove).toHaveBeenCalledWith(ENABLED_SETTING_NAME);
  });
});
