export type QueueEditLockCallback = (clientId: string, locked: boolean) => void | Promise<void>;

/** 持有一次队列编辑锁的远程调用与完成状态。 */
export interface QueueEditLockOwner {
  callback?: QueueEditLockCallback;
  clientId: string;
  ready: Promise<void>;
}

const releasePromises = new WeakMap<QueueEditLockOwner, Promise<void>>();

/**
 * 先释放上一条消息的锁，再申请当前消息的锁，避免远程请求乱序留下孤儿锁。
 */
export function acquireQueueEditLock(
  owner: QueueEditLockOwner | null,
  clientId: string,
  callback?: QueueEditLockCallback,
): QueueEditLockOwner {
  if (owner?.clientId === clientId) return owner;
  const previousSettled = owner
    ? releaseQueueEditLock(owner).catch(() => undefined)
    : Promise.resolve();
  const ready = previousSettled.then(async () => {
    await callback?.(clientId, true);
  });
  // 锁错误仍由后续 commit / release 读取；先挂观察者避免用户停留在编辑态时出现未处理拒绝。
  void ready.catch(() => undefined);
  return { callback, clientId, ready };
}

/** 申请锁的请求结束后再幂等释放；失败后允许后续调用重试解锁。 */
export function releaseQueueEditLock(owner: QueueEditLockOwner): Promise<void> {
  const current = releasePromises.get(owner);
  if (current) return current;
  const release = (async () => {
    try {
      await owner.ready;
    } catch {
      // 远端可能已落锁但响应丢失，仍需补偿解锁；原加锁错误已由调用方展示。
    }
    await owner.callback?.(owner.clientId, false);
  })();
  releasePromises.set(owner, release);
  void release.catch(() => {
    if (releasePromises.get(owner) === release) releasePromises.delete(owner);
  });
  return release;
}

/** 保存落定后再释放，避免取消或卸载让解锁请求超车更新。 */
export async function releaseQueueEditLockAfter(
  owner: QueueEditLockOwner,
  pending: Promise<unknown> | null,
): Promise<void> {
  if (pending) {
    try {
      await pending;
    } catch {
      // 保存失败仍需释放；原始错误由保存调用方处理。
    }
  }
  await releaseQueueEditLock(owner);
}

/** 保存必须夹在加锁与解锁之间；只有确认更新成功才允许释放锁。 */
export async function commitQueueEdit(
  owner: QueueEditLockOwner,
  update: () => boolean | Promise<boolean>,
): Promise<boolean> {
  await owner.ready;
  const updated = await update();
  if (!updated) return false;
  await releaseQueueEditLock(owner);
  return true;
}
