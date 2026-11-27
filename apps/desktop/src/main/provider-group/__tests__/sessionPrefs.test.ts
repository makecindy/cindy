/**
 * 测试价值：§6.2 新增关闭偏好。既有 service fake 不覆盖旧格式兼容、落盘与账号隔离；
 * 从公开读写入口用临时 userData 保存一个旧版 auto 任务，再关闭、重新开启和换账号。
 * 此模块原无测试；与 service 的注入 fake 属于不同隔离环境，单独验证真实偏好存储。
 * tier: unit；不重载模块，不读取真实用户目录。
 * 单文件实测 1.63s（2026-11-03）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({ directory: '', owner: 'owner-a' }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => scope.owner,
  ownerScopedUserDataPath: (file: string) => join(scope.directory, `${scope.owner}-${file}`),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  readProviderGroupAutoRebalance, readProviderGroupRebalanceDisabled,
  writeProviderGroupAutoRebalance, writeProviderGroupRebalanceEnabled,
} from '../sessionPrefs';

afterEach(() => rmSync(scope.directory, { recursive: true, force: true }));

it('preserves legacy automatic choices and persists an owner-scoped opt-out that can be reset', async () => {
  scope.directory = mkdtempSync(join(tmpdir(), 'cindy-rebalance-prefs-'));
  scope.owner = 'owner-a';
  const file = join(scope.directory, 'owner-a-provider-group-session-prefs.json');
  writeFileSync(file, JSON.stringify({ autoRebalance: { s1: 1 } }));
  expect(readProviderGroupAutoRebalance('s1')).toBe(true);
  expect(readProviderGroupRebalanceDisabled('s1')).toBe(false);
  await writeProviderGroupRebalanceEnabled('s1', false, 2);
  await writeProviderGroupAutoRebalance('s2', 3);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    autoRebalance: { s1: 1, s2: 3 }, disabledRebalance: { s1: 2 },
  });
  scope.owner = 'owner-b';
  expect(readProviderGroupRebalanceDisabled('s1')).toBe(false);
  scope.owner = 'owner-a';
  expect(readProviderGroupRebalanceDisabled('s1')).toBe(true);
  expect(readProviderGroupRebalanceDisabled('s2')).toBe(false);
  await writeProviderGroupRebalanceEnabled('s1', true);
  expect(readProviderGroupRebalanceDisabled('s1')).toBe(false);
  expect(readProviderGroupAutoRebalance('s1')).toBe(true);
});
