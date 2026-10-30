/**
 * 任务进行中换号(provider-groups.md §6.2，2026-10-21 用户裁决「手机和电脑一样」)：上一轮结束后用户发下一条消息前，
 * 看任务所在电脑是否提议为了均匀用完各账号的配额换一台。要换就弹窗(换过去 / 换过去并以后自动换 / 取消，手机弹窗
 * 没有复选框，用第二个按钮代替电脑上的「以后自动换」勾选)，只管这个任务；选过以后自动换的不再弹窗，直接换。
 *
 * 判断和记录都在任务所在电脑(`provider-group:remote` 的 `rebalance-suggestion` / `rebalance-decision`)。点发送要立刻清空
 * 输入框、不等网络往返，所以提议在任务空闲时预先问好(上一轮结束、打开任务时，空闲期间每 5 分钟再问)，发送时只用问好的
 * 结果；没问到、问不到、旧版本不认识这个请求都按不提议处理。无论用户怎么选，这条消息都照常发出。
 */
import { useEffect } from 'react';
import { Alert } from 'react-native';

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import { i18n } from '@/i18n';

import { formatLocalizedSeconds } from './sessionDurationFormat';

/** 预先问一次的上限：问不到就当没有提议。 */
export const SESSION_REBALANCE_QUERY_TIMEOUT_MS = 5_000;
/** 问到的提议多久内可用：与组所在电脑判断配额用的快照有效期一致。 */
export const SESSION_REBALANCE_CACHE_MS = 10 * 60_000;
/** 任务空闲、开着时多久重新问一次。 */
export const SESSION_REBALANCE_REFRESH_MS = 5 * 60_000;
const MAX_PREFETCHED = 100;

// 与桌面端 shared/providerGroup.ts 读这个回包的口径一致。
const MEMBER_KEY = /^[A-Za-z0-9_.:-]{1,300}$/;
// eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_WINDOW_MS = 31 * 86_400_000;
const MAX_REBALANCE_LABEL_LENGTH = 128 * 2 + 3;

export interface MobileRebalanceSuggestion {
  kind: 'ask' | 'auto';
  memberKey: string;
  label: string;
  quota: { usedPercent: number; resetAtMs: number | null; windowMs: number };
}

export type MobileRebalanceChoice = 'switch' | 'remember' | 'cancel';

type Invoke = (deviceId: string, channel: string, args?: unknown[]) => Promise<unknown>;

const prefetched = new Map<string, { at: number; suggestion: MobileRebalanceSuggestion | null }>();
const inFlight = new Set<string>();

function cacheKey(hostDeviceId: string, sessionId: string): string {
  return `${hostDeviceId}\u0000${sessionId}`;
}

/** 读 `rebalance-suggestion` 的回包；格式不对按不提议处理。 */
export function parseMobileRebalanceSuggestion(raw: unknown): MobileRebalanceSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'ask' && value.kind !== 'auto') return null;
  if (typeof value.memberKey !== 'string' || !MEMBER_KEY.test(value.memberKey)) return null;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const quota = value.quota as Record<string, unknown> | null | undefined;
  if (!label || label.length > MAX_REBALANCE_LABEL_LENGTH || CONTROL_CHARS.test(label) || !quota || typeof quota !== 'object') return null;
  const { usedPercent, resetAtMs, windowMs } = quota;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0 || windowMs > MAX_WINDOW_MS) return null;
  if (resetAtMs !== null && (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs) || resetAtMs <= 0)) return null;
  return {
    kind: value.kind,
    memberKey: value.memberKey,
    label,
    quota: { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetAtMs, windowMs },
  };
}

/** 弹窗正文：换到哪台、那台的配额还剩多少、多久重置，以及换过去会丢一部分上下文。 */
export function describeMobileRebalance(suggestion: MobileRebalanceSuggestion, nowMs = Date.now()): string {
  const left = Math.max(0, Math.round(100 - suggestion.quota.usedPercent));
  const remainingMs = suggestion.quota.resetAtMs === null ? null : suggestion.quota.resetAtMs - nowMs;
  const quota = remainingMs !== null && remainingMs > 0
    ? i18n.t('session.providerGroupRebalance.quotaReset', {
        left,
        reset: formatLocalizedSeconds(Math.ceil(remainingMs / 60_000) * 60),
      })
    : i18n.t('session.providerGroupRebalance.quota', { left });
  return i18n.t('session.providerGroupRebalance.body', { label: suggestion.label, quota });
}

