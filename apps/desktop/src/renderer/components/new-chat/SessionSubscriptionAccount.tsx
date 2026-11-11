/**
 * 已建立任务实际在用的订阅账号(subscription-account-pools.md「任务的账号」，2026-11-11 用户要求)。
 * 账号池里的任务固定在一个账号上：输入框下方的用量、模型列表里这个供应商(含供应商组那一项)的账号名与
 * 用量都按这个账号显示，不拿默认账号或下一个待分配的账号顶替。账号在执行这个任务的电脑上：本机任务问
 * 本机，远程 Agent、远程控制与供应商组问那台。没有账号池、绑的是默认账号或旧任务时沿用原来的读取；
 * 旧执行端通过已有的原生会话用量查询兼容，不借用默认账号的身份。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { useDocumentVisible } from '@/hooks/useWindowVisible';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import type { RateLimitSnapshot } from '@/hooks/useAccountUsage';
import type { RemoteCodexAccountUsagePayload } from '@/hooks/useRemoteDeviceUsage';

import {
  SUBSCRIPTION_ACCOUNTS_CHANNEL,
  isSubscriptionProvider,
  parseSubscriptionSessionAccountView,
  type SubscriptionAccountUsage,
  type SubscriptionProvider,
  type SubscriptionSessionAccountQuery,
  type SubscriptionSessionAccountView,
} from '../../../shared/subscriptionAccounts';

/** 账号用量在宿主有短缓存，与供应商详情页账号区一样约每分钟重读。 */
const REFRESH_MS = 60_000;

/**
 * 执行任务的电脑版本较旧、不认识账号查询时，用它已有的「按原生会话读所在账号用量」读到的结果：
 * 用量是这个任务的账号，读不到账号名(不拿默认账号的名字凑)。usage 为 null = 那份账号暂无用量或已不可用。
 */
type TaskUsageOnly = {
  providerId: SubscriptionProvider;
  state: 'usage-only';
  usage: SubscriptionAccountUsage | null;
};
export type SessionSubscriptionAccountState =
  | SubscriptionSessionAccountView
  | TaskUsageOnly
  /** 第一次还没读到：不显示默认账号的名字与用量。 */
  | { providerId: SubscriptionProvider; state: 'loading' };
type ReadResult = SessionSubscriptionAccountState;

/** 2026-11-07 起的执行端都认这个附加参数(任务额度重置查询同一个)，返回这个原生会话所在账号的窗口。 */
async function readOlderHostTaskUsage(
  deviceId: string,
  providerId: SubscriptionProvider,
  nativeSessionId: string,
): Promise<TaskUsageOnly | null> {
  const scope = { subscriptionSessionId: nativeSessionId };
  const raw =
    providerId === 'anthropic'
      ? await window.electronAPI.deviceLink.invoke(deviceId, 'maker:usage:claude-subscription', [
          providerId,
          false,
          scope,
        ])
      : await window.electronAPI.deviceLink.invoke(deviceId, 'maker:usage:account', [
          'codex',
          providerId,
          scope,
        ]);
  if (raw === null) return { providerId, state: 'usage-only', usage: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.providerId !== undefined && value.providerId !== providerId) return null;
  if (providerId === 'anthropic')
    return {
      providerId,
      state: 'usage-only',
      usage: { claude: value as NonNullable<SubscriptionAccountUsage['claude']> },
    };
  const table =
    value.appServerBuckets && typeof value.appServerBuckets === 'object'
      ? (value.appServerBuckets as Record<string, unknown>)
      : value.primary || value.secondary
        ? { codex: value }
        : {};
  const credits = value.credits as NonNullable<SubscriptionAccountUsage['codex']>['credits'];
  return {
    providerId,
    state: 'usage-only',
    usage: {
      codex: {
        buckets: table as NonNullable<SubscriptionAccountUsage['codex']>['buckets'],
        credits: credits && typeof credits === 'object' ? credits : null,
      },
    },
  };
}

interface ContextValue {
  providerId: SubscriptionProvider;
  /** 执行任务的电脑；null = 本机。 */
  deviceId: string | null;
  account: SessionSubscriptionAccountState;
}

const Context = createContext<ContextValue | null>(null);

