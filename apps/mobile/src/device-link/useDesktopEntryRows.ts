/**
 * 设置页与桌面组件共用的一行伙伴：与首页伙伴区同样的顺序与展示名，
 * 只保留能绑定到桌面组件所需的信息。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';

import { useHomeRoster } from '@/session/HomeRosterContext';
import { orderedTeammates } from '@/session/teammateNavigation';
import { useStableValue } from '@/utils/useStableValue';
import { deviceDisplayName } from './deviceName';
import type { DesktopEntryAvatar } from './desktopEntryModel';

/** 一位能放上桌面的伙伴：电脑 + 伙伴集合 + 伙伴 + 它的对话。 */
export interface DesktopEntryRow {
  deviceId: string;
  deviceName: string;
  collectionId: string;
  companionId: string;
  sessionId: string;
  title: string;
  online: boolean;
  avatar?: DesktopEntryAvatar | null;
}

export function useDesktopEntryRows(): DesktopEntryRow[] {
  const shared = useHomeRoster();
  const { i18n } = useTranslation();
  const roster = shared?.roster;
  const rows = useMemo(() => {
    if (!roster) return [];
    const rows: DesktopEntryRow[] = [];
    for (const hosted of orderedTeammates(roster.items, '', i18n.language)) {
      const conversation = hosted.item.links.find((link) => link.rel === 'conversation')?.target;
      if (hosted.item.ref.kind !== 'bot' || conversation?.kind !== 'session' || !conversation.sessionId) continue;
      rows.push({
        deviceId: hosted.host.deviceId,
        deviceName: deviceDisplayName(hosted.host.deviceId, hosted.host.deviceName),
        collectionId: hosted.item.ref.collectionId,
        companionId: hosted.item.ref.id,
        sessionId: conversation.sessionId,
        title: resolveRemoteText(hosted.item.display.title, i18n.language),
        online: roster.isOnline(hosted.host),
        avatar: hosted.item.display.avatar ?? null,
      });
    }
    return rows;
  }, [i18n.language, roster]);
  // Roster state objects refresh often; identical rows must not re-run the widget sync.
  return useStableValue(rows, (left, right) => JSON.stringify(left) === JSON.stringify(right));
}
