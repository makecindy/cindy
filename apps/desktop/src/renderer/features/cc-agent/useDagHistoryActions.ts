import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DagHistoryActions, DagHistoryKind, DagNode } from './session-dag/types';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import { prepareDagRecall } from './DagRecallDraft';
import { toast } from '@/lib/toast';
import { previewDagOperation } from './session-dag/dagOperationPreview';
import type { DagCanvasState } from './session-dag/types';

type View = {
  key?: string;
  ready: boolean;
  nodes: readonly DagNode[];
  state?: () => DagCanvasState | undefined;
  writable: (n: DagNode) => Session | undefined;
  refresh: (sid: string, removed: string[], recall: boolean) => void;
};
type Anchor = { id: string; client: string; kind: DagHistoryKind; token: string; scope: string };
type Undo = { undoId: string; label: string };
const stamp = () => {
  const { dataOwnerId, generation } = getDataOwnerGeneration();
  return { dataOwnerId, ownerGeneration: generation };
};

export function useDagHistoryActions(view: View): DagHistoryActions | undefined {
  const api = window.electronAPI?.maker?.dagHistory;
  const live = useRef<View | undefined>(undefined);
  useLayoutEffect(() => {
    live.current = view;
    return () => {
      live.current = undefined;
    };
  });
  const key = view.key && `${view.key}_history`;
  const [undo, setUndo] = useState<Undo>();
  const pending = useRef<Anchor | undefined>(undefined);
  const locked = useRef(false);
  useEffect(() => {
    let dead = false;
    pending.current = undefined;
    setUndo(undefined);
    if (api && key)
      void (async () => {
        const owner = stamp();
        const raw = await window.electronAPI.safeStorageRead(key);
        if (!raw || dead) return;
        const parsed = JSON.parse(raw);
        for (const saved of Array.isArray(parsed) ? parsed.slice(0, 2) : [parsed]) {
          if (dead || !saved || typeof saved.undoId !== 'string' || typeof saved.label !== 'string')
            continue;
          const result = await api.status(saved.undoId, owner);
          if (!dead && result?.status === 'committed' && saved.undoId === result.operationId) {
            setUndo(saved);
            break;
          }
        }
      })().catch(() => {
        if (!dead) toast.error('无法读取上一次历史操作的回执。');
      });
    return () => {
      dead = true;
    };
  }, [api, key]);
  if (!api || !key) return undefined;
  function target(node: DagNode) {
    const v = live.current;
    if (
      !v?.ready ||
      v.key !== view.key ||
      !node.userMessageId ||
      !v.nodes.some(
        (n) =>
          n.id === node.id &&
          n.sessionId === node.sessionId &&
          n.userMessageId === node.userMessageId,
      )
    )
      throw Error('历史已变化，请重新选择原问题。');
    const s = v.writable(node);
    if (!s || s.remoteHostId || s.deviceLinkDeviceId)
      throw Error('只能在任务所在电脑的可写会话中修改历史。');
    return s;
  }
  function scopeFor(node: DagNode) {
    const v = live.current;
    const scope = previewDagOperation({
      operation: 'delete-subtree',
      selectedId: node.id,
      nodes: v?.nodes ?? [],
      historyReady: !!v?.ready,
      canvasState: v?.state?.(),
    });
    if (scope.status !== 'preview-only' || scope.attachedPendingBranches)
      throw Error('分支有待确认的提问或继承关系不完整，未删除。');
    return scope;
  }
  function recall(s: Session, node: DagNode) {
    const msg = makerChatStore
      .getSnapshot(s.id)
      .messages.find((m) => m.clientId === node.userMessageId);
    const prepared = prepareDagRecall(s, msg);
    if (!prepared.ok) throw Error(prepared.reason);
    return prepared;
  }
  return {
    latestUndo: undo,
    async preview(node, kind) {
      const s = target(node);
      pending.current = undefined;
      const owner = getDataOwnerGeneration();
      const action = kind === 'recall' ? 'withdraw' : 'delete';
      const p = await api.preview(s.id, node.userMessageId!, action, stamp());
      if (!isDataOwnerGenerationCurrent(owner)) throw Error('账号已切换。');
      target(node);
      if (!p.canCommit) throw Error(p.reason || '此任务不能安全恢复历史，未删除。');
      if (
        !p.operationId ||
        p.clientId !== node.userMessageId ||
        p.sessionId !== s.id ||
        p.action !== action
      )
        throw Error('无法核对原生操作范围。');
      if (kind === 'recall') recall(s, node);
      const scope = scopeFor(node);
      pending.current = {
        id: s.id,
        client: p.clientId,
        kind,
        token: p.operationId,
        scope: JSON.stringify(scope),
      };
      return {
        token: p.operationId,
        details: [
          `原生历史：${p.turnCount} 轮，${p.branchCount} 个分支。`,
          `跨范围引用 ${scope.crossingReferences} 条；不删除仅通过引用相连的卡片。`,
          '不会回滚文件或外部工具操作。',
          ...(kind === 'recall' ? ['原问题将回到输入框，不会自动发送。'] : []),
        ],
      };
    },
    async commit(node, kind, token) {
      const p = pending.current;
      if (
        locked.current ||
        !p ||
        p.token !== token ||
        p.id !== node.sessionId ||
        p.client !== node.userMessageId ||
        p.kind !== kind
      )
        throw Error('预览已失效，请重新预览。');
      pending.current = undefined;
      locked.current = true;
      const owner = getDataOwnerGeneration(),
        intent = stamp();
      try {
        const s = target(node);
        const handle = kind === 'recall' ? recall(s, node) : null;
        const record = { undoId: token, label: kind === 'recall' ? '撤回提问' : '删除分支' };
        if (
          !(await window.electronAPI.safeStorageStore(
            key,
            JSON.stringify(undo ? [record, undo] : [record]),
          ))
        )
          throw Error('无法保存撤销入口，未修改历史。');
        if (!isDataOwnerGenerationCurrent(owner)) throw Error('账号已切换。');
        target(node);
        handle?.assertReady();
        if (JSON.stringify(scopeFor(node)) !== p.scope) throw Error('画布范围已变化，请重新预览。');
        const result = await api.commit(token, intent).catch(async (error) => {
          const status = await api.status(token, intent).catch(() => null);
          if (status?.status === 'committed') return status;
          throw error;
        });
        if (
          result.operationId !== token ||
          result.status !== 'committed' ||
          result.sessionId !== s.id
        )
          throw Error('原生回执无法确认，不会重发操作。');
        if (isDataOwnerGenerationCurrent(owner) && live.current && live.current.key === view.key) {
          setUndo(record);
          const draft = handle?.restore();
          if (draft && !draft.ok)
            toast.error(`已撤回历史，但未覆盖草稿：${draft.reason}。可撤销本次操作。`);
          live.current.refresh(s.id, result.removedSessionIds, !!handle);
        }
        return { undoId: token };
      } finally {
        locked.current = false;
      }
    },
    async undo(token) {
      if (locked.current || !live.current?.key || live.current.key !== view.key)
        throw Error('当前无法撤销历史。');
      locked.current = true;
      const owner = getDataOwnerGeneration(),
        intent = stamp();
      try {
        const result = await api.undo(token, intent).catch(async (error) => {
          const status = await api.status(token, intent).catch(() => null);
          if (status?.status === 'undone') return status;
          throw error;
        });
        if (result.operationId !== token || result.status !== 'undone')
          throw Error('未确认撤销结果，不会重发。');
        if (isDataOwnerGenerationCurrent(owner) && live.current && live.current.key === view.key) {
          setUndo(undefined);
          live.current.refresh(result.sessionId, result.removedSessionIds, false);
        }
      } finally {
        locked.current = false;
      }
    },
  };
}
