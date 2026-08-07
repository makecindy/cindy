/**
 * cindyOverrideWhitelist.test.ts — 钉档白名单单测(纯函数,无 Electron)。
 *
 * 核心守护:text.*(快问快答)的取值是轻量任务模型链档位键(codex-gpt-5.4-mini
 * 等供应商×模型组合),不是媒体目录模型 id——校验若错拿图像目录,text 钉档
 * 恒被 INVALID_PARAMS 拒绝(详情页「操作失败」),这是本文件的由来。
 */

import { describe, expect, it } from 'vitest';

import { isCindyOverrideModelAllowed } from '../cindyOverrideWhitelist';

const CATALOGS = {
  image: [
    { id: 'img-pro', supportsEdit: true },
    { id: 'img-basic' },
  ],
  video: [{ id: 'vid-pro' }],
  embed: [{ id: 'emb-1' }],
  // text.* 的目录钉全集(调用侧按当前供应商目录现算)。
  textPinIds: ['cat:xd:codex:codex/gpt-5.5', 'cat:openai:codex:gpt-5.5'],
} as const;

describe('isCindyOverrideModelAllowed', () => {
  it('model=null = 清除覆盖(恢复跟随默认),任何类目都放行', () => {
    expect(isCindyOverrideModelAllowed('text.oneshot', null, CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('image.generate', null, CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('video.generate', null, CATALOGS)).toBe(true);
  });

  it('text.* 放行轻量档位键(兼容既有形态)与当前目录钉', () => {
    expect(isCindyOverrideModelAllowed('text.oneshot', 'codex-gpt-5.4-mini', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('text.oneshot', 'litellm-kimi-k2.6', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('text.oneshot', 'cat:xd:codex:codex/gpt-5.5', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('text.oneshot', 'cat:openai:codex:gpt-5.5', CATALOGS)).toBe(true);
  });

  it('text.* 拒绝裸模型名、不在目录的钉值、媒体目录 id 与空串', () => {
    // 档位键 ≠ 模型名:消费方只认这两类编码,放行裸名会让钉档静默回落默认。
    expect(isCindyOverrideModelAllowed('text.oneshot', 'moonshotai/kimi-k2.6', CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('text.oneshot', 'cat:xd:codex:no-such-model', CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('text.oneshot', 'img-pro', CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('text.oneshot', '', CATALOGS)).toBe(false);
  });

  it('image.* 钉图像目录;image.edit 额外要求 supportsEdit', () => {
    expect(isCindyOverrideModelAllowed('image.generate', 'img-pro', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('image.generate', 'img-basic', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('image.edit', 'img-pro', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('image.edit', 'img-basic', CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('image.generate', 'codex-gpt-5.4-mini', CATALOGS)).toBe(false);
  });

  it('video.* 钉视频目录,不要求 supportsEdit', () => {
    expect(isCindyOverrideModelAllowed('video.generate', 'vid-pro', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('video.edit', 'vid-pro', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('video.generate', 'img-pro', CATALOGS)).toBe(false);
  });

  it('embed.* 钉向量目录(上游 #1707 新增的能力域)', () => {
    expect(isCindyOverrideModelAllowed('embed.text', 'emb-1', CATALOGS)).toBe(true);
    expect(isCindyOverrideModelAllowed('embed.text', 'vid-pro', CATALOGS)).toBe(false);
  });

  it('非字符串值(数字/对象/undefined)一律拒', () => {
    expect(isCindyOverrideModelAllowed('text.oneshot', 42, CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('image.generate', { id: 'img-pro' }, CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('video.generate', undefined, CATALOGS)).toBe(false);
  });

  it('未知类目一律拒(IPC 层已先按 CINDY_CAPABILITY_KEYS 过滤,这里是纵深)', () => {
    expect(isCindyOverrideModelAllowed('fs.read', 'img-pro', CATALOGS)).toBe(false);
  });

  it('原型继承键(toString/constructor/__proto__)不当轻量档位放行', () => {
    // `value in UTILITY_MODEL_PROFILES` 会把继承键当真:入库后消费侧拿不到
    // profile,该意识的快问快答持续 NO_CANDIDATE 直到清钉。
    expect(isCindyOverrideModelAllowed('text.oneshot', 'toString', CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('text.oneshot', 'constructor', CATALOGS)).toBe(false);
    expect(isCindyOverrideModelAllowed('text.oneshot', '__proto__', CATALOGS)).toBe(false);
  });
});
