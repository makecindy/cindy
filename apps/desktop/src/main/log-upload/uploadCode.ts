/**
 * 上传编号生成。短、可读、用户能在群里口述（需求 §4.8）。
 *
 * 字符集去掉 0/1/I/L/O/U（字形或读音冲突），8 位分成 `XXXX-XXXX` 两组。
 * 用 rejection sampling 而不是 `% alphabet.length`：取模会让前几个字符出现概率略高，
 * 虽然对「避免口述冲突」没有实质影响，但偏置的随机数没有存在的理由。
 */

import {
  formatUploadCode,
  UPLOAD_CODE_ALPHABET,
  UPLOAD_CODE_LENGTH,
} from '../../shared/logUpload';

/** 注入随机字节，便于单测给定序列。 */
export type RandomBytes = (size: number) => Uint8Array;

export function generateUploadCode(randomBytes: RandomBytes): string {
  const alphabet = UPLOAD_CODE_ALPHABET;
  // 最大可用值:落在 [limit, 256) 的字节丢弃,保证均匀。
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const chars: string[] = [];
  while (chars.length < UPLOAD_CODE_LENGTH) {
    // 一次多取一些,减少系统调用。字符集 30 个字符 ⇒ limit = 240,落在 [240, 256) 的
    // 16 个字节被丢弃,丢弃率 16/256 = 6.25%;取 2× 长度一轮基本够。
    const bytes = randomBytes(UPLOAD_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      chars.push(alphabet[byte % alphabet.length]);
      if (chars.length >= UPLOAD_CODE_LENGTH) break;
    }
  }
  return formatUploadCode(chars.join(''));
}
