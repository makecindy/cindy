/**
 * useInheritedLocalSubscriptions —— 判定「Cindy 正在用这台电脑上已登录的订阅账号」，
 * 并把它做成一条一次性告知。
 *
 * 补的缺口:本机装过并登录过 codex / claude CLI 时,Cindy 会把那份凭证认领到当前账号
 * (设计内的自动继承,见 main 侧 claimDetectedNativeProviderAuth)。自动发现符合产品原则
 * (core-product-principles §2),但整个过程静默 —— 新机器上用户既不知道 Cindy 用的是他机器上
 * 的哪个账号,也不知道去哪儿换掉。这正是 §4.1「用户操作的对象、影响范围…应清楚可见」缺的那半。
 *
 * 与 useProviderOnboarding 的关系是**互斥**而非重叠:那个的判定前提是「零已连接来源」,
 * 而自动继承成功后该供应商 `connected === true`,引导卡压根不出现 —— 于是这条路径上的用户
 * 什么提示都收不到。两个 hook 各管一半,判定不重叠。
 *
 * 判定用三个条件,缺一不可:
 *   1. `scanLocalCli()` 报告该 CLI 本机已安装且已登录;
 *   2. 该条检测的 `sharedWithCindy` —— Cindy 用的**确实是这一份**凭证;
 *   3. 同名 provider 在 Cindy 里已连接。
 *
 * 第 2 条是硬要求,不能省。只看 1+3 会误报:codex 有独立的 codex-home,「本机登录着账号 A、
 * 用户又在 Cindy 里显式登录了账号 B」时两条都成立,而 reconcile 检测到账号不同、刻意让两份
 * 凭证各管各 —— 此时告诉用户「已沿用本机订阅」是错的,他会以为在花 A 的额度
 * (PR #1076 review)。判据按 CLI 分派在 main 侧(claude 与本机共用同一处凭证存储,codex 比对
 * 硬链 inode),renderer 只消费结论。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import { useProviders } from '@/hooks/useProviders';
import type { LocalCliDetection } from '../../shared/localCliDetect';
import {
  acknowledgeInheritedSubscriptions,
  getAcknowledgedInheritedSubscriptions,
  isInheritedSubscriptionAcknowledged,
  subscribeInheritedSubscriptionNotice,
} from '@/state/inheritedSubscriptionNotice';

export interface InheritedSubscriptionRow {
  provider: ProviderView;
  detection: LocalCliDetection;
}

export interface UseInheritedLocalSubscriptionsReturn {
  /** 是否该展示告知(有未读的继承项)。 */
  visible: boolean;
  /** 命中的供应商(按目录序;通常 1 条,同时继承 claude + codex 时 2 条)。 */
  rows: InheritedSubscriptionRow[];
  /** 标记已读(一次性,不再出现)。 */
  acknowledge: () => void;
}

/**
 * @param enabled 调用方 gate(device-link 草稿等场景传 false:连接态在被控端,
 *   本机的检测结果与它无关,提示会指错对象)。
 */
export function useInheritedLocalSubscriptions(
  enabled = true,
): UseInheritedLocalSubscriptionsReturn {
  const { providers, loading } = useProviders();

  const acknowledgedSnapshot = useSyncExternalStore(
    subscribeInheritedSubscriptionNotice,
    getAcknowledgedInheritedSubscriptions,
  );

  // 检测懒加载:只在启用且供应商清单已就绪时扫一次(本地文件 / Keychain 存在性探测,
  // 毫秒级)。失败静默空数组 —— 这条提示是增强,不能因为扫不到就挡住首屏。
  const wantDetections = enabled && !loading;
  const [detections, setDetections] = useState<LocalCliDetection[] | null>(null);
  useEffect(() => {
    if (!wantDetections || detections != null) return;
    let cancelled = false;
    void window.electronAPI.maker
      .scanLocalCli()
      .then((r) => {
        if (!cancelled) setDetections(r.detections);
      })
      .catch(() => {
        if (!cancelled) setDetections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantDetections, detections]);

  const rows = useMemo<InheritedSubscriptionRow[]>(() => {
    if (!enabled || loading || !detections) return [];
    return detections
      // sharedWithCindy 是「确实继承了」的实证(见顶注第 2 条);只有 installed+loggedIn
      // 的那些不算 —— 它们可能是各自登录的不同账号。
      .filter((d) => d.installed && d.loggedIn && d.sharedWithCindy)
      .map((detection) => ({
        detection,
        provider: providers.find((p) => p.id === detection.providerId),
      }))
      .filter(
        (row): row is InheritedSubscriptionRow =>
          // 已连接才是「继承生效了」;未连接的那些归 useProviderOnboarding 的 detectedRows
          // 去引导授权,两处判定在 connected 上正好互补。
          !!row.provider &&
          row.provider.connected &&
          !isInheritedSubscriptionAcknowledged(acknowledgedSnapshot, row.provider.id),
      );
  }, [enabled, loading, detections, providers, acknowledgedSnapshot]);

  const acknowledge = useMemo(() => {
    const ids = rows.map((r) => r.provider.id);
    return () => acknowledgeInheritedSubscriptions(ids);
  }, [rows]);

  return { visible: rows.length > 0, rows, acknowledge };
}
