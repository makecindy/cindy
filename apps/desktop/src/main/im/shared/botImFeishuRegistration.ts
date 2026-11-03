/**
 * 伙伴自有飞书连接的扫码授权会话。
 *
 * 协议与 设置 → IM 机器人 相同(device-code), 但成功的凭证直接落成一条伙伴连接,
 * 不经过 renderer。轮次语义也与设置页一致: 每次 begin 推进 runId, 旧轮次的结果
 * 一律丢弃; cancel 广播 cancelled 并让在途轮次失效。
 */
import type {
  FeishuAppRegistrationBegin,
  FeishuAppRegistrationPoll,
  FeishuAppRegistrationSuccess,
} from '@cindy/im';

import type {
  BotImFeishuRegistrationBeginResult,
  BotImFeishuRegistrationStatus,
} from '../../../shared/botImConnection';

export interface FeishuConnectionRegistrationOptions {
  service: 'feishu' | 'lark';
  request: (service: 'feishu' | 'lark') => Promise<FeishuAppRegistrationBegin>;
  poll: (
    service: 'feishu' | 'lark',
    deviceCode: string,
    interval: number,
  ) => Promise<FeishuAppRegistrationPoll>;
  /** 授权成功后落成连接; 抛错即按失败收口。 */
  commit: (success: FeishuAppRegistrationSuccess, isCurrent: () => boolean) => Promise<void>;
  /** 轮次之外仍然有效的条件(账号未切换、伙伴仍可用)。 */
  isCurrent: () => boolean;
  onStatus: (status: BotImFeishuRegistrationStatus) => void;
}

interface ActiveSession {
  id: number;
  onStatus: (status: BotImFeishuRegistrationStatus) => void;
}

let nextRunId = 0;
let active: ActiveSession | null = null;

export function cancelFeishuConnectionRegistration(): void {
  const cancelled = active;
  active = null;
  if (!cancelled) return;
  cancelled.onStatus({ status: 'cancelled', runId: cancelled.id });
}

export async function startFeishuConnectionRegistration(
  options: FeishuConnectionRegistrationOptions,
): Promise<BotImFeishuRegistrationBeginResult> {
  cancelFeishuConnectionRegistration();
  const id = ++nextRunId;
  active = { id, onStatus: options.onStatus };
  const isCurrent = () => active?.id === id && options.isCurrent();

  let begin: FeishuAppRegistrationBegin;
  try {
    begin = await options.request(options.service);
  } catch (err) {
    const error = messageOf(err);
    if (active?.id === id) {
      active = null;
      options.onStatus({ status: 'error', runId: id, error });
    }
    return { ok: false, error };
  }
  if (!isCurrent()) return { ok: false, error: 'CANCELLED' };

  void poll(id, isCurrent, options, begin);
  return {
    ok: true,
    userCode: begin.userCode,
    verificationUrl: begin.verificationUrl,
    expiresIn: begin.expiresIn,
    runId: id,
  };
}

async function poll(
  id: number,
  isCurrent: () => boolean,
  options: FeishuConnectionRegistrationOptions,
  begin: FeishuAppRegistrationBegin,
): Promise<void> {
  const finish = (status: BotImFeishuRegistrationStatus) => {
    // 账号切换等失效条件不再广播; 但本轮的模块状态必须清掉, 不能留着当幽灵轮次。
    const stillCurrent = isCurrent();
    if (active?.id === id) active = null;
    if (stillCurrent) options.onStatus(status);
  };

  const deadline = Date.now() + begin.expiresIn * 1000;
  let interval = Math.max(begin.interval, 1);
  let service = options.service;
  let immediate = false;

  while (Date.now() < deadline && isCurrent()) {
    if (!immediate) {
      await delay(interval * 1000);
      if (!isCurrent()) return;
    }
    immediate = false;

    let result: FeishuAppRegistrationPoll;
    try {
      result = await options.poll(service, begin.deviceCode, interval);
    } catch (err) {
      finish({ status: 'error', runId: id, error: messageOf(err) });
      return;
    }
    if (!isCurrent()) return;

    const discovered = result.status === 'success' ? result.result.tenantBrand : result.tenantBrand;
    if (service === 'feishu' && discovered === 'lark') {
      service = 'lark';
      immediate = true;
      continue;
    }

    if (result.status === 'pending') {
      options.onStatus({ status: 'pending', runId: id });
      continue;
    }
    if (result.status === 'slow_down') {
      interval = result.interval;
      options.onStatus({ status: 'pending', runId: id });
      continue;
    }
    if (result.status === 'success') {
      if (!result.result.clientId || !result.result.clientSecret) {
        options.onStatus({ status: 'pending', runId: id });
        continue;
      }
      try {
        await options.commit(
          { ...result.result, tenantBrand: result.result.tenantBrand ?? service },
          isCurrent,
        );
      } catch (err) {
        finish({ status: 'error', runId: id, error: messageOf(err) });
        return;
      }
      finish({ status: 'success', runId: id });
      return;
    }
    if (result.status === 'expired') {
      finish({ status: 'expired', runId: id, error: result.message });
      return;
    }
    finish({ status: 'error', runId: id, error: result.message });
    return;
  }

  finish({ status: 'expired', runId: id });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
