import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule, Scheduler } from '@cindy/maker-scheduler';

// 测试价值
// - 生产入口与可观察结果：ScheduleWebhookHost 对本机地址的真实 HTTP 投递；断言状态码、监听生命周期和落盘内容。
// - 规则依据：docs/product-rules/schedule-webhook-trigger.md 的本机边界与密钥存储。
// - 现有覆盖缺口：ingress.test.ts 不经过 HTTP、不落盘。
// - 最小失败输入：未开启时访问端口、错误签名、带正文的已签名请求、关闭触发条件。
// - tier：unit，只用回环地址和临时目录。

const dirs = vi.hoisted(() => ({ root: '' }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/, ''),
  },
}));
vi.mock('../../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(dirs.root, ...parts),
}));
vi.mock('../../../plugin-oauth/identityStore.js', () => ({ oauthSecureStorageAvailable: () => true }));

import { ScheduleWebhookHost } from '../index';

class FakeScheduler extends EventEmitter {
  schedules: Schedule[] = [];
  runNow = vi.fn(async () => ({ runId: 'r1' }));
  async list() { return this.schedules; }
  async get(id: string) { return this.schedules.find((s) => s.id === id) ?? null; }
  getInflightCount() { return 0; }
  change(next: Schedule[]) {
    this.schedules = next;
    this.emit('changed');
  }
}

const withTrigger = { id: 's1', status: 'active', webhookTrigger: { endpointId: 'endpoint-1' } } as Schedule;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function post(url: string, body: string, secret?: string, event = 'issues') {
  return fetch(url, {
    method: 'POST',
    body,
    headers: {
      'x-github-event': event,
      'x-github-delivery': `d-${body.length}`,
      ...(secret ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } : {}),
    },
  });
}

describe('ScheduleWebhookHost', () => {
  let scheduler: FakeScheduler;
  let host: ScheduleWebhookHost;

  beforeEach(() => {
    dirs.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-schedule-webhook-'));
    scheduler = new FakeScheduler();
    host = new ScheduleWebhookHost(scheduler as unknown as Scheduler, {}, { local: true });
  });

  afterEach(async () => {
    await host.stop();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  it('listens on loopback only while a schedule has the trigger', async () => {
    await host.start();
    expect(host.status({ ...withTrigger })?.url).toBeUndefined();
    scheduler.change([withTrigger]);
    await flush();
    const { url } = host.status(withTrigger)!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/schedule-webhook\/endpoint-1$/);
    scheduler.change([]);
    await flush();
    await expect(post(url!, '{}')).rejects.toThrow();
  });

  it('accepts only signed deliveries, and stores neither the body nor the secret in plain text', async () => {
    scheduler.schedules = [withTrigger];
    await host.start();
    const url = host.status(withTrigger)!.url!;
    expect((await post(url, '{}')).status).toBe(401);

    const { secret } = await host.rotateSecret(withTrigger);
    expect(host.status(withTrigger)?.hasSecret).toBe(true);
    expect((await post(url, '{}', 'wrong-secret')).status).toBe(401);
    expect((await post(`${url}-other`, '{}', secret)).status).toBe(404);

    const body = JSON.stringify({ action: 'opened', issue: { number: 1, title: 'private-issue-title' } });
    expect((await post(url, body, secret)).status).toBe(202);
    expect((await post(url, body, secret)).status).toBe(200);

    const onDisk = [
      fs.readFileSync(path.join(dirs.root, 'schedule-webhooks', 'state.json'), 'utf8'),
      fs.readFileSync(path.join(dirs.root, 'schedule-webhooks', 'secrets', 'endpoint-1.enc'), 'utf8'),
    ].join('\n');
    expect(onDisk).not.toContain('private-issue-title');
    expect(onDisk).not.toContain(secret);
  });

  it('still reads a stored secret after restart, without it being issued again', async () => {
    scheduler.schedules = [withTrigger];
    await host.start();
    const { secret } = await host.rotateSecret(withTrigger);
    await host.stop();
    host = new ScheduleWebhookHost(scheduler as unknown as Scheduler, {}, { local: true });
    await host.start();
    expect((await post(host.status(withTrigger)!.url!, '{}', secret)).status).toBe(202);
  });

  it('revokes the old address and secret when the trigger is turned off', async () => {
    scheduler.schedules = [withTrigger];
    await host.start();
    const { secret } = await host.rotateSecret(withTrigger);
    const other = { ...withTrigger, id: 's2', webhookTrigger: { endpointId: 'endpoint-2' } } as Schedule;
    scheduler.change([{ ...withTrigger, webhookTrigger: undefined }, other]);
    await flush();
    expect(fs.existsSync(path.join(dirs.root, 'schedule-webhooks', 'secrets', 'endpoint-1.enc'))).toBe(false);
    const url = host.status(other)!.url!.replace('endpoint-2', 'endpoint-1');
    expect((await post(url, '{}', secret)).status).toBe(404);
  });

  it('does not leave a port open when the account switches during startup', async () => {
    scheduler.schedules = [withTrigger];
    const starting = host.start();
    await host.stop();
    await starting;
    expect(host.status(withTrigger)?.url).toBeUndefined();
  });

  it('stops accepting after an account switch', async () => {
    scheduler.schedules = [withTrigger];
    await host.start();
    const url = host.status(withTrigger)!.url!;
    await host.stop();
    await expect(post(url, '{}')).rejects.toThrow();
  });
});
