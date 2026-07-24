import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * placeholder 颜色接线冻结(2026-07-23 用户实测发现修复):
 * `--login-control-placeholder` token 自登录换皮落地起注册但从未被消费,
 * placeholder 实渲染为 Tailwind preflight 默认 placeholder 灰而非设计稿定稿值。
 * 本测试按仓内静态源码断言先例(loginScenarioHarness.test.ts)锁住接线,
 * 防止工具类再次脱落回默认灰。
 */
const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/login/LoginControls.tsx'),
  'utf8',
);

describe('LoginControls placeholder 接线冻结', () => {
  it('输入框 placeholder 颜色必须消费 --login-control-placeholder token', () => {
    expect(source).toContain('placeholder:text-[var(--login-control-placeholder)]');
  });
});
