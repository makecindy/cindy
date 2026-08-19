/**
 * cindy-docs/_payload.ts —— cindy_docs 工具族共享的 MCP tool result payload helper。
 *
 * 与 xdt-helper/_payload.ts 同口径(每个 server 家族各自持有一份,不跨家族 import):
 *   - 成功: { ok: true, ...data }
 *   - 失败: { ok: false, errorCode, data: { ...data, hint } }, isError: true
 *
 * hint 必须写成「模型能照着自纠」或「能照着转告用户」的人话,不是内部术语。
 */

export interface DocsPayloadContentBlock {
  type: 'text';
  text: string;
}

export interface DocsPayloadResult {
  content: DocsPayloadContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export function okPayload(data: Record<string, unknown>): DocsPayloadResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }],
  };
}

export function errorPayload(
  errorCode: string,
  hint: string,
  data: Record<string, unknown> = {},
): DocsPayloadResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, errorCode, data: { ...data, hint } }),
      },
    ],
    isError: true,
  };
}
