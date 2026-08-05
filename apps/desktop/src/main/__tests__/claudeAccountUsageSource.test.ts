/**
 * Source-level contract tests for Claude account usage accounting.
 *
 * The implementation talks to Electron auth storage and remote LiteLLM endpoints,
 * so these tests pin the endpoint/data-shape contract without doing network IO.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(__dirname, '..', 'usage', 'claudeAccountUsage.ts');
const source = readFileSync(sourcePath, 'utf8');

describe('claudeAccountUsage today accounting', () => {
  it('derives today spend from LiteLLM daily activity results metrics', () => {
    expect(source).toContain('/user/daily/activity');
    expect(source).toContain('resolveDailyActivitySpend');
    expect(source).toContain('todayRow?.metrics?.spend');
  });

  it('drops the per-key (currentKeyTodaySpend) accounting entirely', () => {
    // 该指标用 key 明细端点解析到的是管理用途 key, 与子进程实际计费 key 不是同一把,
    // 取出来的桶并非用户真实用量, 且 todaySpend 已覆盖, 2026-06-21 移除。
    // regression guard 防止它被无意中重新引入 (用标识符而非注释里也会出现的端点字符串)。
    expect(source).not.toContain('currentKeyTodaySpend');
    expect(source).not.toContain('fetchCurrentKeyHash');
    expect(source).not.toContain('apiKeys[currentKeyHash]');
  });

  it('keeps monthly usage available when the daily fetch fails', () => {
    expect(source).toContain('daily 失败只让 todaySpend=null');
    expect(source).toContain('if (!cycle) return null;');
  });

  it('uses a relaxed timeout for background quota refreshes', () => {
    expect(source).toContain('const FETCH_TIMEOUT_MS = 8000;');
  });
});
