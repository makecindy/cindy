/**
 * xdt-helper/_payload.ts —— 共享的 MCP tool result payload helper。
 *
 * 所有 xdt-helper 工具的 ok / err 响应格式必须一致, 由 LLM 拿到统一的 schema:
 *   - 成功: { ok: true, ...data }
 *   - 失败: { ok: false, errorCode: string, data: { hint: string } }, isError: true
 *
 * Hint 字段必须告诉 LLM 该怎么自纠 / 报告用户 (与 lizi_feishu 等其它
 * lizi_* server 的约定一致)。
 */

export interface ToolPayloadContentBlock {
  type: 'text';
  text: string;
}

export interface ToolPayloadResult {
  content: ToolPayloadContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export function okPayload(data: Record<string, unknown>): ToolPayloadResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, ...data }),
      },
    ],
  };
}

export function errorPayload(
  errorCode: string,
  hint: string,
  data: Record<string, unknown> = {},
): ToolPayloadResult {
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

/** Only this structured reason is part of the project write error contract. */
export function controlErrorPayload(failure: { errorCode: string; message: string }) {
  const detail = failure.errorCode === 'PRECONDITION_FAILED'
    && 'reason' in failure && failure.reason === 'HOST_PROFILE_RELEASE_FAILED'
    ? { reason: failure.reason } : undefined;
  return errorPayload(failure.errorCode, failure.message, detail);
}
