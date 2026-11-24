/**
 * 一个分享出去的供应商在手机上的管理页数据：待处理申请、已分享的人、组内电脑状态与额度、分享链接。
 *
 * 读取节奏(只在页面聚焦且应用在前台时；docs/dev-rules/engineering-conventions.md §8.7 的预算)：
 *  - 申请与名单(`owned`，不含用量)和组状态(`view`)每 15 秒一次；
 *  - 手机刚生成链接后的 7 分钟里，申请改为每 5 秒读一次：这段时间供应商所在电脑不弹审批窗，
 *    申请要靠这一页显示(provider-sharing.md §4.1 第 4 步)；组状态仍是 15 秒；
 *  - 额度每 60 秒一次，同时最多读 3 台(那台电脑自带 30 秒缓存并合并在途读取)。
 * 上一轮没回来不发下一轮；离开页面、切到后台、换账号后停止，迟到结果丢弃。
 * 写请求(生成链接、同意、拒绝)只发一次，不重放；结果不明时重新读取现状。同一时间只进行一个写请求。
 * 链接只能用一次：读到它带来的申请后，链接回到「未生成」，申请留在待处理里。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';

import {
  classifyShareManagementError,
  createShareLink,
  decideShareRequest,
  readOwnedShares,
  readShareGroupView,
  readShareQuota,
  type ShareGroupView,
  type ShareManagementErrorCode,
  type ShareManagementLink,
  type ShareManagementRequest,
  type ShareManagementShare,
  type ShareQuotaAccount,
} from './providerShareManagement';
import { SHARE_LINK_WATCH_MS } from './providerShareManagementPresentation';

const STATUS_POLL_MS = 15_000;
const REQUEST_POLL_MS = 5_000;
const QUOTA_REFRESH_MS = 60_000;
const QUOTA_CONCURRENCY = 3;
/** 没建组的供应商只有所在电脑这一台，额度记在这个键下。 */
export const SHARE_HOST_QUOTA_KEY = 'host';

export type ShareQuotaReading =
  | { status: 'loading' }
  | { status: 'ready'; accounts: ShareQuotaAccount[] }
  | { status: 'error'; code: ShareManagementErrorCode };

export type ShareLinkState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'ready'; link: ShareManagementLink }
  | { status: 'error'; code: ShareManagementErrorCode };

export type ShareDecisionNotice =
  | { kind: 'approved' | 'rejected'; name: string }
  /** 申请已在别处处理、撤回或过期。 */
  | { kind: 'gone' }
  /** 那台电脑没回应：申请可能已经处理，以重新读到的名单为准。 */
  | { kind: 'uncertain' }
  | { kind: 'needs-update' }
  | { kind: 'failed' };

export interface ProviderShareDetail {
  /** 这个供应商的分享；null = 那台电脑上还没有它的分享记录。 */
  share: ShareManagementShare | null;
  /** 申请与名单至少读到过一次。 */
  sharesLoaded: boolean;
  sharesError: ShareManagementErrorCode | null;
  group: ShareGroupView | null;
  groupError: ShareManagementErrorCode | null;
  quotas: Readonly<Record<string, ShareQuotaReading>>;
  link: ShareLinkState;
  /** 生成链接后的关注窗口还没过。 */
  watching: boolean;
  deciding: { requestId: string; decision: 'approve' | 'reject' } | null;
  notice: ShareDecisionNotice | null;
  /** 倒计时用的当前时刻；只在有链接时每秒更新。 */
  now: number;
  createLink(): void;
  decide(request: ShareManagementRequest, decision: 'approve' | 'reject'): void;
  refresh(): Promise<void>;
}

