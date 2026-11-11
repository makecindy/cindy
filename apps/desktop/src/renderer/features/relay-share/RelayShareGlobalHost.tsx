/**
 * 中转加入申请的窗口宿主(做法同 `ProviderShareGlobalHost`):主窗口在任何页面都逐条弹审批,
 * 副窗口只显示中转页「处理」手动打开的那条。× / Esc = 稍后处理,申请留在中转那一行里。
 *
 * 申请由 main 在分享链接有效期内轮询中转得到,随 CHANGED 推送过来;这里不另起轮询。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SelfHostedRelayState } from '../../../shared/selfHostedRelay';
import { RelayApproveDialog } from './RelayApproveDialog';
import { closeRelayApproval, useRelayApprovalSelection } from './relayApprovalStore';

export function RelayShareGlobalHost({ manualOnly = false }: { manualOnly?: boolean }) {
  const [state, setState] = useState<SelfHostedRelayState | null>(null);
  const selection = useRelayApprovalSelection();
  // 本次运行已排过队的申请:main 每轮都会推送全部待处理申请,不重复弹。
  const queuedRef = useRef(new Set<string>());
  const [queue, setQueue] = useState<readonly string[]>([]);

  useEffect(() => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!api) return;
    let active = true;
    void api
      .command({ type: 'state' })
      .then((result) => {
        if (active) setState(result.state);
      })
      .catch(() => undefined);
    const off = api.onChanged((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const pending = useMemo(() => state?.pendingRequests ?? [], [state]);

  useEffect(() => {
    if (manualOnly) return;
    const fresh = pending.map((item) => item.requestId).filter((id) => !queuedRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) queuedRef.current.add(id);
    setQueue((items) => [...items, ...fresh]);
  }, [pending, manualOnly]);

  const selectedId = selection?.requestId;
  useEffect(() => {
    if (!selectedId) return;
    // 手动打开的也算本次运行弹过:之后的推送不再把它排进自动队列。
    queuedRef.current.add(selectedId);
    setQueue((items) => items.filter((id) => id !== selectedId));
  }, [selectedId]);

  const selected = selectedId ? pending.find((item) => item.requestId === selectedId) ?? null : null;
  // 手动打开的申请已不在(过期、被撤回或已处理):撤掉这次打开。
  useEffect(() => {
    if (selectedId && state && !selected) closeRelayApproval(selectedId);
  }, [selectedId, selected, state]);

  const headId = queue[0] ?? null;
  const queued = headId ? pending.find((item) => item.requestId === headId) ?? null : null;
  useEffect(() => {
    if (headId && !queued) setQueue((items) => items.filter((id) => id !== headId));
  }, [headId, queued]);

  const current = selected ?? queued;

  const close = useCallback(() => {
    if (selectedId) {
      closeRelayApproval(selectedId);
      return;
    }
    setQueue((items) => (items.length > 0 ? items.slice(1) : items));
  }, [selectedId]);

  if (!current || !state?.relay) return null;
  return (
    <RelayApproveDialog
      key={current.requestId}
      request={current}
      relayName={state.relay.name}
      onClose={close}
      returnFocusTo={selection?.trigger}
    />
  );
}
