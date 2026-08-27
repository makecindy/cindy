/**
 * Codex 订阅远端压缩（remote compact）把解不开的 `encrypted_content` 送给上游后的硬失败。
 *
 * 与 HTTP 静默剥推理密文的分工：单独的 `invalid_encrypted_content` 仍由 proxy 剥
 * `reasoning.encrypted_content` 透明重试。远端 compact 是 Codex 内部硬失败、无本地回退，
 * 且压缩块密文不能剥；原样重试必再撞同一个 400。恢复动作与满窗 / host compact 确定性
 * 失败相同：host-controlled rollover（换窗），不要求用户开新任务或 Fork。
 *
 * 必须同时命中 compact 入口文案和密文错误码，避免把供应商切换时的推理密文 400 误当成换窗。
 */
export function isRemoteCompactEncryptedContentError(message: string): boolean {
  if (!message) return false;
  return (
    /invalid_encrypted_content/i.test(message) &&
    /remote compact/i.test(message)
  );
}