export function useProviderShareDetail(input: {
  active: boolean;
  deviceId: string;
  providerId: string;
}): ProviderShareDetail {
  const { deviceId, providerId } = input;
  const { invoke } = useDeviceLink();
  const [share, setShare] = useState<ShareManagementShare | null>(null);
  const [sharesLoaded, setSharesLoaded] = useState(false);
  const [sharesError, setSharesError] = useState<ShareManagementErrorCode | null>(null);
  const [group, setGroup] = useState<ShareGroupView | null>(null);
  const [groupError, setGroupError] = useState<ShareManagementErrorCode | null>(null);
  const [quotas, setQuotas] = useState<Record<string, ShareQuotaReading>>({});
  const [link, setLink] = useState<ShareLinkState>({ status: 'idle' });
  const [watchUntil, setWatchUntil] = useState(0);
  const [deciding, setDeciding] = useState<ProviderShareDetail['deciding']>(null);
  const [notice, setNotice] = useState<ShareDecisionNotice | null>(null);
  const [now, setNow] = useState(Date.now);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const active = input.active && foreground;

  // 一次挂载对应一个(电脑, 供应商)；页面按这两个值 key，换目标即重新挂载。
  const scope = useRef({ epoch: 0, owner: getMobileAuthOwner() });
  const watchUntilRef = useRef(0);
  // 这一页当前显示的链接；读到它带来的申请后清掉(链接只能用一次)。
  const linkIdRef = useRef<string | null>(null);
  const groupRef = useRef<ShareGroupView | null>(null);
  const busy = useRef({ shares: false, group: false, quota: false, write: false });
  const lastAt = useRef({ group: 0, quota: 0 });
  const kick = useRef<() => void>(() => undefined);
  // 本机已处理的申请：处理前发出的那次读取可能还带着它，回来时不再显示。
  const settled = useRef(new Set<string>());

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);

  const fence = useCallback(() => {
    const { epoch, owner } = scope.current;
    return () => epoch === scope.current.epoch && isMobileAuthOwnerCurrent(owner);
  }, []);

  const loadShares = useCallback(async () => {
    if (busy.current.shares) return;
    busy.current.shares = true;
    const current = fence();
    try {
      const shares = await readOwnedShares(invoke, deviceId);
      if (!current()) return;
      const found = shares.find((entry) => entry.providerId === providerId) ?? null;
      // 链接只能用一次(provider-sharing.md §4.1 第 3 步)：读到它带来的申请就是已经用掉，不再当作还能发给别人的
      // 链接显示；申请本身在「待处理」里，关注窗口内的 5 秒读取照旧。
      const shownLinkId = linkIdRef.current;
      if (shownLinkId && found?.requests.some((request) => request.linkId === shownLinkId)) {
        linkIdRef.current = null;
        setLink({ status: 'idle' });
      }
      setShare(found && { ...found, requests: found.requests.filter((request) => !settled.current.has(request.requestId)) });
      setSharesLoaded(true);
      setSharesError(null);
    } catch (error) {
      // 保留上一次读到的内容：读取失败不等于申请或成员不在了。
      if (current()) setSharesError(classifyShareManagementError(error));
    } finally {
      busy.current.shares = false;
    }
  }, [deviceId, fence, invoke, providerId]);

  const loadQuotas = useCallback(async (view: ShareGroupView) => {
    if (busy.current.quota) return;
    busy.current.quota = true;
    const current = fence();
    const targets = view.grouped
      ? view.members.flatMap((member) => member.quotaTarget ? [{ key: member.key, target: member.quotaTarget }] : [])
      : [{ key: SHARE_HOST_QUOTA_KEY, target: { deviceId, providerId } }];
    const keys = new Set(targets.map((entry) => entry.key));
    // 第一次读到之前写「正在读取」；已有读数的保留到新读数回来，移出组的电脑去掉。
    setQuotas((previous) => Object.fromEntries(targets.map(({ key }) => [key, previous[key] ?? { status: 'loading' as const }])));
    const queue = [...targets];
    try {
      await Promise.all(Array.from({ length: Math.min(QUOTA_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (!current()) return;
          const { key, target } = next;
          let reading: ShareQuotaReading;
          try {
            reading = { status: 'ready', accounts: await readShareQuota(invoke, target.deviceId, target.providerId) };
          } catch (error) {
            reading = { status: 'error', code: classifyShareManagementError(error) };
          }
          if (!current()) return;
          setQuotas((previous) => keys.has(key) && Object.hasOwn(previous, key) ? { ...previous, [key]: reading } : previous);
        }
      }));
    } finally {
      busy.current.quota = false;
    }
  }, [deviceId, fence, invoke, providerId]);

  const loadGroup = useCallback(async () => {
    if (busy.current.group) return;
    busy.current.group = true;
    const current = fence();
    try {
      const view = await readShareGroupView(invoke, deviceId, providerId);
      if (!current()) return;
      groupRef.current = view;
      setGroup(view);
      setGroupError(null);
    } catch (error) {
      if (current()) setGroupError(classifyShareManagementError(error));
    } finally {
      busy.current.group = false;
    }
  }, [deviceId, fence, invoke, providerId]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let ticking = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // 一轮还没结束时又被要求立即读(生成了链接、处理了申请)：记一笔，结束后补读一次，不并发、不叠加定时器。
      if (ticking) {
        again = true;
        return;
      }
      ticking = true;
      clearTimeout(timer);
      try {
        const started = Date.now();
        const groupDue = started - lastAt.current.group >= STATUS_POLL_MS;
        if (groupDue) lastAt.current.group = started;
        await Promise.all([loadShares(), groupDue ? loadGroup() : undefined]);
      } finally {
        ticking = false;
      }
      if (stopped) return;
      if (again) {
        again = false;
        void tick();
        return;
      }
      const view = groupRef.current;
      if (view && Date.now() - lastAt.current.quota >= QUOTA_REFRESH_MS) {
        lastAt.current.quota = Date.now();
        void loadQuotas(view);
      }
      const watching = watchUntilRef.current > Date.now();
      if (!watching) setWatchUntil(0);
      timer = setTimeout(() => { void tick(); }, watching ? REQUEST_POLL_MS : STATUS_POLL_MS);
    };
    kick.current = () => { if (!stopped) void tick(); };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      kick.current = () => undefined;
    };
  }, [active, loadGroup, loadQuotas, loadShares]);

  useEffect(() => () => { scope.current.epoch++; }, []);

  // 倒计时：纯本机的 1 秒计时器，只在页面可见且链接还没过期时走。
  const linkExpiresAt = link.status === 'ready' ? link.link.expiresAtMs : 0;
  useEffect(() => {
    if (!active || linkExpiresAt <= Date.now()) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= linkExpiresAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, linkExpiresAt]);

  const createLink = useCallback(() => {
    if (busy.current.write) return;
    busy.current.write = true;
    const current = fence();
    // 重新生成：上一条链接不再是这一页显示的链接，它迟到的申请不影响新链接的状态。
    linkIdRef.current = null;
    setLink({ status: 'creating' });
    void createShareLink(invoke, deviceId, providerId, () => {
      if (!current()) throw new Error('provider share scope changed');
    }).then((created) => {
      if (!current()) return;
      const until = Date.now() + SHARE_LINK_WATCH_MS;
      watchUntilRef.current = until;
      linkIdRef.current = created.linkId;
      setWatchUntil(until);
      setNow(Date.now());
      setLink({ status: 'ready', link: created });
      kick.current();
    }, (error: unknown) => {
      if (current()) setLink({ status: 'error', code: classifyShareManagementError(error) });
    }).finally(() => {
      busy.current.write = false;
    });
  }, [deviceId, fence, invoke, providerId]);

  const decide = useCallback((request: ShareManagementRequest, decision: 'approve' | 'reject') => {
    if (busy.current.write) return;
    busy.current.write = true;
    const current = fence();
    const drop = () => {
      settled.current.add(request.requestId);
      setShare((value) => value && { ...value, requests: value.requests.filter((entry) => entry.requestId !== request.requestId) });
    };
    setNotice(null);
    setDeciding({ requestId: request.requestId, decision });
    void decideShareRequest(invoke, deviceId, request.requestId, decision, () => {
      if (!current()) throw new Error('provider share scope changed');
    }).then(() => {
      if (!current()) return;
      drop();
      setNotice({ kind: decision === 'approve' ? 'approved' : 'rejected', name: request.displayName });
    }, (error: unknown) => {
      if (!current()) return;
      const code = classifyShareManagementError(error);
      if (code === 'not-found') drop();
      setNotice(code === 'not-found' ? { kind: 'gone' }
        : code === 'offline' ? { kind: 'uncertain' }
        : code === 'needs-update' ? { kind: 'needs-update' }
        : { kind: 'failed' });
    }).finally(() => {
      busy.current.write = false;
      if (!current()) return;
      setDeciding(null);
      // 成功、失败或结果不明都重新读一次现状。
      kick.current();
    });
  }, [deviceId, fence, invoke]);

  const refresh = useCallback(async () => {
    lastAt.current.group = Date.now();
    await Promise.all([loadShares(), loadGroup()]);
    const view = groupRef.current;
    if (view) {
      lastAt.current.quota = Date.now();
      await loadQuotas(view);
    }
  }, [loadGroup, loadQuotas, loadShares]);

  return {
    share,
    sharesLoaded,
    sharesError,
    group,
    groupError,
    quotas,
    link,
    watching: watchUntil > now,
    deciding,
    notice,
    now,
    createLink,
    decide,
    refresh,
  };
}
