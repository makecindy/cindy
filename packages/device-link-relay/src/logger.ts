/**
 * 中转日志接口。调用方只传固定的事件描述和非敏感字段:
 * 不写凭证、加入码、轮询口令、签名地址、帧内容或设备名以外的用户数据。
 */
export interface RelayLogger {
  info(message: string, fields?: Record<string, string | number | boolean>): void;
  warn(message: string, fields?: Record<string, string | number | boolean>): void;
  error(message: string, fields?: Record<string, string | number | boolean>): void;
}

export const silentLogger: RelayLogger = {
  info() {},
  warn() {},
  error() {},
};
