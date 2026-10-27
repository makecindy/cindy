/**
 * 任务进行中换号(provider-groups.md §6.2，2026-10-21 用户裁决)：用户自己发下一条消息前，看任务所在电脑是否提议为了
 * 均匀用完各账号的配额换一台。要换就弹窗确认(换过去 / 取消，可勾「以后自动换」，只管这个任务)；这个任务勾过的
 * 不再弹窗、直接换，消息里的分隔条写明原因。
 *
 * 换号的判断和记录都在任务所在电脑：本机任务问本机，被控电脑上的任务经设备互联问那台。为了不让每次发送都多等一次往返，
 * 提议在任务空闲时预先问好(上一轮结束、打开任务时，空闲期间每 5 分钟再问)，发送时只用问好的结果；没问到、问不到、
 * 旧版本不认识这个请求都按不提议处理。无论用户怎么选，这条消息都照常发出。
 */
import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import { formatQuotaResetCountdown } from '@/components/status/usageCardModel';

import {
  parseProviderGroupRebalanceSuggestion,
  type ProviderGroupCommand,
  type ProviderGroupRebalanceSuggestion,
} from '../../../shared/providerGroup';

/** 预先问一次的上限：问不到就当没有提议，不留着挂起的请求。 */
export const SESSION_REBALANCE_QUERY_TIMEOUT_MS = 5_000;
/** 问到的提议多久内可用：与组所在电脑判断配额用的快照有效期一致。 */
export const SESSION_REBALANCE_CACHE_MS = 10 * 60_000;
/** 任务空闲、开着时多久重新问一次。 */
export const SESSION_REBALANCE_REFRESH_MS = 5 * 60_000;
const MAX_PREFETCHED = 200;

type ConfirmWithCheckbox = (options: {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  checkboxLabel: string;
  autoFocusConfirm?: boolean;
}) => Promise<{ ok: boolean; checked: boolean }>;

type RebalanceRequest = Extract<ProviderGroupCommand, { action: 'rebalance-suggestion' | 'rebalance-decision' }>;

const prefetched = new Map<string, { at: number; suggestion: ProviderGroupRebalanceSuggestion }>();
const inFlight = new Set<string>();

function cacheKey(sessionId: string, hostDeviceId: string | undefined): string {
  return `${hostDeviceId ?? ''}\u0000${sessionId}`;
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

async function command(hostDeviceId: string | undefined, request: RebalanceRequest): Promise<unknown> {
  if (hostDeviceId) {
    const deviceLink = window.electronAPI?.deviceLink;
    if (typeof deviceLink?.invoke !== 'function') return null;
    return deviceLink.invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request]);
  }
  const api = window.electronAPI?.providerGroup;
  if (typeof api?.command !== 'function') return null;
  return api.command(request);
}

/** 任务空闲时预先问好提议。同一个任务同时只问一次。@param hostDeviceId 任务所在的被控电脑；本机任务不传。 */
export async function prefetchSessionRebalance(sessionId: string, hostDeviceId?: string): Promise<void> {
  const key = cacheKey(sessionId, hostDeviceId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const raw = await withTimeout(command(hostDeviceId, { action: 'rebalance-suggestion', sessionId }), null);
    prefetched.delete(key);
    prefetched.set(key, { at: Date.now(), suggestion: parseProviderGroupRebalanceSuggestion(raw) });
    if (prefetched.size > MAX_PREFETCHED) prefetched.delete(prefetched.keys().next().value!);
  } finally {
    inFlight.delete(key);
  }
}

/** 开着的任务空闲时预先问好提议：变空闲(上一轮结束、打开任务)时问一次，之后每 5 分钟再问。 */
export function useSessionRebalancePrefetch(sessionId: string | undefined, hostDeviceId: string | undefined, idle: boolean): void {
  useEffect(() => {
    if (!sessionId || !idle) return;
    void prefetchSessionRebalance(sessionId, hostDeviceId);
    const timer = setInterval(() => void prefetchSessionRebalance(sessionId, hostDeviceId), SESSION_REBALANCE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [sessionId, hostDeviceId, idle]);
}

/** 取走问好的提议：一次提议只用于一条消息，过期的不用。 */
function takePrefetched(sessionId: string, hostDeviceId: string | undefined): ProviderGroupRebalanceSuggestion {
  const key = cacheKey(sessionId, hostDeviceId);
  const entry = prefetched.get(key);
  prefetched.delete(key);
  return entry && Date.now() - entry.at <= SESSION_REBALANCE_CACHE_MS ? entry.suggestion : null;
}

async function recordDecision(
  sessionId: string,
  memberKey: string,
  remember: boolean,
  hostDeviceId: string | undefined,
  clientId: string,
): Promise<boolean> {
  try {
    const raw = await command(hostDeviceId, { action: 'rebalance-decision', sessionId, memberKey, remember, clientId });
    return !!raw && typeof raw === 'object' && (raw as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** 弹窗正文：换到哪台、那台的配额还剩多少、多久重置，以及换过去会丢一部分上下文。 */
export function describeSessionRebalance(
  suggestion: NonNullable<ProviderGroupRebalanceSuggestion>,
  t: TFunction,
  nowMs = Date.now(),
): string {
  const left = Math.max(0, Math.round(100 - suggestion.quota.usedPercent));
  const reset = suggestion.quota.resetAtMs === null
    ? null
    : formatQuotaResetCountdown(suggestion.quota.resetAtMs / 1000, nowMs, t);
  const quota = reset
    ? t('providerGroup.rebalance.quotaReset', { left, reset })
    : t('providerGroup.rebalance.quota', { left });
  return t('providerGroup.rebalance.description', { label: suggestion.label, quota });
}

/**
 * 发送前询问；返回的闭包在消息创建后绑定 clientId 记录确认。没有提议时立即返回，不等网络。
 * 不拦发送——调用方之后照常发出这条消息。
 */
export async function offerSessionRebalance(options: {
  sessionId: string;
  hostDeviceId?: string;
  confirmWithCheckbox: ConfirmWithCheckbox;
  t: TFunction;
}): Promise<((clientId: string) => Promise<void>) | undefined> {
  const { sessionId, hostDeviceId, confirmWithCheckbox, t } = options;
  const suggestion = takePrefetched(sessionId, hostDeviceId);
  if (!suggestion) return;
  if (suggestion.kind === 'auto') {
    return async (clientId) => { await recordDecision(sessionId, suggestion.memberKey, false, hostDeviceId, clientId); };
  }
  const { ok, checked } = await confirmWithCheckbox({
    title: t('providerGroup.rebalance.title', { label: suggestion.label }),
    description: describeSessionRebalance(suggestion, t),
    confirmText: t('providerGroup.rebalance.confirm'),
    cancelText: t('providerGroup.rebalance.cancel'),
    checkboxLabel: t('providerGroup.rebalance.remember'),
    autoFocusConfirm: true,
  });
  if (!ok) return;
  return async (clientId) => { await recordDecision(sessionId, suggestion.memberKey, checked, hostDeviceId, clientId); };
}
