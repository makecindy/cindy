/** Keep the IPC code and message used by existing callers while allowing local recovery to distinguish this failure. */
export class BotModelUnavailable extends Error {
  constructor(readonly code: 'PRECONDITION_FAILED' | 'INVALID_PARAMS' = 'PRECONDITION_FAILED') {
    super(code === 'PRECONDITION_FAILED'
      ? '[PRECONDITION_FAILED] 请先连接模型供应商或选择伙伴模型'
      : '[INVALID_PARAMS] Model route unavailable');
  }
}