/** 系统弹窗问用户；通过明确的取消按钮关闭，禁止点遮罩关闭。 */
export function askMobileSessionRebalance(suggestion: MobileRebalanceSuggestion): Promise<MobileRebalanceChoice> {
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t('session.providerGroupRebalance.title', { label: suggestion.label }),
      describeMobileRebalance(suggestion),
      [
        { text: i18n.t('session.providerGroupRebalance.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
        { text: i18n.t('session.providerGroupRebalance.remember'), onPress: () => resolve('remember') },
        { text: i18n.t('session.providerGroupRebalance.confirm'), onPress: () => resolve('switch') },
      ],
      { cancelable: false },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), SESSION_REBALANCE_QUERY_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 任务空闲时预先问好提议。同一个任务同时只问一次。 */
export async function prefetchMobileSessionRebalance(invoke: Invoke, hostDeviceId: string, sessionId: string): Promise<void> {
  const key = cacheKey(hostDeviceId, sessionId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const raw = await withTimeout(
      invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'rebalance-suggestion', sessionId }]),
      null,
    );
    prefetched.delete(key);
    prefetched.set(key, { at: Date.now(), suggestion: parseMobileRebalanceSuggestion(raw) });
    if (prefetched.size > MAX_PREFETCHED) prefetched.delete(prefetched.keys().next().value!);
  } finally {
    inFlight.delete(key);
  }
}

/** 开着的任务空闲且连着时预先问好提议：变空闲(上一轮结束、打开任务)时问一次，之后每 5 分钟再问。 */
export function useMobileSessionRebalancePrefetch(input: {
  invoke: Invoke;
  hostDeviceId: string;
  sessionId: string;
  idle: boolean;
}): void {
  const { invoke, hostDeviceId, sessionId, idle } = input;
  useEffect(() => {
    if (!hostDeviceId || !sessionId || !idle) return;
    void prefetchMobileSessionRebalance(invoke, hostDeviceId, sessionId);
    const timer = setInterval(
      () => void prefetchMobileSessionRebalance(invoke, hostDeviceId, sessionId),
      SESSION_REBALANCE_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [invoke, hostDeviceId, sessionId, idle]);
}

/** 取走问好的提议：一次提议只用于一条消息，过期的不用。 */
function takePrefetched(hostDeviceId: string, sessionId: string): MobileRebalanceSuggestion | null {
  const key = cacheKey(hostDeviceId, sessionId);
  const entry = prefetched.get(key);
  prefetched.delete(key);
  return entry && Date.now() - entry.at <= SESSION_REBALANCE_CACHE_MS ? entry.suggestion : null;
}

/**
 * 发送前调用：有问好的提议就按用户的选择记到任务所在电脑(它在这条消息发出前换过去)；没有提议时立即返回，不等网络。
 * 不拦发送——调用方之后照常发出这条消息。
 */
export async function offerMobileSessionRebalance(input: {
  invoke: Invoke;
  hostDeviceId: string;
  sessionId: string;
  clientId: string;
  ask(suggestion: MobileRebalanceSuggestion): Promise<MobileRebalanceChoice>;
}): Promise<void> {
  const { invoke, hostDeviceId, sessionId } = input;
  const suggestion = takePrefetched(hostDeviceId, sessionId);
  if (!suggestion) return;
  const choice = suggestion.kind === 'auto' ? 'switch' : await input.ask(suggestion);
  if (choice === 'cancel') return;
  try {
    await invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{
      action: 'rebalance-decision',
      sessionId,
      clientId: input.clientId,
      memberKey: suggestion.memberKey,
      remember: choice === 'remember',
    }]);
  } catch {
    // 没记上就是这条照常发到原来的账号，下一条再问。
  }
}
