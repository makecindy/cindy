import { DeviceLinkError, parseFsWatchTopic } from '@cindy/device-link';

/** 打开具体远程会话或文件树监听时必须先建立 streaming link；轻量 sessions 列表订阅不依赖。 */
export function requiresSessionLink(topics: readonly string[]): boolean {
  return topics.some((topic) => (
    (topic.startsWith('session:') && topic.length > 'session:'.length)
    || parseFsWatchTopic(topic) !== null
  ));
}

/**
 * LINK_NOT_OPEN 由 DeviceLinkClient 在真正发帧前抛出；PEER_RESET 只用于已经
 * 明确标记为幂等读的请求。两者都先重开链路再重试一次，已经发出的写请求或其它
 * 错误绝不重试，避免 enqueue / send 等写操作重复执行。
 */
export async function invokeWithClosedLinkRecovery<T>(
  invoke: () => Promise<T>,
  reopen: () => Promise<unknown>,
  beforeRetry?: () => void,
  onRetryGuardFailure?: () => void,
): Promise<T> {
  try {
    return await invoke();
  } catch (err) {
    const retryable = err instanceof DeviceLinkError
      && (
        (err.code === 'LINK_NOT_OPEN' && err.inFlight !== true)
        || (err.code === 'PEER_RESET' && err.inFlight === true)
      );
    if (!retryable) {
      throw err;
    }
  }

  await reopen();
  try {
    beforeRetry?.();
  } catch (err) {
    try {
      onRetryGuardFailure?.();
    } catch {
      // 清理是 best-effort；保留撤权守卫错误作为调用方可见结果。
    }
    throw err;
  }
  return invoke();
}
