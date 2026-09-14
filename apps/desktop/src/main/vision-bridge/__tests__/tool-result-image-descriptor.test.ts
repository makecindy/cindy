/**
 * createToolResultImageDescriptor 单元测试 —— ghost 工具结果图片 → 视觉桥描述
 * 的 fail-closed 判定链。
 *
 * 覆盖：controller 未注入 / session 缺失 / 旧实例 / 模型不命中 / blob 解析失败
 * → skipped:true（有意跳过，不告警）；视觉后端失败 → skipped:false + null（真实
 * 尝试失败，可告警）；全链路正常 → skipped:false + 描述；signal 透传。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createToolResultImageDescriptor,
  type ToolResultImageDescriptorDeps,
} from '../tool-result-image-descriptor.js';
import type { VisionBridgeController } from '../vision-bridge-controller.js';

function makeDeps(overrides: Partial<ToolResultImageDescriptorDeps> = {}) {
  const controller: VisionBridgeController = {
    shouldBridge: vi.fn().mockReturnValue(true),
    describeImage: vi.fn().mockResolvedValue('a chat list screenshot'),
  };
  return {
    deps: {
      getController: () => controller,
      getSession: () => ({ model: 'deepseek-v4', instanceId: 'inst-1' }),
      resolveBlobPath: () => '/tmp/blob.jpg',
      ...overrides,
    } as ToolResultImageDescriptorDeps,
    controller,
  };
}

const INPUT = { imageUrl: 'cindy-media://blobs/abc.jpg', sessionId: 'sess-1', sessionInstanceId: 'inst-1' };

describe('createToolResultImageDescriptor', () => {
  it('controller 未注入 → 返回 null，不读 blob、不调视觉', async () => {
    const { deps, controller } = makeDeps({ getController: () => null });
    const resolveBlobPath = vi.fn();
    const fn = createToolResultImageDescriptor({ ...deps, resolveBlobPath });
    expect(await fn(INPUT)).toEqual({ skipped: true, description: null });
    expect(resolveBlobPath).not.toHaveBeenCalled();
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('sessionId 缺失 → 返回 null', async () => {
    const { deps, controller } = makeDeps();
    const fn = createToolResultImageDescriptor(deps);
    expect(await fn({ ...INPUT, sessionId: null })).toEqual({ skipped: true, description: null });
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('sessionInstanceId 缺失 → 返回 null', async () => {
    const { deps, controller } = makeDeps();
    const fn = createToolResultImageDescriptor(deps);
    expect(await fn({ ...INPUT, sessionInstanceId: null })).toEqual({ skipped: true, description: null });
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('session 不存在 → 返回 null', async () => {
    const { deps, controller } = makeDeps({ getSession: () => undefined });
    const fn = createToolResultImageDescriptor(deps);
    expect(await fn(INPUT)).toEqual({ skipped: true, description: null });
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('旧实例(session.instanceId 不匹配)→ 返回 null', async () => {
    const { deps, controller } = makeDeps({
      getSession: () => ({ model: 'deepseek-v4', instanceId: 'old-inst' }),
    });
    const fn = createToolResultImageDescriptor(deps);
    expect(await fn(INPUT)).toEqual({ skipped: true, description: null });
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('模型不命中(shouldBridge false)→ 返回 null，不 resolveBlobPath', async () => {
    const controller: VisionBridgeController = {
      shouldBridge: vi.fn().mockReturnValue(false),
      describeImage: vi.fn(),
    };
    const resolveBlobPath = vi.fn();
    const fn = createToolResultImageDescriptor({
      getController: () => controller,
      getSession: () => ({ model: 'claude-sonnet', instanceId: 'inst-1' }),
      resolveBlobPath,
    });
    expect(await fn(INPUT)).toEqual({ skipped: true, description: null });
    expect(resolveBlobPath).not.toHaveBeenCalled();
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('resolveBlobPath 抛错(无效 blob)→ 返回 null', async () => {
    const { deps, controller } = makeDeps({ resolveBlobPath: () => { throw new Error('invalid blob'); } });
    const fn = createToolResultImageDescriptor(deps);
    expect(await fn(INPUT)).toEqual({ skipped: true, description: null });
    expect(controller.describeImage).not.toHaveBeenCalled();
  });

  it('视觉后端失败 → skipped:false + null（真实尝试失败，可告警）', async () => {
    const controller: VisionBridgeController = {
      shouldBridge: vi.fn().mockReturnValue(true),
      describeImage: vi.fn().mockRejectedValue(new Error('backend down')),
    };
    const fn = createToolResultImageDescriptor({
      getController: () => controller,
      getSession: () => ({ model: 'deepseek-v4', instanceId: 'inst-1' }),
      resolveBlobPath: () => '/tmp/blob.jpg',
    });
    expect(await fn(INPUT)).toEqual({ skipped: false, description: null });
  });

  it('全链路正常 → 返回描述，用 imagePath + 默认 prompt', async () => {
    const { deps, controller } = makeDeps();
    const fn = createToolResultImageDescriptor(deps);
    const desc = await fn(INPUT);
    expect(desc).toEqual({ skipped: false, description: 'a chat list screenshot' });
    expect(controller.describeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: '/tmp/blob.jpg',
        prompt: expect.stringContaining('Describe this image accurately'),
      }),
    );
  });

  it('signal 透传到 describeImage', async () => {
    const { deps, controller } = makeDeps();
    const fn = createToolResultImageDescriptor(deps);
    const signal = new AbortController().signal;
    await fn({ ...INPUT, signal });
    expect(controller.describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ signal }),
    );
  });
});
