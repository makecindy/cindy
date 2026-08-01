import { isTransientRemoteError } from '@cindy/maker-shared/device-link-contract';

/**
 * 大文件上传状态轮询只对瞬时链路失败重试。
 *
 * 结构化 DeviceLinkError 的 code 不会出现在 `String(error)` 中，因此统一走共享
 * 分类器；保留 legacy 的 "connection lost" 文本兼容旧 SSH/device 包装错误。
 */
export function isTransientDeviceExportStatusError(error: unknown): boolean {
  return isTransientRemoteError(error) || /connection lost/i.test(String(error));
}
