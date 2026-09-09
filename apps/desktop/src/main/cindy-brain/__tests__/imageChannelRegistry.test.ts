/**
 * imageChannelRegistry.test.ts — 图像执行通道注册表的纯函数单测。
 * 重点锁住乱序安全兜底:未注册的 providerId 视为不就绪(目录数据先于通道代码
 * 合入时,新模型只是不进白名单,绝不错发到别家通道)。
 */

import { describe, expect, it, vi } from 'vitest';

import { ImageChannelRegistry, decodeImageResponse, assertLibraryEditImageSource, type ImageChannel } from '../imageChannelRegistry';

function channel(ready: boolean, supportsEdit?: boolean): ImageChannel {
  return {
    ready: () => ready,
    ...(supportsEdit !== undefined ? { supportsEdit } : {}),
    generateImage: vi.fn(async () => ({ data: [{ b64_json: 'aGk=' }] })),
    editImage: vi.fn(async () => ({ data: [{ b64_json: 'aGk=' }] })),
  };
}

describe('ImageChannelRegistry', () => {
  it('未注册的 providerId 不就绪(目录数据先行的乱序安全兜底)', () => {
    const registry = new ImageChannelRegistry();
    registry.register('xd', channel(true));
    expect(registry.isProviderReady('xd')).toBe(true);
    expect(registry.isProviderReady('gemini')).toBe(false);
  });

  it('ready() false 的通道不就绪;resolve 对未注册/未就绪都人话抛错', () => {
    const registry = new ImageChannelRegistry();
    registry.register('gemini', channel(false));
    expect(registry.isProviderReady('gemini')).toBe(false);
    expect(() => registry.resolve('gemini')).toThrow(/凭证未就绪/);
    expect(() => registry.resolve('nonexistent')).toThrow(/没有可用的执行通道/);
  });

  it('resolve 返回就绪通道;重复注册同 providerId 抛错(装配期编程错误尽早暴露)', () => {
    const registry = new ImageChannelRegistry();
    const xd = channel(true);
    registry.register('xd', xd);
    expect(registry.resolve('xd')).toBe(xd);
    expect(() => registry.register('xd', channel(true))).toThrow(/already registered/);
  });

  it('isProviderEditReady: supportsEdit: false 的来源不进编辑就绪', () => {
    const registry = new ImageChannelRegistry();
    registry.register('xd', channel(true));            // 省略 supportsEdit → true
    registry.register('xai', channel(true, false));    // 仅生成
    registry.register('gemini', channel(true, true));  // 明示支持编辑
    expect(registry.isProviderEditReady('xd')).toBe(true);
    expect(registry.isProviderEditReady('xai')).toBe(false);
    expect(registry.isProviderEditReady('gemini')).toBe(true);
    expect(registry.isProviderEditReady('unknown')).toBe(false);
  });

  it('supportsEdit: false 的通道 resolve 后仍携带该标记,供派发层拒改图请求', () => {
    const registry = new ImageChannelRegistry();
    const generateOnly: ImageChannel = { ...channel(true), supportsEdit: false };
    registry.register('xai', generateOnly);
    expect(registry.isProviderReady('xai')).toBe(true);
    expect(registry.resolve('xai').supportsEdit).toBe(false);
  });
});

describe('decodeImageResponse', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it('mime 由字节魔数决定,不信任上游声明的 output_format', () => {
    // 上游谎报 webp,字节实为 JPEG → 按魔数落 image/jpeg。
    const decoded = decodeImageResponse({
      data: [{ b64_json: JPEG_MAGIC.toString('base64') }],
      output_format: 'webp',
    });
    expect(decoded.mimeType).toBe('image/jpeg');
    expect(decoded.buffer.equals(JPEG_MAGIC)).toBe(true);
    expect(
      decodeImageResponse({ data: [{ b64_json: PNG_MAGIC.toString('base64') }] }).mimeType,
    ).toBe('image/png');
  });

  it('非图片字节拒绝(上游/代理返回错误页等),不产出可落盘的结果', () => {
    expect(() =>
      decodeImageResponse({
        data: [{ b64_json: Buffer.from('<html>proxy error</html>').toString('base64') }],
        output_format: 'png',
      }),
    ).toThrow(/不是有效图片/);
  });

  it('空响应拒绝', () => {
    expect(() => decodeImageResponse({ data: [] })).toThrow(/返回为空/);
    expect(() => decodeImageResponse({ data: [{}] })).toThrow(/返回为空/);
  });
});

describe('assertLibraryEditImageSource', () => {
  const HASH = 'b'.repeat(64);
  const blob = `assets/${HASH.slice(0, 2)}/${HASH}/blob.png`;

  it('正本 blob 可消费,sidecar 与错误文件名 fail-visible', () => {
    expect(() => assertLibraryEditImageSource(blob)).not.toThrow();
    expect(() => assertLibraryEditImageSource(`/abs/library/${blob}`)).not.toThrow();
    expect(() => assertLibraryEditImageSource(`assets/${HASH.slice(0, 2)}/${HASH}/preview.webp`)).toThrow(/sidecar/);
    expect(() => assertLibraryEditImageSource(`assets/${HASH.slice(0, 2)}/${HASH}/meta.json`)).toThrow(/sidecar/);
    expect(() => assertLibraryEditImageSource(`assets/${HASH.slice(0, 2)}/${HASH}.png`)).toThrow(/正本 blob/);
  });
});
