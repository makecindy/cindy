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
 * 判定刻意只用两份已有数据推导,不新增 main 侧状态:
 *   1. `scanLocalCli()` 报告该 CLI 本机已安装且已登录;
 *   2. 同名 provider 在 Cindy 里已连接。
 * 两者同时成立时,Cindy 用的就是本机那份凭证(用户也可能自己在 Cindy 里登录了同一账号 ——
 * 那时这句告知依然是事实,只是他已经知道了。代价是他会多看一次、点掉即止,这比让继承路径
 * 的用户完全无感知要好)。
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
      .filter((d) => d.installed && d.loggedIn)
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