/**
 * 这一轮会不会经账号池选账号：与执行端 subscription-accounts/agent.ts 的 providerFor 同口径——
 * Claude Code 显式选 Anthropic，或三种引擎显式选 OpenAI；SSH 远程与默认路由不进账号池。
 */
export function sessionSubscriptionPoolProvider(
  agent: 'cc' | 'codex' | 'pi',
  providerId: string | null | undefined,
  remoteHostId?: string | null,
): SubscriptionProvider | null {
  if (remoteHostId) return null;
  if (providerId === 'anthropic') return agent === 'cc' ? providerId : null;
  return providerId === 'openai' ? providerId : null;
}

// 切回同一个任务时先显示上次读到的账号，再在后台刷新。
const lastKnown = new Map<string, { owner: DataOwnerGeneration; view: ReadResult }>();

export function SessionSubscriptionAccountProvider({
  providerId,
  deviceId,
  sessionId,
  nativeSessionId,
  refreshKey,
  children,
}: {
  /** 任务这一轮用的供应商；只有 anthropic / openai 有账号池。 */
  providerId: string | null | undefined;
  /** 执行任务的另一台电脑；null = 本机(不传本机自己的 id)。 */
  deviceId: string | null;
  sessionId: string | null | undefined;
  nativeSessionId: string | null | undefined;
  /** 变化时重读(例如一轮开始与结束)。 */
  refreshKey?: unknown;
  children: ReactNode;
}) {
  const pool =
    isSubscriptionProvider(providerId) && (sessionId || nativeSessionId) ? providerId : null;
  const remoteDeviceId = deviceId || null;
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const foreground = useDocumentVisible(pool !== null);
  const reconnectEpoch = useDeviceLinkReconnectEpoch(
    pool && remoteDeviceId ? remoteDeviceId : undefined,
  );
  const key = pool
    ? [remoteDeviceId ?? '', pool, sessionId ?? '', nativeSessionId ?? ''].join('\n')
    : '';
  const [loaded, setLoaded] = useState<{
    key: string;
    owner: DataOwnerGeneration;
    view: ReadResult;
  } | null>(null);

  useEffect(() => {
    if (!pool) return;
    let disposed = false;
    let latest = 0;
    const owner = getDataOwnerGeneration();
    const query: SubscriptionSessionAccountQuery = {
      action: 'session',
      providerId: pool,
      ...(sessionId ? { sessionId } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
    };
    const remember = (view: ReadResult) => {
      lastKnown.set(key, { owner, view });
      setLoaded({ key, owner, view });
    };
    const refresh = async () => {
      const request = ++latest;
      let view: ReadResult | null = null;
      try {
        const raw = remoteDeviceId
          ? await window.electronAPI.deviceLink.invoke(
              remoteDeviceId,
              SUBSCRIPTION_ACCOUNTS_CHANNEL,
              [query],
            )
          : await window.electronAPI.subscriptionAccounts?.sessionAccount?.(query);
        view = parseSubscriptionSessionAccountView(raw, pool);
      } catch {
        // 旧执行端或临时读取失败，先尝试已有的原生会话查询。
      }
      // 旧版本仍能按原生会话读出这个任务所在账号的用量；原来的读取只读那台的默认账号，不能沿用。
      if (!view && remoteDeviceId && nativeSessionId)
        view = await readOlderHostTaskUsage(remoteDeviceId, pool, nativeSessionId).catch(() => null);
      if (!view) {
        // 读取失败不能证明任务用的是默认账号；保留已知结果，否则保持未知并继续重试。
        const previous = lastKnown.get(key);
        view =
          previous && isDataOwnerGenerationCurrent(previous.owner)
            ? previous.view
            : { providerId: pool, state: 'loading' };
      }
      if (disposed || request !== latest || !isDataOwnerGenerationCurrent(owner)) return;
      remember(view);
    };
    void refresh();
    // 没有账号池的任务不轮询；账号池变化时本机有推送，远端靠下一轮或回到窗口时重读。
    const timer = foreground
      ? window.setInterval(() => {
          if (lastKnown.get(key)?.view.state !== 'legacy') void refresh();
        }, REFRESH_MS)
      : undefined;
    const offChanged = remoteDeviceId
      ? undefined
      : window.electronAPI.subscriptionAccounts?.onChanged?.((event) => {
          if (event.providerId === pool) void refresh();
        });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      offChanged?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [pool, key, remoteDeviceId, sessionId, nativeSessionId, foreground, refreshKey, reconnectEpoch, ownerGeneration]);

  const loading = useMemo<SessionSubscriptionAccountState | null>(
    () => (pool ? { providerId: pool, state: 'loading' } : null),
    [pool],
  );
  const cached = key ? lastKnown.get(key) : undefined;
  const account: SessionSubscriptionAccountState | null = !pool
    ? null
    : loaded?.key === key && isDataOwnerGenerationCurrent(loaded.owner)
      ? loaded.view
      : cached && isDataOwnerGenerationCurrent(cached.owner)
        ? cached.view
        : loading;
  const value = useMemo<ContextValue | null>(
    () => (pool && account ? { providerId: pool, deviceId: remoteDeviceId, account } : null),
    [pool, remoteDeviceId, account],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * 这个供应商、这台电脑是不是当前任务实际在用的那份账号；不是返回 null(按原来的读取显示)。
 * remoteDeviceId 为 null 表示本机；调用方先把本机自己的 id 换成 null。
 */
export function useSessionSubscriptionAccount(
  providerId: string | null | undefined,
  remoteDeviceId: string | null,
): SessionSubscriptionAccountState | null {
  const value = useContext(Context);
  if (!value || !providerId || value.providerId !== providerId) return null;
  return (remoteDeviceId || null) === value.deviceId ? value.account : null;
}

export interface SessionAccountDisplay {
  /** 跟在供应商后面的账号名；null = 还不知道，不借用默认账号的名字。 */
  identity: string | null;
  plan?: string;
  /** false：原来的读取读的就是这个账号(默认账号)，用量照旧。 */
  replacesUsage: boolean;
  /** replacesUsage 时这个账号自己的用量；null = 暂无。 */
  usage: SubscriptionAccountUsage | null;
}

/**
 * 用量读谁：null = 原来的读取就是这个账号(没有账号池、默认账号、旧任务)；否则只用这个账号自己的
 * 用量，还没读到或账号不可用时为 null，不借用默认账号。
 */
export function sessionAccountUsage(
  account: SessionSubscriptionAccountState | null,
): { usage: SubscriptionAccountUsage | null } | null {
  if (!account || account.state === 'legacy') return null;
  if (account.state === 'usage-only') return { usage: account.usage };
  if (account.state !== 'bound') return { usage: null };
  return account.account.isDefault ? null : { usage: account.account.usage ?? null };
}

/** null = 按原来的读取显示。 */
export function sessionAccountDisplay(
  account: SessionSubscriptionAccountState | null,
  t: TFunction,
): SessionAccountDisplay | null {
  if (!account || account.state === 'legacy') return null;
  const own = sessionAccountUsage(account);
  const replaces = { replacesUsage: own !== null, usage: own?.usage ?? null };
  if (account.state === 'loading' || account.state === 'usage-only')
    return { identity: null, ...replaces };
  if (account.state === 'unassigned')
    return { identity: t('subscriptionAccounts.unassigned'), ...replaces };
  if (account.state === 'unavailable')
    return { identity: t('subscriptionAccounts.boundUnavailable'), ...replaces };
  const { identity, number, plan } = account.account;
  return {
    identity: identity ?? t('providerGroup.member.accountFallback', { index: number }),
    ...(plan ? { plan } : {}),
    ...replaces,
  };
}

/**
 * 账号池里一个账号的 Codex 桶表，整理成远程用量的组合形状，交给原有的选桶逻辑
 * (selectRemoteCodexAccountUsage / remoteCodexQuotaView)。
 */
export function sessionAccountCodexPayload(
  usage: SubscriptionAccountUsage | null,
): RemoteCodexAccountUsagePayload | null {
  const codex = usage?.codex;
  const buckets = codex?.buckets as Record<string, RateLimitSnapshot> | undefined;
  if (!codex || !buckets || Object.keys(buckets).length === 0) return null;
  const general = buckets.codex ?? buckets.__default__ ?? null;
  const credits = codex.credits ? { credits: codex.credits } : {};
  return {
    ...general,
    ...credits,
    source: 'codex-app-server',
    appServerBuckets: buckets,
    // 账号池仅有原生桶，不伪造 WHAM；桥接模型同样按实际模型选择原生桶。
    webSnapshot: null,
  };
}
