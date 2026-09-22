import { describe, expect, it } from 'vitest';

import {
  isSessionContextWindowAgentKind,
  normalizeSessionContextWindowBounds,
  normalizeSessionContextWindowBoundsRoute,
} from '../sessionContextWindowBounds';

describe('normalizeSessionContextWindowBounds', () => {
  it('keeps the well-formed payload the controlled device returns', () => {
    expect(
      normalizeSessionContextWindowBounds({
        providerId: 'xd', defaultWindow: 200_000, maxWindow: 1_000_000, modelLimit: 100_000,
        budget: 250_000, budgetCustomized: true, defaultEffectiveWindow: 100_000, maxEffectiveWindow: 1_000_000,
      }),
    ).toEqual({
      providerId: 'xd', defaultWindow: 200_000, maxWindow: 1_000_000, modelLimit: 100_000,
      budget: 250_000, budgetCustomized: true, defaultEffectiveWindow: 100_000,
      maxEffectiveWindow: 1_000_000,
    });
    // 任务预算随边界一起回来（偏好文件里的条目），缂少/非法时按「未自定义」处理。
    expect(
      normalizeSessionContextWindowBounds({
        providerId: 'xd', defaultWindow: 200_000, maxWindow: null, modelLimit: null,
      }),
    ).toEqual({
      providerId: 'xd', defaultWindow: 200_000, maxWindow: null, modelLimit: null,
      budget: null, budgetCustomized: false, defaultEffectiveWindow: null, maxEffectiveWindow: null,
    });
    expect(
      normalizeSessionContextWindowBounds({
        providerId: 'xd', defaultWindow: 200_000, maxWindow: null, modelLimit: null,
        budget: -5, budgetCustomized: 'yes', defaultEffectiveWindow: 0, maxEffectiveWindow: 0,
      }),
    ).toEqual({
      providerId: 'xd', defaultWindow: 200_000, maxWindow: null, modelLimit: null,
      budget: null, budgetCustomized: false, defaultEffectiveWindow: null, maxEffectiveWindow: null,
    });
  });

  it('treats any unusable shape as unknown instead of guessing a ceiling', () => {
    // 老版本/畸形返回：宁可退回「只允许收紧」，也不能把某个字段当成上限。
    expect(normalizeSessionContextWindowBounds(null)).toBeNull();
    expect(normalizeSessionContextWindowBounds(undefined)).toBeNull();
    expect(normalizeSessionContextWindowBounds('1000000')).toBeNull();
    // 两个窗口都缺 → 整份不可用（即便 modelLimit 有值也算不出上限）。
    expect(normalizeSessionContextWindowBounds({ defaultWindow: null, maxWindow: null, modelLimit: 900_000 }))
      .toBeNull();
    // 非数/负数/0/NaN 一律按未知处理；只有上限可批时仍可用，但 defaultWindow 为 null。
    expect(
      normalizeSessionContextWindowBounds({
        providerId: '', defaultWindow: '200000', maxWindow: 400_000, modelLimit: -1,
      }),
    ).toEqual({
      providerId: null, defaultWindow: null, maxWindow: 400_000, modelLimit: null,
      budget: null, budgetCustomized: false, defaultEffectiveWindow: null, maxEffectiveWindow: null,
    });
    expect(normalizeSessionContextWindowBounds({ defaultWindow: 0, maxWindow: Number.NaN })).toBeNull();
  });
});

describe('normalizeSessionContextWindowBoundsRoute', () => {
  it('keeps a route the caller sends for the route it is displaying', () => {
    expect(
      normalizeSessionContextWindowBoundsRoute({
        agent: 'pi', providerId: 'commandcode', model: 'deepseek/deepseek-v4.1-flash',
      }),
    ).toEqual({ agent: 'pi', providerId: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' });
    // 不显式指定来源 = 由目录隐式解析（与运行期同口径），保留 null 而不是丢掉整个路由。
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'claude-code', model: 'grok-4.6' }))
      .toEqual({ agent: 'claude-code', providerId: null, model: 'grok-4.6' });
    expect(normalizeSessionContextWindowBoundsRoute({ agent: ' pi ', providerId: ' xd ', model: ' m ' }))
      .toEqual({ agent: 'pi', providerId: 'xd', model: 'm' });
  });

  it('rejects anything that is not a complete route instead of answering half of it', () => {
    // 缺模型或引擎就解析不了窗口：整份拒绝 → 调用方退回「按会话行回答」。
    expect(normalizeSessionContextWindowBoundsRoute(null)).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute('pi')).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute(['pi', 'xd', 'm'])).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({})).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'pi' })).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({ model: 'm' })).toBeNull();
    // 引擎值域外的标识不能当路由用（否则会把任意字符串当 AgentKind 去查目录）。
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'cc', model: 'm' })).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'pi', model: 42 })).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'pi', providerId: 7, model: 'm' })).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'pi', model: '' })).toBeNull();
    expect(normalizeSessionContextWindowBoundsRoute({ agent: 'pi', model: 'x'.repeat(300) })).toBeNull();
  });

  it('recognizes exactly the three maker-core engine kinds', () => {
    expect(isSessionContextWindowAgentKind('claude-code')).toBe(true);
    expect(isSessionContextWindowAgentKind('pi')).toBe(true);
    expect(isSessionContextWindowAgentKind('codex')).toBe(true);
    expect(isSessionContextWindowAgentKind('cc')).toBe(false);
    expect(isSessionContextWindowAgentKind(null)).toBe(false);
  });
});
