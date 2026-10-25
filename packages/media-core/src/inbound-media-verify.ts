import { sniffMediaMime } from './sniff.js';

/**
 * IM 入站媒体入仓前按真实字节核验类型: 渠道给的 MIME / 扩展名只是线索(平台常给
 * octet-stream, transport 会按扩展名推断), 不能单独决定落仓 MIME。识别不出或大类
 * 不符(要存图片却不是图片字节)即拒收 —— transport 据此标不支持, 不回落文件暂存。
 */
export function verifiedInboundMediaMime(buffer: Uint8Array, declared: string, kind: 'image' | 'av'): string {
  const sniffed = sniffMediaMime(buffer, declared.split(';')[0].trim().toLowerCase());
  const matches =
    sniffed !== null &&
    (kind === 'image' ? sniffed.startsWith('image/') : sniffed.startsWith('video/') || sniffed.startsWith('audio/'));
  if (!matches) throw new Error(`IM inbound ${kind} bytes do not match a supported media type`);
  return sniffed;
}
