import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'RolePillDropdown.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('RolePillDropdown worker count summary', () => {
  it('shows total workers separately from the active-slot gate count', () => {
    expect(source).toContain('const totalWorkerCount = workers.length;');
    expect(source).toContain('const activeCount = activeWorkerCount;');
    expect(source).toContain("t('orca.rolePill.workerCountSummary', {");
    expect(source).toContain('totalCount: totalWorkerCount');
    expect(source).toContain('activeCount,');
    // count 必须传给 i18next 以驱动复数选择 (en _one/_other)
    expect(source).toContain('count: totalWorkerCount');
    expect(source).not.toContain('{count} / {softLimit}');

    const gateBlock = extractBetween(
      source,
      '{/* ── Create new worker row (3 上限态) ── */}',
      '        </div>\n      )}',
    );
    expect(gateBlock).toContain('activeCount >= hardLimit');
    expect(gateBlock).toContain('activeCount >= softLimit');
    expect(gateBlock).not.toContain('totalWorkerCount >= hardLimit');
    expect(gateBlock).not.toContain('totalWorkerCount >= softLimit');
  });

  it('defines the pluralized summary string in every locale', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
      const raw = readFileSync(
        resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'),
        'utf8',
      );
      const json = JSON.parse(raw) as {
        orca?: { rolePill?: Record<string, unknown> };
      };
      const rp = json.orca?.rolePill ?? {};
      // 传 count 后 i18next 对所有语言都按 _other 解析 (zh/ja/ko 仅 other 复数类别);
      // en 额外需要 _one, 否则 totalCount===1 时显示 "1 workers" 语法错误。
      const other = rp.workerCountSummary_other;
      expect(other).toEqual(expect.any(String));
      expect(other).toContain('{{totalCount}}');
      expect(other).toContain('{{activeCount}}');
      if (locale === 'en') {
        const one = rp.workerCountSummary_one;
        expect(one).toEqual(expect.any(String));
        expect(one).toContain('{{totalCount}}');
        expect(one).toContain('{{activeCount}}');
      }
    }
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
