import { useState } from 'react';
import type { MessageHistoryRead } from './sessionEmptyState';

/** 历史读取结果按任务访问隔离，连接代变化保留当前访问的失效状态。 */
export function useSessionMessageHistoryRead({
  deviceId,
  sessionId,
  notificationResponse,
  subscriptionIdentity,
}: {
  deviceId: string;
  sessionId: string;
  notificationResponse: string | null;
  subscriptionIdentity: string;
}) {
  const visitKey = JSON.stringify([deviceId, sessionId, notificationResponse]);
  // 通知意味着远端可能已有新消息，旧缓存不能确认本次访问为空。
  const initialHistoryRead: MessageHistoryRead | null = notificationResponse === null
    ? null : { key: subscriptionIdentity, synced: false };
  const [previousVisitKey, setPreviousVisitKey] = useState(visitKey);
  const [historyRead, setHistoryRead] = useState(initialHistoryRead);
  if (previousVisitKey !== visitKey) {
    setPreviousVisitKey(visitKey);
    setHistoryRead(initialHistoryRead);
  }
  return [historyRead, setHistoryRead] as const;
}
