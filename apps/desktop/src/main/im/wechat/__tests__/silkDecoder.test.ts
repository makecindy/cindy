import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { __testing } from '../silkDecoder';

const SILK_BYTES = Buffer.from('#!SILK_V3\u0000silk-frame-data');

describe('SILK decoder input preparation', () => {
  it('copies Buffer-backed input before it can be transferred', () => {
    const source = Buffer.from([1, 2, 3, 4]);
    const copy = __testing.copySilkBytes(source);

    source[0] = 9;

    expect(copy).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(copy.buffer).not.toBe(source.buffer);
  });

  // 测试价值
  // - 生产入口与可观察结果：stageWechatTaskMedia 用 isSilkStream 决定是否走 SILK 解码；
  //   判错会导致真实语音标成 voice:unsupported-format（#10899）或把普通音频误送解码器。
  // - Bug／规则依据：#10899（旧实现按 encode_type===6 硬编码门控，真实微信语音不命中）。
  // - 现有覆盖缺口：旧实现没有内容识别逻辑，无从覆盖。
  // - 最小失败输入：#!SILK 魔数字节、带 0x02 前缀的变体、非 SILK 字节。
  // - tier：unit（纯字节判定，沿用本文件输入准备层）。
  it('recognizes SILK streams by magic bytes including the 0x02-prefixed variant', () => {
    expect(__testing.isSilkStream(SILK_BYTES)).toBe(true);
    expect(__testing.isSilkStream(Buffer.from([0x02, ...SILK_BYTES]))).toBe(true);
    expect(__testing.isSilkStream(Buffer.from('not silk'))).toBe(false);
    expect(__testing.isSilkStream(Buffer.from('#!SILK'))).toBe(true);
    expect(__testing.isSilkStream(Buffer.from('#!SIL'))).toBe(false);
  });

  it('strips a single 0x02 prefix only when the SILK magic follows it', () => {
    expect(Buffer.from(__testing.stripSilkPrefix(Buffer.from([0x02, ...SILK_BYTES])))).toEqual(
      SILK_BYTES,
    );
    expect(Buffer.from(__testing.stripSilkPrefix(SILK_BYTES))).toEqual(SILK_BYTES);
    const noMagic = Buffer.from([0x02, 0x03, 0x04]);
    expect(Buffer.from(__testing.stripSilkPrefix(noMagic))).toEqual(noMagic);
  });
});
