/** 从请求头里取 `Authorization: Bearer <key>` 的 key;没有或格式不对返回 null。 */
export function bearerKeyFromHeaders(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  let value: string | null | undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    value = headers.get('authorization');
  } else if (Array.isArray(headers)) {
    value = headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  } else {
    const record = headers as Record<string, string | undefined>;
    const name = Object.keys(record).find((key) => key.toLowerCase() === 'authorization');
    value = name ? record[name] : undefined;
  }
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match ? match[1].trim() || null : null;
}

/**
 * 给注入式 fetch 包一层:响应 401 时,用本次请求 Authorization 头里的 Bearer key 上报。
 * 只观察状态码,不读响应体、不改请求和响应;key 是否为 Cindy AI Key 由上报器按规则 A 判定。
 */
export function withCindyGatewayKeyRejectionReport(
  fetchImpl: typeof fetch,
  report: (usedKey: string | null) => void,
): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401) {
      const usedKey =
        bearerKeyFromHeaders(init?.headers) ??
        (typeof Request !== 'undefined' && input instanceof Request
          ? bearerKeyFromHeaders(input.headers)
          : null);
      report(usedKey);
    }
    return response;
  };
  return wrapped as typeof fetch;
}
