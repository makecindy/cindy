import { useEffect, useRef } from 'react';
import type { MessageHistoryRead } from './sessionEmptyState';

/** 新活动后重新读取历史，避免旧窗口提前放行已读回执或确认空态。 */
export function useSessionActivityInvalidation({
  liveActivitySig,
  liveAttention,
  sessionSubscriptionIdentity,
  readAckGateGenRef,
  setReadAckSyncedKey,
  setSessionMetadataSyncedKey,
  setMessageHistoryRead,
  load,
}: {
  liveActivitySig: string;
  liveAttention: boolean;
  sessionSubscriptionIdentity: string;
  readAckGateGenRef: { current: number };
  setReadAckSyncedKey: (key: string | null) => void;
  setSessionMetadataSyncedKey: (key: string | null) => void;
  setMessageHistoryRead: (read: MessageHistoryRead | null) => void;
  load: () => Promise<void>;
}) {
  const prevLiveActivitySigRef = useRef<string | null>(null);
  useEffect(() => {
    const prevSig = prevLiveActivitySigRef.current ?? liveActivitySig;
    if (liveAttention && liveActivitySig !== prevSig) {
      setReadAckSyncedKey(null);
      setSessionMetadataSyncedKey(null);
      setMessageHistoryRead({ key: sessionSubscriptionIdentity, synced: false });
      // 变化前启动的读取不能重新确认历史；先推进代次，再启动新读取。
      readAckGateGenRef.current += 1;
      void load();
    }
    prevLiveActivitySigRef.current = liveActivitySig;
  }, [liveActivitySig, liveAttention, sessionSubscriptionIdentity, readAckGateGenRef,
    setReadAckSyncedKey, setSessionMetadataSyncedKey, setMessageHistoryRead, load]);
}
