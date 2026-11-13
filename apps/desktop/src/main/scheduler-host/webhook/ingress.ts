/**
 * 自动化任务 Webhook 的进站逻辑：验签、提取元数据、筛选、入队。
 * 不依赖传输方式：本机 HTTP 是第一个来源，之后服务端推送走同一入口。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  RoutineEventAdmission,
  scheduleWebhookEventMatches,
  type Schedule,
  type ScheduleWebhookAcceptResult,
  type ScheduleWebhookEvent,
} from '@cindy/maker-scheduler';

const FIELD_MAX = 200;

export interface WebhookDelivery {
  endpointId: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type WebhookDeliveryOutcome =
  | ScheduleWebhookAcceptResult
  | 'filtered'
  | 'ping'
  | 'not-found'
  | 'no-secret'
  | 'bad-signature'
  | 'rate-limited'
  | 'store-failed';

export interface WebhookIngressDeps {
  findSchedule(endpointId: string): Schedule | undefined;
  readSecret(endpointId: string): string | null;
  accept(scheduleId: string, event: ScheduleWebhookEvent): Promise<ScheduleWebhookAcceptResult>;
  touch(scheduleId: string): void;
  now(): number;
  onStoreError?(error: unknown): void;
}

const header = (headers: WebhookDelivery['headers'], name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const shortText = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, FIELD_MAX) : undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 只取固定字段；标题、正文、评论等自由文本不进入任务，也不落盘。 */
export function extractWebhookEvent(delivery: Pick<WebhookDelivery, 'headers' | 'body'>, receivedAt: number): ScheduleWebhookEvent {
  const { headers, body } = delivery;
  let payload: Record<string, unknown> = {};
  try {
    payload = record(JSON.parse(body.toString('utf8')));
  } catch {
    // 非 JSON 正文仍是一次有效门铃。
  }
  const checkSuite = record(payload.check_suite);
  const pullRequest = record(payload.pull_request);
  const firstCheckPr = record(Array.isArray(checkSuite.pull_requests) ? checkSuite.pull_requests[0] : undefined);
  const number = [pullRequest.number, record(payload.issue).number, firstCheckPr.number, payload.number]
    .find((value): value is number => Number.isSafeInteger(value));
  const event: ScheduleWebhookEvent = {
    deliveryId: shortText(header(headers, 'x-github-delivery') ?? header(headers, 'x-webhook-delivery'))
      ?? createHash('sha256').update(body).digest('hex'),
    event: shortText(header(headers, 'x-github-event') ?? header(headers, 'x-webhook-event')) ?? 'webhook',
    receivedAt,
  };
  const action = shortText(payload.action);
  const repository = shortText(record(payload.repository).full_name);
  const sender = shortText(record(payload.sender).login);
  const headSha = shortText(checkSuite.head_sha ?? record(pullRequest.head).sha);
  const conclusion = shortText(checkSuite.conclusion);
  return {
    ...event,
    ...(action ? { action } : {}),
    ...(repository ? { repository } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(sender ? { sender } : {}),
    ...(headSha ? { headSha } : {}),
    ...(conclusion ? { conclusion } : {}),
  };
}

export function createWebhookIngress(deps: WebhookIngressDeps) {
  const admission = new RoutineEventAdmission();
  return async function handleDelivery(delivery: WebhookDelivery): Promise<WebhookDeliveryOutcome> {
    const schedule = deps.findSchedule(delivery.endpointId);
    if (!schedule?.webhookTrigger) return 'not-found';
    const secret = deps.readSecret(delivery.endpointId);
    if (!secret) return 'no-secret';
    if (!verifySignature(secret, delivery.body, header(delivery.headers, 'x-hub-signature-256'))) return 'bad-signature';
    const now = deps.now();
    const event = extractWebhookEvent(delivery, now);
    if (event.event === 'ping') {
      deps.touch(schedule.id);
      return 'ping';
    }
    if (!scheduleWebhookEventMatches(schedule.webhookTrigger.events, event)) {
      deps.touch(schedule.id);
      return 'filtered';
    }
    let release: () => void;
    try {
      release = admission.acquire(schedule.id, now);
    } catch {
      return 'rate-limited';
    }
    try {
      return await deps.accept(schedule.id, event);
    } catch (error) {
      deps.onStoreError?.(error);
      return 'store-failed';
    } finally {
      release();
    }
  };
}
