import { DeviceLinkError } from '@cindy/device-link';

/** 打开具体远程会话时必须先建立 streaming link；轻量 sessions 列表订阅不依赖。 */
export function requiresSessionLink(topics: readonly string[]): boolean {
  return topics.some((topic) => (
    topic.startsWith('session:') && topic.length > 'session:'.length
  ));
}

/**
 * LINK_NOT_OPEN 由 DeviceLinkClient 在真正发帧前抛出，因此可先重开链路再重试一次。
 * 已经发出的请求或其它错误绝不重试，避免 enqueue / send 等写操作重复执行。
 */
export async function invokeWithClosedLinkRecovery<T>(
  invoke: () => Promise<T>,
  reopen: () => Promise<unknown>,
  beforeRetry?: () => void,
): Promise<T> {
  try {
    return await invoke();
  } catch (err) {
    if (
      !(err instanceof DeviceLinkError)
      || err.code !== 'LINK_NOT_OPEN'
      || err.inFlight === true
    ) {
      throw err;
    }
  }

  await reopen();
  beforeRetry?.();
  return invoke();
}
