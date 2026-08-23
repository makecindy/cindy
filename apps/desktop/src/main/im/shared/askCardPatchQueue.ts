/**
 * main/im/shared/askCardPatchQueue.ts
 * ---------------------------------------------------------------------------
 * 按 requestId 串行化打勾卡的 updateInteractiveCard。toggle / 提交收口 /
 * turn 作废(dropInteractionCard) 都走这里, 避免 in-flight 勾选 patch 覆盖终态。
 */

const askPatchChain = new Map<string, Promise<void>>();

export function enqueueAskCardPatch(
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = askPatchChain.get(requestId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  askPatchChain.set(requestId, next);
  next.finally(() => {
    if (askPatchChain.get(requestId) === next) askPatchChain.delete(requestId);
  });
  return next;
}
