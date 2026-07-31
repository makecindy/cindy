/**
 * 自定义供应商请求头的输入校验（纯逻辑，零依赖）。
 *
 * 用途：自定义供应商表单里用户手填的「请求头」是自由文本 key-value，落盘后会作为
 * `RoutingDescriptor.headerOverride` 拼进上游请求（见 `user-provider.ts` / desktop 的
 * `provider-route.ts`）。这里在**入口**挡两类问题：
 *   1. 名/值本身不是合法的 HTTP field —— 否则底层 http 客户端要么抛错要么静默丢头，
 *      用户很难自查。
 *   2. 覆盖了「协议完整性」头 —— 这些头由 http 客户端 / anthropic-compat-proxy 自己管理，
 *      用户覆盖会破坏请求分帧或与代理自带逻辑冲突。
 *
 * 刻意**不**拦鉴权头（`authorization` / `x-api-key`）：它们由 `provider-route` 在路由期
 * 强制剥离并用 safeStorage 里的 key 重注（见该文件 `withoutClientAuthHeaders`），入口放行
 * 是为了不影响把 legacy 头带回表单的编辑回填。
 */

/** RFC 9110 HTTP field-name token。与 Node/undici、Rust `http::HeaderName` 的合法字符集对齐。 */
export function isValidHttpHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

/**
 * HTTP field-value 运行期守卫：只放行 RFC 9110 field-value 允许的字节 ——
 * 水平制表符（HTAB = \x09）、可见 ASCII + 空格（\x20–\x7e）与 obs-text（\x80–\xff）。
 * 因此拒绝控制字符、DEL（\x7f），以及**任何 > 0xFF 的码点**（如中文 / emoji）：
 * 头值最终要经 `Headers` / undici 编成 ByteString，码点必须落在 0x00–0xFF，否则
 * 底层会在构造请求头时直接抛错。入口挡在这里，避免用户存下 / 测试一个根本发不出去的配置。
 */
export function isValidHttpHeaderValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

/**
 * 协议完整性 header 黑名单（小写）。这些头决定 HTTP 请求的分帧 / 连接语义，由 http 客户端
 * 与 compat-proxy 自己写；用户覆盖只会破坏请求。鉴权头不在此列（见文件头说明）。
 */
export const PROTECTED_CUSTOM_PROVIDER_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);

export function isProtectedCustomProviderHeaderName(name: string): boolean {
  return PROTECTED_CUSTOM_PROVIDER_HEADER_NAMES.has(name.toLowerCase());
}

export interface CustomHeaderRow {
  name: string;
  value: string;
}

export type CustomHeaderInvalidReason = 'invalid-name' | 'invalid-value' | 'protected';

export type CustomHeaderValidation =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: CustomHeaderInvalidReason; index: number; name: string };

/**
 * 校验并归一化一组请求头行。
 *   - 名字空白的行视为 UI 占位空行，跳过（与既有 `if (n) headers[n] = ...` 行为一致）。
 *   - 名/值都先 `trim` 再判定。
 *   - 头名大小写不敏感，重名后者覆盖前者（保持既有 last-wins 语义，不报错）。
 * 命中问题时返回第一处的 `{ index, name, reason }`，供 UI 定位并出对应文案。
 */
export function validateCustomHeaderRows(
  rows: readonly CustomHeaderRow[],
): CustomHeaderValidation {
  // 按小写名归并，实现大小写不敏感的 last-wins：重名（无论大小写）复用同一槽位，
  // 名字大小写与值都取最后一次出现的，避免向上游发出 `X-Env` 与 `x-env` 两个同名头。
  const byLowerName = new Map<string, { name: string; value: string }>();
  for (let i = 0; i < rows.length; i += 1) {
    const name = rows[i].name.trim();
    if (!name) continue;
    const value = rows[i].value.trim();
    if (!isValidHttpHeaderName(name)) {
      return { ok: false, reason: 'invalid-name', index: i, name };
    }
    if (isProtectedCustomProviderHeaderName(name)) {
      return { ok: false, reason: 'protected', index: i, name };
    }
    if (!isValidHttpHeaderValue(value)) {
      return { ok: false, reason: 'invalid-value', index: i, name };
    }
    byLowerName.set(name.toLowerCase(), { name, value });
  }
  const headers: Record<string, string> = {};
  for (const { name, value } of byLowerName.values()) {
    headers[name] = value;
  }
  return { ok: true, headers };
}
