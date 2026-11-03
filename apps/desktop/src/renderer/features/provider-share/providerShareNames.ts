/**
 * 分享来的供应商与电脑给人看的名字(provider-sharing.md §5.1、§6)：只用分享者的昵称，**不用分享者的
 * 电脑名**。服务端仍存着旧链接里的电脑名、旧版本加入供应商组时的快照也可能是电脑名，界面一律不读它们。
 */
import type { TFunction } from 'i18next';
import { useCallback } from 'react';

import { providerShareAgentDeviceId } from './providerShareFormat';
import { useProviderShareReceived } from './providerShareStore';

interface ShareNameSource {
  shareId: string;
  providerLabel: string;
  owner: { displayName: string };
}

/**
 * 模型列表等处一条分享的名字：「来自 Magi 的分享」。同一位分享者的同一个供应商分享了不止一份
 * (例如从两台电脑各分享了一次)时，按列表顺序给后面的加序号，免得两项一模一样。
 */
export function providerShareDisplayNames(
  shares: readonly ShareNameSource[],
  t: TFunction,
): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const share of shares) {
    const base = t('providerShare.received.fromOwner', { name: share.owner.displayName });
    const key = `${share.owner.displayName}\n${share.providerLabel}`;
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    names.set(share.shareId, index > 1 ? t('providerShare.picker.numbered', { name: base, index }) : base);
  }
  return names;
}

/**
 * `share:<id>` → 分享者昵称(本账号收到的分享；分享属于账号，同账号各台电脑收到的一样)。
 * 不是分享或还没读到时返回 null。
 */
export function useProviderShareOwnerNameOf(): (agentDeviceId: string | null | undefined) => string | null {
  const { received } = useProviderShareReceived();
  return useCallback(
    (agentDeviceId: string | null | undefined) => {
      if (!agentDeviceId) return null;
      return received.find((share) => providerShareAgentDeviceId(share.shareId) === agentDeviceId)?.owner.displayName
        ?? null;
    },
    [received],
  );
}

/** 供应商组里一台分享来的电脑：「Magi 的电脑」；读不到分享者时写「分享来的电脑」。 */
export function providerShareComputerName(t: TFunction, ownerName: string | null | undefined): string {
  const name = ownerName?.trim();
  return name
    ? t('providerGroup.member.shareComputer', { name })
    : t('providerGroup.member.shareComputerUnknown');
}
