/**
 * Favicon URL 持久化白名单。
 *
 * 规则:
 *  - 只允许 `http:` / `https:`,以及 2KB 以内的小 `data:`。data URI 自包含、
 *    可跨重启,SPA dev server 常用 `data:image/svg+xml` 当 favicon,不能一刀切
 *    拒绝;但过大仍会挤占 16KB 总预算,因此 favicon 字段统一限制为 2KB。
 *  - 一律拒绝 `blob:`(会话内临时对象,重启即失效)、`file:`(宿主 renderer 里
 *    可读本地文件)、`javascript:` / `chrome-extension:` / 自定义 app 协议等
 *    一切非白名单 scheme。白名单比黑名单安全,且不依赖前缀匹配 —— 前缀黑名单
 *    可被 C0 控制字符 / 大小写绕过,这里直接用 URL 解析后的 protocol 判定。
 *  - 超长 URL 拒绝:单字段也要给 url / title 留足 16KB 总预算。
 *
 * 返回值用 `new URL(...).href` 归一化(去前后空白与控制字符、补默认端口 / 斜杠),
 * 存进状态的是干净 URL。
 *
 * store 仍对整份 state 做权威 16KB 预检,这里是第一道过滤,让坏数据进不了状态、
 * 也不会触发"乐观写 → main 拒 → 回滚 → 重写"的更新循环。
 */
const MAX_PERSISTED_FAVICON_URL_BYTES = 2 * 1024;
const MAX_PERSISTED_DATA_FAVICON_BYTES = 2 * 1024;
const PERSISTABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 单候选归一化。返回:
 *  - 持久化安全的 favicon URL(归一化后)
 *  - null = 不可持久化(空 / 非白名单 scheme / 超长 / 无法解析)
 */
export function normalizePersistableFavicon(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const bytes = new TextEncoder().encode(url.href).byteLength;
  if (url.protocol === 'data:') {
    if (bytes > MAX_PERSISTED_DATA_FAVICON_BYTES) return null;
    return url.href;
  }
  if (!PERSISTABLE_PROTOCOLS.has(url.protocol)) return null;
  if (bytes > MAX_PERSISTED_FAVICON_URL_BYTES) return null;
  return url.href;
}

/**
 * 从事件候选里挑一个可持久化 favicon:
 *  - 空 / 全空白候选 = 页面明确无图标 → 返回 ''(调用方据此清掉旧图标)
 *  - 有非空候选但全部不可持久化(如只有 blob:)→ 返回 null(保留已持久化图标,
 *    不要用"无图标"覆盖好图标;blob: 反正重启即失效)
 *  - 否则返回第一个可持久化候选
 */
export function selectPersistableFavicon(candidates: string[]): string | null {
  let sawNonEmptyCandidate = false;
  for (const candidate of candidates) {
    const normalized = normalizePersistableFavicon(candidate);
    if (normalized) return normalized;
    if (candidate.trim()) sawNonEmptyCandidate = true;
  }
  return sawNonEmptyCandidate ? null : '';
}
