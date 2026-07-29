/**
 * 供应商推理路径的共享边界。
 *
 * 路径最终会原样进入 Node `http(s).request({ path })`，因此除同源约束外，还必须拒绝
 * 会被 WHATWG URL 重新编码、但透明代理仍按原字节发送的字符。仅允许可打印 ASCII；
 * 空格、控制符和非 ASCII 字符应由用户先做 percent-encoding。
 */
export function isProviderRequestPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const queryIndex = value.indexOf('?');
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const hasEncodedPathSeparator = /%(?:2f|5c)/i.test(path);
  const hasDotSegment = path
    .split('/')
    .some((segment) => {
      const normalizedDots = segment.replace(/%2e/gi, '.');
      return normalizedDots === '.' || normalizedDots === '..';
    });
  return (
    value.length >= 1
    && value.length <= 2_048
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('#')
    && !value.includes('\\')
    && !/[^\u0021-\u007e]/.test(value)
    // Keep byte-for-byte parity between WHATWG URL setters and transparent http.request paths.
    // Characters outside RFC 3986 path/query delimiters must be percent-encoded by the caller.
    && /^\/[A-Za-z0-9\-._~%!$&()*+,;=:@/?]*$/.test(value)
    && !/%(?![0-9A-Fa-f]{2})/.test(value)
    && !hasEncodedPathSeparator
    && !hasDotSegment
  );
}

/**
 * 无鉴权本机代理的 URL 边界。只接受真正的 loopback 主机，避免把 `auth:none`
 * 配置改成远端地址后让应用静默向第三方发送提示词。
 */
export function isLoopbackProviderUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
    ) {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
    const octets = hostname.split('.');
    return (
      octets.length === 4
      && octets[0] === '127'
      && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

/**
 * 把已验证的精确推理路径追加到 base URL，同时保留 base query。
 * requestPath 自带的 query 追加在 base query 后，fragment 一律不进入请求。
 */
export function appendProviderRequestPath(baseUrl: string, requestPath: string): string {
  if (!isProviderRequestPath(requestPath)) {
    throw new TypeError('invalid provider request path');
  }
  const url = new URL(baseUrl);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
  ) {
    throw new TypeError('invalid provider base URL');
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  const queryIndex = requestPath.indexOf('?');
  const exactPath = queryIndex === -1 ? requestPath : requestPath.slice(0, queryIndex);
  const exactQuery = queryIndex === -1 ? '' : requestPath.slice(queryIndex + 1);
  const baseQuery = url.search.slice(1);
  url.pathname = `${basePath}${exactPath}`;
  url.search = [baseQuery, exactQuery].filter(Boolean).join('&');
  url.hash = '';
  return url.toString();
}
